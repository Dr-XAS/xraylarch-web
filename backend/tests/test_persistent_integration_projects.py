from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
from threading import Event, Lock

import pytest

from xraylarch_web.integration_contracts import (
    ExistingDrXasSource,
    ProjectQuota,
    SelectedGroupRef,
)
from xraylarch_web.integration_storage import (
    IntegrationConflictError,
    IntegrationNotFoundError,
    IntegrationStorage,
)


NOW = datetime(2026, 9, 15, 12, tzinfo=UTC)
QUOTA = ProjectQuota(
    max_projects=10,
    max_files=20,
    max_bytes=1_000_000,
    max_groups=30,
    max_exports=40,
    ttl_seconds=60,
)
SOURCE = ExistingDrXasSource(
    turn_id="turn-1",
    artifact_id="artifact-1",
    artifact_version=1,
    source_sha256="a" * 64,
)


@pytest.fixture
def clock():
    return lambda: NOW


@pytest.fixture
def store(tmp_path):
    return IntegrationStorage(tmp_path, integration_secret="integration-secret-that-is-long-enough")


@pytest.fixture
def project(store, clock):
    return store.create_project_record(
        project_id="p1", persistent=True, quota=QUOTA, source=SOURCE, now=clock()
    )


@pytest.fixture
def capability(project):
    return project[1]


def selections(*ids: str) -> tuple[SelectedGroupRef, ...]:
    return tuple(SelectedGroupRef(group_id=group_id, group_version=1) for group_id in ids)


def test_capability_rotation_invalidates_the_old_capability(store, clock):
    record, first = store.create_project_record(project_id="p1", persistent=True, now=clock())

    second = store.rotate_project_capability("p1", first, now=clock())

    with pytest.raises(IntegrationNotFoundError):
        store.load_project("p1", first)
    assert store.load_project("p1", second).project_id == record.project_id


def test_project_persists_only_capability_hash_and_atomic_record(store, capability):
    persisted = store.projects_dir / "p1.json"
    value = json.loads(persisted.read_text(encoding="utf-8"))

    assert capability not in persisted.read_text(encoding="utf-8")
    assert value["capability_hash"] == hashlib.sha256(capability.encode()).hexdigest()
    assert value["source"] == SOURCE.model_dump(mode="json")
    assert value["quota"] == QUOTA.model_dump(mode="json")
    assert not list(store.projects_dir.glob("*.tmp"))


@pytest.mark.parametrize("failure", ("fsync", "replace"))
def test_failed_atomic_project_update_preserves_previous_complete_record(store, capability, monkeypatch, failure):
    persisted = store.projects_dir / "p1.json"
    original = persisted.read_text(encoding="utf-8")
    target = os.fsync if failure == "fsync" else os.replace

    def fail_project_write(*args, **kwargs):
        raise OSError("injected write failure")

    monkeypatch.setattr(os, failure, fail_project_write)
    with pytest.raises(OSError, match="injected write failure"):
        store.rotate_project_capability("p1", capability, now=NOW)
    monkeypatch.setattr(os, failure, target)

    assert persisted.read_text(encoding="utf-8") == original
    assert store.load_project("p1", capability).project_id == "p1"
    assert not list(store.projects_dir.glob("*.tmp"))


def test_wrong_project_capability_is_not_found(store, clock):
    _, first = store.create_project_record(project_id="p1", persistent=True, now=clock())
    _, second = store.create_project_record(project_id="p2", persistent=True, now=clock())

    with pytest.raises(IntegrationNotFoundError):
        store.load_project("p1", second)
    assert store.load_project("p1", first).project_id == "p1"


@pytest.mark.parametrize("project_id", ("folder\\project", "bad\x00id", "C:project", "NUL", "com1.txt"))
def test_project_id_is_platform_independent_and_path_safe(store, project_id):
    with pytest.raises(IntegrationNotFoundError):
        store.create_project_record(project_id=project_id, persistent=True, now=NOW)


def test_project_id_at_portable_filename_byte_limit_is_accepted(store):
    project_id = "a" * 250

    record, capability = store.create_project_record(project_id=project_id, persistent=True, now=NOW)

    assert record.project_id == project_id
    assert store.load_project(project_id, capability).project_id == project_id


@pytest.mark.parametrize("project_id", ("a" * 251, "é" * 126))
def test_project_id_exceeding_portable_filename_byte_limit_is_not_found(store, project_id):
    with pytest.raises(IntegrationNotFoundError):
        store.create_project_record(project_id=project_id, persistent=True, now=NOW)


