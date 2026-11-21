#!/usr/bin/env sh
set -eu
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 20 or newer is required on this server computer.' >&2
  exit 1
fi
exec node server.js --open
