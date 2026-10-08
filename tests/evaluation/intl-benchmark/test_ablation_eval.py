import copy
import json
import tempfile
import unittest
from pathlib import Path
from ablation_eval import evaluate


class AblationTest(unittest.TestCase):
    def manifest(self, root):
        paths = {key: str(root/key) for key in ('corpus', 'queries', 'qrels', 'labels')}
        (root/'corpus').write_text('full corpus')
        (root/'queries').write_text('fixed queries')
        (root/'qrels').write_text('query-id\tcorpus-id\tscore\na\tx\t1\nb\ty\t1\n')
        (root/'labels').write_text('\n'.join(json.dumps({'qid': qid, 'answerable': True, 'evidenceChains': [[doc]]})
            for qid, doc in [('a', 'x'), ('b', 'y')]))
        protocol = {key: 'fixed' for key in ('chunker', 'embedding', 'reranker', 'generator', 'judge', 'budget', 'cache')}
        protocol.update(concurrency=1, pricing={'currency': 'USD', 'models': {'model': {
            'inputPerMillion': 1, 'cachedInputPerMillion': .1, 'outputPerMillion': 2}}})
        variants = []
        for name in ('baseline', 'graph'):
            rows = []
            for qid, doc in [('a', 'x'), ('b', 'y')]:
                counts = {'modelCalls': 1, 'inputTokens': 100, 'cachedInputTokens': 0, 'outputTokens': 20}
                rows.append({'qid': qid, 'docids': [doc] if name == 'graph' else [], 'success': True,
                    'grading': {'supportedClaims': 1, 'totalClaims': 1, 'correctCitations': 1, 'totalCitations': 1,
                        'answerCorrect': True, 'refused': False},
                    'usage': {**counts, 'latencyMs': 400, 'visibleMs': 300, 'byModel': {'model': counts}}})
            path = root/name; path.write_text('\n'.join(json.dumps(row) for row in rows))
            variants.append({'name': name, 'features': ['dense', 'bm25', 'rerank'] + (['graph'] if name == 'graph' else []),
                'protocol': copy.deepcopy(protocol), 'provenance': dict.fromkeys(('gitCommit', 'workingTreeHash', 'modelFingerprint', 'judgeFingerprint'), 'hash'),
                'runs': {'data': [str(path)]}})
        return {'baseline': 'baseline', 'protocol': protocol, 'variants': variants, 'datasets': [{'name': 'data', **paths}]}

    def test_paired_quality_cost_and_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            report = evaluate(self.manifest(Path(directory)), resamples=1000)
            result = report['datasets'][0]
            self.assertEqual(result['comparisons']['graph']['recall']['deltaSimultaneous95'], [1, 1])
            self.assertEqual(result['comparisons']['graph']['chainComplete']['delta'], 1)
            self.assertAlmostEqual(result['variants']['graph']['metrics']['cost']['mean'], .00014)
            self.assertEqual(result['variants']['graph']['metrics']['latencyMs']['p99'], 400)
            self.assertEqual(len(result['hashes']['corpus']), 64)

    def test_config_drift_and_incomplete_topics_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self.manifest(Path(directory))
            manifest['variants'][1]['protocol']['embedding'] = 'different'
            with self.assertRaisesRegex(ValueError, 'Protocol differs'): evaluate(manifest, resamples=1000)
            manifest['variants'][1]['protocol'] = copy.deepcopy(manifest['protocol'])
            path = Path(manifest['variants'][1]['runs']['data'][0]); path.write_text(path.read_text().splitlines()[0])
            with self.assertRaisesRegex(ValueError, 'Every run'): evaluate(manifest, resamples=1000)

    def test_missing_usage_cannot_be_reported_as_zero_cost(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self.manifest(Path(directory)); path = Path(manifest['variants'][0]['runs']['data'][0])
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            del rows[0]['usage']['byModel']
            path.write_text('\n'.join(json.dumps(row) for row in rows))
            with self.assertRaisesRegex(ValueError, 'Missing per-model usage'): evaluate(manifest, resamples=1000)

    def test_fixture_is_not_efficacy_evidence(self):
        with self.assertRaisesRegex(ValueError, 'Synthetic'): evaluate({'fixture': True})


if __name__ == '__main__': unittest.main()
