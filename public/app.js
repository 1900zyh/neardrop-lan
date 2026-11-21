'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const storage = {
  get(key, session = false) { try { return (session ? sessionStorage : localStorage).getItem(key); } catch { return null; } },
  set(key, value, session = false) { try { (session ? sessionStorage : localStorage).setItem(key, value); } catch { /* Private browsing can disable storage. */ } },
};
function uniqueId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function icon(name) { return `<svg aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`; }
function formatBytes(value) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 0 && value / 1024 ** index < 10 ? 1 : 0)} ${units[index]}`;
}
function formatTime(value) { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function defaultName() {
  const ua = navigator.userAgent;
  return `${/iPhone|iPad/.test(ua) ? '我的 iPhone / iPad' : /Android/.test(ua) ? '我的手机' : /Mac/.test(ua) ? '我的 Mac' : '我的电脑'} · ${uniqueId().slice(0, 4).toUpperCase()}`;
}
const requestedRoom = new URL(location.href).searchParams.get('room')?.toUpperCase();
const state = {
  room: /^[A-Z0-9]{6}$/.test(requestedRoom || '') ? requestedRoom : 'lobby',
  name: storage.get('neardrop-name') || defaultName(), client: null, token: null,
  clients: [], items: new Map(), tasks: new Map(), config: { maxFileSize: 2 * 1024 ** 3, chunkSize: 1024 ** 2, retentionHours: 24 },
  info: null, source: null, online: false, joining: false, reconnectTimer: null, reconnectAttempt: 0,
  filter: 'all', tab: 'file', running: 0, maxConcurrent: 2, renderFrame: null, sendingMessage: false, pendingMessage: null,
};
try {
  const saved = JSON.parse(storage.get('neardrop-session', true));
  if (saved?.client?.room === state.room) { state.client = saved.client; state.token = saved.token; }
} catch { /* A damaged session is replaced on the next join. */ }

function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.textContent = message;
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), 4500);
}
async function api(path, options = {}) {
  const headers = { ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...options.headers };
  if (options.body && typeof options.body !== 'string') { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let response;
  try { response = await fetch(path, { ...options, headers, signal: controller.signal }); }
  catch (error) { throw new Error(error.name === 'AbortError' ? '请求超时，请检查网络后重试' : '网络连接中断，请检查网络后重试'); }
  finally { clearTimeout(timeout); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    error.status = response.status; error.offset = data.offset;
    throw error;
  }
  return data;
}
function saveSession() { storage.set('neardrop-session', JSON.stringify({ client: state.client, token: state.token }), true); }
function setConnection(status) {
  state.online = status === 'online';
  const element = $('#connection');
  element.className = `connection ${status === 'online' ? '' : status}`;
  element.querySelector('span').textContent = status === 'online' ? '连接正常' : status === 'connecting' ? '正在连接' : '连接中断';
  $('#network-banner').hidden = status !== 'offline';
}
function applySnapshot(snapshot) {
  state.clients = snapshot.clients || [];
  state.items = new Map((snapshot.items || []).map((item) => [item.id, item]));
  for (const [id, task] of state.tasks) {
    if (task.remoteId && !state.items.has(task.remoteId) && ['ready', 'cancelled'].includes(task.status)) state.tasks.delete(id);
  }
  renderDevices(); scheduleHistory();
}
function receiveItem(item) {
  if (!item) return;
  state.items.set(item.id, item);
  for (const task of state.tasks.values()) {
    if (task.remoteId === item.id) {
      if (item.status === 'ready') { task.status = 'ready'; task.progress = task.file.size; }
      if (item.status === 'cancelled') task.status = 'cancelled';
    }
  }
  scheduleHistory();
}
function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = Math.min(15000, 2000 * 2 ** Math.min(state.reconnectAttempt++, 3));
  state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; joinSpace(); }, delay);
}
async function joinSpace() {
  if (state.joining) return;
  state.joining = true;
  if (!state.client) setConnection('connecting');
  try {
    const joined = await api('/api/join', { method: 'POST', body: { name: state.name, room: state.room, clientId: state.client?.id, token: state.token } });
    const previousId = state.client?.id;
    state.client = joined.client; state.token = joined.token;
    state.config = { ...state.config, ...joined.config };
    saveSession(); applySnapshot(joined.snapshot); renderIdentity(); renderConfig();
    if (previousId && previousId !== state.client.id) {
      for (const task of state.tasks.values()) {
        if (!['ready', 'cancelled'].includes(task.status)) {
          task.pauseRequested = true; task.xhr?.abort(); task.status = 'failed'; task.error = '服务已重启，请重新选择文件发送'; task.sessionExpired = true;
        }
      }
    }
    state.source?.close();
    const source = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
    state.source = source;
    source.onopen = () => { if (state.source === source) { setConnection('online'); state.reconnectAttempt = 0; clearTimeout(state.reconnectTimer); state.reconnectTimer = null; } };
    source.addEventListener('snapshot', (event) => { if (state.source === source) applySnapshot(JSON.parse(event.data)); });
    source.addEventListener('presence', (event) => { if (state.source === source) { state.clients = JSON.parse(event.data).clients || []; renderDevices(); } });
    source.addEventListener('item', (event) => { if (state.source === source) receiveItem(JSON.parse(event.data).item); });
    source.onerror = () => { if (state.source === source) { setConnection('offline'); scheduleReconnect(); } };
  } catch (error) { setConnection('offline'); scheduleReconnect(); }
  finally { state.joining = false; scheduleHistory(); }
}
function renderIdentity() {
  $('#profile-name').textContent = state.name;
  $('#profile-avatar').textContent = state.name.slice(0, 1);
  $('#space-name').textContent = state.room === 'lobby' ? '公共空间' : `空间 ${state.room}`;
  $('#space-button').title = state.room === 'lobby' ? '切换共享空间' : `当前空间码 ${state.room}，点击切换`;
}
function renderDevices() {
  const clients = state.clients.slice().sort((a, b) => Number(b.id === state.client?.id) - Number(a.id === state.client?.id));
  $('#device-count').textContent = String(clients.length);
  $('#devices').innerHTML = clients.length ? clients.map((client) => {
    const self = client.id === state.client?.id;
    const phone = /手机|iPhone|iPad|Android/i.test(client.name);
    return `<div class="device${self ? ' self' : ''}"><span class="device-avatar">${icon(phone ? 'phone' : 'laptop')}</span><div class="device-info"><div class="device-name"><span title="${escapeHtml(client.name)}">${escapeHtml(client.name)}</span>${self ? '<span class="self-tag">本机</span>' : ''}</div><div class="device-subtitle">${self ? '随时准备分享' : '在线 · 可接收'}</div></div></div>`;
  }).join('') : '<p class="muted device-loading">连接后即可查看在线设备</p>';
}
function shareUrl(base) {
  const url = new URL(base || preferredAddress());
  url.pathname = '/'; url.search = ''; url.hash = '';
  if (state.room !== 'lobby') url.searchParams.set('room', state.room);
  return url.href;
}
function preferredAddress() {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return location.origin;
  return state.info?.addresses?.find((address) => !/\/\/(localhost|127\.|\[::1\])/.test(address)) || location.origin;
}
function renderConfig() {
  $('#max-file-size').textContent = formatBytes(state.config.maxFileSize);
  $$('.retention-hours').forEach((element) => { element.textContent = state.config.retentionHours; });
  const url = shareUrl();
  $('#share-address').textContent = url.replace(/^http:\/\//, '').replace(/\/$/, '');
  $('#address-button').title = url;
  const addresses = [...new Set([...(state.info?.addresses || []), location.origin])];
  $('#lan-addresses').innerHTML = addresses.map((address) => {
    const url = shareUrl(address);
    return `<div class="lan-address"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a><button data-copy-address="${escapeHtml(url)}" aria-label="复制地址">复制</button></div>`;
  }).join('');
}
async function copyText(value, success = '已复制') {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const input = document.createElement('textarea'); input.value = value;
      input.className = 'sr-only';
      const parent = document.querySelector('dialog[open]') || document.body;
      const focused = document.activeElement; parent.append(input); input.select();
      const copied = document.execCommand('copy'); input.remove(); focused?.focus();
      if (!copied) throw new Error('copy');
    }
    toast(success);
  } catch { toast('无法自动复制，请长按或选中地址手动复制', true); }
}
function switchTab(tab, focus = false) {
  state.tab = tab;
  for (const type of ['file', 'text']) {
    const active = type === tab;
    $(`#${type}-tab`).classList.toggle('active', active);
    $(`#${type}-tab`).setAttribute('aria-selected', String(active));
    $(`#${type}-tab`).tabIndex = active ? 0 : -1;
    $(`#${type}-panel`).hidden = !active;
  }
  if (focus) $(`#${tab}-tab`).focus();
  if (tab === 'text' && !focus) $('#message-input').focus();
}
function scheduleHistory() {
  if (state.renderFrame) return;
  state.renderFrame = requestAnimationFrame(() => { state.renderFrame = null; renderHistory(); });
}
function receiptsHtml(item) {
  const receipts = (item.receipts || []).filter((receipt) => receipt.clientId !== item.senderId);
  const label = receipts.length ? `${receipts.map((receipt) => receipt.name).join('、')} 已确认收到` : '等待接收方确认';
  return `<span class="receipt${receipts.length ? ' received' : ''}">${icon(receipts.length ? 'double-check' : 'clock')}<span>${escapeHtml(label)}</span></span>`;
}
function confirmationButton(item) {
  if (item.senderId === state.client?.id) return '';
  const received = item.receipts?.some((receipt) => receipt.clientId === state.client?.id);
  return received ? `<button class="action-button confirmed" disabled>${icon('check')}已确认</button>` : `<button class="action-button accent" data-action="confirm" data-id="${item.id}">${icon('check')}确认收到</button>`;
}
function fileUrl(item, inline = false) { return `/api/files/${encodeURIComponent(item.id)}?token=${encodeURIComponent(state.token)}${inline ? '&inline=1' : ''}`; }
function itemCardHtml(item) {
  const mine = item.senderId === state.client?.id;
  const meta = `<div class="item-meta"><span>${escapeHtml(item.senderName)}</span><span>·</span><time datetime="${escapeHtml(item.createdAt)}">${formatTime(item.createdAt)}</time><span class="direction">${mine ? '由你发送' : '收到分享'}</span></div>`;
  if (item.type === 'text') {
    return `${meta}<div class="text-content">${escapeHtml(item.text)}</div><div class="text-actions"><button class="action-button" data-action="copy-message" data-id="${item.id}">${icon('copy')}复制文字</button>${confirmationButton(item)}</div><div class="item-footer">${receiptsHtml(item)}</div>`;
  }
  const isImage = /^image\/(png|jpeg|gif|webp|avif)$/.test(item.mime);
  let actions = '';
  if (item.status === 'ready') actions = `<a class="action-button" href="${fileUrl(item)}" download="${escapeHtml(item.name)}" data-action="download" data-id="${item.id}">${icon('download')}下载文件</a>${confirmationButton(item)}`;
  else if (item.status === 'uploading' && mine) actions = `<button class="action-button danger" data-action="cancel-remote" data-id="${item.id}">${icon('close')}取消上传</button>`;
  const percent = item.size ? Math.min(100, Math.round((item.offset || 0) / item.size * 100)) : 0;
  return `${meta}<div class="file-body"><span class="file-icon${isImage ? ' image-icon' : ''}">${icon(isImage ? 'image' : 'file')}</span><div class="file-info"><div class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div><div class="file-details"><span>${formatBytes(item.size)}</span><span>${item.status === 'ready' ? '可下载' : item.status === 'cancelled' ? '已取消' : '正在上传'}</span></div></div><div class="item-actions">${actions}</div></div>${isImage && item.status === 'ready' ? `<img class="image-preview" src="${fileUrl(item, true)}" alt="${escapeHtml(item.name)}" loading="lazy" decoding="async">` : ''}${item.status === 'uploading' ? `<progress class="progress-track" max="100" value="${percent}" aria-label="上传进度">${percent}%</progress><div class="progress-row"><span>${mine ? '上传未完成，请回到原页面继续或取消后重新发送' : '发送方正在上传，请稍候'}</span><strong>${percent}%</strong></div>` : ''}${item.status === 'ready' ? `<div class="item-footer">${receiptsHtml(item)}<span class="download-hint">下载进度在浏览器中查看</span></div>` : ''}`;
}
function taskCardHtml(task) {
  const remote = state.items.get(task.remoteId);
  if (remote?.status === 'ready' || remote?.status === 'cancelled') return itemCardHtml(remote);
  const percent = task.file.size ? Math.min(99, Math.floor(task.progress / task.file.size * 100)) : 0;
  const paused = task.status === 'paused'; const failed = task.status === 'failed';
  let label = task.status === 'queued' ? '排队中，马上开始' : task.status === 'preparing' ? '正在准备传输…' : paused ? '已暂停，点击继续可从断点上传' : failed ? task.error : task.retryLabel || `正在上传 · ${formatBytes(Math.max(0, task.progress - task.startOffset) / Math.max(1, (Date.now() - task.startedAt) / 1000))}/s`;
  if (task.status === 'cancelled') label = '已取消';
  const actions = task.status === 'cancelled' ? '' : `${paused || failed ? !task.sessionExpired ? `<button class="action-button accent" data-action="resume" data-id="${task.id}">${icon(paused ? 'play' : 'retry')}${paused ? '继续' : '重试'}</button>` : '' : `<button class="action-button" data-action="pause" data-id="${task.id}" aria-label="暂停上传">${icon('pause')}暂停</button>`}<button class="action-button danger" data-action="cancel" data-id="${task.id}" aria-label="取消上传">${icon('close')}</button>`;
  return `<div class="item-meta"><span>${escapeHtml(state.name)}</span><span>·</span><time>${formatTime(task.createdAt)}</time><span class="direction">由你发送</span></div><div class="file-body"><span class="file-icon${task.file.type.startsWith('image/') ? ' image-icon' : ''}">${icon(task.file.type.startsWith('image/') ? 'image' : 'file')}</span><div class="file-info"><div class="file-name" title="${escapeHtml(task.file.name)}">${escapeHtml(task.file.name)}</div><div class="file-details"><span>${formatBytes(task.file.size)}</span><span data-progress-bytes>${formatBytes(task.progress)} 已上传</span></div></div><div class="item-actions">${actions}</div></div>${task.status === 'cancelled' ? `<p class="cancelled-note">已取消上传</p>` : `<progress class="progress-track" data-progress-bar max="100" value="${percent}" aria-label="上传进度">${percent}%</progress><div class="progress-row${failed ? ' error' : ''}"><span data-progress-label>${escapeHtml(label)}</span><strong data-progress-percent>${percent}%</strong></div>`}`;
}
function renderHistory() {
  const localIds = new Set([...state.tasks.values()].map((task) => task.remoteId).filter(Boolean));
  const entries = [...state.items.values()].filter((item) => !localIds.has(item.id)).map((item) => ({ key: item.id, type: item.type, createdAt: item.createdAt, item }));
  for (const task of state.tasks.values()) entries.push({ key: task.id, type: 'file', createdAt: task.createdAt, task });
  $('#history-count').textContent = String(entries.length);
  const filtered = entries.filter((entry) => state.filter === 'all' || entry.type === state.filter).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const container = $('#activity-list');
  if (!filtered.length) {
    const html = `<div class="empty-state"><div class="empty-illustration" aria-hidden="true"><span class="empty-node">${icon('laptop')}</span>${icon('swap')}<span class="empty-node">${icon('phone')}</span></div><h3>${entries.length ? '这里还没有这类分享' : '从这里开始，轻松分享'}</h3><p>${entries.length ? '试试其他筛选，或发送新的内容' : '选择一个文件，或发送第一条文字消息'}</p></div>`;
    if (container.dataset.empty !== html) { container.innerHTML = html; container.dataset.empty = html; }
    return;
  }
  delete container.dataset.empty;
  container.querySelector('.empty-state')?.remove();
  const existing = new Map([...container.children].map((child) => [child.dataset.key, child]));
  const keys = new Set(filtered.map((entry) => entry.key));
  for (const [key, element] of existing) if (!keys.has(key)) element.remove();
  for (let index = 0; index < filtered.length; index++) {
    const entry = filtered[index];
    let element = existing.get(entry.key);
    if (!element) { element = document.createElement('article'); element.dataset.key = entry.key; }
    element.className = `item-card${entry.task?.status === 'failed' ? ' failed-card' : ''}${entry.task?.status === 'paused' ? ' paused-card' : ''}`;
    const html = entry.task ? taskCardHtml(entry.task) : itemCardHtml(entry.item);
    if (element._html !== html) { element.innerHTML = html; element._html = html; }
    if (container.children[index] !== element) container.insertBefore(element, container.children[index] || null);
  }
}
function updateTaskProgress(task, value) {
  task.progress = Math.max(0, Math.min(task.file.size, value));
  const element = [...$('#activity-list').children].find((child) => child.dataset.key === task.id);
  if (!element) return;
  const percent = task.file.size ? Math.min(99, Math.floor(task.progress / task.file.size * 100)) : 0;
  const bar = element.querySelector('[data-progress-bar]'); if (bar) bar.value = percent;
  const text = element.querySelector('[data-progress-percent]'); if (text) text.textContent = `${percent}%`;
  const bytes = element.querySelector('[data-progress-bytes]'); if (bytes) bytes.textContent = `${formatBytes(task.progress)} 已上传`;
  const label = element.querySelector('[data-progress-label]');
  if (label && task.status === 'uploading' && !task.retryLabel) label.textContent = `正在上传 · ${formatBytes(Math.max(0, task.progress - task.startOffset) / Math.max(1, (Date.now() - task.startedAt) / 1000))}/s`;
}
function uploadChunk(task, offset, blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); task.xhr = xhr;
    xhr.upload.onprogress = (event) => { if (event.lengthComputable && !task.pauseRequested && !task.cancelRequested) updateTaskProgress(task, offset + event.loaded); };
    xhr.open('PUT', `/api/transfers/${encodeURIComponent(task.remoteId)}?offset=${offset}`);
    xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.timeout = 120000;
    xhr.onload = () => {
      let data; try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else { const error = new Error(data.error || `上传失败（${xhr.status}）`); error.status = xhr.status; error.offset = data.offset; reject(error); }
    };
    xhr.onerror = () => reject(new Error('网络中断，请检查网络后重试'));
    xhr.ontimeout = () => reject(new Error('上传超时，请检查网络后重试'));
    xhr.onabort = () => { const error = new Error('已暂停'); error.aborted = true; reject(error); };
    xhr.send(blob);
  });
}
async function runTask(task) {
  task.running = true; state.running++; task.pauseRequested = false; task.cancelRequested = false;
  task.status = 'preparing'; task.error = ''; task.retryLabel = ''; scheduleHistory();
  let attempts = 0;
  try {
    while (true) {
      try {
        if (!task.remoteId) {
          const { item } = await api('/api/transfers', { method: 'POST', body: { name: task.file.name, size: task.file.size, mime: task.file.type || 'application/octet-stream', requestId: task.requestId } });
          task.remoteId = item.id; receiveItem(item);
        }
        if (task.cancelRequested || task.pauseRequested) break;
        const { item } = await api(`/api/transfers/${task.remoteId}`);
        receiveItem(item);
        if (item.status === 'ready') { task.status = 'ready'; break; }
        if (item.status === 'cancelled') { task.status = 'cancelled'; break; }
        task.progress = item.offset || 0; task.startOffset = task.progress; task.startedAt = Date.now(); task.status = 'uploading'; task.retryLabel = ''; scheduleHistory();
        while (task.progress < task.file.size && !task.pauseRequested && !task.cancelRequested) {
          const offset = task.progress;
          const end = Math.min(offset + state.config.chunkSize, task.file.size);
          const result = await uploadChunk(task, offset, task.file.slice(offset, end));
          task.progress = result.offset; receiveItem(result.item); attempts = 0;
        }
        if (task.cancelRequested || task.pauseRequested) break;
        task.retryLabel = '正在完成传输…'; scheduleHistory();
        const result = await api(`/api/transfers/${task.remoteId}/complete`, { method: 'POST', body: {} });
        task.status = 'ready'; task.progress = task.file.size; receiveItem(result.item); break;
      } catch (error) {
        if (task.cancelRequested || task.pauseRequested || error.aborted) break;
        if ((!error.status || [408, 409, 429, 500, 502, 503, 504].includes(error.status)) && attempts < 2) {
          attempts++; task.retryLabel = `连接中断，正在重试（${attempts}/2）…`; scheduleHistory();
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempts - 1)));
          if (task.cancelRequested || task.pauseRequested) break;
          continue;
        }
        task.status = 'failed';
        if ([401, 404].includes(error.status)) {
          task.sessionExpired = true; task.error = '内容已过期或服务已重启，请取消此条目后重新选择文件发送';
        } else task.error = `${error.message}。可点击“重试”继续`;
        break;
      }
    }
  } finally {
    if (task.cancelRequested) {
      task.status = 'cancelled';
      if (task.remoteId && !task.sessionExpired) {
        try { const { item } = await deleteTransfer(task.remoteId); task.cancelPending = false; receiveItem(item); }
        catch { task.status = 'failed'; task.error = '取消请求未送达，请重试或稍后取消'; task.cancelPending = true; }
      }
    } else if (task.pauseRequested && !task.sessionExpired && task.status !== 'ready') task.status = 'paused';
    task.running = false; task.xhr = null; state.running--; scheduleHistory(); runQueue();
  }
}
function runQueue() {
  for (const task of state.tasks.values()) {
    if (state.running >= state.maxConcurrent) break;
    if (task.status === 'queued' && !task.running) void runTask(task);
  }
}
function queueFiles(fileList) {
  if (!state.client || !state.online) { toast('请等待连接恢复后再选择文件', true); return; }
  const files = [...fileList];
  const pending = [...state.tasks.values()].filter((task) => !['ready', 'cancelled'].includes(task.status)).length;
  if (pending + files.length > 50) { toast('每次最多保留 50 个待传文件，请先完成当前传输', true); return; }
  let added = 0;
  for (const file of files) {
    if (file.size > state.config.maxFileSize) { toast(`${file.name} 超过单文件 ${formatBytes(state.config.maxFileSize)} 限制`, true); continue; }
    const id = uniqueId(); state.tasks.set(id, { id, requestId: id, file, createdAt: new Date().toISOString(), progress: 0, status: 'queued', remoteId: null, running: false }); added++;
  }
  if (added) { switchTab('file'); state.filter = 'all'; renderFilters(); scheduleHistory(); runQueue(); toast(`已添加 ${added} 个文件，开始分享`); }
}
async function deleteTransfer(id) {
  for (let attempt = 0; ; attempt++) {
    try { return await api(`/api/transfers/${id}`, { method: 'DELETE' }); }
    catch (error) {
      if (error.status !== 409 || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
}
async function cancelTask(task) {
  task.cancelRequested = true; task.pauseRequested = false;
  if (task.running) { task.xhr?.abort(); return; }
  if (task.remoteId && !task.sessionExpired) {
    try { const { item } = await deleteTransfer(task.remoteId); receiveItem(item); }
    catch (error) {
      if (![401, 404].includes(error.status)) {
        task.cancelPending = true; task.status = 'failed'; task.error = '取消请求未送达，请点击重试继续取消'; scheduleHistory(); toast(error.message, true); return;
      }
    }
  }
  task.cancelPending = false; task.status = 'cancelled'; scheduleHistory();
}
async function handleActivityAction(event) {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action, id } = button.dataset;
  const task = state.tasks.get(id); const item = state.items.get(id);
  if (action === 'pause' && task) {
    task.pauseRequested = true; task.xhr?.abort(); if (!task.running) task.status = 'paused'; scheduleHistory(); return;
  }
  if (action === 'resume' && task && !task.running) {
    if (task.cancelPending) { await cancelTask(task); return; }
    task.status = 'queued'; task.pauseRequested = false; task.cancelRequested = false; scheduleHistory(); runQueue(); return;
  }
  if (action === 'cancel' && task) { await cancelTask(task); return; }
  if (action === 'copy-message' && item) { await copyText(item.text, '文字已复制'); return; }
  if (action === 'download') { toast('已交给浏览器下载；保存成功后，请点击“确认收到”'); return; }
  if (action === 'confirm' || action === 'cancel-remote') {
    button.disabled = true;
    try {
      const result = await api(action === 'confirm' ? `/api/items/${id}/receipt` : `/api/transfers/${id}`, { method: action === 'confirm' ? 'POST' : 'DELETE', ...(action === 'confirm' ? { body: {} } : {}) });
      receiveItem(result.item); toast(action === 'confirm' ? '已向发送方确认收到' : '已取消这次上传');
    } catch (error) { toast(error.message, true); button.disabled = false; }
  }
}
async function sendMessage(event) {
  event.preventDefault(); const input = $('#message-input'); const text = input.value.trim();
  if (!text || state.sendingMessage) return;
  if (!state.client) { toast('请先连接服务', true); return; }
  state.sendingMessage = true; const button = $('#send-message-button'); button.disabled = true; button.innerHTML = `${icon('send')}发送中…`;
  if (state.pendingMessage?.text !== text) state.pendingMessage = { text, requestId: uniqueId() };
  try {
    const result = await api('/api/messages', { method: 'POST', body: state.pendingMessage }); receiveItem(result.item);
    if (input.value.trim() === text) { input.value = ''; $('#character-count').textContent = '0'; }
    state.pendingMessage = null; state.filter = 'all'; renderFilters(); scheduleHistory(); toast('文字已发送到当前空间');
  } catch (error) { toast(`${error.message}；内容已保留，可再次发送`, true); }
  finally { state.sendingMessage = false; button.disabled = false; button.innerHTML = `${icon('send')}发送文字`; }
}
function renderFilters() { $$('.filters button').forEach((button) => { const active = button.dataset.filter === state.filter; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }); }
async function changeSpace(room) {
  if ([...state.tasks.values()].some((task) => !['ready', 'cancelled'].includes(task.status))) { toast('请先完成或取消当前文件传输，再切换空间', true); return; }
  if (state.sendingMessage || state.joining) { toast('正在连接或发送，请稍候再切换', true); return; }
  state.source?.close(); state.source = null; clearTimeout(state.reconnectTimer); state.reconnectTimer = null;
  state.room = room; state.client = null; state.token = null; state.tasks.clear(); state.items.clear(); state.clients = [];
  const url = new URL(location.href); url.search = ''; if (room !== 'lobby') url.searchParams.set('room', room); history.replaceState(null, '', url);
  $('#space-dialog').close(); renderIdentity(); renderConfig(); renderDevices(); scheduleHistory();
  await joinSpace(); toast(room === 'lobby' ? '已切换到公共空间' : `当前空间码：${room}，邀请其他设备加入即可分享`);
}

$('#file-tab').addEventListener('click', () => switchTab('file'));
$('#text-tab').addEventListener('click', () => switchTab('text'));
$('.tabs').addEventListener('keydown', (event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); switchTab(event.key === 'Home' ? 'file' : event.key === 'End' ? 'text' : state.tab === 'file' ? 'text' : 'file', true); } });
$('#choose-files-button').addEventListener('click', (event) => { event.stopPropagation(); $('#file-input').click(); });
$('#dropzone').addEventListener('click', () => $('#file-input').click());
$('#dropzone').addEventListener('keydown', (event) => { if (event.target === $('#dropzone') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); $('#file-input').click(); } });
$('#file-input').addEventListener('change', (event) => { queueFiles(event.target.files); event.target.value = ''; });
$('#message-form').addEventListener('submit', sendMessage);
$('#message-input').addEventListener('input', (event) => { $('#character-count').textContent = String(event.target.value.length); });
$('#message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) sendMessage(event); });
$('#activity-list').addEventListener('click', (event) => { void handleActivityAction(event); });
$$('.filters button').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; renderFilters(); scheduleHistory(); }));
$('#copy-link-button').addEventListener('click', () => copyText(shareUrl(), '邀请链接已复制，在另一台设备的浏览器打开即可'));
function showHelp() { renderConfig(); $('#help-dialog').showModal(); }
$('#help-button').addEventListener('click', showHelp);
$('#address-button').addEventListener('click', showHelp);
$('#lan-addresses').addEventListener('click', (event) => { const button = event.target.closest('[data-copy-address]'); if (button) copyText(button.dataset.copyAddress, '地址已复制'); });
$('#space-button').addEventListener('click', () => $('#space-dialog').showModal());
$('#join-lobby-button').addEventListener('click', () => changeSpace('lobby'));
$('#space-form').addEventListener('submit', (event) => { event.preventDefault(); const value = $('#room-input').value.trim().toUpperCase(); if (/^[A-Z0-9]{6}$/.test(value)) changeSpace(value); });
$('#room-input').addEventListener('input', (event) => { event.target.value = event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase(); });
$('#create-room-button').addEventListener('click', () => { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const bytes = new Uint8Array(6); crypto.getRandomValues(bytes); changeSpace([...bytes].map((value) => chars[value % chars.length]).join('')); });
$('#profile-button').addEventListener('click', () => { $('#name-input').value = state.name; $('#profile-dialog').showModal(); $('#name-input').select(); });
$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const name = $('#name-input').value.trim(); if (!name) return;
  try { if (state.client) { const result = await api('/api/profile', { method: 'PATCH', body: { name } }); state.client = result.client; saveSession(); } state.name = name; storage.set('neardrop-name', name); renderIdentity(); $('#profile-dialog').close(); toast('设备名称已更新'); }
  catch (error) { toast(error.message, true); }
});
$$('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('#reconnect-button').addEventListener('click', () => { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; joinSpace(); });
window.addEventListener('online', () => { if (!state.online) joinSpace(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.online) joinSpace(); });
window.addEventListener('beforeunload', (event) => { if ([...state.tasks.values()].some((task) => !['ready', 'cancelled'].includes(task.status))) { event.preventDefault(); event.returnValue = ''; } });
let dragDepth = 0;
document.addEventListener('dragenter', (event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); dragDepth++; if (!document.querySelector('dialog[open]')) $('#drag-overlay').hidden = false; } });
document.addEventListener('dragover', (event) => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drag-overlay').hidden = true; });
document.addEventListener('drop', (event) => { event.preventDefault(); dragDepth = 0; $('#drag-overlay').hidden = true; if (!document.querySelector('dialog[open]') && event.dataTransfer.files.length) queueFiles(event.dataTransfer.files); });
document.addEventListener('paste', (event) => { if (!document.querySelector('dialog[open]') && event.clipboardData?.files.length) { event.preventDefault(); queueFiles(event.clipboardData.files); } });

renderIdentity(); renderConfig(); renderHistory();
void api('/api/info').then((info) => { state.info = info; state.config = { ...state.config, ...info }; renderConfig(); }).catch(() => {});
void joinSpace();
