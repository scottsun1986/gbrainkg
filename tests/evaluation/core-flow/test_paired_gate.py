import unittest
from paired_gate import compare, paired_interval, load
import tempfile
import json
from pathlib import Path
class PairedGateTest(unittest.TestCase):
    def data(self, cost, latency, unauthorized=0):
        return {'corpusHash':'corpus','policyVersion':'core-auth-v1','cases':[{'id':str(i),'bucket':'numeric','authorizationScopeHash':'u','asOf':'2026-09-30T00:00:00Z','correctness':1,'citation_precision':1,'fact_coverage':1,'evidence_coverage':1,'span_correct':1,'unauthorized':unauthorized,'latency_ms':latency,'cost_usd':cost} for i in range(50)]}
    def test_cost_improvement_cannot_override_permission_failure(self):
        baseline=self.data(1,100);candidate=self.data(.5,50,1)
        result=compare(baseline,candidate,min_cases=50)
        self.assertFalse(result['passes']);self.assertIn('unauthorized_content',result['failures'])
    def test_paired_positive_and_negative_results(self):
        self.assertTrue(compare(self.data(1,100),self.data(.5,50),min_cases=50)['passes'])
        candidate=self.data(.5,50);candidate['cases'][0]['correctness']=0
        self.assertFalse(compare(self.data(1,100),candidate,min_cases=50)['passes'])
        self.assertEqual(paired_interval([{'x':0}],[{'x':1}],'x'),[1,1])
    def test_real_latency_is_not_treated_as_probability(self):
        data=self.data(.01,300)
        data.update(runId='test-run',gitCommit='git',workingTreeHash='tree',modelFingerprints=['model'])
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'run.json';path.write_text(json.dumps(data))
            self.assertEqual(load(path)['cases'][0]['latency_ms'],300)
            data['cases'][0]['citation_precision']=1.01;path.write_text(json.dumps(data))
            with self.assertRaises(ValueError):load(path)
    def test_requested_multihop_gain_needs_actual_multihop_cases(self):
        self.assertFalse(compare(self.data(1,100),self.data(.5,50),min_cases=50,require_multihop=True)['passes'])
