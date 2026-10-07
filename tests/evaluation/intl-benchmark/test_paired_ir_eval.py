import json
import tempfile
import unittest
from pathlib import Path
from paired_ir_eval import evaluate, percentile, ranking


class PairedIrTest(unittest.TestCase):
    def test_interpolated_percentile(self):
        self.assertEqual(percentile([0,1,2,3], .5), 1.5)

    def test_full_qrels_and_repeat_pairing(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            (base/'qrels').write_text('query-id\tcorpus-id\tscore\na\tx\t1\nb\ty\t1\n')
            (base/'queries').write_text('actual queries'); (base/'corpus').write_text('actual full corpus')
            (base/'old').write_text('\n'.join(json.dumps({'qid':qid,'docids':[]}) for qid in ('a','b')))
            (base/'new').write_text('\n'.join(json.dumps({'qid':qid,'docids':[doc]}) for qid,doc in [('a','x'),('b','y')]))
            metadata={'gitCommit':'commit','workingTreeHash':'tree','modelFingerprint':'model'}
            manifest={'baselineProvenance':metadata,'candidateProvenance':metadata,'datasets':[{'name':'set','qrels':str(base/'qrels'),'queries':str(base/'queries'),'corpus':str(base/'corpus'),'baseline':[str(base/'old')]*2,'candidate':[str(base/'new')]*2}]}
            report=evaluate(manifest,resamples=1000)
            self.assertTrue(report['passes'])
            self.assertEqual(report['datasets'][0]['metrics']['recall']['delta95'],[1,1])
            (base/'new').write_text(json.dumps({'qid':'a','docids':['x']}))
            with self.assertRaises(ValueError):evaluate(manifest,resamples=1000)

    def test_duplicate_topics_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'run';path.write_text('{"qid":"a","docids":[]}\n'*2)
            with self.assertRaises(ValueError):ranking(path)

    def test_single_topic_is_descriptive_and_cannot_pass_confidence_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            (base/'qrels').write_text('query-id\tcorpus-id\tscore\na\tx\t1\n')
            (base/'queries').write_text('one labeled topic');(base/'corpus').write_text('full corpus')
            (base/'run').write_text('{"qid":"a","docids":["x"]}\n')
            metadata={'gitCommit':'commit','workingTreeHash':'tree','modelFingerprint':'model'}
            row={'name':'single','qrels':str(base/'qrels'),'queries':str(base/'queries'),'corpus':str(base/'corpus'),'baseline':[str(base/'run')],'candidate':[str(base/'run')]}
            report=evaluate({'baselineProvenance':metadata,'candidateProvenance':metadata,'datasets':[row]},resamples=1000)
            self.assertFalse(report['passes'])
            self.assertIsNone(report['datasets'][0]['metrics']['recall']['delta95'])
            self.assertEqual(report['datasets'][0]['metrics']['recall']['candidate'],1)
            self.assertIn('one labeled topic',report['datasets'][0]['inferenceBlocker'])
