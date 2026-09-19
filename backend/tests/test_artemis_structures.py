"""Native AMCSD/site fidelity and bounded asynchronous FEFF execution."""
import json
import os
import stat
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from xraylarch_web import artemis_structures as structures
from xraylarch_web.artemis_structures import FeffJobRequest, FeffJobs, search_structures, structure_details
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


def request(**changes):
    return FeffJobRequest(amcsd_id=13088, absorber="Cu", site_index=1,
                          cluster_radius=3, path_radius=3, max_legs=2, **changes)


def test_copper_search_ranks_mineral_and_formula_before_publication_mentions():
    result = search_structures("copper", limit=25)
    assert result["results"][0]["mineral"] == "Copper"
    assert all(row["mineral"] != "<missing>" for row in result["results"])
    assert search_structures("Cu", limit=1)["results"][0]["formula"] == "Cu"
    assert search_structures("CuO", limit=1)["results"][0]["mineral"] == "Tenorite"
    assert search_structures("Fe2O3", limit=1)["results"][0]["formula"].replace(" ", "") == "Fe2O3"
    assert "curated" in result["source"]
    assert search_structures("13088")["results"][0]["id"] == 13088
    assert search_structures("9" * 100)["results"] == []
    assert search_structures("' OR 1=1 --")["results"] == []
    assert search_structures("%_")["results"] == []
    for row in search_structures("magnetite", element="Fe")["results"]:
        assert "Fe" in row["formula"]


def test_native_sites_preserve_global_indices_and_disorder_rejected(tmp_path):
    copper = structure_details(13088)
    assert copper["ordered"] and copper["supported"]
    assert copper["cell"]["a"] == 3.63
    assert copper["sites"][0] == dict(index=1, element="Cu", species="Cu", occupancy=1.0,
                                      multiplicity=4, wyckoff="4a", x=0, y=0, z=0)
    magnetite = structure_details(9994)
    assert [site["index"] for site in magnetite["sites"] if site["element"] == "Fe"] == [1, 2]
    assert [site["index"] for site in magnetite["sites"] if site["element"] == "O"] == [3]
    disordered = structure_details(1735)
    assert not disordered["supported"] and not disordered["ordered"]
    assert "occupancies" in disordered["warnings"][0]
    with pytest.raises(WebInputError, match="occupancies"):
        FeffJobs(tmp_path).start(FeffJobRequest(amcsd_id=1735, absorber="Ti", site_index=1))


def test_partial_single_species_occupancy_is_not_silently_filled():
    cif = structures._native_cif(13088)
    original = cif.atoms_occupancy
    try:
        cif.atoms_occupancy = [0.98]
        _, ordered = structures._supported_structure(cif)
        assert not ordered
    finally:
        cif.atoms_occupancy = original


@pytest.mark.parametrize("changes", [dict(path_radius=5, cluster_radius=3), dict(cluster_radius=7),
    dict(path_radius=1), dict(max_legs=6), dict(max_paths=101), dict(site_index=0), dict(edge="M5"),
    dict(amcsd_id=True), dict(cluster_radius=float("nan")), dict(filename="/tmp/feff.inp")])
def test_request_bounds_and_no_user_server_paths(changes):
    fields = dict(amcsd_id=13088, absorber="Cu", site_index=1)
    with pytest.raises(ValidationError):
        FeffJobRequest(**(fields | changes))


def test_absorber_site_edge_and_missing_records_fail_before_start(tmp_path):
    jobs = FeffJobs(tmp_path)
    for changes in [dict(absorber="Fe"), dict(site_index=2), dict(absorber="xx"), dict(amcsd_id=99_999_999)]:
        with pytest.raises(WebInputError):
            jobs.start(request().model_copy(update=changes))
    assert not list(jobs.root.glob("*/status.json"))


