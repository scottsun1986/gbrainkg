# 恢复演练 Runbook (Restore Drill)

> 目标：证明「备份真的能恢复」，并量化 **RPO**（备份新鲜度 / 最大可容忍数据丢失）与
> **RTO**（恢复耗时 / 最大可容忍中断）。空谈无效——本手册每一步都给可直接粘贴的命令。
>
> **安全铁律**：演练**绝不覆盖生产库**。目标库固定为 `llmwiki_drill`（后缀 `_drill`），
> `deploy/restore-drill.sh` 内置拒绝 `llmwiki` / `llmwiki_inst*` 等生产库名。

---

## 0. 角色与前置条件

| 项 | 要求 |
|---|---|
| 执行人 | 运维 / 值班 SRE（建议双人，一人操作一人记录） |
| 环境 | **本地开发机或测试库**；生产机上演练时也只允许写 `_drill` 库 |
| 权限 | 可 `CREATE DATABASE` / `DROP DATABASE` 的角色（默认 `llmwiki`） |
| 凭据 | 密码只从 env 读（`PGPASSWORD` 或容器内 trust），**禁止写进脚本/命令行历史** |
| 备份 | `deploy/backup.sh` 已产出 `db-*.dump`（+ 可选 `files-*.tar.gz`） |

一次性准备：

```bash
export PGPASSWORD='<从密钥管理/密码库取出，勿回显勿落盘>'
export DRILL_DB_NAME=llmwiki_drill          # 必须 *_drill
export DRILL_DB_USER=llmwiki
export DRILL_DB_CONTAINER=llmwiki-postgres  # host 无 psql 时回退 docker exec
export BACKUP_ROOT="${BACKUP_ROOT:-$HOME/.local/share/llmwiki/backups}"
```

---

## 1. 一键演练（推荐入口）

```bash
# 1) 只校验备份 + 打印计划（不建库、不恢复）——适合变更窗口前快速体检
bash deploy/restore-drill.sh --dry-run

# 2) 真实演练：恢复到 llmwiki_drill，打印 RPO/RTO
bash deploy/restore-drill.sh

# 3) 带文件恢复 + 结束后清理演练库
bash deploy/restore-drill.sh --files --cleanup

# 4) 指定某一份 dump（而不是「最新」）
bash deploy/restore-drill.sh --dump "$BACKUP_ROOT/db-20260922-020000.dump"
```

脚本输出末尾即为当次 **RPO（备份新鲜度）** 与 **RTO（创建库 + pg_restore + 验证 SQL 耗时）**。

---

## 2. 手工逐步（脚本不可用时的替代路径）

以下命令默认走 **docker exec**（共享 PostgreSQL 容器 `llmwiki-postgres`）。
宿主机装了 `psql` / `pg_restore` 时，把 `docker exec -i llmwiki-postgres` 换成
`psql -h 127.0.0.1 -p 5432 -U llmwiki` / `pg_restore -h 127.0.0.1 -p 5432 -U llmwiki` 即可。

### 2.1 挑一份备份并校验

```bash
DUMP=$(ls -1t "$BACKUP_ROOT"/db-*.dump | head -1)
echo "using $DUMP ($(du -h "$DUMP" | cut -f1))"

# pg_dump custom format：魔数 + TOC 可读
head -c 5 "$DUMP"        # 应显示 PGDMP
pg_restore --list "$DUMP" >/dev/null && echo "TOC ok"

# 文件归档（若有）：gzip -t
FILES=$(ls -1t "$BACKUP_ROOT"/files-*.tar.gz 2>/dev/null | head -1)
[ -n "$FILES" ] && gzip -t "$FILES" && echo "files archive ok"

# 每轮备份都应有 manifest；核对 sha256
cat "$BACKUP_ROOT/backup-manifest.json" | jq .
sha256sum "$DUMP"
# 与 manifest 里 artifacts[].sha256 对照，不一致立即停演、查备份链路
```

### 2.2 建演练库（绝不碰生产库）

```bash
DB=llmwiki_drill   # 必须 _drill 结尾

docker exec -i llmwiki-postgres psql -U llmwiki -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = '$DB' AND pid <> pg_backend_pid();"

docker exec -i llmwiki-postgres psql -U llmwiki -d postgres -c \
  "DROP DATABASE IF EXISTS \"$DB\";"

docker exec -i llmwiki-postgres psql -U llmwiki -d postgres -c \
  "CREATE DATABASE \"$DB\" OWNER llmwiki;"

# 与 scripts/bootstrap-new-server.sh 对齐的扩展集
for ext in vector pg_trgm pgcrypto; do
  docker exec -i llmwiki-postgres psql -U llmwiki -d "$DB" \
    -c "CREATE EXTENSION IF NOT EXISTS $ext;"
done
```

