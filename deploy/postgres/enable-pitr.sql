-- 启用 WAL 归档 / PITR 基础配置 (ROI-5)
-- 用法 (以超级用户, 目标库任意):
--   psql -h 127.0.0.1 -U llmwiki -d postgres -f deploy/postgres/enable-pitr.sql
-- 或:
--   sudo -u postgres psql -d postgres -f enable-pitr.sql
--
-- 生效说明:
--   wal_level / archive_mode / max_*  → 需要 restart (ALTER SYSTEM 后执行
--     SELECT pg_reload_conf() 不够; 请: sudo pg_ctlcluster <ver> <name> restart
--     或 sudo systemctl restart postgresql@<ver>-<name>)
--   archive_command / archive_timeout → reload 即可
--
-- 归档目录需先建好并 chown postgres, 例:
--   sudo mkdir -p /data/pg-archive/main
--   sudo chown postgres:postgres /data/pg-archive/main
-- 包装脚本需安装到 archive_command 里写的路径 (默认 /usr/local/sbin/pg-archive-wal.sh)

-- 1) WAL 级别 (replica: 归档 + 流复制)
ALTER SYSTEM SET wal_level = replica;

-- 2) 归档开关 + 命令 (路径与 deploy/postgres/postgresql-pitr.conf.sample 对齐)
--    如使用自定义 PG_ARCHIVE_DIR, 请同步修改下面的 archive_command, 或改用
--    archive-wal.sh 并通过 postgresql@ 服务环境注入 PG_ARCHIVE_DIR。
ALTER SYSTEM SET archive_mode = on;
ALTER SYSTEM SET archive_command = '/bin/bash /usr/local/sbin/pg-archive-wal.sh %p %f';

-- 3) RPO 上界: 5 分钟强制切 WAL 段 (空闲库也能保证 RPO ≤ 5min)
ALTER SYSTEM SET archive_timeout = 300;

-- 4) 流复制预留 (HA)
ALTER SYSTEM SET max_wal_senders = 10;
ALTER SYSTEM SET max_replication_slots = 4;
ALTER SYSTEM SET wal_keep_size = '256MB';

-- 5) Hot Standby
ALTER SYSTEM SET hot_standby = on;

-- 便于人工核对
SELECT name, setting, pending_restart
FROM pg_settings
WHERE name IN (
  'wal_level', 'archive_mode', 'archive_command', 'archive_timeout',
  'max_wal_senders', 'max_replication_slots', 'wal_keep_size', 'hot_standby'
)
ORDER BY name;

-- 提示: pending_restart = true 的项必须 restart 后生效
\echo 'enable-pitr.sql applied. RESTART PostgreSQL to activate archive_mode/wal_level.'
