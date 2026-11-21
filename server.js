import http from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const fallback = () => console.log(`未能自动打开浏览器，请手动访问：${url}`);
  try {
    const browser = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    browser.once('error', fallback);
    browser.once('exit', (code) => { if (code) fallback(); });
    browser.unref();
  } catch { fallback(); }
}
const SAFE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const PUBLIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icons.svg', ['icons.svg', 'image/svg+xml']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

class HttpError extends Error {
  constructor(status, message, code, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

function positiveNumber(value, fallback, name, integer = true) {
  if (value === undefined || value === '') return fallback;
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0 || (integer && !Number.isSafeInteger(result))) {
    throw new Error(`${name} 必须是大于 0 的${integer ? '整数' : '数字'}`);
  }
  return result;
}

export function localAddresses(port, interfaces = os.networkInterfaces()) {
  const addresses = new Map();
  const virtualName = /vmware|virtual|vethernet|wsl|docker|tun(?:nel)?|tap|mihomo|vpn|hyper-v|tailscale|zerotier|wireguard|loopback|bluetooth|蓝牙|虚拟/i;
  const physicalName = /wi[\s-]?fi|wlan|ethernet|以太网|无线/i;
  let order = 0;
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal || item.address.startsWith('169.254.')) continue;
      const octets = item.address.split('.').map(Number);
      const privateAddress = octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
      // Home Wi-Fi/Ethernet comes first; keep VPN and VM networks as alternate routes.
      const rank = virtualName.test(name) ? (privateAddress ? 4 : 5)
        : privateAddress ? (physicalName.test(name) ? 0 : 1)
          : physicalName.test(name) ? 2 : 3;
      const previous = addresses.get(item.address);
      if (!previous || rank < previous.rank) addresses.set(item.address, { rank, order: order++, url: `http://${item.address}:${port}` });
    }
  }
  return [...addresses.values()].sort((a, b) => a.rank - b.rank || a.order - b.order).map((item) => item.url);
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function textValue(value, max, label) {
  if (typeof value !== 'string') throw new HttpError(400, `请提供${label}`, 'INVALID_INPUT');
  const result = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!result || result.length > max) throw new HttpError(400, `${label}长度应为 1–${max} 个字符`, 'INVALID_INPUT');
  return result;
}

function requestKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value)) {
    throw new HttpError(400, '请求标识无效，请刷新后重试', 'INVALID_REQUEST_ID');
  }
  return value;
}

async function readJson(req, limit = 64 * 1024) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, '请使用 JSON 格式发送请求', 'INVALID_CONTENT_TYPE');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new HttpError(413, '请求内容过长', 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, '请求格式无效', 'INVALID_JSON');
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function publicItem(item) {
  const result = {
    id: item.id, type: item.type, senderId: item.senderId, senderName: item.senderName,
    createdAt: item.createdAt, status: item.status, receipts: item.receipts,
    expiresAt: item.expiresAt,
  };
  if (item.type === 'text') result.text = item.text;
  else Object.assign(result, { name: item.name, size: item.size, mime: item.mime, offset: item.offset });
  return result;
}

/**
 * Create a dependency-free LAN relay. The returned native http.Server is not listening yet.
 * await server.shutdown() closes SSE streams, the listener, and this run's temporary files.
 */
