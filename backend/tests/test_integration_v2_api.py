from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from xraylarch_web.config import Settings
from xraylarch_web.integration_service import v2_signing_payload
from xraylarch_web.main import create_app


NOW = datetime.now(UTC).replace(microsecond=0)
SECRET = "integration-secret-that-is-long-enough"
ISSUER = "drxas"
AUDIENCE = "xraylarch-web"


def settings(tmp_path, **overrides):
    defaults = {
        "integration_api_enabled": True, "browser_consume_enabled": True,
        "integration_issuer": ISSUER, "integration_audience": AUDIENCE,
        "integration_hmac_secret": SECRET,
    }
    return Settings(data_root=tmp_path, **(defaults | overrides))


def signed_headers(method, path, raw, *, nonce="n" * 32, timestamp=NOW):
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


def test_create_launch_rename_rotate_and_delete_project(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        created = create(client)
        project_id, capability = created["project_id"], created["capability"]
        assert created["project"]["name"] == "Persistent project"
        assert created["project"]["group_count"] == 0

        launched = request(client, "POST", f"/api/integration/v2/projects/{project_id}/launch", {"capability": capability}, nonce="l" * 32, capability=capability)
        assert launched.status_code == 200
        handle = launched.json()["handle"]
        consumed = client.post("/api/integration/v2/browser/consume", json={"handle": handle})
        assert consumed.status_code == 200
        assert consumed.json()["project_id"] == project_id
        assert consumed.json()["capability"] == capability
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


def test_guest_expiry_and_quota_rejection_precede_athena_mutation(tmp_path, monkeypatch):
    import xraylarch_web.integration_routes as integration_routes
    clock = [NOW]
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
        later = NOW + timedelta(seconds=2)
        clock[0] = later
        raw = json.dumps({"capability": guest["capability"]}).encode()
        response = client.post(
            f"/api/integration/v2/projects/{guest['project_id']}/launch", content=raw,
            headers=signed_headers("POST", f"/api/integration/v2/projects/{guest['project_id']}/launch", raw, nonce="e" * 32, timestamp=later),
        )
        assert response.status_code == 404


def test_export_reservation_transitions_are_idempotent(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        created = create(client)
        project_id, capability = created["project_id"], created["capability"]
        payload = {"contract_version": 2, "project_id": project_id, "project_version": 0,
                   "selections": [{"group_id": "selected-group", "group_version": 0}]}
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


def test_v2_routes_are_registered_at_the_versioned_root(tmp_path):
    app = create_app(settings(tmp_path))
    paths = {route.path for route in app.routes}

    assert "/api/integration/v2/projects" in paths
    assert "/api/integration/v1/api/integration/v2/projects" not in paths


def test_seeded_creation_persists_seed_summary_into_one_use_browser_session(tmp_path):
    source = {"kind": "drxas", "turn_id": "turn", "artifact_id": "artifact",
              "artifact_version": 1, "source_sha256": "a" * 64}
    with TestClient(create_app(settings(tmp_path))) as client:
        created = request(client, "POST", "/api/integration/v2/projects", {
            "contract_version": 2, "name": "Seeded", "persistent": True, "source": source,
        }, nonce="z" * 32)
        assert created.status_code == 200
        payload = created.json()
        launched = request(client, "POST", f"/api/integration/v2/projects/{payload['project_id']}/launch",
                           {"capability": payload["capability"]}, nonce="y" * 32,
                           capability=payload["capability"])
        consumed = client.post("/api/integration/v2/browser/consume", json={"handle": launched.json()["handle"]})
        assert consumed.status_code == 200
        assert consumed.json()["seed_group"]["source"] == source
        assert consumed.json()["allowed_operations"] == ["read_project"]


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


def test_browser_consume_rejects_service_credentials_and_health_advertises_v2(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        assert client.post("/api/integration/v2/browser/consume", json={"handle": "x" * 22}, headers={"X-DrXAS-Signature": "secret"}).status_code == 404
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["integration_contract_version"] == 2
