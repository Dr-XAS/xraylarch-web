"""Offline comparison regression checks; no model or server calls."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


compare = module("compare_science", "compare_science.py")
pair = module("run_pair", "run_pair.py")


class ComparisonChecks(unittest.TestCase):
    def test_missing_data_never_equivalent(self):
        for task in compare.TASKS:
            result = compare.compare_task(task, {}, {}, {}, [], [])
            self.assertEqual(result["numerical_status"], "unknown")
            self.assertTrue(all(row["status"] == "unknown" for row in result["comparisons"]))

    def test_first_fit_is_not_replaced_by_better_later_fit(self):
        app_events, native_events = [], []
        for index, distance in enumerate([2.57, 2.55]):
            app_events.extend([
                {"seq": index * 2 + 1, "kind": "http_request", "path": "/api/artemis/projects/p/groups/g/fit",
                 "body": {"transform": {"kmax": 12 + index}}},
                {"seq": index * 2 + 2, "kind": "http_result", "status": 200, "output": {"body": {
                    "success": True, "group_label": compare.FOILS[0],
                    "paths": [{"r": distance, "degen": 12, "scatterers": "Cu-Cu"}],
                    "parameters": [], "statistics": {}, "transform": {"kmax": 12 + index}}}},
            ])
            native_events.extend([
                {"seq": index * 2 + 1, "kind": "tool_call", "arguments": {
                    "xas_ref": "original", "material_id": "eval_copper_11145"}},
                {"seq": index * 2 + 2, "kind": "tool_result", "call_seq": index * 2 + 1,
                 "tool": "fit_ffef_first_shell", "output": {
                    "path_parameter": [{"R": distance, "n_feff": 12}],
                    "fitted_parameter": {"kmax": 12 + index}}},
            ])
        science = {"originals": [{"label": compare.FOILS[0], "xas_ref": "original"}]}
        self.assertEqual(compare.app_first_fit(app_events)["r"], 2.57)
        self.assertEqual(compare.native_first_fit(science, native_events)["r"], 2.57)
        app_events[1]["output"]["body"]["success"] = False
        native_events[1]["output"]["error"] = "fit failed"
        self.assertEqual(compare.app_first_fit(app_events)["r"], 2.55)
        self.assertEqual(compare.native_first_fit(science, native_events)["r"], 2.55)

    def test_tolerance_and_invalid_numbers(self):
        self.assertEqual(compare.comparison("r", 2.55, 2.56, .02)["status"], "equivalent")
        self.assertEqual(compare.comparison("r", 2.55, 2.58, .02)["status"], "different")
        self.assertEqual(compare.comparison("r", None, 2.55, .02)["status"], "unknown")
        self.assertIsNone(compare.comparison("r", float("nan"), 2.55, .02)["native"])

    def test_nested_layout(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            native, app, runtime = (root / "t1" / part for part in ("native-T1", "app-T1", "app-T1-runtime"))
            for directory in (native, app, runtime):
                directory.mkdir(parents=True)
            originals = [{"label": label, "e0": 8980., "edge_step": 2.3} for label in compare.FOILS]
            (native / "science.json").write_text(json.dumps({"originals": originals}))
            (native / "events.jsonl").write_text("")
            (app / "events.jsonl").write_text("")
            (runtime / "initial-summary.json").write_text(json.dumps({"groups": originals}))
            (runtime / "run.json").write_text("{}")
            result = compare.compare_runs(root)
            self.assertEqual(result["tasks"]["T1"]["numerical_status"], "equivalent")
            self.assertEqual(result["tasks"]["T2"]["numerical_status"], "unknown")

    def test_kmin_is_an_invariant(self):
        science = {"transforms": [{"source_label": compare.FOILS[0], "kmin": 2, "kmax": 14, "r_peak": 2.3}]}
        snapshot = {"summary": {"groups": [{"label": compare.FOILS[0], "id": "ten"}]},
                    "parameters": {"groups": [{"id": "ten", "effective": {"kmin": 3, "kmax": 14}}]}}
        result = compare.compare_task("T3", science, {}, snapshot, [], [])
        invariant = next(row for row in result["comparisons"] if row["field"] == "10 K.kmin")
        self.assertEqual(invariant["kind"], "invariant")
        self.assertEqual(invariant["status"], "different")
        self.assertEqual(invariant["expected_unchanged_kmin"], 3)
        self.assertEqual(invariant["absolute_tolerance"], 1e-6)


class MeasurementIdentityChecks(unittest.TestCase):
    def setUp(self):
        self.rows = [{"label": "Cu2O", "energy": [8980., 8990.], "mu": [0.2, 0.8]}]

    def test_tiny_roundoff_matches(self):
        measured = copy.deepcopy(self.rows)
        measured[0]["mu"][1] += 5e-15
        self.assertTrue(pair.measurements_match(measured, self.rows))

    def test_mismatch_does_not_match(self):
        measured = copy.deepcopy(self.rows)
        measured[0]["mu"][1] += 1e-8
        self.assertFalse(pair.measurements_match(measured, self.rows))

    def test_missing_group_or_array_sample_does_not_match(self):
        self.assertFalse(pair.measurements_match([], self.rows))
        measured = copy.deepcopy(self.rows)
        measured[0]["mu"].pop()
        self.assertFalse(pair.measurements_match(measured, self.rows))


if __name__ == "__main__":
    unittest.main()
