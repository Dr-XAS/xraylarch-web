from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta
import base64
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
from typing import Iterator, Callable

from .integration_contracts import (
    ArtifactSourceIdentity,
    DraftStatus,
    ImportBinding,
    LaunchEnvelope,
    canonical_sha256,
)


_OPAQUE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


class IntegrationStorageError(ValueError):
    pass


class IntegrationReplayError(IntegrationStorageError):
    pass


class IntegrationNotFoundError(IntegrationStorageError):
    pass


class IntegrationConflictError(IntegrationStorageError):
    pass


@dataclass(frozen=True)
class DraftOrigin:
    """Launch facts a sealed export needs but cannot rebuild from the workspace.

    The Athena project keeps only the arrays and the flat parameter map, so the
    artifact identity and the recipe's own version stamps would otherwise be
    lost the moment the draft is created. ``spectrum_sha256`` is carried too so
    an export can prove the authoritative arrays were never edited instead of
    taking the workspace's word for it.
    """

    source: ArtifactSourceIdentity
    recipe_version: int
    larch_version: str
    spectrum_sha256: str


@dataclass(frozen=True)
class DraftRecord:
    id: str
    project_id: str
    group_id: str
    source_sha256: str
    owner_capability_hash: str
    handle_hash: str
    status: DraftStatus
    created_at: datetime
    updated_at: datetime
    expires_at: datetime
    origin: DraftOrigin | None = None
    import_binding: ImportBinding | None = None


@dataclass(frozen=True)
class BrowserSession:
    draft_id: str
    project_id: str
    group_id: str
    source_sha256: str
    owner_capability: str


def capability_for_handle(handle: str, integration_secret: str) -> str:
    digest = hmac.new(
        integration_secret.encode(),
        b"xraylarch-owner-capability\0" + handle.encode(),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _dt(value: datetime | str) -> datetime:
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value)
    elif isinstance(value, datetime):
        parsed = value
    else:
        raise ValueError("Integration timestamps must be ISO strings or datetimes.")
    if parsed.tzinfo is None:
        raise ValueError("Integration timestamps must include a timezone.")
    return parsed.astimezone(UTC)


