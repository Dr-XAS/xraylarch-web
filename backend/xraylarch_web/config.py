from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


_DEFAULT_MAX_UPLOAD_BYTES = 50_000_000
_DEFAULT_MAX_POINTS = 250_000
_DEFAULT_MAX_COLUMNS = 64
_DEFAULT_MAX_NFFT = 262_144


@dataclass(frozen=True)
class Settings:
    """Non-secret runtime settings for the local workspace service."""

    data_root: Path
    max_upload_bytes: int = _DEFAULT_MAX_UPLOAD_BYTES
    max_points: int = _DEFAULT_MAX_POINTS
    max_columns: int = _DEFAULT_MAX_COLUMNS
    max_nfft: int = _DEFAULT_MAX_NFFT

    def __post_init__(self) -> None:
        object.__setattr__(self, "data_root", Path(self.data_root).expanduser())
        for name, value in (
            ("XRAYLARCH_MAX_UPLOAD_BYTES", self.max_upload_bytes),
            ("XRAYLARCH_MAX_POINTS", self.max_points),
            ("XRAYLARCH_MAX_COLUMNS", self.max_columns),
            ("XRAYLARCH_MAX_NFFT", self.max_nfft),
        ):
            if value <= 0:
                raise ValueError(f"{name} must be greater than zero.")

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

        return cls(
            data_root=data_root,
            max_upload_bytes=integer_setting(
                "XRAYLARCH_MAX_UPLOAD_BYTES", _DEFAULT_MAX_UPLOAD_BYTES
            ),
            max_points=integer_setting("XRAYLARCH_MAX_POINTS", _DEFAULT_MAX_POINTS),
            max_columns=integer_setting(
                "XRAYLARCH_MAX_COLUMNS", _DEFAULT_MAX_COLUMNS
            ),
            max_nfft=integer_setting("XRAYLARCH_MAX_NFFT", _DEFAULT_MAX_NFFT),
        )
