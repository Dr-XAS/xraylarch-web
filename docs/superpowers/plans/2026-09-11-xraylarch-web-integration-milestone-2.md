# XrayLarch Web Integration Milestone 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden xraylarch-web with capability-owned, seven-day integration drafts that can be atomically bootstrapped by Dr.XAS through signed server-to-server requests and opened once in a restricted core-processing workspace.

**Architecture:** Add an integration persistence/service layer under `data_root/integration/` that owns tenant capabilities, bootstrap nonces, browser handles, lifecycle metadata, and project mapping. An integration router validates an HMAC-signed canonical request before it can create a draft; a capability-aware Athena gateway protects every operation on integration-tagged projects while preserving the unrelated trusted-network legacy project API. The browser receives only a short-lived one-use handle and exchanges it for the owner capability after consumption; no Dr.XAS UI, public FastAPI listener, or Dr.XAS runtime adapter is included.

**Tech Stack:** Python 3.11+, FastAPI, Pydantic v2, filesystem persistence (`fcntl`, atomic `os.replace`, `fsync`), HMAC-SHA-256, pytest, existing Athena processing/store APIs.

**Spec:** Dr.XAS shared-memory topic `xraylarch-web-integration-plan` (2026-09-11 checkpoint); cross-repository integration contract `backend/xraylarch_web/integration_contracts.py`.

## Global Constraints

- Preserve all pre-existing dirty work in both repositories; modify only xraylarch-web Milestone 2 files and the existing mirrored contract defect needed for runtime correctness.
- Do not commit, push, deploy, alter watcher/deployment files, start the Dr.XAS adapter, add report-pane UI, or expose the FastAPI service beyond its existing loopback deployment.
- Integration is **default off**: every integration endpoint returns 404 unless `integration_api_enabled`; browser consumption also requires `browser_consume_enabled`; sealed export/import is not added in this milestone.
- Integration-only ownership: every operation on an integration-created project requires its opaque owner capability; legacy Athena projects and routes retain their established trusted-network behavior.
- Browser URLs carry only a `LaunchHandle` value and no project ID, payload, owner capability, shared secret, identity, filesystem path, or artifact key. The handle expires in at most 300 seconds and is single-use.
- Server-to-server bootstrap requires HMAC-SHA-256 over the exact canonical signing input: `issuer + "\n" + audience + "\n" + timestamp + "\n" + nonce + "\n" + body_sha256`; validate issuer/audience using constant-time comparison, require timestamp within ±300 seconds, and require a 32-byte lowercase-hex SHA-256 of the exact request body.
- Persist and atomically claim nonce and handle records before success; retries after a consumed nonce/handle must fail without creating or exposing another draft.
- Draft records expire after `Settings.draft_ttl_seconds` (default/max 604800); supported statuses are `active`, `sealed`, `discarded`, and `expired`; terminal transitions are idempotent, and sealed/discarded/expired drafts cannot mutate Athena data.
- One draft has one source spectrum/group. Its project may expose only core-processing operations: metadata selection where required for display, `parameters`, `set_e0`, `undo`, `redo`, and download/export of its own data. Project creation, data/project upload/import/restore, analyses, differences, group creation/deletion/duplication, and global project listing are unavailable to integration capabilities.
- Validate the versioned `LaunchEnvelope` strictly before any persistence or nonce claim. Never silently decimate, normalize, or modify authoritative energy/mu arrays; cap remains 100000 points.
- Imported integration project construction must be atomic: if writing project metadata, raw spectrum/group, or draft state fails, remove all newly created directory state and leave nonce consumed (retries fail closed).
- No external dependencies or database are added. Persistence stays 0700 directories/0600 files under the configured data root and uses existing atomic filesystem primitives.

---

## File Structure

