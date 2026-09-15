"""Host configuration reaches only the backend child, never its argv."""
import json
import os
from pathlib import Path
import subprocess

import pytest


@pytest.mark.parametrize("legacy", [False, True])
def test_deployer_uses_private_config_only_for_backend(tmp_path, legacy):
    deployer = Path(__file__).resolve().parents[2] / "scripts/deploy-xraylarch-web.sh"
    module = tmp_path / "backend/xraylarch_web/integration_runtime.py"
    module.parent.mkdir(parents=True)
    if not legacy:
        module.touch()
    script = '''
XRAYLARCH_WEB_TEST_MODE=1 source "$1"
release_sha_from_path() { printf '%s' 0123456789abcdef0123456789abcdef01234567; }
assert_release_identity() { :; }
assert_component_record_available() { :; }
assert_port_unbound() { :; }
capture_screen_record() { :; }
wait_for_component_record() { :; }
launch_screen() { printf '%s\\n' "$@"; }
launch_component TEST task "$3" "$2" 127.0.0.1 8006 http://127.0.0.1:8006
'''
    backend = subprocess.check_output(["bash", "-c", script, "test", str(deployer), "backend", str(tmp_path)], text=True)
    frontend = subprocess.check_output(["bash", "-c", script, "test", str(deployer), "frontend", str(tmp_path)], text=True)
    if legacy:
        assert "-m\nuvicorn\nxraylarch_web.main:app\n" in backend
        assert "integration.json" not in backend
    else:
        assert "xraylarch_web.integration_runtime\n/local/apps/xraylarch-web/config/integration.json\n" in backend
    assert "integration_runtime" not in frontend
    assert "integration.json" not in frontend


def config_file(tmp_path, values):
    path = tmp_path / "integration.json"
    path.write_text(json.dumps(values))
    path.chmod(0o600)
    return path


def enabled_config():
    return {
        "integration_api_enabled": True,
        "browser_consume_enabled": True,
        "import_enabled": True,
        "integration_issuer": "drxas-dev",
        "integration_audience": "editor-dev",
        "integration_hmac_secret": "test-only-secret-" * 3,
    }


def test_missing_config_disables_ambient_integration(tmp_path):
    from xraylarch_web.integration_runtime import backend_environment
    env = backend_environment(tmp_path / "absent", {
        "PATH": "/safe/bin", "XRAYLARCH_IMPORT_ENABLED": "true",
        "XRAYLARCH_INTEGRATION_HMAC_SECRET": "ambient-secret",
    })
    assert env == {"PATH": "/safe/bin"}


def test_private_config_reaches_exec_environment_without_secret_in_argv(tmp_path, monkeypatch):
    from xraylarch_web import integration_runtime as runtime
    values = enabled_config()
    path = config_file(tmp_path, values)
    captured = []
    monkeypatch.setattr(runtime.os, "execve", lambda *args: captured.append(args))
    runtime.main([str(path), "--host", "127.0.0.1", "--port", "8006"])
    executable, argv, env = captured[0]
    assert argv == [executable, "-m", "uvicorn", "xraylarch_web.main:app", "--host", "127.0.0.1", "--port", "8006"]
    assert env["XRAYLARCH_INTEGRATION_HMAC_SECRET"] == values["integration_hmac_secret"]
    assert env["XRAYLARCH_BROWSER_CONSUME_ENABLED"] == "true"
    assert env["XRAYLARCH_IMPORT_ENABLED"] == "true"
    assert values["integration_hmac_secret"] not in repr(argv)


def test_private_config_allows_non_secret_v2_quota_settings(tmp_path):
    from xraylarch_web.integration_runtime import backend_environment

    values = {
        **enabled_config(),
        "integration_max_projects": 4,
        "integration_max_files": 8,
        "integration_max_bytes": 1_000_000,
        "integration_max_groups": 12,
        "integration_max_exports": 6,
        "integration_guest_max_projects": 2,
        "integration_guest_max_files": 4,
        "integration_guest_max_bytes": 500_000,
        "integration_guest_max_groups": 6,
        "integration_guest_max_exports": 3,
        "integration_guest_ttl_seconds": 3600,
    }
    environment = backend_environment(config_file(tmp_path, values), {})
    assert environment["XRAYLARCH_INTEGRATION_MAX_PROJECTS"] == "4"
    assert environment["XRAYLARCH_INTEGRATION_GUEST_TTL_SECONDS"] == "3600"


@pytest.mark.parametrize("change", [
    {"PATH": "/injected"}, {"max_upload_bytes": 100}, {"import_enabled": "true"},
    {"integration_hmac_secret": "short"}, {"integration_api_enabled": False},
    {"draft_ttl_seconds": 604801},
])
def test_invalid_config_is_refused_without_values(tmp_path, change):
    from xraylarch_web.integration_runtime import backend_environment
    values = {**enabled_config(), **change}
    with pytest.raises(ValueError, match="Invalid integration runtime configuration") as error:
        backend_environment(config_file(tmp_path, values), {})
    assert values["integration_hmac_secret"] not in str(error.value)


@pytest.mark.parametrize("mode", [0o644, 0o620])
def test_config_must_be_private(tmp_path, mode):
    from xraylarch_web.integration_runtime import backend_environment
    path = config_file(tmp_path, enabled_config())
    path.chmod(mode)
    with pytest.raises(ValueError):
        backend_environment(path, {})


def test_symlink_refused_even_when_target_absent(tmp_path):
    from xraylarch_web.integration_runtime import backend_environment
    link = tmp_path / "link"
    link.symlink_to(tmp_path / "absent")
    with pytest.raises(ValueError):
        backend_environment(link, {})


def test_wrong_owner_refused(tmp_path, monkeypatch):
    from xraylarch_web import integration_runtime as runtime
    path = config_file(tmp_path, enabled_config())
    monkeypatch.setattr(runtime.os, "geteuid", lambda: os.stat(path).st_uid + 1)
    with pytest.raises(ValueError):
        runtime.backend_environment(path, {})


@pytest.mark.parametrize("raw", ['[]', '{', '{"import_enabled":false,"import_enabled":false}', '{}' + ' ' * 16383])
def test_malformed_duplicate_or_oversize_config_refused(tmp_path, raw):
    from xraylarch_web.integration_runtime import backend_environment
    path = tmp_path / "integration.json"
    path.write_text(raw)
    path.chmod(0o600)
    with pytest.raises(ValueError):
        backend_environment(path, {})
