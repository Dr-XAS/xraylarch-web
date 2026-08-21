# XrayLarch Web Watcher Reboot Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Goldendale XrayLarch Web watcher restartable after reboot and able to recover the unchanged active release when its processes are gone.

**Architecture:** Keep the existing GNU `screen` watcher and deployer boundaries. Add an app-owned, locked `ensure-watcher.sh` bootstrap; add a fail-closed `recover` action to the host deployer by reusing its candidate, process-record, activation, and guarded rollback machinery; and make each watcher poll health-check and recover the canonical release before considering a SHA current. Register the helper with Goldendale's existing user cron boot/liveness paths after local verification.

**Tech Stack:** Bash, GNU `screen`, `flock`, Git, `curl`, `lsof`/`ss`, shell regression tests, Markdown deployment contract.

**Spec:** `docs/superpowers/specs/2026-08-21-xraylarch-web-watcher-reboot-durability-design.md`

## Global Constraints

- Preserve final frontend `0.0.0.0:3004`, backend `127.0.0.1:8006`, candidate ports `13004`/`18006`, and existing screen names.
- Preserve the deployer's exact release, process-owner, command-line, working-directory, listener, symlink, and state-file checks; fail closed on ambiguity.
- The watcher remains a coordinator; only the deployer may stage, cut over, recover, roll back, or mutate application activation state.
- Goldendale runs with `XRAYLARCH_WEB_SIBLING_PROFILE=goldendale`; the default `drxas` profile must remain unchanged.
- No provider, email, Slack, Dr.XAS database, or other secret may enter watcher/deployer environments.
- Keep all application mutable data below `/local/apps/xraylarch-web/data` and watcher state below `/local/apps/xraylarch-web/state/watcher`.
- Do not push, merge, publish, or modify unrelated services; host writes are limited to the XrayLarch Web operations files and Goldendale's watcher persistence entries.
- Every implementation behavior must have a test that was observed failing before its production change.

---

### Task 1: Add the locked watcher bootstrap helper

**Files:**
- Create: `scripts/ensure-watcher.sh`
- Create: `tests/test_watcher_bootstrap.sh`

**Interfaces:**
- Consumes environment variables `XRAYLARCH_WEB_APP_ROOT`, `XRAYLARCH_WEB_WATCH_SCREEN`, `XRAYLARCH_WEB_WATCHER_SCRIPT`, `XRAYLARCH_WEB_WATCH_STATE_ROOT`, `XRAYLARCH_WEB_SIBLING_PROFILE`, `XRAYLARCH_WEB_WATCH_PATH`, `XRAYLARCH_WEB_REPO_DIR`, `XRAYLARCH_WEB_DEPLOY_SCRIPT`, `XRAYLARCH_WEB_BRANCH`, `XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE`, `XRAYLARCH_WEB_WATCH_LOG`, and `XRAYLARCH_WEB_WATCH_INTERVAL`.
- Produces no application-state changes when exactly one exact watcher screen exists.
- Produces one detached screen named `xraylarch-web-watch` when none exists, with the configured profile and explicit PATH.
- Returns nonzero without stopping anything when multiple exact sessions, an invalid watcher script, or an unavailable screen binary is found.

- [ ] **Step 1: Write the failing bootstrap test.**

Create a temporary fixture with a mocked `screen` executable. The mock must:

1. print a tab-separated `PID.NAME (Detached)` line for `-ls` from a fixture file;
2. record `-dmS` arguments and the `env` assignments from the start command; and
3. write a synthetic exact session to the fixture file after a successful `-dmS` call.

Exercise these cases in `tests/test_watcher_bootstrap.sh`:

