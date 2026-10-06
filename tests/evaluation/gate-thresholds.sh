#!/usr/bin/env bash
# Defaults are shared with direct TypeScript gate entrypoints. Explicit overrides
# are preserved; invalid numeric settings fail rather than silently disabling a gate.
threshold_file="$(dirname "${BASH_SOURCE[0]}")/gate-thresholds.json"
threshold_values=$(python3 - "$threshold_file" <<'PYTHON'
import json, math, os, sys
for key, default in json.load(open(sys.argv[1])).items():
    value = os.environ.get(key) or str(default)
    number = float(value)
    if not math.isfinite(number) or number < 0 or (key != 'PROBE_TOLERANCE' and number > 1):
        raise ValueError(f'{key}: invalid threshold')
    if key in ('PROBE_TOLERANCE', 'GATE_STRICT') and not number.is_integer():
        raise ValueError(f'{key}: integer required')
    print(f'{key}\t{value}')
PYTHON
) || return 1
while IFS=$'\t' read -r threshold_key threshold_value; do
  export "$threshold_key=$threshold_value"
done <<< "$threshold_values"
unset threshold_file threshold_values threshold_key threshold_value
