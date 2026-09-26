# PostgreSQL PITR 与 HA 运维 Runbook（ROI-5）

> **范围**：WAL 归档 PITR（RPO ≤ 5 分钟）+ 单机可验证的流复制 HA 基础 + 故障切换 3 步。
> **环境**：生产 `meetings2`，PostgreSQL 16（Debian cluster `16/main`，`:5432`），
> 库 `llmwiki` / `llmwiki_inst2` / `llmwiki_inst3`。
>
> **安全铁律**
> - 演练只写独立目录（`/data/pg-drill/...`）或 `*_drill` 库名，**绝不覆盖生产 data directory**
>   （`/var/lib/postgresql/16/main`）——除非 `--force-production` 且
>   `FORCE_PRODUCTION_RESTORE=YES_I_MEAN_IT` 二次确认。
> - **严禁**未授权 `deploy-prod`、DROP 生产库、重启生产 API。
> - 仅开启 WAL 归档 / pg_basebackup / 独立目录恢复演练在授权范围内。

---

## 0. 术语与目标

| 指标 | 定义 | 本方案目标 |
|---|---|---|
| **RPO**（Recovery Point Objective） | 灾难时刻与「可恢复的最后一致状态」之间可能丢失的数据窗口 | **≤ 5 分钟**（连续 WAL 归档 + `archive_timeout=300`） |
| **RTO**（Recovery Time Objective） | 从决定恢复到服务可用的耗时 | 见 §5 实测；测量方法固定如下 |

### RTO 测量方法（标准化，可复现）

```
T0 = 运维宣布「开始恢复」/ 执行 restore-pitr.sh 的时刻
T1 = 恢复实例可接受连接且验证 SQL 返回的时刻
RTO = T1 - T0
```

脚本 `deploy/restore-pitr.sh` 打印的 `RTO (restore)` 覆盖：解压 basebackup → 写恢复配置 →
replay WAL 到目标点 → 启动 → 验证 SQL。人工切换的「决策时间」与「改连接串时间」另计（见 §6）。

### RPO 测量方法

- **PITR 到指定时间点**：`RPO = 灾难时刻 − recovery_target_time`（目标点取灾难前最后一笔完好提交）。
- **恢复到归档末尾**：`RPO = 灾难时刻 − 已归档的最后提交`；上界由 `archive_timeout=300` 保证
  （空闲库也会每 5 分钟强制切段归档），活跃库通常为秒级。
- 演练验证方式：basebackup 后写入 marker 行 A，再写 marker 行 B，恢复到 A/B 之间 →
  **A 必须在、B 必须不在**（证明真正按时间点截断，而非「恢复到最新」）。

---

## 1. 组件与文件

| 文件 | 作用 |
|---|---|
| `deploy/postgres/postgresql-pitr.conf.sample` | PITR/复制 GUC 样例（可放 `/etc/postgresql/16/main/conf.d/pitr.conf`） |
| `deploy/postgres/enable-pitr.sql` | `ALTER SYSTEM` 一键开启 WAL 归档/复制预留 |
| `deploy/postgres/archive-wal.sh` | `archive_command` 包装（幂等、原子 mv、支持 `PG_ARCHIVE_DIR`） |
| `deploy/postgres/restore-wal.sh` | `restore_command` 包装 |
| `deploy/postgres/recovery.conf.sample` | PG16 恢复配置样例（`postgresql.auto.conf` + `recovery.signal`） |
| `deploy/postgres/setup-replica.sh` | 复制槽 + `pg_basebackup -R` 搭 hot standby |
| `deploy/postgres/streaming-replica.md` | 流复制验证清单 |
| `deploy/postgres/promote-standby.sh` | 故障切换第 2 步：promote |
| `scripts/pg-pitr-backup.sh` | `pg_basebackup` + manifest + 保留 N 份 |
| `deploy/restore-pitr.sh` | basebackup + WAL → 独立目录（+可选临时实例 / `*_drill` 库） |
| `deploy/backup.sh --basebackup` | dump **与** basebackup 并存的备份入口 |
| `deploy/backup-retention.sh` | 统一 retention：dump / basebackup / WAL archive |

目录约定（生产 meetings2）：