- `backend/xraylarch_web/integration_contracts.py` — repair the runtime-equivalent FFT capacity invariant shared with Dr.XAS.
- `backend/tests/test_integration_contracts.py` — red/green regression coverage for the fixed capacity invariant.
- `backend/xraylarch_web/config.py` — integration signing identity/secret and per-owner quota settings; strict default-off validation.
- `backend/tests/test_config.py` — test settings fail closed when integration is enabled without signing settings and validate quotas.
- `backend/xraylarch_web/integration_storage.py` — focused durable records, atomic replay claims, capability validation, lifecycle transitions, cleanup, and rollback primitives.
- `backend/xraylarch_web/integration_service.py` — server-to-server signature verification, envelope-to-single-group Athena adaptation, draft creation, browser consumption, and core-surface policy.
- `backend/xraylarch_web/integration_routes.py` — FastAPI routes gated by settings and explicit request/body/header models.
- `backend/xraylarch_web/athena.py` — small capability-aware gateway for integration-tagged project routes; legacy behavior unchanged.
- `backend/xraylarch_web/main.py` — mount the integration router and pass the one shared integration service to Athena routes.
- `backend/tests/test_integration_api.py` — black-box failing-first coverage for signature, replay, tampering, ownership, lifecycle, one-time consume, restricted operations, malformed envelopes, and atomic failure.

### Task 1: Repair the mirrored FFT-capacity contract invariant

**Files:**
- Modify: `backend/xraylarch_web/integration_contracts.py:431-443`
- Modify: `/Users/huang.jeffrey/Desktop/Dr.XAS/backend/xraylarch_contracts.py:425-443`
- Test: `backend/tests/test_integration_contracts.py`
- Test: `/Users/huang.jeffrey/Desktop/Dr.XAS/backend/tests/test_xraylarch_contracts.py`

**Interfaces:**
- Consumes: `CoreProcessingRecipe.forward_ft`, `CoreProcessingRecipe.autobk`.
- Produces: identical runtime-equivalent validation in both strict contract mirrors.

- [ ] **Step 1: Write failing boundary tests in both suites**

```python
# Accept when the complete required k-grid exactly fits selected nfft.
recipe = valid_recipe(forward_ft={"nfft": 2048, "kstep": 0.05, "kmax": 101.4, "dk2": 0.0})
assert LaunchEnvelope.model_validate(valid_envelope(recipe=recipe))

# Reject when the forward taper extends the complete grid past selected nfft.
recipe = valid_recipe(forward_ft={"nfft": 2048, "kstep": 0.05, "kmax": 101.5, "dk2": 1.0})
with pytest.raises(ValidationError, match="nfft"):
    LaunchEnvelope.model_validate(valid_envelope(recipe=recipe))
```

- [ ] **Step 2: Run each focused test and verify it fails for the old invariant**

Run: `DRXAS_USERS_DB_PATH="/Users/huang.jeffrey/Desktop/Dr.XAS/backend/.pytest_users.db" /Users/huang.jeffrey/Desktop/Dr.XAS/backend/.venv/bin/python -m pytest /Users/huang.jeffrey/Desktop/xraylarch-web/backend/tests/test_integration_contracts.py -q` and the matching Dr.XAS focused test selector.

Expected: the boundary test fails because the old code compares `autobk` to `nfft // 2` and taper padding to the global maximum.

- [ ] **Step 3: Implement the shared runtime-equivalent formula**

```python
processing_kmax = max(recipe.autobk.kmax, recipe.forward_ft.kmax)
required_points = int(
    1.01 + max(processing_kmax, recipe.forward_ft.kmax + recipe.forward_ft.dk2)
    / recipe.forward_ft.kstep
)
if required_points > recipe.forward_ft.nfft:
    raise ValueError("The selected forward FFT nfft cannot represent the requested k range.")
```

- [ ] **Step 4: Run focused contract suites and schema drift checks**

Run the two focused contract suites, xraylarch-web local schema parity check, Dr.XAS schema generator/check, and `git diff --check`.

Expected: all pass; generated schema/type artifacts remain unchanged unless the emitted model schema changes.

