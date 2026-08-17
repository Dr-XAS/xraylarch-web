from pathlib import Path
import sys

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))


@pytest.fixture
def sample_xmu_bytes() -> bytes:
    return (Path(__file__).parent / "fixtures" / "cu_rt01.xmu").read_bytes()


@pytest.fixture
def data_root(tmp_path, monkeypatch):
    monkeypatch.setenv("XRAYLARCH_DATA_ROOT", str(tmp_path))
    return tmp_path


@pytest.fixture
def xas_arrays(sample_xmu_bytes) -> tuple[np.ndarray, np.ndarray]:
    from xraylarch_web.parsing import parse_upload

    parsed = parse_upload(sample_xmu_bytes, "cu_rt01.xmu")
    return parsed.arrays["energy"].copy(), parsed.arrays["mu"].copy()