```
/data/pg-archive/main/        # WAL 归档 (PG_ARCHIVE_DIR)
/data/pg-backup/              # pg_basebackup 产物 (PITR_BACKUP_ROOT)
/data/pg-drill/pitr-<STAMP>/  # PITR 演练独立 data directory
/data/pg-standby/standby1/    # 流复制从库 data directory (演练用)
```

---

## 2. 启用 WAL 归档（一次性）

```bash
# 1) 装包装脚本
sudo install -m 0755 deploy/postgres/archive-wal.sh   /usr/local/sbin/pg-archive-wal.sh
sudo install -m 0755 deploy/postgres/restore-wal.sh   /usr/local/sbin/pg-archive-wal.sh.restore

# 2) 归档目录
sudo mkdir -p /data/pg-archive/main /data/pg-backup /data/pg-drill
sudo chown postgres:postgres /data/pg-archive/main
sudo chown ubuntu:ubuntu /data/pg-backup /data/pg-drill   # 按执行账号调整

# 3) 打开 GUC（ALTER SYSTEM → postgresql.auto.conf）
sudo -u postgres psql -d postgres -f deploy/postgres/enable-pitr.sql

# 4) restart（archive_mode / wal_level 必须 restart；不是重启 API）
sudo pg_ctlcluster 16 main restart
#    预期中断：秒级；三实例 API 连接会自动重连。禁止在业务高峰执行。

# 5) 验证
sudo -u postgres psql -c "SHOW archive_mode; SHOW archive_command; SHOW archive_timeout;"
sudo -u postgres psql -c "SELECT pg_switch_wal();"   # 手动切段
ls -l /data/pg-archive/main/                          # 应很快出现新 WAL 段
```

**RPO ≤ 5 分钟的依据**：`archive_timeout=300` 强制每 5 分钟切 WAL 并归档；
即使业务空闲，丢失窗口也不超过 5 分钟。活跃负载下归档延迟通常 < 数秒。

---

## 3. 基础备份（PITR 基线）

```bash
# 常规（dump + 可选物理备份并存）
bash deploy/backup.sh --basebackup

# 仅物理备份（PITR 基线，跳过逻辑 dump）
bash deploy/backup.sh --basebackup-only
# 或专用脚本（manifest + 保留 N 份）
sudo bash scripts/pg-pitr-backup.sh --format=tar
```

建议节奏：

| 产物 | 频率 | 保留 | 用途 |
|---|---|---|---|
| `db-*.dump` | 每日 | 7 份 | 单库逻辑恢复、跨版本迁移 |
| `basebackup-*` | 每日（或每周） | 3 份 | PITR 基线 / 整集群恢复 / 从库搭建 |
| WAL archive | 连续 | ≥ 7 天，且 ≥ 最旧 basebackup 之后全部 | PITR 增量 |
| `files-*.tar.gz` | 每日 | 7 份 | 上传原件 / brain_repos |

retention 统一入口：`bash deploy/backup-retention.sh`
（同时管 dump、basebackup、archive；archive 删除前检查最旧 basebackup 保护下界）。

---

## 4. PITR 恢复（演练 / 真实灾难）

```bash
# 计划（不落地）
sudo bash deploy/restore-pitr.sh \
  --base /data/pg-backup/basebackup-<STAMP> \
  --archive /data/pg-archive/main \
  --target-dir /data/pg-drill/pitr-<STAMP> \
  --target-time '2026-09-23 22:00:00+08' \
  --start-port 55432 --drill-db llmwiki_pitr_drill \
  --dry-run

# 真实执行（独立目录 + 临时实例 + 改名 llmwiki_pitr_drill）
sudo bash deploy/restore-pitr.sh \
  --base /data/pg-backup/basebackup-<STAMP> \
  --archive /data/pg-archive/main \
  --target-time '<灾难前时刻>' \
  --start-port 55432 --drill-db llmwiki_pitr_drill
```

脚本内置：

1. **拒绝**写生产 data directory（除非 `--force-production` +
   `FORCE_PRODUCTION_RESTORE=YES_I_MEAN_IT` + 交互输入 `OVERWRITE-PRODUCTION-DATA`）。
2. 拒绝 `llmwiki` / `llmwiki_inst*` 作为 drill 库名。
3. 写 `restore_command` + `recovery_target_*` + `recovery.signal`（PG16 无 recovery.conf）。
4. 可选启动临时实例、把 `llmwiki` 改名为 `llmwiki_pitr_drill`、跑验证 SQL、输出 RPO/RTO。