### Task 2: Add fail-closed signing and quota configuration

**Files:**
- Modify: `backend/xraylarch_web/config.py`
- Test: `backend/tests/test_config.py`

**Interfaces:**
- Produces: `Settings.integration_issuer: str | None`, `integration_audience: str | None`, `integration_hmac_secret: str | None`, `integration_owner_draft_limit: int`; `Settings.integration_signing_enabled` validates necessary values.
- Consumes: existing `integration_api_enabled`, `browser_consume_enabled`, `draft_ttl_seconds` fields.

- [ ] **Step 1: Write failing configuration tests**

```python
def test_enabled_integration_requires_issuer_audience_and_secret(tmp_path):
    with pytest.raises(ValueError, match="issuer"):
        Settings(data_root=tmp_path, integration_api_enabled=True)


def test_integration_owner_draft_limit_is_positive(tmp_path):
    with pytest.raises(ValueError, match="OWNER_DRAFT_LIMIT"):
        Settings(data_root=tmp_path, integration_owner_draft_limit=0)
```

- [ ] **Step 2: Run `backend/tests/test_config.py` and verify RED**

Run: `.../.venv/bin/python -m pytest backend/tests/test_config.py -q`

Expected: failures because signing and quota fields do not exist and enabled integration currently accepts missing signing settings.

- [ ] **Step 3: Implement minimal strict environment/config support**

Use `XRAYLARCH_INTEGRATION_ISSUER`, `XRAYLARCH_INTEGRATION_AUDIENCE`, `XRAYLARCH_INTEGRATION_HMAC_SECRET`, and `XRAYLARCH_INTEGRATION_OWNER_DRAFT_LIMIT` (default `5`). Require non-blank issuer/audience, secret length at least 32 characters, and positive quota whenever integration API is enabled; do not return the secret in API output or error messages.

- [ ] **Step 4: Run focused config tests and preserve default-off behavior**

Run: `.../.venv/bin/python -m pytest backend/tests/test_config.py -q`

Expected: all tests pass including existing strict boolean/default-off tests.

### Task 3: Build durable integration-draft persistence and lifecycle primitives

**Files:**
- Create: `backend/xraylarch_web/integration_storage.py`
- Test: `backend/tests/test_integration_storage.py`

**Interfaces:**
- Produces:

```python
class IntegrationStorage:
    def claim_nonce(self, *, nonce: str, expires_at: datetime) -> None: ...
    def create_draft(self, *, envelope: LaunchEnvelope, owner_capability: str, project_id: str, created_at: datetime) -> DraftRecord: ...
    def load_draft(self, draft_id: str, owner_capability: str) -> DraftRecord: ...
    def consume_handle(self, handle: str, now: datetime) -> BrowserSession: ...
    def transition(self, draft_id: str, owner_capability: str, status: DraftStatus, now: datetime) -> DraftRecord: ...
    def expire_due(self, now: datetime) -> tuple[str, ...]: ...
```

- Consumes: `LaunchEnvelope`, `DraftStatus`, `DraftSummary`, `Settings.data_root`, and existing `WorkspaceStorage` atomic/permission helpers.

- [ ] **Step 1: Write failing storage tests**

```python
def test_nonce_claim_is_durable_and_rejects_replay_after_new_store(tmp_path):
    first = IntegrationStorage(tmp_path)
    first.claim_nonce(nonce="n" * 32, expires_at=FUTURE)
    with pytest.raises(IntegrationReplayError):
        IntegrationStorage(tmp_path).claim_nonce(nonce="n" * 32, expires_at=FUTURE)


def test_consume_handle_is_single_use_and_survives_restart(tmp_path):
    store, handle = seeded_active_draft(tmp_path)
    assert store.consume_handle(handle, NOW).draft_id
    with pytest.raises(IntegrationReplayError):
        IntegrationStorage(tmp_path).consume_handle(handle, NOW)


def test_expiry_and_terminal_transitions_are_idempotent(tmp_path):
    store, draft = seeded_active_draft(tmp_path)
    assert store.transition(draft.id, CAPABILITY, DraftStatus.DISCARDED, NOW).status == "discarded"
    assert store.transition(draft.id, CAPABILITY, DraftStatus.DISCARDED, NOW).status == "discarded"
    assert store.expire_due(AFTER_EXPIRY) == (draft.id,)
```

