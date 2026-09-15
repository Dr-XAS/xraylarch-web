from __future__ import annotations

from datetime import UTC, datetime, timedelta
from dataclasses import replace
import hashlib
import hmac
import json
import math
from threading import Event, Thread

import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app
from test_integration_contracts import launch_payload


SECRET = "integration-secret-that-is-long-enough"
ISSUER = "drxas"
AUDIENCE = "xraylarch-web"


def now():
    return datetime.now(UTC).replace(microsecond=0)


def enabled_settings(tmp_path, *, browser=True):
    return Settings(
        data_root=tmp_path,
        integration_api_enabled=True,
        browser_consume_enabled=browser,
        integration_issuer=ISSUER,
        integration_audience=AUDIENCE,
        integration_hmac_secret=SECRET,
    )


def body(*, source="1", timestamp=None) -> bytes:
    timestamp = timestamp or now()
    payload = launch_payload()
    payload["source"]["artifact_id"] = f"artifact-{source}"
    payload["created_at"] = timestamp.isoformat()
    payload["expires_at"] = (timestamp + timedelta(minutes=5)).isoformat()
    return json.dumps(payload, separators=(",", ":")).encode()


def headers(raw: bytes, *, nonce="n" * 32, timestamp=None,
            issuer=ISSUER, audience=AUDIENCE):
    timestamp = timestamp or now()
    digest = hashlib.sha256(raw).hexdigest()
    stamp = str(int(timestamp.timestamp()))
    canonical = "\n".join((issuer, audience, stamp, nonce, digest)).encode()
    signature = hmac.new(SECRET.encode(), canonical, hashlib.sha256).hexdigest()
    return {
        "X-DrXAS-Issuer": issuer,
        "X-DrXAS-Audience": audience,
        "X-DrXAS-Timestamp": stamp,
        "X-DrXAS-Nonce": nonce,
        "X-DrXAS-Body-SHA256": digest,
        "X-DrXAS-Signature": signature,
    }


def bootstrap(client, raw, **header_options):
    return client.post(
        "/api/integration/v1/bootstrap",
        content=raw,
        headers={"content-type": "application/json", **headers(raw, **header_options)},
    )


def consume(client, handle):
    return client.post("/api/integration/v1/browser/consume", json={"handle": handle})


def capability(value):
    return {"X-XrayLarch-Draft-Capability": value}


def launch_session(client, *, source="1", nonce="n" * 32):
    response = bootstrap(client, body(source=source), nonce=nonce)
    assert response.status_code == 200, response.text
    consumed = consume(client, response.json()["handle"])
    assert consumed.status_code == 200, consumed.text
    return consumed.json()


@pytest.mark.parametrize('with_capability', [False, True])
def test_all_other_athena_project_routes_refuse_integrated_drafts_before_body_parsing(tmp_path, with_capability):
    app = create_app(enabled_settings(tmp_path))
    permitted = {
        ('GET', '/api/athena/projects/{ident}'),
        ('POST', '/api/athena/projects/{ident}/command'),
        ('GET', '/api/athena/projects/{ident}/export'),
        ('GET', '/api/athena/projects/{ident}/groups/{group_id}/export'),
    }
    with TestClient(app) as client:
        session = launch_session(client)
        checked = []
        for route in app.routes:
            if not route.path.startswith('/api/athena/projects/{ident}/'):
                continue
            for method in route.methods:
                if (method, route.path) in permitted:
                    continue
                path = route.path
                for name, converter in route.param_convertors.items():
                    value = session['project_id'] if name == 'ident' else session['group_id'] if name == 'group_id' else 'test'
                    path = path.replace('{' + name + '}', value).replace('{' + name + ':path}', value)
                response = client.request(method, path, content=b'not-valid-json',
                    headers={'content-type':'application/json', **(capability(session['owner_capability']) if with_capability else {})})
                assert response.status_code == 404, (method, route.path, response.status_code)
                checked.append((method, route.path))
        assert len(checked) >= 20


