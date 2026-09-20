from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
import hashlib
import hmac
import json
import math
import re

import pytest
from fastapi.testclient import TestClient

from xraylarch_web.config import Settings
from xraylarch_web.integration_service import v2_signing_payload
from xraylarch_web.main import create_app


SECRET = "integration-secret-that-is-long-enough"
ISSUER = "drxas"
AUDIENCE = "xraylarch-web"


@pytest.fixture
def now():
    # Session lifetimes start with the test, not when pytest collects this file.
    return datetime.now(UTC).replace(microsecond=0)


def settings(tmp_path, **overrides):
    defaults = {
        "integration_api_enabled": True, "browser_consume_enabled": True,
        "integration_issuer": ISSUER, "integration_audience": AUDIENCE,
        "integration_hmac_secret": SECRET,
    }
    return Settings(data_root=tmp_path, **(defaults | overrides))


def signed_headers(method, path, raw, *, nonce="n" * 32, timestamp=None):
    if timestamp is None:
        timestamp = datetime.now(UTC)
    stamp = str(int(timestamp.timestamp()))
    digest = hashlib.sha256(raw).hexdigest()
    payload = v2_signing_payload(
        method=method, path=path, issuer=ISSUER, audience=AUDIENCE,
        timestamp=stamp, nonce=nonce, body_sha256=digest,
    )
    signature = hmac.new(SECRET.encode(), payload, hashlib.sha256).hexdigest()
    return {
        "content-type": "application/json",
        "X-DrXAS-Issuer": ISSUER,
        "X-DrXAS-Audience": AUDIENCE,
        "X-DrXAS-Timestamp": stamp,
        "X-DrXAS-Nonce": nonce,
        "X-DrXAS-Body-SHA256": digest,
        "X-DrXAS-Signature": signature,
    }


def request(client, method, path, payload, *, nonce="n" * 32, headers=None, capability=None):
    raw = json.dumps(payload, separators=(",", ":")).encode()
    request_headers = headers or signed_headers(method, path, raw, nonce=nonce)
    if capability:
        request_headers = {**request_headers, **project_headers(capability)}
    return client.request(method, path, content=raw, headers=request_headers)


def create(client, *, name="Persistent project", persistent=True, nonce="c" * 32):
    response = request(client, "POST", "/api/integration/v2/projects", {
        "contract_version": 2, "name": name, "persistent": persistent,
    }, nonce=nonce)
    assert response.status_code == 200, response.text
    return response.json()


def project_headers(capability):
    return {"X-XrayLarch-Project-Capability": capability}


@pytest.mark.parametrize("tamper", ["method", "path", "body", "nonce"])
def test_v2_signature_rejects_tampering(tmp_path, tamper):
    with TestClient(create_app(settings(tmp_path))) as client:
        path = "/api/integration/v2/projects"
        payload = {"contract_version": 2, "name": "Signed", "persistent": True}
        raw = json.dumps(payload, separators=(",", ":")).encode()
        signed_method, signed_path, signed_raw, signed_nonce = "POST", path, raw, "a" * 32
        if tamper == "method":
            method = "PUT"
        else:
            method = signed_method
        if tamper == "path":
            path = "/api/integration/v2/projects/other"
        if tamper == "body":
            raw += b" "
        headers = signed_headers(signed_method, signed_path, signed_raw, nonce=signed_nonce)
        if tamper == "nonce":
            headers["X-DrXAS-Nonce"] = "b" * 32
        assert client.request(method, path, content=raw, headers=headers).status_code == 401


def test_v2_signatures_refresh_after_authentication_window(tmp_path, monkeypatch):
    import xraylarch_web.integration_routes as integration_routes

    clock = [datetime.now(UTC).replace(microsecond=0)]

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock[0] if tz is None else clock[0].astimezone(tz)

    monkeypatch.setattr(__name__ + ".datetime", Clock)
    monkeypatch.setattr(integration_routes, "_now", lambda: clock[0])
    path = "/api/integration/v2/projects"
    raw = json.dumps({"contract_version": 2, "name": "Fresh signature", "persistent": True}).encode()
    stale_headers = signed_headers("POST", path, raw, nonce="s" * 32)

    with TestClient(create_app(settings(tmp_path))) as client:
        clock[0] += timedelta(seconds=301)
        stale = client.post(path, content=raw, headers=stale_headers)
        assert stale.status_code == 401

        fresh_headers = signed_headers("POST", path, raw, nonce="f" * 32)
        assert fresh_headers["X-DrXAS-Timestamp"] == str(int(clock[0].timestamp()))
        fresh = client.post(path, content=raw, headers=fresh_headers)
        assert fresh.status_code == 200, fresh.text


