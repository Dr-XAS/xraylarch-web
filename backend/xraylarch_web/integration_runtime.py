"""Load private host integration configuration after the clean backend launch."""
from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

from .config import Settings


_FIELDS = (
    "integration_api_enabled", "browser_consume_enabled", "import_enabled",
    "integration_issuer", "integration_audience", "integration_hmac_secret",
    "draft_ttl_seconds",
    "integration_max_projects", "integration_max_files", "integration_max_bytes",
    "integration_max_groups", "integration_max_exports",
    "integration_guest_max_projects", "integration_guest_max_files",
    "integration_guest_max_bytes", "integration_guest_max_groups",
    "integration_guest_max_exports", "integration_guest_ttl_seconds",
)
_ERROR = "Invalid integration runtime configuration"


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(_ERROR)
        result[key] = value
    return result


def backend_environment(path: Path, inherited: dict[str, str]) -> dict[str, str]:
    environment = dict(inherited)
    for field in _FIELDS:
        environment.pop("XRAYLARCH_" + field.upper(), None)
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return environment
    except OSError:
        raise ValueError(_ERROR) from None
    try:
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
                raise ValueError(_ERROR)
            raw = handle.read(16385)
        if len(raw) > 16384:
            raise ValueError(_ERROR)
        values = json.loads(raw, object_pairs_hook=_unique_object)
        if not isinstance(values, dict) or set(values) - set(_FIELDS):
            raise ValueError(_ERROR)
        # Reuse the backend's gate hierarchy, strict boolean and TTL validation.
        Settings(data_root=Path(environment.get("XRAYLARCH_DATA_ROOT", ".")), **values)
        for key, value in values.items():
            if not isinstance(value, (str, bool, int)) or isinstance(value, str) and "\x00" in value:
                raise ValueError(_ERROR)
            environment["XRAYLARCH_" + key.upper()] = str(value).lower() if isinstance(value, bool) else str(value)
    except (OSError, ValueError, TypeError, AttributeError):
        raise ValueError(_ERROR) from None
    return environment


def main(arguments: list[str] | None = None) -> None:
    args = sys.argv[1:] if arguments is None else arguments
    if not args:
        raise SystemExit("Integration runtime configuration path required")
    try:
        environment = backend_environment(Path(args[0]), dict(os.environ))
    except ValueError:
        raise SystemExit(_ERROR) from None
    os.execve(sys.executable, [sys.executable, "-m", "uvicorn", "xraylarch_web.main:app", *args[1:]], environment)


if __name__ == "__main__":
    main()
