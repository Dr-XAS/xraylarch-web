# XrayLarch Web Watcher Reboot Durability Design

**Status:** Approved in chat on 2026-08-21

## Problem

Goldendale rebooted at 01:08 on 2026-08-21. The detached
`xraylarch-web-watch` screen session disappeared, ports `3004` and `8006` are
not listening, and the process records still describe the pre-reboot release
`6f90e68f7639407f689163bbfe703bff3ca99578`.

The current watcher has two independent gaps:

1. Nothing recreates its screen session after reboot. Goldendale's existing
   five-minute liveness cron only covers the Dr.XAS watchers.
2. If the watcher is restarted while the remote branch still equals the
   deployer's `state/last-successful` SHA, it logs `already active` without
   checking the application health. A reboot can therefore leave the app down
   indefinitely even after the watcher returns.

The watcher must remain the polling coordinator; the deployer must remain the
sole authority for release identity, process ownership, candidate validation,
cutover, rollback, and application state.

## Goals

- Recreate the exact `xraylarch-web-watch` screen session after a reboot.
- Recreate the watcher if its screen session is later killed or exits.
- Detect an unhealthy active release even when its SHA has not changed.
- Safely re-activate the canonical active release after a reboot or partial
  process loss, without deleting or replacing a release.
- Continue to support Goldendale's explicit `goldendale` sibling-service
  profile and the default `drxas` profile.
- Preserve fail-closed behavior for unexpected screens, listeners, malformed
  records, symlinks, ownership changes, or ambiguous process identity.
- Keep all mutable application data below the existing application data root
  and avoid provider, email, Slack, or Dr.XAS database secrets.

## Non-goals

- Migrating the application to systemd or changing the existing GNU `screen`
  process contract.
- Changing application ports, release layout, sibling services, reverse proxy,
  firewall, or scientific behavior.
- Adding a global reboot service or changing unrelated applications.
- Automatically pushing, merging, or deploying a new Git revision as part of
  local development verification.

## Design

### 1. Idempotent watcher bootstrap

Add `scripts/ensure-watcher.sh`, installed beside the other host operations as
`/local/apps/xraylarch-web/ops/ensure-watcher.sh`.

The helper will:

- take an exclusive `flock` under the private watcher state directory so an
  `@reboot` invocation and a periodic liveness invocation cannot race;
- inspect `screen -ls` for the exact `xraylarch-web-watch` name;
- return successfully without changing anything when exactly one matching
  screen exists;
- refuse to stop or reuse an ambiguous or colliding screen name;
- start exactly one detached screen with the configured watcher script,
  sibling profile, and an explicit executable `PATH` that includes the host's
  conda installation; and
- leave all deploy and process control to `start-watcher.sh` and the deployer.

Goldendale persistence will invoke the helper with
`XRAYLARCH_WEB_SIBLING_PROFILE=goldendale`. The host registration will add a
narrow `@reboot` entry and add the helper to the existing five-minute watcher
liveness path. The helper is safe to run from both paths because of its lock and
exact-session check.

### 2. Deployer recovery action

Extend `scripts/deploy-xraylarch-web.sh` with a `recover <full-sha>` action.
The action will:

- acquire the existing deployment lock and validate that `current`, the
  canonical release, and `state/last-successful` all name the requested SHA;
- return success without a restart if the full application health check passes;
- otherwise re-use the existing candidate/staging, identity-record, screen,
  listener, health, and guarded-cleanup machinery to re-activate the same
  immutable release;
- treat a completely absent pair of final screens and listeners as a safe
  reboot-recovery state, validating and removing only matching stale process
  records before launch;
- fail closed if any final screen, listener, record, symlink, or identity is
  present but cannot be proven to belong to the requested release; and
- preserve `current` and `state/last-successful` on failure, restoring the
  release and health state through the existing guarded recovery path.

The recovery path will not build a release, change the release SHA, or stop a
process that is not proven by the existing identity contract.

### 3. Health-aware watcher loop

Refactor the watcher poll into a single testable poll operation:

1. Fetch and resolve the approved branch to a full SHA.
2. Read the deployer's canonical successful SHA.
3. If a canonical SHA exists, invoke the deployer's read-only `health` action.
4. If health fails, invoke `recover` for that canonical SHA. Do not attempt a
   new deployment until recovery succeeds.
5. If the remote SHA differs from the canonical SHA, invoke the existing
   `deploy` action.
6. Record watcher observations and watcher success only after the relevant
   health, recovery, or deployment operation succeeds.

This ordering makes a reboot with no new commit recover the app, and makes a
new commit wait for a known-good active baseline before candidate cutover.
The canonical deployer state remains authoritative; watcher bookkeeping stays
separate and private.

### 4. Documentation and host acceptance

Update the README and deployment manifest with:

- the `recover` command;
- the bootstrap helper and its exact-session behavior;
- the Goldendale reboot/liveness registration contract; and
- read-only status and recovery verification commands.

After local verification, install the helper and persistence entries on
Goldendale, start the helper, and use the recovery path to restore the current
release. Host acceptance must confirm:

- exactly one watcher screen with the Goldendale profile;
- frontend HTTP 200 on `3004`;
- backend health HTTP 200 and `status: ok` on `8006`;
- same-origin backend health HTTP 200;
- canonical release and process records still equal the pre-reboot SHA;
- Goldendale's existing Dr.XAS development services remain healthy; and
- the watcher log records health/recovery success.

## Testing

- Add shell tests for bootstrap idempotence, exact screen matching, collision
  refusal, explicit profile/PATH propagation, and status reporting.
- Add deployer tests for safe stale-record cleanup, refusal when a listener or
  same-named screen remains, and recovery action routing.
- Run `bash -n` on every changed shell script.
- Run the focused deployment and watcher shell suites, then the existing
  application checks required by the repository's deployment workflow.
- Perform a fresh read-only review of the final diff and verify Goldendale
  after host installation before reporting completion.
