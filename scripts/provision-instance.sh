#!/usr/bin/env bash
# ==============================================================================
# GBrainKG 新客户实例一键开辟脚本（SOP Automated Provisioner）
# ==============================================================================
# 用法:
#   bash scripts/provision-instance.sh <实例编号>
# 示例:
#   bash scripts/provision-instance.sh 3
# ==============================================================================

set -euo pipefail

PROD_HOST="${PROD_HOST:-meetings2}"
INST_NUM="${1:-}"

if [[ -z "$INST_NUM" || ! "$INST_NUM" =~ ^[0-9]+$ || "$INST_NUM" -lt 2 ]]; then
  echo "用法: bash scripts/provision-instance.sh <实例编号 (>= 2)>"
  echo "示例: bash scripts/provision-instance.sh 3"
  exit 1
fi

# Redis 默认只提供 16 个逻辑库（0-15），实例号必须留出 inst1 占用的 DB 0。
# 越界会让 BullMQ 在 SELECT 时报 "DB index is out of range" 并静默丢掉任务。
if [[ "$INST_NUM" -gt 16 ]]; then
  echo "ERROR: 实例编号 $INST_NUM 超出 Redis 逻辑库上限（REDIS_DB=$((INST_NUM - 1)) 越界）。"
  echo "       请在 deploy/docker-compose.prod.yml 为 redis 增加 --databases N 后重试，"
  echo "       或改用 Redis Cluster（需同步调整隔离方案）。"
  exit 1
fi

OFFSET=$((INST_NUM - 1))
INST_NAME="inst${INST_NUM}"
API_PORT=$((3000 + 2 * OFFSET))
WEB_PORT=$((3200 + OFFSET))
PUBLIC_PORT=$((20080 + OFFSET))
DB_NAME="llmwiki_inst${INST_NUM}"
REDIS_DB="$OFFSET"
DATA_DIR="/data/llmwiki-inst${INST_NUM}"
CODE_DIR="/data/llmwiki-inst${INST_NUM}/code"
SYMLINK_DIR="/home/ubuntu/gbrainkg-inst${INST_NUM}"
ENV_FILE="/home/ubuntu/.config/llmwiki/production-inst${INST_NUM}.env"
API_SERVICE="llmwiki-api-inst${INST_NUM}"
WEB_SERVICE="llmwiki-web-inst${INST_NUM}"

# ---- 每实例独立密钥（P0 安全加固）----
# 原因：此前 provision 从 inst1 的 production.env 直接 cp，导致 AUTH_SECRET /
# MODEL_CONFIG_KEY / PARSER_AUTH_TOKEN / AUTH_TOKEN / DB_PASS 跨实例共享。任一
# 实例泄露即可伪造其它实例的 JWT 会话、篡改模型配置或直连其它实例数据库。
# 现改为 openssl rand 各自独立生成，禁止从基座/inst1 复制任何凭据。
INST_DB_PASS="$(openssl rand -hex 32)"
INST_APP_DB_PASS="$(openssl rand -hex 32)"
INST_AUTH_SECRET="$(openssl rand -hex 32)"
INST_MODEL_CONFIG_KEY="$(openssl rand -hex 32)"
INST_PARSER_AUTH_TOKEN="$(openssl rand -hex 32)"
INST_AUTH_TOKEN="$(openssl rand -hex 32)"
# 运行时角色：NOBYPASSRLS，RLS 策略实际生效；迁移/GBrain 仍用 llmwiki(BYPASSRLS)。
INST_APP_USER="llmwiki_app_inst${INST_NUM}"
# 每实例迁移/GBrain 角色（BYPASSRLS），DB_PASS 独立，不再共享 llmwiki 口令。
INST_MIGRATE_USER="llmwiki_inst${INST_NUM}"

log() { echo "[provision-instance $(date '+%F %T')] $*"; }

log "================================================================================"
log "准备在生产服务器 [$PROD_HOST] 开辟新实例: $INST_NAME"
log "  - 数据库名: $DB_NAME"
log "  - Redis 独立 DB: $REDIS_DB"
log "  - 后端 API 端口: $API_PORT"
log "  - 前端 Web 端口: $WEB_PORT"
log "  - 公网 HTTPS 端口: $PUBLIC_PORT"
log "  - 存储与代码路径: $DATA_DIR"
log "  - 配置文件路径: $ENV_FILE"
log "================================================================================"

