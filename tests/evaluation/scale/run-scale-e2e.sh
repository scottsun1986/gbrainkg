#!/bin/bash
# 100k-scale ingest + retrieval benchmark (dev/test only).
#
#   bash tests/evaluation/scale/run-scale-e2e.sh              # 10k -> 50k -> 100k
#   MAX_CHUNKS=50000 bash tests/evaluation/scale/run-scale-e2e.sh
#   SKIP_INGEST=1 bash tests/evaluation/scale/run-scale-e2e.sh  # reuse schemas
#
# Writes timestamped JSON under tests/evaluation/scale/out/.
# Never touches production (meetings2). Safe to re-run; cleanup via cleanup.sh.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_ROOT"

OUT_DIR="${OUT_DIR:-tests/evaluation/scale/out}"
API_BASE="${API_BASE:-http://127.0.0.1:3202}"
LLMWIKI_USER="${LLMWIKI_USER:-admin}"
LLMWIKI_PASS="${LLMWIKI_PASS:-123456}"
export API_BASE LLMWIKI_USER LLMWIKI_PASS

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
RUN_DIR="$OUT_DIR/run-$STAMP"
mkdir -p "$RUN_DIR"

# Progressive ladder. MAX_CHUNKS caps the ladder (default 100000).
MAX_CHUNKS="${MAX_CHUNKS:-100000}"
LEVELS=()
for n in 10000 50000 100000; do
  if [ "$n" -le "$MAX_CHUNKS" ]; then
    LEVELS+=("$n")
  fi
done

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$RUN_DIR/run.log"; }
snap() {
  {
    echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') $* ==="
    free -h || true
    df -h / || true
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' || true
  } >> "$RUN_DIR/resources.log"
}

schema_for() {
  case "$1" in
    10000) echo "scale_10k" ;;
    50000) echo "scale_50k" ;;
    100000) echo "scale_bench" ;;
    *) echo "scale_n$1" ;;
  esac
}

log "scale e2e start stamp=$STAMP levels=${LEVELS[*]}"
snap start

if [ "${SKIP_INGEST:-0}" != "1" ]; then
  for n in "${LEVELS[@]}"; do
    schema="$(schema_for "$n")"
    seed_out="$RUN_DIR/seed-${n}-${schema}.json"
    log "INGEST n=$n schema=$schema"
    snap "before-seed-$n"
    set +e
    /usr/bin/time -f 'wall_sec=%e max_rss_kb=%M' \
      pnpm --filter api scale:seed -- \
        --schema="$schema" --chunks="$n" --kb-count=40 --out="$seed_out" \
        > "$RUN_DIR/seed-${n}.stdout" 2> "$RUN_DIR/seed-${n}.stderr"
    seed_rc=$?
    set -e
    snap "after-seed-$n"
    log "INGEST done n=$n rc=$seed_rc (see seed-${n}.stdout/.stderr)"
    if [ "$seed_rc" -ne 0 ]; then
      log "INGEST FAILED at n=$n — stopping ladder"
      echo "$n" > "$RUN_DIR/failed_at.txt"
      break
    fi
  done
fi

# Pick the largest successfully seeded schema for retrieval / ANN.
export RUN_DIR
MAX_OK="$(python3 - <<'PY'
import json, os
run_dir = os.environ["RUN_DIR"]
mapping = {10000: "scale_10k", 50000: "scale_50k", 100000: "scale_bench"}
max_ok = 0
for n, schema in mapping.items():
    path = os.path.join(run_dir, f"seed-{n}-{schema}.json")
    if os.path.isfile(path):
        try:
            data = json.load(open(path))
            if int(data.get("consistency", {}).get("chunks") or 0) > 0:
                max_ok = max(max_ok, n)
        except Exception:
            pass
print(max_ok)
PY
)"
if [ "${SKIP_INGEST:-0}" = "1" ] && [ "$MAX_OK" = "0" ]; then
  MAX_OK="$MAX_CHUNKS"
fi
log "max successful N=$MAX_OK"
if [ "$MAX_OK" = "0" ]; then
  log "no successful ingest — aborting"
  exit 1
fi
MAX_SCHEMA="$(schema_for "$MAX_OK")"

