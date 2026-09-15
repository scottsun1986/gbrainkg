# GBrainKG 最节省资源型多实例部署与运维全指南

本文档定义在生产服务器（如 `meetings2`）上开辟、扩展与运维多客户实例的标准架构规范与自动化工具链。
该架构通过**中间件全量共享 + 业务进程专属极轻量化 + 强隔离安全防线**，实现极致节省资源与高可用性。

---

## 1. 核心设计架构：共享重型中间件，专属轻量业务进程

每个新实例**严禁**重复部署全量 Docker 容器、独立数据库集群或重型 Python 服务，统一遵循如下规范：

| 组件类别 | 服务名称 | 部署形态 | 资源开销机制 | 隔离与安全保障 |
| :--- | :--- | :--- | :--- | :--- |
| **持久化存储** | **PostgreSQL 16** | **全局共享单实例** | 每个实例专属独立 Database（如 `llmwiki`, `llmwiki_inst2`, `llmwiki_inst3`） | 数据库逻辑物理分库，连接池由 PG 统一复用调度 |
| **消息队列与缓存** | **Redis 7** | **全局共享单实例** | 每个实例分配独立 DB 索引（`REDIS_DB=0`, `REDIS_DB=1`, `REDIS_DB=2`...） | **【核心铁律】** BullMQ 队列按 DB 隔离，严禁多实例共享同一 Redis 库 |
| **AI 文档解析** | **Parser-Worker** | **全局共享单实例 (8100 端口)** | Python/Docling/OCR 解析池由全局共享，按任务队列排队 | 零重复显存/内存开销，单实例常驻仅占一份资源 |
| **对象存储** | **MinIO** | **全局共享单实例 (9000 端口)** | 全局单守护进程，按实例前缀或 Bucket 逻辑隔离 | 统一对象存储，共享磁盘 I/O 优化 |
| **边缘网关** | **Nginx** | **全局共享单实例** | 复用泛域名或 SAN SSL 证书，高端口段做网关路由 | `20080`=实例1，`20081`=实例2，`20082`=实例3... |
| **业务 API** | **llmwiki-api-instN** | **实例专属 Systemd 服务** | 轻量 NestJS（运行态内存 ~60MB，设 `MemoryMax=2G` 防护） | 独立端口（`3000`, `3002`, `3004`...），独立配置文件 |
| **前端 Web** | **llmwiki-web-instN** | **实例专属 Systemd 服务** | 极轻量 Next.js（运行态内存 ~50MB，设 `MemoryMax=1G`） | 独立端口（`3200`, `3201`, `3202`...），独立 SSR 渲染 |

> **容量测算**：
> 在 8 核 16GB / 32GB 内存的标准服务器上，部署单个新客户实例仅需额外消耗约 **100MB~150MB** 内存，单机可轻松支撑 10+ 独立客户实例同时稳定运行。

---

## 2. 实例端口与路径规划规范表

| 实例标识 | 实例代码与存储根路径 | API 端口 | Web 端口 | 公网 HTTPS 端口 | 数据库名 | Redis DB | 配置文件路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **实例 1 (inst1)** | `/data/llmwiki` (软链至 `/home/ubuntu/gbrainkg`) | `3000` | `3200` | `20080` | `llmwiki` | `0` | `~/.config/llmwiki/production.env` |
| **实例 2 (inst2)** | `/data/llmwiki-inst2` (软链至 `/home/ubuntu/gbrainkg-inst2`) | `3002` | `3201` | `20081` | `llmwiki_inst2` | `1` | `~/.config/llmwiki/production-inst2.env` |
| **实例 3 (inst3)** | `/data/llmwiki-inst3` (软链至 `/home/ubuntu/gbrainkg-inst3`) | `3004` | `3202` | `20082` | `llmwiki_inst3` | `2` | `~/.config/llmwiki/production-inst3.env` |
| **实例 N (instN)** | `/data/llmwiki-instN` (软链至 `/home/ubuntu/gbrainkg-instN`) | `3000+2(N-1)` | `3200+(N-1)` | `20080+(N-1)` | `llmwiki_instN` | `N-1` | `~/.config/llmwiki/production-instN.env` |

---

## 3. 防患未然：多实例部署核心防线与踩坑规避（Lessons Learned）

在多实例混合部署中，以下四条安全防线由代码与脚本强制保障，彻底杜绝文档卡在“索引中/解析中”的隐患：

### 防线 1：Redis 库号物理强隔离（杜绝任务跨实例偷抢）
- **根因场景**：若多个实例的 BullMQ 队列连入同一个 Redis DB（默认 0），实例 1 的 Worker 会抢到实例 2 的解析/向量任务。由于文档实体仅存在于实例 2 的数据库，实例 1 查不到数据后会将其判定为“已删除”，导致向量富化被跳过、文档在实例 2 **永久卡在 `indexing` 或 `parsing`**。
- **自动防线**：
  1. `apps/api/src/app.module.ts` 强制读取 `REDIS_DB=Number(process.env.REDIS_DB || 0)`。
  2. `apps/api/src/main.ts` 启动时打印连接的 Redis 库号，若非默认端口运行在 DB 0，输出强警告。
  3. `scripts/deploy-prod.sh` 在部署前执行**预检门禁（Pre-flight Check）**：强制核验 `REDIS_DB` 是否严格等于 `instN - 1`，若发现库号冲突或未配置，**立即中断部署**。