```bash
# No session: one exact start with the Goldendale profile and a PATH containing conda.
XRAYLARCH_WEB_SIBLING_PROFILE=goldendale \
XRAYLARCH_WEB_WATCH_PATH=/opt/miniconda/bin:/usr/bin \
XRAYLARCH_WEB_WATCH_SCREEN=xraylarch-web-watch \
XRAYLARCH_WEB_WATCHER_SCRIPT="$repo_root/scripts/start-watcher.sh" \
XRAYLARCH_WEB_WATCH_STATE_ROOT="$test_root/state/watcher" \
SCREEN_BIN="$test_root/bin/screen" \
  "$repo_root/scripts/ensure-watcher.sh"

grep -F 'profile=goldendale' "$test_root/screen-start.log"
grep -F 'PATH=/opt/miniconda/bin:/usr/bin' "$test_root/screen-start.log"
[[ "$(wc -l < "$test_root/screen-start.log")" -eq 1 ]]

# Exact session present: no duplicate start.
SCREEN_BIN="$test_root/bin/screen" \
XRAYLARCH_WEB_WATCH_STATE_ROOT="$test_root/state/watcher" \
  "$repo_root/scripts/ensure-watcher.sh"
[[ "$(wc -l < "$test_root/screen-start.log")" -eq 1 ]]

# Ambiguous exact sessions: fail closed and do not stop either session.
printf '101.xraylarch-web-watch (Detached)\n102.xraylarch-web-watch (Detached)\n' > "$test_root/sessions"
if SCREEN_BIN="$test_root/bin/screen" \
   XRAYLARCH_WEB_WATCH_STATE_ROOT="$test_root/state/collision" \
   "$repo_root/scripts/ensure-watcher.sh"; then
  fail "ambiguous watcher sessions must fail closed"
fi
```

Also assert that a similarly prefixed name such as `xraylarch-web-watch-extra`
does not satisfy the exact-session check.

- [ ] **Step 2: Run the new test and verify the expected red failure.**

Run:

```bash
bash tests/test_watcher_bootstrap.sh
```

Expected: failure because `scripts/ensure-watcher.sh` does not exist yet.

- [ ] **Step 3: Implement the minimal locked helper.**

Implement `scripts/ensure-watcher.sh` with `set -Eeuo pipefail` and `umask 077`:

```bash
APP_ROOT="${XRAYLARCH_WEB_APP_ROOT:-/local/apps/xraylarch-web}"
SCREEN_NAME="${XRAYLARCH_WEB_WATCH_SCREEN:-xraylarch-web-watch}"
WATCHER_SCRIPT="${XRAYLARCH_WEB_WATCHER_SCRIPT:-${APP_ROOT}/ops/start-watcher.sh}"
STATE_ROOT="${XRAYLARCH_WEB_WATCH_STATE_ROOT:-${APP_ROOT}/state/watcher}"
SIBLING_PROFILE="${XRAYLARCH_WEB_SIBLING_PROFILE:-drxas}"
WATCH_PATH="${XRAYLARCH_WEB_WATCH_PATH:-${HOME:-/home/beams/HUANG.JEFFREY}/miniconda3/bin:/usr/local/bin:/usr/bin:/bin}"
SCREEN_BIN="${SCREEN_BIN:-/usr/bin/screen}"
```

Validate `SIBLING_PROFILE` as `drxas|goldendale`, validate that `SCREEN_BIN`
and `WATCHER_SCRIPT` are executable regular files and that the state root is
not a symlink, then create the private state directory and acquire
`$STATE_ROOT/ensure.lock` with `flock -n`. Treat a held lock as a successful
no-op because another bootstrap invocation owns the reconciliation.

Use the same exact-session `awk` shape as the deployer:

```bash
screen_sessions_for_name() {
  "$SCREEN_BIN" -ls 2>/dev/null |
    awk -v target="$SCREEN_NAME" '$1 ~ ("^[0-9]+\\." target "$") { print $1 }'
}
```

If there is one exact session, log `already running` and exit 0. If there is
more than one, fail without issuing a stop command. If there are none, launch
without a shell-built command string:

```bash
"$SCREEN_BIN" -dmS "$SCREEN_NAME" /usr/bin/env \
  PATH="$WATCH_PATH" \
  XRAYLARCH_WEB_SIBLING_PROFILE="$SIBLING_PROFILE" \
  bash "$WATCHER_SCRIPT"
```

Pass through the configured repository, deployer, branch, state, log, and
interval variables as explicit `env` assignments when they are set, so cron
does not lose the Goldendale profile or host paths. Do not stop stale screens,
kill PIDs, or mutate application release state in this helper.

- [ ] **Step 4: Run the bootstrap test and syntax check.**

Run:

```bash
bash tests/test_watcher_bootstrap.sh
bash -n scripts/ensure-watcher.sh
```

Expected: all bootstrap cases pass and the syntax check exits 0.

- [ ] **Step 5: Commit the isolated helper task.**

```bash
git add scripts/ensure-watcher.sh tests/test_watcher_bootstrap.sh
git commit -m "ops: add idempotent watcher bootstrap"
```

### Task 2: Add fail-closed same-release recovery to the deployer

**Files:**
- Modify: `scripts/deploy-xraylarch-web.sh:51-88, 754-779, 857-929`
- Modify: `tests/test_deploy_xraylarch_web.sh:43-250`

**Interfaces:**
- Adds CLI action `recover <full-sha>` alongside `deploy`, `rollback`, `health`, and `migrate`.
- Adds `perform_recover`, `recovery_surface_is_absent`, and `discard_stale_recovery_records` shell functions.
- `perform_recover` returns success without mutation when `perform_health` passes; otherwise it invokes `activate_release` for the same requested SHA.
- Recovery uses the existing `ACTIVATION_*` variables and guarded cleanup; it never builds a release or changes the requested SHA.

- [ ] **Step 1: Add failing unit tests for recovery routing and stale-record safety.**

Extend `tests/test_deploy_xraylarch_web.sh` with these assertions before adding
the implementation:

```bash
parse_arguments recover "$state_sha"
[[ "$ACTION" == recover && "$REQUESTED_SHA" == "$state_sha" ]] ||
  test_fail "recover must parse as a full-SHA action"

events=()
read_current_release() { CURRENT_RELEASE="$state_release"; CURRENT_SHA="$state_sha"; }
assert_last_successful_state() { :; }
perform_health() { return 1; }
activate_release() { events+=("activate:$1"); }
REQUESTED_SHA="$state_sha"
perform_recover
[[ "${events[*]}" == "activate:$state_sha" ]] ||
  test_fail "unhealthy recover must reactivate the requested release"
```

Create a valid stale frontend/backend record pair using the existing record
fixture helpers, mock `screen_sessions_for_name` and `listener_pids` to return
no active surface, call `recovery_surface_is_absent` followed by
`discard_stale_recovery_records`, and assert both records are gone. Then mock
one exact screen or one listener and assert the helper fails and leaves the
record untouched.

- [ ] **Step 2: Run the deployment test and verify it fails for missing recovery behavior.**

Run:

```bash
bash tests/test_deploy_xraylarch_web.sh
```

Expected: failure at `parse_arguments recover` or the missing recovery helper,
not a test harness syntax error.

- [ ] **Step 3: Add the `recover` CLI action and recovery helpers.**

Add `recover` to `usage`, the accepted action pattern, and `main`:

```bash
deploy-xraylarch-web.sh recover <full-sha>
```

Implement `recovery_surface_is_absent` for the final frontend/backend pairs:

```bash
recovery_surface_is_absent() {
  local pair name port
  for pair in \
    "${FRONTEND_SCREEN}:${FINAL_FRONTEND_PORT}" \
    "${BACKEND_SCREEN}:${FINAL_BACKEND_PORT}"; do
    name=${pair%%:*}
    port=${pair##*:}
    [[ -z "$(screen_sessions_for_name "$name")" ]] || return 1
    [[ -z "$(listener_pids "$port")" ]] || return 1
  done
}
```

Implement `discard_stale_recovery_records` only after the absence check has
passed. For each final record, if it exists, load it with
`load_component_record` using the current canonical release, expected kind,
host, and port; remove it only after the load succeeds. A symlink, malformed
record, mismatched release, or collision must return nonzero before any
removal. Missing records are acceptable.

Update `begin_activation` so the current-release branch has two explicit
paths:

1. If both final screens and listeners are absent, validate/discard matching
   stale records, set `ACTIVATION_PREVIOUS_RELEASE`/`ACTIVATION_PREVIOUS_SHA`
   to the current release, and mark both previous components stopped so the
   existing guarded cleanup can restart them if staging fails.
2. Otherwise preserve the existing capture-and-verify path. A partial or
   ambiguous active surface must fail closed rather than be killed.

Implement `perform_recover` as:

