import unittest
import numpy as np
from analyze import cliffs_delta, holm, median_interval


class StatisticsTests(unittest.TestCase):
    def test_effect_direction_and_ties(self):
        self.assertEqual(cliffs_delta([3, 4], [1, 2]), 1)
        self.assertEqual(cliffs_delta([1, 2], [3, 4]), -1)
        self.assertEqual(cliffs_delta([1, 1], [1, 1]), 0)

    def test_holm_known_example(self):
        np.testing.assert_allclose(holm([.03, .01, .04]), [.06, .03, .06])

    def test_single_observation_has_no_interval(self):
        self.assertEqual(median_interval([5], 1, 1000), (None, None))

    def test_constant_sample(self):
        self.assertEqual(median_interval([7] * 10, 1, 1000), (7, 7))

    def test_reproducible_bootstrap(self):
        self.assertEqual(median_interval(range(10), 42, 1000), median_interval(range(10), 42, 1000))


class InputTests(unittest.TestCase):
    def test_rejects_incomplete_series(self):
        import tempfile
        import json
        from pathlib import Path
        from analyze import load_batch
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            for name, data in [('summary', {'status': 'failed', 'failed': 1}), ('config', {}), ('plan', [])]:
                (p / f'{name}.json').write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'завершённой'):
                load_batch(p)

    def test_inference_and_validation_separation(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import pandas as pd
        from analyze import analyze, METRICS
        rows = []
        for i in range(10):
            for variant, value in [('a', i + 1), ('b', i + 21)]:
                rows.append(dict(order=len(rows) + 1, scenario='sequential', variant=variant,
                                 **{metric: value for metric in METRICS}))
        frame = pd.DataFrame(rows)
        with tempfile.TemporaryDirectory() as directory, patch('matplotlib.figure.Figure.savefig'):
            p = Path(directory)
            config = dict(scenarios=['sequential'], variants=['a', 'b'], purpose='experiment')
            analyze(frame, config, p, 42, 1000)
            comparisons = pd.read_csv(p / 'comparisons.csv')
            self.assertTrue((comparisons.cliffs_delta == -1).all())
            self.assertTrue((comparisons.p_holm < .05).all())
            config['purpose'] = 'validation'
            analyze(frame, config, p, 42, 1000)
            comparisons = pd.read_csv(p / 'comparisons.csv')
            self.assertTrue(comparisons.p_raw.isna().all())
