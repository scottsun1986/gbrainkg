"""Offline 10k/100k spreadsheet resource probe. Never calls production services.

Run from apps/parser-worker with its test interpreter:
  python scripts/benchmark_structured_excel.py --rows 10000 100000 --output /tmp/parser-spreadsheet-resource.json
Generates write-only sources and measures each isolated parse's wall time,
peak child RSS, complete fact count, output bytes, and warm batch reuse.
"""
import argparse
import json
import os
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def child(source, directory, rows):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
    import artifact_cache
    import artifact_store
    import structured_excel
    artifact_store.ROOT = directory / 'artifacts'
    artifact_cache.ROOT = directory / 'cache'
    started = time.monotonic()
    first = structured_excel.extract(source, 'benchmark-inst1')
    cold = time.monotonic() - started
    table = first['structured_tables'][0]
    if not table.get('artifact_id'):
        # Small sheets stay inline by design; there is no streamed artifact to
        # measure. Force the streaming path so the probe always reports the same
        # quantities instead of crashing on a missing artifact id.
        raise RuntimeError(
            'Benchmark table stayed inline; use --rows above the inline preview '
            f'budget ({structured_excel.INLINE_ROWS} rows) to exercise streaming'
        )
    path = artifact_store.resolve(table['artifact_id'], 'benchmark-inst1')
    with path.open('rb') as handle:
        facts = sum(1 for _ in handle)
    started = time.monotonic()
    second = structured_excel.extract(source, 'benchmark-inst1')['structured_tables'][0]
    warm = time.monotonic() - started
    if facts != rows + 1 or table['row_count'] != facts:
        raise RuntimeError('Complete facts differ from source row count')
    print(json.dumps({'source_rows': rows, 'fact_rows_including_header': facts,
        'cold_seconds': round(cold, 3), 'warm_seconds': round(warm, 3),
        'peak_rss_kib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        'artifact_bytes': path.stat().st_size, 'preview_rows': len(table['rows']),
        'reused_batches': second['reused_batches'], 'batch_rows': table['batch_rows'],
        'same_complete_artifact_reused': table['artifact_id'] == second['artifact_id']}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rows', type=int, nargs='+', default=[10000, 100000])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if any(n < 1 or n > 500000 for n in args.rows):
        parser.error('rows must be between 1 and 500000')
    import openpyxl
    results = []
    for rows in args.rows:
        with tempfile.TemporaryDirectory(prefix='parser-benchmark-') as temporary:
            directory = Path(temporary)
            source = directory / 'source.xlsx'
            book = openpyxl.Workbook(write_only=True)
            sheet = book.create_sheet('Facts')
            sheet.append(['Identifier', 'Amount', 'Enabled', 'Ratio'])
            for index in range(rows):
                sheet.append([f'{index:08d}', index % 1000, bool(index % 2), (index % 100) / 100])
            book.save(source)
            book.close()
            command = [sys.executable, str(Path(__file__).resolve()), '_child', str(source), str(directory), str(rows)]
            completed = subprocess.run(command, check=True, capture_output=True, text=True, timeout=600)
            results.append(json.loads(completed.stdout))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'format': 'xlsx', 'runs': results}, indent=2), encoding='utf-8')
    print(json.dumps({'output': str(args.output), 'runs': results}, indent=2))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '_child':
        child(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]))
    else:
        main()
