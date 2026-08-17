import numpy as np
import pytest

from xraylarch_web.contracts import RecipeDraft
from xraylarch_web.errors import WebInputError
from xraylarch_web.parsing import parse_upload
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
    assert {trace.id for trace in result.plots} == {
        "raw_mu",
        "norm_mu",
        "chi_k",
        "chi_r",
    }
    assert all(np.isfinite(trace.x).all() for trace in result.plots)
    assert all(np.isfinite(trace.y).all() for trace in result.plots)


def test_validate_recipe_reports_all_invalid_ranges_without_running_larch(xas_arrays):
    energy, _ = xas_arrays

    issues = validate_recipe(RecipeDraft(kmin=10, kmax=5, rbkg=0), energy)

    assert {issue.code for issue in issues} >= {"k_range_invalid", "rbkg_invalid"}


def test_validate_mapping_rejects_non_monotonic_energy(sample_xmu_bytes):
    parsed = parse_upload(b"# energy mu\n3 1\n2 2\n4 3\n", "bad.dat")

    with pytest.raises(WebInputError, match="strictly increasing") as error:
        validate_mapping(parsed, "energy", "mu")

    assert error.value.code == "invalid_mapping"