def test_create_launch_rename_rotate_and_delete_project(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        created = create(client)
        project_id, capability = created["project_id"], created["capability"]
        assert created["project"]["name"] == "Persistent project"
        assert created["project"]["group_count"] == 0

        summary_path = f"/api/integration/v2/projects/{project_id}"
        summary = request(
            client, "GET", summary_path, {}, nonce="s" * 32, capability=capability
        )
        assert summary.status_code == 200
        assert summary.json() == created["project"]
        invalid = request(
            client,
            "GET",
            summary_path,
            {},
            nonce="t" * 32,
            capability="invalid-capability-value",
        )
        missing = request(
            client, "GET", summary_path, {}, nonce="u" * 32
        )
        assert invalid.status_code == missing.status_code == 404
        assert invalid.content == missing.content

        launched = request(client, "POST", f"/api/integration/v2/projects/{project_id}/launch", {"capability": capability}, nonce="l" * 32, capability=capability)
        assert launched.status_code == 200
        handle = launched.json()["handle"]
        consumed = client.post("/api/integration/v2/browser/consume", json={"handle": handle})
        assert consumed.status_code == 200
        assert consumed.json()["project_id"] == project_id
        assert consumed.json()["capability"] != capability
        assert client.post("/api/integration/v2/browser/consume", json={"handle": handle}).status_code == 404

        renamed = request(client, "PATCH", f"/api/integration/v2/projects/{project_id}", {"name": "Renamed"}, nonce="r" * 32, capability=capability)
        assert renamed.status_code == 200
        assert renamed.json()["name"] == "Renamed"
        rotated = request(client, "POST", f"/api/integration/v2/projects/{project_id}/capability/rotate", {}, nonce="o" * 32, capability=capability)
        assert rotated.status_code == 200
        new_capability = rotated.json()["capability"]
        assert new_capability != capability
        deleted = request(client, "DELETE", f"/api/integration/v2/projects/{project_id}", {}, nonce="d" * 32, capability=new_capability)
        assert deleted.status_code == 200
        assert deleted.json()["status"] == "deleted"


def test_rename_updates_exact_stored_bytes_and_rejects_over_quota(tmp_path):
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        created = create(client, name="A")
        project_id, capability = created["project_id"], created["capability"]
        renamed = request(
            client, "PATCH", f"/api/integration/v2/projects/{project_id}",
            {"name": "A longer project name"}, nonce="r" * 32, capability=capability,
        )
        assert renamed.status_code == 200
        actual = (tmp_path / "athena" / project_id / "project.json").stat().st_size
        assert renamed.json()["stored_bytes"] == actual

        integration_record = tmp_path / "integration" / "projects" / f"{project_id}.json"
        metadata = json.loads(integration_record.read_text(encoding="utf-8"))
        assert metadata["stored_bytes"] == actual
        metadata["quota"]["max_bytes"] = actual
        integration_record.write_text(json.dumps(metadata, separators=(",", ":")), encoding="utf-8")

        rejected = request(
            client, "PATCH", f"/api/integration/v2/projects/{project_id}",
            {"name": "A much longer project name"}, nonce="s" * 32, capability=capability,
        )
        assert rejected.status_code == 409
        assert json.loads((tmp_path / "athena" / project_id / "project.json").read_text())["name"] == "A longer project name"
        assert json.loads(integration_record.read_text())["stored_bytes"] == actual


def test_rename_recovers_metadata_after_workspace_commit_interruption(tmp_path, monkeypatch, now):
    from xraylarch_web.athena import AthenaStore
    from xraylarch_web.integration_service import IntegrationService
    from xraylarch_web.integration_storage import IntegrationStorage

    configured = settings(tmp_path)
    storage = IntegrationStorage(tmp_path, integration_secret=SECRET)
    service = IntegrationService(configured, AthenaStore(configured), storage)
    from xraylarch_web.integration_contracts import ProjectBootstrapRequest
    project_id, capability, _ = service.create_v2_project(
        ProjectBootstrapRequest(contract_version=2, name="Before", persistent=True), now=now
    )
    original = storage._set_project_stored_bytes_locked
    failed = False

    def interrupt(record, stored_bytes, *, now):
        nonlocal failed
        if not failed:
            failed = True
            raise OSError("process stopped after workspace commit")
        return original(record, stored_bytes, now=now)

    monkeypatch.setattr(storage, "_set_project_stored_bytes_locked", interrupt)
    with pytest.raises(OSError, match="process stopped"):
        service.rename_v2_project(project_id, capability, "Committed", now=now)
    assert json.loads((tmp_path / "athena" / project_id / "project.json").read_text())["name"] == "Committed"
    assert list((tmp_path / "integration" / "rename-intents").glob("*.json"))

    summary = service.rename_v2_project(project_id, capability, "Recovered", now=now)

    workspace_path = tmp_path / "athena" / project_id / "project.json"
    assert summary.name == "Recovered"
    assert summary.stored_bytes == workspace_path.stat().st_size
    assert not list((tmp_path / "integration" / "rename-intents").glob("*.json"))


@pytest.mark.parametrize("boundary", ("intent", "workspace", "metadata"))
def test_restart_launch_recovers_rename_intent_at_every_durable_boundary(tmp_path, boundary, now):
    from xraylarch_web.athena import AthenaStore
    from xraylarch_web.integration_contracts import ProjectBootstrapRequest
    from xraylarch_web.integration_service import IntegrationService
    from xraylarch_web.integration_storage import IntegrationStorage

    configured = settings(tmp_path)
    service = IntegrationService(configured, AthenaStore(configured), IntegrationStorage(tmp_path, integration_secret=SECRET))
    project_id, capability, before = service.create_v2_project(
        ProjectBootstrapRequest(contract_version=2, name="Before", persistent=True), now=now
    )
    intent = service.storage.rename_intents_dir / f"{hashlib.sha256(project_id.encode()).hexdigest()}.json"
    service.storage._atomic_json(intent, {"project_id": project_id, "name": "After"})
    workspace = tmp_path / "athena" / project_id / "project.json"
    if boundary != "intent":
        project = json.loads(workspace.read_text(encoding="utf-8"))
        project["name"] = "After"
        service.athena_store.storage.write_json(project_id, "project.json", project)
    if boundary == "metadata":
        service.storage.set_project_stored_bytes(project_id, capability, workspace.stat().st_size, now=now)

    restarted = IntegrationService(configured, AthenaStore(configured), IntegrationStorage(tmp_path, integration_secret=SECRET))
    handle = restarted.launch_v2_project(project_id, capability, now=now)

    assert handle
    assert restarted.storage.load_project(project_id, capability, now=now).stored_bytes == workspace.stat().st_size
    assert not intent.exists()


@pytest.mark.parametrize("boundary", ("intent", "workspace", "metadata"))
def test_restart_delete_consumes_rename_intent_at_every_durable_boundary(tmp_path, boundary, now):
    from xraylarch_web.athena import AthenaStore
    from xraylarch_web.integration_contracts import ProjectBootstrapRequest
    from xraylarch_web.integration_service import IntegrationService
    from xraylarch_web.integration_storage import IntegrationStorage

    configured = settings(tmp_path)
    service = IntegrationService(configured, AthenaStore(configured), IntegrationStorage(tmp_path, integration_secret=SECRET))
    project_id, capability, _ = service.create_v2_project(
        ProjectBootstrapRequest(contract_version=2, name="Before", persistent=True), now=now
    )
    intent = service.storage.rename_intents_dir / f"{hashlib.sha256(project_id.encode()).hexdigest()}.json"
    service.storage._atomic_json(intent, {"project_id": project_id, "name": "After"})
    workspace = tmp_path / "athena" / project_id / "project.json"
    if boundary != "intent":
        project = json.loads(workspace.read_text(encoding="utf-8"))
        project["name"] = "After"
        service.athena_store.storage.write_json(project_id, "project.json", project)
    if boundary == "metadata":
        service.storage.set_project_stored_bytes(project_id, capability, workspace.stat().st_size, now=now)

    restarted = IntegrationService(configured, AthenaStore(configured), IntegrationStorage(tmp_path, integration_secret=SECRET))
    result = restarted.delete_v2_project(project_id, capability, now=now)

    assert result["cleanup_pending"] is False
    assert not intent.exists()
    assert not workspace.parent.exists()


def test_rename_holds_integration_then_workspace_lock(tmp_path, monkeypatch, now):
    from contextlib import contextmanager
    from xraylarch_web.athena import AthenaStore
    from xraylarch_web.integration_service import IntegrationService
    from xraylarch_web.integration_storage import IntegrationStorage
    from xraylarch_web.integration_contracts import ProjectBootstrapRequest

    configured = settings(tmp_path)
    storage = IntegrationStorage(tmp_path, integration_secret=SECRET)
    athena = AthenaStore(configured)
    service = IntegrationService(configured, athena, storage)
    project_id, capability, _ = service.create_v2_project(
        ProjectBootstrapRequest(contract_version=2, name="Before", persistent=True), now=now
    )
    held = []
    project_lock = storage.project_lock
    workspace_lock = athena.storage.lock

    @contextmanager
    def traced_project_lock(value):
        with project_lock(value):
            held.append("integration")
            try:
                yield
            finally:
                held.pop()

    @contextmanager
    def traced_workspace_lock(value):
        assert held == ["integration"]
        with workspace_lock(value):
            held.append("workspace")
            try:
                yield
            finally:
                held.pop()

    monkeypatch.setattr(storage, "project_lock", traced_project_lock)
    monkeypatch.setattr(athena.storage, "lock", traced_workspace_lock)

    service.rename_v2_project(project_id, capability, "After", now=now)
    assert held == []


def test_guest_expiry_and_quota_rejection_precede_athena_mutation(tmp_path, monkeypatch, now):
    import xraylarch_web.integration_routes as integration_routes
    clock = [now]
    monkeypatch.setattr(integration_routes, "_now", lambda: clock[0])
    app = create_app(settings(tmp_path, integration_guest_max_projects=1, integration_guest_ttl_seconds=1))
    with TestClient(app) as client:
        guest = create(client, persistent=False, nonce="g" * 32)
        assert guest["project"]["expires_at"] is not None
        rejected = request(client, "POST", "/api/integration/v2/projects", {
            "contract_version": 2, "name": "Too many", "persistent": False,
        }, nonce="q" * 32)
        assert rejected.status_code == 409
        assert len(list((tmp_path / "athena").iterdir())) == 1
        later = now + timedelta(seconds=2)
        clock[0] = later
        raw = json.dumps({"capability": guest["capability"]}).encode()
        response = client.post(
            f"/api/integration/v2/projects/{guest['project_id']}/launch", content=raw,
            headers=signed_headers("POST", f"/api/integration/v2/projects/{guest['project_id']}/launch", raw, nonce="e" * 32, timestamp=later),
        )
        assert response.status_code == 404


def test_export_reservation_transitions_are_idempotent(tmp_path):
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        created = seeded(client, name="Reservation transitions", nonce="t" * 32)
        project_id, capability = created["project_id"], created["capability"]
        group_id = app.state.integration_service.athena_store.load(project_id)["groups"][0]["id"]
        payload = {"contract_version": 2, "project_id": project_id, "project_version": 0,
                   "selections": [{"group_id": group_id, "group_version": 0}]}
        reserve_path = f"/api/integration/v2/projects/{project_id}/exports/reservations/reservation-1"
        first = request(client, "POST", reserve_path, payload, nonce="p" * 32, capability=capability)
        second = request(client, "POST", reserve_path, payload, nonce="s" * 32, capability=capability)
        assert first.status_code == second.status_code == 200
        assert first.json()["status"] == "prepared"
        commit_path = f"{reserve_path}/commit"
        assert request(client, "POST", commit_path, {}, nonce="m" * 32, capability=capability).json()["status"] == "committed"
        assert request(client, "POST", commit_path, {}, nonce="i" * 32, capability=capability).json()["status"] == "committed"
        assert request(client, "POST", f"{reserve_path}/abort", {}, nonce="a" * 32, capability=capability).status_code == 409


def test_delete_retires_access_before_retryable_workspace_cleanup(tmp_path, monkeypatch):
    from xraylarch_web.integration_service import shutil as service_shutil
    with TestClient(create_app(settings(tmp_path))) as client:
        created = create(client)
        project_id, capability = created["project_id"], created["capability"]
        original = service_shutil.rmtree
        monkeypatch.setattr(service_shutil, "rmtree", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("busy")))
        first = request(client, "DELETE", f"/api/integration/v2/projects/{project_id}", {}, nonce="u" * 32, capability=capability)
        assert first.status_code == 200
        assert first.json()["cleanup_pending"] is True
        monkeypatch.setattr(service_shutil, "rmtree", original)
        retry = request(client, "DELETE", f"/api/integration/v2/projects/{project_id}", {}, nonce="v" * 32, capability=capability)
        assert retry.status_code == 200
        assert retry.json()["cleanup_pending"] is False
        assert not (tmp_path / "athena" / project_id).exists()