class IntegrationStorage:
    def __init__(
        self,
        data_root: Path,
        *,
        integration_secret: str,
        draft_ttl_seconds: int = 604800,
    ) -> None:
        self.root = Path(data_root).expanduser().resolve() / "integration"
        self.integration_secret = integration_secret
        self.draft_ttl_seconds = draft_ttl_seconds
        self.drafts_dir = self.root / "drafts"
        self.nonces_dir = self.root / "nonces"
        self.handles_dir = self.root / "handles"
        for path in (self.root, self.drafts_dir, self.nonces_dir, self.handles_dir):
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(path, 0o700)

    @staticmethod
    def _validate_opaque(value: str) -> str:
        if not isinstance(value, str) or not _OPAQUE.fullmatch(value):
            raise IntegrationNotFoundError("Integration draft was not found.")
        return value

    @staticmethod
    def _source_sha256(envelope: LaunchEnvelope) -> str:
        return canonical_sha256(envelope.source)

    @staticmethod
    def _serialize(record: DraftRecord) -> dict:
        value = asdict(record)
        value["status"] = record.status.value
        for key in ("created_at", "updated_at", "expires_at"):
            value[key] = value[key].isoformat()
        if record.origin is not None:
            value["origin"] = {
                "source": record.origin.source.model_dump(mode="json"),
                "recipe_version": record.origin.recipe_version,
                "larch_version": record.origin.larch_version,
                "spectrum_sha256": record.origin.spectrum_sha256,
            }
        if record.import_binding is not None:
            value["import_binding"] = record.import_binding.model_dump(mode="json")
        return value

    @staticmethod
    def _deserialize(value: dict) -> DraftRecord:
        return DraftRecord(
            id=value["id"],
            project_id=value["project_id"],
            group_id=value["group_id"],
            source_sha256=value["source_sha256"],
            owner_capability_hash=value["owner_capability_hash"],
            handle_hash=value["handle_hash"],
            status=DraftStatus(value["status"]),
            created_at=_dt(value["created_at"]),
            updated_at=_dt(value["updated_at"]),
            expires_at=_dt(value["expires_at"]),
            origin=IntegrationStorage._deserialize_origin(value.get("origin")),
            import_binding=(ImportBinding.model_validate(value["import_binding"])
                            if value.get("import_binding") is not None else None),
        )

    @staticmethod
    def _deserialize_origin(value: dict | None) -> DraftOrigin | None:
        # Drafts written before the export milestone carry no origin. Return None
        # rather than raising: these records are still globbed wholesale by
        # expire_due, so one stale file must not poison every other operation.
        if not isinstance(value, dict):
            return None
        try:
            return DraftOrigin(
                source=ArtifactSourceIdentity.model_validate(value["source"]),
                recipe_version=value["recipe_version"],
                larch_version=value["larch_version"],
                spectrum_sha256=value["spectrum_sha256"],
            )
        except (KeyError, TypeError, ValueError):
            return None

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _atomic_json(self, path: Path, value: dict) -> None:
        temporary = path.with_name(f".{path.name}.{secrets.token_urlsafe(8)}.tmp")
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(value, stream, separators=(",", ":"), allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            os.chmod(path, 0o600)
            self._fsync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)

    @contextmanager
    def _lock(self, name: str) -> Iterator[None]:
        path = self.root / f".{name}.lock"
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    @contextmanager
    def draft_lock(self, draft_id: str) -> Iterator[None]:
        with self._lock(f"draft-{self._validate_opaque(draft_id)}"):
            yield

    def claim_nonce(self, *, nonce: str, expires_at: datetime) -> None:
        self._validate_opaque(nonce)
        path = self.nonces_dir / f"{_hash(nonce)}.json"
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as exc:
            raise IntegrationReplayError("Integration request nonce was already used.") from exc
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump({"nonce_hash": _hash(nonce), "expires_at": _dt(expires_at).isoformat()}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(path, 0o600)
            self._fsync_directory(self.nonces_dir)
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def _read_draft_unchecked(self, draft_id: str) -> DraftRecord:
        self._validate_opaque(draft_id)
        try:
            with open(self.drafts_dir / f"{draft_id}.json", encoding="utf-8") as stream:
                return self._deserialize(json.load(stream))
        except (FileNotFoundError, KeyError, ValueError, json.JSONDecodeError) as exc:
            raise IntegrationNotFoundError("Integration draft was not found.") from exc

    def create_draft(
        self,
        *,
        envelope: LaunchEnvelope,
        owner_capability: str,
        browser_handle: str,
        project_id: str,
        group_id: str,
        created_at: datetime,
    ) -> DraftRecord:
        self._validate_opaque(owner_capability)
        self._validate_opaque(browser_handle)
        self._validate_opaque(project_id)
        self._validate_opaque(group_id)
        if not hmac.compare_digest(
            owner_capability,
            capability_for_handle(browser_handle, self.integration_secret),
        ):
            raise ValueError("Owner capability must correspond to the browser handle.")
        created_at = _dt(created_at)
        owner_hash = _hash(owner_capability)
        source_hash = self._source_sha256(envelope)
        with self._lock("create"):
            records = [
                self._deserialize(json.loads(path.read_text(encoding="utf-8")))
                for path in self.drafts_dir.glob("*.json")
            ]
            if any(
                record.source_sha256 == source_hash
                and record.status in {DraftStatus.ACTIVE, DraftStatus.IMPORTING}
                for record in records
            ):
                raise IntegrationConflictError("An integration draft already exists for this source.")
            draft_id = secrets.token_urlsafe(18)
            handle_hash = _hash(browser_handle)
            record = DraftRecord(
                id=draft_id,
                project_id=project_id,
                group_id=group_id,
                source_sha256=source_hash,
                owner_capability_hash=owner_hash,
                handle_hash=handle_hash,
                status=DraftStatus.ACTIVE,
                created_at=created_at,
                updated_at=created_at,
                expires_at=created_at + timedelta(seconds=self.draft_ttl_seconds),
                origin=DraftOrigin(
                    source=envelope.source,
                    recipe_version=envelope.recipe.recipe_version,
                    larch_version=envelope.recipe.larch_version,
                    spectrum_sha256=envelope.spectrum_sha256,
                ),
            )
            draft_path = self.drafts_dir / f"{draft_id}.json"
            handle_path = self.handles_dir / f"{handle_hash}.json"
            try:
                self._atomic_json(draft_path, self._serialize(record))
                self._atomic_json(
                    handle_path,
                    {
                        "handle_hash": handle_hash,
                        "draft_id": draft_id,
                        "expires_at": min(
                            envelope.expires_at, created_at + timedelta(seconds=300)
                        ).isoformat(),
                    },
                )
            except Exception:
                draft_path.unlink(missing_ok=True)
                handle_path.unlink(missing_ok=True)
                raise
            return record

    def load_draft(self, draft_id: str, owner_capability: str) -> DraftRecord:
        record = self._read_draft_unchecked(draft_id)
        if not hmac.compare_digest(record.owner_capability_hash, _hash(owner_capability)):
            raise IntegrationNotFoundError("Integration draft was not found.")
        return record

    def find_draft_by_source(self, source) -> DraftRecord | None:
        source_hash = canonical_sha256(source)
        for path in self.drafts_dir.glob("*.json"):
            record = self._deserialize(json.loads(path.read_text(encoding="utf-8")))
            if hmac.compare_digest(record.source_sha256, source_hash):
                return record
        return None

    def find_draft_by_project(self, project_id: str) -> DraftRecord | None:
        for path in self.drafts_dir.glob("*.json"):
            record = self._deserialize(json.loads(path.read_text(encoding="utf-8")))
            if hmac.compare_digest(record.project_id, project_id):
                return record
        return None

    def consume_handle(self, handle: str, now: datetime) -> BrowserSession:
        self._validate_opaque(handle)
        handle_hash = _hash(handle)
        path = self.handles_dir / f"{handle_hash}.json"
        claimed = path.with_suffix(".consumed")
        try:
            os.replace(path, claimed)
            self._fsync_directory(self.handles_dir)
        except FileNotFoundError as exc:
            raise IntegrationReplayError("Browser launch handle is invalid or already used.") from exc
        try:
            value = json.loads(claimed.read_text(encoding="utf-8"))
            if not hmac.compare_digest(value["handle_hash"], handle_hash):
                raise IntegrationReplayError("Browser launch handle is invalid or already used.")
            if _dt(now) > _dt(value["expires_at"]):
                raise IntegrationReplayError("Browser launch handle is invalid or already used.")
            capability = capability_for_handle(handle, self.integration_secret)
            draft = self.load_draft(value["draft_id"], capability)
            if draft.status is not DraftStatus.ACTIVE or _dt(now) >= draft.expires_at:
                raise IntegrationReplayError("Browser launch handle is invalid or already used.")
            return BrowserSession(
                draft_id=draft.id,
                project_id=draft.project_id,
                group_id=draft.group_id,
                source_sha256=draft.source_sha256,
                owner_capability=capability,
            )
        finally:
            claimed.unlink(missing_ok=True)
            self._fsync_directory(self.handles_dir)

    def prepare_import(self, draft_id: str, owner_capability: str, binding: ImportBinding,
                       now: datetime, validate_snapshot: Callable[[DraftRecord], None]) -> DraftRecord:
        with self.draft_lock(draft_id):
            record = self.load_draft(draft_id, owner_capability)
            if _dt(now) >= record.expires_at:
                raise IntegrationNotFoundError("Integration draft was not found.")
            if record.status in {DraftStatus.IMPORTING, DraftStatus.SEALED} and record.import_binding == binding:
                return record
            if record.status is not DraftStatus.ACTIVE:
                raise IntegrationConflictError("Integration import is already reserved.")
            validate_snapshot(record)
            updated = replace(record, status=DraftStatus.IMPORTING, import_binding=binding,
                              updated_at=min(_dt(now), record.expires_at - timedelta(microseconds=1)))
            self._atomic_json(self.drafts_dir / f"{record.id}.json", self._serialize(updated))
            return updated

    def complete_import(self, draft_id: str, owner_capability: str, binding: ImportBinding,
                        now: datetime, *, commit: bool) -> DraftRecord:
        with self.draft_lock(draft_id):
            record = self.load_draft(draft_id, owner_capability)
            target = DraftStatus.SEALED if commit else DraftStatus.ACTIVE
            if record.import_binding != binding:
                raise IntegrationConflictError("Integration import binding changed.")
            # A commit receipt survives editor expiry; acknowledging it must
            # never reopen the project or permit an expired reservation to abort.
            if record.status is DraftStatus.EXPIRED and commit:
                return record
            if record.status is target:
                return record
            if record.status is not DraftStatus.IMPORTING or _dt(now) >= record.expires_at:
                raise IntegrationConflictError("Integration import cannot be completed.")
            updated = replace(record, status=target,
                              updated_at=min(_dt(now), record.expires_at - timedelta(microseconds=1)))
            self._atomic_json(self.drafts_dir / f"{record.id}.json", self._serialize(updated))
            return updated

    def transition(
        self,
        draft_id: str,
        owner_capability: str,
        status: DraftStatus,
        now: datetime,
    ) -> DraftRecord:
        if status not in {DraftStatus.SEALED, DraftStatus.DISCARDED, DraftStatus.EXPIRED}:
            raise IntegrationConflictError("Unsupported integration draft transition.")
        with self.draft_lock(draft_id):
            record = self.load_draft(draft_id, owner_capability)
            if record.status is status:
                return record
            if record.status is not DraftStatus.ACTIVE:
                raise IntegrationConflictError("Integration draft is already terminal.")
            # replace() keeps typed fields (notably `origin`) as objects; an
            # asdict round-trip would flatten them into plain dicts.
            updated = replace(
                record,
                status=status,
                updated_at=min(_dt(now), record.expires_at - timedelta(microseconds=1)),
            )
            self._atomic_json(
                self.drafts_dir / f"{record.id}.json", self._serialize(updated)
            )
            self._remove_handle(record.handle_hash)
            return updated

    def _remove_handle(self, handle_hash: str) -> None:
        (self.handles_dir / f"{handle_hash}.json").unlink(missing_ok=True)
        (self.handles_dir / f"{handle_hash}.consumed").unlink(missing_ok=True)
        self._fsync_directory(self.handles_dir)

    def expire_due(self, now: datetime) -> tuple[str, ...]:
        now = _dt(now)
        for path in tuple(self.nonces_dir.glob("*.json")):
            try:
                expires_at = _dt(json.loads(path.read_text(encoding="utf-8"))["expires_at"])
            except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
                continue
            if now >= expires_at:
                path.unlink(missing_ok=True)
        self._fsync_directory(self.nonces_dir)

        expired: list[str] = []
        for path in tuple(self.drafts_dir.glob("*.json")):
            record = self._deserialize(json.loads(path.read_text(encoding="utf-8")))
            if record.status in {DraftStatus.ACTIVE, DraftStatus.IMPORTING, DraftStatus.SEALED} and now >= record.expires_at:
                with self.draft_lock(record.id):
                    current = self._read_draft_unchecked(record.id)
                    if current.status in {DraftStatus.ACTIVE, DraftStatus.IMPORTING, DraftStatus.SEALED} and now >= current.expires_at:
                        updated = replace(
                            current,
                            status=DraftStatus.EXPIRED,
                            updated_at=current.expires_at - timedelta(microseconds=1),
                        )
                        self._atomic_json(path, self._serialize(updated))
                        self._remove_handle(current.handle_hash)
                        expired.append(current.id)
        return tuple(sorted(expired))

    def remove_draft_artifacts(self, draft_id: str) -> None:
        try:
            record = self._read_draft_unchecked(draft_id)
        except IntegrationNotFoundError:
            return
        (self.drafts_dir / f"{draft_id}.json").unlink(missing_ok=True)
        self._remove_handle(record.handle_hash)
        self._fsync_directory(self.drafts_dir)

    def remove_all(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)
