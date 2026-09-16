#!/usr/bin/env bash
# ==============================================================================
# GBrainKG 新服务器实例1初始化脚手架（New Server Bootstrap Script）
# ==============================================================================
# 用法:
#   PROD_HOST="<新服务器IP或SSH别名>" bash scripts/bootstrap-new-server.sh
#
# 环境变量（可选自定义）:
#   PROD_HOST               目标新服务器 SSH Host（必填，默认 meetings2）
#   REMOTE_USER             目标服务器登录用户（默认: ubuntu）
#   DOMAIN                  生产公网域名（默认: knowledge.5gsailor.com）
#   PUBLIC_PORT             公网访问端口（默认: 20080）
#   ADMIN_INITIAL_PASSWORD  初始管理员密码（默认: 123456）
#
# 本脚本将在全新的 Linux 宿主机上从零自动完成：
#   1. 系统底层工具与开发包安装（antiword, libpq, python3-venv 等）
#   2. Node.js 20 LTS + pnpm + Bun 运行时安装与全局软链
#   3. PostgreSQL 16 + pgvector 扩展安装、角色赋权(BYPASSRLS)与数据库初始化
#   4. Redis 7 缓存与消息队列安装及密码安全配置
#   5. 大容量数据盘(/data)与应用代码/运行时目录规范建立
#   6. GBrain 知识底座与 CLI 全局链接部署
#   7. Python Parser-Worker 微服务专属独立虚拟环境(.venv)与依赖部署
#   8. 实例1生产环境专属配置文件 (~/.config/llmwiki/production.env) 安全生成
#   9. Systemd 全局服务守护单元(llmwiki-parser, llmwiki-api, llmwiki-web)注册
#   10. Nginx 边缘网关反向代理配置与热重载
# ==============================================================================

set -euo pipefail

PROD_HOST="${PROD_HOST:-}"
REMOTE_USER="${REMOTE_USER:-ubuntu}"
DOMAIN="${DOMAIN:-knowledge.5gsailor.com}"
PUBLIC_PORT="${PUBLIC_PORT:-20080}"
ADMIN_INITIAL_PASSWORD="${ADMIN_INITIAL_PASSWORD:-123456}"
LOCAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$PROD_HOST" ]]; then
  echo "================================================================================"
  echo "错误: 未指定目标服务器 PROD_HOST！"
  echo "用法: PROD_HOST=\"<新服务器IP或SSH别名>\" bash scripts/bootstrap-new-server.sh"
  echo "示例: PROD_HOST=\"119.45.22.137\" bash scripts/bootstrap-new-server.sh"
  echo "================================================================================"
  exit 1
fi

log() { echo "[bootstrap-new-server $(date '+%F %T')] $*"; }

log "================================================================================"
log "开始在新服务器 [$PROD_HOST] 上自动化初始化 GBrainKG 基础底座与实例 1"
log "  - 目标主机: $PROD_HOST"
log "  - 运维用户: $REMOTE_USER"
log "  - 绑定域名: $DOMAIN"
log "  - 实例1网关端口: $PUBLIC_PORT"
log "================================================================================"

# ---- 1. 连通性与权限检查 ----
log "[1/9] Checking SSH connectivity and sudo privileges..."
ssh "$PROD_HOST" "
  set -e
  echo 'SSH connection successful.'
  sudo -n true 2>/dev/null || { echo 'ERROR: User $REMOTE_USER must have passwordless sudo or valid sudo permissions!'; exit 1; }
  
  # 校验 /data 挂载或创建
  if mountpoint -q /data; then
    echo 'Data disk (/data) is already mounted as an independent volume.'
  else
    echo 'Notice: /data is not a dedicated mountpoint, checking directory existence...'
    sudo mkdir -p /data
    echo 'Created /data on root volume.'
  fi
  sudo chown -R $REMOTE_USER:$REMOTE_USER /data
"

# ---- 2. 操作系统基础依赖安装 ----
log "[2/9] Installing base OS packages & utilities..."
ssh "$PROD_HOST" "
  set -e
  sudo apt-get update -y
  sudo apt-get install -y --no-install-recommends \
    curl wget git rsync jq build-essential antiword \
    libpq-dev python3 python3-pip python3-venv openssl \
    ca-certificates gnupg lsb-release
