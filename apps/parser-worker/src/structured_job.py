"""Isolated native spreadsheet job; timeout/cancellation kills its process group."""
import json
import os
import resource
import sys
from pathlib import Path

from env_config import env_int
import temp_budget
import structured_excel
from structured_excel import extract

if __name__ == '__main__':
    limit = env_int('PARSER_NATIVE_MEMORY_BYTES', 1536 * 1024 * 1024)
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    resource.setrlimit(resource.RLIMIT_CPU, (240, 245))
    path, output, identity, units, inline_rows = sys.argv[1:]
    structured_excel.INLINE_ROWS = min(501, max(1, int(inline_rows)))
    structured_excel.INLINE_BYTES = min(1024 * 1024, max(structured_excel.INLINE_BYTES, structured_excel.INLINE_ROWS * 2048))
    result = extract(Path(path), identity, json.loads(units))
    payload = json.dumps(result, ensure_ascii=False, allow_nan=False)
    if len(payload.encode()) > env_int('PARSER_NATIVE_RESULT_BYTES', 32 * 1024 * 1024):
        raise ValueError('Parser result exceeds output budget')
    temp_budget.write_text(Path(output), payload, Path(path).parent)