```bash
perform_recover() {
  read_current_release || { fail "current release symlink is absent"; return 1; }
  [[ "$CURRENT_SHA" == "$REQUESTED_SHA" ]] || {
    fail "current release is not the requested SHA"
    return 1
  }
  assert_last_successful_state "$REQUESTED_SHA" "$CURRENT_RELEASE" || return 1
  if perform_health >/dev/null 2>&1; then
    printf 'healthy sha=%s release=%s\n' "$CURRENT_SHA" "$CURRENT_RELEASE"
    return 0
  fi
  activate_release "$REQUESTED_SHA" || return 1
  printf 'recovered sha=%s release=%s\n' "$REQUESTED_SHA" "$CURRENT_RELEASE"
}
```

Dispatch `recover` through `initialize_host_paths` and
`prepare_candidate_data`, just like `deploy` and `rollback`, so it holds the
deployment lock and has the clean runtime directories required by
`launch_component`. Do not call `build_release` for this action.

- [ ] **Step 4: Run the deployment tests and syntax check.**

Run:

```bash
bash tests/test_deploy_xraylarch_web.sh
bash -n scripts/deploy-xraylarch-web.sh
```

Expected: the routing, stale-record, collision, existing activation, and
existing Goldendale profile checks all pass.

- [ ] **Step 5: Commit the deployer recovery task.**

```bash
git add scripts/deploy-xraylarch-web.sh tests/test_deploy_xraylarch_web.sh
git commit -m "ops: recover active release after process loss"
```

### Task 3: Make watcher polling health-aware

**Files:**
- Modify: `scripts/start-watcher.sh:6-79`
- Modify: `tests/test_watcher.sh:90-148`

**Interfaces:**
- Adds `write_watcher_success`, `run_deployer_action`, and `poll_once` shell functions.
- `poll_once` fetches one remote SHA, records observation, repairs the canonical active SHA before deployment, and returns nonzero after a failed recovery/deploy without advancing watcher success state.
- `run_deployer_action <action> <sha>` always passes `XRAYLARCH_WEB_SIBLING_PROFILE` and appends deployer output to the watcher log.

- [ ] **Step 1: Extend the watcher test with failing health/recovery cases.**

Change the deploy mock in `tests/test_watcher.sh` to record action names and
return independently controlled `TEST_HEALTH_EXIT`, `TEST_RECOVER_EXIT`, and
`TEST_DEPLOY_EXIT` values. Add these cases:

```bash
# Same SHA but failed health: recover, do not deploy, and record watcher success.
rm -f "$test_root/deploy.log" "$test_root/state/watcher/last-successful-sha"
TEST_HEALTH_EXIT=1 TEST_RECOVER_EXIT=0 TEST_DEPLOY_EXIT=0 \
TEST_REMOTE_SHA="$sha" TEST_DEPLOY_LOG="$test_root/deploy.log" \
PATH="$test_root/bin:$PATH" XRAYLARCH_WEB_REPO_DIR="$test_root/repo" \
XRAYLARCH_WEB_DEPLOY_SCRIPT="$test_root/deploy.sh" \
XRAYLARCH_WEB_SIBLING_PROFILE=goldendale \
XRAYLARCH_WEB_WATCH_STATE_ROOT="$test_root/state/watcher" \
XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE="$test_root/last-successful" \
XRAYLARCH_WEB_WATCH_LOG="$test_root/watcher.log" \
XRAYLARCH_WEB_WATCH_INTERVAL=1 XRAYLARCH_WEB_WATCH_ONCE=1 \
  "$watcher" >/dev/null 2>&1
grep -F 'action=health' "$test_root/deploy.log"
grep -F 'action=recover' "$test_root/deploy.log"
! grep -F 'action=deploy' "$test_root/deploy.log"
[[ "$(<"$test_root/state/watcher/last-successful-sha")" == "$sha" ]]

# Failed recovery: no deployment and no watcher success advancement.
rm -f "$test_root/state/watcher/last-successful-sha"
TEST_HEALTH_EXIT=1 TEST_RECOVER_EXIT=1 TEST_DEPLOY_EXIT=0 \
TEST_REMOTE_SHA="$sha" TEST_DEPLOY_LOG="$test_root/deploy.log" \
PATH="$test_root/bin:$PATH" XRAYLARCH_WEB_REPO_DIR="$test_root/repo" \
XRAYLARCH_WEB_DEPLOY_SCRIPT="$test_root/deploy.sh" \
XRAYLARCH_WEB_SIBLING_PROFILE=goldendale \
XRAYLARCH_WEB_WATCH_STATE_ROOT="$test_root/state/watcher" \
XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE="$test_root/last-successful" \
XRAYLARCH_WEB_WATCH_LOG="$test_root/watcher.log" \
XRAYLARCH_WEB_WATCH_INTERVAL=1 XRAYLARCH_WEB_WATCH_ONCE=1 \
  "$watcher" >/dev/null 2>&1 || true
! grep -F 'action=deploy' "$test_root/deploy.log"
[[ ! -e "$test_root/state/watcher/last-successful-sha" ]]
```