# ---- 1. 检查连通性与前置环境 ----
log "[1/5] Checking remote host and base environment..."
ssh "$PROD_HOST" "
  set -e
  mountpoint -q /data || { echo 'ERROR: /data is not mounted on remote host'; exit 1; }
  [[ -f /home/ubuntu/.config/llmwiki/production.env ]] || { echo 'ERROR: Base production.env not found'; exit 1; }
"

# ---- 2. 创建独立数据库与赋权 ----
# DB_PASS 各实例独立：为本实例创建专属角色，禁止复用 inst1 的 llmwiki 口令。
log "[2/5] Initializing PostgreSQL database $DB_NAME (isolated roles)..."
ssh "$PROD_HOST" "
  set -e
  # 迁移/GBrain 角色保留 BYPASSRLS（GBrain 迁移硬性依赖，见 MULTI_INSTANCE_GUIDE）
  sudo -u postgres psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$INST_MIGRATE_USER'\" | grep -q 1 || {
    echo 'Creating migration role $INST_MIGRATE_USER (BYPASSRLS)...'
    sudo -u postgres psql -c \"CREATE USER $INST_MIGRATE_USER WITH PASSWORD '$INST_DB_PASS' BYPASSRLS;\"
  }
  sudo -u postgres psql -c \"ALTER ROLE $INST_MIGRATE_USER WITH PASSWORD '$INST_DB_PASS' BYPASSRLS;\"
  # 运行时角色 NOBYPASSRLS：RLS 租户隔离在此角色上真正生效
  sudo -u postgres psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$INST_APP_USER'\" | grep -q 1 || {
    echo 'Creating runtime role $INST_APP_USER (NOBYPASSRLS)...'
    sudo -u postgres psql -c \"CREATE USER $INST_APP_USER WITH PASSWORD '$INST_APP_DB_PASS' NOBYPASSRLS;\"
  }
  sudo -u postgres psql -c \"ALTER ROLE $INST_APP_USER WITH PASSWORD '$INST_APP_DB_PASS' NOBYPASSRLS;\"
  # 创建新实例专属独立数据库（owner 用迁移角色，便于 gbrain/prisma migrate）
  sudo -u postgres psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\" | grep -q 1 || {
    echo 'Creating database $DB_NAME...'
    sudo -u postgres psql -c \"CREATE DATABASE $DB_NAME OWNER $INST_MIGRATE_USER;\"
  }
  # 运行时角色授权（表由迁移角色创建，DEFAULT PRIVILEGES 让后续表自动可读写）
  sudo -u postgres psql -c \"GRANT CONNECT,TEMPORARY ON DATABASE $DB_NAME TO $INST_APP_USER;\"
  sudo -u postgres psql -d '$DB_NAME' -c \"GRANT USAGE,CREATE ON SCHEMA public TO $INST_APP_USER;\"
  sudo -u postgres psql -d '$DB_NAME' -c \"GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO $INST_APP_USER;\"
  sudo -u postgres psql -d '$DB_NAME' -c \"GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO $INST_APP_USER;\"
  sudo -u postgres psql -d '$DB_NAME' -c \"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO $INST_APP_USER;\"
  sudo -u postgres psql -d '$DB_NAME' -c \"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO $INST_APP_USER;\"
  # 过滤 HNSW 召回参数必须逐库设置（new instance DB would otherwise fall back
  # to pgvector defaults ef_search=40 / iterative_scan=off => Recall@10 0.21）。
  sudo -u postgres psql -d '$DB_NAME' -c \"ALTER DATABASE $DB_NAME SET hnsw.ef_search = 200;\"
  sudo -u postgres psql -d '$DB_NAME' -c \"ALTER DATABASE $DB_NAME SET hnsw.iterative_scan = 'relaxed_order';\"
  sudo -u postgres psql -d '$DB_NAME' -c \"ALTER DATABASE $DB_NAME SET hnsw.max_scan_tuples = 20000;\"
"

# ---- 3. 创建持久化数据盘目录与软链 ----
log "[3/5] Creating directories on /data..."
ssh "$PROD_HOST" "
  set -e
  sudo mkdir -p '$DATA_DIR/runtime/uploads' '$DATA_DIR/runtime/gbrain-sources' '$CODE_DIR'
  sudo chown -R ubuntu:ubuntu '$DATA_DIR'
  ln -sfn '$CODE_DIR' '$SYMLINK_DIR'