恢复后人工核对：

```sql
SELECT pg_is_in_recovery();                  -- f = 已 promote
SELECT count(*) FROM "Document";
SELECT max("updatedAt") FROM "Document";     -- 与 recovery_target_time 对齐
```

---

## 5. 演练记录（真实 PITR）

### 5.1 dump 路径（restore-drill.sh）— 2026-09-22

| 项 | 值 |
|---|---|
| 目标库 | `llmwiki_drill` |
| RPO（备份新鲜度） | **45s** |
| RTO（create + pg_restore + verify） | **377s** |
| 来源 | `deploy/restore-drill.md` 已有记录 |

### 5.2 PITR 路径（restore-pitr.sh）— 2026-09-23（meetings2，真实演练）

| 项 | 值 |
|---|---|
| 日期 | 2026-09-23 22:53–22:55 CST |
| basebackup | `/data/pg-backup/basebackup-20260923-225312`（8s） |
| 目标 | `llmwiki_pitr_drill`（`/data/pg-drill/pitr-20260923-drill`，端口 55432） |
| recovery_target | `2026-09-23 22:53:46+08`（marker A/B 之间） |
| **RPO** | 点恢复精度 ≈ **1.2s**；生产上界 **≤ 5min**（`archive_timeout=300`） |
| **RTO** | **≈ 9.5s**（extract 1.5G + replay + promote + verify） |
| 证据 | A 在 / B 不在；users=10 kbs=26 docs=10703 chunks=13996 与演练前一致 |

详见 §9.1 演练纪要。

---

## 6. 故障切换 3 步（HA）

> 前置：至少一个流复制从库在线（`deploy/postgres/setup-replica.sh`，
> 验证清单见 `deploy/postgres/streaming-replica.md`）。

### 步骤 1 — 检测（≤ 60s 内判定）

```bash
# a) 主库进程/端口
ss -lntp | grep 5432
systemctl status postgresql@16-main

# b) 健康探针（API 依赖）
curl -sf http://127.0.0.1:3000/api/health || echo API_DOWN

# c) 主从延迟 / 复制状态
sudo -u postgres psql -d postgres -c \
  "SELECT application_name, state, replay_lsn,
          pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag
   FROM pg_stat_replication;"
```

判定：主库不可写 **且** 从库 `pg_is_in_recovery()=t` 且 `replay_lsn` 接近主库最后 LSN
→ 进入步骤 2。若从库延迟过大，先确认归档里还有可补的 WAL（`/data/pg-archive/main`）。

### 步骤 2 — promote 从库

```bash
sudo bash deploy/postgres/promote-standby.sh \
  --data-dir /data/pg-standby/standby1 --port 5433
```

等价手工：

```bash
sudo -u postgres /usr/lib/postgresql/16/bin/pg_ctl -D /data/pg-standby/standby1 promote
sudo -u postgres psql -h 127.0.0.1 -p 5433 -d postgres \
  -c "SELECT NOT pg_is_in_recovery() AS is_primary;"
```

### 步骤 3 — 改连接串并验证 API

```bash
# 1) 改三实例 DATABASE_URL / GBRAIN_DATABASE_URL 的 host:port → 新主
#    (systemd 环境文件 或 /home/ubuntu/gbrainkg*/.env; 由 deploy-prod.sh 管理的路径)
# 2) 重启 API 进程使连接串生效 (这是「改连接串后的应用重载」, 非本次授权范围的生产发布)
#    systemctl --user restart llmwiki-api llmwiki-web   # 按实例
# 3) 验证
curl -sf http://127.0.0.1:3000/api/health
curl -sf http://127.0.0.1:3002/api/health
curl -sf http://127.0.0.1:3003/api/health   # 以实际端口为准
```

旧主恢复后：`setup-replica.sh --teardown && setup-replica.sh` 重建为从库
（或 pg_rewind，超出本 runbook 单机验证范围）。

### 目标 RPO / RTO

| 场景 | RPO | RTO 目标 | 验证方式 |
|---|---|---|---|
| 逻辑损坏 / 误删（PITR） | ≤ 5 min | 实测脚本 RTO + 10min 人工 | §5 演练 |
| 主机宕机（promote 从库） | ≈ 复制延迟（秒级） | ≤ 15 min（含改连接串） | §6 三步演练 |
| 整机丢失（异地备份） | 归档上次同步 | ≤ 4 h（含取回） | 含 offsite 的 DR 演练 |

