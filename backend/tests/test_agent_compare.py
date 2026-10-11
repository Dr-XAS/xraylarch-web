"""The comparison read: several groups against the first, without arrays."""
import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web import agent_suite
from xraylarch_web.agent_suite import FOILS
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.mark.parametrize("saved_weight", [0, 1.5, 3, None])
def test_chi_amplitude_honors_zero_and_only_defaults_an_absent_weight(saved_weight):
    from xraylarch_web.agent_compare import _chi_amplitude

    k = np.linspace(0, 2, 5)
    reference = {"result": {"arrays": {"k": k.tolist(), "chi": np.ones(5).tolist()},
                            "effective": {"kweight": saved_weight, "kmin": 0}}}
    target = {"result": {"arrays": {"k": k.tolist(), "chi": k.tolist()}}}
    result = _chi_amplitude(target, reference)
    expected_weight = 2 if saved_weight is None else saved_weight
    weighted = k ** expected_weight
    expected_ratio = np.sqrt(np.mean((k * weighted) ** 2) / np.mean(weighted ** 2))
    assert result["kweight"] == expected_weight
    assert result["bins"] == [{"k": [0, 2], "ratio": round(float(expected_ratio), 3)}]


def test_chi_amplitude_uses_shared_measured_support_without_low_k_padding_or_extrapolation():
    from xraylarch_web.agent_compare import _chi_amplitude
    k = np.linspace(0, 12, 241)
    reference = {"data_type": "chi", "energy": [0., 12.], "result": {
        "arrays": {"k": k.tolist(), "chi": np.ones_like(k).tolist()}, "effective": {"kweight": 0, "kmin": 3}}}
    target = {"data_type": "chi", "energy": [6.001, 11.997], "result": {
        "arrays": {"k": k.tolist(), "chi": np.where(k < 6.001, 0., 2.).tolist()}}}
    result = _chi_amplitude(target, reference)
    assert result["range"] == [6.001, 11.997]
    assert all(row["ratio"] == 2 for row in result["bins"])
    assert result["bins"][0]["k"][0] == 6.001
    assert result["bins"][-1]["k"][1] == 11.997
    # Sparse/unpadded processed grids must not be extrapolated either.
    target["result"]["arrays"] = {"k": k[k >= 7].tolist(), "chi": np.full(sum(k >= 7), 2.).tolist()}
    assert _chi_amplitude(target, reference)["range"][0] == 7


def test_mu_derived_chi_support_respects_raw_shifted_energy_and_e0():
    from xraylarch_web.agent_compare import _chi_amplitude
    from xraylarch_web.athena_science import ETOK
    k = np.linspace(0, 12, 241)
    reference = {"result": {"arrays": {"k": k.tolist(), "chi": np.ones_like(k).tolist()},
                            "effective": {"kmin": 3, "kweight": 0}}}
    target = {"data_type": "mu", "energy": [7102 + 36 / ETOK, 7102 + 100 / ETOK],
              "parameters": {"energy_shift": 10}, "result": {
                  "arrays": {"k": k.tolist(), "chi": np.ones_like(k).tolist()}, "effective": {"e0": 7112}}}
    result = _chi_amplitude(target, reference)
    assert result["range"] == pytest.approx([6, 10])
    assert all(row["ratio"] == 1 for row in result["bins"])


@pytest.mark.parametrize("case", ["failed", "zero", "nan", "negative_k", "few_points", "no_overlap"])
def test_chi_unavailable_cases_never_invent_zero_amplitude_ratios(case):
    from copy import deepcopy
    from xraylarch_web.agent_compare import _chi_amplitude
    reference = {"data_type": "chi", "energy": [0., 4.], "result": {
        "arrays": {"k": [0., 1., 2., 3., 4.], "chi": [1.] * 5}, "effective": {"kmin": 0, "kweight": 1.5}}}
    target = deepcopy(reference)
    if case == "failed": target["processing_error"] = "Failure with stale arrays"
    if case == "zero": reference["result"]["arrays"]["chi"] = [0.] * 5
    if case == "nan": target["result"]["arrays"]["chi"][2] = float("nan")
    if case == "negative_k": target["result"]["arrays"]["k"][0] = -1.
    if case == "few_points":
        target["energy"] = [3., 4.]
    if case == "no_overlap": target["energy"] = [5., 6.]
    assert _chi_amplitude(target, reference) is None