### 2.3 恢复数据库（RTO 计时核心段）

```bash
# RTO 计时开始
START=$(date +%s)

docker cp "$DUMP" llmwiki-postgres:/tmp/restore-drill.dump
docker exec -i llmwiki-postgres pg_restore \
  -U llmwiki -d "$DB" --no-owner --exit-on-error /tmp/restore-drill.dump
docker exec -i llmwiki-postgres rm -f /tmp/restore-drill.dump

END=$(date +%s)
echo "RTO(core restore) = $((END - START))s"
```

`--exit-on-error` 必须保留：部分失败的恢复若被当成功，演练结论无效。

### 2.4 恢复文件（可选）

```bash
DRILL_FILES_DIR="$HOME/.local/share/llmwiki/restore-drill"
rm -rf "$DRILL_FILES_DIR" && mkdir -p "$DRILL_FILES_DIR"
tar -xzf "$FILES" -C "$DRILL_FILES_DIR"
find "$DRILL_FILES_DIR" -type f | wc -l
```

### 2.5 验证 SQL（恢复成功的客观证据）

```bash
docker exec -i llmwiki-postgres psql -U llmwiki -d llmwiki_drill -v ON_ERROR_STOP=1 <<'SQL'
-- 扩展就位
SELECT extname FROM pg_extension
 WHERE extname IN ('vector','pg_trgm','pgcrypto') ORDER BY 1;

-- 表/索引规模（应与生产同一数量级）
SELECT count(*) AS public_tables   FROM pg_tables  WHERE schemaname = 'public';
SELECT count(*) AS public_indexes  FROM pg_indexes WHERE schemaname = 'public';

-- 关键业务表行数（Prisma 模型名即表名，无 @@map）
SELECT 'User'           AS t, count(*) FROM "User"
UNION ALL SELECT 'KnowledgeBase', count(*) FROM "KnowledgeBase"
UNION ALL SELECT 'Document',      count(*) FROM "Document"
UNION ALL SELECT 'Chunk',         count(*) FROM "Chunk"
UNION ALL SELECT 'GraphEntity',   count(*) FROM "GraphEntity";

-- 向量列可读（embedding 维度不为 0）
SELECT count(*) AS chunks_with_embedding
  FROM "Chunk" WHERE embedding IS NOT NULL;

-- 一次真实向量检索（384/1024 维都兼容：用现有行的向量自比对）
SELECT id FROM "Chunk"
 WHERE embedding IS NOT NULL
 ORDER BY embedding <=> (SELECT embedding FROM "Chunk" WHERE embedding IS NOT NULL LIMIT 1)
 LIMIT 5;
SQL
```

**通过标准（至少满足）：**
1. `pg_restore` 退出码 0（`--exit-on-error` 下无跳过错误）；
2. 三个扩展均在；
3. `User` / `Document` / `Chunk` 行数 > 0，且与备份前 `backup-manifest.json` 同期生产计数偏差 < 1%（或落在 RPO 窗口内的合理增量）；
4. 向量自比对查询返回 5 行（证明 pgvector 索引/数据可用）；
5. （若做了 2.4）文件数与 `files-*.tar.gz` 内条目数一致：`tar -tzf "$FILES" | wc -l`。

### 2.6 清理演练库

```bash
docker exec -i llmwiki-postgres psql -U llmwiki -d postgres -c \
  "DROP DATABASE IF EXISTS llmwiki_drill;"
rm -rf "$HOME/.local/share/llmwiki/restore-drill"
```

---

## 3. RPO / RTO 测量方法

### 3.1 RPO（Recovery Point Objective）= 备份新鲜度

**定义**：若生产库此刻损毁、只能靠本次备份回退，最多丢失多长时间的数据。
对「每日全量 pg_dump」来说，RPO ≈ **最近一次成功备份距现在的时间**。

```bash
# 用现成脚本（推荐）：直接打印 estimated RPO
bash deploy/backup-status.sh

# 手工测量
DUMP=$(ls -1t "$BACKUP_ROOT"/db-*.dump | head -1)
NOW=$(date +%s)
MT=$(stat -c %Y "$DUMP")
echo "RPO = $((NOW - MT))s  (backup age)"
# 或以 manifest 生成时刻为准
jq -r .generatedAt "$BACKUP_ROOT/backup-manifest.json"
```

**目标值建议**：日备 ⇒ RPO 目标 24h；若业务要求 RPO ≤ 1h，必须上 WAL 归档 / `pg_basebackup`+连续归档，仅靠本脚本日备**达不到**。

### 3.2 RTO（Recovery Time Objective）= 端到端恢复耗时

**定义**：从「决定恢复」到「验证 SQL 通过」的墙钟时间。本演练记两段：

