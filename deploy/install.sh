#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="$HOME/.local/bin:$HOME/.hermes/node/bin:$HOME/.bun/bin:$PATH"

# Check host prerequisites
for command_name in node pnpm python3 openssl curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Error: $command_name is required on host. Please install it first." >&2
    exit 1
  fi
done

echo "=================================================="
echo "         LLMWiki Host-Native Installation         "
echo "=================================================="

SECRET_DIR="$ROOT_DIR/.secrets"
SECRET_FILE="$SECRET_DIR/admin_initial_password"
API_ENV="$ROOT_DIR/apps/api/.env"
WEB_ENV="$ROOT_DIR/apps/web/.env.production"

# 1. Environment configuration
echo "[1/6] Preparing environment configuration..."
mkdir -p "$ROOT_DIR/.local/share/llmwiki/uploads" "$ROOT_DIR/.local/share/llmwiki/brain_repos"
mkdir -p "$HOME/.local/share/llmwiki/uploads" "$HOME/.local/share/llmwiki/brain_repos"

if [[ ! -f "$API_ENV" ]]; then
  if [[ -f "$ROOT_DIR/apps/api/.env.example" ]]; then
    cp "$ROOT_DIR/apps/api/.env.example" "$API_ENV"
  fi
  random_secret() { openssl rand -hex 32; }
  sed -i \
    -e "s#replace-with-a-long-random-secret#$(random_secret)#" \
    -e "s#replace-with-an-independent-long-random-secret#$(random_secret)#" \
    "$API_ENV" 2>/dev/null || true
  echo "Created $API_ENV with generated secrets."
fi

if [[ ! -f "$WEB_ENV" ]]; then
  echo "NEXT_PUBLIC_API_URL=http://localhost:3202" > "$WEB_ENV"
  echo "Created $WEB_ENV."
fi

# 2. Admin initial password configuration
mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"
if [[ ! -s "$SECRET_FILE" ]]; then
  if [[ -n "${ADMIN_INITIAL_PASSWORD:-}" ]]; then
    printf '%s\n' "$ADMIN_INITIAL_PASSWORD" > "$SECRET_FILE"
    unset ADMIN_INITIAL_PASSWORD
  elif [[ -t 0 ]]; then
    while true; do
      read -r -s -p "Set initial password for admin (minimum 6 characters): " admin_password
      echo
      read -r -s -p "Confirm initial password: " admin_password_confirm
      echo
      [[ "$admin_password" == "$admin_password_confirm" && ${#admin_password} -ge 6 ]] && break
      echo "Passwords must match and contain at least 6 characters."
    done
    printf '%s\n' "$admin_password" > "$SECRET_FILE"
    unset admin_password admin_password_confirm
  else
    echo "ADMIN_INITIAL_PASSWORD is not set; skipping initial admin password file creation."
  fi
  [[ -f "$SECRET_FILE" ]] && chmod 600 "$SECRET_FILE"
fi

# 3. Monorepo dependencies
echo "[2/6] Installing Node dependencies..."
pnpm install --frozen-lockfile=false

# 4. Database sync
echo "[3/6] Synchronizing database schema..."
pnpm --filter database exec prisma generate
pnpm --filter database exec prisma migrate deploy --schema=prisma/schema.prisma

# 5. Build services
echo "[4/6] Building API and Web frontend..."
pnpm --filter api build
pnpm --filter web build

# Bootstrap admin if initial password file exists
if [[ -s "$SECRET_FILE" ]]; then
  echo "Bootstrapping initial admin user..."
  ADMIN_INITIAL_PASSWORD_FILE="$SECRET_FILE" node "$ROOT_DIR/apps/api/dist/bootstrap/production-bootstrap.js" || true
fi

# 6. Install & Enable Systemd User Units
echo "[5/6] Configuring systemd user services..."
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_USER_DIR"

ln -sf "$ROOT_DIR/deploy/systemd/llmwiki-parser.service" "$SYSTEMD_USER_DIR/llmwiki-parser.service"
ln -sf "$ROOT_DIR/deploy/systemd/llmwiki-api.service" "$SYSTEMD_USER_DIR/llmwiki-api.service"
ln -sf "$ROOT_DIR/deploy/systemd/llmwiki-web.service" "$SYSTEMD_USER_DIR/llmwiki-web.service"

systemctl --user daemon-reload
systemctl --user enable --now llmwiki-parser.service llmwiki-api.service llmwiki-web.service
systemctl --user restart llmwiki-parser.service llmwiki-api.service llmwiki-web.service
loginctl enable-linger "$USER" 2>/dev/null || true

# 7. Health check
echo "[6/6] Verifying service health..."
sleep 2
"$ROOT_DIR/deploy/healthcheck.sh"

echo
echo "Installation complete. Systemd services are active and managed via systemctl --user."
