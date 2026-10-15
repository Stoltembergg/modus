"""Small guard tests for the directed comparison, never inference fixtures."""
import unittest
import numpy as np
from dynamic_equivalence import compare_outputs, enforce_token_limit


class EquivalenceGuardTests(unittest.TestCase):
    def compare(self, left, right):
        return compare_outputs(np.array([left], dtype=np.float32), np.array([right], dtype=np.float32),
                               np.zeros((1,2), dtype=np.float32), np.zeros((1,2), dtype=np.float32), 2.55)

    def test_identical_outputs_pass(self):
        result=self.compare([1,0,-1],[1,0,-1])
        self.assertEqual(result['max_logit_abs_error'],0)
        self.assertEqual(result['max_probability_abs_error'],0)

    def test_out_of_tolerance_logits_fail(self):
        with self.assertRaisesRegex(AssertionError,'logits'):
            self.compare([0,0,0],[.01,0,0])

    def test_probability_error_can_fail_despite_relative_logit_tolerance(self):
        with self.assertRaisesRegex(AssertionError,'probabilities'):
            self.compare([100,100,100],[100.002,100,100])

    def test_near_tie_choice_flip_fails_even_when_numbers_are_close(self):
        with self.assertRaisesRegex(AssertionError,'choice'):
            self.compare([0,.00001,-1],[.00001,0,-1])

    def test_non_finite_outputs_fail(self):
        with self.assertRaisesRegex(AssertionError,'finite'):
            self.compare([0,0,0],[float('nan'),0,0])

    def test_token_limit_rejects_instead_of_truncating(self):
        enforce_token_limit(1024)
        with self.assertRaisesRegex(ValueError,'1024'):
            enforce_token_limit(1025)


if __name__=='__main__': unittest.main()
