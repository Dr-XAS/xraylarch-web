from __future__ import annotations

from datetime import UTC, datetime, timedelta
import hashlib
import hmac
import json
import math
from copy import deepcopy

import pytest
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.integration_service import (
    IntegrationAuthenticationError,
    IntegrationAuthorizationError,
    IntegrationService,
)
from xraylarch_web.integration_contracts import DraftStatus, AuthoritativeSpectrum, canonical_sha256
from xraylarch_web.integration_storage import IntegrationReplayError, IntegrationStorage
from test_integration_contracts import launch_payload


NOW = datetime(2026, 9, 11, 12, tzinfo=UTC)
SECRET = "integration-secret-that-is-long-enough"
ISSUER = "drxas"
AUDIENCE = "xraylarch-web"


def raw_launch(*, source="1") -> bytes:
    payload = launch_payload()
    payload["source"]["artifact_id"] = f"artifact-{source}"
    payload["created_at"] = NOW.isoformat()
    payload["expires_at"] = (NOW + timedelta(minutes=5)).isoformat()
    return json.dumps(payload, separators=(",", ":")).encode()


def signed_headers(raw_body: bytes, *, nonce="n" * 32, timestamp=NOW,
                   issuer=ISSUER, audience=AUDIENCE) -> dict[str, str]:
    digest = hashlib.sha256(raw_body).hexdigest()
    stamp = str(int(timestamp.timestamp()))
    signing_input = "\n".join((issuer, audience, stamp, nonce, digest)).encode()
    signature = hmac.new(SECRET.encode(), signing_input, hashlib.sha256).hexdigest()
    return {
        "X-DrXAS-Issuer": issuer,
        "X-DrXAS-Audience": audience,
        "X-DrXAS-Timestamp": stamp,
        "X-DrXAS-Nonce": nonce,
        "X-DrXAS-Body-SHA256": digest,
        "X-DrXAS-Signature": signature,
    }


@pytest.fixture
def service(tmp_path):
    settings = Settings(
        data_root=tmp_path,
        integration_api_enabled=True,
        browser_consume_enabled=True,
        integration_issuer=ISSUER,
        integration_audience=AUDIENCE,
        integration_hmac_secret=SECRET,
    )
    athena = AthenaStore(settings)
    storage = IntegrationStorage(
        tmp_path,
        integration_secret=SECRET,
        draft_ttl_seconds=settings.draft_ttl_seconds,
    )
    return IntegrationService(settings, athena, storage)


def test_bootstrap_verifies_signature_and_creates_one_exact_group(service):
    raw = raw_launch()
    launch = service.bootstrap(raw_body=raw, headers=signed_headers(raw), now=NOW)
    session = service.consume_browser_handle(launch.launch_handle, NOW)
    draft = service.authorize_project(session.project_id, session.owner_capability, NOW)
    project = service.athena_store.load(session.project_id)
    expected = json.loads(raw)["spectrum"]

    assert draft.id == session.draft_id
    assert project["integration"] is True
    assert len(project["groups"]) == 1
    assert project["groups"][0]["id"] == session.group_id
    assert project["groups"][0]["energy"] == expected["energy"]
    assert project["groups"][0]["mu"] == expected["mu"]
    parameters = project["groups"][0]["parameters"]
    assert parameters["dk"] == json.loads(raw)["recipe"]["forward_ft"]["dk"]
    assert parameters["dr"] == json.loads(raw)["recipe"]["reverse_ft"]["dr"]


def real_science_session(service):
    payload = json.loads(raw_launch())
    energy = [8800.0 + index * 2 for index in range(551)]
    mu = [0.2 + 0.5 + math.atan((value - 8980.0) / 4.0) / math.pi for value in energy]
    spectrum = AuthoritativeSpectrum.model_validate({"energy": tuple(energy), "mu": tuple(mu)})
    payload["spectrum"] = spectrum.model_dump(mode="json")
    payload["spectrum_sha256"] = canonical_sha256(spectrum)
    raw = json.dumps(payload).encode()
    launched = service.bootstrap(raw_body=raw, headers=signed_headers(raw), now=NOW)
    return service.consume_browser_handle(launched.launch_handle, NOW)