def test_delete_is_idempotent_for_concurrent_cleanup_retries(tmp_path):
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        created = create(client)
    def delete(index):
        with TestClient(app) as client:
            return request(
                client, "DELETE", f"/api/integration/v2/projects/{created['project_id']}", {},
                nonce=("j" if index == 0 else "k") * 32, capability=created["capability"],
            ).json()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(delete, range(2)))
    assert all(result == {"project_id": created["project_id"], "status": "deleted", "cleanup_pending": False}
               for result in results)
    assert not (tmp_path / "athena" / created["project_id"]).exists()


def test_v2_routes_are_registered_at_the_versioned_root(tmp_path):
    app = create_app(settings(tmp_path))
    paths = {route.path for route in app.routes}

    assert "/api/integration/v2/projects" in paths
    assert "/api/integration/v1/api/integration/v2/projects" not in paths


def test_seeded_creation_persists_seed_summary_into_one_use_browser_session(tmp_path):
    from test_integration_contracts import launch_payload
    source = {"kind": "drxas", "turn_id": "turn", "artifact_id": "artifact",
              "artifact_version": 1, "source_sha256": "a" * 64}
    seed = launch_payload()
    energy = [8800.0 + index * 2 for index in range(551)]
    mu = [0.7 + __import__("math").atan((value - 8980.0) / 4.0) / __import__("math").pi for value in energy]
    from xraylarch_web.integration_contracts import AuthoritativeSpectrum, canonical_sha256
    spectrum = AuthoritativeSpectrum(energy=tuple(energy), mu=tuple(mu))
    seed = {"source": source, "spectrum": spectrum.model_dump(mode="json"), "recipe": seed["recipe"],
            "spectrum_sha256": canonical_sha256(spectrum), "recipe_sha256": seed["recipe_sha256"]}
    with TestClient(create_app(settings(tmp_path))) as client:
        created = request(client, "POST", "/api/integration/v2/projects", {
            "contract_version": 2, "name": "Seeded", "persistent": True, "source": source, "seed": seed,
        }, nonce="z" * 32)
        assert created.status_code == 200
        payload = created.json()
        assert payload["project"]["stored_bytes"] == (tmp_path / "athena" / payload["project_id"] / "project.json").stat().st_size
        launched = request(client, "POST", f"/api/integration/v2/projects/{payload['project_id']}/launch",
                           {"capability": payload["capability"]}, nonce="y" * 32,
                           capability=payload["capability"])
        consumed = client.post("/api/integration/v2/browser/consume", json={"handle": launched.json()["handle"]})
        assert consumed.status_code == 200
        assert consumed.json()["seed_group"]["source"].items() >= source.items()
        assert {"read_project", "upload", "import", "command", "read_upload", "export"}.issubset(
            consumed.json()["allowed_operations"]
        )


def test_v2_create_purges_expired_project_handles(tmp_path, monkeypatch, now):
    import xraylarch_web.integration_routes as integration_routes
    clock = [now]
    monkeypatch.setattr(integration_routes, "_now", lambda: clock[0])
    with TestClient(create_app(settings(tmp_path))) as client:
        created = create(client)
        launched = request(client, "POST", f"/api/integration/v2/projects/{created['project_id']}/launch",
                           {"capability": created["capability"]}, nonce="h" * 32,
                           capability=created["capability"])
        handle = launched.json()["handle"]
        handle_path = tmp_path / "integration" / "handles" / f"{hashlib.sha256(handle.encode()).hexdigest()}.json"
        assert handle_path.exists()
        clock[0] += timedelta(seconds=301)
        raw = json.dumps({"contract_version": 2, "name": "Purges expired handle", "persistent": True}, separators=(",", ":")).encode()
        response = client.post("/api/integration/v2/projects", content=raw,
                               headers=signed_headers("POST", "/api/integration/v2/projects", raw,
                                                      nonce="i" * 32, timestamp=clock[0]))
        assert response.status_code == 200
        assert not handle_path.exists()


def test_seeded_creation_accepts_high_nfft_when_bounded_outputs_fit_quota(tmp_path):
    from test_integration_contracts import launch_payload
    from xraylarch_web.integration_contracts import AuthoritativeSpectrum, CoreProcessingRecipe, canonical_sha256

    source = {"kind": "drxas", "turn_id": "turn", "artifact_id": "artifact",
              "artifact_version": 1, "source_sha256": "a" * 64}
    recipe_payload = launch_payload()
    recipe_payload["recipe"]["forward_ft"]["nfft"] = 65_536
    recipe_payload["recipe"]["reverse_ft"]["nfft"] = 65_536
    spectrum = AuthoritativeSpectrum(
        energy=tuple(8800.0 + index * 2 for index in range(551)),
        mu=tuple(0.7 + math.atan((8800.0 + index * 2 - 8980.0) / 4.0) / math.pi for index in range(551)),
    )
    recipe = CoreProcessingRecipe.model_validate(recipe_payload["recipe"])
    seed = {"source": source, "spectrum": spectrum.model_dump(mode="json"),
            "recipe": recipe.model_dump(mode="json"), "spectrum_sha256": canonical_sha256(spectrum),
            "recipe_sha256": canonical_sha256(recipe)}

    with TestClient(create_app(settings(tmp_path))) as client:
        response = request(client, "POST", "/api/integration/v2/projects", {
            "contract_version": 2, "name": "High nfft", "persistent": False,
            "source": source, "seed": seed,
        }, nonce="j" * 32)

    assert response.status_code == 200, response.text
    project_id = response.json()["project_id"]
    assert (tmp_path / "athena" / project_id / "project.json").stat().st_size < 50_000_000


