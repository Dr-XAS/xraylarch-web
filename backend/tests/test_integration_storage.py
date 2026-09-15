from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
import hashlib
import json
from pathlib import Path
import stat

import pytest

from xraylarch_web.integration_contracts import DraftStatus, LaunchEnvelope
from xraylarch_web.integration_storage import (
    IntegrationConflictError,
    IntegrationNotFoundError,
    IntegrationReplayError,
    IntegrationStorage,
    capability_for_handle,
)
from test_integration_contracts import launch_payload


NOW = datetime(2026, 9, 11, 12, tzinfo=UTC)
SECRET = "integration-secret-that-is-long-enough"
HANDLE = "browser-handle-one"
CAPABILITY = capability_for_handle(HANDLE + "1", SECRET)
OTHER_CAPABILITY = "owner-capability-two"


def envelope(source_suffix: str = "1") -> LaunchEnvelope:
    payload = launch_payload()
    payload["source"]["artifact_id"] = f"artifact-{source_suffix}"
    payload["created_at"] = NOW.isoformat()
    payload["expires_at"] = (NOW + timedelta(minutes=5)).isoformat()
    return LaunchEnvelope.model_validate_json(json.dumps(payload))


def seeded_active_draft(tmp_path, *, source_suffix="1"):
    store = IntegrationStorage(
        tmp_path, integration_secret=SECRET, draft_ttl_seconds=604800
    )
    draft = store.create_draft(
        envelope=envelope(source_suffix),
        owner_capability=CAPABILITY,
        browser_handle=HANDLE + "1",
        project_id="project-identifier-1" + source_suffix,
        group_id="group-identifier-1" + source_suffix,
        created_at=NOW,
    )
    return store, draft


def test_nonce_claim_is_durable_and_rejects_replay_after_restart(tmp_path):
    first = IntegrationStorage(tmp_path, integration_secret=SECRET)
    first.claim_nonce(nonce="n" * 32, expires_at=NOW + timedelta(minutes=5))

    with pytest.raises(IntegrationReplayError):
        IntegrationStorage(tmp_path, integration_secret=SECRET).claim_nonce(
            nonce="n" * 32, expires_at=NOW + timedelta(minutes=5)
        )


def test_expire_due_removes_only_expired_nonce_records(tmp_path):
    store = IntegrationStorage(tmp_path, integration_secret=SECRET)
    expired_nonce = "e" * 32
    live_nonce = "l" * 32
    store.claim_nonce(nonce=expired_nonce, expires_at=NOW - timedelta(seconds=1))
    store.claim_nonce(nonce=live_nonce, expires_at=NOW + timedelta(seconds=1))

    store.expire_due(NOW)

    expired_hash = hashlib.sha256(expired_nonce.encode()).hexdigest()
    live_hash = hashlib.sha256(live_nonce.encode()).hexdigest()
    assert not (store.nonces_dir / f"{expired_hash}.json").exists()
    assert (store.nonces_dir / f"{live_hash}.json").is_file()


def test_expire_due_retains_malformed_nonce_records_without_crashing(tmp_path):
    store = IntegrationStorage(tmp_path, integration_secret=SECRET)
    malformed = store.nonces_dir / "malformed.json"
    malformed.write_text('{"expires_at":null}', encoding="utf-8")

    assert store.expire_due(NOW) == ()
    assert malformed.is_file()


def test_expire_due_is_bounded_and_persists_progress(tmp_path, monkeypatch):
    store = IntegrationStorage(tmp_path, integration_secret=SECRET)
    for index in range(6):
        store.claim_nonce(
            nonce=f"nonce-{index:011d}", expires_at=NOW + timedelta(minutes=5)
        )
    reads = []
    original = Path.read_text

    def count_read(path, *args, **kwargs):
        if path.parent == store.nonces_dir:
            reads.append(path.name)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", count_read)
    store.expire_due(NOW, max_items=2)
    first_cursor = (store.root / ".cleanup-queue.json").read_text(encoding="utf-8")
    assert len(reads) == 2
    reads.clear()

    store.expire_due(NOW, max_items=2)
    second_cursor = (store.root / ".cleanup-queue.json").read_text(encoding="utf-8")

    assert len(reads) == 2
    assert first_cursor != second_cursor
    assert json.loads(second_cursor)["sequence"] == 4


def test_expire_due_resumes_without_rescanning_a_large_prefix(tmp_path, monkeypatch):
    store = IntegrationStorage(tmp_path, integration_secret=SECRET)
    for index in range(12):
        store.claim_nonce(
            nonce=f"queued-nonce-{index:06d}", expires_at=NOW + timedelta(minutes=5)
        )
    reads = []
    original = Path.read_text

    def count_read(path, *args, **kwargs):
        if path.parent == store.nonces_dir:
            reads.append(path.name)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", count_read)
    store.expire_due(NOW, max_items=3)
    first = tuple(reads)
    reads.clear()

    store.expire_due(NOW, max_items=3)

    assert len(reads) == 3
    assert not set(first) & set(reads)


