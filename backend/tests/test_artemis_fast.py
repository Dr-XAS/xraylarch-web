"""The differentiable fit backend against the reference one, on the same fits.

The fast backend is only useful if it is the same fit, faster. These tests put
both backends on identical requests -- the synthetic copper model and all twelve
published benchmark models -- and require the fitted values, uncertainties and
goodness-of-fit numbers to agree.

Agree to what? Not to machine precision, and the reason is worth stating,
because it is the single most surprising thing about this backend. The two
forward models are the same equation: at the converged parameters their
weighted residuals differ by about 1e-13 (`test_the_two_forward_models_agree`).
What differs is the optimizer. Larch drives MINPACK with finite-difference
derivatives; this backend drives scipy's trust-region solver with an exact
Jacobian from automatic differentiation. The two solvers also differ in
algorithm, scaling and termination test, and they stop at slightly different
points: scored with Larch's own residual the differentiable backend's objective
is the smaller one on all twelve benchmarks, by 1e-12 to 1e-7 relative, which
is well inside either solver's stopping tolerance and is not traced to a cause
here.

So the parameters are not expected to be bit-identical, and a tolerance in
relative units would be measuring the wrong thing. A fitted value only means
anything to the precision of its own uncertainty, so that is the scale used
here: the two backends must place every parameter within a hundredth of its
own standard error. Measured across all twelve benchmarks the worst case is
0.0014 sigma, so this leaves a factor of seven in hand. It catches the
regressions that act on the model -- a wrong constant, a wrong window, a
mis-wired path -- because those move parameters rather than just rescaling the
objective. It does not catch a regression that leaves the fitted values alone:
a global error in the noise scale is the clear example, which is why
epsilon_k and n_independent are compared separately below.

Every test here skips when the differentiable engine is not installed. A
skipped test is not evidence: a deployment that intends to offer the fast
backend must run this suite with the engine present.
"""
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.fitting import group2params
from larch.xafs import feffpath, ff2chi

from xraylarch_web import artemis
from xraylarch_web.artemis import FitRequest, copper_example, fit_group
from xraylarch_web.artemis_fast import fast_engine_status, fast_fit_group
from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

from test_artemis_benchmarks import CASES, IDS, _group, _model, _request

pytestmark = pytest.mark.skipif(not fast_engine_status()["available"],
                                reason=f"differentiable engine unavailable: {fast_engine_status()['reason']}")

# How far apart the two backends may place a parameter, in units of that
# parameter's own standard error. Worst observed over the twelve benchmarks:
# 0.0014. Anything that changes the physics moves parameters by order 1 sigma
# or more, so this catches a real regression while tolerating the fact that
# one optimizer converges further than the other.
VALUE_SIGMA = 0.01
# The uncertainties are read from the curvature each solver estimates at its
# own stopping point, so they move a little more than the values do. Worst
# observed: 0.0033 relative.
STDERR_RTOL = 0.01
# Chi-square is quadratic in the parameter error near the minimum, so it is
# reproduced far more tightly than the parameters. The assertion is that the
# fast backend is never worse by more than this slack -- not that it is never
# worse at all, which would be a test of stopping rules rather than of physics.
# Observed: better in every case, by 1e-12 to 1e-7 relative.
CHI_SQUARE_SLACK = 1e-6
# n_independent and epsilon_k are inputs to the fit, not outcomes of it: both
# backends read them from the same Larch dataset and must get the same number.
INPUT_RTOL = 1e-12
# The two forward models are the same equation in different code. What is left
# is floating-point rounding; anything larger is a real disagreement.
PARITY_TOLERANCE = 1e-8
# Curve comparisons are made against the peak of the measured data, not against
# each array's own values: the arrays cross zero, so a relative tolerance is
# meaningless, and a residual must not be held to a tighter standard just
# because the fit is good. A difference of 1e-7 of the data is far below one
# pixel of the plot; the observed difference is 4e-10 of it.
CURVE_RTOL_OF_PEAK = 1e-7