@pytest.fixture
def http(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


@pytest.fixture
def run(http):
    return agent_suite.setup(http)


def compare(http, run, *labels):
    response = http.get(f"/api/athena/projects/{run['project_id']}/compare",
                        params={"groups": ",".join(run["groups"][label] for label in labels)})
    assert response.status_code == 200, response.text
    return {row["label"]: row for row in response.json()["groups"]} | {"": response.json()}


def send(http, run, action, labels, **options):
    base = f"/api/athena/projects/{run['project_id']}"
    version = http.get(base, params={"view": "summary"}).json()["version"]
    response = http.post(f"{base}/command", params={"view": "summary"}, json={
        "version": version, "action": action,
        "group_ids": [run["groups"][label] for label in labels], "options": options})
    assert response.status_code == 200, response.text


def test_it_says_which_scan_is_off_and_by_how_much(http, run):
    rows = compare(http, run, *FOILS)
    cold, warm = rows[FOILS[1]], rows[FOILS[2]]
    assert abs(cold["energy_shift"]["value"]) < 0.1 and cold["xanes_max_difference"] < 0.02
    assert warm["energy_shift"]["value"] == pytest.approx(-2.96, abs=0.05)
    assert warm["xanes_max_difference"] > 0.2
    assert warm["available_kmax"] < 18 and warm["common_range"][1] < 10200
    # The 300 K oscillation dies away faster with k, which is the Debye-Waller
    # factor and the reason not to average it with the cold scans unawares.
    ratios = [entry["ratio"] for entry in warm["chi_amplitude"]["bins"]]
    assert ratios[0] > ratios[-1] and ratios[-1] < 0.3
    assert all(0.85 < entry["ratio"] < 1.1 for entry in cold["chi_amplitude"]["bins"])


def test_it_names_the_same_measurement_under_two_labels(http, run):
    rows = compare(http, run, FOILS[0], FOILS[2], "Cu foil · shared reference")
    assert rows[FOILS[2]]["same_data_as"] == ["Cu foil · shared reference"]
    assert rows["Cu foil · shared reference"]["same_data_as"] == [FOILS[2]]


def test_it_names_a_duplicate_that_was_not_selected(http, run):
    """The copy worth knowing about is usually the one nobody thought to compare."""
    rows = compare(http, run, FOILS[0], FOILS[2])
    assert rows[FOILS[2]]["same_data_as"] == ["Cu foil · shared reference"]


def test_it_measures_a_linked_family_that_align_will_not_move(http, run):
    """The example's foils share a reference, so align refuses them; reading is not moving."""
    base = f"/api/athena/projects/{run['project_id']}"
    before = http.get(base, params={"view": "summary"}).json()["version"]
    assert compare(http, run, *FOILS)[FOILS[2]]["energy_shift"]["stderr"] is not None
    assert http.get(base, params={"view": "summary"}).json()["version"] == before


def test_after_aligning_there_is_nothing_left_to_shift(http, run):
    send(http, run, "assign_reference", FOILS, reference_id=None)
    send(http, run, "align", FOILS[1:], method="demeter-larch", operation="auto",
         standard_id=run["groups"][FOILS[0]])
    warm = compare(http, run, FOILS[0], FOILS[2])[FOILS[2]]
    assert abs(warm["energy_shift"]["value"]) < 0.05, "the shift is reported relative to the current one"
    assert warm["xanes_max_difference"] < 0.2, "the difference is taken on the shifted axis"


def test_it_is_small(http, run):
    whole = compare(http, run, *run["groups"])[""]
    assert len(str(whole)) < 6000, "five groups compared should cost a digest, not an export"
    assert "note" in whole and whole["reference"]["label"] == next(iter(run["groups"]))


@pytest.mark.parametrize("groups", ["only-one", "a,a"])
def test_it_needs_two_distinct_groups(http, run, groups):
    response = http.get(f"/api/athena/projects/{run['project_id']}/compare", params={"groups": groups})
    assert response.status_code == 400
    assert "at least two distinct" in response.json()["error"]["message"]


def preview(http, run, view, **options):
    base = f"/api/athena/projects/{run['project_id']}"
    version = http.get(base, params={"view": "summary"}).json()["version"]
    response = http.post(f"{base}/merge/preview", params={"view": view}, json={
        "version": version, "action": "merge", "group_ids": [run["groups"][label] for label in FOILS],
        "options": {"method": "demeter-larch", "exclude_short_data": False} | options})
    assert response.status_code == 200, response.text
    return response.json()["outputs"][0]


def test_a_merge_preview_measures_how_far_apart_its_members_are(http, run):
    agreement = preview(http, run, "summary", array="norm")["agreement"]
    rms = {row["label"]: row["rms_to_range"] for row in agreement["members"]}
    assert rms[FOILS[2]] > 1.5 * max(rms[FOILS[0]], rms[FOILS[1]])
    assert 0 < agreement["scatter_to_range"] < agreement["max_scatter_to_range"]


def test_aligning_first_brings_the_members_together(http, run):
    before = preview(http, run, "summary", array="norm")["agreement"]
    send(http, run, "assign_reference", FOILS, reference_id=None)
    send(http, run, "align", FOILS[1:], method="demeter-larch", operation="auto",
         standard_id=run["groups"][FOILS[0]])
    after = preview(http, run, "summary", array="norm")["agreement"]
    assert after["max_scatter_to_range"] < before["max_scatter_to_range"] / 2


def test_the_full_preview_is_left_as_the_browser_has_it(http, run):
    assert "agreement" not in preview(http, run, "full")


def test_a_summary_preview_leaves_out_the_new_groups_starting_recipe(http, run):
    output = preview(http, run, "summary", array="norm")
    assert set(output["parameters"]) == {"e0", "omitted"}
    assert len(preview(http, run, "full")["parameters"]) > 30
