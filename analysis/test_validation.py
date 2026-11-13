import unittest
import numpy as np
import pandas as pd
from validate_stand import aa_test, trend_test, resource_summary

class ValidationTests(unittest.TestCase):
    def test_aa_constant(self):
        labels = np.array(['A1'] * 5 + ['A2'] * 5)
        result = aa_test([2] * 10, labels)
        self.assertEqual(result['p_raw'], 1)
        self.assertEqual(result['cliffs_delta'], 0)

    def test_aa_known_exact_probability(self):
        labels = np.array(['A1'] * 5 + ['A2'] * 5)
        result = aa_test(range(10), labels)
        self.assertAlmostEqual(result['p_raw'], 2 / 252)
        self.assertEqual(result['cliffs_delta'], -1)

    def test_detects_monotonic_trend(self):
        result = trend_test(range(10), range(10), 42, 999)
        self.assertAlmostEqual(result['rho'], 1)
        self.assertLess(result['p_raw'], .05)

    def test_constant_has_no_trend(self):
        self.assertEqual(trend_test(range(10), [1] * 10, 42, 999)['p_raw'], 1)

    def test_missing_monitoring_is_not_success(self):
        frame = pd.DataFrame([dict(phase='scenario', cgroupAvailable=False, controllerCpuPercentOneCore=1)])
        self.assertEqual(resource_summary(frame, 80)[0]['status'], 'incomplete')

    def test_throttling_requires_attention(self):
        frame = pd.DataFrame([dict(phase='scenario', cgroupAvailable=True, controllerCpuPercentOneCore=1,
                                  containerCpuPercentQuota=10, throttledPeriods=1)])
        self.assertEqual(resource_summary(frame, 80)[0]['status'], 'attention')