"

# ---- 4. 生成专属配置文件与 Systemd 服务 ----
log "[4/5] Generating isolated environment and systemd service files..."
# 安全：禁止 `cp production.env` 继承 inst1/基座密钥。仅提取非敏感通用配置做模板，
# 所有凭据（AUTH_SECRET / MODEL_CONFIG_KEY / PARSER_AUTH_TOKEN / AUTH_TOKEN / DB_PASS）
# 一律用上方 openssl rand 生成的本实例独立值覆写。
ssh "$PROD_HOST" "
  set -e
  if [[ ! -f '$ENV_FILE' ]]; then
    # 仅复制非敏感基座配置（功能开关/版本号等），显式剔除一切密钥行
    if [[ -f /home/ubuntu/.config/llmwiki/production.env ]]; then
      grep -Ev '^(AUTH_SECRET|MODEL_CONFIG_KEY|PARSER_AUTH_TOKEN|AUTH_TOKEN|DB_PASS|DB_USER|DB_NAME|DATABASE_URL|GBRAIN_DATABASE_URL|DATABASE_URL_APP|REDIS_PASS)=' \
        /home/ubuntu/.config/llmwiki/production.env > '$ENV_FILE' || true
    else
      touch '$ENV_FILE'
    fi

    # 强制写入本实例独立密钥与连接串（不从任何既有 env 复制）
    cat <<SECRETS >> '$ENV_FILE'

# ---- instance-unique credentials (openssl rand, never copied from inst1) ----
DB_USER=$INST_MIGRATE_USER
DB_PASS=$INST_DB_PASS
DB_NAME=$DB_NAME
# 迁移/GBrain 用 BYPASSRLS 角色
DATABASE_URL=postgresql://$INST_MIGRATE_USER:$INST_DB_PASS@127.0.0.1:5432/$DB_NAME?schema=public
GBRAIN_DATABASE_URL=postgresql://$INST_MIGRATE_USER:$INST_DB_PASS@127.0.0.1:5432/$DB_NAME?schema=public
# 运行时用 NOBYPASSRLS 角色（RLS_ENFORCE=1 时租户隔离真正生效）
DB_USER_APP=$INST_APP_USER
DB_PASS_APP=$INST_APP_DB_PASS
DATABASE_URL_APP=postgresql://$INST_APP_USER:$INST_APP_DB_PASS@127.0.0.1:5432/$DB_NAME?schema=public
RLS_ENFORCE=1

AUTH_SECRET=$INST_AUTH_SECRET
MODEL_CONFIG_KEY=$INST_MODEL_CONFIG_KEY
PARSER_AUTH_TOKEN=$INST_PARSER_AUTH_TOKEN
AUTH_TOKEN=$INST_AUTH_TOKEN
SECRETS

    # 强制设置专属 REDIS_DB（杜绝队列冲突）
    grep -q '^REDIS_DB=' '$ENV_FILE' && sed -i 's/^REDIS_DB=.*/REDIS_DB=$REDIS_DB/' '$ENV_FILE' || echo 'REDIS_DB=$REDIS_DB' >> '$ENV_FILE'
    
    # 设置专属端口
    sed -i 's/^PORT=.*/PORT=$API_PORT/' '$ENV_FILE'
    sed -i 's/^HTTP_PORT=.*/HTTP_PORT=$PUBLIC_PORT/' '$ENV_FILE'
    sed -i 's/^WEB_PORT=.*/WEB_PORT=$WEB_PORT/' '$ENV_FILE'
    sed -i 's|^WEB_ORIGIN=.*|WEB_ORIGIN=https://knowledge.5gsailor.com:$PUBLIC_PORT|' '$ENV_FILE'
    
    # 设置存储路径
    sed -i 's|^BRAIN_REPO_BASE_PATH=.*|BRAIN_REPO_BASE_PATH=$DATA_DIR/runtime|' '$ENV_FILE'
    sed -i 's|^UPLOAD_ROOT=.*|UPLOAD_ROOT=$DATA_DIR/runtime/uploads|' '$ENV_FILE'
    
    # 保障单分块 Prompt 放行上限（防止大表格与密集语义被硬截断）
    grep -q '^CHAT_CHUNK_MAX_CHARS=' '$ENV_FILE' && sed -i 's/^CHAT_CHUNK_MAX_CHARS=.*/CHAT_CHUNK_MAX_CHARS=6000/' '$ENV_FILE' || echo 'CHAT_CHUNK_MAX_CHARS=6000' >> '$ENV_FILE'
    
    chmod 600 '$ENV_FILE'
    echo 'Created $ENV_FILE with REDIS_DB=$REDIS_DB and PORT=$API_PORT (unique credentials)'
  else
    echo '$ENV_FILE already exists, keeping existing file.'
  fi

  # 写入 API Systemd 服务
  sudo bash -c 'cat <<EOF > /etc/systemd/system/$API_SERVICE.service
