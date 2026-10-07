import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sota20_benchmark as benchmark


class ReadOnlyPreflightTest(unittest.TestCase):
    def fixture(self, directory, second_exact=False):
        dataset=Path(directory)/'sample';(dataset/'qrels').mkdir(parents=True)
        (dataset/'corpus.jsonl').write_text('{"_id":"a"}\n{"_id":"b"}\n')
        (dataset/'queries.jsonl').write_text('{"_id":"q","text":"question"}\n')
        (dataset/'qrels/test.tsv').write_text('query-id\tcorpus-id\tscore\nq\ta\t1\n')
        def http(method,path,**kwargs):
            self.assertEqual(method,'GET','preflight cannot mutate or retrieve')
            if path.startswith('/api/v1/kbs?page='):
                return 200,json.dumps({'items':[{'id':'old','name':'BEIR-Eval-sample'},{'id':'exact','name':'BEIR-Eval-sample'}],'total':2})
            ids=['a','b'] if '/exact/' in path or second_exact else ['a','other']
            return 200,json.dumps({'items':[{'title':f'[BEIR:{id}]'} for id in ids],'total':2})
        return http

    def test_equal_counts_require_exact_corpus_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            http=self.fixture(directory)
            with patch.dict(benchmark.BEIR_DIRS,{'beir':Path(directory)}),patch.object(benchmark,'http',side_effect=http):
                report=benchmark.read_only_preflight('sample','beir','test-session')
            self.assertEqual(report['status'],'ready')
            self.assertEqual(report['kb_id'],'exact')
            self.assertFalse(report['candidates'][0]['exact_corpus_match'])
            self.assertEqual(set(report['hashes']),{'corpus','queries','qrels'})

    def test_duplicate_exact_corpora_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            http=self.fixture(directory,second_exact=True)
            with patch.dict(benchmark.BEIR_DIRS,{'beir':Path(directory)}),patch.object(benchmark,'http',side_effect=http):
                report=benchmark.read_only_preflight('sample','beir','test-session')
            self.assertEqual(report['status'],'ambiguous_ready_corpus')
            self.assertNotIn('kb_id',report)
