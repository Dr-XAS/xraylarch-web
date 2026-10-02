"""Independent disorder physics, changing fit parameters, and path isolation."""
import copy
import math

import numpy as np
import pytest
from lmfit import Parameters
from larch import Group
from larch.xafs import feffpath, ff2chi
from larch.xafs.sigma2_models import EINS_FACTOR, sigma2_eins
from scipy.integrate import quad
from larch.io import read_session
from test_artemis import model, spectrum
from test_artemis_persistence import workspace, draft, post

from xraylarch_web import artemis
from xraylarch_web.artemis import FitRequest, FitParameter, _expression, _evaluate, fit_group
from xraylarch_web.artemis_disorder import (
    evaluate_disorder, install_disorder_functions, runtime_expression,
)
from xraylarch_web.errors import WebInputError
from xraylarch_web.artemis_persistence import validate_result

FILES = [artemis._EXAMPLE, artemis._CUPRITE_EXAMPLE / "feff0001.dat",
         artemis._CUPRITE_EXAMPLE / "feff0003.dat"]


def independent_debye(path, temperature, theta):
    """Adaptive quadrature and length gradients, independent of Larch's integrator."""
    atoms = path._feffdat.geom
    positions = np.array([atom[4:7] for atom in atoms], dtype=float)
    legs = np.roll(positions, -1, axis=0) - positions
    directions = legs / np.linalg.norm(legs, axis=1)[:, None]
    gradients = (np.roll(directions, 1, axis=0) - directions) / 2
    total = 0
    for i, atom in enumerate(atoms):
        for j, other in enumerate(atoms):
            distance = np.linalg.norm(positions[i] - positions[j])
            rx = 4.5693349700844 * distance / path._feffdat.rnorman
            def integrand(w):
                thermal = math.tanh(theta * w / (2 * temperature)) if temperature else 1
                return w * np.sinc(rx * w / np.pi) / thermal
            covariance = 72.7630804732553 / (theta * math.sqrt(atom[3] * other[3])) * quad(integrand, 0, 1, epsabs=1e-12)[0]
            total += np.dot(gradients[i], gradients[j]) * covariance
    return total


@pytest.mark.parametrize("filename", FILES)
@pytest.mark.parametrize("temperature", [0, 10, 300, 1000])
def test_debye_matches_independent_quadrature(filename, temperature):
    path = feffpath(str(filename))
    actual = evaluate_disorder("sigma2_debye", temperature, 350, path)
    assert actual == pytest.approx(independent_debye(path, temperature, 350), rel=1e-8)


@pytest.mark.parametrize("filename", FILES)
def test_einstein_native_agreement_and_zero_point(filename):
    path = feffpath(str(filename))
    for temperature in (10, 300, 1000):
        assert evaluate_disorder("eins", temperature, 350, path) == pytest.approx(sigma2_eins(temperature, 350, path), rel=1e-13)
    zero = EINS_FACTOR * sum(1 / atom[3] for atom in path._feffdat.geom) / 350
    assert evaluate_disorder("eins", 0, 350, path) == pytest.approx(zero, rel=1e-13)


@pytest.mark.parametrize("function", ["eins", "debye", "sigma2_eins", "sigma2_debye"])
def test_lmfit_copy_reads_current_geometry_and_rejects_invalid_runtime(function):
    first, second = [feffpath(str(filename)) for filename in FILES[:2]]
    parameters = Parameters()
    install_disorder_functions(parameters)
    parameters._asteval.symtable.update(feffpath=first._feffdat, temp=300, theta=350)
    expression = runtime_expression(f"{function}(temp, theta)")
    copied = copy.deepcopy(parameters)
    copied._asteval.symtable["feffpath"] = second._feffdat
    assert copied._asteval(expression) == pytest.approx(evaluate_disorder(function, 300, 350, second))
    assert copied._asteval(expression) != pytest.approx(parameters._asteval(expression))
    for temperature, theta in [(-1, 350), (300, 0), (300, -1), (math.inf, 350), (300, math.nan)]:
        with pytest.raises(ValueError):
            copied._asteval.symtable[function](temperature, theta, second._feffdat)


@pytest.mark.parametrize("expression", [
    "sigma2_eins(300)", "sigma2_debye(300,350,feffpath)", "eins(t=300,theta=350)",
    "eins.__call__(300,350)", "debye(300,350)[0]", "eins(300,350) + __import__('os')",
])
def test_disorder_preserves_bounded_grammar(expression):
    with pytest.raises(WebInputError):
        _expression(expression, set(), "path.sigma2", allow_disorder=True)


