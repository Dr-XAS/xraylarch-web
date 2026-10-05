"""The independent scientific checks must reject both original failures."""
import unittest
from pathlib import Path

from verify_evidence import close, verify_task

BASELINE = Path(__file__).resolve().parent.parent / "2026-10-05-native-vs-app/runs/t2-t5"


class EvidenceTests(unittest.TestCase):
    def test_original_alignment_success_is_scientifically_wrong(self):
        directory = BASELINE / "native-T2"
        result = verify_task(directory, directory)
        self.assertTrue(result["checks"]["workflow_state"])
        self.assertFalse(result["passed"])
        for label in ("Cu foil · 50 K", "Cu foil · 300 K"):
            self.assertFalse(result["checks"][f"{label}.shift"])
            self.assertFalse(result["checks"][f"{label}.edge_residual"])
            self.assertTrue(result["checks"][f"{label}.energy_min_shift"])

    def test_original_transform_replaced_saved_settings(self):
        directory = BASELINE / "native-T3"
        result = verify_task(directory, directory)
        self.assertFalse(result["passed"])
        self.assertTrue(result["checks"]["upper_limit_reduced"])
        self.assertTrue(result["checks"]["first_shell_peak"])
        for key in ("kmin", "window", "rmax_out"):
            self.assertFalse(result["checks"][f"preserved.{key}"])

    def test_missing_or_nonfinite_values_cannot_pass(self):
        for value in (None, float("nan"), float("inf"), True):
            self.assertFalse(close(value, 1, 10))


if __name__ == "__main__":
    unittest.main()
