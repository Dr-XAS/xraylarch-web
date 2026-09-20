"""Check the public deployment's data boundary through real HTTP requests."""
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
import pytest

from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

COOKIE = "xraylarch_session"


def public_app(root, **kwargs):
    return create_app(Settings(data_root=root, public_mode=True, **kwargs))


def client(app):
    return TestClient(app, base_url="https://testserver")


def test_sessions_isolate_projects_and_classic_workspaces(tmp_path):
    app = public_app(tmp_path)
    with client(app) as alice, client(app) as bob:
        session = alice.get("/api/session")
        assert session.json() == {"isolated": True}
        assert all(flag in session.headers["set-cookie"] for flag in ("HttpOnly", "Secure", "SameSite=lax"))
        project = alice.post("/api/athena/projects").json()
        workspace = alice.post("/api/workspaces").json()
        assert [p["id"] for p in alice.get("/api/athena/projects").json()] == [project["id"]]
        assert bob.get("/api/athena/projects").json() == []
        assert alice.cookies[COOKIE] != bob.cookies[COOKIE]
        for path in (f'/api/athena/projects/{project["id"]}',
                     f'/api/athena/projects/{project["id"]}/export',
                     f'/api/workspaces/{workspace["workspace_id"]}'):
            response = bob.get(path)
            assert response.status_code == 404, response.text
            assert response.json()["error"]["code"] == "workspace_not_found"
            assert response.headers["cache-control"] == "private, no-store"
        mutation = bob.post(f'/api/athena/projects/{project["id"]}/command', json={
            "version": 0, "action": "example", "group_ids": [], "options": {}})
        assert mutation.status_code == 404
        assert alice.get(f'/api/athena/projects/{project["id"]}').json()["groups"] == []


def test_preferences_and_applied_plugin_configuration_are_private_and_durable(tmp_path):
    app = public_app(tmp_path)
    config_path = "/api/athena/preferences/plugins/X15B/configuration"
    with client(app) as alice, client(app) as bob:
        prefs = alice.get("/api/athena/preferences/rebin").json()
        original = bob.get("/api/athena/preferences/rebin").json()
        prefs["grid"]["emin"] = -40
        assert alice.put("/api/athena/preferences/rebin", json=prefs).status_code == 200
        assert bob.get("/api/athena/preferences/rebin").json() == original
        before = alice.get(config_path).json()
        change = {"version": before["version"], "session_id": before["session_id"],
                  "values": before["values"] | {"narrow": 9}, "save": False}
        applied = alice.put(config_path, json=change)
        assert applied.status_code == 200, applied.text
        assert applied.json()["unsaved"] is True
        assert alice.get(config_path).json()["values"]["narrow"] == 9
        assert bob.get(config_path).json()["values"]["narrow"] == 7
        assert alice.put(config_path, json=change).status_code == 409
        cookie = alice.cookies[COOKIE]
        project_id = alice.post("/api/athena/projects").json()["id"]
    with client(public_app(tmp_path)) as restarted:
        restarted.cookies.set(COOKIE, cookie)
        assert restarted.get(f"/api/athena/projects/{project_id}").status_code == 200
        assert restarted.get(config_path).json()["values"]["narrow"] == 9
        assert restarted.get("/api/athena/preferences/rebin").json()["grid"]["emin"] == -40


def test_forged_cookie_cannot_select_another_session(tmp_path):
    app = public_app(tmp_path)
    with client(app) as alice:
        project = alice.post("/api/athena/projects").json()
        original = alice.cookies[COOKIE]
    ident, signature = original.split(".")
    forged = ident + "." + ("A" if signature[0] != "A" else "B") + signature[1:]
    with client(app) as attacker:
        response = attacker.get(f'/api/athena/projects/{project["id"]}', headers={"cookie": f"{COOKIE}={forged}"})
        assert response.status_code == 404
        assert attacker.cookies[COOKIE].split(".")[0] != ident
        assert attacker.get("/api/athena/projects").json() == []


def test_concurrent_project_requests_use_the_initialized_session(tmp_path):
    app = public_app(tmp_path)
    with client(app) as browser:
        browser.get("/api/session")
        cookie = browser.cookies[COOKIE]
        def create(_):
            with client(app) as request:
                return request.post("/api/athena/projects", headers={"cookie": f"{COOKIE}={cookie}"}).json()["id"]
        with ThreadPoolExecutor(max_workers=3) as pool:
            ids = set(pool.map(create, range(3)))
        assert {p["id"] for p in browser.get("/api/athena/projects").json()} == ids


@pytest.mark.parametrize("suffix", ["inspect", "restore?version=0", "preview-project"])
def test_athena_upload_body_limit_precedes_multipart_parser(tmp_path, suffix):
    with client(public_app(tmp_path, max_upload_bytes=100)) as browser:
        ident = browser.post("/api/athena/projects").json()["id"]
        response = browser.post(f"/api/athena/projects/{ident}/{suffix}",
                                content=b"x" * 200, headers={"content-type": "multipart/form-data; boundary=test"})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "upload_too_large"


def test_health_and_trusted_local_mode_do_not_create_public_sessions(tmp_path):
    with client(public_app(tmp_path / "public")) as browser:
        assert "set-cookie" not in browser.get("/health").headers
    with client(create_app(Settings(data_root=tmp_path / "local"))) as browser:
        response = browser.get("/api/session")
        assert response.json() == {"isolated": False}
        assert "set-cookie" not in response.headers