- [ ] **Step 2: Run the storage test file and verify RED**

Run: `.../.venv/bin/python -m pytest backend/tests/test_integration_storage.py -q`

Expected: collection failure because the integration storage module does not exist.

- [ ] **Step 3: Implement record layout and atomic primitives**

Use `data_root/integration/{drafts,nonces,handles}/<opaque-id>.json`, each record mode 0600. Create nonce records via exclusive `os.open(..., O_CREAT | O_EXCL, 0o600)` and fsync the parent directory after a successful create. Store only SHA-256 hashes for owner capabilities and browser handles. Use `fcntl.flock` on each draft record lock for lifecycle transitions. Return authorization-neutral not-found errors for missing/invalid capability/draft combinations. Cleanup changes expired active/sealed drafts to `expired` and unlinks capability/handle indexes; it does not delete project audit data until a later controlled retention operation.

- [ ] **Step 4: Run storage tests and inspect persisted permissions**

Run: `.../.venv/bin/python -m pytest backend/tests/test_integration_storage.py -q`

Expected: all storage tests pass, including restart/replay and idempotent transition coverage.

### Task 4: Adapt a validated one-spectrum envelope into an atomic Athena integration draft

**Files:**
- Create: `backend/xraylarch_web/integration_service.py`
- Modify: `backend/xraylarch_web/athena.py`
- Test: `backend/tests/test_integration_service.py`

**Interfaces:**
- Produces:

```python
class IntegrationService:
    def bootstrap(self, *, raw_body: bytes, headers: Mapping[str, str], now: datetime) -> LaunchHandle: ...
    def consume_browser_handle(self, handle: str, now: datetime) -> BrowserSession: ...
    def authorize_project(self, project_id: str, capability: str, now: datetime) -> DraftRecord: ...
    def allowed_operation(self, action: str, *, group_ids: Sequence[str], draft: DraftRecord) -> None: ...
```

- Consumes: `AthenaStore`, `IntegrationStorage`, configured signing settings, `LaunchEnvelope`.

- [ ] **Step 1: Write failing atomic-import/service tests**

```python
def test_bootstrap_creates_exactly_one_owner_bound_one_group_draft(client, signed_launch):
    result = bootstrap(client, signed_launch)
    session = consume(client, result.handle)
    project = get_integrated_project(client, session)
    assert len(project["groups"]) == 1
    assert project["groups"][0]["energy"] == list(signed_launch.envelope.spectrum.energy)


def test_atomic_import_failure_leaves_no_project_or_draft(monkeypatch, service, signed_launch):
    monkeypatch.setattr(service.athena_store.storage, "write_json", fail_after_first_project_write)
    with pytest.raises(OSError):
        service.bootstrap(...)
    assert service.storage.find_draft_by_source(signed_launch.envelope.source) is None
    assert not list((service.athena_store.storage.root).iterdir())


def test_integration_project_rejects_non_core_actions(service, session):
    for action in ("example", "duplicate", "delete", "difference", "restore"):
        with pytest.raises(IntegrationAuthorizationError):
            service.allowed_operation(action, group_ids=[session.group_id], draft=session.draft)
```

- [ ] **Step 2: Run service tests and verify RED**

Run: `.../.venv/bin/python -m pytest backend/tests/test_integration_service.py -q`

Expected: collection failure because `IntegrationService` does not exist.

- [ ] **Step 3: Implement signature verification and atomic adaptation**