"

# ---- 3. 安装 Node.js 20 LTS, pnpm 与 Bun 运行时 ----
log "[3/9] Setting up Node.js 20, pnpm, and Bun runtime..."
ssh "$PROD_HOST" "
  set -e
  # Node.js 20 LTS
  if ! command -v node >/dev/null 2>&1 || [[ \$(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
    echo 'Installing Node.js 20 LTS via NodeSource...'
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  echo \"Node.js version: \$(node -v)\"

  # pnpm
  if ! command -v pnpm >/dev/null 2>&1; then
    echo 'Installing pnpm globally...'
    sudo npm install -g pnpm
  fi
  echo \"pnpm version: \$(pnpm -v)\"

  # Bun runtime
  if ! command -v bun >/dev/null 2>&1 && [[ ! -f /usr/local/bin/bun ]]; then
    echo 'Installing Bun runtime...'
    curl -fsSL https://bun.sh/install | bash
    sudo ln -sfn \$HOME/.bun/bin/bun /usr/local/bin/bun
  fi
  sudo ln -sfn \$HOME/.bun/bin/bun /usr/local/bin/bun 2>/dev/null || true
  echo \"Bun version: \$(/usr/local/bin/bun --version)\"
"

# ---- 4. 安装与配置 PostgreSQL 16 + pgvector ----
DB_PASS="$(openssl rand -hex 16)"
log "[4/9] Setting up PostgreSQL 16 with pgvector extension..."
ssh "$PROD_HOST" "
  set -e
  # 安装 PostgreSQL 16 与 pgvector
  if ! dpkg -l | grep -q postgresql-16-pgvector; then
    echo 'Installing postgresql-16 and postgresql-16-pgvector...'
    sudo apt-get install -y postgresql-16 postgresql-16-pgvector || {
      # 若系统源无 pgvector，添加官方 PostgreSQL apt 源
      sudo sh -c 'echo \"deb http://apt.postgresql.org/pub/repos/apt \$(lsb_release -cs)-pgdg main\" > /etc/apt/sources.list.d/pgdg.list'
      curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
      sudo apt-get update -y
      sudo apt-get install -y postgresql-16 postgresql-16-pgvector
    }
  fi

  sudo systemctl enable postgresql
  sudo systemctl start postgresql

  # 创建用户与赋权（核心铁律：BYPASSRLS）
  sudo -u postgres psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='llmwiki'\" | grep -q 1 || {
    echo 'Creating PostgreSQL role llmwiki...'
    sudo -u postgres psql -c \"CREATE USER llmwiki WITH PASSWORD '$DB_PASS';\"
  }
  sudo -u postgres psql -c \"ALTER ROLE llmwiki WITH PASSWORD '$DB_PASS' BYPASSRLS;\"

  # 创建实例1专属数据库
  sudo -u postgres psql -tAc \"SELECT 1 FROM pg_database WHERE datname='llmwiki'\" | grep -q 1 || {
    echo 'Creating database llmwiki...'
    sudo -u postgres psql -c \"CREATE DATABASE llmwiki OWNER llmwiki;\"
  }

  # 安装扩展
  sudo -u postgres psql -d llmwiki -c \"CREATE EXTENSION IF NOT EXISTS vector;\"
  sudo -u postgres psql -d llmwiki -c \"CREATE EXTENSION IF NOT EXISTS pg_trgm;\"
  sudo -u postgres psql -d llmwiki -c \"CREATE EXTENSION IF NOT EXISTS pgcrypto;\"
  echo 'PostgreSQL 16 & pgvector initialized successfully.'
"

# ---- 5. 安装与配置 Redis 7 ----
REDIS_PASS="$(openssl rand -hex 16)"
log "[5/9] Setting up Redis 7 with password security..."
ssh "$PROD_HOST" "
  set -e
  if ! command -v redis-server >/dev/null 2>&1; then
    sudo apt-get install -y redis-server
  fi

  # 配置 Redis 密码并允许本地访问
  sudo sed -i 's/^bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
  if grep -q '^requirepass ' /etc/redis/redis.conf; then
    sudo sed -i 's/^requirepass .*/requirepass $REDIS_PASS/' /etc/redis/redis.conf
  else
    echo 'requirepass $REDIS_PASS' | sudo tee -a /etc/redis/redis.conf >/dev/null
  fi

  sudo systemctl enable redis-server
  sudo systemctl restart redis-server
  echo 'Redis 7 configured and active.'
"

# ---- 6. 规划数据盘目录与同步 GBrain 知识底座 ----
log "[6/9] Establishing /data layout and deploying GBrain engine..."
ssh "$PROD_HOST" "
  set -e
  sudo mkdir -p /data/llmwiki/runtime/uploads /data/llmwiki/runtime/gbrain-sources /data/llmwiki/gbrain-data
  sudo mkdir -p /home/$REMOTE_USER/.config/llmwiki /home/$REMOTE_USER/.local/bin /home/$REMOTE_USER/.local/share
  mkdir -p /home/$REMOTE_USER/gbrainkg
  sudo chown -R $REMOTE_USER:$REMOTE_USER /data/llmwiki /home/$REMOTE_USER/gbrainkg /home/$REMOTE_USER/.config/llmwiki
  ln -sfn /data/llmwiki/runtime /home/$REMOTE_USER/gbrainkg/runtime
"

# 同步或拉取 GBrain 引擎
if [[ -d "$HOME/.local/share/gbrain" ]]; then
  log "Syncing local gbrain engine to remote host..."
  rsync -az --delete \
    --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='test' \
    "$HOME/.local/share/gbrain/" "$PROD_HOST:/data/llmwiki/gbrain-data/"
else
  log "Cloning gbrain repository on remote host..."
  ssh "$PROD_HOST" "
    set -e
    if [[ ! -d /data/llmwiki/gbrain-data/src ]]; then
      git clone https://github.com/garrytan/gbrain.git /data/llmwiki/gbrain-data
    fi
  "
fi

ssh "$PROD_HOST" "
  set -e
  cd /data/llmwiki/gbrain-data
  /usr/local/bin/bun install
  chmod +x /data/llmwiki/gbrain-data/src/cli.ts
  sudo ln -sfn /data/llmwiki/gbrain-data/src/cli.ts /usr/local/bin/gbrain
  ln -sfn /data/llmwiki/gbrain-data /home/$REMOTE_USER/.local/share/gbrain
  ln -sfn /usr/local/bin/gbrain /home/$REMOTE_USER/.local/bin/gbrain
  echo \"GBrain CLI version: \$(gbrain --version)\"
"

# ---- 7. 部署 Python 解析服务环境 (Parser-Worker .venv) ----
log "[7/9] Setting up Python virtualenv (.venv) for Parser-Worker..."
ssh "$PROD_HOST" "
  set -e
  cd /home/$REMOTE_USER/gbrainkg
  if [[ ! -d .venv ]]; then
    python3 -m venv .venv
  fi
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install \
    'fastapi>=0.111.0' 'uvicorn>=0.30.0' 'pydantic>=2.7.0' 'python-multipart>=0.0.9' \
    'httpx>=0.28.0' 'pypdf>=5.0.0' 'python-docx>=1.1.0' 'python-pptx>=1.0.0' \
    'openpyxl>=3.1.0' 'xlrd>=2.0.1' 'minio>=7.2.7'
  echo 'Parser-worker virtualenv installed successfully.'
"

# ---- 8. 生成生产配置文件 production.env 与 Systemd 服务注册 ----
AUTH_SECRET="$(openssl rand -hex 32)"
MODEL_CONFIG_KEY="$(openssl rand -hex 32)"
PARSER_AUTH_TOKEN="$(openssl rand -hex 32)"

log "[8/9] Generating ~/.config/llmwiki/production.env and registering systemd services..."
ssh "$PROD_HOST" "
  set -e
  ENV_FILE=\"/home/$REMOTE_USER/.config/llmwiki/production.env\"
  if [[ ! -f \"\$ENV_FILE\" ]]; then
    cat <<EOF > \"\$ENV_FILE\"
# GBrainKG Instance 1 Production Environment
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
WEB_PORT=3200
HTTP_PORT=$PUBLIC_PORT

DB_USER=llmwiki
DB_PASS=$DB_PASS
DB_NAME=llmwiki
DATABASE_URL=postgresql://llmwiki:$DB_PASS@127.0.0.1:5432/llmwiki?schema=public
GBRAIN_DATABASE_URL=postgresql://llmwiki:$DB_PASS@127.0.0.1:5432/llmwiki?schema=public

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASS=$REDIS_PASS
REDIS_DB=0

AUTH_SECRET=$AUTH_SECRET
MODEL_CONFIG_KEY=$MODEL_CONFIG_KEY
PARSER_AUTH_TOKEN=$PARSER_AUTH_TOKEN
PARSER_WORKER_URL=http://127.0.0.1:8100
AUTH_TOKEN=$PARSER_AUTH_TOKEN

WEB_ORIGIN=https://$DOMAIN:$PUBLIC_PORT
CORS_ORIGINS=https://$DOMAIN:$PUBLIC_PORT

BRAIN_REPO_BASE_PATH=/home/$REMOTE_USER/gbrainkg/runtime
UPLOAD_ROOT=/data/llmwiki/runtime/uploads
GBRAIN_HOME=/home/$REMOTE_USER/.config/gbrain
GBRAIN_BIN=/usr/local/bin/gbrain

GBRAIN_VERSION=0.47.6.0
GBRAIN_MAINTENANCE_ENABLED=1
GBRAIN_MAINTENANCE_TZ=Asia/Shanghai
GBRAIN_MAINTENANCE_CRON=\"0 2 * * *\"
GBRAIN_SCOPE_SYNTHESIZE_ENABLED=1
GBRAIN_GRAPH_EXTRACT_ENABLED=1
ENABLE_GRAPHRAG_CONTEXT=1
GBRAIN_POOL_SIZE=2
ACCESS_RECONCILE_INTERVAL_MS=900000
INGESTION_CONCURRENCY=2

PDF_PARSE_MODE=hybrid
LOCAL_DOCLING_ENABLED=0
OCR_PROVIDER=none
DOCLING_TIMEOUT_SECONDS=240

# 单分块 Prompt 字数放行上限（默认 6000，保障大表格与密集行语义完整送入大模型）
CHAT_CHUNK_MAX_CHARS=6000

ADMIN_EMAIL=admin@local.invalid
EOF
    chmod 600 \"\$ENV_FILE\"
    echo \"Generated \$ENV_FILE with REDIS_DB=0 and strict security credentials.\"
  else
    echo \"\$ENV_FILE already exists, keeping existing credentials.\"
  fi

  # 写入 llmwiki-parser.service
  sudo bash -c 'cat <<EOF > /etc/systemd/system/llmwiki-parser.service
[Unit]
Description=LLMWiki Parser Worker
After=network.target

[Service]
Type=simple
User=$REMOTE_USER
Group=$REMOTE_USER
WorkingDirectory=/home/$REMOTE_USER/gbrainkg/apps/parser-worker
EnvironmentFile=/home/$REMOTE_USER/.config/llmwiki/production.env
ExecStart=/home/$REMOTE_USER/gbrainkg/.venv/bin/python -m uvicorn src.main:app --host 127.0.0.1 --port 8100
Restart=always
RestartSec=5
TimeoutStopSec=15

MemoryMax=4G
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF'

  # 写入 llmwiki-api.service
  sudo bash -c 'cat <<EOF > /etc/systemd/system/llmwiki-api.service
[Unit]
Description=LLMWiki API (inst1)
After=network.target postgresql.service redis-server.service llmwiki-parser.service
Wants=llmwiki-parser.service

[Service]
Type=simple
User=$REMOTE_USER
Group=$REMOTE_USER
WorkingDirectory=/home/$REMOTE_USER/gbrainkg/apps/api
EnvironmentFile=/home/$REMOTE_USER/.config/llmwiki/production.env
Environment=PATH=/home/$REMOTE_USER/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/node /home/$REMOTE_USER/gbrainkg/apps/api/dist/main.js
Restart=always
RestartSec=5
TimeoutStopSec=15

MemoryMax=2G
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF'

  # 写入 llmwiki-web.service
  sudo bash -c 'cat <<EOF > /etc/systemd/system/llmwiki-web.service
[Unit]
Description=LLMWiki Web (inst1)
After=network.target llmwiki-api.service
Wants=llmwiki-api.service

[Service]
Type=simple
User=$REMOTE_USER
Group=$REMOTE_USER
WorkingDirectory=/home/$REMOTE_USER/gbrainkg/apps/web
Environment=PORT=3200
Environment=HOSTNAME=127.0.0.1
Environment=PATH=/home/$REMOTE_USER/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/npm run start -- --hostname 127.0.0.1
Restart=always
RestartSec=5
TimeoutStopSec=15

MemoryMax=1G
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF'

  sudo systemctl daemon-reload
  sudo systemctl enable llmwiki-parser.service llmwiki-api.service llmwiki-web.service
  sudo systemctl restart llmwiki-parser.service || true
"

# ---- 9. 配置 Nginx 边缘网关 ----
log "[9/9] Configuring Nginx reverse proxy..."
ssh "$PROD_HOST" "
  set -e
  if ! command -v nginx >/dev/null 2>&1; then
    sudo apt-get install -y nginx certbot python3-certbot-nginx
  fi

  # 判断是否已有证书
  SSL_CERT=\"/etc/letsencrypt/live/$DOMAIN/fullchain.pem\"
  SSL_KEY=\"/etc/letsencrypt/live/$DOMAIN/privkey.pem\"

  if [[ -f \"\$SSL_CERT\" && -f \"\$SSL_KEY\" ]]; then
    echo 'Found existing SSL certificates. Configuring HTTPS gateway...'
    sudo bash -c 'cat <<EOF > /etc/nginx/sites-available/llmwiki
limit_req_zone \$binary_remote_addr zone=llmwiki_login:10m rate=3r/s;
limit_req_zone \$binary_remote_addr zone=llmwiki_api:10m rate=20r/s;

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location / {
        return 301 https://\$host:$PUBLIC_PORT\\\$request_uri;
    }
}

server {
    listen $PUBLIC_PORT ssl http2;
    listen [::]:$PUBLIC_PORT ssl http2;
    server_name $DOMAIN;

    ssl_certificate '\$SSL_CERT';
    ssl_certificate_key '\$SSL_KEY';
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 250M;

    location = /health {
        proxy_pass http://127.0.0.1:3000/health;
        proxy_http_version 1.1;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }

    location = /api/v1/auth/login {
        limit_req zone=llmwiki_login burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }

    location /api/ {
        limit_req zone=llmwiki_api burst=40 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }

    location /open-api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\\$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }
}
EOF'
  else
    echo 'No existing SSL certificates found. Configuring HTTP gateway on port $PUBLIC_PORT...'
    sudo bash -c 'cat <<EOF > /etc/nginx/sites-available/llmwiki
limit_req_zone \$binary_remote_addr zone=llmwiki_login:10m rate=3r/s;
limit_req_zone \$binary_remote_addr zone=llmwiki_api:10m rate=20r/s;

server {
    listen $PUBLIC_PORT;
    listen [::]:$PUBLIC_PORT;
    server_name _;

    client_max_body_size 250M;

    location = /health {
        proxy_pass http://127.0.0.1:3000/health;
        proxy_http_version 1.1;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }

    location = /api/v1/auth/login {
        limit_req zone=llmwiki_login burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }

    location /api/ {
        limit_req zone=llmwiki_api burst=40 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }

    location /open-api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\\$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
    }
}
EOF'
  fi

  sudo ln -sfn /etc/nginx/sites-available/llmwiki /etc/nginx/sites-enabled/llmwiki
  sudo nginx -t && sudo systemctl reload nginx
"

log "================================================================================"
log "🎉 恭喜！新服务器 [$PROD_HOST] 基础环境与实例 1 脚手架初始化完毕！"
log "================================================================================"
echo ""
echo "下一步：立即执行一键全量构建与部署（在本地开发机执行）："
echo "  PROD_HOST=\"$PROD_HOST\" bash scripts/deploy-prod.sh --target=inst1"
echo ""
echo "部署完成后访问入口："
echo "  - Web 控制台: https://$DOMAIN:$PUBLIC_PORT (或 http://<服务器IP>:$PUBLIC_PORT)"
echo "  - 默认管理员: admin"
echo "  - 初始密码:   $ADMIN_INITIAL_PASSWORD"
echo "================================================================================"