[Unit]
Description=LLMWiki API ($INST_NAME)
After=network.target postgresql@16-main.service redis-server.service llmwiki-parser.service
Wants=llmwiki-parser.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=$SYMLINK_DIR/apps/api
EnvironmentFile=$ENV_FILE
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/node $SYMLINK_DIR/apps/api/dist/main.js
Restart=always
RestartSec=5
TimeoutStopSec=15

MemoryMax=2G
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF'

  # 写入 Web Systemd 服务
  sudo bash -c 'cat <<EOF > /etc/systemd/system/$WEB_SERVICE.service
[Unit]
Description=LLMWiki Web ($INST_NAME)
After=network.target $API_SERVICE.service
Wants=$API_SERVICE.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=$SYMLINK_DIR/apps/web
Environment=PORT=$WEB_PORT
Environment=HOSTNAME=127.0.0.1
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
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
  sudo systemctl enable '$API_SERVICE' '$WEB_SERVICE'
"

# ---- 5. 自动配置 Nginx 反向代理并热重载 ----
log "[5/5] Configuring Nginx reverse proxy for $INST_NAME (port $PUBLIC_PORT)..."
ssh "$PROD_HOST" "sudo tee /etc/nginx/sites-available/llmwiki-$INST_NAME >/dev/null" <<EOF
# Host Nginx vhost for LLMWiki $INST_NAME
limit_req_zone \$binary_remote_addr zone=llmwiki_login_$INST_NAME:10m rate=3r/s;
limit_req_zone \$binary_remote_addr zone=llmwiki_api_$INST_NAME:10m rate=20r/s;

server {
    listen $PUBLIC_PORT ssl;
    listen [::]:$PUBLIC_PORT ssl;
    server_name knowledge.5gsailor.com;

    ssl_certificate /etc/letsencrypt/live/knowledge.5gsailor.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/knowledge.5gsailor.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL_LLMWIKI_${INST_NAME^^}:10m;
    ssl_session_tickets off;

    error_page 497 301 =307 https://\$host:$PUBLIC_PORT\$request_uri;

    client_max_body_size 200m;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location = /health {
        proxy_pass http://127.0.0.1:$API_PORT/health;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location = /api/v1/auth/login {
        limit_req zone=llmwiki_login_$INST_NAME burst=5 nodelay;
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /api/ {
        limit_req zone=llmwiki_api_$INST_NAME burst=40 nodelay;
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /mcp {
        limit_req zone=llmwiki_api_$INST_NAME burst=40 nodelay;
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /mcp/ {
        limit_req zone=llmwiki_api_$INST_NAME burst=40 nodelay;
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /open-api/ {
        limit_req zone=llmwiki_api_$INST_NAME burst=40 nodelay;
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:$WEB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ssh "$PROD_HOST" "
  sudo ln -sfn '/etc/nginx/sites-available/llmwiki-$INST_NAME' '/etc/nginx/sites-enabled/llmwiki-$INST_NAME'
  sudo nginx -t && sudo systemctl reload nginx
"

log "================================================================================"
log "🎉 实例 $INST_NAME 开辟与网关配置完毕！"
log "  - 后端 API 端口: $API_PORT"
log "  - 前端 Web 端口: $WEB_PORT"
log "  - 公网 HTTPS 入口: https://knowledge.5gsailor.com:$PUBLIC_PORT"
log "  - 数据库: $DB_NAME"
log "  - Redis DB: $REDIS_DB"
log "================================================================================"
echo "下一步：执行代码发布与双引擎迁移："
echo "  bash scripts/deploy-prod.sh --target=$INST_NAME"
echo "================================================================================"
