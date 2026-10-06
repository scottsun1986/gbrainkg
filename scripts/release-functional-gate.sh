#!/usr/bin/env bash
# Functional deployment gate for the selected, explicitly authorized profile.
# Official paired SOTA quality/cost claims require the separate full CI gate.
set -euo pipefail
cd "$(dirname "$0")/.."
export E2E_REQUIRE_ALL=1
python3 scripts/assert-test-target.py "${API_BASE:-http://127.0.0.1:3202}"
[[ -n "${LLMWIKI_TOKEN:-}" ]] || { echo 'FAIL: live authenticated test token required'; exit 1; }
python3 - <<'PY'
import os
from pathlib import Path
flags={'CORE_AUTH_ENFORCE','CORE_VERSIONING_ENABLED','CORE_GRAPH_INCREMENTAL_ENABLED','ADAPTIVE_RETRIEVAL_ENABLED','BGE_M3_HYBRID_ENABLED','BGE_M3_MAXSIM_ENABLED','BGE_M3_LATE_CHUNKING_ENABLED'}
values={}
for p in [Path('apps/api/.env')]:
 for line in p.read_text().splitlines():
  if '=' in line:
   k,v=line.split('=',1); values[k.strip()]=v.strip().strip("\"'")
values.update(os.environ)
active=[k for k in flags if values.get(k) in ('true','1')]
if os.environ.get('RELEASE_GATE_PROFILE')=='quality-first':
 expected={'ALLOW_UNVERSIONED_EMBEDDING_PUBLICATION':'true','RLS_ENFORCE':'1','CORE_AUTH_ENFORCE':'1','CORE_VERSIONING_ENABLED':'1','CORE_GRAPH_INCREMENTAL_ENABLED':'1','ADAPTIVE_RETRIEVAL_ENABLED':'true','RETRIEVAL_QUALITY_PROFILE':'quality-first','BGE_M3_HYBRID_ENABLED':'false','BGE_M3_MAXSIM_ENABLED':'false','BGE_M3_LATE_CHUNKING_ENABLED':'false'}
 if any(values.get(k)!=v for k,v in expected.items()):raise SystemExit('FAIL: local quality-first configuration mismatch')
 import json,urllib.request
 ready=json.load(urllib.request.urlopen(os.environ.get('API_BASE','http://127.0.0.1:3202')+'/ready'));runtime=ready['knowledgeProfile']
 import hashlib
 root=Path('apps/api/dist');identity=hashlib.sha256()
 for file in sorted(root.rglob('*.js')):identity.update(file.relative_to(root).as_posix().encode());identity.update(hashlib.sha256(file.read_bytes()).digest())
 if ready.get('apiReleaseFingerprint')!=identity.hexdigest():raise SystemExit('FAIL: test API is not running the candidate compiled code; restart test API first')
 if runtime.get('profile')!='quality-first' or not all(runtime.get(k) is True for k in ['authorization','immutableVersions','incrementalGraph','adaptiveRetrieval']) or any(runtime.get(k) for k in ['sparse','maxSim','lateChunking']):raise SystemExit('FAIL: running test API does not match the release policy')
 print('PASS: quality-first feature activation matches running API')
elif active: raise SystemExit('FAIL: experimental activation requires full gate: '+', '.join(active))
if os.environ.get('RELEASE_GATE_PROFILE')!='quality-first':print('PASS: additive deployment; experimental flags disabled')
PY
# These checks always run. Fingerprints reuse only expensive live scenarios.
pnpm --filter database exec prisma generate --schema=prisma/schema.prisma
pnpm --filter api exec tsc --noEmit
pnpm --filter api lint
pnpm --filter web exec tsc --noEmit
pnpm --filter web lint
pnpm run test:api
pnpm --filter web test
python3 tests/integration/run-core-checks.py
pnpm run test:parser
pnpm run test:adapter
pnpm run benchmark:selftest
git diff --check
if python3 scripts/release-gate-fingerprint.py check; then
  curl --fail --silent "${API_BASE:-http://127.0.0.1:3202}/ready" >/dev/null
  exit 0
fi
(cd apps/web && npx --yes tsx@4.23.13 __tests__/answer-layout.fixture.tsx /tmp/gbrain-answer-layout.html)
python3 tests/e2e/chat_answer_layout.py
python3 -u tests/e2e/sota_knowledge_base_suite.py
git diff --check
python3 scripts/release-gate-fingerprint.py save
printf '%s\n' 'FUNCTIONAL RELEASE GATE PASSED. SOTA and paired quality/cost improvement are not claimed.'
