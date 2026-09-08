#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="$HOME/.local/bin:$HOME/.hermes/node/bin:$HOME/.bun/bin:$PATH"
echo "=================================================="
echo "            LLMWiki Production Upgrade            "
echo "=================================================="

# 1. Check prerequisites
for cmd in node pnpm python3 curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd is required on host." >&2
    exit 1
  fi
done

# 2. Install Node dependencies
echo "[1/5] Installing package dependencies..."
pnpm install --frozen-lockfile=false

# 3. Database migrations / sync
echo "[2/5] Synchronizing database schema..."
pnpm --filter database exec prisma generate
pnpm --filter database exec prisma migrate deploy --schema=prisma/schema.prisma

# 4. Build API
echo "[3/5] Building API backend..."
pnpm --filter api build

# 5. Build Web
echo "[4/5] Building Web frontend..."
pnpm --filter web build

# 6. Restart Systemd User Services
echo "[5/5] Reloading and restarting systemd user services..."
systemctl --user daemon-reload
systemctl --user restart llmwiki-parser.service llmwiki-api.service llmwiki-web.service

# 7. Healthcheck
echo "Verifying service health..."
sleep 2
deploy/healthcheck.sh

echo "Upgrade complete. Native services are up to date."
