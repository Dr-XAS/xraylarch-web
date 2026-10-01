"""A spectrum described for a caller with no plot to look at."""
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.config import Settings
from xraylarch_web.main import create_app
from tests.test_agent_views import numeric_runs


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


@pytest.fixture
def example(client):
    project = client.post("/api/athena/projects").json()
    return client.post(f"/api/athena/projects/{project['id']}/command", json={
        "version": project["version"], "action": "example",
        "group_ids": [], "options": {}}).json()


def digest(client, project, group_id):
    response = client.get(
        f"/api/athena/projects/{project['id']}/groups/{group_id}/digest")
    assert response.status_code == 200, response.text
    return response.json()


def test_digest_describes_copper_without_returning_it(client, example):
    report = digest(client, example, example["groups"][0]["id"])

    assert not [path for path, length in numeric_runs(report) if length > 2]

    assert report["group"]["element"] == "Cu"
    assert report["sampling"]["points"] == 612
    assert report["sampling"]["uniform"] is False

    # Copper metal: first shell near 2.2 A after phase shift, so the transform
    # peak sits somewhat below that. Assert the band, not a fitted distance.
    peaks = report["chir_peaks"]
    assert peaks, "processed copper EXAFS should show shells"
    assert peaks == sorted(peaks, key=lambda peak: -peak["magnitude"])
    assert any(1.8 < peak["r"] < 2.4 for peak in peaks)
    assert all(peak["r"] <= 6.0 for peak in peaks)
    assert "Not bond lengths" in report["chir_peaks_note"]

    assert report["noise"]["epsilon_k"] > 0
    assert report["noise"]["nidp"] > 0


def test_digest_separates_what_was_asked_from_what_larch_used(client, example):
    report = digest(client, example, example["groups"][0]["id"])
    transform = report["transform"]
    assert transform["kmin"]["requested"] == 3
    assert transform["kmax"]["requested"] is None, "the example leaves kmax automatic"
    assert transform["kmax"]["used"] > 0, "processing resolved one"
    assert transform["available_kmax"] >= transform["kmax"]["used"]

    normalization = report["normalization"]
    assert normalization["pre1"]["requested"] is None
    assert normalization["pre1"]["used"] < 0


def test_clipped_ranges_are_reported_as_adjustments(client, example):
    """A pre-edge range wider than the measured data is clipped; say so."""
    target = example["groups"][0]["id"]
    moved = client.post(f"/api/athena/projects/{example['id']}/command", json={
        "version": example["version"], "action": "parameters",
        "group_ids": [target], "options": {"pre1": -900.0}}).json()

    report = digest(client, moved, target)
    adjusted = {entry["parameter"] for entry in report["normalization"]["adjustments"]}
    assert "pre1" in adjusted
    assert report["normalization"]["pre1"]["requested"] == -900.0
    assert report["normalization"]["pre1"]["used"] > -900.0


@pytest.mark.parametrize("error", [None, "Larch processing failed; widen the ranges."])
def test_a_group_that_never_processed_says_why(example, error):
    """A digest of a broken group is still a digest, and never raises.

    Processing failures are recorded on the group rather than rejected at
    import, so this branch is reachable for any group whose saved recipe no
    longer suits its data.
    """
    from xraylarch_web.agent_digest import group_digest

    group = dict(example["groups"][0], result=None, processing_error=error)
    report = group_digest(group)

    assert report["unavailable"] == (error or "This group has not been processed yet.")
    assert report["group"]["processed"] is False
    assert report["sampling"]["points"] == 612
    for absent in ("normalization", "background", "transform", "chir_peaks", "noise"):
        assert absent not in report


def test_a_missing_group_is_a_clean_error(client, example):
    response = client.get(
        f"/api/athena/projects/{example['id']}/groups/nosuchgroup/digest")
    assert response.status_code == 400
    assert response.json()["error"]["code"]


def test_signal_to_noise_locates_where_chi_stops_being_signal(client, example):
    """The one number a caller used to have to export 29 KB of CSV to get."""
    report = digest(client, example, example["groups"][0]["id"])
    block = report["signal_to_noise"]

    assert not [path for path, length in numeric_runs(block) if length > 2]
    assert block["over"] == [3.0, 25.0], "binned over the measured support"
    assert [b["k"] for b in block["bins"]] == [
        [3.0, 5.0], [5.0, 7.0], [7.0, 9.0], [9.0, 11.0], [11.0, 13.0], [13.0, 15.0],
        [15.0, 17.0], [17.0, 19.0], [19.0, 21.0], [21.0, 23.0], [23.0, 25.0]]

    ratios = {tuple(b["k"]): b["ratio"] for b in block["bins"]}
    # Copper at 10 K: strong to k = 15, marginal to 19, noise after that. The
    # default transform runs to kmax 24, which is the point of the exercise.
    assert ratios[(3.0, 5.0)] > 50
    assert ratios[(15.0, 17.0)] > 3
    assert ratios[(19.0, 21.0)] < 2
    assert ratios[(23.0, 25.0)] < 1

    crossing = min(k for (k, _), ratio in ratios.items() if ratio < 2)
    assert 17 <= crossing <= 21


def test_the_bins_do_not_move_when_the_transform_range_does(client, example):
    """The defect this row exists to fix: epsilon_k alone cannot say where to cut.

    Larch measures the digest's other noise figure over the current Fourier
    range, so it more than doubles when kmax comes in from 24 to 16 and takes
    every ratio built on it along. These bins are measured against the whole
    support and must stay put, or a caller narrowing kmax would watch the
    crossing chase the window it is choosing.
    """
    target = example["groups"][0]["id"]
    wide = digest(client, example, target)

    narrowed = client.post(f"/api/athena/projects/{example['id']}/command", json={
        "version": example["version"], "action": "parameters",
        "group_ids": [target], "options": {"kmax": 16.0}}).json()
    narrow = digest(client, narrowed, target)

    assert narrow["noise"]["epsilon_k"] > 2 * wide["noise"]["epsilon_k"], (
        "the range-averaged figure is expected to move; that is the problem")
    assert narrow["signal_to_noise"]["epsilon_k"] == wide["signal_to_noise"]["epsilon_k"]
    assert narrow["signal_to_noise"]["bins"] == wide["signal_to_noise"]["bins"]


def test_a_short_scan_is_binned_to_its_own_support(client, example):
    """The 300 K scan stops at k 17.45; a trailing sliver is folded in, not shown."""
    report = digest(client, example, example["groups"][2]["id"])
    bins = report["signal_to_noise"]["bins"]

    assert report["signal_to_noise"]["over"][1] < 18
    assert bins[-1]["k"] == [15.0, 17.45]
    assert all(b["k"][1] - b["k"][0] >= 1.0 for b in bins), "no sliver windows"


def test_a_group_with_no_transform_says_so_rather_than_guessing(example):
    """chi(k) that never processed has no floor to measure, and no bins."""
    from xraylarch_web.agent_digest import _signal_to_noise

    group = dict(example["groups"][0])
    assert "unavailable" in _signal_to_noise(group, {})