def test_concurrent_expire_due_does_not_regress_persistent_progress(tmp_path):
    store = IntegrationStorage(tmp_path, integration_secret=SECRET)
    for index in range(12):
        store.claim_nonce(
            nonce=f"parallel-nonce-{index:04d}", expires_at=NOW + timedelta(minutes=5)
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        tuple(executor.map(lambda _: store.expire_due(NOW, max_items=3), range(2)))

    state = json.loads((store.root / ".cleanup-queue.json").read_text(encoding="utf-8"))
    assert state["sequence"] == 6


def test_expire_due_tolerates_malformed_drafts_per_item(tmp_path):
    store = IntegrationStorage(tmp_path, integration_secret=SECRET)
    (store.drafts_dir / "broken.json").write_bytes(b"\xff")
    (store.drafts_dir / "truncated.json").write_text('{"id":', encoding="utf-8")

    assert store.expire_due(NOW, max_items=20) == ()


def test_draft_persists_only_hashes_and_private_permissions(tmp_path):
    store, draft = seeded_active_draft(tmp_path)
    persisted = (store.drafts_dir / f"{draft.id}.json").read_text()

    assert CAPABILITY not in persisted
    assert HANDLE not in persisted
    assert draft.owner_capability_hash in persisted
    assert stat.S_IMODE(store.root.stat().st_mode) == 0o700
    assert stat.S_IMODE((store.drafts_dir / f"{draft.id}.json").stat().st_mode) == 0o600


def test_load_draft_is_authorization_neutral_for_wrong_owner(tmp_path):
    store, draft = seeded_active_draft(tmp_path)

    assert store.load_draft(draft.id, CAPABILITY).id == draft.id
    with pytest.raises(IntegrationNotFoundError):
        store.load_draft(draft.id, OTHER_CAPABILITY)
    with pytest.raises(IntegrationNotFoundError):
        store.load_draft("missing-draft-id", CAPABILITY)


def test_consume_handle_is_single_use_and_survives_restart(tmp_path):
    store, draft = seeded_active_draft(tmp_path)

    unkeyed_candidate = capability_for_handle(HANDLE + "1", "publicly-known-placeholder")
    with pytest.raises(IntegrationNotFoundError):
        store.load_draft(draft.id, unkeyed_candidate)

    session = IntegrationStorage(tmp_path, integration_secret=SECRET).consume_handle(HANDLE + "1", NOW)
    assert (session.draft_id, session.project_id, session.group_id) == (
        draft.id,
        draft.project_id,
        draft.group_id,
    )
    assert session.owner_capability == CAPABILITY
    with pytest.raises(IntegrationReplayError):
        IntegrationStorage(tmp_path, integration_secret=SECRET).consume_handle(HANDLE + "1", NOW)


def test_expired_handle_is_consumed_but_not_returned(tmp_path):
    store, _ = seeded_active_draft(tmp_path)

    with pytest.raises(IntegrationReplayError):
        store.consume_handle(HANDLE + "1", NOW + timedelta(minutes=6))
    with pytest.raises(IntegrationReplayError):
        store.consume_handle(HANDLE + "1", NOW)


def test_duplicate_active_source_is_rejected(tmp_path):
    store, _ = seeded_active_draft(tmp_path)
    with pytest.raises(IntegrationConflictError, match="source"):
        store.create_draft(
            envelope=envelope("1"),
            owner_capability=capability_for_handle("another-browser-handle", SECRET),
            browser_handle="another-browser-handle", project_id="another-project-id-1",
            group_id="another-group-id-1", created_at=NOW,
        )


def test_terminal_source_history_allows_a_new_draft(tmp_path):
    store, draft = seeded_active_draft(tmp_path)
    store.transition(draft.id, CAPABILITY, DraftStatus.DISCARDED, NOW + timedelta(seconds=1))
    handle = "replacement-browser-handle"

    replacement = store.create_draft(
        envelope=envelope("1"),
        owner_capability=capability_for_handle(handle, SECRET),
        browser_handle=handle,
        project_id="replacement-project-id",
        group_id="replacement-group-id",
        created_at=NOW + timedelta(seconds=2),
    )

    assert replacement.status is DraftStatus.ACTIVE
    assert replacement.id != draft.id
    assert store.load_draft(draft.id, CAPABILITY).status is DraftStatus.DISCARDED


def test_terminal_transitions_are_idempotent_and_expiry_is_durable(tmp_path):
    store, draft = seeded_active_draft(tmp_path)

    discarded = store.transition(
        draft.id, CAPABILITY, DraftStatus.DISCARDED, NOW + timedelta(seconds=1)
    )
    assert discarded.status is DraftStatus.DISCARDED
    assert store.transition(
        draft.id, CAPABILITY, DraftStatus.DISCARDED, NOW + timedelta(seconds=2)
    ).status is DraftStatus.DISCARDED
    with pytest.raises(IntegrationConflictError):
        store.transition(draft.id, CAPABILITY, DraftStatus.SEALED, NOW)

    expiring_store, expiring = seeded_active_draft(tmp_path / "expiry", source_suffix="4")
    assert expiring_store.expire_due(NOW + timedelta(days=8)) == (expiring.id,)
    assert expiring_store.load_draft(expiring.id, CAPABILITY).status is DraftStatus.EXPIRED
    assert expiring_store.expire_due(NOW + timedelta(days=9)) == ()


def test_remove_draft_artifacts_preserves_nonce_records(tmp_path):
    store, draft = seeded_active_draft(tmp_path)
    store.claim_nonce(nonce="z" * 32, expires_at=NOW + timedelta(minutes=5))

    store.remove_draft_artifacts(draft.id)

    assert not (store.drafts_dir / f"{draft.id}.json").exists()
    assert list(store.handles_dir.iterdir()) == []
    assert len(list(store.nonces_dir.iterdir())) == 1


def test_import_reservation_is_durable_and_can_only_finish_for_its_binding(tmp_path):
    from xraylarch_web.integration_contracts import ImportBinding
    store, draft = seeded_active_draft(tmp_path)
    binding = ImportBinding(import_id='a' * 32, attempt_id='b' * 32, project_version=3, snapshot_sha256='c' * 64)
    checked = []
    prepared = store.prepare_import(draft.id, CAPABILITY, binding, NOW, lambda record: checked.append(record.id))
    assert prepared.status.value == 'importing'
    assert checked == [draft.id]
    restarted = IntegrationStorage(tmp_path, integration_secret=SECRET)
    assert restarted.load_draft(draft.id, CAPABILITY).import_binding == binding
    with pytest.raises(IntegrationConflictError):
        restarted.transition(draft.id, CAPABILITY, DraftStatus.DISCARDED, NOW)
    stale = binding.model_copy(update={'attempt_id': 'd' * 32})
    with pytest.raises(IntegrationConflictError):
        restarted.complete_import(draft.id, CAPABILITY, stale, NOW, commit=False)
    sealed = restarted.complete_import(draft.id, CAPABILITY, binding, NOW, commit=True)
    assert sealed.status is DraftStatus.SEALED
    assert sealed.expires_at == draft.expires_at
    assert restarted.complete_import(draft.id, CAPABILITY, binding, NOW, commit=True) == sealed
    with pytest.raises(IntegrationConflictError):
        restarted.complete_import(draft.id, CAPABILITY, binding, NOW, commit=False)


def test_import_reservation_abort_restores_editability_and_refuses_old_attempt(tmp_path):
    from xraylarch_web.integration_contracts import ImportBinding
    store, draft = seeded_active_draft(tmp_path)
    first = ImportBinding(import_id='a' * 32, attempt_id='b' * 32, project_version=0, snapshot_sha256='c' * 64)
    store.prepare_import(draft.id, CAPABILITY, first, NOW, lambda record: None)
    active = store.complete_import(draft.id, CAPABILITY, first, NOW, commit=False)
    assert active.status is DraftStatus.ACTIVE
    second = first.model_copy(update={'attempt_id': 'd' * 32, 'project_version': 1})
    store.prepare_import(draft.id, CAPABILITY, second, NOW, lambda record: None)
    with pytest.raises(IntegrationConflictError):
        store.complete_import(draft.id, CAPABILITY, first, NOW, commit=False)
    assert store.load_draft(draft.id, CAPABILITY).status.value == 'importing'


def test_failed_snapshot_validation_never_reserves_the_draft(tmp_path):
    from xraylarch_web.integration_contracts import ImportBinding
    store, draft = seeded_active_draft(tmp_path)
    binding = ImportBinding(import_id='a' * 32, attempt_id='b' * 32, project_version=0, snapshot_sha256='c' * 64)
    def reject(record):
        raise IntegrationConflictError('snapshot changed')
    with pytest.raises(IntegrationConflictError):
        store.prepare_import(draft.id, CAPABILITY, binding, NOW, reject)
    assert store.load_draft(draft.id, CAPABILITY).status is DraftStatus.ACTIVE


def test_pending_import_expires_and_blocks_a_second_active_draft(tmp_path):
    from xraylarch_web.integration_contracts import ImportBinding
    store, draft = seeded_active_draft(tmp_path)
    binding = ImportBinding(import_id='a' * 32, attempt_id='b' * 32, project_version=0, snapshot_sha256='c' * 64)
    store.prepare_import(draft.id, CAPABILITY, binding, NOW, lambda record: None)
    next_handle = 'another-browser-handle'
    with pytest.raises(IntegrationConflictError):
        store.create_draft(envelope=envelope(), owner_capability=capability_for_handle(next_handle, SECRET),
            browser_handle=next_handle, project_id='next-project-identifier', group_id='next-group-identifier', created_at=NOW)
    assert store.expire_due(draft.expires_at) == (draft.id,)
    assert store.load_draft(draft.id, CAPABILITY).status is DraftStatus.EXPIRED