export async function createLanServer(options = {}) {
  const config = {
    port: Number(options.port ?? process.env.PORT ?? 3210),
    host: options.host ?? process.env.HOST ?? '0.0.0.0',
    maxFileSize: positiveNumber(options.maxFileSize ?? process.env.MAX_FILE_SIZE, 2 * 1024 ** 3, 'MAX_FILE_SIZE'),
    chunkSize: positiveNumber(options.chunkSize, 1024 ** 2, 'chunkSize'),
    retentionHours: positiveNumber(options.retentionHours ?? process.env.RETENTION_HOURS, 24, 'RETENTION_HOURS', false),
    maxStorageBytes: positiveNumber(options.maxStorageBytes ?? process.env.MAX_STORAGE_BYTES, 10 * 1024 ** 3, 'MAX_STORAGE_BYTES'),
    maxItems: positiveNumber(options.maxItems, 200, 'maxItems'),
    sweepIntervalMs: positiveNumber(options.sweepIntervalMs, 60_000, 'sweepIntervalMs'),
    shutdownGraceMs: positiveNumber(options.shutdownGraceMs, 1000, 'shutdownGraceMs'),
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('PORT 必须是 0–65535 的整数');
  const retentionMs = config.retentionHours * 3_600_000;
  const dataRoot = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? path.join(os.tmpdir(), 'linchuan-transfer'));
  await fs.mkdir(dataRoot, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(dataRoot, 'session-'));
  await fs.writeFile(path.join(dataDir, 'owner.json'), JSON.stringify({ app: 'linchuan-transfer', pid: process.pid, createdAt: Date.now() }));
  const cleanOrphans = async () => {
    const entries = await fs.readdir(dataRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
      const directory = path.join(dataRoot, entry.name);
      if (directory === dataDir) continue;
      try {
        const owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'));
        if (owner.app !== 'linchuan-transfer' || !Number.isSafeInteger(owner.pid) || Date.now() - owner.createdAt <= retentionMs) continue;
        let running = true;
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
        if (!running) await fs.rm(directory, { recursive: true, force: true });
      } catch { /* Only remove known, expired data owned by this application. */ }
    }
  };
  await cleanOrphans();
  const clients = new Map();
  const tokens = new Map();
  const rooms = new Map();
  const rates = new Map();
  let reservedBytes = 0;
  let closing = false;

  const roomFor = (name) => {
    if (!rooms.has(name)) rooms.set(name, { items: new Map(), requests: new Map() });
    return rooms.get(name);
  };
  const clientView = (client) => ({ id: client.id, name: client.name, room: client.room });
  const onlineClients = (room) => [...clients.values()]
    .filter((client) => client.room === room && client.online)
    .map((client) => ({ id: client.id, name: client.name, online: true }));
  const snapshot = (room) => ({
    clients: onlineClients(room),
    items: [...roomFor(room).items.values()].filter((item) => Date.parse(item.expiresAt) > Date.now()).map(publicItem),
  });
  const send = (stream, event, data) => {
    if (stream.destroyed || stream.writableEnded) return;
    // A stalled browser reconnects with a fresh snapshot instead of growing a buffer forever.
    if (stream.writableLength > 1024 ** 2) { stream.end(); return; }
    stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (room, event, data) => {
    for (const client of clients.values()) {
      if (client.room === room) for (const stream of client.streams) send(stream, event, data);
    }
  };
  const presence = (room) => broadcast(room, 'presence', { clients: onlineClients(room) });
  const itemEvent = (room, item) => broadcast(room, 'item', { item: publicItem(item) });
  const markOnline = (client) => {
    clearTimeout(client.offlineTimer);
    client.lastSeen = Date.now();
    const changed = !client.online;
    client.online = true;
    if (changed) presence(client.room);
  };
  const markOfflineLater = (client) => {
    clearTimeout(client.offlineTimer);
    client.offlineTimer = setTimeout(() => {
      if (client.streams.size) return;
      client.online = false;
      client.lastSeen = Date.now();
      presence(client.room);
    }, 15_000);
    client.offlineTimer.unref();
  };
  const removeItem = async (room, item) => {
    const state = roomFor(room);
    if (!state.items.delete(item.id)) return;
    if (item.requestKey) state.requests.delete(item.requestKey);
    if (item.type === 'file' && item.reserved) {
      reservedBytes -= item.size;
      item.reserved = false;
      await fs.rm(item.filePath, { force: true }).catch(() => {});
    }
  };
  const makeSpace = async (room) => {
    const state = roomFor(room);
    let removed = false;
    while (state.items.size >= config.maxItems) {
      const candidate = [...state.items.values()].find((item) => item.status !== 'uploading' && !item.locked);
      if (!candidate) throw new HttpError(429, '当前传输较多，请稍后再试', 'ROOM_FULL');
      await removeItem(room, candidate);
      removed = true;
    }
    if (removed) broadcast(room, 'snapshot', snapshot(room));
  };
  const auth = (req, url, queryAllowed = false) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (queryAllowed ? url.searchParams.get('token') : '');
    const client = tokens.get(token);
    if (!client) throw new HttpError(401, '连接已失效，请重新加入空间', 'UNAUTHORIZED');
    client.lastSeen = Date.now();
    return client;
  };
  const findItem = (client, id, ownerOnly = false) => {
    const item = roomFor(client.room).items.get(id);
    if (!item || Date.parse(item.expiresAt) <= Date.now()) throw new HttpError(404, '内容不存在或已过期', 'NOT_FOUND');
    if (ownerOnly && item.senderId !== client.id) throw new HttpError(403, '只有发送者可以操作此传输', 'FORBIDDEN');
    return item;
  };
  const publishedConfig = () => ({ maxFileSize: config.maxFileSize, chunkSize: config.chunkSize, retentionHours: config.retentionHours });
  const knownHosts = new Set(['localhost', '127.0.0.1', '[::1]', os.hostname().toLowerCase(), config.host.toLowerCase()]);
  for (const list of Object.values(os.networkInterfaces())) for (const item of list || []) knownHosts.add(item.address.toLowerCase());

  async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (closing) throw new HttpError(503, '服务正在关闭，请稍后重试', 'SHUTTING_DOWN');
      let url;
      try { url = new URL(req.url, `http://${req.headers.host}`); } catch { throw new HttpError(400, '请求地址无效'); }
      if (!knownHosts.has(url.hostname.toLowerCase())) throw new HttpError(403, '请使用本机或局域网 IP 地址访问服务', 'INVALID_HOST');
      if (req.headers.origin && req.headers.origin !== url.origin) throw new HttpError(403, '不允许跨站请求', 'INVALID_ORIGIN');
      if (req.method === 'OPTIONS') throw new HttpError(405, '不允许跨站请求', 'METHOD_NOT_ALLOWED');

      if (req.method === 'GET' && url.pathname === '/api/info') {
        const port = server.address()?.port ?? config.port;
        return json(res, 200, { addresses: localAddresses(port), port, ...publishedConfig(), version: VERSION });
      }
      if (!['GET', 'HEAD', 'PUT'].includes(req.method)) {
        const key = req.socket.remoteAddress || 'unknown';
        const current = rates.get(key);
        const bucket = !current || current.until < Date.now() ? { count: 0, until: Date.now() + 60_000 } : current;
        rates.set(key, bucket);
        if (++bucket.count > 1500) throw new HttpError(429, '请求过于频繁，请稍后重试', 'RATE_LIMITED');
      }
      if (req.method === 'POST' && url.pathname === '/api/join') {
        const body = await readJson(req);
        const name = textValue(body.name, 40, '设备名称');
        const room = body.room === 'lobby' || !body.room ? 'lobby' : String(body.room).trim().toUpperCase();
        if (room !== 'lobby' && !/^[A-Z0-9]{6}$/.test(room)) throw new HttpError(400, '空间码需要 6 位大写字母或数字', 'INVALID_ROOM');
        let client = clients.get(body.clientId);
        if (!client || !sameToken(client.token, body.token)) {
          if (clients.size >= 2000) throw new HttpError(503, '当前设备过多，请稍后重试', 'CLIENT_LIMIT');
          client = { id: randomUUID(), token: randomBytes(32).toString('base64url'), streams: new Set(), room, name, online: false, lastSeen: Date.now() };
          clients.set(client.id, client);
          tokens.set(client.token, client);
        } else if (client.room !== room) {
          const oldRoom = client.room;
          for (const stream of client.streams) stream.end();
          client.streams.clear();
          client.room = room;
          presence(oldRoom);
        }
        client.name = name;
        markOnline(client);
        markOfflineLater(client);
        presence(room);
        return json(res, 200, { client: clientView(client), token: client.token, config: publishedConfig(), snapshot: snapshot(room) });
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        const client = auth(req, url, true);
        if (client.streams.size >= 4) {
          const first = client.streams.values().next().value;
          first.end();
          client.streams.delete(first);
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        client.streams.add(res);
        markOnline(client);
        send(res, 'snapshot', snapshot(client.room));
        presence(client.room);
        req.on('close', () => {
          client.streams.delete(res);
          if (!client.streams.size) markOfflineLater(client);
        });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const download = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
        const client = auth(req, url, Boolean(download));
        const currentRoom = client.room;
        if (req.method === 'GET' && url.pathname === '/api/snapshot') return json(res, 200, snapshot(client.room));
        if (req.method === 'PATCH' && url.pathname === '/api/profile') {
          const body = await readJson(req);
          client.name = textValue(body.name, 40, '设备名称');
          presence(client.room);
          return json(res, 200, { client: clientView(client) });
        }
        if (req.method === 'POST' && ['/api/messages', '/api/transfers'].includes(url.pathname)) {
          const body = await readJson(req);
          const type = url.pathname === '/api/messages' ? 'text' : 'file';
          const state = roomFor(currentRoom);
          const previousLock = state.createLock || Promise.resolve();
          let releaseLock;
          state.createLock = new Promise((resolve) => { releaseLock = resolve; });
          await previousLock;
          try {
          const key = `${client.id}:${type}:${requestKey(body.requestId)}`;
          const previous = state.items.get(state.requests.get(key));
          if (previous) return json(res, 200, { item: publicItem(previous) });
          let data;
          if (type === 'text') data = { text: textValue(body.text, 10_000, '消息') };
          else {
            // Normalize malformed Unicode so filename encoding can never break a download.
            const name = Buffer.from(textValue(body.name, 255, '文件名').replace(/[\r\n]/g, ' '), 'utf8').toString('utf8');
            const size = body.size;
            if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, '文件大小无效', 'INVALID_SIZE');
            if (size > config.maxFileSize) throw new HttpError(413, '文件超出单文件大小限制', 'FILE_TOO_LARGE');
            if (reservedBytes + size > config.maxStorageBytes) throw new HttpError(507, '暂存空间不足，请稍后重试或联系服务运行者', 'STORAGE_FULL');
            const mime = typeof body.mime === 'string' && body.mime.length <= 127 && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(body.mime) ? body.mime.toLowerCase() : 'application/octet-stream';
            data = { name, size, mime, offset: 0 };
          }
          await makeSpace(currentRoom);
          // Recheck after the await: parallel creates must not over-reserve disk space.
          if (type === 'file' && reservedBytes + data.size > config.maxStorageBytes) throw new HttpError(507, '暂存空间不足，请稍后重试', 'STORAGE_FULL');
          const item = {
            id: randomUUID(), type, senderId: client.id, senderName: client.name,
            createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + retentionMs).toISOString(),
            status: type === 'text' ? 'ready' : 'uploading', receipts: [], requestKey: key, ...data,
          };
          if (type === 'file') {
            item.filePath = path.join(dataDir, item.id);
            item.reserved = true;
            reservedBytes += item.size;
            try { const handle = await fs.open(item.filePath, 'wx'); await handle.close(); }
            catch (error) { reservedBytes -= item.size; throw error; }
          }
          state.items.set(item.id, item);
          state.requests.set(key, item.id);
          itemEvent(currentRoom, item);
          return json(res, 201, { item: publicItem(item) });
          } finally {
            releaseLock();
          }
        }
        const transfer = /^\/api\/transfers\/([^/]+)(\/complete)?$/.exec(url.pathname);
        if (transfer) {
          const item = findItem({ id: client.id, room: currentRoom }, transfer[1], req.method !== 'GET');
          if (item.type !== 'file') throw new HttpError(404, '传输不存在', 'NOT_FOUND');
          if (req.method === 'GET' && !transfer[2]) return json(res, 200, { item: publicItem(item) });
          if (req.method === 'PUT' && !transfer[2]) {
            if (item.status !== 'uploading') throw new HttpError(409, '此传输已结束', 'TRANSFER_CLOSED', { offset: item.offset });
            if (item.locked) throw new HttpError(409, '文件正在写入，请稍后重试', 'UPLOAD_BUSY', { offset: item.offset });
            const rawOffset = url.searchParams.get('offset');
            const offset = Number(rawOffset);
            if (!rawOffset || !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset) || offset !== item.offset) {
              throw new HttpError(409, '上传位置已变化，请继续重试', 'OFFSET_MISMATCH', { offset: item.offset });
            }
            if (Number(req.headers['content-length']) > config.chunkSize) throw new HttpError(413, '上传分块过大', 'CHUNK_TOO_LARGE');
            item.locked = true;
            let handle;
            let written = 0;
            try {
              handle = await fs.open(item.filePath, 'r+');
              for await (const chunk of req) {
                if (written + chunk.length > config.chunkSize || offset + written + chunk.length > item.size) throw new HttpError(413, '上传分块超出允许范围', 'CHUNK_TOO_LARGE');
                let cursor = 0;
                while (cursor < chunk.length) {
                  const { bytesWritten } = await handle.write(chunk, cursor, chunk.length - cursor, offset + written + cursor);
                  if (!bytesWritten) throw new Error('Unable to write upload chunk');
                  cursor += bytesWritten;
                }
                written += chunk.length;
              }
              if (!written) throw new HttpError(400, '上传分块不能为空', 'EMPTY_CHUNK');
              item.offset += written;
            } catch (error) {
              if (handle) await handle.truncate(offset).catch(() => {});
              throw error;
            } finally {
              if (handle) await handle.close().catch(() => {});
              item.locked = false;
            }
            itemEvent(currentRoom, item);
            return json(res, 200, { offset: item.offset, item: publicItem(item) });
          }
          if (req.method === 'POST' && transfer[2]) {
            await readJson(req);
            if (item.status === 'ready') return json(res, 200, { item: publicItem(item) });
            if (item.status === 'cancelled') throw new HttpError(409, '传输已取消', 'TRANSFER_CLOSED');
            if (item.locked || item.offset !== item.size) throw new HttpError(409, '文件尚未上传完成，请继续重试', 'UPLOAD_INCOMPLETE', { offset: item.offset });
            item.status = 'ready';
            itemEvent(currentRoom, item);
            return json(res, 200, { item: publicItem(item) });
          }
          if (req.method === 'DELETE' && !transfer[2]) {
            if (item.locked) throw new HttpError(409, '文件正在写入，请稍后取消', 'UPLOAD_BUSY', { offset: item.offset });
            if (item.status !== 'cancelled') {
              item.status = 'cancelled';
              if (item.reserved) {
                reservedBytes -= item.size;
                item.reserved = false;
                await fs.rm(item.filePath, { force: true }).catch(() => {});
              }
              itemEvent(currentRoom, item);
            }
            return json(res, 200, { item: publicItem(item) });
          }
        }
        const receipt = /^\/api\/items\/([^/]+)\/receipt$/.exec(url.pathname);
        if (receipt && req.method === 'POST') {
          await readJson(req);
          const item = findItem(client, receipt[1]);
          if (item.senderId === client.id) throw new HttpError(400, '无需确认自己发送的内容', 'OWN_RECEIPT');
          if (item.status !== 'ready') throw new HttpError(409, '内容尚不可接收', 'NOT_READY');
          if (!item.receipts.some((entry) => entry.clientId === client.id)) {
            item.receipts.push({ clientId: client.id, name: client.name, at: new Date().toISOString() });
            itemEvent(client.room, item);
          }
          return json(res, 200, { item: publicItem(item) });
        }
        if (download && ['GET', 'HEAD'].includes(req.method)) {
          const item = findItem(client, download[1]);
          if (item.type !== 'file' || item.status !== 'ready') throw new HttpError(409, '文件尚不可下载', 'NOT_READY');
          const inline = url.searchParams.get('inline') === '1' && SAFE_IMAGES.has(item.mime);
          const asciiName = item.name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
          const encodedName = encodeURIComponent(item.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
          const headers = {
            'Content-Type': inline ? item.mime : 'application/octet-stream',
            'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
            'Accept-Ranges': 'bytes', 'Content-Length': item.size,
          };
          let start = 0;
          let end = item.size - 1;
          let status = 200;
          if (req.headers.range) {
            const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (range && (range[1] || range[2])) {
              if (!range[1]) start = Math.max(0, item.size - Number(range[2]));
              else start = Number(range[1]);
              if (range[1] && range[2]) end = Math.min(end, Number(range[2]));
            }
            if (!range || (!range[1] && !range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= item.size) {
              res.setHeader('Content-Range', `bytes */${item.size}`);
              throw new HttpError(416, '请求的文件范围无效', 'INVALID_RANGE');
            }
            status = 206;
            headers['Content-Range'] = `bytes ${start}-${end}/${item.size}`;
            headers['Content-Length'] = end - start + 1;
          }
          await fs.access(item.filePath);
          res.writeHead(status, headers);
          if (req.method === 'HEAD' || !item.size) return res.end();
          const stream = createReadStream(item.filePath, { start, end });
          stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy());
          stream.pipe(res);
          return;
        }
        throw new HttpError(404, '接口不存在', 'NOT_FOUND');
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const resource = PUBLIC_FILES.get(url.pathname);
      if (!resource || !['GET', 'HEAD'].includes(req.method)) throw new HttpError(404, '页面不存在', 'NOT_FOUND');
      let data;
      try { data = await fs.readFile(path.join(ROOT, 'public', resource[0])); }
      catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, '页面文件不存在', 'NOT_FOUND'); throw error; }
      res.writeHead(200, { 'Content-Type': resource[1], 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
      if (!(error instanceof HttpError)) console.error('[服务错误]', error.message);
      json(res, error.status || 500, { error: error.status ? error.message : '服务暂时不可用，请稍后重试', ...(error.code && error.status ? { code: error.code } : {}), ...(error.details || {}) });
    }
  }

  const activeHandlers = new Set();
  const server = http.createServer((req, res) => {
    const task = handler(req, res);
    activeHandlers.add(task);
    task.then(() => activeHandlers.delete(task), () => {
      activeHandlers.delete(task);
      if (!res.destroyed) res.destroy();
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      for (const stream of client.streams) if (!stream.destroyed && !stream.writableEnded) stream.write(': heartbeat\n\n');
    }
  }, 15_000);
  heartbeat.unref();
  const sweep = setInterval(async () => {
    const now = Date.now();
    for (const [room, state] of rooms) {
      let removed = false;
      for (const item of state.items.values()) if (Date.parse(item.expiresAt) <= now && !item.locked) { await removeItem(room, item); removed = true; }
      if (removed) broadcast(room, 'snapshot', snapshot(room));
      if (!state.items.size && ![...clients.values()].some((client) => client.room === room)) rooms.delete(room);
    }
    for (const [id, client] of clients) if (!client.online && now - client.lastSeen > retentionMs) { clients.delete(id); tokens.delete(client.token); clearTimeout(client.offlineTimer); }
    for (const [key, rate] of rates) if (rate.until < now) rates.delete(key);
    await cleanOrphans();
  }, config.sweepIntervalMs);
  sweep.unref();
  let cleanupPromise;
  const cleanup = () => {
    clearInterval(heartbeat);
    clearInterval(sweep);
    for (const client of clients.values()) clearTimeout(client.offlineTimer);
    cleanupPromise ||= fs.rm(dataDir, { recursive: true, force: true });
    return cleanupPromise;
  };
  server.on('close', () => {
    if (!closing) Promise.allSettled([...activeHandlers]).then(cleanup).catch((error) => console.error('[清理错误]', error.message));
  });
  let shutdownPromise;
  server.shutdown = () => shutdownPromise ||= (async () => {
    closing = true;
    for (const client of clients.values()) for (const stream of client.streams) stream.end();
    if (server.listening) {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      // An unfinished request must not make Ctrl+C wait for the HTTP request timeout.
      const force = setTimeout(() => server.closeAllConnections(), config.shutdownGraceMs);
      force.unref();
      try { await closed; } finally { clearTimeout(force); }
    }
    // A destroyed upload still needs to roll back and close its file before Windows can delete it.
    await Promise.allSettled([...activeHandlers]);
    await cleanup();
  })();
  server.lanConfig = { ...config, dataDir };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await createLanServer();
    server.on('error', (error) => {
      console.error(error.code === 'EADDRINUSE' ? `端口 ${server.lanConfig.port} 已被占用，请设置其他 PORT。` : `无法启动服务：${error.message}`);
      server.shutdown().finally(() => { process.exitCode = 1; });
    });
    server.listen(server.lanConfig.port, server.lanConfig.host, () => {
      const port = server.address().port;
      console.log(`\n邻传 · 局域网传输服务 v${VERSION}\n`);
      console.log(`本机访问：http://localhost:${port}`);
      for (const address of localAddresses(port)) console.log(`其他设备：${address}`);
      console.log(`\n请让设备连接同一局域网，并允许 Node.js 通过专用网络防火墙。`);
      console.log('请优先使用 Wi-Fi/以太网地址；VPN、虚拟网卡的备用地址可能无法从其他设备访问。');
      console.log(`文件暂存 ${server.lanConfig.retentionHours} 小时；关闭服务会清空本次暂存。按 Ctrl+C 退出。\n`);
      if (process.argv.includes('--open')) {
        const address = server.address().address;
        const host = ['0.0.0.0', '::', '127.0.0.1'].includes(address) ? 'localhost' : address.includes(':') ? `[${address}]` : address;
        openBrowser(`http://${host}:${port}`);
      }
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      server.shutdown().then(() => { process.exitCode = 0; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
      setTimeout(() => process.exit(0), 5000).unref();
    });
  } catch (error) {
    console.error(`无法启动服务：${error.message}`);
    process.exitCode = 1;
  }
}