def test_seeded_creation_rejects_asymmetric_reverse_q_grid_before_processing(tmp_path, monkeypatch):
    from test_integration_contracts import launch_payload
    from xraylarch_web.athena import AthenaStore
    from xraylarch_web.integration_contracts import AuthoritativeSpectrum, CoreProcessingRecipe, canonical_sha256

    source = {"kind": "drxas", "turn_id": "turn", "artifact_id": "artifact",
              "artifact_version": 1, "source_sha256": "a" * 64}
    recipe_payload = launch_payload()["recipe"]
    recipe_payload["forward_ft"].update(nfft=2048, kstep=0.05)
    recipe_payload["reverse_ft"].update(nfft=65_536, kstep=0.05, qmax_out=30.0)
    recipe = CoreProcessingRecipe.model_validate(recipe_payload)
    spectrum = AuthoritativeSpectrum(
        energy=tuple(8800.0 + index * 2 for index in range(551)),
        mu=tuple(0.7 + math.atan((8800.0 + index * 2 - 8980.0) / 4.0) / math.pi for index in range(551)),
    )
    seed = {"source": source, "spectrum": spectrum.model_dump(mode="json"),
            "recipe": recipe.model_dump(mode="json"), "spectrum_sha256": canonical_sha256(spectrum),
            "recipe_sha256": canonical_sha256(recipe)}
    request_payload = {"contract_version": 2, "name": "Asymmetric", "persistent": True,
                       "source": source, "seed": seed}
    project = {"groups": [{"energy": list(spectrum.energy), "parameters": {
        **__import__("xraylarch_web.athena", fromlist=["AthenaParameters"]).AthenaParameters().model_dump(),
        **{"nfft": 2048, "kstep": 0.05, "reverse_nfft": 65_536,
           "reverse_kstep": 0.05, "qmax_out": 30.0},
    }}]}
    parameters = project["groups"][0]["parameters"]
    source_points = len(project["groups"][0]["energy"])
    available_kmax = math.sqrt(3.80998212 * (project["groups"][0]["energy"][-1] - project["groups"][0]["energy"][1]))
    kmax = min(parameters["bkg_kmax"] or available_kmax, available_kmax)
    k_points = min(parameters["nfft"] // 2, int(1.01 + kmax / parameters["kstep"]))
    rstep = math.pi / (parameters["kstep"] * parameters["nfft"])
    rmax = parameters["rmax_out"] or max(10.0, parameters["rmax"] + parameters["dr"] / 2 + rstep)
    r_points = min(parameters["nfft"] // 2, int(rmax / rstep) + 2)
    old_q_points = min(parameters["reverse_nfft"] // 2,
                       int(parameters["qmax_out"] / parameters["reverse_kstep"]) + 2)
    old_bound = 9 * source_points + 4 * k_points + 6 * r_points + 5 * old_q_points
    old_bound = len(json.dumps(project, allow_nan=False, separators=(",", ":")).encode()) + old_bound * 32 + 131_072
    calls = []
    monkeypatch.setattr(AthenaStore, "process", lambda *args: calls.append(args))

    with TestClient(create_app(settings(
        tmp_path, integration_max_bytes=old_bound + 1, integration_guest_max_bytes=old_bound + 1,
    ))) as client:
        response = request(client, "POST", "/api/integration/v2/projects", request_payload,
                           nonce="u" * 32)

    assert response.status_code == 409
    assert calls == []


def test_seeded_creation_rejects_processed_size_bound_before_processing(tmp_path, monkeypatch):
    from test_integration_contracts import launch_payload
    from xraylarch_web.athena import AthenaStore
    from xraylarch_web.integration_contracts import AuthoritativeSpectrum, canonical_sha256

    source = {"kind": "drxas", "turn_id": "turn", "artifact_id": "artifact",
              "artifact_version": 1, "source_sha256": "a" * 64}
    recipe_payload = launch_payload()
    spectrum = AuthoritativeSpectrum(
        energy=tuple(8800.0 + index * 2 for index in range(551)),
        mu=tuple(0.7 + math.atan((8800.0 + index * 2 - 8980.0) / 4.0) / math.pi for index in range(551)),
    )
    seed = {"source": source, "spectrum": spectrum.model_dump(mode="json"),
            "recipe": recipe_payload["recipe"], "spectrum_sha256": canonical_sha256(spectrum),
            "recipe_sha256": recipe_payload["recipe_sha256"]}
    request_payload = {"contract_version": 2, "name": "Bounded", "persistent": True,
                       "source": source, "seed": seed}
    original_process = AthenaStore.process
    monkeypatch.setattr(AthenaStore, "process", lambda *args: None)
    raw_root = tmp_path / "raw"
    with TestClient(create_app(settings(raw_root))) as client:
        raw = request(client, "POST", "/api/integration/v2/projects", request_payload,
                      nonce="d" * 32).json()
    raw_size = (raw_root / "athena" / raw["project_id"] / "project.json").stat().st_size

    monkeypatch.setattr(AthenaStore, "process", original_process)
    processed_root = tmp_path / "processed"
    with TestClient(create_app(settings(processed_root))) as client:
        processed = request(client, "POST", "/api/integration/v2/projects", request_payload,
                            nonce="e" * 32).json()
    processed_size = (processed_root / "athena" / processed["project_id"] / "project.json").stat().st_size
    assert raw_size < processed_size
    quota = (raw_size + processed_size) // 2

    calls = []
    monkeypatch.setattr(AthenaStore, "process", lambda *args: calls.append(args))
    bounded_root = tmp_path / "bounded"
    with TestClient(create_app(settings(bounded_root, integration_max_bytes=quota,
                                        integration_guest_max_bytes=quota))) as client:
        response = request(client, "POST", "/api/integration/v2/projects", request_payload,
                           nonce="f" * 32)

    assert response.status_code == 409
    assert calls == []


def test_seeded_creation_rejects_byte_quota_before_workspace_mutation(tmp_path, monkeypatch):
    from test_integration_contracts import launch_payload
    source = {"kind": "drxas", "turn_id": "turn", "artifact_id": "artifact",
              "artifact_version": 1, "source_sha256": "a" * 64}
    recipe = launch_payload()["recipe"]
    from xraylarch_web.integration_contracts import AuthoritativeSpectrum, canonical_sha256
    spectrum = AuthoritativeSpectrum(
        energy=tuple(8800.0 + index * 2 for index in range(551)),
        mu=tuple(0.7 + math.atan((8800.0 + index * 2 - 8980.0) / 4.0) / math.pi for index in range(551)),
    )
    seed = {"source": source, "spectrum": spectrum.model_dump(mode="json"), "recipe": recipe,
            "spectrum_sha256": canonical_sha256(spectrum), "recipe_sha256": recipe and launch_payload()["recipe_sha256"]}
    from xraylarch_web.athena import AthenaStore
    app = create_app(settings(tmp_path, integration_max_bytes=128, integration_guest_max_bytes=128))
    monkeypatch.setattr(AthenaStore, "process", lambda *_: pytest.fail("quota must precede Athena processing"))
    with TestClient(app) as client:
        response = request(client, "POST", "/api/integration/v2/projects", {
            "contract_version": 2, "name": "Too large", "persistent": True,
            "source": source, "seed": seed,
        }, nonce="b" * 32)
    assert response.status_code == 409
    assert not (tmp_path / "athena").exists() or not list((tmp_path / "athena").iterdir())


def test_source_only_project_is_honestly_empty(tmp_path):
    source = {"kind": "drxas", "turn_id": "turn", "artifact_id": "artifact",
              "artifact_version": 1, "source_sha256": "a" * 64}
    with TestClient(create_app(settings(tmp_path))) as client:
        created = request(client, "POST", "/api/integration/v2/projects", {
            "contract_version": 2, "name": "Unseeded", "persistent": True, "source": source,
        }, nonce="t" * 32)
        payload = created.json()
        launched = request(client, "POST", f"/api/integration/v2/projects/{payload['project_id']}/launch",
                           {"capability": payload["capability"]}, nonce="s" * 32, capability=payload["capability"])
        consumed = client.post("/api/integration/v2/browser/consume", json={"handle": launched.json()["handle"]})
        assert consumed.json()["seed_group"] is None
        assert consumed.json()["project"]["group_count"] == 0


@pytest.mark.parametrize("contents", (b"\xff", b'{"kind":"v2-project"'))
def test_browser_consume_returns_uniform_not_found_for_corrupt_launch_record(tmp_path, contents):
    with TestClient(create_app(settings(tmp_path))) as client:
        created = create(client)
        launched = request(
            client, "POST", f"/api/integration/v2/projects/{created['project_id']}/launch",
            {"capability": created["capability"]}, nonce="x" * 32,
            capability=created["capability"],
        )
        handle = launched.json()["handle"]
        path = tmp_path / "integration" / "handles" / f"{hashlib.sha256(handle.encode()).hexdigest()}.json"
        path.write_bytes(contents)

        response = client.post("/api/integration/v2/browser/consume", json={"handle": handle})

    assert response.status_code == 404
    assert response.json() == {"detail": "Integration project was not found."}


def test_browser_consume_does_not_run_global_cleanup(tmp_path, monkeypatch):
    from xraylarch_web.integration_storage import IntegrationStorage

    monkeypatch.setattr(
        IntegrationStorage, "expire_due",
        lambda *args, **kwargs: pytest.fail("unauthenticated consume must not trigger cleanup"),
    )
    with TestClient(create_app(settings(tmp_path))) as client:
        response = client.post("/api/integration/v2/browser/consume", json={"handle": "x" * 22})

    assert response.status_code == 404


def test_v2_browser_consume_obeys_feature_gate(tmp_path):
    with TestClient(create_app(settings(tmp_path, browser_consume_enabled=False))) as client:
        assert client.post("/api/integration/v2/browser/consume", json={"handle": "x" * 22}).status_code == 404


def test_v2_invalid_payload_does_not_consume_nonce_and_rejects_duplicate_auth_headers(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        path = "/api/integration/v2/projects"
        raw = b'{"contract_version":2}'
        signed = signed_headers("POST", path, raw, nonce="x" * 32)
        assert client.post(path, content=raw, headers=signed).status_code == 422
        valid = json.dumps({"contract_version": 2, "name": "Retry", "persistent": True}, separators=(",", ":")).encode()
        retry = signed_headers("POST", path, valid, nonce="x" * 32)
        assert client.post(path, content=valid, headers=retry).status_code == 200
        duplicate = signed_headers("POST", path, valid, nonce="w" * 32)
        duplicate_headers = list(duplicate.items()) + [("X-DrXAS-Issuer", ISSUER)]
        assert client.post(path, content=valid, headers=duplicate_headers).status_code == 401


def test_browser_consume_rejects_service_credentials_and_health_advertises_v2(tmp_path, monkeypatch):
    revision = "0123456789abcdef0123456789abcdef01234567"
    monkeypatch.setenv("XRAYLARCH_GIT_REVISION", revision)
    with TestClient(create_app(settings(tmp_path))) as client:
        assert client.post("/api/integration/v2/browser/consume", json={"handle": "x" * 22}, headers={"X-DrXAS-Signature": "secret"}).status_code == 404
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["integration_contract_version"] == 2
        assert health.json()["git_revision"] == revision


def _route_request(client, route, project_id, headers):
    path = route.path.replace("{ident}", project_id)
    path = re.sub(r"\{upload_id[^}]*\}", "missing-upload", path)
    path = re.sub(r"\{group_id[^}]*\}", "missing-group", path)
    path = path.replace("{member_index}", "0").replace("{action}", "preview")
    kwargs = {"headers": headers}
    if "POST" in route.methods:
        if any(token in path for token in ("/inspect", "/restore", "/preview-project")):
            kwargs["files"] = {"file": ("sample.dat", b"1 2\n2 3\n")}
        else:
            kwargs["json"] = {}
        method = "POST"
    elif "PATCH" in route.methods:
        kwargs["json"] = {}
        method = "PATCH"
    elif "DELETE" in route.methods:
        method = "DELETE"
    else:
        method = "GET"
    return client.request(method, path, **kwargs)


def _browser_session(client, integrated, *, nonce="l" * 32):
    project_id = integrated["project_id"]
    launched = request(
        client,
        "POST",
        f"/api/integration/v2/projects/{project_id}/launch",
        {"capability": integrated["capability"]},
        nonce=nonce,
        capability=integrated["capability"],
    )
    assert launched.status_code == 200, launched.text
    consumed = client.post(
        "/api/integration/v2/browser/consume",
        json={"handle": launched.json()["handle"]},
    )
    assert consumed.status_code == 200, consumed.text
    return consumed.json()


def test_guest_browser_session_expires_with_project_without_cleanup(tmp_path, monkeypatch, now):
    import xraylarch_web.athena as athena_module
    import xraylarch_web.integration_routes as integration_routes

    clock = [now]

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock[0] if tz is None else clock[0].astimezone(tz)

    monkeypatch.setattr(integration_routes, "_now", lambda: clock[0])
    monkeypatch.setattr(athena_module, "datetime", Clock)
    app = create_app(settings(tmp_path, integration_guest_ttl_seconds=10))
    with TestClient(app) as client:
        guest = create(client, persistent=False)
        clock[0] = now + timedelta(seconds=9)
        session = _browser_session(client, guest)
        session_path = (
            tmp_path / "integration" / "sessions"
            / f"{hashlib.sha256(session['capability'].encode()).hexdigest()}.json"
        )
        session_record = json.loads(session_path.read_text(encoding="utf-8"))
        assert datetime.fromisoformat(session_record["expires_at"]) == now + timedelta(seconds=10)

        clock[0] = now + timedelta(seconds=11)
        denied = client.get(
            f"/api/athena/projects/{guest['project_id']}",
            headers=project_headers(session["capability"]),
        )

    assert denied.status_code == 404
    assert denied.json() == {"detail": "Project was not found."}
    project_record = json.loads(
        (tmp_path / "integration" / "projects" / f"{guest['project_id']}.json").read_text(
            encoding="utf-8"
        )
    )
    assert project_record["status"] == "expired"


@pytest.mark.parametrize("revoke", ("rotate", "delete"))
def test_browser_session_is_immediately_revoked_by_owner_lifecycle(tmp_path, revoke):
    with TestClient(create_app(settings(tmp_path))) as client:
        integrated = create(client)
        session = _browser_session(client, integrated)
        project_id = integrated["project_id"]
        if revoke == "rotate":
            response = request(
                client,
                "POST",
                f"/api/integration/v2/projects/{project_id}/capability/rotate",
                {},
                nonce="r" * 32,
                capability=integrated["capability"],
            )
        else:
            response = request(
                client,
                "DELETE",
                f"/api/integration/v2/projects/{project_id}",
                {},
                nonce="d" * 32,
                capability=integrated["capability"],
            )
        denied = client.get(
            f"/api/athena/projects/{project_id}",
            headers=project_headers(session["capability"]),
        )

    assert response.status_code == 200, response.text
    assert denied.status_code == 404
    if revoke == "rotate":
        assert denied.json() == {"detail": "Project was not found."}


def test_browser_session_enforces_authoritative_operation_scope(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        integrated = create(client)
        session = _browser_session(client, integrated)
        project_id = integrated["project_id"]

        readable = client.get(
            f"/api/athena/projects/{project_id}",
            headers=project_headers(session["capability"]),
        )
        renamed = client.post(
            f"/api/athena/projects/{project_id}/command",
            headers=project_headers(session["capability"]),
            json={
                "version": 0,
                "action": "project",
                "group_ids": [],
                "options": {"name": "Browser-authorized"},
            },
        )
        owner_secret = client.get(
            f"/api/athena/projects/{project_id}",
            headers=project_headers(integrated["capability"]),
        )

    assert "read_project" in session["allowed_operations"]
    assert "project" in session["allowed_operations"]
    assert session["capability"] != integrated["capability"]
    assert readable.status_code == 200
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Browser-authorized"
    assert owner_secret.status_code == 404
    assert owner_secret.json() == {"detail": "Project was not found."}


@pytest.mark.parametrize(
    "headers",
    [
        {"X-XrayLarch-Draft-Capability": "draft-secret"},
        {"X-XrayLarch-Project-Capability": "project-secret"},
        {
            "X-XrayLarch-Draft-Capability": "draft-secret",
            "X-XrayLarch-Project-Capability": "project-secret",
        },
    ],
)
def test_legacy_project_collection_rejects_capability_headers(tmp_path, headers):
    with TestClient(create_app(settings(tmp_path))) as client:
        listing = client.get("/api/athena/projects", headers=headers)
        creation = client.post("/api/athena/projects", headers=headers)

    assert listing.status_code == 403
    assert creation.status_code == 403


def test_persistent_command_enforces_quota_and_updates_exact_bytes(tmp_path, now):
    from xraylarch_web.integration_service import IntegrationService

    app = create_app(settings(
        tmp_path, integration_max_groups=2, integration_guest_max_groups=2
    ))
    with TestClient(app) as client:
        service = app.state.integration_service
        integrated = create(client)
        session_capability = service.storage.create_project_session(
            project_id=integrated["project_id"],
            owner_capability=integrated["capability"],
            allowed_operations=("command", "project", "example"),
            expires_at=now + timedelta(minutes=5),
            now=now,
        )
        renamed = client.post(
            f"/api/athena/projects/{integrated['project_id']}/command",
            headers=project_headers(session_capability),
            json={"version": 0, "action": "project", "group_ids": [],
                  "options": {"name": "Accounted"}},
        )
        rejected = client.post(
            f"/api/athena/projects/{integrated['project_id']}/command",
            headers=project_headers(session_capability),
            json={"version": 1, "action": "example", "group_ids": [], "options": {}},
        )

    workspace = tmp_path / "athena" / integrated["project_id"]
    record = service.storage.load_project(
        integrated["project_id"], integrated["capability"], now=now
    )
    assert renamed.status_code == 200, renamed.text
    assert record.stored_bytes == sum(
        path.stat().st_size
        for path in workspace.iterdir()
        if path.is_file() and path.name != "workspace.lock"
    )
    assert rejected.status_code == 409
    assert json.loads((workspace / "project.json").read_text())["groups"] == []


def test_compact_selection_retains_integration_authorization_and_quota_transaction(tmp_path, monkeypatch, now):
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        service = app.state.integration_service
        integrated = create(client)
        ident = integrated["project_id"]
        route = f"/api/athena/projects/{ident}/command"
        session = service.storage.create_project_session(
            project_id=ident, owner_capability=integrated["capability"],
            allowed_operations=("command", "example", "metadata"),
            expires_at=now + timedelta(minutes=5), now=now,
        )
        seeded = client.post(route, headers=project_headers(session), json={
            "version": 0, "action": "example",
        })
        assert seeded.status_code == 200, seeded.text
        project = seeded.json()
        service.rename_v2_project(ident, integrated["capability"], "Renamed in Dr.XAS", now=now)
        assert service.athena_store.load(ident)["version"] == project["version"]
        payload = {"version": project["version"], "action": "metadata",
                   "group_ids": [group["id"] for group in project["groups"]],
                   "options": {"marked": True}, "response_mode": "selection"}
        workspace = tmp_path / "athena" / ident

        def snapshot():
            return {path.name: path.read_bytes() for path in workspace.iterdir()
                    if path.is_file() and path.name != "workspace.lock"}

        before = snapshot()
        denied = client.post(route, json=payload)
        assert denied.status_code == 404
        assert snapshot() == before
        restricted = service.storage.create_project_session(
            project_id=ident, owner_capability=integrated["capability"],
            allowed_operations=("command",),
            expires_at=now + timedelta(minutes=5), now=now,
        )
        denied = client.post(route, headers=project_headers(restricted), json=payload)
        assert denied.status_code == 404
        assert snapshot() == before

        original_mutate = service.mutate_v2_project
        transaction_results = []

        def inspect_transaction(*args, **kwargs):
            result = original_mutate(*args, **kwargs)
            # The integration layer must see the full project, including data.
            assert "result" in result["groups"][0]
            assert "kind" not in result
            transaction_results.append(result)
            return result

        monkeypatch.setattr(service, "mutate_v2_project", inspect_transaction)
        marked = client.post(route, headers=project_headers(session), json=payload)
        assert marked.status_code == 200, marked.text
        delta = marked.json()
        assert delta["kind"] == "selection" and all(row["marked"] for row in delta["groups"])
        assert delta["name"] == "Renamed in Dr.XAS"
        reconstructed = {**project, **{key: value for key, value in delta.items()
                                      if key not in {"kind", "base_version", "groups"}},
                         "groups": [{**group, **row}
                                    for group, row in zip(project["groups"], delta["groups"])]}
        assert reconstructed == service.athena_store.load(ident)
        assert len(transaction_results) == 1
        record = service.storage.load_project(ident, integrated["capability"], now=now)
        assert record.stored_bytes == sum(len(value) for value in snapshot().values())

        record_path = tmp_path / "integration" / "projects" / f"{ident}.json"
        record_json = json.loads(record_path.read_text())
        record_json["quota"]["max_bytes"] = record.stored_bytes + 1
        record_path.write_text(json.dumps(record_json, separators=(",", ":")))
        before = snapshot()
        rejected = client.post(route, headers=project_headers(session), json={
            **payload, "version": delta["version"], "options": {"marked": False},
        })
        assert rejected.status_code == 409, rejected.text
        assert snapshot() == before


@pytest.mark.parametrize("declared_length", (None, "1"))
def test_integrated_upload_uses_actual_bytes_and_rolls_back(tmp_path, declared_length, now):
    from xraylarch_web.integration_service import IntegrationService

    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        service = app.state.integration_service
        integrated = create(client)
        session_capability = service.storage.create_project_session(
            project_id=integrated["project_id"],
            owner_capability=integrated["capability"],
            allowed_operations=("upload",),
            expires_at=now + timedelta(minutes=5),
            now=now,
        )
        record_path = tmp_path / "integration" / "projects" / f"{integrated['project_id']}.json"
        metadata = json.loads(record_path.read_text())
        metadata["quota"]["max_bytes"] = metadata["stored_bytes"] + 10
        record_path.write_text(json.dumps(metadata, separators=(",", ":")))
        raw = b"energy mu\n" + b"\n".join(f"{index} {index + 1}".encode() for index in range(12))
        headers = project_headers(session_capability)
        request_kwargs = {"headers": headers, "files": {"file": ("sample.dat", raw)}}
        if declared_length is None:
            request_kwargs["headers"] = {
                **headers, "transfer-encoding": "chunked"
            }
        else:
            request_kwargs["headers"] = {
                **headers, "content-length": declared_length
            }
        rejected = client.post(
            f"/api/athena/projects/{integrated['project_id']}/inspect",
            **request_kwargs,
        )

    workspace = tmp_path / "athena" / integrated["project_id"]
    assert rejected.status_code == 409
    assert not list(workspace.glob("upload-*"))


@pytest.mark.parametrize("action", ("deconvolve", "self_absorption"))
def test_scientific_command_action_requires_its_exact_scope(tmp_path, action, now):
    from test_integration_contracts import launch_payload
    from xraylarch_web.integration_contracts import AuthoritativeSpectrum, canonical_sha256

    source = {"kind": "drxas", "turn_id": "turn", "artifact_id": "artifact",
              "artifact_version": 1, "source_sha256": "a" * 64}
    seed = launch_payload()
    energy = [8800.0 + index * 2 for index in range(551)]
    mu = [0.7 + math.atan((value - 8980.0) / 4.0) / math.pi for value in energy]
    spectrum = AuthoritativeSpectrum(energy=tuple(energy), mu=tuple(mu))
    seed = {"source": source, "spectrum": spectrum.model_dump(mode="json"),
            "recipe": seed["recipe"], "spectrum_sha256": canonical_sha256(spectrum),
            "recipe_sha256": seed["recipe_sha256"]}
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        service = app.state.integration_service
        created = request(client, "POST", "/api/integration/v2/projects", {
            "contract_version": 2, "name": "Scientific command", "persistent": True,
            "source": source, "seed": seed,
        }, nonce="q" * 32).json()
        allowed_capability = service.storage.create_project_session(
            project_id=created["project_id"], owner_capability=created["capability"],
            allowed_operations=("command", action), expires_at=now + timedelta(minutes=5), now=now,
        )
        denied_capability = service.storage.create_project_session(
            project_id=created["project_id"], owner_capability=created["capability"],
            allowed_operations=("command", "project"), expires_at=now + timedelta(minutes=5), now=now,
        )
        group_id = service.athena_store.load(created["project_id"])["groups"][0]["id"]
        options = ({"form": "gaussian", "width": 1, "xmin": 8950, "xmax": 9100}
                   if action == "deconvolve" else
                   {"formula": "Cu", "element": "Cu", "edge": "K", "angle_in": 45, "angle_out": 45})
        payload = {"version": 0, "action": action, "group_ids": [group_id], "options": options}
        allowed = client.post(
            f"/api/athena/projects/{created['project_id']}/command",
            headers=project_headers(allowed_capability), json=payload,
        )
        denied = client.post(
            f"/api/athena/projects/{created['project_id']}/command",
            headers=project_headers(denied_capability), json=payload,
        )

    assert allowed.status_code == 200, allowed.text
    assert denied.status_code == 404
    assert denied.json() == {"detail": "Project was not found."}


def test_command_action_requires_its_individual_scope(tmp_path, now):
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        service = app.state.integration_service
        integrated = create(client)
        session_capability = service.storage.create_project_session(
            project_id=integrated["project_id"],
            owner_capability=integrated["capability"],
            allowed_operations=("command", "project"),
            expires_at=now + timedelta(minutes=5), now=now,
        )
        allowed = client.post(
            f"/api/athena/projects/{integrated['project_id']}/command",
            headers=project_headers(session_capability),
            json={"version": 0, "action": "project", "group_ids": [],
                  "options": {"name": "Allowed"}},
        )
        denied = client.post(
            f"/api/athena/projects/{integrated['project_id']}/command",
            headers=project_headers(session_capability),
            json={"version": 1, "action": "example", "group_ids": [], "options": {}},
        )

    assert allowed.status_code == 200, allowed.text
    assert denied.status_code == 404
    assert denied.json() == {"detail": "Project was not found."}


def test_concurrent_integrated_uploads_cannot_take_same_last_file_slot(tmp_path, now):
    app = create_app(settings(
        tmp_path, integration_max_files=1, integration_guest_max_files=1
    ))
    with TestClient(app) as client:
        service = app.state.integration_service
        integrated = create(client)
        session_capability = service.storage.create_project_session(
            project_id=integrated["project_id"],
            owner_capability=integrated["capability"],
            allowed_operations=("upload",), expires_at=now + timedelta(minutes=5),
            now=now,
        )

    raw = b"energy mu\n" + b"\n".join(
        f"{index} {index + 1}".encode() for index in range(12)
    )

    def upload(index):
        with TestClient(app) as client:
            return client.post(
                f"/api/athena/projects/{integrated['project_id']}/inspect",
                headers=project_headers(session_capability),
                files={"file": (f"sample-{index}.dat", raw)},
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = list(executor.map(upload, range(2)))

    assert sorted(statuses) == [200, 409]
    workspace = tmp_path / "athena" / integrated["project_id"]
    assert len(list(workspace.glob("upload-*.source"))) == 1


def test_integrated_project_preview_group_uses_staged_ownership(tmp_path, now):
    from xraylarch_web.integration_service import IntegrationService

    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        service = app.state.integration_service
        first = create(client, nonce="a" * 32)
        second = create(client, nonce="b" * 32)
        capabilities = {}
        for item in (first, second):
            capabilities[item["project_id"]] = service.storage.create_project_session(
                project_id=item["project_id"], owner_capability=item["capability"],
                allowed_operations=("upload", "read_upload"),
                expires_at=now + timedelta(minutes=5), now=now,
            )
        source = {
            "format": "athena-web", "schema_version": 1, "version": 0,
            "name": "Preview", "journal": "", "groups": [{
                "id": "staged-group", "label": "Staged", "energy": list(range(12)),
                "mu": [float(index) for index in range(12)], "data_type": "mu",
                "parameters": {}, "source": {}, "notes": "", "marked": False,
                "frozen": False, "multiplier": 1, "offset": 0,
                "reference_id": None, "background_standard_id": None,
            }],
        }
        preview = client.post(
            f"/api/athena/projects/{first['project_id']}/preview-project",
            headers=project_headers(capabilities[first["project_id"]]),
            files={"file": ("preview.json", json.dumps(source).encode())},
        )
        assert preview.status_code == 200, preview.text
        upload_id = preview.json()["upload_id"]
        allowed = client.get(
            f"/api/athena/projects/{first['project_id']}/preview-project/{upload_id}/groups/staged-group",
            headers=project_headers(capabilities[first["project_id"]]),
        )
        denied = client.get(
            f"/api/athena/projects/{second['project_id']}/preview-project/{upload_id}/groups/staged-group",
            headers=project_headers(capabilities[second["project_id"]]),
        )

    assert allowed.status_code == 200, allowed.text
    assert denied.status_code == 404
    assert denied.json() == {"detail": "Project was not found."}


def test_every_integrated_athena_project_route_requires_matching_capability(tmp_path):
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        integrated = create(client)
        routes = [
            route for route in app.routes
            if getattr(route, "path", "").startswith("/api/athena/projects/{ident}")
        ]
        assert len(routes) >= 35
        for route in routes:
            missing = _route_request(client, route, integrated["project_id"], {})
            wrong = _route_request(
                client, route, integrated["project_id"], project_headers("wrong")
            )
            assert missing.status_code == 404, (route.methods, route.path, missing.text)
            assert wrong.status_code == 404, (route.methods, route.path, wrong.text)


def seeded(client, *, name="Exportable", nonce="s" * 32, **overrides):
    """Create a persistent project seeded with one recomputable Dr.XAS group."""
    from test_integration_contracts import launch_payload
    from xraylarch_web.integration_contracts import AuthoritativeSpectrum, canonical_sha256

    source = {"kind": "drxas", "turn_id": "turn", "artifact_id": "artifact",
              "artifact_version": 1, "source_sha256": "a" * 64}
    energy = [8800.0 + index * 2 for index in range(551)]
    mu = [0.7 + math.atan((value - 8980.0) / 4.0) / math.pi for value in energy]
    spectrum = AuthoritativeSpectrum(energy=tuple(energy), mu=tuple(mu))
    seed = {"source": source, "spectrum": spectrum.model_dump(mode="json"),
            "recipe": launch_payload()["recipe"], "spectrum_sha256": canonical_sha256(spectrum),
            "recipe_sha256": launch_payload()["recipe_sha256"]}
    response = request(client, "POST", "/api/integration/v2/projects", {
        "contract_version": 2, "name": name, "persistent": True,
        "source": source, "seed": seed, **overrides,
    }, nonce=nonce)
    assert response.status_code == 200, response.text
    return response.json()


def export_groups(client, project, selections, *, project_version=0, nonce="e" * 32, capability=None):
    path = f"/api/integration/v2/projects/{project['project_id']}/exports/groups"
    return request(client, "POST", path, {
        "contract_version": 2, "project_id": project["project_id"],
        "project_version": project_version, "selections": selections,
    }, nonce=nonce, capability=project["capability"] if capability is None else capability)


def test_seeded_creation_records_the_seed_group_revision(tmp_path):
    """The seed is written straight to disk, so ``save`` never stamps it."""
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        created = seeded(client)
        project = app.state.integration_service.athena_store.load(created["project_id"])
    assert project["group_versions"] == {project["groups"][0]["id"]: 0}


def test_selected_group_export_carries_recomputable_science_for_a_seeded_group(tmp_path):
    from xraylarch_web.integration_contracts import SelectedGroupExportBatch, canonical_sha256

    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        created = seeded(client)
        group_id = app.state.integration_service.athena_store.load(created["project_id"])["groups"][0]["id"]
        response = export_groups(client, created, [{"group_id": group_id, "group_version": 0}])

    assert response.status_code == 200, response.text
    batch = SelectedGroupExportBatch.model_validate_json(response.content)
    assert batch.project_id == created["project_id"] and batch.project_version == 0
    (group,) = batch.groups
    assert (group.group_id, group.group_version, group.label) == (group_id, 0, "Dr.XAS source")
    assert group.source.kind == "drxas" and group.source.turn_id == "turn"
    assert group.science.kind == "recomputable"
    assert group.science.recipe_sha256 == canonical_sha256(group.science.recipe)
    assert group.science.recipe.larch_version == group.larch_version
    assert len(group.science.computed.arrays["chi"]) > 1


def test_selected_group_export_refuses_a_stale_project_or_group_revision(tmp_path):
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        created = seeded(client)
        group_id = app.state.integration_service.athena_store.load(created["project_id"])["groups"][0]["id"]
        stale_project = export_groups(client, created, [{"group_id": group_id, "group_version": 0}],
                                      project_version=1, nonce="f" * 32)
        stale_group = export_groups(client, created, [{"group_id": group_id, "group_version": 1}],
                                    nonce="g" * 32)
        absent = export_groups(client, created, [{"group_id": "no-such-group", "group_version": 0}],
                               nonce="h" * 32)
    assert stale_project.status_code == 409, stale_project.text
    assert stale_group.status_code == 409, stale_group.text
    assert absent.status_code == 409, absent.text


def test_selected_group_export_requires_both_the_signature_and_the_project_capability(tmp_path):
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        created = seeded(client)
        group_id = app.state.integration_service.athena_store.load(created["project_id"])["groups"][0]["id"]
        selections = [{"group_id": group_id, "group_version": 0}]
        path = f"/api/integration/v2/projects/{created['project_id']}/exports/groups"
        body = {"contract_version": 2, "project_id": created["project_id"],
                "project_version": 0, "selections": selections}
        uncapable = export_groups(client, created, selections, nonce="i" * 32, capability="")
        unsigned = client.post(path, json=body, headers=project_headers(created["capability"]))
        wrong_capability = export_groups(client, created, selections, nonce="j" * 32,
                                         capability="not-the-owner-capability")
    assert uncapable.status_code == 404
    assert unsigned.status_code == 401
    assert wrong_capability.status_code == 404


def test_selected_group_export_puts_a_derived_group_under_xraylarch_web_authority(tmp_path, now):
    """A deconvolved group is norm(E) with no portable recipe: xraylarch-web owns it."""
    from xraylarch_web.integration_contracts import SelectedGroupExportBatch

    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        service = app.state.integration_service
        created = seeded(client, nonce="k" * 32)
        seed_id = service.athena_store.load(created["project_id"])["groups"][0]["id"]
        session = service.storage.create_project_session(
            project_id=created["project_id"], owner_capability=created["capability"],
            allowed_operations=("command", "deconvolve"), expires_at=now + timedelta(minutes=5), now=now,
        )
        commanded = client.post(
            f"/api/athena/projects/{created['project_id']}/command",
            headers=project_headers(session),
            json={"version": 0, "action": "deconvolve", "group_ids": [seed_id],
                  "options": {"form": "gaussian", "width": 1}},
        )
        assert commanded.status_code == 200, commanded.text
        project = service.athena_store.load(created["project_id"])
        derived = project["groups"][1]
        response = export_groups(
            client, created,
            [{"group_id": derived["id"], "group_version": project["group_versions"][derived["id"]]}],
            project_version=project["version"], nonce="l" * 32,
        )

    assert response.status_code == 200, response.text
    (group,) = SelectedGroupExportBatch.model_validate_json(response.content).groups
    assert group.source.kind == "athena_internal"
    assert group.source.parent_group_ids == (seed_id,)
    assert group.science.kind == "exported"
    assert (group.science.reason, group.science.data_type) == ("data_type", "norm")
    assert "energy" in group.science.arrays and "norm" in group.science.arrays


def test_selected_group_export_refuses_a_group_whose_processing_failed(tmp_path, now):
    """A group Athena could not process has no science to export, only an error."""
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        service = app.state.integration_service
        created = seeded(client, nonce="m" * 32)
        seed_id = service.athena_store.load(created["project_id"])["groups"][0]["id"]
        session = service.storage.create_project_session(
            project_id=created["project_id"], owner_capability=created["capability"],
            allowed_operations=("command", "deconvolve"), expires_at=now + timedelta(minutes=5), now=now,
        )
        # Deconvolving a narrow window leaves too little post-edge k to process.
        commanded = client.post(
            f"/api/athena/projects/{created['project_id']}/command",
            headers=project_headers(session),
            json={"version": 0, "action": "deconvolve", "group_ids": [seed_id],
                  "options": {"form": "gaussian", "width": 1, "xmin": 8950, "xmax": 9100}},
        )
        assert commanded.status_code == 200, commanded.text
        project = service.athena_store.load(created["project_id"])
        broken = project["groups"][1]
        assert broken["processing_error"]
        response = export_groups(
            client, created,
            [{"group_id": broken["id"], "group_version": project["group_versions"][broken["id"]]}],
            project_version=project["version"], nonce="n" * 32,
        )
    assert response.status_code == 409
    assert response.json()["detail"] == (
        "Selected group has no processed result; repair its processing first."
    )


def reserve(client, project, selections, *, project_version, reservation="reservation-1", nonce="p" * 32):
    path = f"/api/integration/v2/projects/{project['project_id']}/exports/reservations/{reservation}"
    return request(client, "POST", path, {
        "contract_version": 2, "project_id": project["project_id"],
        "project_version": project_version, "selections": selections,
    }, nonce=nonce, capability=project["capability"])


def test_export_reservation_pins_the_revisions_it_was_asked_for(tmp_path, now):
    """A reservation that records version 0 for every project cannot bind anything."""
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        service = app.state.integration_service
        created = seeded(client, nonce="o" * 32)
        seed_id = service.athena_store.load(created["project_id"])["groups"][0]["id"]
        session = service.storage.create_project_session(
            project_id=created["project_id"], owner_capability=created["capability"],
            allowed_operations=("command", "deconvolve"), expires_at=now + timedelta(minutes=5), now=now,
        )
        assert client.post(
            f"/api/athena/projects/{created['project_id']}/command",
            headers=project_headers(session),
            json={"version": 0, "action": "deconvolve", "group_ids": [seed_id],
                  "options": {"form": "gaussian", "width": 1}},
        ).status_code == 200
        project = service.athena_store.load(created["project_id"])
        selections = [{"group_id": seed_id, "group_version": 0}]
        reserved = reserve(client, created, selections, project_version=project["version"])
        stale = reserve(client, created, selections, project_version=0,
                        reservation="reservation-2", nonce="q" * 32)
        absent = reserve(client, created, [{"group_id": "no-such-group", "group_version": 0}],
                         project_version=project["version"], reservation="reservation-3",
                         nonce="r" * 32)
    assert reserved.status_code == 200, reserved.text
    assert reserved.json()["project_version"] == project["version"] == 1
    assert stale.status_code == 409, stale.text
    assert absent.status_code == 409, absent.text


def test_selected_group_export_refuses_a_result_that_predates_version_attribution(tmp_path):
    """Science whose computing Larch was never recorded cannot be credited."""
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        service = app.state.integration_service
        created = seeded(client, nonce="u" * 32)
        stored = tmp_path / "athena" / created["project_id"] / "project.json"
        project = json.loads(stored.read_text())
        group_id = project["groups"][0]["id"]
        assert project["groups"][0]["result"].pop("larch_version")
        stored.write_text(json.dumps(project))
        response = export_groups(client, created, [{"group_id": group_id, "group_version": 0}],
                                 nonce="v" * 32)
    assert response.status_code == 409
    assert response.json()["detail"] == (
        "Selected group's cached result predates version attribution; reprocess it."
    )


def test_selected_group_export_puts_a_difference_spectrum_under_xraylarch_web_authority(tmp_path, now):
    """A difference has no absorption edge, so no recipe could replay it."""
    from xraylarch_web.integration_contracts import SelectedGroupExportBatch

    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        service = app.state.integration_service
        created = seeded(client, nonce="w" * 32)
        seed_id = service.athena_store.load(created["project_id"])["groups"][0]["id"]
        session = service.storage.create_project_session(
            project_id=created["project_id"], owner_capability=created["capability"],
            allowed_operations=("command", "duplicate", "difference"),
            expires_at=now + timedelta(minutes=5), now=now,
        )

        def command(version, action, group_ids):
            response = client.post(
                f"/api/athena/projects/{created['project_id']}/command",
                headers=project_headers(session),
                json={"version": version, "action": action, "group_ids": group_ids, "options": {}},
            )
            assert response.status_code == 200, response.text

        command(0, "duplicate", [seed_id])
        copy_id = service.athena_store.load(created["project_id"])["groups"][1]["id"]
        command(1, "difference", [seed_id, copy_id])
        project = service.athena_store.load(created["project_id"])
        difference = project["groups"][2]
        assert difference["is_difference"]
        response = export_groups(
            client, created,
            [{"group_id": difference["id"],
              "group_version": project["group_versions"][difference["id"]]}],
            project_version=project["version"], nonce="x" * 32,
        )

    assert response.status_code == 200, response.text
    (group,) = SelectedGroupExportBatch.model_validate_json(response.content).groups
    assert group.science.kind == "exported" and group.science.reason == "difference"
    assert group.source.kind == "athena_internal"
    assert set(group.source.parent_group_ids) == {seed_id, copy_id}
