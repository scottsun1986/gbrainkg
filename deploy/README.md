# LLMWiki 生产环境部署 (宿主机原生架构 / Host-Native)

> 📖 **相关指南索引**：
> - 🚀 **新服务器从零部署实例 1**：参见 [新服务器部署手册 (NEW_SERVER_DEPLOY_GUIDE.md)](file:///home/scottsun/gbrainkg/deploy/NEW_SERVER_DEPLOY_GUIDE.md)
> - 🏢 **生产多实例极简资源扩容（实例 2、3...）**：参见 [多实例部署指南 (MULTI_INSTANCE_GUIDE.md)](file:///home/scottsun/gbrainkg/deploy/MULTI_INSTANCE_GUIDE.md)

生产环境采用与测试环境一致的**宿主机原生部署模式（Host-Native via Systemd）**，直接运行在 Linux 宿主机上，无需通过 Docker Compose 封装应用容器，提供极佳的性能、直观的日志与便捷的运维体验。

## 架构说明

- **Web 前端 (`llmwiki-web.service`)**: Next.js 生产包，监听端口 `3200`（绑定 `0.0.0.0:3200`，局域网与本机均可访问）。
- **API 后端 (`llmwiki-api.service`)**: NestJS 生产包，监听端口 `3202`（`0.0.0.0:3202`），内置 GBrain 知识引擎与混合检索通道。
- **解析服务 (`llmwiki-parser.service`)**: FastAPI / Uvicorn Python 微服务，监听端口 `8100` (`127.0.0.1:8100`)。
- **存储与缓存**:
  - PostgreSQL (带 `pgvector` 扩展，监听端口 `5433` 或 `5432`)
  - Redis (监听端口 `6379`)
  - 文档上传路径: `~/.local/share/llmwiki/uploads`
  - GBrain 知识库数据: `~/.local/share/llmwiki/brain_repos`

---

## 快速安装与部署

### 1. 环境依赖

- **Node.js**: >= 18 (推荐 Node 20 LTS)
- **pnpm**: >= 9.0
- **Python**: >= 3.10 (含 FastAPI, Uvicorn, PyPDF 等依赖)
- **PostgreSQL**: 16+ (带 pgvector 扩展)
- **Redis**: 7+

### 2. 执行一键安装

在项目根目录执行：

```bash
./deploy/install.sh
```

一键安装脚本自动完成以下步骤：
1. 检查宿主机环境依赖（Node、pnpm、Python3、curl 等）；
2. 自动准备 `apps/api/.env` 与 `apps/web/.env.production`，生成强随机密钥；
3. 安装 monorepo Node 依赖 (`pnpm install`)；
4. 执行 Prisma 客户端生成与数据库迁移 (`prisma migrate deploy`)；
5. 编译构建 API 后端与 Web 前端；
6. 自动注册并启用 Systemd 用户服务 (`~/.config/systemd/user/llmwiki-*.service`)；
7. 开启用户会话守护 (`loginctl enable-linger $USER`)，确保终端登出后服务持续运行；
8. 执行健康检查并输出局域网访问地址。

---

## 生产升级维护

代码更新后，仅需在根目录下执行一键升级：

```bash
./deploy/upgrade.sh
```

升级脚本会自动完成依赖更新、数据库迁移、重新构建 API 与 Web 前端、平滑重启 systemd 用户服务并执行健康检查。

---

## 访问与验证

- **Web 管理界面**: `http://<服务器局域网IP>:3200` 或 `http://localhost:3200`
- **API 接口地址**: `http://<服务器局域网IP>:3202` 或 `http://localhost:3202`
- **初始管理员账号**: `admin`

---

## 常用运维命令 (Systemd)

所有的应用进程均通过 `systemd --user` 进行生命周期管理：

```bash
# 查看服务运行状态
systemctl --user status llmwiki-web.service llmwiki-api.service llmwiki-parser.service

# 重启全部服务
systemctl --user restart llmwiki-parser.service llmwiki-api.service llmwiki-web.service

# 停止服务
systemctl --user stop llmwiki-web.service llmwiki-api.service llmwiki-parser.service

# 查看实时日志
journalctl --user -u llmwiki-web -f
journalctl --user -u llmwiki-api -f
journalctl --user -u llmwiki-parser -f

# 执行健康检查
./deploy/healthcheck.sh
```

---

## 发布门禁 / 回滚（P0）

**发布门禁**（`scripts/deploy-prod.sh` 默认开启）：

```bash
# 默认：先跑 GATE_STRICT=1 bash scripts/ci.sh，失败即中止，不 rsync、不重启
bash scripts/deploy-prod.sh --target=inst1

# 显式跳过门禁（打印警告，仅限应急）
bash scripts/deploy-prod.sh --target=inst1 --skip-gate
```

- `GATE_STRICT=1` 时任一层测试失败 → 非零退出，发布中止。
- 无 `LLMWIKI_TOKEN` 时 e2e 层仍跳过，但 STRICT 下会打 `WARN`（门禁不完整）。
- `deploy/upgrade.sh` 默认 `pnpm install --frozen-lockfile`；确需刷新锁文件时显式传 `--allow-lock-update`。

**发布前快照与回滚**：

每次 rsync 前自动备份到 `$PROD_REPO/.releases/<timestamp>/`：
`manifest.json`（git SHA、`.env` 哈希、`apps/api/package.json` 版本、rsync 前树摘要）+ `tree.tar.gz`。

```bash
# 回滚到上一个发布快照（previous = 最近一次发布前的状态）
bash scripts/rollback-release.sh previous --target=inst1
# 或等价：
bash scripts/deploy-prod.sh --rollback previous --target=inst1

# 指定快照 / 列出快照
bash scripts/rollback-release.sh 20260922120000 --target=inst2
bash scripts/rollback-release.sh --list --target=inst1
```

回滚流程：按 manifest 回切代码（优先 `git checkout` 对应 SHA，否则从 `tree.tar.gz` 恢复）→ `pnpm install --frozen-lockfile` → 重启服务 → curl 健康检查。回滚失败非零退出。
**健康检查失败不会自动回滚**（避免误伤）；脚本会打印上述回滚命令，由运维确认后手动执行。

---

## 升级注意（2026-09-20 检索/图谱整改）

以下变更在**发布后需要一次性确认**，否则会出现"服务在跑但能力未生效"的静默降级：

1. **过滤 HNSW 参数按库生效**
   迁移 `20260920120000_hnsw_query_settings` 会对**当前数据库**执行
   `ALTER DATABASE ... SET hnsw.ef_search = 200 / hnsw.iterative_scan = 'relaxed_order' /
   hnsw.max_scan_tuples = 20000`。多实例场景请确认**每个实例库**都已生效
   （`provision-instance.sh` 与 `bootstrap-new-server.sh` 已内置该步骤，`deploy-prod.sh`
   在发布时会打印预检告警）：

   ```bash
   sudo -u postgres psql -d llmwiki -tAc \
     "SELECT setting FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase,
      unnest(s.setconfig) AS setting WHERE d.datname = 'llmwiki' AND setting LIKE 'hnsw.%';"
   ```

   缺失时过滤召回会退化到 Recall@10 ≈ 0.21（pgvector 默认值），且**没有任何报错**。

2. **parser-worker 容器改为非 root 运行**
   镜像现在以 uid 10002 运行。如果 `parser_data` 卷是旧版本创建的（root 所有），
   需要一次性修正属主，否则解析结果无法落盘：

   ```bash
   docker run --rm -v llmwiki_parser_data:/data alpine chown -R 10002:10002 /data
   ```

3. **本地版面模型（Docling）不在生产镜像内**
   生产镜像只安装纯库依赖（含 PyMuPDF，用于页面级 VLM 渲染），不安装
   docling/MinerU 等本地模型。`/health` 现在同时返回
   `local_docling_configured` 与 `docling_installed/local_docling_enabled`，两者不一致时
   说明配置要求了镜像不具备的能力，请改 `LOCAL_DOCLING_ENABLED=0` 或按需构建带模型的镜像。

4. **共享 parser 随任意实例发布重启**
   `deploy-prod.sh` 现在会在发布 inst2+ 时把 `apps/parser-worker` 同步到 inst1 发布目录
   并重启共享 parser，避免只发实例 2 时解析服务版本漂移。

5. **MinIO 现状**
   `docker-compose.prod.yml` 仍提供 MinIO（共享中间件），但应用代码没有任何 SDK 调用
   （`Document.rawFileOid` 存的是本地路径）。它是预留对象存储，不参与检索链路；若不需要
   控制台可自行停用，不影响功能。

---

## 备份 / 恢复演练 / 反馈门禁（P2）

### 备份（`deploy/backup.sh`）

每日全量：`pg_dump` custom format（`db-<STAMP>.dump`）+ `uploads`/`brain_repos` 归档
（`files-<STAMP>.tar.gz`）。由 `deploy/systemd/llmwiki-backup.timer` 调度，也可手动执行。

```bash
./deploy/backup.sh                     # 本地备份（默认，不开异地）
./deploy/backup.sh --offsite           # 本地成功后镜像到异地（需已配置目标）
./deploy/backup.sh --offsite-required  # 异地失败即非零退出（关键路径）
```

**校验与清单**：dump 走 pg_dump 退出码 + PGDMP 魔数（有 `pg_restore` 时再做 `--list` TOC 校验）；
`files-*.tar.gz` 走 `gzip -t`。每轮写 `backup-manifest-<STAMP>.json` 并刷新
`backup-manifest.json`（时间、大小、sha256、db name、pg 版本、offsite 结果）。

**异地备份（默认关闭）**：本地成功后才做异地镜像；失败只打日志、不阻断主备份，
除非显式 `--offsite-required`。目标二选一（也可并用）：

| 环境变量 | 含义 |
|---|---|
| `BACKUP_OFFSITE_DIR` | 异地目录，`rsync`（无 rsync 则 `cp -a`）拷贝 |
| `BACKUP_OFFSITE_S3`（旧名 `BACKUP_S3_ALIAS`） | MinIO/S3 目标（`mc` alias，例 `backup-remote/bucket`） |

其他常用变量：`BACKUP_ROOT`（默认 `~/.local/share/llmwiki/backups`）、
`BACKUP_RETAIN_COUNT`（默认 7）、`BACKUP_DB_NAME` / `BACKUP_DB_USER` / `BACKUP_DB_CONTAINER`、
`DATABASE_URL` / `PGPASSWORD`（密码只走 env，不写进脚本）。

### 备份保留（`deploy/backup-retention.sh`）

```bash
./deploy/backup-retention.sh                        # 默认保留 7 份
BACKUP_RETAIN_COUNT=14 ./deploy/backup-retention.sh # 参数化保留份数
```

统一清理：代码包（`BACKUP_KEEP_CODE`）、过期库备份/快照（`BACKUP_KEEP_DB_DAYS`）、
以及 `backup.sh` 备份根下的 `db-*.dump` / `files-*.tar.gz` / **`backup-manifest-*.json`**
（保留最新 `BACKUP_RETAIN_COUNT` 份；`backup-manifest.json` 指针永不随滚动删除，并清孤儿 manifest）。

### 备份状态（`deploy/backup-status.sh`）

```bash
./deploy/backup-status.sh
```

打印最近备份时间、大小、是否 offsite、**预计 RPO**（= 备份年龄；超过
`BACKUP_RPO_TARGET_S`，默认 86400，则 WARNING）。无备份时优雅报「无备份」并退出 0。

### 恢复演练（`deploy/restore-drill.sh` + `restore-drill.md`）

**绝不覆盖生产库**：目标库强制 `DRILL_DB_NAME=llmwiki_drill`（必须 `_drill` 后缀），
脚本拒绝 `llmwiki` / `llmwiki_inst*`。密码从 env 读。

```bash
./deploy/restore-drill.sh --dry-run       # 只校验备份 + 打印计划
./deploy/restore-drill.sh                 # 恢复到 llmwiki_drill，打印 RPO/RTO
./deploy/restore-drill.sh --files --cleanup
```

详细命令级 runbook（手工恢复步骤、验证 SQL、RPO/RTO 测量方法、演练记录表）见
**[restore-drill.md](./restore-drill.md)**。建议每季度 ≥ 1 次演练并填写记录表。

### 反馈回流门禁（`scripts/feedback-gate.sh`）

重放管理员 `converted` 的 FeedbackCase，校验拒答 / 关键词缺失 / 与旧答案完全相同
三类回归（harness：`tests/evaluation/feedback-regression.ts`，**不改其内部逻辑**）。

```bash
bash scripts/feedback-gate.sh                  # 无凭据则跳过并退出 0
GATE_STRICT=1 TEST_PASSWORD=... bash scripts/feedback-gate.sh   # 发布门禁
```

- 无 `LLMWIKI_TOKEN` / `TEST_PASSWORD`：跳过 + 警告，退出 0。
- `GATE_STRICT=1` 且配置了 token/凭据：回归失败即非零退出（`FEEDBACK_GATE=1`）。
- `scripts/ci.sh` 末尾已追加可选调用（仅当 `LLMWIKI_TOKEN` 存在）。