def test_native_input_preserves_absorber_global_site_and_explicit_feff_bounds():
    details = structure_details(9994)
    params = FeffJobRequest(amcsd_id=9994, absorber="Fe", site_index=2, cluster_radius=4, path_radius=3, max_legs=3)
    text = structures._prepare_input(params, details)
    assert "RPATH     3.000" in text and "NLEG      3" in text and "S02       1.0" in text
    site_line = next(line for line in text.splitlines() if "<- absorber" in line)
    assert "2" in site_line and "0.50000 0.50000 0.50000" in site_line
    assert "AMCSD structure 9994" in text


def test_two_slots_are_shared_across_managers_and_released(tmp_path):
    first, second = FeffJobs(tmp_path), FeffJobs(tmp_path)
    slot1, slot2 = first._slot(), second._slot()
    try:
        with pytest.raises(WebInputError, match="already running"):
            second._slot()
        slot1.close()
        new_slot = first._slot()
        new_slot.close()
    finally:
        slot1.close()
        slot2.close()


def test_feff_job_storage_repairs_private_permissions(tmp_path):
    root = tmp_path / "artemis-feff"
    root.mkdir(mode=0o777)
    root.chmod(0o777)
    jobs = FeffJobs(tmp_path)
    if os.name != "nt":
        assert stat.S_IMODE(root.stat().st_mode) == 0o700

    directory = jobs.root / ("a" * 32)
    directory.mkdir(mode=0o777)
    directory.chmod(0o777)
    assert jobs._directory(directory.name) == directory
    if os.name != "nt":
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    jobs._save(directory, {"status": "running"})
    if os.name != "nt":
        assert stat.S_IMODE((directory / "status.json").stat().st_mode) == 0o600
    jobs._write_private_text(directory / "source.cif", "data_test\n")
    if os.name != "nt":
        assert stat.S_IMODE((directory / "source.cif").stat().st_mode) == 0o600

    slot = jobs._slot()
    slot.close()
    if os.name != "nt":
        assert stat.S_IMODE((jobs.root / ".slot-0.lock").stat().st_mode) == 0o600


def test_count_pruning_does_not_remove_job_being_polled(tmp_path):
    jobs = FeffJobs(tmp_path)
    identifiers = [f"{index:032x}" for index in range(19)]
    for index, ident in enumerate(identifiers):
        directory = jobs.root / ident
        directory.mkdir(mode=0o700)
        jobs._save(directory, {
            "id": ident, "status": "complete", "created": time.time() - index,
            "elapsed_seconds": 0,
        })
        jobs._write_private_text(directory / "paths.json", "[]")
    assert jobs.get(identifiers[0])["paths"] == []
    assert (jobs.root / identifiers[0]).exists()


def test_poll_survives_another_worker_and_reports_interrupted_job(tmp_path):
    jobs = FeffJobs(tmp_path)
    ident = "a" * 32
    directory = jobs.root / ident
    directory.mkdir()
    record = dict(id=ident, status="running", stage="pot", created=time.time(), owner_pid=os.getpid(), elapsed_seconds=0)
    jobs._save(directory, record)
    assert FeffJobs(tmp_path).get(ident)["status"] == "running"
    record["created"] = time.time() - structures._TIMEOUT - 31
    jobs._save(directory, record)
    assert jobs.get(ident)["status"] == "failed"
    record["created"] = time.time() - 86401
    jobs._save(directory, record)
    with pytest.raises(WebInputError, match="expired"):
        jobs.get(ident)
    assert not directory.exists()
    with pytest.raises(WebInputError):
        jobs.get("../elsewhere")


def test_service_start_prunes_expired_job_data(tmp_path):
    root = tmp_path / "artemis-feff"
    directory = root / ("b" * 32)
    directory.mkdir(parents=True)
    (directory / "status.json").write_text(json.dumps({
        "status": "complete", "created": time.time() - 86401,
    }))
    FeffJobs(tmp_path)
    assert not directory.exists()