def _both(spectrum, request_model):
    return fit_group(spectrum, request_model), fast_fit_group(spectrum, request_model)


def _assert_curves_match(actual, expected, scale, label):
    """Compare two plotted curves against the scale of the measured data."""
    np.testing.assert_allclose(np.asarray(actual, dtype=float), np.asarray(expected, dtype=float),
                               rtol=0, atol=CURVE_RTOL_OF_PEAK * scale,
                               err_msg=f"{label} differs by more than {CURVE_RTOL_OF_PEAK:g} of the data")


def _assert_same_fit(reference, fast):
    assert fast["success"] == reference["success"]
    assert fast["statistics"]["errorbars"] == reference["statistics"]["errorbars"]
    rows = {row["name"]: row for row in reference["parameters"]}
    assert {row["name"] for row in fast["parameters"]} == set(rows)
    for row in fast["parameters"]:
        expected = rows[row["name"]]
        assert row["kind"] == expected["kind"]
        if expected["stderr"] is None:
            # A Set parameter is an input, not a result: it must come back
            # unchanged, and it carries no error bar to measure against.
            assert row["stderr"] is None
            assert row["value"] == expected["value"], f"{row['name']} was not held fixed"
            continue
        off_by = abs(row["value"] - expected["value"]) / expected["stderr"]
        assert off_by <= VALUE_SIGMA, (
            f"{row['name']}: backends differ by {off_by:.3g} sigma "
            f"({row['value']:.10g} vs {expected['value']:.10g}, stderr {expected['stderr']:.3g})")
        np.testing.assert_allclose(row["stderr"], expected["stderr"], rtol=STDERR_RTOL,
                                   err_msg=f"{row['name']} stderr")
    for key in ("n_varys", "n_data"):
        assert fast["statistics"][key] == reference["statistics"][key]
    for key in ("n_independent", "epsilon_k"):
        np.testing.assert_allclose(fast["statistics"][key], reference["statistics"][key],
                                   rtol=INPUT_RTOL, err_msg=key)
    reference_chi = reference["statistics"]["chi_square"]
    assert fast["statistics"]["chi_square"] <= reference_chi * (1 + CHI_SQUARE_SLACK), (
        f"fast backend found a worse minimum: {fast['statistics']['chi_square']:.10g} "
        f"> {reference_chi:.10g}")


@pytest.fixture
def model():
    example = copper_example()
    return dict(version=0, parameters=example["parameters"], transform=example["transform"],
                paths=[{key: value for key, value in example["path"].items() if key != "metadata"}
                       | {"id": "cu1", "label": "Cu first shell"}])


@pytest.fixture
def spectrum():
    """One FEFF path at known parameters plus a little noise, as chi(k)."""
    path = feffpath(str(artemis._EXAMPLE), s02=0.9, e0=3, deltar=0.01, sigma2=0.008)
    data = Group()
    ff2chi([path], group=data, k=np.arange(301) * 0.05)
    chi = data.chi + np.random.default_rng(123).normal(0, 0.00005, len(data.k))
    return dict(id="synthetic-cu", label="Synthetic Cu", data_type="chi", processing_error=None,
                parameters={}, source={},
                result=dict(effective=dict(rbkg=1),
                            arrays=dict(k=data.k.tolist(), chi=chi.tolist())))


@pytest.mark.parametrize("space,weights", [("r", [2]), ("r", [1, 2, 3]), ("k", [2])])
def test_the_fast_backend_finds_the_same_minimum_as_feffit(model, spectrum, space, weights):
    model["transform"].update(fitspace=space, kweight=weights)
    reference, fast = _both(spectrum, FitRequest(**model))
    _assert_same_fit(reference, fast)


