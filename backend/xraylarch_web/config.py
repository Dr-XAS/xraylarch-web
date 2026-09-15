from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


_DEFAULT_MAX_UPLOAD_BYTES = 50_000_000
_DEFAULT_MAX_POINTS = 250_000
# Multi-element detector scans can carry more than 64 source channels.
DEFAULT_MAX_COLUMNS = 256
_DEFAULT_MAX_NFFT = 262_144
_DEFAULT_DRAFT_TTL_SECONDS = 7 * 24 * 60 * 60
_MAX_DRAFT_TTL_SECONDS = 7 * 24 * 60 * 60


@dataclass(frozen=True)
class Settings:
    """Non-secret runtime settings for the local workspace service."""

    data_root: Path
    max_upload_bytes: int = _DEFAULT_MAX_UPLOAD_BYTES
    max_points: int = _DEFAULT_MAX_POINTS
    max_columns: int = DEFAULT_MAX_COLUMNS
    max_nfft: int = _DEFAULT_MAX_NFFT
    integration_api_enabled: bool = False
    browser_consume_enabled: bool = False
    import_enabled: bool = False
    draft_ttl_seconds: int = _DEFAULT_DRAFT_TTL_SECONDS
    integration_issuer: str | None = None
    integration_audience: str | None = None
    integration_hmac_secret: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "data_root", Path(self.data_root).expanduser())
        for name, value in (
            ("integration_api_enabled", self.integration_api_enabled),
            ("browser_consume_enabled", self.browser_consume_enabled),
            ("import_enabled", self.import_enabled),
        ):
            if not isinstance(value, bool):
                raise ValueError(f"{name} must be a boolean.")
        for name, value in (
            ("XRAYLARCH_MAX_UPLOAD_BYTES", self.max_upload_bytes),
            ("XRAYLARCH_MAX_POINTS", self.max_points),
            ("XRAYLARCH_MAX_COLUMNS", self.max_columns),
            ("XRAYLARCH_MAX_NFFT", self.max_nfft),
            ("XRAYLARCH_DRAFT_TTL_SECONDS", self.draft_ttl_seconds),
        ):
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"{name} must be an integer.")
            if value <= 0:
                raise ValueError(f"{name} must be greater than zero.")
        if self.draft_ttl_seconds > _MAX_DRAFT_TTL_SECONDS:
            raise ValueError(
                "XRAYLARCH_DRAFT_TTL_SECONDS must not exceed 604800 seconds."
            )
        if not self.integration_api_enabled and (
            self.browser_consume_enabled or self.import_enabled
        ):
            raise ValueError(
                "Browser consume and import require the integration API to be enabled."
            )
        if self.integration_api_enabled:
            if not self.integration_issuer or not self.integration_issuer.strip():
                raise ValueError("Integration issuer must be configured.")
            if not self.integration_audience or not self.integration_audience.strip():
                raise ValueError("Integration audience must be configured.")
            if (
                not self.integration_hmac_secret
                or len(self.integration_hmac_secret) < 32
            ):
                raise ValueError(
                    "Integration HMAC secret must contain at least 32 characters."
                )

    @classmethod
    def from_environment(cls) -> Settings:
        configured_root = os.environ.get("XRAYLARCH_DATA_ROOT")
        data_root = (
            Path(configured_root)
            if configured_root
            else Path(__file__).resolve().parents[1] / "data" / "xraylarch-web"
        )
        def integer_setting(name: str, default: int) -> int:
            configured = os.environ.get(name)
            if configured is None:
                return default
            try:
                return int(configured)
            except ValueError as exc:
                raise ValueError(f"{name} must be an integer.") from exc

        def boolean_setting(name: str) -> bool:
            configured = os.environ.get(name)
            if configured is None:
                return False
            normalized = configured.strip().lower()
            if normalized == "true":
                return True
            if normalized == "false":
                return False
            raise ValueError(f"{name} must be true or false.")

        return cls(
            data_root=data_root,
            max_upload_bytes=integer_setting(
                "XRAYLARCH_MAX_UPLOAD_BYTES", _DEFAULT_MAX_UPLOAD_BYTES
            ),
            max_points=integer_setting("XRAYLARCH_MAX_POINTS", _DEFAULT_MAX_POINTS),
            max_columns=integer_setting(
                "XRAYLARCH_MAX_COLUMNS", DEFAULT_MAX_COLUMNS
            ),
            max_nfft=integer_setting("XRAYLARCH_MAX_NFFT", _DEFAULT_MAX_NFFT),
            integration_api_enabled=boolean_setting(
                "XRAYLARCH_INTEGRATION_API_ENABLED"
            ),
            browser_consume_enabled=boolean_setting(
                "XRAYLARCH_BROWSER_CONSUME_ENABLED"
            ),
            import_enabled=boolean_setting("XRAYLARCH_IMPORT_ENABLED"),
            draft_ttl_seconds=integer_setting(
                "XRAYLARCH_DRAFT_TTL_SECONDS", _DEFAULT_DRAFT_TTL_SECONDS
            ),
            integration_issuer=os.environ.get("XRAYLARCH_INTEGRATION_ISSUER"),
            integration_audience=os.environ.get("XRAYLARCH_INTEGRATION_AUDIENCE"),
            integration_hmac_secret=os.environ.get(
                "XRAYLARCH_INTEGRATION_HMAC_SECRET"
            ),
        )
