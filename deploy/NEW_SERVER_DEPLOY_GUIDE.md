# GBrainKG 新服务器从零部署全流程操作手册 (SOP)
## —— 实例 1 (Instance 1) 极简资源节省型部署指南

本文档提供将 **GBrainKG 实例 1（主生产系统）** 从零发布并部署至**全新 Linux 宿主机服务器**（如全新购买或初始化的 Ubuntu 22.04 / 24.04 LTS 服务器）的标准操作规程。

---

## 目录
1. [服务器前置要求与规格建议](#1-服务器前置要求与规格建议)
2. [方式一：一键全自动脚手架部署（推荐，5分钟就绪）](#2-方式一一键全自动脚手架部署推荐5分钟就绪)
3. [方式二：逐行手动部署 SOP（深度定制与运维审计）](#3-方式二逐行手动部署-sop深度定制与运维审计)
   - [第一步：基础依赖与运行时环境](#第一步基础依赖与运行时环境)
   - [第二步：核心中间件安装（PostgreSQL 16 + Redis 7）](#第二步核心中间件安装postgresql-16--redis-7)
   - [第三步：存储目录规划与 GBrain 知识底座部署](#第三步存储目录规划与-gbrain-知识底座部署)
   - [第四步：Python 文档解析微服务 (.venv) 部署](#第四步python-文档解析微服务-venv-部署)
   - [第五步：生产环境配置 (production.env) 生成](#第五步生产环境配置-productionenv-生成)
   - [第六步：Systemd 系统守护进程注册](#第六步systemd-系统守护进程注册)
   - [第七步：Nginx 边缘网关与 SSL 证书配置](#第七步nginx-边缘网关与-ssl-证书配置)
   - [第八步：代码全量构建、双引擎迁移与拉起](#第八步代码全量构建双引擎迁移与拉起)
4. [核心防线检查清单（避坑铁律）](#4-核心防线检查清单避坑铁律)
5. [系统冒烟巡检与验收测试](#5-系统冒烟巡检与验收测试)
6. [后续扩充实例 2、实例 3 指南](#6-后续扩充实例-2实例-3-指南)

---

## 1. 服务器前置要求与规格建议

| 维度 | 最低配置 | 推荐配置（支撑 10+ 客户实例） |
| :--- | :--- | :--- |
| **操作系统** | Ubuntu 22.04 LTS (x86_64) | Ubuntu 24.04 LTS (x86_64) |
| **计算资源** | 4 核 CPU / 8GB 内存 | 8 核 CPU / 16GB ~ 32GB 内存 |
| **存储磁盘** | 系统盘 50GB + 数据盘 100GB (挂载在 `/data`) | 高速 NVMe 数据盘 500GB+ (挂载在 `/data`) |
| **网络端口** | 开放入站：`22` (SSH), `80` (HTTP), `20080` (HTTPS) | 云控制台安全组开放相应端口 |
| **运维账号** | 具备 sudo 权限的账号（推荐 `ubuntu`） | 配置免密 SSH 登录与免密 sudo |

> [!IMPORTANT]
> **数据盘挂载要求**：
> 生产环境强烈建议将独立大容量数据盘格式化为 `ext4` 并永久挂载至 `/data`（写入 `/etc/fstab`）。
> 代码、上传文档与知识图谱底座均集中存放在 `/data/llmwiki`，保障系统根分区空间安全。

---

## 2. 方式一：一键全自动脚手架部署（推荐，5分钟就绪）

我们在项目中内置了全流程自动化脚手架，在本地开发控制机仅需执行**两条命令**即可完成整台服务器的安装与拉起：

### 第 1 步：执行底座自动化脚手架初始化
在本地开发机根目录下执行：
```bash
PROD_HOST="<新服务器公网IP或SSH别名>" \
DOMAIN="knowledge.5gsailor.com" \
bash scripts/bootstrap-new-server.sh
```
> **脚本自动完成**：
> - 自动化安装 Node.js 20 LTS、pnpm、Bun 运行时；
> - 自动化安装 PostgreSQL 16 与 `pgvector` 扩展，配置 `BYPASSRLS` 权限并建库；
> - 自动化安装配置 Redis 7，生成强随机密码；
> - 自动化规划 `/data` 目录与软链，部署并链接 GBrain CLI 底座；
> - 自动化安装 Python 解析服务独立虚拟环境与依赖；
> - 自动化生成高强度密钥的 `production.env`；
> - 自动化注册 `llmwiki-parser`、`llmwiki-api`、`llmwiki-web` 等 Systemd 守护服务；
> - 自动化生成并热加载 Nginx 反向代理配置。

### 第 2 步：执行代码构建、双引擎数据库迁移与服务拉起
底座初始化完成后，直接执行生产发布命令：
```bash
PROD_HOST="<新服务器公网IP或SSH别名>" \
bash scripts/deploy-prod.sh --target=inst1
```
> **脚本自动完成**：
> - 本地编译 NestJS API 与 Next.js Web；
> - 增量 rsync 同步代码与产物至目标服务器 `/home/ubuntu/gbrainkg`；
> - 执行 Prisma 数据库架构迁移与 GBrain 迁移（`gbrain apply-migrations --yes`）；
> - 自动初始化超级管理员账号 `admin`（初始密码：`123456`）；
> - 重启服务并执行全套健康巡检。

---

## 3. 方式二：逐行手动部署 SOP（深度定制与运维审计）

如果需要在企业隔离环境、私有云或需要按审计规范逐项手动执行，请按以下步骤操作：

### 第一步：基础依赖与运行时环境
登录新服务器（`ssh ubuntu@<SERVER_IP>`），执行系统级基础工具安装：

```bash
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends \
  curl wget git rsync jq build-essential antiword \
  libpq-dev python3 python3-pip python3-venv openssl \
  ca-certificates gnupg lsb-release nginx
```

安装 Node.js 20 LTS 与 pnpm：
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm
```

安装 Bun 运行时并建立全局软链：
```bash
curl -fsSL https://bun.sh/install | bash
sudo ln -sfn $HOME/.bun/bin/bun /usr/local/bin/bun
```

---

### 第二步：核心中间件安装（PostgreSQL 16 + Redis 7）

#### 1. PostgreSQL 16 + pgvector
```bash
# 安装 PostgreSQL 16 与向量扩展（Ubuntu 24.04 自带，22.04 可添加 pgdg 源）
sudo apt-get install -y postgresql-16 postgresql-16-pgvector

sudo systemctl enable --now postgresql

# 生成随机数据库密码
DB_PASS=$(openssl rand -hex 16)
echo "数据库密码: $DB_PASS"

# 创建用户并授予 BYPASSRLS 权限（【核心铁律】防止迁移报错）
sudo -u postgres psql -c "CREATE USER llmwiki WITH PASSWORD '$DB_PASS';"
sudo -u postgres psql -c "ALTER ROLE llmwiki BYPASSRLS;"

# 创建实例1专属数据库
sudo -u postgres psql -c "CREATE DATABASE llmwiki OWNER llmwiki;"

# 安装关键扩展
sudo -u postgres psql -d llmwiki -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -d llmwiki -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
sudo -u postgres psql -d llmwiki -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

#### 2. Redis 7
```bash
sudo apt-get install -y redis-server

REDIS_PASS=$(openssl rand -hex 16)
echo "Redis密码: $REDIS_PASS"

# 配置监听本地与设置密码
sudo sed -i 's/^bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
echo "requirepass $REDIS_PASS" | sudo tee -a /etc/redis/redis.conf

sudo systemctl enable --now redis-server
sudo systemctl restart redis-server
```

---

### 第三步：存储目录规划与 GBrain 知识底座部署

```bash
# 1. 建立数据盘持久化目录
sudo mkdir -p /data/llmwiki/runtime/uploads
sudo mkdir -p /data/llmwiki/runtime/gbrain-sources
sudo mkdir -p /data/llmwiki/gbrain-data
sudo mkdir -p /home/ubuntu/.config/llmwiki
mkdir -p /home/ubuntu/gbrainkg

# 2. 赋予运维账号权限
sudo chown -R ubuntu:ubuntu /data/llmwiki /home/ubuntu/gbrainkg /home/ubuntu/.config/llmwiki

# 3. 建立运行时软链
ln -sfn /data/llmwiki/runtime /home/ubuntu/gbrainkg/runtime

# 4. 部署 GBrain 知识底座
git clone https://github.com/garrytan/gbrain.git /data/llmwiki/gbrain-data
cd /data/llmwiki/gbrain-data
bun install
chmod +x /data/llmwiki/gbrain-data/src/cli.ts

# 5. 建立全局可执行软链
sudo ln -sfn /data/llmwiki/gbrain-data/src/cli.ts /usr/local/bin/gbrain
mkdir -p /home/ubuntu/.local/bin /home/ubuntu/.local/share
ln -sfn /data/llmwiki/gbrain-data /home/ubuntu/.local/share/gbrain
ln -sfn /usr/local/bin/gbrain /home/ubuntu/.local/bin/gbrain

# 验证版本输出（预期: gbrain 0.47.6.0）
gbrain --version
```

---

### 第四步：Python 文档解析微服务 (.venv) 部署

```bash
cd /home/ubuntu/gbrainkg
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install \
  'fastapi>=0.111.0' 'uvicorn>=0.30.0' 'pydantic>=2.7.0' 'python-multipart>=0.0.9' \
  'httpx>=0.28.0' 'pypdf>=5.0.0' 'python-docx>=1.1.0' 'python-pptx>=1.0.0' \
  'openpyxl>=3.1.0' 'xlrd>=2.0.1' 'minio>=7.2.7'
```

---

### 第五步：生产环境配置 (production.env) 生成

创建 `/home/ubuntu/.config/llmwiki/production.env` 文件：

```bash
AUTH_SECRET=$(openssl rand -hex 32)
MODEL_CONFIG_KEY=$(openssl rand -hex 32)
PARSER_AUTH_TOKEN=$(openssl rand -hex 32)

cat <<EOF > /home/ubuntu/.config/llmwiki/production.env
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
WEB_PORT=3200
HTTP_PORT=20080

DB_USER=llmwiki
DB_PASS=${DB_PASS}
DB_NAME=llmwiki
DATABASE_URL=postgresql://llmwiki:${DB_PASS}@127.0.0.1:5432/llmwiki?schema=public
GBRAIN_DATABASE_URL=postgresql://llmwiki:${DB_PASS}@127.0.0.1:5432/llmwiki?schema=public

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASS=${REDIS_PASS}
REDIS_DB=0

AUTH_SECRET=${AUTH_SECRET}
MODEL_CONFIG_KEY=${MODEL_CONFIG_KEY}
PARSER_AUTH_TOKEN=${PARSER_AUTH_TOKEN}
PARSER_WORKER_URL=http://127.0.0.1:8100
AUTH_TOKEN=${PARSER_AUTH_TOKEN}

WEB_ORIGIN=https://knowledge.5gsailor.com:20080
CORS_ORIGINS=https://knowledge.5gsailor.com:20080

BRAIN_REPO_BASE_PATH=/home/ubuntu/gbrainkg/runtime
UPLOAD_ROOT=/data/llmwiki/runtime/uploads
GBRAIN_HOME=/home/ubuntu/.config/gbrain
GBRAIN_BIN=/usr/local/bin/gbrain

GBRAIN_VERSION=0.47.6.0
GBRAIN_MAINTENANCE_ENABLED=1
GBRAIN_MAINTENANCE_TZ=Asia/Shanghai
GBRAIN_MAINTENANCE_CRON="0 2 * * *"
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

ADMIN_EMAIL=admin@local.invalid
EOF

chmod 600 /home/ubuntu/.config/llmwiki/production.env
```

---

### 第六步：Systemd 系统守护进程注册

#### 1. 全局 Python 解析服务 (`/etc/systemd/system/llmwiki-parser.service`)
```ini
[Unit]
Description=LLMWiki Parser Worker
After=network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/gbrainkg/apps/parser-worker
EnvironmentFile=/home/ubuntu/.config/llmwiki/production.env
ExecStart=/home/ubuntu/gbrainkg/.venv/bin/python -m uvicorn src.main:app --host 127.0.0.1 --port 8100
Restart=always
RestartSec=5
TimeoutStopSec=15

MemoryMax=4G
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

#### 2. 实例 1 后端 API 服务 (`/etc/systemd/system/llmwiki-api.service`)
```ini
[Unit]
Description=LLMWiki API (inst1)
After=network.target postgresql.service redis-server.service llmwiki-parser.service
Wants=llmwiki-parser.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/gbrainkg/apps/api
EnvironmentFile=/home/ubuntu/.config/llmwiki/production.env
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/node /home/ubuntu/gbrainkg/apps/api/dist/main.js
Restart=always
RestartSec=5
TimeoutStopSec=15

MemoryMax=2G
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

#### 3. 实例 1 前端 Web 服务 (`/etc/systemd/system/llmwiki-web.service`)
```ini
[Unit]
Description=LLMWiki Web (inst1)
After=network.target llmwiki-api.service
Wants=llmwiki-api.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/gbrainkg/apps/web
Environment=PORT=3200
Environment=NODE_ENV=production
EnvironmentFile=/home/ubuntu/.config/llmwiki/production.env
Environment=PATH=/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/node /home/ubuntu/gbrainkg/node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3200
Restart=always
RestartSec=5
TimeoutStopSec=15

MemoryMax=1G
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

重载并启用服务：
```bash
sudo systemctl daemon-reload
sudo systemctl enable llmwiki-parser.service llmwiki-api.service llmwiki-web.service
sudo systemctl start llmwiki-parser.service
```

---

### 第七步：Nginx 边缘网关与 SSL 证书配置

创建 `/etc/nginx/sites-available/llmwiki`：
```nginx
limit_req_zone $binary_remote_addr zone=llmwiki_login:10m rate=3r/s;
limit_req_zone $binary_remote_addr zone=llmwiki_api:10m rate=20r/s;

server {
    listen 80;
    listen [::]:80;
    server_name knowledge.5gsailor.com;
    location / {
        return 301 https://$host:20080$request_uri;
    }
}

server {
    listen 20080 ssl http2;
    listen [::]:20080 ssl http2;
    server_name knowledge.5gsailor.com;

    ssl_certificate /etc/letsencrypt/live/knowledge.5gsailor.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/knowledge.5gsailor.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 250M;

    location = /health {
        proxy_pass http://127.0.0.1:3000/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /api/v1/auth/login {
        limit_req zone=llmwiki_login burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ {
        limit_req zone=llmwiki_api burst=40 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /open-api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用站点并重载 Nginx：
```bash
sudo ln -sfn /etc/nginx/sites-available/llmwiki /etc/nginx/sites-enabled/llmwiki
sudo nginx -t && sudo systemctl reload nginx
```
> 若新服务器暂未申请 SSL 证书，可先在 `listen 20080;`（去除去 `ssl http2`）进行 HTTP 临时调试，域名解析生效后执行 `sudo certbot --nginx -d knowledge.5gsailor.com` 一键配置安全证书。

---

### 第八步：代码全量构建、双引擎迁移与拉起

在本地开发机执行自动化发布命令：
```bash
PROD_HOST="<新服务器公网IP或SSH别名>" bash scripts/deploy-prod.sh --target=inst1
```

---

## 4. 核心防线检查清单（避坑铁律）

在发布上线前，检查如下 4 条核心铁律：

| 校验项 | 关键标准 | 检查方法 |
| :--- | :--- | :--- |
| **防线 1：Redis DB 隔离** | 实例 1 必须配置 `REDIS_DB=0` | `grep REDIS_DB ~/.config/llmwiki/production.env` |
| **防线 2：BYPASSRLS 权限** | PG 角色 `llmwiki` 必须拥有 `BYPASSRLS` | `sudo -u postgres psql -tAc "SELECT rolbypassrls FROM pg_roles WHERE rolname='llmwiki'"` |
| **防线 3：GBrain CLI 全局软链** | `/usr/local/bin/gbrain` 和 `/usr/local/bin/bun` 必须存在且正常输出版本 | `gbrain --version && bun --version` |
| **防线 4：数据盘挂载路径** | 运行时数据与代码存放在 `/data/llmwiki` | `df -h /data` |

---

## 5. 系统冒烟巡检与验收测试

部署完成后，在服务器上或本地运行健康检查：

```bash
# 1. 检查各服务状态
sudo systemctl status llmwiki-parser llmwiki-api llmwiki-web

# 2. 检查内部健康接口
curl -I http://127.0.0.1:3000/open-api/spec.json
curl -I http://127.0.0.1:3200/

# 3. 检查公网网关访问
curl -k -I https://<服务器公网IP或域名>:20080/

# 4. 登录验证
# 打开浏览器访问 https://<服务器公网IP或域名>:20080
# 账号: admin
# 密码: 初始密码（默认 123456）
```

**文档上传与解析全链路测试**：
1. 登录后台控制台，上传一份 PDF 或 Word 文档；
2. 观察文档解析队列流转：`上传中 -> 解析中 (parsing) -> 索引中 (indexing) -> 已发布 (published/ready)`；
3. 知识问答页面针对文档内容提问，验证知识检索与回答精准度。

---

## 6. 后续扩充实例 2、实例 3 指南

新服务器部署好实例 1 之后，整台服务器的基础中间件（PostgreSQL 16、Redis 7、Parser-Worker、Nginx）已全部就绪。

当后续需要为新客户开辟**实例 2、实例 3... 实例 N** 时：
**切勿重复安装中间件！** 直接在本地执行：
```bash
# 开辟实例 2
PROD_HOST="<服务器IP>" bash scripts/provision-instance.sh 2

# 开辟实例 3
PROD_HOST="<服务器IP>" bash scripts/provision-instance.sh 3
```
每个新客户实例仅额外占用 ~100MB 内存，单机轻松承载 10+ 实例，极致节省硬件资源！