@pytest.mark.parametrize("dataset_name,model_name", CASES, ids=IDS)
def test_the_fast_backend_reproduces_every_published_benchmark_fit(dataset_name, model_name):
    dataset, entry = _model(dataset_name, model_name)
    reference, fast = _both(_group(dataset), _request(dataset, entry))
    _assert_same_fit(reference, fast)


@pytest.mark.parametrize("dataset_name,model_name", CASES, ids=IDS)
def test_the_two_forward_models_agree_at_the_converged_parameters(dataset_name, model_name):
    # This is the check that would catch a wrong constant, a wrong window or a
    # wrong interpolation in the differentiable path equation, each of which can
    # hide inside a refit because the optimizer absorbs it into the parameters.
    # It compares the two residuals at one set of parameters, so unlike the
    # fitted values it is not blunted by either optimizer's stopping rule.
    dataset, entry = _model(dataset_name, model_name)
    fast = fast_fit_group(_group(dataset), _request(dataset, entry))
    assert fast["metadata"]["engine_parity"] < PARITY_TOLERANCE


def test_the_fitted_curves_are_the_ones_the_reference_backend_would_draw(model, spectrum):
    reference, fast = _both(spectrum, FitRequest(**model))
    np.testing.assert_allclose(fast["k"]["x"], reference["k"]["x"], rtol=0, atol=0)
    np.testing.assert_allclose(fast["r"]["x"], reference["r"]["x"], rtol=0, atol=0)
    k_scale = float(np.max(np.abs(reference["k"]["data"])))
    r_scale = float(np.max(np.abs(reference["r"]["data_mag"])))
    for key in ("data", "model", "residual"):
        _assert_curves_match(fast["k"][key], reference["k"][key], k_scale, f"chi(k) {key}")
    for key in ("data_mag", "model_mag", "residual_mag"):
        _assert_curves_match(fast["r"][key], reference["r"][key], r_scale, f"chi(R) {key}")
    assert [path["id"] for path in fast["paths"]] == [path["id"] for path in reference["paths"]]
    for fast_path, reference_path in zip(fast["paths"], reference["paths"]):
        _assert_curves_match(fast_path["k"]["chi"], reference_path["k"]["chi"], k_scale,
                             f"path {fast_path['id']} chi(k)")
        for field, value in fast_path["values"].items():
            # A path parameter that came out wholly different means the path was
            # wired to the wrong expression, which no curve comparison catches
            # once the optimizer has absorbed it.
            np.testing.assert_allclose(value, reference_path["values"][field],
                                       rtol=1e-4, atol=1e-7, err_msg=field)


def test_constrained_parameters_carry_propagated_uncertainties(spectrum):
    """A Def parameter's error bar must come from the covariance, not be dropped."""
    example = copper_example()
    parameters = [dict(parameter) for parameter in example["parameters"]]
    for parameter in parameters:
        if parameter["name"] == "sig2":
            parameter.update(kind="def", expression="ss_base * 1.0", value=0,
                             min=None, max=None)
    parameters.append(dict(name="ss_base", kind="guess", value=0.005, min=0.0, max=0.05))
    request = dict(version=0, parameters=parameters, transform=example["transform"],
                   paths=[{key: value for key, value in example["path"].items() if key != "metadata"}
                          | {"id": "cu1", "label": "Cu first shell"}])
    reference, fast = _both(spectrum, FitRequest(**request))
    _assert_same_fit(reference, fast)
    derived = next(row for row in fast["parameters"] if row["name"] == "sig2")
    assert derived["kind"] == "def"
    assert derived["stderr"] is not None and derived["stderr"] > 0


def test_the_fast_backend_does_not_settle_for_a_measurably_worse_minimum(model, spectrum):
    """The headline claim of this backend, stated as its own test.

    _assert_same_fit folds this in, but it is the reason the parameter
    tolerance above is written in sigma rather than in digits, so it is worth
    failing on its own terms when it stops being true. The claim asserted is
    "no worse than CHI_SQUARE_SLACK relative", not "strictly better": a
    difference below that slack is within either optimizer's stopping rule.
    """
    reference, fast = _both(spectrum, FitRequest(**model))
    assert fast["statistics"]["chi_square"] <= reference["statistics"]["chi_square"] * (1 + CHI_SQUARE_SLACK)


