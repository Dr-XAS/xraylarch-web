"""Exercise a real crystallographic calculation through to EXAFS fitting."""
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.xafs import feffpath, ff2chi, find_exe

from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


def test_amcsd_generated_path_fits_known_structure_without_changing_spectrum(tmp_path):
    modules = ("rdinp", "pot", "xsph", "pathfinder", "genfmt", "ff2x")
    if any(find_exe(f"feff8l_{module}") is None for module in modules):
        pytest.skip("Bundled FEFF8L executables are unavailable on this platform")
    settings = Settings(data_root=tmp_path / "workspace")
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/artemis/feff/jobs", json={
            "amcsd_id": 13088, "absorber": "Cu", "edge": "K", "site_index": 1,
            "cluster_radius": 3.0, "path_radius": 3.0, "max_legs": 2, "max_paths": 10,
        })
        assert response.status_code in (200, 202), response.text
        job = response.json()
        deadline = time.monotonic() + 60
        while job["status"] in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(0.1)
            response = client.get(f"/api/artemis/feff/jobs/{job['id']}")
            assert response.status_code == 200, response.text
            job = response.json()
        assert job["status"] == "complete", job
        assert len(job["paths"]) == 1
        generated = job["paths"][0]
        assert generated["metadata"]["absorber"] == "Cu"
        assert generated["metadata"]["degen"] == 12
        assert generated["metadata"]["nleg"] == 2
        assert generated["metadata"]["reff"] == pytest.approx(2.5668, abs=0.0001)

        source = tmp_path / generated["filename"]
        source.write_text(generated["content"])
        known = {"amp": 0.9, "del_e0": 3, "del_r": 0.01, "sig2": 0.008}
        native_path = feffpath(str(source), s02=known["amp"], e0=known["del_e0"],
                               deltar=known["del_r"], sigma2=known["sig2"])
        data = Group()
        ff2chi([native_path], group=data, k=np.arange(301) * 0.05)
        chi = data.chi + np.random.default_rng(127).normal(0, 0.00005, len(data.k))
        group = dict(id="generated-cu", label="Known Cu structure", data_type="chi",
                     processing_error=None, parameters={}, source={},
                     result=dict(effective=dict(rbkg=1), arrays=dict(k=data.k.tolist(), chi=chi.tolist())))
        store = AthenaStore(settings)
        project = store.create()
        project["groups"] = [group]
        store.storage.write_json(project["id"], "project.json", project)
        project_url = f"/api/athena/projects/{project['id']}"
        before = client.get(project_url).json()
        example = client.get("/api/artemis/examples/copper").json()
        response = client.post(f"/api/artemis/projects/{project['id']}/groups/{group['id']}/fit", json={
            "version": project["version"], "parameters": example["parameters"],
            "transform": example["transform"],
            "paths": [{"id": "from-cif", "filename": generated["filename"], "content": generated["content"]}],
        })
        assert response.status_code == 200, response.text
        fitted = response.json()
        assert fitted["success"]
        values = {row["name"]: row["value"] for row in fitted["parameters"]}
        for name, tolerance in (("amp", 0.001), ("del_e0", 0.02), ("del_r", 0.0001), ("sig2", 0.00002)):
            assert values[name] == pytest.approx(known[name], abs=tolerance)
        assert fitted["statistics"]["r_factor"] < 0.0001
        assert client.get(project_url).json() == before