Keep the existing failed-deploy and Goldendale-profile assertions, updating
their expected mock lines to include action names.

- [ ] **Step 2: Run the watcher test and verify the expected red failure.**

Run:

```bash
bash tests/test_watcher.sh
```

Expected: the new health/recovery assertions fail because the current watcher
does not call the deployer `health` or `recover` actions.

- [ ] **Step 3: Refactor the watcher into a health-aware poll.**

Add:

```bash
run_deployer_action() {
  local action="$1" sha="$2"
  XRAYLARCH_WEB_SIBLING_PROFILE="$SIBLING_PROFILE" \
    bash "$DEPLOY_SCRIPT" "$action" "$sha" >>"$LOG" 2>&1
}

write_watcher_success() {
  local sha="$1"
  write_atomic "$STATE_ROOT/last-successful-sha" "$sha"
  write_atomic "$STATE_ROOT/last-successful-at" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
```

Move one fetch/resolve iteration into `poll_once`:

```bash
poll_once() {
  local remote_sha successful_sha previous
  if ! git -C "$REPO_DIR" fetch origin "$BRANCH" -q 2>>"$LOG"; then
    log "fetch failed; retaining the active release and retrying after the next poll"
    return 1
  fi
  remote_sha="$(git -C "$REPO_DIR" rev-parse "origin/${BRANCH}")"
  [[ "$remote_sha" =~ ^[0-9a-f]{40}$ ]] || {
    log "refusing invalid remote SHA: ${remote_sha}"
    return 1
  }
  write_atomic "$STATE_ROOT/last-observed-remote-sha" "$remote_sha"
  write_atomic "$STATE_ROOT/last-observed-remote-at" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  successful_sha="$(read_successful_sha || true)"
  if [[ -n "$successful_sha" ]]; then
    if run_deployer_action health "$successful_sha"; then
      log "${successful_sha:0:12} health is good"
    elif run_deployer_action recover "$successful_sha"; then
      log "${successful_sha:0:12} recovered before branch reconciliation"
    else
      log "${successful_sha:0:12} recovery failed; retaining the active release"
      return 1
    fi
  fi

  if [[ "$remote_sha" == "$successful_sha" ]]; then
    write_watcher_success "$remote_sha"
    log "${remote_sha:0:12} already active"
    return 0
  fi

  previous="${successful_sha:-none}"
  log "deploying ${remote_sha:0:12} (last success: ${previous:0:12})"
  if run_deployer_action deploy "$remote_sha"; then
    write_watcher_success "$remote_sha"
    log "deployment succeeded for ${remote_sha:0:12}"
    return 0
  fi
  log "deployment failed for ${remote_sha:0:12}; retrying after the next poll"
  return 1
}
```

Call it inside the existing loop as `if ! poll_once; then :; fi`, preserve
`XRAYLARCH_WEB_WATCH_ONCE=1`, and keep the loop sleep behavior unchanged.
This prevents `set -e` from terminating the long-lived watcher on a transient
fetch, health, recovery, or deploy failure.

- [ ] **Step 4: Run watcher tests, syntax checks, and the focused shell suite.**

Run:

```bash
bash tests/test_watcher.sh
bash -n scripts/start-watcher.sh
bash -n scripts/check-xraylarch-web-watcher.sh
bash tests/test_deploy_xraylarch_web.sh
```