@pytest.mark.parametrize("dataset_name,model_name", CASES, ids=IDS)
def test_larch_scores_the_two_answers_as_equivalent(dataset_name, model_name):
    """Score both answers with Larch's residual, so the new code cannot grade itself.

    The previous test compares a chi-square that artemis_fast computes. If that
    formula drifted from feffit's -- a wrong n_independent, a wrong weighting --
    the fast backend could look better while fitting worse. Here the only thing
    taken from the new code is the parameter values it proposes; the scoring is
    Larch's own.

    What is asserted is equivalence within CHI_SQUARE_SLACK, which is the
    defensible claim: the two objectives differ by far less than either
    optimizer's stopping tolerance, so their ordering is an observation about
    where each solver stopped and not evidence that one of them under-converges.
    The observed direction is that the differentiable backend's objective is the
    smaller one in all twelve cases, by 1e-12 to 1e-7 relative.
    """
    dataset, entry = _model(dataset_name, model_name)
    group, request = _group(dataset), _request(dataset, entry)
    reference, fast = _both(group, request)
    varied = [row["name"] for row in reference["parameters"] if row["kind"] == "guess"]
    scores = []
    for result in (reference, fast):
        values = {row["name"]: row["value"] for row in result["parameters"] if row["name"] in varied}
        with artemis._LARCH_LOCK, TemporaryDirectory(prefix="artemis-score-") as directory:
            inputs = artemis.fit_inputs(group, request, Path(directory))
            params = group2params(inputs.parameters)
            inputs.dataset.prepare_fit(params)
            for name, value in values.items():
                params[name].value = value
            params.update_constraints()
            scores.append(float(np.sum(np.asarray(inputs.dataset._residual(params), dtype=float) ** 2)))
    assert scores[1] <= scores[0] * (1 + CHI_SQUARE_SLACK), (
        f"Larch's own residual prefers the reference parameters by more than "
        f"{CHI_SQUARE_SLACK:g} relative: {scores[1]:.12g} > {scores[0]:.12g}")


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_root=tmp_path)
    with TestClient(create_app(settings)) as client:
        yield client, AthenaStore(settings)


def _example_project(client):
    project = client.post("/api/athena/projects").json()
    project = client.post(f"/api/athena/projects/{project['id']}/command",
                          json=dict(version=0, action="example")).json()
    return project, project["groups"][0]


def test_the_route_returns_the_same_shape_as_the_reference_route(client):
    """The two routes must be interchangeable, or the demo cannot switch between them."""
    client, _ = client
    example = copper_example()
    project, group = _example_project(client)
    base = f"/api/artemis/projects/{project['id']}/groups/{group['id']}"
    request = dict(version=project["version"], parameters=example["parameters"],
                   transform=example["transform"],
                   paths=[{key: value for key, value in example["path"].items()
                           if key != "metadata"} | dict(id="cu1")])
    reference = client.post(f"{base}/fit", json=request)
    fast = client.post(f"{base}/fit/fast", json=request)
    assert reference.status_code == 200, reference.text
    assert fast.status_code == 200, fast.text
    assert set(fast.json()) == set(reference.json())
    _assert_same_fit(reference.json(), fast.json())
    assert fast.json()["metadata"]["engine"] != reference.json()["metadata"]["engine"]


