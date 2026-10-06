"""The web EXAFS fitting workflow against public spectra already fitted with Larch feffit.

Ten measured spectra from public databases, each with its FEFF85L scattering paths
and the feffit result recorded with them, are refitted here through the
app's own request model. The suite catches a change in the app that would move a
fitted distance, a sigma², an uncertainty or a goodness-of-fit number away from
what plain feffit gives for the same data, paths, starting values and bounds.
"""
import functools
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from xraylarch_web.artemis import FitRequest, fit_group

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "exafs-benchmarks"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())
DATASETS = {entry["name"]: entry for entry in MANIFEST["datasets"]}
CASES = [(dataset["name"], model["name"]) for dataset in MANIFEST["datasets"] for model in dataset["models"]]
IDS = [f"{dataset}-{model}" for dataset, model in CASES]

# Agreement measured when the fixture was recorded is below 3e-8 relative on every
# fitted value and uncertainty, and below 1e-13 on the R factor. The tolerances
# below leave room for a different BLAS or CPU while still failing on a change
# that moves a fitted number in the sixth significant digit. The absolute floors
# matter for the near-zero deltar values, where a relative measure is meaningless.
VALUE_RTOL, VALUE_ATOL = 1e-6, 1e-9
STDERR_RTOL, STDERR_ATOL = 1e-6, 1e-9
STATISTIC_RTOL = 1e-9
SUPPLIED_EPSILON_CHI_SQUARE_FACTOR = 2.0


def _model(dataset_name, model_name):
    dataset = DATASETS[dataset_name]
    return dataset, next(model for model in dataset["models"] if model["name"] == model_name)


def _request(dataset, model):
    """Rebuild the recorded fit as an app request: same paths, starting values and bounds."""
    recorded = model["expected"]["parameters"]
    shells = sorted({shell for _, shell in model["paths"]})
    names = ["amp", "enot"] + [f"{label}{shell}" for shell in shells for label in ("delr", "ss")]
    parameters = [dict(name=name, kind="guess", value=recorded[name]["initial"],
                       min=recorded[name]["min"], max=recorded[name]["max"]) for name in names]
    paths = [dict(id=f"p{position}", label=f"{filename} shell {shell}", filename=filename,
                  content=(FIXTURES / dataset["paths"][filename]["file"]).read_text(),
                  s02="amp", e0="enot", deltar=f"delr{shell}", sigma2=f"ss{shell}")
             for position, (filename, shell) in enumerate(model["paths"], start=1)]
    transform = dataset["transform"]
    return FitRequest(version=0, parameters=parameters, paths=paths,
                      transform=dict(fitspace=transform["fitspace"], kmin=transform["kmin"], kmax=transform["kmax"],
                                     kweight=[transform["kweight"]], dk=transform["dk"], window=transform["window"],
                                     rmin=transform["rmin"], rmax=transform["rmax"], dr=transform["dr"]))


def _group(dataset):
    table = np.genfromtxt(FIXTURES / dataset["chi"]["file"], delimiter=",", names=True)
    return dict(id=dataset["name"], label=dataset["title"], data_type="chi", processing_error=None,
                parameters={}, source={},
                result=dict(effective={}, arrays=dict(k=table["k_inv_angstrom"].tolist(), chi=table["chi"].tolist())))


@functools.lru_cache(maxsize=None)
def fitted(dataset_name, model_name):
    dataset, model = _model(dataset_name, model_name)
    return fit_group(_group(dataset), _request(dataset, model))


@pytest.mark.parametrize("dataset_name,model_name", CASES, ids=IDS)
def test_fitted_values_match_the_recorded_feffit_fit(dataset_name, model_name):
    _, model = _model(dataset_name, model_name)
    result = fitted(dataset_name, model_name)
    assert result["success"]
    recorded = model["expected"]["parameters"]
    assert {row["name"] for row in result["parameters"]} == set(recorded)
    for row in result["parameters"]:
        np.testing.assert_allclose(row["value"], recorded[row["name"]]["value"],
                                   rtol=VALUE_RTOL, atol=VALUE_ATOL, err_msg=row["name"])