Expected: all watcher and deployer tests pass with no new stderr diagnostics.

- [ ] **Step 5: Commit the health-aware watcher task.**

```bash
git add scripts/start-watcher.sh tests/test_watcher.sh
git commit -m "ops: recover unhealthy release before watcher deploys"
```

### Task 4: Update the deployment contract and operational documentation

**Files:**
- Modify: `README.md:88-145`
- Modify: `deploy/xraylarch-web.manifest.md:20-165`

**Interfaces:**
- Documents `recover <full-sha>` as a host-only deployer action.
- Documents `/local/apps/xraylarch-web/ops/ensure-watcher.sh` and its exact-session/fail-closed contract.
- Documents Goldendale's `@reboot` and five-minute liveness registration with explicit profile and PATH.

- [ ] **Step 1: Add documentation assertions to the existing shell check.**

Add a lightweight `tests/test_watcher.sh` text check that the README and
manifest contain `recover`, `ensure-watcher.sh`, `@reboot`, and
`XRAYLARCH_WEB_SIBLING_PROFILE=goldendale`. This fails before the documentation
change and prevents the operational contract from drifting.

- [ ] **Step 2: Run the documentation check and verify it fails.**

Run:

```bash
bash tests/test_watcher.sh
```

Expected: only the new documentation assertion fails before the docs are
updated.

- [ ] **Step 3: Update README and manifest.**

Add the recovery command beside deploy/rollback/health:

```text
XRAYLARCH_WEB_SIBLING_PROFILE=goldendale \
  /local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh recover <full-sha>
```

Document the helper's defaults, exact-session matching, no-kill behavior, and
the two Goldendale persistence entries. State explicitly that the watcher
health-check/recovery path keeps the existing release SHA and that
`state/last-successful` remains deployer-owned.

- [ ] **Step 4: Run documentation, syntax, and focused tests.**

Run:

```bash
bash tests/test_watcher.sh
bash tests/test_watcher_bootstrap.sh
bash tests/test_deploy_xraylarch_web.sh
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the operational contract task.**

```bash
git add README.md deploy/xraylarch-web.manifest.md tests/test_watcher.sh
git commit -m "docs: document durable watcher recovery"
```

### Task 5: Full local verification and independent review

**Files:**
- Review: all commits since `3c5f1f68b893b608cad591ddd19f98b1962c972b`

**Interfaces:**
- No new production interface; this task proves the complete watcher/deployer contract before host writes.

- [ ] **Step 1: Run the complete changed-script syntax check.**

```bash
for script in scripts/ensure-watcher.sh scripts/start-watcher.sh \
  scripts/check-xraylarch-web-watcher.sh scripts/deploy-xraylarch-web.sh; do
  bash -n "$script"
