import numpy as np
import pytest

from xraylarch_web.contracts import RecipeDraft
from xraylarch_web.errors import WebInputError
from xraylarch_web.parsing import parse_upload
import xraylarch_web.processing as processing_module
from xraylarch_web.processing import run_processing, validate_mapping, validate_recipe


def test_run_processing_preserves_raw_arrays_and_effective_values(xas_arrays):
    energy, mu = xas_arrays
    raw_energy = energy.copy()
    raw_mu = mu.copy()

    result = run_processing(energy, mu, RecipeDraft())

    assert np.array_equal(energy, raw_energy)
    assert np.array_equal(mu, raw_mu)
    assert result.effective.e0 > energy.min()
    assert result.effective.edge_step > 0
    assert result.effective.e0_automatic is True
    assert result.effective.edge_step_automatic is True
    assert result.effective.pre1 == pytest.approx(-230.0)
    assert result.effective.pre2 == pytest.approx(-115.0)
    assert result.effective.norm1 == pytest.approx(25.0)
    assert result.effective.norm2 == pytest.approx(370.0)
    assert result.effective.nnorm == 2
    assert result.effective.pre1_automatic is True
    assert result.effective.pre2_automatic is True
    assert result.effective.norm1_automatic is True
    assert result.effective.norm2_automatic is True
    assert result.effective.nnorm_automatic is True
    assert result.effective.rbkg == pytest.approx(1.0)
    assert result.effective.kweight == 2
    assert result.effective.autobk_kmin == 0
    assert result.effective.autobk_kmax == pytest.approx(9.85)
    assert result.effective.autobk_kmax_automatic is True
    assert result.effective.autobk_dk == pytest.approx(0.1)
    assert result.effective.autobk_dk_automatic is True
    assert result.effective.autobk_window == "hanning"
    assert result.effective.autobk_window_automatic is True
    assert result.effective.xftf_kmin == 0
    assert result.effective.xftf_kmax == 20
    assert result.effective.xftf_kmax_automatic is True
    assert result.effective.xftf_dk == 1
    assert result.effective.xftf_dk2 == 1
    assert result.effective.xftf_dk2_automatic is True
    assert result.effective.xftf_window == "kaiser"
    assert {trace.id for trace in result.plots} == {
        "raw_mu",
        "norm_mu",
        "chi_k",
        "chi_r",
    }
    assert all(np.isfinite(trace.x).all() for trace in result.plots)
    assert all(np.isfinite(trace.y).all() for trace in result.plots)


def test_effective_rbkg_records_larch_clamp(xas_arrays):
    energy, mu = xas_arrays
    recipe = RecipeDraft(rbkg=0.01)

    result = run_processing(energy, mu, recipe)

    assert result.effective.rbkg == pytest.approx(2 * np.pi / (recipe.kstep * recipe.nfft))
    assert result.effective.rbkg > recipe.rbkg


def test_default_fourier_range_uses_larch_automatic_value(xas_arrays, monkeypatch):
    energy, mu = xas_arrays
    real_xftf = processing_module.xftf
    captured_arguments = {}

    def recording_xftf(*args, **kwargs):
        captured_arguments.update(kwargs)
        return real_xftf(*args, **kwargs)

    monkeypatch.setattr(processing_module, "xftf", recording_xftf)

    result = run_processing(energy, mu, RecipeDraft())

    assert "kmax" not in captured_arguments
    assert result.effective.xftf_kmax == 20.0
    assert result.effective.autobk_kmax == pytest.approx(9.85)


def test_validate_recipe_reports_all_invalid_ranges_without_running_larch(xas_arrays):
    energy, _ = xas_arrays

    issues = validate_recipe(RecipeDraft(kmin=10, kmax=5, rbkg=0), energy)

    assert {issue.code for issue in issues} >= {"k_range_invalid", "rbkg_invalid"}


def test_validate_recipe_rejects_unsafe_fft_resource_requests(xas_arrays):
    energy, _ = xas_arrays

    issues = validate_recipe(
        RecipeDraft(nfft=524_288, kstep=0.0001, rmax_out=20_000),
        energy,
        max_nfft=262_144,
    )

    assert {issue.code for issue in issues} >= {
        "nfft_too_large",
        "kstep_too_small",
        "rmax_out_invalid",
    }


def test_validate_mapping_rejects_non_monotonic_energy():
    parsed = parse_upload(b"# energy mu\n3 1\n2 2\n4 3\n", "bad.dat")

    with pytest.raises(WebInputError, match="strictly increasing") as error:
        validate_mapping(parsed, "energy", "mu")

    assert error.value.code == "invalid_mapping"


def test_validate_mapping_selects_the_second_duplicate_by_column_id():
    parsed = parse_upload(
        b"energy,mu,mu\n1,2,20\n2,3,30\n3,4,40\n",
        "duplicates.csv",
    )

    energy, signal = validate_mapping(parsed, "column_0001", "column_0003")

    assert energy.tolist() == [1.0, 2.0, 3.0]
    assert signal.tolist() == [20.0, 30.0, 40.0]


def test_validate_mapping_accepts_only_unique_legacy_names():
    parsed = parse_upload(
        b"energy,mu,mu\n1,2,20\n2,3,30\n3,4,40\n",
        "duplicates.csv",
    )

    energy, _ = validate_mapping(parsed, "energy", "column_0003")
    assert energy.tolist() == [1.0, 2.0, 3.0]

    with pytest.raises(WebInputError) as error:
        validate_mapping(parsed, "column_0001", "mu")

    assert error.value.code == "invalid_mapping"