log "ANN recall on schema=$MAX_SCHEMA"
set +e
ANN_EVAL_DATABASE_URL="$(node scripts/bench-database-url.cjs "$MAX_SCHEMA")" \
  python3 tests/evaluation/intl-benchmark/ann_recall_eval.py \
    --database-url "$(node scripts/bench-database-url.cjs "$MAX_SCHEMA")" \
    --schema "$MAX_SCHEMA" \
    --limit "${QUERIES:-60}" --k 10 \
    --ef-search 40 100 200 \
    --iterative-scan off relaxed_order \
    --out "$RUN_DIR/ann-recall-${MAX_OK}.json" \
    > "$RUN_DIR/ann-recall.stdout" 2> "$RUN_DIR/ann-recall.stderr"
ann_rc=$?
set -e
log "ANN recall rc=$ann_rc"

log "pure-vector load on schema=$MAX_SCHEMA"
for c in 1 10 50; do
  reqs=50
  if [ "$c" = "1" ]; then reqs=30; fi
  snap "before-vector-c$c"
  set +e
  python3 tests/evaluation/scale/vector_load.py \
    --schema "$MAX_SCHEMA" --concurrency "$c" --requests "$reqs" \
    --output "$RUN_DIR/vector-load-c${c}.json" \
    > "$RUN_DIR/vector-load-c${c}.stdout" 2> "$RUN_DIR/vector-load-c${c}.stderr"
  set -e
  snap "after-vector-c$c"
done

log "promote corpus to public KB scale-bench-100k"
set +e
python3 tests/evaluation/scale/promote_to_public.py \
  --from-schema "$MAX_SCHEMA" --kb-name scale-bench-100k \
  --out "$RUN_DIR/promote.json" \
  > "$RUN_DIR/promote.stdout" 2> "$RUN_DIR/promote.stderr"
promote_rc=$?
set -e
log "promote rc=$promote_rc"

KB_ID="$(python3 - <<'PY'
import json, os
path = os.path.join(os.environ["RUN_DIR"], "promote.json")
print(json.load(open(path)).get("kb_id", "") if os.path.isfile(path) else "")
PY
)"
export KB_ID
KB_ID="$(python3 -c 'import json,os;print(json.load(open(os.path.join(os.environ["RUN_DIR"],"promote.json"))).get("kb_id",""))')"
log "kb_id=$KB_ID"

if [ -n "$KB_ID" ]; then
  log "hybrid+rerank API load (chat/search)"
  for c in 1 10 50; do
    reqs=30
    if [ "$c" = "50" ]; then reqs=50; fi
    snap "before-hybrid-c$c"
    set +e
    LLMWIKI_USER="$LLMWIKI_USER" LLMWIKI_PASS="$LLMWIKI_PASS" \
      python3 tests/evaluation/intl-benchmark/load_test.py \
        --api-base "$API_BASE" \
        --user "$LLMWIKI_USER" --password "$LLMWIKI_PASS" \
        --kb-id "$KB_ID" --endpoint search \
        --concurrency "$c" --requests "$reqs" \
        --output "$RUN_DIR/hybrid-load-c${c}.json" \
        > "$RUN_DIR/hybrid-load-c${c}.stdout" 2> "$RUN_DIR/hybrid-load-c${c}.stderr"
    set -e
    snap "after-hybrid-c$c"
  done

  # Pure vector at API-visible KB (same kb filter as production vector arm).
  for c in 1 10 50; do
    reqs=50
    set +e
    python3 tests/evaluation/scale/vector_load.py \
      --schema public --kb "$KB_ID" --concurrency "$c" --requests "$reqs" \
      --output "$RUN_DIR/vector-load-public-c${c}.json" \
      > "$RUN_DIR/vector-load-public-c${c}.stdout" 2> "$RUN_DIR/vector-load-public-c${c}.stderr"
    set -e
  done
fi

log "EXPLAIN ANALYZE hot SQL"
set +e
python3 tests/evaluation/scale/hot_sql_explain.py \
  --schema "$MAX_SCHEMA" --k 10 --ef-search 100 \
  --out "$RUN_DIR/hot-sql.json" \
  > "$RUN_DIR/hot-sql.stdout" 2> "$RUN_DIR/hot-sql.stderr"
set -e

snap end
log "scale e2e complete dir=$RUN_DIR"
echo "$RUN_DIR"