def test_import_snapshot_copies_cached_science_and_exact_project_version(service):
    session = real_science_session(service)
    project = service.athena_store.load(session.project_id)
    changed = deepcopy(project)
    changed["groups"][0]["result"]["arrays"]["norm"][100] = 123.0
    saved = service.athena_store.save(changed, project, "snapshot evidence")
    snapshot = service.import_snapshot(draft_id=session.draft_id, capability=session.owner_capability, now=NOW)
    assert snapshot.project_version == saved["version"]
    assert snapshot.computed.arrays["norm"][100] == 123.0
    assert snapshot.computed.e0 == saved["groups"][0]["result"]["effective"]["e0"]
    assert service.storage.load_draft(session.draft_id, session.owner_capability).status is DraftStatus.ACTIVE


def test_import_snapshot_refuses_failed_science(service):
    session = real_science_session(service)
    project = service.athena_store.load(session.project_id)
    changed = deepcopy(project)
    changed["groups"][0]["processing_error"] = "computation failed"
    service.athena_store.save(changed, project, "failed science")
    with pytest.raises(IntegrationAuthorizationError):
        service.import_snapshot(draft_id=session.draft_id, capability=session.owner_capability, now=NOW)


def test_bootstrap_preserves_every_signed_recipe_field_supported_by_larch(service):
    raw = raw_launch()
    launch = service.bootstrap(raw_body=raw, headers=signed_headers(raw), now=NOW)
    session = service.consume_browser_handle(launch.launch_handle, NOW)
    parameters = service.athena_store.load(session.project_id)["groups"][0]["parameters"]
    recipe = json.loads(raw)["recipe"]

    assert parameters["nvict"] == recipe["normalization"]["nvict"]
    assert parameters["nknots"] == recipe["autobk"]["nknots"]
    assert parameters["dk2"] == recipe["forward_ft"]["dk2"]
    assert parameters["rmax_out"] == recipe["forward_ft"]["rmax_out"]
    assert parameters["forward_with_phase"] == recipe["forward_ft"]["with_phase"]
    assert parameters["dr2"] == recipe["reverse_ft"]["dr2"]
    assert parameters["qmax_out"] == recipe["reverse_ft"]["qmax_out"]
    assert parameters["reverse_nfft"] == recipe["reverse_ft"]["nfft"]
    assert parameters["reverse_kstep"] == recipe["reverse_ft"]["kstep"]
    assert parameters["reverse_with_phase"] == recipe["reverse_ft"]["with_phase"]


def test_signature_rejects_wrong_identity_expiry_and_body_tampering(service):
    raw = raw_launch()
    for headers in (
        signed_headers(raw, issuer="other"),
        signed_headers(raw, audience="other"),
        signed_headers(raw, timestamp=NOW - timedelta(seconds=301)),
        signed_headers(raw) | {"X-DrXAS-Body-SHA256": "0" * 64},
    ):
        with pytest.raises(IntegrationAuthenticationError):
            service.bootstrap(raw_body=raw, headers=headers, now=NOW)
    with pytest.raises(IntegrationAuthenticationError):
        service.bootstrap(
            raw_body=raw + b" ", headers=signed_headers(raw), now=NOW
        )


def test_malformed_large_timestamp_is_rejected_as_authentication_failure(service):
    raw = raw_launch()
    headers = signed_headers(raw) | {"X-DrXAS-Timestamp": "9" * 16}

    with pytest.raises(IntegrationAuthenticationError):
        service.bootstrap(raw_body=raw, headers=headers, now=NOW)


def test_replay_is_rejected_after_success(service):
    raw = raw_launch()
    headers = signed_headers(raw)
    service.bootstrap(raw_body=raw, headers=headers, now=NOW)

    with pytest.raises(IntegrationReplayError):
        service.bootstrap(raw_body=raw, headers=headers, now=NOW)


def test_future_timestamp_nonce_remains_claimed_for_full_acceptance_window(service):
    raw = raw_launch()
    future = NOW + timedelta(seconds=300)
    headers = signed_headers(raw, timestamp=future)
    service.bootstrap(raw_body=raw, headers=headers, now=NOW)

    service.storage.expire_due(future)

    with pytest.raises(IntegrationReplayError):
        service.bootstrap(raw_body=raw, headers=headers, now=future)