def test_atomic_project_writes_with_same_token_use_distinct_temp_targets(tmp_path, monkeypatch):
    store = IntegrationStorage(tmp_path, integration_secret="integration-secret-that-is-long-enough")
    original_open = os.open
    entered = Event()
    release = Event()
    call_lock = Lock()
    calls = 0

    monkeypatch.setattr("xraylarch_web.integration_storage.secrets.token_urlsafe", lambda _: "same-token")

    def pausing_open(path, flags, mode=0o777):
        nonlocal calls
        descriptor = original_open(path, flags, mode)
        if Path(path).parent == store.projects_dir and flags & os.O_EXCL:
            with call_lock:
                calls += 1
                first = calls == 1
            if first:
                entered.set()
                assert release.wait(timeout=1)
        return descriptor

    monkeypatch.setattr(os, "open", pausing_open)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(store.create_project_record, project_id="p1", persistent=True, now=NOW)
        assert entered.wait(timeout=1)
        second = executor.submit(store.create_project_record, project_id="p2", persistent=True, now=NOW)
        release.set()
        first.result()
        second.result()

    assert (store.projects_dir / "p1.json").is_file()
    assert (store.projects_dir / "p2.json").is_file()


def test_expired_guest_is_expired_during_authorized_read_and_mutation(store):
    _, capability = store.create_project_record(
        project_id="guest", persistent=False, quota=QUOTA, now=NOW
    )

    with pytest.raises(IntegrationNotFoundError):
        store.reserve_export(
            "guest", capability, selections("g1"), "import-1", now=NOW + timedelta(seconds=61)
        )
    expired_record = json.loads((store.projects_dir / "guest.json").read_text(encoding="utf-8"))
    assert expired_record["status"] == "expired"
    with pytest.raises(IntegrationNotFoundError):
        store.load_project("guest", capability, now=NOW + timedelta(seconds=61))


def test_export_reservation_is_idempotent(store, capability):
    first = store.reserve_export("p1", capability, selections("g1", "g2"), "import-1", now=NOW)
    second = store.reserve_export("p1", capability, selections("g1", "g2"), "import-1", now=NOW)

    assert second == first
    assert second.status == "prepared"


def test_export_reservation_rejects_duplicate_selections_and_conflicting_reuse(store, capability):
    with pytest.raises(IntegrationConflictError):
        store.reserve_export("p1", capability, selections("g1", "g1"), "import-1", now=NOW)

    store.reserve_export("p1", capability, selections("g1"), "import-1", now=NOW)
    with pytest.raises(IntegrationConflictError):
        store.reserve_export("p1", capability, selections("g2"), "import-1", now=NOW)


def test_export_reservation_commit_and_abort_are_idempotent(store, capability):
    prepared = store.reserve_export("p1", capability, selections("g1"), "import-1", now=NOW)

    committed = store.commit_export_reservation("p1", capability, "import-1", now=NOW)
    assert committed.status == "committed"
    assert store.commit_export_reservation("p1", capability, "import-1", now=NOW) == committed
    with pytest.raises(IntegrationConflictError):
        store.abort_export_reservation("p1", capability, "import-1", now=NOW)

    store.reserve_export("p1", capability, selections("g2"), "import-2", now=NOW)
    aborted = store.abort_export_reservation("p1", capability, "import-2", now=NOW)
    assert aborted.status == "aborted"
    assert store.abort_export_reservation("p1", capability, "import-2", now=NOW) == aborted
    assert prepared.status == "prepared"


def test_deleted_project_rejects_load_and_mutation(store, capability):
    deleted = store.delete_project_record("p1", capability, now=NOW)
    assert deleted.status == "deleted"

    with pytest.raises(IntegrationNotFoundError):
        store.load_project("p1", capability)
    with pytest.raises(IntegrationNotFoundError):
        store.reserve_export("p1", capability, selections("g1"), "import-1", now=NOW)


def test_expire_due_marks_guests_terminal_and_rejects_load(store, clock):
    record, capability = store.create_project_record(
        project_id="guest", persistent=False, quota=QUOTA, now=clock()
    )
    assert record.expires_at == NOW + timedelta(seconds=QUOTA.ttl_seconds or 0)

    assert store.expire_due(record.expires_at) == ("guest",)
    with pytest.raises(IntegrationNotFoundError):
        store.load_project("guest", capability)
    assert store.expire_due(record.expires_at + timedelta(seconds=1)) == ()


def test_concurrent_rotation_leaves_exactly_one_winning_capability(store, capability):
    def rotate():
        try:
            return store.rotate_project_capability("p1", capability, now=NOW)
        except IntegrationNotFoundError:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: rotate(), range(2)))

    winners = [result for result in results if result is not None]
    assert len(winners) == 1
    assert store.load_project("p1", winners[0]).project_id == "p1"


def test_concurrent_reservations_do_not_lose_updates(store, capability):
    def reserve(reservation_id: str):
        return store.reserve_export(
            "p1", capability, selections(f"group-{reservation_id}"), reservation_id, now=NOW
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(reserve, ("import-1", "import-2")))

    assert {result.reservation_id for result in results} == {"import-1", "import-2"}
    record = store.load_project("p1", capability)
    assert {reservation.reservation_id for reservation in record.reservations} == {"import-1", "import-2"}
