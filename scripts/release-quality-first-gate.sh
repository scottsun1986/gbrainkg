#!/usr/bin/env bash
set -euo pipefail
export RELEASE_GATE_PROFILE=quality-first
exec bash "$(dirname "$0")/release-functional-gate.sh"
