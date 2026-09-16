"""Native FEFF recovery, scientific guards, and read-only Artemis HTTP lifecycle."""
import copy
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.fitting import param, param_group
from larch.xafs import feffit, feffit_dataset, feffit_transform, feffpath, ff2chi
from pydantic import ValidationError

from xraylarch_web import artemis
from xraylarch_web.artemis import FitRequest, FitTransform, PathInput, copper_example, fit_group, inspect_path
from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


@pytest.fixture
def model():
    example = copper_example()
    return dict(version=0, parameters=example["parameters"], transform=example["transform"],
                paths=[{key: value for key, value in example["path"].items() if key != "metadata"} | {"id": "cu1", "label": "Cu first shell"}])


@pytest.fixture
def spectrum():
    path = feffpath(str(artemis._EXAMPLE), s02=0.9, e0=3, deltar=0.01, sigma2=0.008)
    data = Group()
    ff2chi([path], group=data, k=np.arange(301) * 0.05)
    chi = data.chi + np.random.default_rng(123).normal(0, 0.00005, len(data.k))
    return dict(id="synthetic-cu", label="Synthetic Cu", data_type="chi", processing_error=None,
                parameters={}, source={}, result=dict(effective=dict(rbkg=1), arrays=dict(k=data.k.tolist(), chi=chi.tolist())))


@pytest.mark.parametrize("space,weights", [("r", [2]), ("r", [1, 2, 3]), ("k", [2])])
def test_real_larch_recovers_known_structure_and_complex_residual(model, spectrum, space, weights):
    model["transform"].update(fitspace=space, kweight=weights)
    before = copy.deepcopy(spectrum)
    result = fit_group(spectrum, FitRequest(**model))
    assert result["success"] and result["statistics"]["errorbars"]
    values = {row["name"]: row["value"] for row in result["parameters"]}
    assert values["amp"] == pytest.approx(0.9, abs=0.001)
    assert values["del_e0"] == pytest.approx(3, abs=0.01)
    assert values["del_r"] == pytest.approx(0.01, abs=0.0001)
    assert values["sig2"] == pytest.approx(0.008, abs=0.00001)
    assert result["statistics"]["n_independent"] == pytest.approx(1 + 2 * 9 * 1.6 / math.pi)
    assert result["statistics"]["r_factor"] < 0.0001
    assert result["paths"][0]["metadata"]["degen"] == 12
    assert result["paths"][0]["values"]["s02"] == pytest.approx(values["amp"])
    assert result["correlations"]
    assert all(row["stderr"] is not None and row["stderr"] > 0 for row in result["parameters"])
    assert "FEFFIT RESULTS" in result["report"]
    assert "artemis-fit-" not in result["report"]
    r = result["r"]
    np.testing.assert_allclose(r["residual_re"], np.array(r["data_re"]) - r["model_re"])
    np.testing.assert_allclose(r["residual_im"], np.array(r["data_im"]) - r["model_im"])
    np.testing.assert_allclose(r["residual_mag"], np.hypot(r["residual_re"], r["residual_im"]))
    np.testing.assert_allclose(result["k"]["residual"], np.array(result["k"]["data"]) - result["k"]["model"])
    assert len({len(value) for value in r.values()}) == 1
    assert spectrum == before


def test_gds_constraints_bounds_and_duplicate_path_labels(model, spectrum):
    model["parameters"] += [dict(name="half", kind="set", value=0.5),
                            dict(name="amplitude", kind="def", expression="amp * half")]
    model["paths"][0]["s02"] = "amplitude"
    model["paths"].append(model["paths"][0] | {"id": "cu2"})
    result = fit_group(spectrum, FitRequest(**model))
    assert result["success"]
    assert len(result["paths"]) == 2
    values = {row["name"]: row for row in result["parameters"]}
    assert values["amp"]["value"] == pytest.approx(0.9, abs=0.001)
    assert values["half"]["value"] == 0.5 and values["half"]["kind"] == "set"
    assert values["amplitude"]["value"] == pytest.approx(values["amp"]["value"] / 2)
    assert result["statistics"]["n_varys"] == 4