| 段 | 计时范围 | 命令 |
|---|---|---|
| RTO(core) | `CREATE DATABASE` + 扩展 + `pg_restore` | `restore-drill.sh` 打印的 RTO |
| RTO(e2e)  | 上述 + 文件恢复 + 验证 SQL + （人工确认） | 演练记录表手工填 |

```bash
START=$(date +%s)
# ... 执行 2.2 + 2.3 + 2.5 ...
END=$(date +%s)
echo "RTO(e2e) = $((END - START))s"
```

**目标值建议**：先测出基线，再定目标（例如基线 12min ⇒ 目标 ≤ 30min）。
超标就按瓶颈优化：本地 SSD 摆 dump、并行 `pg_restore -j 4`、预热扩展模板库。

### 3.3 如何把 RPO/RTO 写成可验收数字

- **实测 RPO** = 演练时刻 − 备份 mtime（见上）。
- **实测 RTO** = 演练脚本输出。
- **达标线** = 与业务书面约定的目标（例：RPO ≤ 24h，RTO ≤ 60min）。
- 结论只允许三种：**达标** / **超标（附瓶颈）** / **失败（附日志）**。

---

## 4. 演练记录表（每次演练复制一份填写）

```markdown
### 演练记录 — <YYYY-MM-DD>

| 项 | 值 |
|---|---|
| 演练日期/时间 | |
| 执行人 / 记录人 | |
| 环境（本地 / 测试 / 生产只读） | |
| 备份文件 | db-<STAMP>.dump |
| 备份时间（mtime 或 manifest.generatedAt） | |
| 备份大小 / sha256 核对 | 通过 / 失败 |
| offsite 副本是否可取到 | 是 / 否 / 未启用 |
| 恢复目标库 | llmwiki_drill |
| pg_restore 退出码 | |
| 验证 SQL 结果摘要（User/Document/Chunk 行数） | |
| 文件恢复（若有）文件数 | |
| **实测 RPO** | |
| **实测 RTO(core)** | |
| **实测 RTO(e2e)** | |
| RPO 目标 / 是否达标 | |
| RTO 目标 / 是否达标 | |
| 发现的问题 | |
| 后续行动项（负责人 / 截止日） | |
| 结论（达标 / 超标 / 失败） | |
```

**演练节奏建议**：每季度 ≥ 1 次全量演练；备份链路、PG 大版本、存储位置任一变更后 7 天内补一次。

---

## 5. 故障速查

| 现象 | 排查 |
|---|---|
| `pg_restore: error: did not find magic string` | dump 截断/损坏；用 `backup-manifest.json` 的 sha256 对照，换上一份备份 |
| `database llmwiki_drill already has active connections` | 先 `pg_terminate_backend`（见 2.2） |
| `extension "vector" does not exist` | 宿主机未装 `postgresql-16-pgvector`；扩展模板或换用带扩展的容器镜像 |
| 恢复后 Chunk 行数远少于预期 | 确认拿的是全量 `pg_dump`（custom format）而不是 schema-only；查 backup.sh 日志 |
| RTO 远超目标 | `pg_restore -j 4`、dump 放本地盘、先建好扩展再恢复、把非关键索引恢复后建 |

---

## 6. PITR 演练纪要（2026-09-23，meetings2，`llmwiki` → `llmwiki_pitr_drill`）

> 路径：`deploy/restore-pitr.sh`（basebackup + WAL 归档，**非**逻辑 dump）。
> 完整 runbook 见 `docs/postgres-pitr-ha-runbook.md`。

| 项 | 值 |
|---|---|
| 日期 / 主机 | 2026-09-23 22:53–22:55 CST / meetings2 |
| basebackup | `/data/pg-backup/basebackup-20260923-225312`（8s，manifest 齐全） |
| marker A | `2026-09-23 22:53:45.016896+08` |
| marker B | `2026-09-23 22:53:47.161664+08` |
| recovery_target_time | `2026-09-23 22:53:46+08` |
| 截断证据 | B 未进恢复集 / A 已进（日志 `stopping before commit … 22:53:47.162`） |
| 演练库 | `llmwiki_pitr_drill`（独立 data dir `/data/pg-drill/pitr-20260923-drill`，:55432） |
| 行数核对 | users=10 kbs=26 docs=10703 chunks=13996（= 演练前 `llmwiki`） |
| **实测 RPO** | 点恢复精度 **≈ 1.2s**；生产上界 **≤ 5min**（`archive_timeout=300`） |
| **实测 RTO(core)** | **≈ 9.5s**（extract 1.5G + WAL replay + promote） |
| **实测 RTO(e2e)** | 含决策/改连接串另计，目标 ≤ 15min（promote 路径） |
| 三实例 API | `/ready` 全程 200/200/200（未受影响） |
| 结论 | **达标**（真 PITR 截断验证通过；RTO 9.5s ≪ dump 路径 377s） |