def test_module_timeout_kills_child_without_changing_process_cwd(tmp_path, monkeypatch):
    jobs = FeffJobs(tmp_path)
    class Child:
        killed = False
        def poll(self): return 0 if self.killed else None
        def kill(self): self.killed = True
        def wait(self, timeout):
            if self.killed: return -9
            raise subprocess.TimeoutExpired("feff8l_pot", timeout)
    child = Child()
    captured = {}
    def popen(args, **kwargs):
        captured.update(args=args, **kwargs)
        return child
    monkeypatch.setattr(structures.subprocess, "Popen", popen)
    before = Path.cwd()
    with (tmp_path / "log").open("wb") as log, pytest.raises(TimeoutError):
        jobs._run_module(Path("/fixed/feff8l_pot"), tmp_path, log, time.monotonic() - 1)
    assert child.killed and Path.cwd() == before
    assert captured["args"] == ["/fixed/feff8l_pot"] and captured["cwd"] == tmp_path
    assert "shell" not in captured
    if os.name != "nt":
        assert captured["umask"] == 0o077


def test_fast_module_output_limit_also_enforced(tmp_path, monkeypatch):
    jobs = FeffJobs(tmp_path)
    (tmp_path / "output").write_bytes(b"abc")
    monkeypatch.setattr(structures, "_MAX_DISK_BYTES", 2)
    class Done:
        def wait(self, timeout): return 0
        def poll(self): return 0
    monkeypatch.setattr(structures.subprocess, "Popen", lambda *args, **kwargs: Done())
    with (tmp_path / "log").open("wb") as log, pytest.raises(RuntimeError, match="output limit"):
        jobs._run_module(Path("/fixed/feff8l_pot"), tmp_path, log, time.monotonic() + 10)


def test_conversion_failure_is_terminal_and_releases_capacity(tmp_path, monkeypatch):
    def failed(*args): raise RuntimeError("deliberate converter failure")
    monkeypatch.setattr(structures, "_prepare_input", failed)
    jobs = FeffJobs(tmp_path)
    job = jobs.start(request())
    for _ in range(100):
        job = jobs.get(job["id"])
        if job["status"] != "running": break
        time.sleep(0.01)
    assert job["status"] == "failed" and "converter failure" in job["message"]
    slot1, slot2 = jobs._slot(), jobs._slot()
    slot1.close(); slot2.close()


def test_failed_status_write_still_releases_job_slot(tmp_path, monkeypatch):
    jobs = FeffJobs(tmp_path)
    class Slot:
        closed = False
        def close(self): self.closed = True
    slot = Slot()
    def failed(*args): raise OSError("disk full")
    monkeypatch.setattr(structures, "_prepare_input", failed)
    monkeypatch.setattr(jobs, "_save", failed)
    with pytest.raises(OSError, match="disk full"):
        jobs._run(tmp_path, {"id": "a" * 32}, request(), {}, {}, slot)
    assert slot.closed


def test_http_search_details_validation_and_missing_database(tmp_path, monkeypatch):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        found = client.get("/api/artemis/structures", params=dict(q="copper", limit=2))
        assert found.status_code == 200 and found.json()["results"][0]["mineral"] == "Copper"
        assert client.get("/api/artemis/structures/13088").json()["sites"][0]["index"] == 1
        assert client.get("/api/artemis/structures", params=dict(limit=100)).status_code == 422
        bad = client.post("/api/artemis/feff/jobs", json=request().model_dump() | dict(site_index=2))
        assert bad.status_code == 400 and bad.json()["error"]["recovery"]
        assert client.get("/api/artemis/structures/9999999999999999999999").status_code == 400
        monkeypatch.setattr(structures, "_DATABASE", tmp_path / "missing.db")
        response = client.get("/api/artemis/structures", params=dict(q="copper"))
        assert response.status_code == 400 and "database is unavailable" in response.json()["error"]["message"]