def test_nonuniform_input_matches_independent_native_larch_pipeline(model, spectrum):
    arrays = spectrum["result"]["arrays"]
    # A real imported chi(k) can be sampled unevenly; interpolate a denser source
    # onto such a grid, then compare against an independently assembled core fit.
    original_k = np.asarray(arrays["k"])
    original_chi = np.asarray(arrays["chi"])
    irregular = original_k.copy()
    irregular[1:-1] += 0.01 * np.sin(np.arange(1, len(irregular) - 1))
    arrays["k"] = irregular.tolist()
    arrays["chi"] = np.interp(irregular, original_k, original_chi).tolist()
    actual = fit_group(spectrum, FitRequest(**model))
    native_data = Group(k=original_k, chi=np.interp(original_k, irregular, arrays["chi"]))
    native_parameters = param_group(**{item["name"]: param(item["value"], vary=True, min=item["min"], max=item["max"])
                                      for item in model["parameters"]})
    native_path = feffpath(str(artemis._EXAMPLE), s02="amp", e0="del_e0", deltar="del_r", sigma2="sig2")
    native_transform = feffit_transform(**(model["transform"] | {"kweight": 2}), kstep=0.05, nfft=2048)
    native_dataset = feffit_dataset(data=native_data, paths=[native_path], transform=native_transform)
    expected = feffit(native_parameters, native_dataset, max_nfev=2000)
    for row in actual["parameters"]:
        assert row["value"] == pytest.approx(expected.params[row["name"]].value, rel=1e-10, abs=1e-12)
        assert row["stderr"] == pytest.approx(expected.params[row["name"]].stderr, rel=1e-8)
    assert actual["statistics"]["r_factor"] == pytest.approx(expected.rfactor, rel=1e-10)
    np.testing.assert_allclose(actual["r"]["model_re"], native_dataset.model.chir.real, atol=1e-12)
    np.testing.assert_allclose(actual["r"]["model_im"], native_dataset.model.chir.imag, atol=1e-12)


@pytest.mark.parametrize("expression", ["__import__('os').getcwd()", "amp.real", "amp[0]", "[amp]", "unknown_name", "2 ** amp", "2 ** 100", "exp(10000)", "1 / 0", "1e309", "lambda: amp"])
def test_expression_allowlist_rejects_unsafe_undefined_or_nonfinite(model, spectrum, expression):
    model["paths"][0]["s02"] = expression
    with pytest.raises(WebInputError):
        fit_group(spectrum, FitRequest(**model))


@pytest.mark.parametrize("name", ["items", "keys", "values", "reff", "degen", "rmass", "sqrt", "pi", "class"])
def test_parameter_names_cannot_shadow_group_or_feff_symbols(model, name):
    model["parameters"][0]["name"] = name
    with pytest.raises(ValidationError):
        FitRequest(**model)


@pytest.mark.parametrize("change", ["unused", "cycle", "too_many", "negative_sigma", "duplicate_id", "disabled", "bounds"])
def test_invalid_models_do_not_reach_optimizer(model, spectrum, change, monkeypatch):
    def optimizer_must_not_run(*args, **kwargs):
        pytest.fail("Invalid model reached the Larch optimizer")
    monkeypatch.setattr(artemis, "feffit", optimizer_must_not_run)
    if change == "unused": model["parameters"].append(dict(name="unused", value=1))
    elif change == "cycle":
        model["parameters"] += [dict(name="first", kind="def", expression="second"), dict(name="second", kind="def", expression="first")]
    elif change == "too_many": model["transform"].update(kmin=3, kmax=4, rmin=1.4, rmax=1.5)
    elif change == "negative_sigma": model["paths"][0]["sigma2"] = "-sig2"
    elif change == "duplicate_id": model["paths"].append(model["paths"][0].copy())
    elif change == "disabled": model["paths"][0]["enabled"] = False
    elif change == "bounds": model["parameters"][0]["max"] = 0.5
    with pytest.raises((WebInputError, ValidationError)):
        fit_group(spectrum, FitRequest(**model))


