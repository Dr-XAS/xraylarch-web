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
