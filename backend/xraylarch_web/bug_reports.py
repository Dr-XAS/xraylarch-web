"""Bug reports, feature requests and feedback, filed from the workbench.

Reports land in a local bug library under ``<data_root>/bug_reports``, one
directory per report, in the same layout Dr.XAS keeps for its own reports so
that its reading tools can be pointed at this directory later:

    bug_reports/<report_id>/
        report.json             the record, every other file named from here
        description.txt         what the reporter wrote
        screenshot_N.<ext>      pasted or dropped images
        attachments/NN_<name>   every other file the reporter added
        client_metadata.json    browser, page, build and storage capture
        project_state.json      what the workbench was showing, plus the
                                project summary and recent transcript read here
        project_export.json     the athena-web project, when asked for

There is no reader. V1 is a trusted-network application without accounts, so
nothing here is exposed back over HTTP; the directory is read on the host.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, File, Form, UploadFile

from . import __version__
from .agent_views import project_summary
from .bug_report_notify import schedule_report_notification
from .errors import WebInputError

logger = logging.getLogger(__name__)

REPORT_TYPES = ("bug", "feature_request", "feedback")
# This app's slug in the shared Dr.XAS bug library. Dr.XAS reports carry no
# ``project_id``; every other project's reports name theirs.
REPORT_PROJECT = "xraylarch-web"

REPORT_FILE_NAME = "report.json"
DESCRIPTION_FILE_NAME = "description.txt"
CLIENT_METADATA_FILE_NAME = "client_metadata.json"
PROJECT_STATE_FILE_NAME = "project_state.json"
PROJECT_EXPORT_FILE_NAME = "project_export.json"
ATTACHMENTS_DIR_NAME = "attachments"

MAX_DESCRIPTION_BYTES = 64 * 1024
MAX_EMAIL_CHARS = 254
MAX_SCREENSHOTS = 5
MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
MAX_ATTACHMENTS = 10
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_CLIENT_METADATA_BYTES = 16 * 1024 * 1024
MAX_PROJECT_STATE_BYTES = 1024 * 1024
CLIENT_METADATA_SCHEMA_VERSION = 1
TRANSCRIPT_RECORDS = 20

_READ_CHUNK_BYTES = 1024 * 1024
_STAGE_PREFIX = ".stage-"
_MAX_EXTENSION_CHARS = 16
_SUMMARY_LIMIT = 128
_PAGE_SUMMARY_LIMIT = 256
PUBLIC_REPORT_LIBRARY_BYTES = 500 * 1024 * 1024
PUBLIC_DISK_RESERVE_BYTES = 1024 * 1024 * 1024


@contextmanager
def _public_report_capacity(settings, incoming_bytes: int):
    """Bound anonymous reports without deleting reports or touching project data."""
    if not settings.public_mode:
        yield
        return
    import fcntl

    directory = Path(settings.data_root) / "bug_reports"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(directory / ".quota.lock", "a+b") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            used = sum(path.stat().st_size for path in directory.rglob("*")
                       if path.is_file() and not path.is_symlink())
            if (used + incoming_bytes > PUBLIC_REPORT_LIBRARY_BYTES
                    or shutil.disk_usage(directory).free - incoming_bytes < PUBLIC_DISK_RESERVE_BYTES):
                raise WebInputError(
                    "bug_report_capacity", "The report library cannot accept more data right now.",
                    (), "Try without attachments or contact the website operator. Existing reports are retained.",
                )
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _invalid(message: str, *fields: str) -> WebInputError:
    return WebInputError(
        "bug_report_invalid",
        message,
        tuple(fields),
        "Review the report and retry.",
    )


def _utc_iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_report_id(report_type: str, now: datetime | None = None) -> str:
    """``bug_<stamp>_<uuid8>`` for bugs and requests, ``feedback_`` otherwise.

    The same shape Dr.XAS mints, so a mixed directory still sorts by time.
    """
    moment = now or datetime.now(UTC)
    prefix = "feedback" if report_type == "feedback" else "bug"
    return f"{prefix}_{moment.strftime('%Y%m%d_%H%M%S')}_{uuid4().hex[:8]}"


def normalize_email(value: str | None) -> str:
    candidate = (value or "").strip()
    if not candidate or "@" not in candidate or any(c.isspace() for c in candidate):
        raise _invalid("A valid email is required so we can follow up.", "user_email")
    if len(candidate) > MAX_EMAIL_CHARS:
        raise _invalid("The email address is too long.", "user_email")
    return candidate


def normalize_type(value: str | None) -> str:
    candidate = (value or "bug").strip()
    if candidate not in REPORT_TYPES:
        raise _invalid("Choose bug, feature_request or feedback.", "type")
    return candidate


def normalize_description(value: str | None) -> str:
    candidate = (value or "").strip()
    if not candidate:
        raise _invalid("Describe the problem before submitting.", "description")
    if len(candidate.encode("utf-8")) > MAX_DESCRIPTION_BYTES:
        raise _invalid(
            f"The description exceeds {MAX_DESCRIPTION_BYTES} bytes.", "description"
        )
    return candidate


def _parse_json_field(value: str | None, field: str, max_bytes: int) -> dict[str, Any] | None:
    if value is None or not value.strip():
        return None
    if len(value.encode("utf-8")) > max_bytes:
        raise _invalid(f"{field} exceeds {max_bytes} bytes.", field)
    try:
        parsed = json.loads(value)
    except ValueError as exc:
        raise _invalid(f"{field} is not valid JSON.", field) from exc
    if not isinstance(parsed, dict):
        raise _invalid(f"{field} must be a JSON object.", field)
    return parsed


def normalize_client_metadata(value: Any) -> dict[str, Any] | None:
    """Accept only schema-v1 metadata; the same test Dr.XAS applies."""
    if not isinstance(value, dict):
        return None
    version = value.get("schema_version")
    if type(version) is not int or version != CLIENT_METADATA_SCHEMA_VERSION:
        return None
    storage = value.get("storage")
    if not isinstance(storage, dict):
        return None
    for field in ("local_storage", "session_storage"):
        entries = storage.get(field)
        if not isinstance(entries, dict) or not all(
            isinstance(key, str) and isinstance(item, str) for key, item in entries.items()
        ):
            return None
    return value


def _clip(value: Any, limit: int) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _name_and_version(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    parts = [item for item in (value.get("name"), value.get("version")) if isinstance(item, str) and item]
    return _clip(" ".join(parts), _SUMMARY_LIMIT)


def client_metadata_summary(metadata: dict[str, Any]) -> dict[str, Any]:
    """The few fields a reader wants before opening the sidecar."""
    app = metadata.get("app") if isinstance(metadata.get("app"), dict) else {}
    page = metadata.get("page") if isinstance(metadata.get("page"), dict) else {}
    storage = metadata["storage"]
    storage_bytes = sum(
        len(json.dumps(storage[field], ensure_ascii=False).encode("utf-8"))
        for field in ("local_storage", "session_storage")
    )
    return {
        "captured_at": _clip(metadata.get("captured_at"), 64),
        "browser": _name_and_version(metadata.get("browser")),
        "os": _name_and_version(metadata.get("os")),
        "app_version": _clip(app.get("version"), _SUMMARY_LIMIT),
        "page": _clip(page.get("pathname"), _PAGE_SUMMARY_LIMIT),
        "storage_bytes": storage_bytes,
    }


def _safe_extension(filename: str | None) -> str:
    """Keep a short alphanumeric extension, or fall back to ``.png``."""
    suffix = Path(filename or "").suffix.lstrip(".")
    kept = ""
    for char in suffix:
        if not char.isalnum():
            break
        kept += char
        if len(kept) == _MAX_EXTENSION_CHARS:
            break
    return f".{kept.lower()}" if kept else ".png"


def _safe_basename(filename: str | None, fallback: str) -> str:
    name = Path(filename or "").name.strip()
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    return name if name and name not in (".", "..") else fallback


def _read_bounded(upload: UploadFile, max_bytes: int, field: str, label: str) -> bytes:
    chunks: list[bytes] = []
    size = 0
    try:
        while chunk := upload.file.read(_READ_CHUNK_BYTES):
            size += len(chunk)
            if size > max_bytes:
                raise _invalid(f"{label} exceeds the {max_bytes} byte limit.", field)
            chunks.append(chunk)
    finally:
        upload.file.close()
    return b"".join(chunks)


def _write_bytes(path: Path, content: bytes) -> None:
    path.write_bytes(content)
    os.chmod(path, 0o600)
    with open(path, "rb") as handle:
        os.fsync(handle.fileno())


def _write_text(path: Path, content: str) -> None:
    _write_bytes(path, content.encode("utf-8"))


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class BugReportStore:
    """Writes one report directory atomically under ``<data_root>/bug_reports``."""

    def __init__(self, data_root: Path) -> None:
        self.data_root = Path(data_root)
        self.storage_dir = self.data_root / "bug_reports"

    def report_dir(self, report_id: str) -> Path:
        return self.storage_dir / report_id

    def store(
        self,
        *,
        report_id: str,
        report_type: str,
        description: str,
        user_email: str,
        screenshots: list[tuple[bytes, str]] = (),
        attachments: list[tuple[bytes, str, str | None]] = (),
        client_metadata: dict[str, Any] | None = None,
        project_state: dict[str, Any] | None = None,
        project_export: bytes | None = None,
        project_export_error: str | None = None,
        created_at: datetime | None = None,
    ) -> dict[str, Any]:
        """Stage every file, then publish the directory with one rename.

        A reader never sees a half-written report: the stage is private until
        the rename, and a failure before it leaves nothing behind.
        """
        created = created_at or datetime.now(UTC)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        final_dir = self.report_dir(report_id)
        if final_dir.exists():
            raise FileExistsError(f"bug report {report_id} already exists")
        stage = self.storage_dir / f"{_STAGE_PREFIX}{uuid4().hex}"
        stage.mkdir(mode=0o700)
        try:
            screenshot_files: list[str] = []
            for index, (content, filename) in enumerate(screenshots, start=1):
                name = f"screenshot_{index}{_safe_extension(filename)}"
                _write_bytes(stage / name, content)
                screenshot_files.append(name)

            attached_files: list[dict[str, Any]] = []
            if attachments:
                attachments_dir = stage / ATTACHMENTS_DIR_NAME
                attachments_dir.mkdir(mode=0o700)
                for index, (content, filename, content_type) in enumerate(attachments, start=1):
                    original = _safe_basename(filename, f"attachment_{index}")
                    stored = f"{index:02d}_{original}"
                    _write_bytes(attachments_dir / stored, content)
                    attached_files.append({
                        "name": original,
                        "stored_filename": stored,
                        "type": content_type,
                        "size_bytes": len(content),
                        "has_content": True,
                    })
                _fsync_directory(attachments_dir)

            _write_text(stage / DESCRIPTION_FILE_NAME, description)

            relative = final_dir.relative_to(self.data_root)
            payload: dict[str, Any] = {
                "report_id": report_id,
                "attachment_owner_report_id": report_id,
                "project_id": REPORT_PROJECT,
                "description": description,
                "user_email": user_email,
                "created_at": _utc_iso(created),
                "status": "pending",
                "source": "local_bug_library",
                "type": report_type,
                "admin_schedule_approved": False,
                "surface": "web",
                "screenshot_files": screenshot_files,
                "description_file": str(relative / DESCRIPTION_FILE_NAME),
                "report_file": str(relative / REPORT_FILE_NAME),
                "app": {
                    "name": REPORT_PROJECT,
                    "version": __version__,
                    "git_revision": os.environ.get("XRAYLARCH_GIT_REVISION") or None,
                },
            }
            if attached_files:
                payload["attached_files"] = attached_files

            if client_metadata is not None:
                _write_text(stage / CLIENT_METADATA_FILE_NAME,
                            json.dumps(client_metadata, ensure_ascii=False, sort_keys=True))
                payload["client_metadata_file"] = CLIENT_METADATA_FILE_NAME
                payload["client_metadata_summary"] = client_metadata_summary(client_metadata)

            if project_state is not None:
                _write_text(stage / PROJECT_STATE_FILE_NAME,
                            json.dumps(project_state, ensure_ascii=False, indent=2, sort_keys=True))
                payload["project_state_file"] = PROJECT_STATE_FILE_NAME
                payload["project_state_summary"] = project_state_summary(project_state)

            if project_export is not None:
                _write_bytes(stage / PROJECT_EXPORT_FILE_NAME, project_export)
                payload["project_export_file"] = PROJECT_EXPORT_FILE_NAME
                payload["project_export_bytes"] = len(project_export)
            if project_export_error:
                payload["project_export_error"] = project_export_error

            report_path = stage / REPORT_FILE_NAME
            _write_text(report_path, json.dumps(payload, indent=2, ensure_ascii=False))
            _fsync_directory(stage)
            os.replace(stage, final_dir)
            _fsync_directory(self.storage_dir)
            stage = None
            return payload
        finally:
            if stage is not None:
                shutil.rmtree(stage, ignore_errors=True)


def project_state_summary(state: dict[str, Any]) -> dict[str, Any]:
    project = state.get("project") if isinstance(state.get("project"), dict) else {}
    summary = state.get("summary") if isinstance(state.get("summary"), dict) else {}
    counts = summary.get("counts") if isinstance(summary.get("counts"), dict) else {}
    groups = project.get("groups") if isinstance(project.get("groups"), list) else []
    return {
        "mode": _clip(state.get("mode"), 32),
        "athena_project_id": _clip(project.get("id"), 128),
        "project_name": _clip(project.get("name"), _SUMMARY_LIMIT),
        "version": project.get("version") if isinstance(project.get("version"), int) else None,
        "group_count": counts.get("groups") if isinstance(counts.get("groups"), int) else len(groups),
        "failed_groups": counts.get("failed") if isinstance(counts.get("failed"), int) else None,
        "error": _clip(state.get("error"), _PAGE_SUMMARY_LIMIT),
        "transcript_records": len(state["transcript"]) if isinstance(state.get("transcript"), list) else 0,
    }


def _server_project_state(athena_store, project_id: str | None) -> dict[str, Any]:
    """What the backend knows about the project: its summary and recent commands.

    Read-only, and tolerant: a report about a project that no longer loads is
    still a report, so the failure is recorded in place of the summary.
    """
    if not project_id:
        return {}
    extra: dict[str, Any] = {}
    try:
        extra["summary"] = project_summary(athena_store.load(project_id))
    except Exception as exc:  # noqa: BLE001 - recorded, never raised
        extra["summary_error"] = str(exc)[:500]
    try:
        extra["transcript"] = athena_store.transcript.read(project_id, limit=TRANSCRIPT_RECORDS)
    except Exception as exc:  # noqa: BLE001
        extra["transcript_error"] = str(exc)[:500]
    return extra


def build_bug_report_router(settings, athena_store) -> APIRouter:
    router = APIRouter(prefix="/api")
    store = BugReportStore(settings.data_root)

    @router.post("/bug-reports")
    def submit_bug_report(
        background: BackgroundTasks,
        description: str = Form(default=""),
        type: str = Form(default="bug"),
        user_email: str = Form(default=""),
        project_id: str | None = Form(default=None),
        attach_project: bool = Form(default=False),
        project_state: str | None = Form(default=None),
        client_metadata: str | None = Form(default=None),
        screenshots: list[UploadFile] | None = File(default=None),
        attachments: list[UploadFile] | None = File(default=None),
    ) -> dict[str, Any]:
        # Plain ``def``: file reads and the project export run in the threadpool.
        report_type = normalize_type(type)
        clean_description = normalize_description(description)
        email = normalize_email(user_email)

        screenshot_uploads = screenshots or []
        attachment_uploads = attachments or []
        if len(screenshot_uploads) > MAX_SCREENSHOTS:
            raise _invalid(f"Attach at most {MAX_SCREENSHOTS} screenshots.", "screenshots")
        if len(attachment_uploads) > MAX_ATTACHMENTS:
            raise _invalid(f"Attach at most {MAX_ATTACHMENTS} files.", "attachments")
        screenshot_data = [
            (_read_bounded(upload, MAX_SCREENSHOT_BYTES, "screenshots", "A screenshot"), upload.filename or "")
            for upload in screenshot_uploads
        ]
        attachment_data = [
            (_read_bounded(upload, MAX_ATTACHMENT_BYTES, "attachments", "An attachment"),
             upload.filename or "", upload.content_type)
            for upload in attachment_uploads
        ]

        metadata = normalize_client_metadata(
            _parse_json_field(client_metadata, "client_metadata", MAX_CLIENT_METADATA_BYTES)
        )
        if client_metadata and metadata is None:
            logger.warning("bug report: client metadata rejected, not schema v1")

        clean_project_id = (project_id or "").strip() or None
        if clean_project_id and (len(clean_project_id) > 128 or "/" in clean_project_id):
            raise _invalid("project_id is malformed.", "project_id")
        state = _parse_json_field(project_state, "project_state", MAX_PROJECT_STATE_BYTES)
        server_state = _server_project_state(athena_store, clean_project_id)
        if server_state:
            state = {**(state or {}), **server_state}

        export: bytes | None = None
        export_error: str | None = None
        if attach_project and clean_project_id:
            try:
                export = athena_store.export_project(clean_project_id, "json")
            except Exception as exc:  # noqa: BLE001 - the report still files
                export_error = str(exc)[:500]
                logger.warning("bug report: project export failed: %s", export_error)

        report_id = new_report_id(report_type)
        incoming_bytes = (sum(len(item[0]) for item in screenshot_data + attachment_data)
                          + len(export or b"") + 2 * len(clean_description.encode("utf-8"))
                          + len(json.dumps(metadata, ensure_ascii=False).encode("utf-8"))
                          + len(json.dumps(state, ensure_ascii=False, indent=2).encode("utf-8"))
                          + 64 * 1024)
        with _public_report_capacity(settings, incoming_bytes):
            payload = store.store(
                report_id=report_id,
                report_type=report_type,
                description=clean_description,
                user_email=email,
                screenshots=screenshot_data,
                attachments=attachment_data,
                client_metadata=metadata,
                project_state=state,
                project_export=export,
                project_export_error=export_error,
            )
        schedule_report_notification(background, payload)
        label = {"bug": "Bug report", "feature_request": "Feature request", "feedback": "Feedback"}[report_type]
        return {
            "status": "success",
            "report_id": report_id,
            "type": report_type,
            "stored_locally": True,
            "project_export_attached": export is not None,
            "message": f"{label} {report_id} saved.",
        }

    return router
