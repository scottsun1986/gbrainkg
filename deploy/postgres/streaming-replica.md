# 流复制从库 (Streaming Replica / Hot Standby) — ROI-5 HA 基础

> 目标：单机可验证的 HA 基础 — 复制槽 + hot standby + 只读验证 + 复制延迟观测。
> 真正的跨机故障切换 3 步见 `docs/postgres-pitr-ha-runbook.md`。

---

## 0. 架构

```
  primary (:5432)                    standby (:5433, 独立目录)
  ┌──────────────────┐   WAL stream ┌──────────────────┐
  │ llmwiki          │ ───────────► │ hot standby      │
  │ llmwiki_inst2/3  │   slot=      │ 只读查询 / 报表  │
  │ WAL archive      │   standby1   │ (API 不直连)     │
  └──────────────────┘              └──────────────────┘
         │
         └── pg-archive/main/  (PITR 归档, 与流复制互补)
```

- **复制槽 (replication slot)**：保证从库断线期间主库不回收其还需要的 WAL。
- **归档 + 流复制互补**：流复制挂了仍有 WAL 归档可 PITR；归档慢了仍有流复制低延迟。
- **hot_standby=on**：从库恢复期间可跑只读查询（验证、报表、备份导出）。

---

## 1. 前置（主库，一次）

```bash
# 1) 启用 PITR/复制相关 GUC（需 restart archive_mode/wal_level）
sudo -u postgres psql -d postgres -f deploy/postgres/enable-pitr.sql
sudo pg_ctlcluster 16 main restart     # 或 systemctl restart postgresql@16-main

# 2) 归档目录（若尚未建）
sudo mkdir -p /data/pg-archive/main
sudo chown postgres:postgres /data/pg-archive/main

# 3) 复制角色（默认用 postgres，已带 REPLICATION；独立用户时）
sudo -u postgres psql -d postgres <<'SQL'
-- CREATE ROLE replicator REPLICATION LOGIN PASSWORD '<secret>';
-- GRANT CONNECT ON DATABASE llmwiki TO replicator;  -- 仅必要时
SQL
```

`pg_hba.conf` 本机默认已有：

```
local  replication  all                 peer
host   replication  all  127.0.0.1/32  scram-sha-256
```

跨机时为 standby IP 增加一行 `host replication replicator <standby_ip>/32 scram-sha-256`。

---

## 2. 一键搭建从库

```bash
export REPL_PASSWORD='<secret>'    # 若非 peer 认证
sudo bash deploy/postgres/setup-replica.sh \
  --slot standby1 \
  --data-dir /data/pg-standby/standby1 \
  --port 5433
```

脚本动作：

1. `pg_create_physical_replication_slot('standby1')`（幂等）
2. `pg_basebackup -R -X stream -S standby1` → `/data/pg-standby/standby1`
   （`-R` 自动写 `standby.signal` + `primary_conninfo`）
3. 追加 `primary_slot_name` / `port` / `hot_standby`
4. `pg_ctl start`，并打印主从两侧状态

---

## 3. 验证清单（必做）

### 3.1 主库：`pg_stat_replication` 存在且有行

```bash
sudo -u postgres psql -d postgres -c \
  "SELECT application_name, state, sync_state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
          pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes
   FROM pg_stat_replication;"
```

期望：`state=streaming`，`replay_lag_bytes` 在活跃写入下通常 < 数 MB。

### 3.2 从库：处于恢复态且可读

```bash
sudo -u postgres psql -h 127.0.0.1 -p 5433 -d llmwiki -c \
  "SELECT pg_is_in_recovery() AS is_standby,
          pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"
# is_standby = t

sudo -u postgres psql -h 127.0.0.1 -p 5433 -d llmwiki -c \
  "SELECT count(*) FROM \"Document\";"
```

### 3.3 从库只读拒绝写

```bash
sudo -u postgres psql -h 127.0.0.1 -p 5433 -d llmwiki -c \
  "CREATE TABLE ha_write_probe(i int);"
# 期望报错:  cannot execute CREATE TABLE in a read-only transaction
```

### 3.4 复制延迟实测

```bash
# 主库推进一个标记
sudo -u postgres psql -d llmwiki -c \
  "CREATE TABLE IF NOT EXISTS ha_lag_probe(t timestamptz primary key);
   INSERT INTO ha_lag_probe VALUES (now()) ON CONFLICT DO NOTHING;"

# 立刻在从库查询（延迟 = 从库查到的时间 - 主库 now()）
sudo -u postgres psql -h 127.0.0.1 -p 5433 -d llmwiki -c \
  "SELECT t AS primary_commit, now() - t AS replication_delay FROM ha_lag_probe;"
```

---

## 4. 拆除（演练完释放磁盘）

```bash
sudo bash deploy/postgres/setup-replica.sh --teardown \
  --slot standby1 --data-dir /data/pg-standby/standby1
```

会 stop 从库、删数据目录、`pg_drop_replication_slot('standby1')`。

---

## 5. 与 PITR 的分工

| 场景 | 用什么 | RPO | RTO 参考 |
|---|---|---|---|
| 误删表 / 脏数据 / 要回到 5 分钟前 | WAL 归档 PITR | ≤ 5min（archive_timeout=300） | 见 runbook 实测 |
| 主机宕机，需快速接管 | promote 从库 | ≈ 流复制延迟（秒级） | promote + 改连接串 |
| 逻辑损坏且从库已同步损坏 | basebackup + PITR | ≤ 5min | 同 PITR |
| 磁盘整机丢失 | 异地 basebackup + WAL 归档 | 归档上一次同步延迟 | 含拉取异地备份时间 |

---

## 6. 常见坑

1. **忘了复制槽** → 从库长时间断连后 WAL 被回收，只能重做 basebackup。
   监控 `pg_replication_slots.restart_lsn` 与磁盘水位；长期离线的槽要及时 `pg_drop_replication_slot`。
2. **`max_slot_wal_keep_size=-1` 且槽卡死** → 磁盘被 WAL 打满。生产建议设上限（如 50GB）。
3. **archive_command 失败会阻塞 WAL 回收** — 归档脚本必须幂等 + 快 + 失败即非零退出（见 `archive-wal.sh`）。
4. **`ALTER SYSTEM` 的 `archive_mode`/`wal_level` 要 restart 才生效** — `pg_reload_conf()` 不够。
5. **promote 后旧主不能直接再当主** — 旧主恢复后必须以从库身份重建（或 pg_rewind，单机演练不展开）。
