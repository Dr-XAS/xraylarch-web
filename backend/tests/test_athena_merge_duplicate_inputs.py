"""Repeated input warnings must not alter native merge arithmetic."""
from copy import deepcopy

import numpy as np
import pytest

from xraylarch_web.athena_merge import MergeOptions, merge
from xraylarch_web.athena_science import AthenaParameters


def spectrum(ident, *, length=40, delta=0.0, data_type="mu"):
    x = np.linspace(8900, 9100, length)
    y = np.sin(x / 100) + 2 + delta
    return dict(id=ident, label=ident, energy=x.tolist(), mu=y.tolist(),
                data_type=data_type, source={}, parameters=AthenaParameters().model_dump(),
                result=dict(arrays=dict(energy=x.tolist(), norm=y.tolist()),
                            effective=dict(edge_step=1.0)))


def repeated_warnings(result):
    return [warning for warning in result["warnings"] if "identical input arrays" in warning]


@pytest.mark.parametrize("array", ["mu", "norm"])
def test_warns_for_contributing_duplicates_without_changing_input_or_merge(array):
    groups = [spectrum("scan"), spectrum("scan-copy"), spectrum("independent", delta=0.2)]
    before = deepcopy(groups)
    result = merge(groups, MergeOptions(array=array))
    assert len(repeated_warnings(result)) == 1
    assert "scan-copy" in repeated_warnings(result)[0]
    assert "independent acquisitions" in repeated_warnings(result)[0]
    np.testing.assert_allclose(result["y"], (2 * np.asarray(groups[0]["mu"][:-1]) + np.asarray(groups[2]["mu"][:-1])) / 3)
    assert [member["coefficient"] for member in result["members"]] == [1 / 3] * 3
    assert groups == before


def test_excluded_and_zero_weight_duplicates_do_not_warn():
    groups = [spectrum("long", length=60), spectrum("short"), spectrum("short-copy"), spectrum("other-long", length=60, delta=0.2)]
    result = merge(groups, MergeOptions())
    assert not repeated_warnings(result)
    assert len(result["excluded"]) == 2
    groups = [spectrum("scan"), spectrum("copy"), spectrum("independent", delta=0.2)]
    assert not repeated_warnings(merge(groups, MergeOptions(weights={"copy": 0})))


def test_different_inputs_and_theory_are_not_reported_as_repeat_measurements():
    assert not repeated_warnings(merge([spectrum("a"), spectrum("b", delta=0.01)], MergeOptions()))
    groups = [spectrum("theory-a"), spectrum("theory-b")]
    for group in groups:
        group["source"]["tags"] = ["theory"]
    assert not repeated_warnings(merge(groups, MergeOptions()))
