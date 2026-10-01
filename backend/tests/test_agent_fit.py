"""An Artemis fit read in numbers: the distance the digest's peaks are not."""
import json

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import agent_suite, larchctl
from xraylarch_web.agent_suite import FOILS
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app
from tests.test_agent_views import numeric_runs

CUPRITE = "Cu₂O · room temperature"


@pytest.fixture
def http(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


@pytest.fixture
def run(http):
    return agent_suite.setup(http)


def fit(http, run, label=CUPRITE, view="summary", **changes):
    example = http.get("/api/artemis/examples/cuprite").json()
    paths = [{"id": f"p{index}", "filename": path["filename"], "content": path["content"]}
             for index, path in enumerate(example["paths"], start=1)]
    parameters = [row | changes.get(row["name"], {}) for row in example["parameters"]]
    version = http.get(f"/api/athena/projects/{run['project_id']}", params={"view": "summary"}).json()["version"]
    return http.post(f"/api/artemis/projects/{run['project_id']}/groups/{run['groups'][label]}/fit",
                     params={"view": view}, json={"version": version, "parameters": parameters,
                                                  "paths": paths, "transform": example["transform"]})


def test_the_summary_is_the_fitted_values_without_the_curves(http, run):
    response = fit(http, run)
    assert response.status_code == 200, response.text
    assert len(response.content) < 4000, "a fit's numbers, not the 250 KB it plots"
    reply = response.json()
    assert not [path for path, length in numeric_runs(reply) if length > 8]
    first = reply["paths"][0]
    assert first["scatterers"] == "Cu-O" and first["degen"] == 2
    # Cu2O's Cu-O bond is 1.85 A; the fit lands near it, where a |chi(R)| peak would not.
    assert 1.80 < first["r"] < 1.95
    assert first["r"] == pytest.approx(first["reff"] + first["deltar"], abs=1e-4)
    assert all(abs(row["value"]) >= 0.1 for row in reply["correlations"])
    assert reply["statistics"]["r_factor"] < 0.3 and "note" in reply


def test_a_parameter_pinned_at_its_bound_says_so(http, run):
    reply = fit(http, run, sig2={"value": 0.003, "max": 0.004}).json()
    sig2 = next(row for row in reply["parameters"] if row["name"] == "sig2")
    assert sig2["at_bound"] == "max"
    assert all("at_bound" not in row for row in reply["parameters"] if row["name"] != "sig2")


def test_the_full_reply_is_left_as_the_browser_has_it(http, run):
    reply = fit(http, run, view="full").json()
    assert {"k", "r", "plot_source", "report"} <= set(reply)


@pytest.fixture
def cli(http, run, capsys):
    def invoke(*argv, expect=0):
        capsys.readouterr()
        code = larchctl.main(["--project", run["project_id"], *argv], http=http)
        captured = capsys.readouterr()
        assert code == expect, captured.err or captured.out
        return captured.err if expect else captured.out
    return invoke


def test_the_cli_fits_the_bundled_cuprite_setup(cli):
    out = cli("fit", "Cu2O", "--example", "cuprite")
    assert "Fit succeeded" in out
    assert "Cu-O        2   1.8412" in out
    assert "r is reff + deltar" in out


def test_the_cli_runs_feff_on_a_structure_and_fits_the_first_shell(cli):
    """Copper foil's Cu-Cu distance is 2.55 A; the digest reports its peak at 2.30."""
    out = cli("fit", FOILS[0], "--structure", "11145")
    row = next(line for line in out.splitlines() if line.startswith("feff0001.dat"))
    scatterers, degen, reff, distance = row.split()[1:5]
    assert (scatterers, degen) == ("Cu-Cu", "12")
    assert 2.52 < float(distance) < 2.58


def test_the_cli_holds_a_fixed_parameter(cli, http, run):
    out = cli("--json", "fit", "Cu2O", "--example", "cuprite", "--fix", "amp=0.9", "-t", "kmax=11")
    reply = json.loads(out)
    amp = next(row for row in reply["parameters"] if row["name"] == "amp")
    assert (amp["kind"], amp["value"]) == ("set", 0.9)
    assert reply["transform"]["kmax"] == 11


@pytest.mark.parametrize("argv, message", [
    (("fit", "Cu2O"), "Give FEFF paths"),
    (("fit", "Cu2O", "--example", "cuprite", "-p", "nope=1"), "No fit parameter 'nope'"),
    (("fit", "Cu2O", "--example", "cuprite", "--structure", "11145"), "not both"),
])
def test_the_cli_refuses_a_fit_it_cannot_build(cli, argv, message):
    assert message in cli(*argv, expect=1)


def test_structures_lists_what_fit_can_use(cli):
    out = cli("structures", "copper", "--element", "Cu")
    assert "11145" in out and "Copper" in out


def test_a_fit_that_does_not_describe_the_data_says_so(http, run, cli):
    """A blind run fitted in k space, read "Fit succeeded", and had an R-factor of 0.37."""
    cli("do", "parameters", FOILS[0], "-o", "kmax=18")
    good = json.loads(cli("--json", "fit", FOILS[0], "--structure", "11145"))
    assert good["statistics"]["r_factor"] < 0.01 and good["concerns"] == []
    # The bundled Cu2O setup is a starting point, not a finished fit.
    assert any(concern.startswith("R-factor 0.1") for concern in fit(http, run).json()["concerns"])
    pinned = fit(http, run, sig2={"value": 0.003, "max": 0.004}).json()
    assert any("sig2 stopped at its max bound" in concern for concern in pinned["concerns"])


def test_the_cli_takes_the_k_range_the_group_was_given(cli):
    """Setting the group's kmax and then fitting at the route's k 3-12 was run 5's first complaint."""
    out = cli("fit", FOILS[0], "--structure", "11145")
    assert "k 3-12 (kweight 0,1,2,3, dk 2)" in out, "an untouched group keeps the fit's defaults"
    cli("do", "parameters", FOILS[0], "-o", "kmax=18")
    out = cli("fit", FOILS[0], "--structure", "11145", "-t", "kweight=2")
    assert "k 3-18 (kweight 2, dk 1)" in out
    assert "kmin, kmax, dk from the group's transform; kweight from -t" in out


def test_the_cli_cuts_the_group_kmax_to_where_feff_stops(cli):
    cli("do", "parameters", FOILS[0], "-o", "kmax=22")
    reply = json.loads(cli("--json", "fit", FOILS[0], "--structure", "11145"))
    assert reply["transform"]["kmax"] == 20
    assert reply["transform_from"]["kmax"] == "the group's, cut to where FEFF stops"


def test_the_cli_flags_a_fit_it_should_not_quote(cli):
    out = cli("fit", FOILS[0], "--structure", "11145", "-t", "fitspace=k")
    assert "CONCERN: R-factor" in out


def test_the_cli_scans_a_range_from_one_feff_calculation(cli, http, run):
    out = cli("fit", FOILS[0], "--structure", "11145", "--vary", "kmax=10,11", "--vary", "del_e0=2")
    assert "kmax=10" in out and "kmax=11" in out and "del_e0=2" in out
    assert "varying kmax: r spans" in out and "varying del_e0: r spans" in out
    jobs = [row for row in http.get(f"/api/athena/projects/{run['project_id']}/transcript").json()["records"]]
    assert all(row["action"] != "fit" for row in jobs), "fits are not commands"


def test_a_second_fit_on_the_same_structure_runs_no_feff(cli, tmp_path):
    first = json.loads(cli("--json", "fit", FOILS[0], "--structure", "11145"))
    second = json.loads(cli("--json", "fit", FOILS[0], "--structure", "11145", "-t", "kmax=11"))
    assert len(list((tmp_path / "artemis-feff").glob("*/status.json"))) == 1
    assert first["paths"][0]["r"] != second["paths"][0]["r"]


@pytest.mark.parametrize("argv, message", [
    (("--vary", "kmax"), "--vary looks like key=v1,v2"),
    (("--vary", "nope=1,2"), "--vary takes a transform key"),
    (("-t", "kweight=two"), "kweight needs integers"),
])
def test_the_cli_refuses_a_scan_it_cannot_run(cli, argv, message):
    assert message in cli("fit", "Cu2O", "--example", "cuprite", *argv, expect=1)


def test_capabilities_describe_the_bodies_the_blind_arms_had_to_guess(http):
    response = http.get("/api/artemis/capabilities")
    assert response.status_code == 200 and len(response.content) < 6000
    described = response.json()
    assert "default [0, 1, 2, 3]" in described["fit"]["transform"]["kweight"]
    assert "ge 1" in described["feff_job"]["body"]["site_index"]
    assert any("counts from 1" in note for note in described["feff_job"]["notes"])
    # The bundled example is the one complete body; it must fit the description.
    example = http.get("/api/artemis/examples/cuprite").json()
    assert {key for row in example["parameters"] for key in row} <= set(described["fit"]["parameter"])
    assert set(example["transform"]) <= set(described["fit"]["transform"])


def test_a_refused_field_says_what_it_wanted(http):
    response = http.post("/api/artemis/feff/jobs", json={
        "amcsd_id": 11145, "absorber": "Cu", "site_index": 0, "path_radius": 3, "cluster_radius": 5})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["fields"] == ["site_index"]
    assert "site_index: Input should be greater than or equal to 1" in error["message"]


def test_a_feff_job_can_be_polled_without_its_files(http):
    import time

    job = http.post("/api/artemis/feff/jobs", json={
        "amcsd_id": 11145, "absorber": "Cu", "site_index": 1, "path_radius": 3, "cluster_radius": 5}).json()
    deadline = time.monotonic() + 60
    while job["status"] in ("queued", "running") and time.monotonic() < deadline:
        time.sleep(0.2)
        job = http.get(f"/api/artemis/feff/jobs/{job['id']}", params={"view": "summary"}).json()
    assert job["status"] == "complete"
    summary = http.get(f"/api/artemis/feff/jobs/{job['id']}", params={"view": "summary"})
    full = http.get(f"/api/artemis/feff/jobs/{job['id']}")
    assert len(summary.content) < len(full.content) / 10
    first = summary.json()["paths"][0]
    assert (first["scatterers"], first["degen"], first["kmax"]) == ("Cu-Cu", 12, 20)
    assert "content" not in first and "content" in full.json()["paths"][0]


def _copper_job(http):
    import time

    job = http.post("/api/artemis/feff/jobs", json={
        "amcsd_id": 11145, "absorber": "Cu", "site_index": 1, "path_radius": 3, "cluster_radius": 5}).json()
    deadline = time.monotonic() + 60
    while job["status"] in ("queued", "running") and time.monotonic() < deadline:
        time.sleep(0.2)
        job = http.get(f"/api/artemis/feff/jobs/{job['id']}", params={"view": "summary"}).json()
    assert job["status"] == "complete"
    return job


def _fit_foil(http, run, paths):
    version = http.get(f"/api/athena/projects/{run['project_id']}", params={"view": "summary"}).json()["version"]
    return http.post(f"/api/artemis/projects/{run['project_id']}/groups/{run['groups'][FOILS[0]]}/fit",
                     params={"view": "summary"},
                     json={"version": version, "paths": paths, "transform": {"kmax": 16, "kweight": [2]},
                           "parameters": larchctl.DEFAULT_FIT_PARAMETERS})


def test_a_fit_can_name_a_feff_jobs_path_instead_of_carrying_it(http, run):
    job = _copper_job(http)
    named = _fit_foil(http, run, [{"id": "p1", "feff_job": job["id"], "feff_path": "feff0001"}])
    assert named.status_code == 200, named.text
    source = http.get(f"/api/artemis/feff/jobs/{job['id']}").json()["paths"][0]
    carried = _fit_foil(http, run, [{"id": "p1", "filename": source["filename"], "content": source["content"]}])
    assert named.json()["paths"] == carried.json()["paths"]
    assert 2.52 < named.json()["paths"][0]["r"] < 2.58


def test_a_named_path_the_job_does_not_have_is_refused_by_name(http, run):
    job = _copper_job(http)
    response = _fit_foil(http, run, [{"id": "p1", "feff_job": job["id"], "feff_path": "feff0099"}])
    assert response.status_code == 400
    assert "has no path feff0099; it has feff0001" in response.json()["error"]["message"]
    # A body that mixes the two forms is refused for its own fields, not for both shapes.
    response = _fit_foil(http, run, [{"id": "p1", "feff_job": job["id"]}])
    assert response.status_code == 422
    assert response.json()["error"]["fields"] == ["feff_path"]