def test_disorder_scope_and_dependency_validation():
    for field in ("global_def", "path.s02"):
        with pytest.raises(WebInputError, match="current FEFF path"):
            _expression("eins(temp,theta)", {"temp", "theta"}, field)
    _, names = _expression("static + eins(temp,theta)", {"static", "temp", "theta"}, "path.sigma2", allow_disorder=True)
    assert names == {"static", "temp", "theta"}
    for name in ("eins", "debye", "sigma2_eins", "sigma2_debye", "feffpath"):
        with pytest.raises(ValueError):
            FitParameter(name=name)
    tree, _ = _expression("eins(-1, 350)", set(), "path.sigma2", allow_disorder=True)
    with pytest.raises(WebInputError, match="temperature"):
        _evaluate(tree, {}, "path.sigma2", path=feffpath(str(FILES[0])))


def test_report_preserves_numbers_when_sigma2_uses_scientific_notation(model, spectrum):
    model["parameters"] = [row for row in model["parameters"] if row["name"] != "sig2"]
    model["paths"][0]["sigma2"] = "1e-2"
    result = fit_group(spectrum, FitRequest(**model))
    assert result["paths"][0]["values"]["sigma2"] == .01
    assert "1e-2000" not in result["report"]
    assert "sigma2 =  0.0100000  := '1e-2'" in result["report"]


@pytest.mark.parametrize("function", ["sigma2_eins", "sigma2_debye", "eins", "debye"])
def test_actual_fit_recovers_temperature_across_distinct_paths(function):
    # Shared theta, distinct Cu-Cu and Cu-O masses/geometry, fixed static offset.
    native_paths = [feffpath(str(filename), s02=.9, e0=3, deltar=.01) for filename in FILES[:2]]
    for path in native_paths:
        path.sigma2 = .001 + evaluate_disorder(function, 300, 350, path)
    data = Group()
    ff2chi(native_paths, group=data, k=np.arange(301) * .05)
    spectrum = dict(id="thermal", data_type="chi", result=dict(arrays=dict(k=data.k.tolist(),
        chi=(data.chi + np.random.default_rng(321).normal(0, 1.e-6, len(data.k))).tolist())))
    parameters = [row for row in artemis.copper_example()["parameters"] if row["name"] != "sig2"]
    parameters.extend([dict(name="temp", kind="set", value=300), dict(name="static", kind="set", value=.001),
                       dict(name="theta", kind="guess", value=450, min=100, max=1000)])
    expression = f"static + {function}(temp, theta)"
    request = FitRequest(version=0, parameters=parameters, paths=[
        dict(id=f"path{i}", filename=file.name, content=file.read_text(), sigma2=expression)
        for i, file in enumerate(FILES[:2])])
    before = request.model_dump()
    result = fit_group(spectrum, request)
    values = {row["name"]: row["value"] for row in result["parameters"]}
    assert result["success"]
    assert values["theta"] == pytest.approx(350, abs=.02)
    assert result["statistics"]["r_factor"] < 1.e-7
    for original, fitted in zip(native_paths, result["paths"]):
        assert fitted["values"]["sigma2"] == pytest.approx(.001 + evaluate_disorder(function, 300, values["theta"], original), rel=1.e-10)
        assert fitted["sigma2_expression"] == expression
    assert request.model_dump() == before
    assert "feffpath" not in result["report"]
    np.testing.assert_allclose(np.sum([path["k"]["chi"] for path in result["paths"]], axis=0), result["k"]["model"], atol=1e-12)


@pytest.mark.parametrize("function,canonical", [("eins", "sigma2_eins"), ("debye", "sigma2_debye")])
def test_saved_fit_exchange_and_native_export_keep_thermal_model(workspace, model, tmp_path, function, canonical):
    store, client, project, group_id = workspace
    model["parameters"] = [row for row in model["parameters"] if row["name"] != "sig2"] + [
        dict(name="temperature", kind="set", value=300),
        dict(name="theta", kind="guess", value=350, min=100, max=1000)]
    expression = f"{function}(temperature, theta)"
    model["paths"][0]["sigma2"] = expression
    project = post(client, project, group_id, "fit-saved", model=draft(model))["project"]
    state = store.load(project["id"])["groups"][0]["artemis"]
    result = state["history"][0]["result"]
    assert result["paths"][0]["sigma2_expression"] == expression
    legacy = copy.deepcopy(result)
    del legacy["paths"][0]["sigma2_expression"]
    assert validate_result(legacy) == legacy
    for format in ("json", "prj"):
        output = store.export_project(project["id"], format=format)
        destination = store.create()
        restored = store.restore(destination["id"], destination["version"], output, f"thermal.{format}")
        saved = restored["groups"][0]["artemis"]
        assert saved["model"] == state["model"]
        assert saved["history"][0]["result"] == result
    response = client.get(f"/api/artemis/projects/{project['id']}/groups/{group_id}/export",
                          params={"format": "larix", "version": project["version"]})
    assert response.status_code == 200, response.text
    file = tmp_path / "thermal.larix"
    file.write_bytes(response.content)
    session = read_session(str(file))
    data = session.symbols[next(iter(session.symbols["_xasgroups"].values()))]
    paths, _, _ = data.feffit_model
    assert next(iter(paths.values())).sigma2 == f"{canonical}(temperature, theta)"