done
```

- [ ] **Step 2: Run the focused shell regression suite.**

```bash
bash tests/test_watcher_bootstrap.sh
bash tests/test_watcher.sh
bash tests/test_deploy_xraylarch_web.sh
```

Record the exact pass counts/output and stop if any test fails.

- [ ] **Step 3: Run the repository's required application checks.**

Run the existing backend/frontend checks from the V1 checkpoint, using the
worktree-local environments and sequential frontend type/build commands so
`.next/types` cannot race:

```bash
backend/.venv/bin/python -m pytest backend/tests -q
backend/.venv/bin/python -m pytest backend/tests -W error -q
(cd frontend && npm run test -- --run)
(cd frontend && npm run typecheck)
(cd frontend && npm run build)
```

If an environment is absent, report that as a verification limitation rather
than substituting an unrelated global interpreter.

- [ ] **Step 4: Perform a fresh read-only diff review.**

Review `git diff 3c5f1f68b893b608cad591ddd19f98b1962c972b..HEAD`, checking:

- recovery cannot remove a record before proving its final port and screen are absent;
- ambiguous names and listeners are never stopped;
- `recover` preserves `current`/`last-successful` and uses guarded activation cleanup;
- watcher success state cannot advance after failed recovery/deploy;
- Goldendale profile and PATH are explicit under cron; and
- docs match the actual script interfaces.

Fix findings, rerun the affected red-green test, and commit the review fix
before touching Goldendale.

### Task 6: Install and accept the Goldendale host change

**Files:**
- Host install: `/local/apps/xraylarch-web/ops/ensure-watcher.sh`
- Host install: `/local/apps/xraylarch-web/ops/start-watcher.sh`
- Host install: `/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh`
- Host install: `/local/apps/xraylarch-web/ops/check-xraylarch-web-watcher.sh`
- Host persistence: Goldendale user's existing crontab and `/local/drxas-ops/watcher-liveness.sh`

**Interfaces:**
- Host persistence invokes only the XrayLarch watcher helper with `goldendale` profile and the conda-containing PATH.
- Host recovery uses the existing canonical SHA `6f90e68f7639407f689163bbfe703bff3ca99578`; it does not build or fetch a new release.

- [ ] **Step 1: Recheck host target and current state immediately before writes.**

Run read-only checks:

```bash
ssh goldendale 'hostname; screen -ls; ss -ltn; crontab -l'
ssh goldendale '/local/apps/xraylarch-web/ops/check-xraylarch-web-watcher.sh status'
```

Confirm the target is still Goldendale, the watcher is absent or unchanged,
and no unrelated service has changed since the earlier diagnosis.

- [ ] **Step 2: Install the four scoped operations scripts atomically.**

Copy the locally verified scripts to temporary files under the user's Goldendale
home, verify checksums, then install them with mode `0700` to the exact
`/local/apps/xraylarch-web/ops/` targets. Do not overwrite any other file and
do not push the branch.

- [ ] **Step 3: Add idempotent Goldendale persistence entries.**

Add only these exact commands if absent:

```cron
@reboot /usr/bin/env PATH="$HOME/miniconda3/bin:/usr/local/bin:/usr/bin:/bin" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale /local/apps/xraylarch-web/ops/ensure-watcher.sh >> /tmp/xraylarch-web-watchdog.log 2>&1
```

Add the same helper invocation to the existing `/local/drxas-ops/watcher-liveness.sh`
after its three existing `ensure_screen` calls, preserving the existing
five-minute `*/5` crontab entry rather than adding a duplicate periodic cron.
Back up each exact host file before the write and verify the resulting lines.

- [ ] **Step 4: Start the helper and recover the canonical release.**

Run:

```bash
ssh goldendale 'XRAYLARCH_WEB_SIBLING_PROFILE=goldendale /local/apps/xraylarch-web/ops/ensure-watcher.sh'
```

Allow the watcher to run one poll, or invoke the scoped recovery explicitly if
the watcher log shows it is waiting:

```bash
ssh goldendale 'XRAYLARCH_WEB_SIBLING_PROFILE=goldendale /local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh recover 6f90e68f7639407f689163bbfe703bff3ca99578'
```

Do not use `deploy` or `rollback` for this host recovery.

- [ ] **Step 5: Verify host acceptance and leave the host in a durable state.**

Run:

```bash
ssh goldendale 'XRAYLARCH_WEB_SIBLING_PROFILE=goldendale /local/apps/xraylarch-web/ops/check-xraylarch-web-watcher.sh status'
ssh goldendale 'XRAYLARCH_WEB_SIBLING_PROFILE=goldendale /local/apps/xraylarch-web/ops/check-xraylarch-web.sh check 6f90e68f7639407f689163bbfe703bff3ca99578'
ssh goldendale 'curl --fail --silent --show-error http://127.0.0.1:3004/ >/dev/null && curl --fail --silent --show-error http://127.0.0.1:8006/health'
ssh goldendale 'grep -E "health is good|recovered before branch reconciliation|deployment succeeded" /tmp/xraylarch-web-watch.log | tail -n 5'
```

Confirm exactly one watcher screen, frontend/backend/same-origin health, the
unchanged canonical SHA, healthy Goldendale Dr.XAS dev services, and explicit
Goldendale profile in the watcher process/log. Report any host limitation
without claiming reboot validation that was not actually performed.

- [ ] **Step 6: Record final Git and host state.**

Run `git status --short --branch`, `git log --oneline -8`, and the read-only
host status commands again. Do not push, merge, deploy a new SHA, or remove the
isolated worktree.