def test_new_project_route_cannot_escape_by_renaming_its_path_parameter(tmp_path):
    app = create_app(enabled_settings(tmp_path))
    route_type = type(next(route for route in app.routes if route.path == '/api/athena/projects/{ident}'))
    called = []
    async def future_operation(project_id: str):
        called.append(project_id)
        return {'unsafe': True}
    app.router.add_api_route('/api/athena/projects/{project_id}/future', future_operation,
        methods=['POST'], route_class_override=route_type)
    with TestClient(app) as client:
        session = launch_session(client)
        response = client.post(f"/api/athena/projects/{session['project_id']}/future",
            headers=capability(session['owner_capability']))
        assert response.status_code == 404
        assert called == []


def test_default_off_integration_routes_are_not_found(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        assert client.post("/api/integration/v1/bootstrap", content=b"{}").status_code == 404
        assert client.post("/api/integration/v1/browser/consume", json={"handle": "x"}).status_code == 404


def test_browser_consume_has_independent_default_off_gate(tmp_path):
    with TestClient(create_app(enabled_settings(tmp_path, browser=False))) as client:
        launched = bootstrap(client, body())
        assert launched.status_code == 200
        assert consume(client, launched.json()["handle"]).status_code == 404


@pytest.mark.parametrize("imports", [False, True])
def test_workspace_advertises_import_only_when_enabled(tmp_path, imports):
    settings = replace(enabled_settings(tmp_path), import_enabled=imports)
    with TestClient(create_app(settings)) as client:
        session = launch_session(client)
        url = f"/api/integration/v1/drafts/{session['draft_id']}/workspace"
        result = client.get(url, headers=capability(session["owner_capability"]))
        assert result.status_code == 200
        assert ("export" in result.json()["allowed_operations"]) is imports


def test_bootstrap_rejects_replay_expiry_wrong_identity_and_tampered_body(tmp_path):
    with TestClient(create_app(enabled_settings(tmp_path))) as client:
        raw = body()
        assert bootstrap(client, raw).status_code == 200
        assert bootstrap(client, raw).status_code in (400, 409)
        assert bootstrap(client, raw, nonce="o" * 32,
                         timestamp=now() - timedelta(seconds=301)).status_code == 401
        assert bootstrap(client, raw, nonce="p" * 32, issuer="other").status_code == 401
        assert bootstrap(client, raw, nonce="q" * 32, audience="other").status_code == 401
        tampered = client.post(
            "/api/integration/v1/bootstrap",
            content=raw + b" ",
            headers={"content-type": "application/json", **headers(raw, nonce="r" * 32)},
        )
        assert tampered.status_code == 401


def test_duplicate_handle_consume_and_cross_owner_access_are_rejected(tmp_path):
    with TestClient(create_app(enabled_settings(tmp_path))) as client:
        first = launch_session(client, source="1", nonce="a" * 32)
        second = launch_session(client, source="2", nonce="b" * 32)
        assert second["source_sha256"] == hashlib.sha256(
            json.dumps(
                {
                    **launch_payload()["source"],
                    "artifact_id": "artifact-2",
                },
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode()
        ).hexdigest()
        launched = bootstrap(client, body(source="3"), nonce="c" * 32).json()
        assert consume(client, launched["handle"]).status_code == 200
        assert consume(client, launched["handle"]).status_code in (400, 404)
        workspace = client.get(
            f"/api/integration/v1/drafts/{second['draft_id']}/workspace",
            headers=capability(first["owner_capability"]),
        )
        assert workspace.status_code == 404
        project = client.get(
            f"/api/athena/projects/{second['project_id']}",
            headers=capability(first["owner_capability"]),
        )
        assert project.status_code == 404


def test_malformed_envelope_and_duplicate_source_are_atomic(tmp_path):
    with TestClient(create_app(enabled_settings(tmp_path))) as client:
        malformed = b"not-json"
        first_bad = bootstrap(client, malformed, nonce="m" * 32)
        second_bad = bootstrap(client, malformed, nonce="m" * 32)
        assert first_bad.status_code == second_bad.status_code == 422

        first = bootstrap(client, body(source="duplicate"), nonce="d" * 32)
        second = bootstrap(client, body(source="duplicate"), nonce="e" * 32)
        assert first.status_code == 200
        assert second.status_code == 409
        project_dirs = [path for path in (tmp_path / "athena").iterdir() if path.is_dir()]
        draft_files = list((tmp_path / "integration" / "drafts").glob("*.json"))
        assert len(project_dirs) == len(draft_files) == 1


def test_global_project_list_keeps_legacy_project_and_hides_integration_draft(
    tmp_path, monkeypatch
):
    with TestClient(create_app(enabled_settings(tmp_path))) as client:
        integrated = launch_session(client)
        legacy = client.post("/api/athena/projects")
        assert legacy.status_code == 200

        original_list = AthenaStore.list

        def unfiltered_list(store):
            visible = original_list(store)
            project = store.load(integrated["project_id"])
            return visible + [
                {
                    **{key: project[key] for key in ("id", "name", "updated", "version")},
                    "count": len(project["groups"]),
                }
            ]

        monkeypatch.setattr(AthenaStore, "list", unfiltered_list)
        listed_ids = {item["id"] for item in client.get("/api/athena/projects").json()}

        assert listed_ids == {legacy.json()["id"]}
        assert integrated["project_id"] not in listed_ids


def test_workspace_lifecycle_and_athena_capability_gateway(tmp_path):
    with TestClient(create_app(enabled_settings(tmp_path))) as client:
        session = launch_session(client)
        draft_id = session["draft_id"]
        project_id = session["project_id"]
        group_id = session["group_id"]
        auth = capability(session["owner_capability"])

        assert client.get(f"/api/athena/projects/{project_id}").status_code == 404
        project = client.get(f"/api/athena/projects/{project_id}", headers=auth)
        assert project.status_code == 200
        assert [group["id"] for group in project.json()["groups"]] == [group_id]

        blocked = client.post(
            f"/api/athena/projects/{project_id}/command",
            headers=auth,
            json={"version": 0, "action": "duplicate", "group_ids": [group_id], "options": {}},
        )
        assert blocked.status_code == 403
        allowed = client.post(
            f"/api/athena/projects/{project_id}/command",
            headers=auth,
            json={"version": 0, "action": "metadata", "group_ids": [group_id], "options": {"label": "Integrated spectrum"}},
        )
        assert allowed.status_code == 200, allowed.text

        workspace = client.get(
            f"/api/integration/v1/drafts/{draft_id}/workspace", headers=auth
        )
        assert workspace.status_code == 200
        assert workspace.json()["draft"]["source_sha256"] == hashlib.sha256(
            json.dumps(
                launch_payload()["source"],
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode()
        ).hexdigest()
        assert workspace.json()["allowed_operations"] == [
            "metadata", "parameters", "set_e0", "undo", "redo"
        ]
        assert "owner_capability" not in workspace.json()

        sealed = client.post(
            f"/api/integration/v1/drafts/{draft_id}/seal", headers=auth
        )
        assert sealed.status_code == 200
        assert client.post(
            f"/api/integration/v1/drafts/{draft_id}/seal", headers=auth
        ).status_code == 200
        before = client.get(f"/api/athena/projects/{project_id}", headers=auth)
        assert before.status_code == 200
        rejected = client.post(
            f"/api/athena/projects/{project_id}/command",
            headers=auth,
            json={
                "version": 1,
                "action": "metadata",
                "group_ids": [group_id],
                "options": {"label": "Must not persist"},
            },
        )
        assert rejected.status_code == 403
        assert client.get(
            f"/api/athena/projects/{project_id}", headers=auth
        ).json() == before.json()


def test_command_persistence_is_serialized_before_seal(tmp_path, monkeypatch):
    app = create_app(enabled_settings(tmp_path))
    route = next(
        route
        for route in app.routes
        if getattr(route, "path", None) == "/api/athena/projects/{ident}/command"
    )
    store = route.endpoint.__closure__[2].cell_contents
    original_command = store.command
    command_entered = Event()
    allow_command = Event()

    def paused_command(ident, request):
        command_entered.set()
        assert allow_command.wait(timeout=5)
        return original_command(ident, request)

    monkeypatch.setattr(store, "command", paused_command)
    with TestClient(app) as client:
        session = launch_session(client)
        auth = capability(session["owner_capability"])
        result = {}

        def mutate():
            result["response"] = client.post(
                f"/api/athena/projects/{session['project_id']}/command",
                headers=auth,
                json={
                    "version": 0,
                    "action": "metadata",
                    "group_ids": [session["group_id"]],
                    "options": {"label": "Serialized mutation"},
                },
            )

        command_thread = Thread(target=mutate)
        command_thread.start()
        assert command_entered.wait(timeout=5)

        seal_result = {}
        seal_thread = Thread(
            target=lambda: seal_result.setdefault(
                "response",
                client.post(
                    f"/api/integration/v1/drafts/{session['draft_id']}/seal",
                    headers=auth,
                ),
            )
        )
        seal_thread.start()
        seal_thread.join(timeout=0.2)
        assert seal_thread.is_alive()

        allow_command.set()
        command_thread.join(timeout=5)
        seal_thread.join(timeout=5)
        assert result["response"].status_code == 200
        assert seal_result["response"].status_code == 200

        project = client.get(
            f"/api/athena/projects/{session['project_id']}", headers=auth
        ).json()
        assert project["groups"][0]["label"] == "Serialized mutation"


def test_generic_project_creation_rejects_integration_capability_but_legacy_is_unchanged(tmp_path):
    with TestClient(create_app(enabled_settings(tmp_path))) as client:
        session = launch_session(client)
        assert client.post("/api/athena/projects").status_code == 200
        assert client.post(
            "/api/athena/projects", headers=capability(session["owner_capability"])
        ).status_code == 403


def import_settings(tmp_path, *, imports=True):
    return Settings(
        data_root=tmp_path,
        integration_api_enabled=True,
        browser_consume_enabled=True,
        import_enabled=imports,
        integration_issuer=ISSUER,
        integration_audience=AUDIENCE,
        integration_hmac_secret=SECRET,
    )


def export(client, draft_id, capability_value, *, nonce="e" * 32, **header_options):
    raw = json.dumps(
        {"draft_id": draft_id, "owner_capability": capability_value},
        separators=(",", ":"),
    ).encode()
    return client.post(
        f"/api/integration/v1/drafts/{draft_id}/export",
        content=raw,
        headers={
            "content-type": "application/json",
            **headers(raw, nonce=nonce, **header_options),
        },
    )


def test_export_has_an_independent_default_off_gate(tmp_path):
    with TestClient(create_app(import_settings(tmp_path, imports=False))) as client:
        session = launch_session(client)
        assert (
            export(client, session["draft_id"], session["owner_capability"]).status_code
            == 404
        )


def test_export_returns_the_sealed_envelope_to_a_signed_owner_request(tmp_path):
    with TestClient(create_app(import_settings(tmp_path))) as client:
        session = launch_session(client)

        response = export(client, session["draft_id"], session["owner_capability"])

        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["draft_id"] == session["draft_id"]
        assert payload["parity_status"] == "not_checked"
        assert payload["spectrum_sha256"] == json.loads(body())["spectrum_sha256"]
        assert response.headers["cache-control"] == "no-store"


def test_signed_snapshot_returns_cached_numerical_evidence_and_rejects_replay(tmp_path):
    from xraylarch_web.integration_contracts import AuthoritativeSpectrum, canonical_sha256, ImportSnapshot, snapshot_sha256
    payload = json.loads(body())
    energy = [8800.0 + index * 2 for index in range(551)]
    mu = [0.7 + math.atan((value - 8980.0) / 4.0) / math.pi for value in energy]
    spectrum = AuthoritativeSpectrum.model_validate({"energy": tuple(energy), "mu": tuple(mu)})
    payload.update(spectrum=spectrum.model_dump(mode="json"), spectrum_sha256=canonical_sha256(spectrum))
    raw = json.dumps(payload).encode()
    with TestClient(create_app(import_settings(tmp_path))) as client:
        launched = bootstrap(client, raw)
        session = consume(client, launched.json()["handle"]).json()
        request_body = json.dumps({"draft_id": session["draft_id"], "owner_capability": session["owner_capability"]}).encode()
        path = f"/api/integration/v1/drafts/{session['draft_id']}/snapshot"
        assert client.post(path, content=request_body).status_code == 401
        signed = headers(request_body, nonce="s" * 32)
        response = client.post(path, content=request_body, headers=signed)
        assert response.status_code == 200, response.text
        assert response.json()["project_version"] == 0
        assert len(response.json()["computed"]["arrays"]["norm"]) == 551
        assert response.headers["cache-control"] == "no-store"
        assert client.post(path, content=request_body, headers=signed).status_code in (400, 409)
        snapshot = ImportSnapshot.model_validate_json(response.content)
        binding = {"import_id": "a" * 32, "attempt_id": "b" * 32,
                   "project_version": 0, "snapshot_sha256": snapshot_sha256(snapshot)}
        import_path = f"/api/integration/v1/drafts/{session['draft_id']}/import"
        for action, nonce, expected in (("prepare", "p", "importing"), ("finalize", "f", "sealed")):
            raw_action = json.dumps({"draft_id": session["draft_id"], "owner_capability": session["owner_capability"],
                                     "action": action, "binding": binding}).encode()
            assert client.post(import_path, content=raw_action).status_code == 401
            done = client.post(import_path, content=raw_action, headers=headers(raw_action, nonce=nonce * 32))
            assert done.status_code == 200, done.text
            assert done.json()["status"] == expected
            workspace = client.get(f"/api/integration/v1/drafts/{session['draft_id']}/workspace",
                                   headers=capability(session["owner_capability"]))
            assert workspace.json()["allowed_operations"] == ["export"]


def test_export_requires_a_valid_signature_and_rejects_replay(tmp_path):
    with TestClient(create_app(import_settings(tmp_path))) as client:
        session = launch_session(client)
        draft_id = session["draft_id"]
        cap = session["owner_capability"]

        unsigned = client.post(
            f"/api/integration/v1/drafts/{draft_id}/export",
            json={"draft_id": draft_id, "owner_capability": cap},
        )
        assert unsigned.status_code == 401
        assert export(client, draft_id, cap, nonce="f" * 32, issuer="other").status_code == 401
        assert export(client, draft_id, cap, nonce="g" * 32, audience="other").status_code == 401
        assert export(
            client, draft_id, cap, nonce="h" * 32, timestamp=now() - timedelta(seconds=301)
        ).status_code == 401

        assert export(client, draft_id, cap, nonce="i" * 32).status_code == 200
        assert export(client, draft_id, cap, nonce="i" * 32).status_code in (400, 409)


def test_export_refuses_a_capability_that_does_not_own_the_draft(tmp_path):
    with TestClient(create_app(import_settings(tmp_path))) as client:
        session = launch_session(client)

        assert export(client, session["draft_id"], "w" * 32).status_code == 404


def test_export_refuses_a_cross_draft_request(tmp_path):
    # Note what actually refuses this: the owner capability is derived from a
    # single draft's handle, so it cannot authorize another draft no matter what
    # the path says. The service also compares the signed body's draft_id with
    # the path, but that check is redundant defence-in-depth — no behaviour can
    # isolate it, because capability ownership already implies it.
    with TestClient(create_app(import_settings(tmp_path))) as client:
        first = launch_session(client)
        second = launch_session(client, source="2", nonce="m" * 32)
        raw = json.dumps(
            {
                "draft_id": second["draft_id"],
                "owner_capability": second["owner_capability"],
            },
            separators=(",", ":"),
        ).encode()

        response = client.post(
            f"/api/integration/v1/drafts/{first['draft_id']}/export",
            content=raw,
            headers={"content-type": "application/json", **headers(raw, nonce="z" * 32)},
        )

        assert response.status_code == 404


def test_export_is_not_reachable_with_only_the_browser_capability_header(tmp_path):
    # The browser holds this capability in sessionStorage. Export must require a
    # Dr.XAS signature as well, or the browser could seal its own import source.
    with TestClient(create_app(import_settings(tmp_path))) as client:
        session = launch_session(client)

        response = client.post(
            f"/api/integration/v1/drafts/{session['draft_id']}/export",
            json={
                "draft_id": session["draft_id"],
                "owner_capability": session["owner_capability"],
            },
            headers=capability(session["owner_capability"]),
        )

        assert response.status_code == 401
