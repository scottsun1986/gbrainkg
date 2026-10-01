import unittest
from maxsim_job import maxsim
class MaxSimTest(unittest.TestCase):
    def test_exact_cosine_and_candidate_identity(self):
        rows = maxsim([[1,0],[0,1]], [{'id':'complete','vectors':[[2,0],[0,3]]}, {'id':'partial','vectors':[[2,0]]}])
        self.assertEqual(rows[0], {'id':'complete','score':1.0})
        self.assertEqual(rows[1], {'id':'partial','score':.5})
    def test_dimension_and_candidate_budget(self):
        with self.assertRaises(ValueError):
            maxsim([[1,0]], [{'id':'bad','vectors':[[1]]}])
        with self.assertRaises(ValueError):
            maxsim([[1,0]], [{'id':str(i),'vectors':[[1,0]]} for i in range(41)])
