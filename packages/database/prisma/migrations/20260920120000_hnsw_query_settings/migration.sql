-- 20260920120000_hnsw_query_settings
--
-- Filtered HNSW recall settings must live with the database, not in a manual
-- operator note. pgvector applies the WHERE filter *after* the graph scan, so a
-- selective permission filter (1 of N knowledge bases) returns far fewer than k
-- neighbours unless `hnsw.iterative_scan` is on and `hnsw.ef_search` is raised.
--
-- Measured on 100k chunks with a 2.5% filter selectivity (exact KNN as gold,
-- see tests/evaluation/intl-benchmark/reports/ann-recall-100k-chunks.json):
--   ef_search=40,  iterative_scan=off          -> Recall@10 0.2067 (100% short results)
--   ef_search=100, iterative_scan=off          -> Recall@10 0.4450
--   ef_search=200, iterative_scan=off          -> Recall@10 1.0000
--   ef_search=200, iterative_scan=relaxed_order-> Recall@10 1.0000 (p50 21ms)
--
-- Without this migration every freshly provisioned instance database
-- (llmwiki_instN) silently fell back to the pgvector defaults (ef_search=40,
-- iterative_scan=off), i.e. the worst row of the table above.
--
-- ALTER DATABASE requires ownership of the database, which the deployment role
-- holds (provision-instance.sh creates each database with OWNER llmwiki). The
-- dotted `hnsw.*` names are valid custom placeholders even before the extension
-- is loaded, so this migration is safe to run before the vector extension is
-- created in a brand new database.

DO $$
DECLARE
  target_db text := current_database();
BEGIN
  EXECUTE format('ALTER DATABASE %I SET hnsw.ef_search = %s', target_db, 200);
  EXECUTE format('ALTER DATABASE %I SET hnsw.iterative_scan = %L', target_db, 'relaxed_order');
  -- Bound the extra graph scan so a pathological filter cannot scan forever.
  EXECUTE format('ALTER DATABASE %I SET hnsw.max_scan_tuples = %s', target_db, 20000);
  RAISE NOTICE 'HNSW query settings applied to database %', target_db;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING
      'Could not ALTER DATABASE % (insufficient privilege). Filtered HNSW recall will stay at pgvector defaults until an operator runs: ALTER DATABASE %I SET hnsw.ef_search = 200; ALTER DATABASE %I SET hnsw.iterative_scan = ''relaxed_order'';',
      target_db, target_db, target_db;
END $$;
