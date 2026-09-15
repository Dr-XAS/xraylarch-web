from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
import hashlib
import json

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


def test_wrong_project_capability_is_not_found(store, clock):
    _, first = store.create_project_record(project_id="p1", persistent=True, now=clock())
    _, second = store.create_project_record(project_id="p2", persistent=True, now=clock())

    with pytest.raises(IntegrationNotFoundError):
        store.load_project("p1", second)
    assert store.load_project("p1", first).project_id == "p1"


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
