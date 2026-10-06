"""Regression checks for the two observed coordinator failures and safe resume."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from unittest import TestCase, main
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import recover_setup
import run_repeats

class RunnerTests(TestCase):
    def test_record_after_app_first_setup_failure_with_empty_pairs(self):
        manifest = {"pairs": {}}
        result = {"returncode": 0, "started": 12.0, "finished": 20.0}
        recover_setup.record_arm(manifest, "T2", "app", result)
        self.assertEqual(manifest["pairs"]["T2"]["app"], result)
        recover_setup.record_arm(manifest, "T2", "native", {"returncode": 1})
        self.assertEqual(manifest["pairs"]["T2"]["app"], result)

    def test_completed_failed_and_partial_attempts_are_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ("run.json", "run.partial.json", "events.jsonl"):
                attempt = root / name.replace(".", "_")
                attempt.mkdir()
                self.assertFalse(recover_setup.attempt_started(attempt))
                (attempt / name).write_text("{}")
                self.assertTrue(recover_setup.attempt_started(attempt))
            self.assertFalse(recover_setup.attempt_started(root / "not_started"))

    def test_failed_preflight_never_starts_model(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(sys, "argv", ["recover", "--root", temp, "--python", sys.executable]), patch.object(recover_setup, "preflight", side_effect=RuntimeError("fixture mismatch")), patch.object(recover_setup.run_pair, "model_run") as model, patch.object(recover_setup.run_pair, "run_app") as app:
            with self.assertRaisesRegex(RuntimeError, "fixture mismatch"):
                recover_setup.main()
            model.assert_not_called()
            app.assert_not_called()
            self.assertFalse((Path(temp) / "recovery.json").exists())

    def test_initial_setup_failure_aborts_remaining_schedule(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(sys, "argv", ["repeat", "--root", temp, "--python", sys.executable]), patch.object(run_repeats.subprocess, "run") as launch:
            (Path(temp) / "protocol.md").write_text("fixed protocol")
            launch.return_value.returncode = 1
            self.assertEqual(run_repeats.main(), 1)
            self.assertEqual(launch.call_count, 1)
            schedule = json.loads((Path(temp) / "schedule.json").read_text())
            self.assertEqual(schedule["scheduled_attempts"], 30)
            self.assertEqual(len(schedule["launch_results"]), 1)

if __name__ == "__main__":
    main()
