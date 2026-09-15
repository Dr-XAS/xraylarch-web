from __future__ import annotations

import pytest

from xraylarch_web.config import Settings


_INTEGRATION_ENV = (
    "XRAYLARCH_INTEGRATION_API_ENABLED",
    "XRAYLARCH_BROWSER_CONSUME_ENABLED",
    "XRAYLARCH_IMPORT_ENABLED",
    "XRAYLARCH_DRAFT_TTL_SECONDS",
    "XRAYLARCH_INTEGRATION_ISSUER",
    "XRAYLARCH_INTEGRATION_AUDIENCE",
    "XRAYLARCH_INTEGRATION_HMAC_SECRET",
)


def test_integration_settings_default_off_with_seven_day_ttl(tmp_path, monkeypatch):
    monkeypatch.setenv("XRAYLARCH_DATA_ROOT", str(tmp_path))
    for name in _INTEGRATION_ENV:
        monkeypatch.delenv(name, raising=False)

    settings = Settings.from_environment()

    assert settings.integration_api_enabled is False
    assert settings.browser_consume_enabled is False
    assert settings.import_enabled is False
    assert settings.draft_ttl_seconds == 7 * 24 * 60 * 60


@pytest.mark.parametrize("true_value", ["true", "TRUE", " true "])
@pytest.mark.parametrize("false_value", ["false", "FALSE", " false "])
def test_integration_boolean_environment_values_are_strictly_parsed(
    tmp_path, monkeypatch, true_value, false_value
):
    monkeypatch.setenv("XRAYLARCH_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("XRAYLARCH_INTEGRATION_API_ENABLED", true_value)
    monkeypatch.setenv("XRAYLARCH_BROWSER_CONSUME_ENABLED", true_value)
    monkeypatch.setenv("XRAYLARCH_IMPORT_ENABLED", false_value)
    monkeypatch.setenv("XRAYLARCH_INTEGRATION_ISSUER", "drxas")
    monkeypatch.setenv("XRAYLARCH_INTEGRATION_AUDIENCE", "xraylarch-web")
    monkeypatch.setenv("XRAYLARCH_INTEGRATION_HMAC_SECRET", "s" * 32)

    settings = Settings.from_environment()

    assert settings.integration_api_enabled is True
    assert settings.browser_consume_enabled is True
    assert settings.import_enabled is False


@pytest.mark.parametrize("value", ["1", "yes", "on", "", "truthy"])
def test_invalid_boolean_environment_values_are_rejected(tmp_path, monkeypatch, value):
    monkeypatch.setenv("XRAYLARCH_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("XRAYLARCH_INTEGRATION_API_ENABLED", value)
    with pytest.raises(ValueError, match="XRAYLARCH_INTEGRATION_API_ENABLED must be true or false"):
        Settings.from_environment()


@pytest.mark.parametrize("dependent", ["browser_consume_enabled", "import_enabled"])
def test_dependent_flags_require_integration_api(tmp_path, dependent):
    with pytest.raises(ValueError, match="integration API"):
        Settings(data_root=tmp_path, **{dependent: True})


def test_direct_settings_require_real_booleans(tmp_path):
    with pytest.raises(ValueError, match="must be a boolean"):
        Settings(data_root=tmp_path, integration_api_enabled=1)


@pytest.mark.parametrize("ttl", [0, -1, 8 * 24 * 60 * 60, True, 1.5])
def test_draft_ttl_must_be_positive_and_bounded(tmp_path, ttl):
    with pytest.raises(ValueError, match="XRAYLARCH_DRAFT_TTL_SECONDS"):
        Settings(data_root=tmp_path, draft_ttl_seconds=ttl)


def test_draft_ttl_is_parsed_from_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("XRAYLARCH_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("XRAYLARCH_DRAFT_TTL_SECONDS", "3600")
    assert Settings.from_environment().draft_ttl_seconds == 3600


def test_enabled_integration_requires_signing_identity_and_secret(tmp_path):
    with pytest.raises(ValueError, match="issuer"):
        Settings(data_root=tmp_path, integration_api_enabled=True)
    with pytest.raises(ValueError, match="audience"):
        Settings(
            data_root=tmp_path,
            integration_api_enabled=True,
            integration_issuer="drxas",
        )
    with pytest.raises(ValueError, match="secret"):
        Settings(
            data_root=tmp_path,
            integration_api_enabled=True,
            integration_issuer="drxas",
            integration_audience="xraylarch-web",
        )


def test_integration_secret_requires_at_least_32_characters_when_enabled(tmp_path):
    with pytest.raises(ValueError, match="secret"):
        Settings(
            data_root=tmp_path,
            integration_api_enabled=True,
            integration_issuer="drxas",
            integration_audience="xraylarch-web",
            integration_hmac_secret="short",
        )


def test_signing_settings_load_from_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("XRAYLARCH_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("XRAYLARCH_INTEGRATION_API_ENABLED", "true")
    monkeypatch.setenv("XRAYLARCH_INTEGRATION_ISSUER", "drxas")
    monkeypatch.setenv("XRAYLARCH_INTEGRATION_AUDIENCE", "xraylarch-web")
    monkeypatch.setenv("XRAYLARCH_INTEGRATION_HMAC_SECRET", "s" * 32)

    settings = Settings.from_environment()

    assert settings.integration_issuer == "drxas"
    assert settings.integration_audience == "xraylarch-web"
    assert settings.integration_hmac_secret == "s" * 32
