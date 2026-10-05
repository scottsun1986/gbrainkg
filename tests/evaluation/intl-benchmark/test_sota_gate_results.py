"""Offline regressions for SOTA gate validity and shell orchestration."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from sota_gate_results import validate_no_answer, validate_probe

BASE = Path(__file__).resolve().parent


class ArtifactValidityTests(unittest.TestCase):
    def setUp(self):
        self.dataset = [{'id': 'GS-NA-001'}, {'id': 'GS-NA-002'}]
        self.run = {'results': [{'id': c['id'], 'hallucination': False} for c in self.dataset],
                    'summary': {'overall': {'count': 2, 'api_failure_count': 0, 'hallucination_rate': 0}}}
        self.probe = {'dataset': 'hotpot', 'mode': 'full', 'n': 2, 'retrieval_api_errors': 0,
                      'qa': {'api_errors': 0, 'containment': 0.5},
                      'detail_qa': [{'qid': 'q1', 'containment': 1}, {'qid': 'q2', 'containment': 0}],
                      'detail_retrieval': [{'qid': 'q1'}, {'qid': 'q2'}]}

    def test_valid_artifacts(self):
        self.assertEqual(validate_no_answer(self.run, self.dataset, 0.01), (2, 0))
        self.assertEqual(validate_probe(self.probe, 'hotpot', {'cases': 2, 'probe_passed': 1}, 0), 1)

    def test_partial_duplicate_and_environment_cases_rejected(self):
        for mutation in ('partial', 'duplicate', 'failure', 'dry_run', 'corpus_absent'):
            run = copy.deepcopy(self.run)
            if mutation == 'partial':
                run['results'].pop()
            elif mutation == 'duplicate':
                run['results'][1]['id'] = run['results'][0]['id']
            else:
                run['results'][0][mutation] = True
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate_no_answer(run, self.dataset, 0.01)

    def test_unmeasured_and_nonfinite_scores_rejected(self):
        for value in (None, float('nan'), float('inf'), -1, 1.1, True):
            run = copy.deepcopy(self.run)
            run['summary']['overall']['hallucination_rate'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_no_answer(run, self.dataset, 0.01)

    def test_probe_wrong_count_or_errors_rejected(self):
        for key, value in (('n', 100), ('dataset', '2wiki'), ('mode', 'retrieval'), ('retrieval_api_errors', 1)):
            run = copy.deepcopy(self.probe)
            run[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_probe(run, 'hotpot', {'cases': 2, 'probe_passed': 1}, 0)
        run = copy.deepcopy(self.probe)
        run['qa']['api_errors'] = 1
        with self.assertRaises(ValueError):
            validate_probe(run, 'hotpot', {'cases': 2, 'probe_passed': 1}, 0)

    def test_probe_query_identity_must_be_complete_and_match(self):
        for mutation in ('duplicate', 'empty', 'missing_retrieval', 'different_retrieval', 'detail_error'):
            run = copy.deepcopy(self.probe)
            if mutation == 'duplicate':
                run['detail_qa'][1]['qid'] = 'q1'
            elif mutation == 'empty':
                run['detail_qa'][0]['qid'] = ' '
            elif mutation == 'missing_retrieval':
                run.pop('detail_retrieval')
            elif mutation == 'different_retrieval':
                run['detail_retrieval'][0]['qid'] = 'q3'
            else:
                run['detail_retrieval'][0]['error'] = 'HTTP 401'
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate_probe(run, 'hotpot', {'cases': 2, 'probe_passed': 1}, 0)
        with self.assertRaises(ValueError):
            validate_probe(self.probe, 'hotpot', {'cases': 2, 'probe_passed': 1}, 0, ['other', 'queries'])

    def test_aggregate_cannot_hide_bad_rows(self):
        self.run['results'][0]['hallucination'] = True
        with self.assertRaises(ValueError):
            validate_no_answer(self.run, self.dataset, 0.01)
        self.probe['qa']['containment'] = 1
        with self.assertRaises(ValueError):
            validate_probe(self.probe, 'hotpot', {'cases': 2, 'probe_passed': 1}, 0)


class ShellGateTests(unittest.TestCase):
    def test_fresh_results_and_subprocess_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            script_dir = root / 'tests/evaluation/intl-benchmark'
            script_dir.mkdir(parents=True)
            for name in ('sota-gate.sh', 'sota_gate_results.py'):
                shutil.copy(BASE / name, script_dir / name)
            shutil.copy(BASE.parent / 'gate-thresholds.sh', script_dir.parent / 'gate-thresholds.sh')
            (script_dir.parent / 'golden_dataset.json').write_text(json.dumps([{'id': 'GS-NA-001'}]))
            (script_dir / 'regression').mkdir()
            (script_dir / 'regression/hard-multihop-hotpot.json').write_text(json.dumps([{'qid': 'q0'}]))
            (script_dir / 'regression/floors.json').write_text(json.dumps({'hotpot': {'cases': 1, 'probe_passed': 1}}))
            # A stale high-scoring artifact must not rescue a bad current probe.
            (script_dir / 'results').mkdir()
            (script_dir / 'results/intl-hotpot-99999999.json').write_text('{}')
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            shim = bin_dir / 'python3'
            shim.write_text(f'#!{sys.executable}\n' + '''import json, os, pathlib, sys
args = sys.argv[1:]
if args[:2] == ['-m', 'pytest']:
    p = pathlib.Path('results') / os.environ['EVAL_RESULTS_NAME']
    p.write_text(json.dumps({'results': [{'id': 'GS-NA-001', 'hallucination': False}], 'summary': {'overall': {'count': 1, 'api_failure_count': 0, 'hallucination_rate': 0}}}))
    assert os.environ['EVAL_API_BASE_URL'] == 'http://isolated-test:1234/api/v1'
    sys.exit(int(os.environ.get('MOCK_PYTEST_FAILURE', '0')))
if args and args[0] == 'benchmark_suite.py':
    if 'EVAL_SET_PATH' in os.environ:
        n = int(os.environ.get('MOCK_PROBE_COUNT', '1'))
        p = pathlib.Path(os.environ['INTL_RESULTS_DIR']) / 'intl-hotpot-current.json'
        p.write_text(json.dumps({'dataset': 'hotpot', 'mode': 'full', 'n': n, 'retrieval_api_errors': 0, 'qa': {'api_errors': 0, 'containment': 1}, 'detail_qa': [{'qid': f'q{i}', 'containment': 1} for i in range(n)], 'detail_retrieval': [{'qid': f'q{i}'} for i in range(n)]}))
    sys.exit(0)
os.execv(sys.executable, [sys.executable] + args)
''')
            shim.chmod(0o755)
            docker = bin_dir / 'docker'
            docker.write_text('#!/bin/sh\ntouch "' + str(root / 'cache-mutated') + '"\nexit 1\n')
            docker.chmod(0o755)
            env = dict(os.environ, PATH=str(bin_dir) + ':' + os.environ['PATH'],
                       LLMWIKI_TOKEN='offline-fixture', API_BASE='http://isolated-test:1234', PROBE_TOLERANCE='0')
            for overrides, expected in (({}, 0), ({'MOCK_PYTEST_FAILURE': '1'}, 1), ({'MOCK_PROBE_COUNT': '100'}, 1)):
                with self.subTest(overrides=overrides):
                    result = subprocess.run(['bash', str(script_dir / 'sota-gate.sh'), 'quick'], env={**env, **overrides}, capture_output=True, text=True)
                    self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
            runs = list((script_dir.parent / 'results').glob('sota-gate-*'))
            self.assertEqual(len(runs), 3)
            self.assertFalse((root / 'cache-mutated').exists())


if __name__ == '__main__':
    unittest.main()
