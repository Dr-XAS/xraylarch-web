"""Public-browser boundaries for master's Artemis and preference services."""
import shutil
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import artemis, artemis_structures as structures
from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

COOKIE = "xraylarch_session"
JOB_PATH = "/api/artemis/feff/jobs"


def app(root):
    return create_app(Settings(data_root=root, public_mode=True))


def browser(application):
    return TestClient(application, base_url="https://testserver")


def attached_project(client):
    project = client.post("/api/athena/projects").json()
    response = client.post(
        f"/api/artemis/projects/{project['id']}/structures",
        json={"version": project["version"], "amcsd_id": 13088},
    )
    assert response.status_code == 200, response.text
    return response.json()


def job_request(project=None):
    source = (
        {"amcsd_id": 13088}
        if project is None
        else {
            "project_id": project["id"],
            "version": project["version"],
            "attachment_id": project["artemis_structures"][0]["id"],
        }
    )
    return source | {
        "absorber": "Cu",
        "site_index": 1,
        "cluster_radius": 3,
        "path_radius": 3,
        "max_legs": 2,
    }


def completed(client, ident):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f"{JOB_PATH}/{ident}")
        assert response.status_code == 200, response.text
        result = response.json()
        if result["status"] != "running":
            assert result["status"] == "complete", result
            return result
        time.sleep(0.02)
    pytest.fail("Mock FEFF calculation did not complete")


@pytest.fixture
def mock_feff(monkeypatch):
    release = threading.Event()
    captured = []
    monkeypatch.setattr(
        structures, "_executables", lambda: {"pot": Path("/mock/feff8l_pot")}
    )
    monkeypatch.setattr(
        structures, "_prepare_input", lambda *_: "TITLE public session test\n"
    )

    def run_module(self, executable, directory, log, deadline):
        # This runs on the real FEFF background thread, after the HTTP response.
        assert release.wait(10), "Mock calculation was never released"
        assert isinstance(self.store, AthenaStore)
        record = self.get(directory.name)
        project_id = record["request"].get("project_id")
        if project_id:
            assert self.store.load(project_id)["id"] == project_id
        captured.append(self.store.settings.data_root)
        shutil.copyfile(artemis._EXAMPLE, directory / "feff0001.dat")

    monkeypatch.setattr(structures.FeffJobs, "_run_module", run_module)
    yield release, captured
    release.set()


def test_public_mode_rejects_integration_even_with_valid_credentials(tmp_path):
    with pytest.raises(
        ValueError, match="Public browser mode cannot enable the integration API"
    ):
        Settings(
            data_root=tmp_path,
            public_mode=True,
            integration_api_enabled=True,
            integration_issuer="test-issuer",
            integration_audience="test-audience",
            integration_hmac_secret="a" * 64,
        )


def test_new_agent_reads_and_larix_export_remain_visitor_private(tmp_path):
    with browser(app(tmp_path)) as alice, browser(app(tmp_path)) as bob:
        project = attached_project(alice)
        base = f"/api/athena/projects/{project['id']}"
        for endpoint in (
            f"{base}?view=summary",
            f"{base}?view=parameters",
            f"{base}/transcript",
            f"{base}/groups/foil/digest",
            f"/api/artemis/projects/{project['id']}/groups/foil/export?format=larix",
        ):
            response = bob.get(endpoint)
            assert response.status_code == 404, response.text
        summary = alice.get(f"{base}?view=summary")
        assert summary.status_code == 200, summary.text
        transcript = alice.get(f"{base}/transcript")
        assert transcript.status_code == 200, transcript.text
        assert bob.post(
            f"/api/artemis/projects/{project['id']}/structures/foreign-cif/remove",
            json={"version": project["version"]},
        ).status_code == 404


def test_artemis_foreign_attachments_fit_and_attached_feff_are_denied(tmp_path):
    with browser(app(tmp_path)) as alice, browser(app(tmp_path)) as bob:
        project = attached_project(alice)
        endpoint = f"/api/artemis/projects/{project['id']}/structures"
        model = {
            "version": project["version"],
            "parameters": [{"name": "amp", "value": 1.0}],
            "paths": [
                {"id": "cu1", "filename": "feff0001.dat", "content": "test"}
            ],
        }
        responses = [
            bob.get(endpoint),
            bob.post(
                endpoint,
                json={"version": project["version"], "amcsd_id": 9994},
            ),
            bob.post(
                f"/api/artemis/projects/{project['id']}/groups/foil/fit",
                json=model,
            ),
            bob.post(JOB_PATH, json=job_request(project)),
        ]
        for response in responses:
            assert response.status_code == 404, response.text
            assert response.json()["error"]["code"] == "workspace_not_found"
        assert alice.get(endpoint).json()["structures"] == project[
            "artemis_structures"
        ]