def test_malformed_envelope_does_not_consume_nonce(service):
    malformed = b'{"not":"a launch envelope"}'
    headers = signed_headers(malformed)
    with pytest.raises(ValidationError):
        service.bootstrap(raw_body=malformed, headers=headers, now=NOW)

    with pytest.raises(ValidationError):
        service.bootstrap(raw_body=malformed, headers=headers, now=NOW)


def test_atomic_import_failure_removes_project_and_draft_but_consumes_nonce(
    service, monkeypatch
):
    raw = raw_launch()
    headers = signed_headers(raw)
    original = service.athena_store.storage.write_json

    def fail_project_write(workspace_id, name, data):
        original(workspace_id, name, data)
        raise OSError("simulated project write failure")

    monkeypatch.setattr(service.athena_store.storage, "write_json", fail_project_write)
    with pytest.raises(OSError, match="simulated"):
        service.bootstrap(raw_body=raw, headers=headers, now=NOW)

    assert list(service.storage.drafts_dir.glob("*.json")) == []
    assert list(service.athena_store.storage.root.iterdir()) == []
    with pytest.raises(IntegrationReplayError):
        service.bootstrap(raw_body=raw, headers=headers, now=NOW)


def test_authorize_project_rejects_cross_owner_and_terminal_mutation(service):
    raw = raw_launch()
    launch = service.bootstrap(raw_body=raw, headers=signed_headers(raw), now=NOW)
    session = service.consume_browser_handle(launch.launch_handle, NOW)

    with pytest.raises(IntegrationAuthorizationError):
        service.authorize_project(session.project_id, "wrong-owner-capability", NOW)
    service.storage.transition(
        session.draft_id,
        session.owner_capability,
        DraftStatus.SEALED,
        NOW + timedelta(seconds=1),
    )
    draft = service.authorize_project(
        session.project_id, session.owner_capability, NOW + timedelta(seconds=2),
        allow_terminal=True,
    )
    with pytest.raises(IntegrationAuthorizationError):
        service.allowed_operation("parameters", group_ids=[session.group_id], draft=draft)


def test_allowed_operation_is_strictly_core_and_single_group(service):
    raw = raw_launch()
    launch = service.bootstrap(raw_body=raw, headers=signed_headers(raw), now=NOW)
    session = service.consume_browser_handle(launch.launch_handle, NOW)
    draft = service.authorize_project(session.project_id, session.owner_capability, NOW)

    for action in ("metadata", "parameters", "set_e0", "undo", "redo", "export"):
        service.allowed_operation(action, group_ids=[session.group_id], draft=draft)
    for action in ("example", "duplicate", "delete", "difference", "restore", "analyze"):
        with pytest.raises(IntegrationAuthorizationError):
            service.allowed_operation(action, group_ids=[session.group_id], draft=draft)
    with pytest.raises(IntegrationAuthorizationError):
        service.allowed_operation("parameters", group_ids=["other-group-id-1"], draft=draft)


def _bootstrap(service, *, source="1"):
    raw = raw_launch(source=source)
    handle = service.bootstrap(
        raw_body=raw, headers=signed_headers(raw), now=NOW
    )
    session = service.consume_browser_handle(handle.launch_handle, NOW)
    return json.loads(raw), session


def test_sealed_export_round_trips_the_launch_recipe_exactly(service):
    # The Athena parameter mapping is the only path the recipe takes through the
    # editor, so an export taken before any edit must reproduce the launch recipe
    # bit for bit. Any lossy field would silently corrupt every later import.
    launch, session = _bootstrap(service)

    sealed = service.sealed_export(
        draft_id=session.draft_id,
        capability=session.owner_capability,
        now=NOW,
    )

    assert sealed.draft_id == session.draft_id
    assert sealed.recipe.model_dump() == launch["recipe"]
    assert sealed.recipe_sha256 == launch["recipe_sha256"]
    assert sealed.spectrum_sha256 == launch["spectrum_sha256"]
    assert sealed.source.model_dump(mode="json") == launch["source"]
    assert sealed.parity_status == "not_checked"


def _write_group(service, session, mutate):
    project = service.athena_store.load(session.project_id)
    group = next(g for g in project["groups"] if g["id"] == session.group_id)
    mutate(group)
    service.athena_store.storage.write_json(session.project_id, "project.json", project)


