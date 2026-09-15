# GBrainKG 最节省资源型多实例部署与运维手册

本文档定义在同一台生产服务器（如 `meetings2`）上多开客户实例的标准模式。该模式保证**资源消耗极低、实例数据安全隔离、运维一致性强**。

---

## 1. 核心设计原则：共享重型中间件，专属轻量业务进程

每个新实例**绝不能**重复部署全量 Docker 容器、数据库或 Python 重型服务，而是遵循如下原则：

| 组件类别 | 服务名称 | 部署形态 | 资源开销机制 |
| :--- | :--- | :--- | :--- |
| **持久化存储** | **PostgreSQL 16** | **全局共享单实例** | 每个实例专属独立 Database（如 `llmwiki`, `llmwiki_inst2`, `llmwiki_inst3`），共享连接池与底层资源，零重复常驻内存 |
| **内存队列与缓存** | **Redis 7** | **全局共享单实例** | 每个实例分配独立 DB 编号（`REDIS_DB=0`, `REDIS_DB=1`, `REDIS_DB=2`），数据与 BullMQ 队列天然隔离 |
| **AI 文档解析** | **Parser-Worker (Docling)** | **全局共享单实例 (8100 端口)** | Python/OCR/PDF 解析进程池由全局共享，按需处理各实例排队任务，避免重复消耗几百 MB 至数 GB 显存/内存 |
| **对象存储** | **MinIO** | **全局共享单实例 (9000 端口)** | 共享存储守护进程，按前缀或 Bucket 逻辑隔离 |
| **边缘网关** | **Nginx** | **全局共享单实例** | 复用泛域名或 SAN SSL 证书，以端口段映射（`20080` 对应实例 1，`20081` 对应实例 2...）实现反向代理 |
| **业务 API** | **llmwiki-api-instN (NestJS)** | **实例专属 Systemd 服务** | 轻量 Node.js 进程（运行态内存仅约 50MB~80MB，设 `MemoryMax=2G` 防护），负责该实例的专属路由与安全管控 |
| **前端 Web** | **llmwiki-web-instN (Next.js)** | **实例专属 Systemd 服务** | 极轻量 SSR/静态服务（运行态内存仅约 50MB，设 `MemoryMax=1G`） |

> **容量测算**：
> 在 8 核 16GB 内存或 32GB 内存的标准服务器上，采用此架构部署单个新实例仅额外增加约 **100MB~150MB** 物理内存，单机可轻松承载 10+ 独立运行的单客户系统。

---

## 2. 实例端口与路径规划标准表

| 实例编号 | 实例代码与存储根路径 | 后端端口 | 前端端口 | 对外 HTTPS 端口 | 数据库名 | Redis 库号 | 配置文件路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **实例 1** | `/data/llmwiki` (软链至 `/home/ubuntu/gbrainkg`) | `3000` | `3200` | `20080` | `llmwiki` | `0` | `~/.config/llmwiki/production.env` |
| **实例 2** | `/data/llmwiki-inst2` (软链至 `/home/ubuntu/gbrainkg-inst2`) | `3002` | `3201` | `20081` | `llmwiki_inst2` | `1` | `~/.config/llmwiki/production-inst2.env` |
| **实例 3** | `/data/llmwiki-inst3` (软链至 `/home/ubuntu/gbrainkg-inst3`) | `3004` | `3202` | `20082` | `llmwiki_inst3` | `2` | `~/.config/llmwiki/production-inst3.env` |
| **实例 N** | `/data/llmwiki-instN` | `3000+2(N-1)` | `3200+(N-1)` | `20080+(N-1)` | `llmwiki_instN` | `N-1` | `~/.config/llmwiki/production-instN.env` |

---

## 3. 部署新实例标准操作流（以实例 3 为例）

当需要开辟第 3 套新实例时，仅需 5 步即可完成：

### 步骤 1：创建数据库与目录
```bash
# 1. 在 PostgreSQL 中创建独立库
sudo -u postgres psql -c "CREATE DATABASE llmwiki_inst3 OWNER llmwiki;"

# 2. 在数据盘 /data 创建目录结构
sudo mkdir -p /data/llmwiki-inst3/runtime/uploads /data/llmwiki-inst3/code
sudo chown -R ubuntu:ubuntu /data/llmwiki-inst3
ln -s /data/llmwiki-inst3/code /home/ubuntu/gbrainkg-inst3
```

### 步骤 2：生成配置文件
复制 `~/.config/llmwiki/production.env` 为 `~/.config/llmwiki/production-inst3.env`，仅需调整以下字段：
```env
PORT=3004
DATABASE_URL=postgresql://llmwiki:PASSWORD@127.0.0.1:5432/llmwiki_inst3?schema=public
GBRAIN_DATABASE_URL=postgresql://llmwiki:PASSWORD@127.0.0.1:5432/llmwiki_inst3
REDIS_DB=2
BRAIN_REPO_BASE_PATH=/data/llmwiki-inst3/runtime
UPLOAD_ROOT=/data/llmwiki-inst3/runtime/uploads
WEB_ORIGIN=https://knowledge.5gsailor.com:20082
HTTP_PORT=20082
```

### 步骤 3：配置 Systemd 服务
创建 `/etc/systemd/system/llmwiki-api-inst3.service` 与 `llmwiki-web-inst3.service`：
- `API` 指定端口 `3004`、配置文件指向 `production-inst3.env`；
- `Web` 执行 `next start --hostname 127.0.0.1 --port 3202`。

### 步骤 4：配置 Nginx 端口监听
在 `/etc/nginx/sites-available/` 中添加对 `20082` 端口的 HTTPS 监听：
- 静态页面及前端反代至 `http://127.0.0.1:3202`；
- `/api/` 路由反代至 `http://127.0.0.1:3004`。
重载 Nginx：`sudo nginx -s reload`。

### 步骤 5：统一发布脚本集成
在 `scripts/deploy-prod.sh` 的目标列表中加入 `inst3`，即可使用：
```bash
bash scripts/deploy-prod.sh --target=all
```
一键完成本地编译、代码同步、数据库迁移、服务重启及健康巡检。