### 防线 2：PostgreSQL `BYPASSRLS` 权限与 GBrain 迁移全量同步
- **根因场景**：GBrain 知识图谱与向量引擎底层拥有 144 个架构迁移（包含行级安全策略 RLS 与表结构演进）。若新建数据库时所属角色缺少 `BYPASSRLS` 权限，GBrain 迁移会在第 24 版中断，导致 `pages` 表缺失 `chunker_version` 字段，文档知识源同步必然报错中断。
- **自动防线**：
  1. `scripts/provision-instance.sh` 与 `scripts/deploy-prod.sh` 自动执行检查：
     `ALTER ROLE llmwiki BYPASSRLS;`
  2. 部署时自动执行 `gbrain apply-migrations --yes`，保证底座与 Prisma 架构 100% 同步。

### 防线 3：可执行程序全局软链与 PATH 自愈
- **根因场景**：Systemd 服务的非交互式环境变量与 Node.js 子进程可能缺少自定义 PATH，导致执行 `gbrain` 或 `bun` 时报 `command not found`。
- **自动防线**：
  1. 生产服务器全局建立软链：`/usr/local/bin/bun` 和 `/usr/local/bin/gbrain`。
  2. `gbrain-adapter` 代码中自动将 `gbrainBin` 所在目录及系统标准路径优先注入子进程环境。

### 防线 4：系统启动自愈与断点续传（Self-Healing Ingestion）
- `IngestionService.onModuleInit` 具备断点续传能力：
  - 若文档停留在 `parsing`：自动重新加入解析队列；
  - 若文档停留在 `indexing`：自动排队向量富化并重新触发 `onKnowledgePublished` 发布流程。
- 服务每次重启时，均会自动唤醒历史异常滞留文档并走完发布流程。

---

## 4. 新实例一键开辟操作手册（SOP）

当需要为新客户开辟第 3 套新实例（`inst3`）时，无需手动执行繁琐命令，使用自动化脚本即可全流程就绪：

### 第一步：一键初始化新实例基础环境
在开发机根目录执行自动化开辟脚本：
```bash
bash scripts/provision-instance.sh 3
```
脚本将在生产服务器 `meetings2` 自动完成：
1. 校验数据盘 `/data` 挂载；
2. 自动检查并配置 PostgreSQL 角色 `BYPASSRLS`；
3. 创建独立数据库 `llmwiki_inst3`；
4. 创建数据盘存储目录 `/data/llmwiki-inst3/{runtime,code,uploads}` 与软链；
5. 自动生成专属配置文件 `~/.config/llmwiki/production-inst3.env`（`PORT=3004`, `REDIS_DB=2`, 独立数据库与路径）；
6. 自动生成并注册 Systemd 服务 `llmwiki-api-inst3` 与 `llmwiki-web-inst3`。

### 第二步：配置 Nginx 端口反向代理
登录生产服务器 `ssh meetings2`，在 `/etc/nginx/sites-available/knowledge.5gsailor.com` 追加脚本输出的端口配置块（监听 `20082` 端口），随后重载配置：
```bash
sudo nginx -t && sudo nginx -s reload
```

### 第三步：一键发布与构建
在本地执行部署脚本，即可完成代码打包、产物同步、双引擎数据库迁移与服务拉起：
```bash
bash scripts/deploy-prod.sh --target=inst3
```
或直接使用全量发布命令：
```bash
bash scripts/deploy-prod.sh --target=all
```
> `deploy-prod.sh --target=all` 会**自动发现**远端服务器上所有已配置的实例（`inst1`, `inst2`, `inst3`...），并按实例顺序全量执行隔离性检查、增量部署与健康巡检！

---

## 5. 多实例日常运维常用指令

### 1. 查看所有实例服务状态
```bash
ssh meetings2 "systemctl status llmwiki-api llmwiki-web llmwiki-api-inst2 llmwiki-web-inst2 llmwiki-api-inst3 llmwiki-web-inst3"
```

### 2. 查看特定实例实时日志
```bash
ssh meetings2 "journalctl -u llmwiki-api-inst3 -f"
```

### 3. 查看特定实例数据库文档发布状态
```bash
ssh meetings2 "sudo -u postgres psql -d llmwiki_inst3 -c 'SELECT id, title, status, \"qualityStatus\", \"indexReadiness\" FROM \"Document\" ORDER BY \"createdAt\" DESC;'"
```

### 4. 查看各实例 Redis 隔离状态
```bash
# 查看实例 1 队列
ssh meetings2 "REDISCLI_AUTH=PASSWORD redis-cli -n 0 keys 'bull:*'"
# 查看实例 2 队列
ssh meetings2 "REDISCLI_AUTH=PASSWORD redis-cli -n 1 keys 'bull:*'"
# 查看实例 3 队列
ssh meetings2 "REDISCLI_AUTH=PASSWORD redis-cli -n 2 keys 'bull:*'"
```
