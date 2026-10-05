"""Fail-closed validation for artifacts produced by one isolated SOTA gate run."""
import json
import math
import os
import sys
from pathlib import Path


def unit_score(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError('missing or invalid score')
    return value


def validate_no_answer(run, dataset, maximum):
    expected = [case['id'] for case in dataset if 'GS-NA' in case['id']]
    rows = run.get('results', [])
    overall = run.get('summary', {}).get('overall', {})
    if not expected or sorted(row.get('id', '') for row in rows) != sorted(expected):
        raise ValueError('no-answer case IDs differ from the complete dataset')
    if run.get('dry_run') or any(row.get('dry_run') or row.get('failure') or row.get('corpus_absent') for row in rows):
        raise ValueError('no-answer run contains dry-run, API failure or absent corpus')
    if overall.get('count') != len(expected) or overall.get('api_failure_count') != 0:
        raise ValueError('no-answer count/API failure summary invalid')
    if any(not isinstance(row.get('hallucination'), bool) for row in rows):
        raise ValueError('no-answer rows lack hallucination judgments')
    rate = sum(row['hallucination'] for row in rows) / len(rows)
    if abs(unit_score(overall.get('hallucination_rate')) - rate) > 1e-8:
        raise ValueError('no-answer aggregate disagrees with rows')
    if rate > unit_score(maximum):
        raise ValueError(f'no-answer hallucination rate {rate:.3f} exceeds {maximum}')
    return len(rows), rate


def validate_probe(run, dataset, floor, tolerance, expected_qids=None):
    if run.get('dataset') != dataset or run.get('mode') != 'full' or run.get('n') != floor['cases']:
        raise ValueError(f'{dataset}: wrong dataset/mode/sample count')
    qa = run.get('qa') or {}
    rows = run.get('detail_qa') or []
    if len(rows) != floor['cases'] or qa.get('api_errors') != 0 or run.get('retrieval_api_errors') != 0 or any(row.get('error') for row in rows):
        raise ValueError(f'{dataset}: incomplete probe or API failures')
    retrieval_rows = run.get('detail_retrieval') or []
    def query_ids(detail):
        ids = [row.get('qid') for row in detail]
        if len(ids) != floor['cases'] or any(not isinstance(qid, str) or not qid.strip() for qid in ids) or len(set(ids)) != len(ids):
            raise ValueError(f'{dataset}: incomplete/duplicate/empty query IDs')
        if any(row.get('error') for row in detail):
            raise ValueError(f'{dataset}: detailed API failure')
        return set(ids)
    qa_ids, retrieval_ids = query_ids(rows), query_ids(retrieval_rows)
    if qa_ids != retrieval_ids or (expected_qids is not None and qa_ids != set(expected_qids)):
        raise ValueError(f'{dataset}: QA/retrieval/source query IDs disagree')
    containment = unit_score(qa.get('containment'))
    mean = sum(unit_score(row.get('containment')) for row in rows) / len(rows)
    if abs(containment - mean) > 0.0001:
        raise ValueError(f'{dataset}: aggregate disagrees with rows')
    passed = round(containment * run['n'])
    if passed < floor['probe_passed'] - tolerance:
        raise ValueError(f'{dataset}: {passed} passes below floor')
    return passed


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] != 'no-answer':
        raise SystemExit('usage: sota_gate_results.py no-answer RESULT DATASET')
    count, rate = validate_no_answer(json.loads(Path(sys.argv[2]).read_text()),
                                     json.loads(Path(sys.argv[3]).read_text()),
                                     float(os.environ.get('GATE_NO_ANSWER_HALLUCINATION_MAX', '0.01')))
    print(f'  ✓ no-answer: {count} cases, hallucination rate {rate:.3f}')