def test_feff_background_uses_concrete_owner_store_and_status_is_private(
    tmp_path, mock_feff
):
    release, captured = mock_feff
    application = app(tmp_path)
    with browser(application) as alice, browser(application) as bob:
        project = attached_project(alice)
        response = alice.post(JOB_PATH, json=job_request(project))
        assert response.status_code == 202, response.text
        ident = response.json()["id"]
        denied = bob.get(f"{JOB_PATH}/{ident}")
        assert denied.status_code == 400, denied.text
        assert denied.json()["error"]["code"] == "invalid_artemis_structure"
        assert "provenance" not in denied.json()
        release.set()
        result = completed(alice, ident)
        assert result["provenance"]["project_id"] == project["id"]
        assert result["paths"][0]["metadata"]["degen"] == 12
        assert captured == [
            tmp_path / "sessions" / alice.cookies[COOKIE].split(".")[0]
        ]
        assert bob.get(f"{JOB_PATH}/{ident}").status_code == 400


def test_feff_two_job_limit_is_global_across_visitors_and_releases(
    tmp_path, mock_feff
):
    release, captured = mock_feff
    application = app(tmp_path)
    with (
        browser(application) as alice,
        browser(application) as bob,
        browser(application) as carol,
    ):
        first = alice.post(JOB_PATH, json=job_request())
        second = bob.post(JOB_PATH, json=job_request())
        assert first.status_code == second.status_code == 202
        denied = carol.post(JOB_PATH, json=job_request())
        assert denied.status_code == 400, denied.text
        assert denied.json()["error"]["code"] == "feff_busy"
        release.set()
        completed(alice, first.json()["id"])
        completed(bob, second.json()["id"])
        accepted = carol.post(JOB_PATH, json=job_request())
        assert accepted.status_code == 202, accepted.text
        completed(carol, accepted.json()["id"])
        assert len(set(captured)) == 3
        assert all(path.parent == tmp_path / "sessions" for path in captured)


def test_smoothing_apply_is_private_and_survives_requests_and_restart(tmp_path):
    endpoint = "/api/athena/preferences/smoothing"
    with browser(app(tmp_path)) as alice, browser(app(tmp_path)) as bob:
        before = alice.get(endpoint).json()
        other = bob.get(endpoint).json()
        request = {
            "version": before["version"],
            "session_id": before["session_id"],
            "values": {"window": 25, "order": 11},
            "save": False,
        }
        applied = alice.put(endpoint, json=request)
        assert applied.status_code == 200, applied.text
        assert applied.json()["unsaved"] is True
        assert applied.json()["saved"] == before["saved"]
        assert alice.get(endpoint).json() == applied.json()
        assert bob.get(endpoint).json() == other
        assert alice.put(endpoint, json=request).status_code == 409
        cookie = alice.cookies[COOKIE]
    with browser(app(tmp_path)) as restarted:
        restarted.cookies.set(COOKIE, cookie)
        assert restarted.get(endpoint).json() == applied.json()


def test_dispersive_get_put_export_import_remain_browser_private(tmp_path):
    endpoint = "/api/athena/preferences/dispersive"
    coefficients = {"offset": 8900.0, "linear": 2.0, "quadratic": 0.001}
    with browser(app(tmp_path)) as alice, browser(app(tmp_path)) as bob:
        assert alice.get(endpoint).json() == bob.get(endpoint).json() == {
            "version": 0,
            "coefficients": None,
        }
        saved = alice.put(
            endpoint, json={"version": 0, "coefficients": coefficients}
        )
        assert saved.status_code == 200, saved.text
        assert alice.get(endpoint).json()["coefficients"] == coefficients
        assert bob.get(endpoint).json() == {"version": 0, "coefficients": None}
        exported = alice.get(endpoint + "/file")
        assert exported.status_code == 200
        assert bob.get(endpoint + "/file").status_code == 400
        imported = bob.post(
            endpoint + "/import?version=0",
            files={"file": ("athena.dxas", exported.content)},
        )
        assert imported.status_code == 200, imported.text
        assert bob.get(endpoint).json()["coefficients"] == coefficients
        assert alice.get(endpoint).json() == saved.json()