def test_the_fast_route_is_guarded_exactly_as_the_reference_route_is(client, spectrum):
    """A second fit route must not become an unguarded way into integration drafts.

    Those spectra are capability-guarded by Athena's integration router; a new
    endpoint that reached them without the same checks would be a hole, and a
    stale project version must still be refused so the fit cannot silently
    apply to data that has since changed.
    """
    client, store = client
    project = store.create()
    project["groups"] = [spectrum]
    store.storage.write_json(project["id"], "project.json", project)
    endpoint = f"/api/artemis/projects/{project['id']}/groups/{spectrum['id']}/fit/fast"
    example = copper_example()
    request = dict(version=project["version"], parameters=example["parameters"],
                   transform=example["transform"],
                   paths=[{key: value for key, value in example["path"].items()
                           if key != "metadata"} | dict(id="cu1")])
    assert client.post(endpoint, json=request | dict(version=project["version"] + 7)).status_code == 409
    project["integration"] = True
    store.storage.write_json(project["id"], "project.json", project)
    response = client.post(endpoint, json=request)
    assert response.status_code == 400, response.text
    assert "integration draft" in response.json()["error"]["message"]


def test_the_status_route_says_whether_the_engine_is_available(client):
    client, _ = client
    response = client.get("/api/artemis/fast-fit/status")
    assert response.status_code == 200, response.text
    status = response.json()
    assert status["available"] is True
    assert status["engine"] == "diffexafs_core.pathsum+jax"


def test_the_report_names_the_engine_and_its_timing(model, spectrum):
    fast = fast_fit_group(spectrum, FitRequest(**model))
    assert fast["metadata"]["engine"] == "diffexafs_core.pathsum+jax"
    assert "FAST FIT" in fast["report"]
    assert "parity" in fast["report"]


def test_both_engines_time_the_same_phases(model, spectrum):
    """The screen compared feffit's whole call with the fast optimizer loop alone.

    Each engine now reports the whole server-side fit, the fit call, and the
    optimizer loop inside it, nested in that order; only the fast engine has a
    compilation phase. A reader can then compare like with like.
    """
    reference, fast = _both(spectrum, FitRequest(**model))
    for result in (reference, fast):
        seconds = result["metadata"]["seconds"]
        assert 0 < seconds["optimizer"] <= seconds["fit"] <= seconds["total"]
    assert "compile" not in reference["metadata"]["seconds"]
    fast_seconds = fast["metadata"]["seconds"]
    assert fast_seconds["compile"] + fast_seconds["optimizer"] <= fast_seconds["fit"]


def test_degenerate_parameters_get_no_uncertainties_rather_than_finite_nonsense(spectrum):
    """Two guesses that only enter as a product cannot be told apart by any data.

    Inverting JᵀJ there returns finite but meaningless errors; the fast backend
    must withhold them and say why.
    """
    example = copper_example()
    parameters = [dict(parameter) for parameter in example["parameters"] if parameter["name"] != "amp"]
    parameters += [dict(name="amp_a", kind="guess", value=1.0, min=0.1, max=3.0),
                   dict(name="amp_b", kind="guess", value=0.9, min=0.1, max=3.0)]
    request = FitRequest(version=0, parameters=parameters, transform=example["transform"],
                         paths=[{key: value for key, value in example["path"].items() if key != "metadata"}
                                | {"id": "cu1", "label": "Cu first shell", "s02": "amp_a * amp_b"}])
    fast = fast_fit_group(spectrum, request)
    assert fast["statistics"]["errorbars"] is False
    assert fast["statistics"]["jacobian_rank"] < fast["statistics"]["n_varys"]
    assert all(row["stderr"] is None for row in fast["parameters"] if row["kind"] == "guess")
    assert any("not independently determined" in warning for warning in fast["warnings"])


def test_both_engines_flag_a_parameter_that_stopped_on_its_bound(model, spectrum):
    """The synthetic data has S0² = 0.9; capping amp at 0.6 pins it to the cap."""
    for parameter in model["parameters"]:
        if parameter["name"] == "amp":
            parameter.update(value=0.5, max=0.6)
    reference, fast = _both(spectrum, FitRequest(**model))
    for result in (reference, fast):
        assert any(warning.startswith("amp finished at its upper bound") for warning in result["warnings"]), result["warnings"]