def test_sealed_export_reflects_edits_made_in_the_workspace(service):
    # Without this the round-trip test above is vacuous: an export that ignored
    # the workspace entirely and echoed the launch origin would still pass it.
    launch, session = _bootstrap(service)
    assert launch["recipe"]["autobk"]["rbkg"] != 1.375
    _write_group(service, session, lambda g: g["parameters"].update(rbkg=1.375))

    sealed = service.sealed_export(
        draft_id=session.draft_id,
        capability=session.owner_capability,
        now=NOW,
    )

    assert sealed.recipe.autobk.rbkg == 1.375
    assert sealed.recipe_sha256 != launch["recipe_sha256"]
    assert sealed.spectrum_sha256 == launch["spectrum_sha256"]


def test_sealed_export_refuses_a_capability_that_does_not_own_the_draft(service):
    _, session = _bootstrap(service)

    with pytest.raises(IntegrationAuthorizationError):
        service.sealed_export(
            draft_id=session.draft_id,
            capability="w" * 32,
            now=NOW,
        )


def test_sealed_export_refuses_a_discarded_draft(service):
    _, session = _bootstrap(service)
    service.storage.transition(
        session.draft_id, session.owner_capability, DraftStatus.DISCARDED, NOW
    )

    with pytest.raises(IntegrationAuthorizationError):
        service.sealed_export(
            draft_id=session.draft_id,
            capability=session.owner_capability,
            now=NOW,
        )


def test_sealed_export_still_serves_a_sealed_draft(service):
    # Sealing is what import does on success. Export stays readable afterwards so
    # a retried or resumed import is not locked out of its own source data.
    _, session = _bootstrap(service)
    service.storage.transition(
        session.draft_id, session.owner_capability, DraftStatus.SEALED, NOW
    )

    sealed = service.sealed_export(
        draft_id=session.draft_id,
        capability=session.owner_capability,
        now=NOW,
    )

    assert sealed.draft_id == session.draft_id


def test_sealed_export_refuses_a_workspace_whose_arrays_were_tampered_with(service):
    # The editor never edits energy/mu, so a changed digest is tampering, not an
    # edit, and must not be laundered into a signed export.
    _, session = _bootstrap(service)
    _write_group(
        service, session, lambda g: g.update(mu=[value + 0.5 for value in g["mu"]])
    )

    with pytest.raises(IntegrationAuthorizationError):
        service.sealed_export(
            draft_id=session.draft_id,
            capability=session.owner_capability,
            now=NOW,
        )


def test_a_draft_without_a_persisted_origin_is_unexportable_but_not_poisonous(service):
    # Drafts created before this milestone have no origin. They must refuse to
    # export, yet still be readable by the wholesale glob in expire_due so one
    # stale file cannot break every other draft's operations.
    _, session = _bootstrap(service)
    path = service.storage.drafts_dir / f"{session.draft_id}.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    del value["origin"]
    path.write_text(json.dumps(value), encoding="utf-8")

    assert service.storage.expire_due(NOW) == ()
    assert service.storage.load_draft(
        session.draft_id, session.owner_capability
    ).origin is None
    with pytest.raises(IntegrationAuthorizationError):
        service.sealed_export(
            draft_id=session.draft_id,
            capability=session.owner_capability,
            now=NOW,
        )


def test_snapshot_holds_the_draft_lock_through_cached_result_read(service, monkeypatch):
    from threading import Event, Thread
    session = real_science_session(service)
    original_load = service.athena_store.load
    waiting, acquired = Event(), Event()
    def compete():
        waiting.set()
        with service.storage.draft_lock(session.draft_id):
            acquired.set()
    worker = Thread(target=compete)
    def checked_load(project_id):
        worker.start()
        assert waiting.wait(2)
        assert not acquired.wait(0.2), 'mutation entered during snapshot read'
        return original_load(project_id)
    monkeypatch.setattr(service.athena_store, 'load', checked_load)
    try:
        service.import_snapshot(draft_id=session.draft_id, capability=session.owner_capability, now=NOW)
    finally:
        worker.join(2)
    assert acquired.is_set()


