#!/usr/bin/env bash
# Read-only pre-deploy summary for one deployed instance: services, ports,
# revision and running build identity. Never mutates anything.
set -euo pipefail
HOST="${1:?host required}"; shift || true
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" bash -s <<'REMOTE'
set -uo pipefail
echo "host=$(hostname) now=$(date -Is)"
echo "--- services ---"
systemctl --user list-units --type=service --no-pager --plain 2>/dev/null \
  | grep -E 'llmwiki|llmwiki-api|llmwiki-web|llmwiki-parser' || true
echo "--- ports ---"
ss -ltn 2>/dev/null | grep -E ':(300[0-9]|320[0-9]|8100|50003)\b' || true
echo "--- repo ---"
for d in /home/ubuntu/gbrainkg /data/llmwiki-inst2/code /data/llmwiki-inst3/code; do
  [ -d "$d" ] || continue
  echo "$d sha=$(git -C "$d" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  [ -f "$d/apps/api/dist/main.js" ] && echo "$d dist=$(sha256sum "$d/apps/api/dist/main.js" | cut -c1-16)"
done
echo "--- ready ---"
for p in 3000 3002 3202; do
  code=$(curl -s -o /tmp/ready.$p -w '%{http_code}' -m 3 "http://127.0.0.1:$p/ready" 2>/dev/null || echo 000)
  echo "port=$p http=$code fp=$(python3 -c "import json,sys
try: print(json.load(open('/tmp/ready.$p')).get('apiReleaseFingerprint','')[:16])
except Exception: print('')" 2>/dev/null)"
done
REMOTE