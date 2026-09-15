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
log "[2/5] Initializing PostgreSQL database $DB_NAME..."
ssh "$PROD_HOST" "
  set -e
  # 确保角色具备 BYPASSRLS
  sudo -u postgres psql -tAc \"SELECT rolbypassrls FROM pg_roles WHERE rolname='llmwiki'\" | grep -q 't' || {
    echo 'Granting BYPASSRLS to role llmwiki...'
    sudo -u postgres psql -c 'ALTER ROLE llmwiki BYPASSRLS;'
  }
  # 创建新实例专属独立数据库
  sudo -u postgres psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\" | grep -q 1 || {
    echo 'Creating database $DB_NAME...'
    sudo -u postgres psql -c \"CREATE DATABASE $DB_NAME OWNER llmwiki;\"
  }
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
ssh "$PROD_HOST" "
  set -e
  # 从现有 production.env 提取密码与通用配置，覆写专属端口与库号
  if [[ ! -f '$ENV_FILE' ]]; then
    cp /home/ubuntu/.config/llmwiki/production.env '$ENV_FILE'
    
    # 替换数据库 URL
    sed -i 's|/llmwiki?|/$DB_NAME?|g' '$ENV_FILE'
    sed -i 's|/llmwiki$|/$DB_NAME|g' '$ENV_FILE'
    
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
    
    chmod 600 '$ENV_FILE'
    echo 'Created $ENV_FILE with REDIS_DB=$REDIS_DB and PORT=$API_PORT'
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
After=network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=$SYMLINK_DIR/apps/web
Environment=PORT=$WEB_PORT
Environment=NODE_ENV=production
EnvironmentFile=$ENV_FILE
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/ubuntu/.hermes/node/bin/next start --hostname 127.0.0.1 --port $WEB_PORT
Restart=always
RestartSec=5

MemoryMax=1G
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF'

  sudo systemctl daemon-reload
  sudo systemctl enable '$API_SERVICE' '$WEB_SERVICE'
"

# ---- 5. 输出 Nginx 反向代理配置指南 ----
log "[5/5] Provisioning completed successfully!"
echo ""
echo "================================================================================"
echo "【下一步：配置 Nginx 端口反向代理】"
echo "请在服务器 /etc/nginx/sites-available/knowledge.5gsailor.com 中追加如下 server 块："
echo "================================================================================"
cat <<EOF
server {
    listen $PUBLIC_PORT ssl http2;
    listen [::]:$PUBLIC_PORT ssl http2;
    server_name knowledge.5gsailor.com;

    ssl_certificate /etc/letsencrypt/live/knowledge.5gsailor.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/knowledge.5gsailor.com/privkey.pem;

    client_max_body_size 250M;

    # API 反向代理
    location /api/ {
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
    }

    location /open-api/ {
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # 前端 Web 反向代理
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
echo "================================================================================"
echo "配置完成后执行: sudo nginx -t && sudo nginx -s reload"
echo "发布代码执行:   bash scripts/deploy-prod.sh --target=$INST_NAME"
echo "================================================================================"