def test_pending_import_denies_mutation_but_keeps_audit_reads(service):
    from xraylarch_web.integration_contracts import ImportBinding
    session = real_science_session(service)
    binding = ImportBinding(import_id='a' * 32, attempt_id='b' * 32, project_version=0, snapshot_sha256='c' * 64)
    draft = service.storage.prepare_import(session.draft_id, session.owner_capability, binding, NOW, lambda record: None)
    for action in ('metadata', 'parameters', 'set_e0', 'undo', 'redo'):
        with pytest.raises(IntegrationAuthorizationError):
            service.allowed_operation(action, group_ids=(session.group_id,), draft=draft)
    service.allowed_operation('export', group_ids=(session.group_id,), draft=draft)


def import_binding(service, session):
    from xraylarch_web.integration_contracts import ImportBinding, snapshot_sha256
    snapshot = service.import_snapshot(draft_id=session.draft_id, capability=session.owner_capability, now=NOW)
    return ImportBinding(import_id='a' * 32, attempt_id='b' * 32,
                         project_version=snapshot.project_version, snapshot_sha256=snapshot_sha256(snapshot))


def signed_import_action(service, session, action, binding=None, nonce='i' * 32, now=NOW):
    payload = {'draft_id': session.draft_id, 'owner_capability': session.owner_capability, 'action': action}
    if binding is not None:
        payload['binding'] = binding.model_dump(mode='json')
    raw = json.dumps(payload).encode()
    return service.verified_import_action(raw_body=raw, headers=signed_headers(raw, nonce=nonce, timestamp=now), draft_id=session.draft_id, now=now)


def test_signed_import_preparation_checks_snapshot_and_finalization_is_idempotent(service):
    session = real_science_session(service)
    binding = import_binding(service, session)
    prepared = signed_import_action(service, session, 'prepare', binding)
    assert prepared.status.value == 'importing'
    assert prepared.binding == binding
    with pytest.raises(IntegrationReplayError):
        signed_import_action(service, session, 'prepare', binding)
    status = signed_import_action(service, session, 'status', nonce='j' * 32)
    assert status == prepared
    finished = signed_import_action(service, session, 'finalize', binding, nonce='k' * 32)
    assert finished.status is DraftStatus.SEALED
    assert signed_import_action(service, session, 'finalize', binding, nonce='l' * 32) == finished


def test_prepare_refuses_an_edited_snapshot_before_freezing(service):
    from xraylarch_web.integration_storage import IntegrationConflictError
    session = real_science_session(service)
    binding = import_binding(service, session)
    project = service.athena_store.load(session.project_id)
    edited = deepcopy(project)
    edited['groups'][0]['label'] = 'edited meanwhile'
    service.athena_store.save(edited, project, 'intervening edit')
    with pytest.raises(IntegrationConflictError):
        signed_import_action(service, session, 'prepare', binding)
    assert service.storage.load_draft(session.draft_id, session.owner_capability).status is DraftStatus.ACTIVE


def test_expired_prepared_import_can_acknowledge_commit_without_reopening_editor(service):
    from xraylarch_web.integration_storage import IntegrationConflictError, IntegrationNotFoundError
    session = real_science_session(service)
    binding = import_binding(service, session)
    signed_import_action(service, session, 'prepare', binding)
    later = NOW + timedelta(days=8)
    state = signed_import_action(service, session, 'status', nonce='j' * 32, now=later)
    assert state.status is DraftStatus.EXPIRED
    assert state.binding == binding
    finished = signed_import_action(service, session, 'finalize', binding, nonce='k' * 32, now=later)
    assert finished == state
    with pytest.raises(IntegrationAuthorizationError):
        service.import_snapshot(draft_id=session.draft_id, capability=session.owner_capability, now=later)
    with pytest.raises(IntegrationConflictError):
        signed_import_action(service, session, 'abort', binding, nonce='l' * 32, now=later)
    wrong = binding.model_copy(update={'attempt_id': 'f' * 32})
    with pytest.raises(IntegrationConflictError):
        signed_import_action(service, session, 'finalize', wrong, nonce='m' * 32, now=later)
    assert service.storage.load_draft(session.draft_id, session.owner_capability).status is DraftStatus.EXPIRED


def test_expired_unprepared_draft_has_no_import_receipt(service):
    from xraylarch_web.integration_storage import IntegrationNotFoundError
    session = real_science_session(service)
    with pytest.raises(IntegrationNotFoundError):
        signed_import_action(service, session, 'status', now=NOW + timedelta(days=8))
