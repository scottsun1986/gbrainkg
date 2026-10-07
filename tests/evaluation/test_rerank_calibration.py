import unittest
from fit_rerank_calibration import calibrate, probability, wilson


class CalibrationTest(unittest.TestCase):
    def labels(self):
        return {'contract':'rerank-labels-v1','route':'https://fixture.invalid/rerank','model':'fixture','revision':'r1','corpusHash':'fixture-corpus','cases':[{'id':str(i),'score':float(i%100)/100,'supported':i%100>=50} for i in range(1000)]}

    def test_disjoint_reproducible_holdout_and_deployment_pin(self):
        first,report=calibrate(self.labels(),threshold=.5)
        second,_=calibrate(self.labels(),threshold=.5)
        self.assertEqual(first,second)
        self.assertEqual(first['sampleCount'],300)
        self.assertNotEqual(first['trainingSetHash'],first['validationSetHash'])
        self.assertGreater(first['slope'],0)
        self.assertGreater(report['refusalPrecision']['value'],.9)
        self.assertGreater(probability(.9,first['slope'],first['intercept']),probability(.1,first['slope'],first['intercept']))

    def test_insufficient_holdout_and_fake_profile_refused(self):
        data=self.labels();data['cases']=data['cases'][:100]
        with self.assertRaises(ValueError):calibrate(data)
        data=self.labels();data['fixture']=True
        with self.assertRaises(ValueError):calibrate(data)

    def test_wilson_non_degenerate_at_perfect_sample(self):
        self.assertLess(wilson(10,10)[0],1)
        self.assertEqual(wilson(0,0),None)

    def test_unknown_revision_cannot_emit_a_deployment_profile(self):
        data=self.labels();data['revision']=''
        with self.assertRaises(ValueError):calibrate(data)
        _,report=calibrate(data,allow_unversioned_diagnostics=True)
        self.assertFalse(report['deploymentEligible'])
        self.assertIn('revision',report['deploymentBlocker'])
