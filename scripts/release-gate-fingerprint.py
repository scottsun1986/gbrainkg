"""Bind reusable functional gate results to release sources, artifacts and test config."""
import hashlib,json,subprocess,sys,time,os
from pathlib import Path
root=Path(__file__).resolve().parents[1]
source_files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).decode().split('\0')
files={root/name for name in source_files if name and name.startswith(('apps/','packages/','scripts/','tests/')) and '/node_modules/' not in name and '/results/' not in name and '/out/' not in name and '__pycache__' not in name}
files.update(root/name for name in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','turbo.json','apps/api/.env'] if (root/name).is_file())
for directory in ['apps/api/dist','packages/gbrain-adapter/dist','apps/web/.next/server','apps/web/.next/static']:
 files.update(p for p in (root/directory).rglob('*') if p.is_file())
files.add(root/'apps/web/.next/BUILD_ID')
h=hashlib.sha256()
h.update(json.dumps({k:os.environ.get(k) for k in ["RELEASE_GATE_PROFILE","API_BASE","TEST_KB_NAME","TEST_CONFLICT_KB_NAME","PERF_BUDGET_S"]},sort_keys=True).encode())
for p in sorted(files):
 if p.is_file():h.update(str(p.relative_to(root)).encode());h.update(hashlib.sha256(p.read_bytes()).digest())
fingerprint=h.hexdigest()
record=root/'runtime/baseline-release-gate.json'
if sys.argv[1]=='check':
 try:
  data=json.loads(record.read_text());assert data['fingerprint']==fingerprint and 0<=time.time()-data['passedAt']<3600
 except (OSError,ValueError,KeyError,AssertionError):sys.exit(1)
 print('PASS: reusing functional gate for identical sources/artifacts/config within one hour:',fingerprint)
elif sys.argv[1]=='save':
 record.parent.mkdir(exist_ok=True);record.write_text(json.dumps({'fingerprint':fingerprint,'passedAt':time.time()}));record.chmod(0o600);print('Saved release gate artifact fingerprint:',fingerprint)
else:raise SystemExit('check or save required')
