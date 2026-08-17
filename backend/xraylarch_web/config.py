from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


_DEFAULT_MAX_UPLOAD_BYTES = 50_000_000


@dataclass(frozen=True)
class Settings:
    """Non-secret runtime settings for the local workspace service."""

    data_root: Path
    max_upload_bytes: int = _DEFAULT_MAX_UPLOAD_BYTES

    def __post_init__(self) -> None:
        object.__setattr__(self, "data_root", Path(self.data_root).expanduser())
        if self.max_upload_bytes <= 0:
            raise ValueError("XRAYLARCH_MAX_UPLOAD_BYTES must be greater than zero.")

    @classmethod
    def from_environment(cls) -> Settings:
        configured_root = os.environ.get("XRAYLARCH_DATA_ROOT")
        data_root = (
            Path(configured_root)
            if configured_root
            else Path(__file__).resolve().parents[1] / "data" / "xraylarch-web"
        )
        configured_limit = os.environ.get("XRAYLARCH_MAX_UPLOAD_BYTES")
        if configured_limit is None:
            max_upload_bytes = _DEFAULT_MAX_UPLOAD_BYTES
        else:
            try:
                max_upload_bytes = int(configured_limit)
            except ValueError as exc:
                raise ValueError(
                    "XRAYLARCH_MAX_UPLOAD_BYTES must be an integer."
                ) from exc
        return cls(data_root=data_root, max_upload_bytes=max_upload_bytes)
