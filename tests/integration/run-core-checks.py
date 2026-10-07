"""Run against an explicitly isolated local schema without printing DB credentials."""
import argparse
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--database", default="gbrain_core_opt_test")
parser.add_argument("--unit", action="store_true")
parser.add_argument("--reliability", action="store_true", help="real process loss and application artifact/quota scale checks")
parser.add_argument("--compiler", action="store_true", help="large source scan and compiled truth/graph checks")
args = parser.parse_args()
if not args.database.startswith("gbrain_core_opt_test") or not args.database.replace("_", "").isalnum():
    parser.error("database must be an isolated gbrain_core_opt_test database")
env = os.environ.copy()
for file in (root / ".env", root / "packages/database/.env"):
    if not file.exists():
        continue
    for line in file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            if key.strip() == "DATABASE_URL":
                env.setdefault("DATABASE_URL", value.strip().strip('"').strip("'"))
parts = urlsplit(env["DATABASE_URL"])
url = urlunsplit((parts.scheme, parts.netloc.rsplit("@", 1)[0] + "@127.0.0.1:5433", "/" + args.database, "schema=public", ""))
env.update(DATABASE_URL=url, DATABASE_URL_APP=url, RLS_ENFORCE="0", CORE_AUTH_ENFORCE="0", LLMWIKI_FORCE_MIGRATOR_URL="1", CORE_VERSIONING_ENABLED="0")
def run(command):
    subprocess.run(command, cwd=root, env=env, check=True)
run(["pnpm", "--filter", "api", "build"])
run(["node", "tests/integration/core-knowledge-versions.cjs"])
run(["node", "tests/integration/core-graph-projection.cjs"])
run(["node", "tests/integration/core-ingestion-replacement.cjs"])
run(["node", "tests/integration/core-application-permissions.cjs"])
if args.compiler:
    run(["node", "tests/integration/core-compiler-coverage.cjs"])
if args.reliability:
    env.update(REDIS_HOST="127.0.0.1", REDIS_PORT="6379", REDIS_DB="15")
    run(["node", "tests/integration/core-service-loss.cjs"])
    run(["node", "tests/integration/core-artifact-quota.cjs"])
if args.unit:
    run(["pnpm", "run", "test", "--env-mode=loose", "--force"])