@pytest.mark.parametrize("change", ["empty", "nonfinite", "mismatch", "nonmonotonic", "kmax", "kmin", "zero", "error", "xanes"])
def test_unusable_data_and_extrapolated_fit_ranges_are_rejected(model, spectrum, change):
    arrays = spectrum["result"]["arrays"]
    if change == "empty": arrays["chi"] = []
    elif change == "nonfinite": arrays["chi"][3] = float("nan")
    elif change == "mismatch": arrays["chi"].pop()
    elif change == "nonmonotonic": arrays["k"][3] = 0
    elif change == "kmax": model["transform"]["kmax"] = 16
    elif change == "kmin": arrays["k"] = [value + 4 for value in arrays["k"]]
    elif change == "zero": arrays["chi"] = [0] * len(arrays["chi"])
    elif change == "error": spectrum["processing_error"] = "autobk failed"
    elif change == "xanes": spectrum["data_type"] = "xanes"
    with pytest.raises(WebInputError):
        fit_group(spectrum, FitRequest(**model))


def test_inspect_real_feff_metadata_and_invalid_files():
    example = copper_example()
    metadata = example["path"]["metadata"]
    assert (metadata["absorber"], metadata["edge"], metadata["degen"], metadata["nleg"]) == ("Cu", "K", 12, 2)
    assert metadata["reff"] == 2.5478 and metadata["kmax"] == 20
    for invalid in ["../../feff.dat", "/tmp/feff.dat", "C:\\feff.dat", "feff\n.dat"]:
        with pytest.raises(ValidationError):
            PathInput(filename=invalid, content=example["path"]["content"])
    with pytest.raises(WebInputError, match="not a usable FEFF"):
        inspect_path(PathInput(filename="feff0001.dat", content="1 2 3\n4 5 6\n"))


@pytest.mark.parametrize("value", [[True], [2, 2], [-1], [4], []])
def test_weights_are_bounded_unique_real_integers(value):
    with pytest.raises(ValidationError):
        FitTransform(kweight=value)


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_root=tmp_path)
    with TestClient(create_app(settings)) as client:
        yield client, AthenaStore(settings)


def test_api_real_example_fit_readonly_and_stale_revision(client):
    client, store = client
    example = client.get("/api/artemis/examples/copper")
    assert example.status_code == 200
    example = example.json()
    inspected = client.post("/api/artemis/paths/inspect", json={key: example["path"][key] for key in ("filename", "content")})
    assert inspected.status_code == 200 and inspected.json() == example["path"]
    project = client.post("/api/athena/projects").json()
    project_url = f"/api/athena/projects/{project['id']}"
    project = client.post(f"{project_url}/command", json=dict(version=0, action="example")).json()
    group = project["groups"][0]
    endpoint = f"/api/artemis/projects/{project['id']}/groups/{group['id']}/fit"
    request = dict(version=project["version"], parameters=example["parameters"], transform=example["transform"],
                   paths=[{key: value for key, value in example["path"].items() if key != "metadata"} | dict(id="cu1")])
    response = client.post(endpoint, json=request)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["success"] and result["project_id"] == project["id"]
    assert result["version"] == project["version"] and result["group_id"] == group["id"]
    assert all(np.isfinite(result["r"][key]).all() for key in result["r"])
    assert client.get(project_url).json() == project
    assert client.post(endpoint, json=request | dict(version=0)).status_code == 409
    assert client.get(project_url).json() == project


def test_version_rechecked_after_fit_and_integration_drafts_blocked(client, model, spectrum, monkeypatch):
    client, store = client
    project = store.create()
    project["groups"] = [spectrum]
    store.storage.write_json(project["id"], "project.json", project)
    endpoint = f"/api/artemis/projects/{project['id']}/groups/{spectrum['id']}/fit"
    original = artemis.fit_group
    def concurrent_edit(group, request):
        result = original(group, request)
        project["version"] += 1
        store.storage.write_json(project["id"], "project.json", project)
        return result
    monkeypatch.setattr(artemis, "fit_group", concurrent_edit)
    response = client.post(endpoint, json=model)
    assert response.status_code == 409, response.text
    project["integration"] = True
    store.storage.write_json(project["id"], "project.json", project)
    response = client.post(endpoint, json=model | dict(version=1))
    assert response.status_code == 400
    assert "local project" in response.json()["error"]["message"]
