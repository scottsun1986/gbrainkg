#!/usr/bin/env bash
# Incrementally sync lightweight runtime peers in the existing shared Parser venv.
# Do not reinstall the full lock (which also contains development tools/models).
set -euo pipefail

parser_repo="${1:-/home/ubuntu/gbrainkg}"
parser_python="${2:-$parser_repo/.venv/bin/python}"
parser_lock="$parser_repo/apps/parser-worker/requirements.lock.txt"
[[ -x "$parser_python" ]] || { echo 'ERROR: shared parser virtualenv missing' >&2; exit 1; }
[[ -f "$parser_lock" ]] || { echo 'ERROR: shared parser requirements lock missing' >&2; exit 1; }

# soffice alone may exist with Writer but without the Impress conversion filter.
# Installation is a separate operator step: apt unpacking consumes root disk even
# when its archive cache is moved to /data. Fail before mutating the virtualenv.
impress_installed=false
for impress_package in libreoffice-impress-nogui libreoffice-impress; do
  if [[ "$(dpkg-query -W -f='${Status}' "$impress_package" 2>/dev/null || true)" == 'install ok installed' ]]; then
    impress_installed=true
    break
  fi
done
if ! command -v soffice >/dev/null || [[ "$impress_installed" != true ]]; then
  echo 'ERROR: shared parser requires soffice and Impress (libreoffice-impress-nogui or libreoffice-impress); provision the matching headless/GUI package after checking root disk capacity.' >&2
  exit 1
fi

mountpoint -q /data || { echo 'ERROR: /data must be mounted for parser dependency staging' >&2; exit 1; }
parser_stage=$(mktemp -d /data/gbrain-parser-deps.XXXXXX)
trap 'rm -rf "$parser_stage"' EXIT
export TMPDIR="$parser_stage"

"$parser_python" - "$parser_lock" <<'PY'
import importlib.metadata
from pathlib import Path
import subprocess
import sys

from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.utils import canonicalize_name

peers = {"numpy", "pymupdf", "pillow"}
missing = []
selected = set()
for raw in Path(sys.argv[1]).read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    requirement = Requirement(line)
    name = canonicalize_name(requirement.name)
    if name not in peers or (requirement.marker and not requirement.marker.evaluate()):
        continue
    selected.add(name)
    try:
        installed = importlib.metadata.version(requirement.name)
    except importlib.metadata.PackageNotFoundError:
        installed = None
    if installed is None or installed not in requirement.specifier:
        missing.append(line)
# Older rollback locks may not yet declare every new peer; honor their own lock.
if "numpy" not in selected:
    raise SystemExit("ERROR: parser lock has no applicable numpy pin")
if missing:
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--no-cache-dir", *missing],
        check=True,
    )
for name in selected:
    print(f"Shared parser dependency: {name}=={importlib.metadata.version(name)}")
PY
