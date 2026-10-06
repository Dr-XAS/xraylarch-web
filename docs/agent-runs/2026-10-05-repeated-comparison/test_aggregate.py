"""Guard against turning absent or incomplete attempt evidence into a pass."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("aggregate", Path(__file__).with_name("aggregate.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class AggregationTests(unittest.TestCase):
    def test_missing_attempts_keep_fixed_denominator_and_do_not_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = module.read(module.BASE.parent / "2026-10-05-native-vs-app/fixture/fixture.json")
            result = module.aggregate(Path(directory), fixture, {})
        self.assertEqual(len(result["runs"]), 30)
        self.assertTrue(all(row["status"] == "missing" for row in result["runs"]))
        self.assertTrue(all(row["combined_status"] != "pass" for row in result["runs"]))
        self.assertTrue(all(row["attempts"] == 3 for row in result["summaries"]))
        self.assertTrue(all(row["metrics"]["input_tokens"]["n"] == 0 for row in result["summaries"]))

    def test_failed_attempt_usage_is_retained_and_no_answer_is_not_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arm = root / "repeat-1/T5/app-T5"
            arm.mkdir(parents=True)
            (arm / "run.partial.json").write_text(json.dumps({"status": "failed", "error_type": "UserError", "usage": {"input_tokens": 4317, "output_tokens": 152}}))
            (arm / "events.jsonl").write_text(json.dumps({"kind": "tool_call", "seq": 1}) + "\n" + json.dumps({"kind": "tool_error", "call_seq": 1}) + "\n")
            fixture = module.read(module.BASE.parent / "2026-10-05-native-vs-app/fixture/fixture.json")
            result = module.aggregate(root, fixture, {})
            row = next(r for r in result["runs"] if r["repeat"] == 1 and r["task"] == "T5" and r["arm"] == "app")
            self.assertEqual(row["input_tokens"], 4317)
            self.assertEqual(row["output_tokens"], 152)
            self.assertEqual(row["rejected_tool_calls"], 1)
            self.assertEqual(row["combined_status"], "fail")
            self.assertIsNone(row["agent_wall_seconds"])

    def test_missing_check_and_failed_check_are_distinct(self):
        self.assertEqual(module.status({"fit": None}), "unknown")
        self.assertEqual(module.status({"fit": True, "state": False}), "fail")
        self.assertEqual(module.status({"fit": True, "state": True}), "pass")

    def test_observed_ranges_and_medians_exclude_missing_not_zero(self):
        self.assertEqual(module.numeric_range([2.54, None, 2.56]), {"n": 2, "min": 2.54, "max": 2.56})
        self.assertEqual(module.metric_median([{"tokens": 10}, {}, {"tokens": 30}], "tokens"), {"n": 2, "median": 20})

    def test_overlapping_http_calls_join_by_identity_and_keep_call_order(self):
        events = [
            {"kind": "tool_call", "tool": "http_request", "seq": 1, "arguments": {"path": "/first"}},
            {"kind": "tool_call", "tool": "http_request", "seq": 3, "arguments": {"path": "/second"}},
            {"kind": "tool_result", "tool": "http_request", "seq": 5, "call_seq": 3, "output": {"status": 200, "body": {"id": "second"}}},
            {"kind": "tool_result", "tool": "http_request", "seq": 7, "call_seq": 1, "output": {"status": 200, "body": {"id": "first"}}},
        ]
        paired = list(module.correlated_http_results(events))
        self.assertEqual([(request["path"], output["id"]) for _, request, output in paired], [("/first", "first"), ("/second", "second")])
        self.assertEqual(paired[0][0]["seq"], 7)

    def test_absolute_check_rejects_shared_wrong_value(self):
        paired = module.science.comparison("alignment", 9.0, 9.0, .1)
        self.assertEqual(paired["status"], "equivalent")
        self.assertFalse(module.close(paired["native"], -2.959, .1))

if __name__ == "__main__":
    unittest.main()