---

## 7. 监控与告警建议

- `pg_stat_replication` 行数为 0（有从库却无流）→ 告警
- `replay_lag_bytes` > 64MB 或 `replay_lag` > 60s → 告警
- 彘归档目录最新段 mtime 距今 > 10min（活跃库）→ 告警
- `/data` 磁盘 > 80% → 告警（WAL + basebackup 都在这）
- 最新 basebackup 年龄 > 26h → 告警
- `pg_replication_slots` 中 `active=false` 且 `restart_lsn` 过旧 → 告警（槽卡死会吃磁盘）

（接现有 `deploy/monitoring/gbrainkg-alerts.yml`，本任务不改动该文件。）

---

## 8. 常见故障速查

| 症状 | 处理 |
|---|---|
| `archive_command` 失败，WAL 堆积 | 查 `/var/log/postgresql/postgresql-16-main.log`；`archive-wal.sh` 幂等可重试；磁盘满先清过期 basebackup |
| PITR 停在半路「找不到 WAL 段」 | 归档缺口：只能恢复到缺口前；检查 retention 是否误删、offsite 是否可拉回 |
| promote 后应用仍连旧主 | 步骤 3 未做；核对三实例 `DATABASE_URL` |
| 从库 `FATAL: could not start streaming` | `pg_hba.conf` replication 行、密码、复制槽是否还在 |
| 演练误指生产 data directory | 脚本会拒绝；若已 `--force-production` 误操作，立刻停机走异地 basebackup + WAL |

---

## 9. 验收记录（ROI-5）

- [x] 所有脚本 `bash -n` 通过
- [x] meetings2 开启 WAL 归档（`archive_mode=on`，段落入 `/data/pg-archive/main`）
- [x] `pg_basebackup` 一次验证成功（`basebackup-20260923-225312`，8s，manifest 齐全）
- [x] 真实 PITR 演练到 `llmwiki_pitr_drill`（见 §5.2 / §9.1）
- [x] 真起流复制从库 `standby1`：`state=streaming`，`replay_lag_bytes=0`，只读拒绝写，复制延迟 ≈ 1s（含 1s 采样间隔）
- [x] 三实例 API 无影响（`/ready` 全程 200/200/200）

### 9.1 PITR 演练纪要（2026-09-23 22:53–22:55 CST，meetings2）

| 项 | 值 |
|---|---|
| basebackup | `/data/pg-backup/basebackup-20260923-225312`（完成 22:53:20） |
| marker A | `pitr_probe.markers` id=A @ `2026-09-23 22:53:45.016896+08` |
| marker B | id=B @ `2026-09-23 22:53:47.161664+08` |
| recovery_target_time | `2026-09-23 22:53:46+08`（A/B 中点） |
| 恢复日志证据 | `recovery stopping before commit of transaction … time 22:53:47.162`（**B 截断**）/ `last completed transaction … 22:53:45.017`（**A 保留**） |
| 验证 | markers **仅 A**；`llmwiki_pitr_drill`：users=10 kbs=26 docs=10703 chunks=13996 |
| **RTO** | **≈ 9.5s**（22:55:08 → 22:55:17.5 ready） |
| **RPO** | 点恢复 ≈ **1.2s**；生产上界 **≤ 5min** |
| 数据目录 | `/data/pg-drill/pitr-20260923-drill`（独立目录，未碰生产 datadir） |

**RTO 测量方法**：`T0 = restore-pitr.sh 开始`，`T1 = 恢复实例 ready / 验证 SQL 返回`，`RTO = T1 − T0`。

### 9.2 流复制验证（2026-09-23，standby1 :5433）

```
 application_name |   state   | replay_lag_bytes
 standby1         | streaming |                0
 is_standby = t
 CREATE TABLE → ERROR: cannot execute CREATE TABLE in a read-only transaction
 replication_delay ≈ 1.0s（含 1s 人为采样间隔；链路本身亚秒）
```

注意（Debian 布局）：`pg_basebackup` 不含 `/etc/postgresql/**/postgresql.conf`。
`restore-pitr.sh` 已自动生成最小 conf；从库需补 conf 且 `max_connections` ≥ 主库（本次踩坑：50&lt;100 被拒）。