Require headers `X-DrXAS-Issuer`, `X-DrXAS-Audience`, `X-DrXAS-Timestamp`, `X-DrXAS-Nonce`, `X-DrXAS-Body-SHA256`, and `X-DrXAS-Signature`. Reject malformed header syntax before claiming nonce. Confirm exact raw-body digest with `hmac.compare_digest`, validate timestamp ±300 seconds, calculate the prescribed HMAC input, compare signature with `hmac.compare_digest`, then parse `LaunchEnvelope.model_validate_json(raw_body)`. Claim the nonce only after all validation succeeds and before project creation.

Map the authoritative arrays to one Athena group with an explicit integration source marker, one group ID, core resolved parameters, and no raw upload artifact. Create project directory/project.json and draft/handle records within a compensating try/except: on any error remove newly-created project directory and draft/handle records, while retaining the nonce claim to fail closed. Generate 32-byte URL-safe owner capability and handle with `secrets.token_urlsafe(32)`; persist only their hashes.

- [ ] **Step 4: Add Athena integration authorization hooks**

Add optional `integration_service` to `build_athena_router`. For every project-specific Athena route, if the project has an integration marker, require `X-XrayLarch-Draft-Capability`, load/authorize the draft, reject expired/sealed/discarded state, and invoke `allowed_operation` before mutation. Keep legacy project paths unchanged. Update list endpoint so integration drafts are never returned; explicitly reject generic project creation/import/restore operations when using an integration capability.

- [ ] **Step 5: Run service tests and legacy Athena focused suite**

Run: `.../.venv/bin/python -m pytest backend/tests/test_integration_service.py backend/tests/test_athena_api.py -q`

Expected: integration tests pass and legacy Athena behavior remains green.

### Task 5: Expose default-off bootstrap, browser-consume, lifecycle, and restricted workspace routes

**Files:**
- Create: `backend/xraylarch_web/integration_routes.py`
- Modify: `backend/xraylarch_web/main.py`
- Modify: `backend/xraylarch_web/athena.py`
- Test: `backend/tests/test_integration_api.py`

**Interfaces:**
- Produces these endpoints only when their required settings are enabled:

```text
POST /api/integration/v1/bootstrap
POST /api/integration/v1/browser/consume
GET  /api/integration/v1/drafts/{draft_id}
POST /api/integration/v1/drafts/{draft_id}/discard
POST /api/integration/v1/drafts/{draft_id}/seal
GET  /api/integration/v1/drafts/{draft_id}/workspace
```

- `POST /bootstrap` accepts only raw JSON body plus signed server headers and returns `{ "handle": LaunchHandle }`.
- `POST /browser/consume` accepts `{ "handle": string }`, returns the project/group identifiers and an owner capability exactly once, and sends `Cache-Control: no-store`.
- Draft routes require `X-XrayLarch-Draft-Capability`; the workspace response returns a restricted snapshot and allowed-operation list.

- [ ] **Step 1: Write failing HTTP-level tests**

```python
def test_default_off_integration_routes_are_not_found(client):
    assert client.post("/api/integration/v1/bootstrap", content=b"{}").status_code == 404


def test_bootstrap_rejects_replay_expiry_wrong_issuer_audience_and_tampered_body(client, signed_launch):
    assert bootstrap(client, signed_launch).status_code == 200
    assert bootstrap(client, signed_launch).status_code in (400, 401)
    assert bootstrap(client, signed_launch.with_timestamp(OLD)).status_code == 401
    assert bootstrap(client, signed_launch.with_issuer("other")).status_code == 401
    assert bootstrap(client, signed_launch.with_audience("other")).status_code == 401
    assert bootstrap(client, signed_launch.with_body(b'{"tampered":true}')).status_code == 401


def test_cross_owner_access_and_duplicate_handle_consume_are_rejected(client, two_drafts):
    first = consume(client, two_drafts.first.handle).json()
    assert consume(client, two_drafts.first.handle).status_code in (400, 404)
    assert client.get(workspace_url(two_drafts.second.id), headers=capability(first)).status_code == 404


def test_malformed_envelope_and_duplicate_source_import_are_atomic(client, signed_launch):
    assert bootstrap(client, signed_launch.with_body(b"not-json")).status_code == 422
    first = bootstrap(client, signed_launch)
    second = bootstrap(client, signed_launch.with_new_nonce())
    assert second.status_code == 409
    assert exactly_one_draft_and_project(client)
```

