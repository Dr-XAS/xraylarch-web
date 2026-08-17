from io import StringIO
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
def xas_arrays() -> tuple[np.ndarray, np.ndarray]:
    """Deterministic, adequately sampled XAS spectrum for Larch processing."""
    energy = np.linspace(8750.0, 9350.0, 1201)
    e0 = 8980.0
    k = np.sqrt(np.clip((energy - e0) / 3.80998212, 0.0, None))
    edge = 1.0 / (1.0 + np.exp(-(energy - e0) / 2.5))
    chi = 0.035 * np.sin(2.2 * k + 0.3) * np.exp(-0.17 * k)
    mu = 0.18 + 0.000018 * (energy - energy[0]) + 0.85 * edge * (1.0 + chi)
    return energy, mu


@pytest.fixture
def synthetic_xmu_bytes(xas_arrays) -> bytes:
    energy, mu = xas_arrays
    output = StringIO()
    np.savetxt(output, np.column_stack((energy, mu)), header="energy mu")
    return output.getvalue().encode("utf-8")