@pytest.mark.parametrize("dataset_name,model_name", CASES, ids=IDS)
def test_uncertainties_match_the_recorded_feffit_fit(dataset_name, model_name):
    _, model = _model(dataset_name, model_name)
    result = fitted(dataset_name, model_name)
    assert result["statistics"]["errorbars"]
    recorded = model["expected"]["parameters"]
    for row in result["parameters"]:
        np.testing.assert_allclose(row["stderr"], recorded[row["name"]]["stderr"],
                                   rtol=STDERR_RTOL, atol=STDERR_ATOL, err_msg=row["name"])


@pytest.mark.parametrize("dataset_name,model_name", CASES, ids=IDS)
def test_fit_quality_and_sampling_match_the_recorded_feffit_fit(dataset_name, model_name):
    _, model = _model(dataset_name, model_name)
    statistics = fitted(dataset_name, model_name)["statistics"]
    expected = model["expected"]
    assert (statistics["n_varys"], statistics["n_data"]) == (expected["nvarys"], expected["ndata"])
    np.testing.assert_allclose(statistics["n_independent"], expected["n_independent"], rtol=STATISTIC_RTOL)
    np.testing.assert_allclose(statistics["r_factor"], expected["rfactor"], rtol=STATISTIC_RTOL)


@pytest.mark.parametrize("dataset_name,model_name", CASES, ids=IDS)
def test_the_optimizer_takes_the_recorded_number_of_steps(dataset_name, model_name):
    # A change in starting values, bounds or the residual shows up here first,
    # before it is large enough to move a fitted value past its tolerance.
    _, model = _model(dataset_name, model_name)
    assert fitted(dataset_name, model_name)["statistics"]["nfev"] == model["expected"]["nfev"]


@pytest.mark.parametrize("dataset_name,model_name", CASES, ids=IDS)
def test_goodness_of_fit_matches_feffit_once_both_use_the_same_noise_scale(dataset_name, model_name):
    # Two conventions separate the app's goodness of fit from the recorded one,
    # and neither of them is a difference in the fit:
    #  - the recorded fits were handed epsilon(k) = the RMS of chi(k) over the
    #    fit window, where the app uses Larch's estimate from the high-R part of
    #    the transform, and chi-square scales with 1/epsilon(k)**2;
    #  - Larch turns epsilon(k) into the epsilon(R) its residual divides by with
    #    a factor sqrt(2) smaller when the scale is supplied than when Larch
    #    estimates it, which doubles chi-square by itself. See
    #    docs/artemis-web.md; if Larch reconciles the two, this factor goes.
    # Undo both and the fits must agree. Anything left over is a real difference.
    dataset, model = _model(dataset_name, model_name)
    statistics = fitted(dataset_name, model_name)["statistics"]
    expected = model["expected"]
    scale = SUPPLIED_EPSILON_CHI_SQUARE_FACTOR * (statistics["epsilon_k"] / dataset["epsilon_k"]) ** 2
    np.testing.assert_allclose(statistics["chi_square"] * scale, expected["chi_square"], rtol=1e-6)
    np.testing.assert_allclose(statistics["reduced_chi_square"] * scale, expected["reduced_chi_square"], rtol=1e-6)
    # AIC and BIC are log-likelihoods, so the same rescaling is an additive shift.
    shift = statistics["n_independent"] * np.log(scale)
    np.testing.assert_allclose(statistics["aic"] + shift, expected["aic"], rtol=1e-6)
    np.testing.assert_allclose(statistics["bic"] + shift, expected["bic"], rtol=1e-6)


@pytest.mark.parametrize("dataset_name,model_name", CASES, ids=IDS)
def test_the_path_contributions_add_up_to_the_fitted_model(dataset_name, model_name):
    result = fitted(dataset_name, model_name)
    np.testing.assert_allclose(np.sum([path["k"]["chi"] for path in result["paths"]], axis=0),
                               result["k"]["model"], atol=1e-12)
    for component in ("re", "im"):
        np.testing.assert_allclose(np.sum([path["r"][component] for path in result["paths"]], axis=0),
                                   result["r"][f"model_{component}"], atol=1e-12)


@pytest.mark.parametrize("name", sorted(DATASETS), ids=sorted(DATASETS))
def test_the_benchmark_inputs_are_the_bytes_that_were_recorded(name):
    # These files were copied in from another repository, so the fit above only
    # means something while they are still the files the reference fit used.
    dataset = DATASETS[name]
    for entry in [dataset["chi"], *dataset["paths"].values()]:
        assert hashlib.sha256((FIXTURES / entry["file"]).read_bytes()).hexdigest() == entry["sha256"], entry["file"]