- [ ] **Step 2: Run API tests and verify RED**

Run: `.../.venv/bin/python -m pytest backend/tests/test_integration_api.py -q`

Expected: failures because no integration router is mounted.

- [ ] **Step 3: Implement route gate, HTTP error mapping, and lifecycle endpoints**

Mount `build_integration_router(service, settings)` from `create_app()`, constructing one `AthenaStore`, `IntegrationStorage`, and `IntegrationService` shared by both routers. Do not disclose whether a draft exists to an invalid owner. Call `expire_due(now)` before every integration request. Allow `discard` and `seal` idempotently only to the owner; `seal` preserves project read/export access but blocks mutations. Do not add sealed-export/import callbacks: later Dr.XAS milestones own that flow.

- [ ] **Step 4: Run integration API suite and focused integration/legacy regression suites**

Run: `.../.venv/bin/python -m pytest backend/tests/test_integration_api.py backend/tests/test_integration_storage.py backend/tests/test_integration_service.py backend/tests/test_athena_api.py backend/tests/test_integration_contracts.py backend/tests/test_config.py -q`

Expected: all pass, including replay, expiry, issuer/audience, tampering, owner isolation, duplicate consumption, duplicate import, malformed-envelope, and atomic-failure tests.

### Task 6: Perform focused and full available verification plus independent review

**Files:**
- Modify only if tests/review identify a Milestone 2 defect.

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: verified uncommitted Milestone 2 changes with unrelated work preserved.

- [ ] **Step 1: Run static and focused verification**

Run:

```bash
cd /Users/huang.jeffrey/Desktop/xraylarch-web
python -m compileall backend/xraylarch_web
DRXAS_USERS_DB_PATH="/Users/huang.jeffrey/Desktop/Dr.XAS/backend/.pytest_users.db" \
  /Users/huang.jeffrey/Desktop/Dr.XAS/backend/.venv/bin/python -m pytest \
  backend/tests/test_integration_contracts.py backend/tests/test_config.py \
  backend/tests/test_integration_storage.py backend/tests/test_integration_service.py \
  backend/tests/test_integration_api.py backend/tests/test_athena_api.py -q
git diff --check
```

Expected: compile, focused tests, and diff check pass.

- [ ] **Step 2: Run the full available backend suite without modifying environment-generated files**

Run using the existing compatible virtual environment. If collection blocks on the pre-existing missing `larch._version` condition, record the exact blocker and do not generate/commit environment artifacts. Otherwise report failures with whether they reproduce against unchanged pre-Milestone-2 code.

- [ ] **Step 3: Dispatch an independent read-only security/correctness review**

Review requirements: signature canonicalization, constant-time comparisons, durable replay behavior over restart, raw-body tamper resistance, all integration project routes capability-gated, terminal-state behavior, default-off routing, no capability leakage in URL/log/error, legacy Athena compatibility, and atomic rollback behavior.

- [ ] **Step 4: Address confirmed reviewer findings through test-first fixes and rerun the affected suites**

For each confirmed finding, first add a narrow regression test that fails; then apply the minimal fix; rerun that test plus the relevant integration suite.

- [ ] **Step 5: Update durable memory and staged daily/weekly reports; do not commit code**

Use the Dr.XAS `memoryctl begin` transaction mechanism. Record the absolute date, uncommitted branches, changed files, verification commands/results, review results, outstanding blockers, and that no deployment/push/commit occurred.
