# XrayLarch Web V1 Dr.XAS deployment manifest

## Authorization

| Item | Approved value |
| --- | --- |
| Application | `xraylarch-web` |
| Owner and rollback authority | Jeffrey Huang |
| Repository | `https://github.com/Dr-XAS/xraylarch-web.git` |
| Authorized branch | `codex/xraylarch-web-v1` |
| Public address | `http://drxas.xray.aps.anl.gov:3004` |
| Frontend listener | `0.0.0.0:3004` |
| Backend listener | `127.0.0.1:8006` |
| Candidate frontend listener | `127.0.0.1:13004` |
| Candidate backend listener | `127.0.0.1:18006` |
| Release root | `/local/apps/xraylarch-web/releases` |
| Active release link | `/local/apps/xraylarch-web/current` |
| Mutable data root | `/local/apps/xraylarch-web/data` |
| Process identity records | `/local/apps/xraylarch-web/state/processes` |
| Frontend screen | `xraylarch-web-frontend` |
| Backend screen | `xraylarch-web-backend` |
| Candidate frontend screen | `xraylarch-web-candidate-frontend` |
| Candidate backend screen | `xraylarch-web-candidate-backend` |
| Watcher screen | `xraylarch-web-watch` |
| Watcher poll interval | 60 seconds |
| Watcher state | `/local/apps/xraylarch-web/state/watcher` |
| Watcher log | `/tmp/xraylarch-web-watch.log` |

V1 is a trusted-network, single-user application. It has no authentication.

## Release contract

The approved host deployer is installed as
`/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh`. It accepts only a
full 40-character SHA:

```bash
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh deploy <full-sha>
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh rollback <full-sha>
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh health <full-sha>
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh recover <full-sha>
```

`deploy` first requires `refs/heads/codex/xraylarch-web-v1` at the remote to
equal the requested SHA. It builds a new detached checkout under
`releases/<sha>`, creates a release-local backend virtual environment from
`drxas-deploy`, installs the complete pinned set in
`deploy/python-release-constraints.txt`, records `pip freeze`, runs `pip check`,
and runs `npm ci` plus the production frontend build through `drxas-node20`.
Release inputs and artifacts are made read-only after integrity metadata is
written. The repository checkout is never used as a shared host clone.

The only mutable application state is below
`/local/apps/xraylarch-web/data`, including private candidate cache, runtime,
and temporary-home directories. The deployer starts child processes with a
clean environment and provides only `XRAYLARCH_DATA_ROOT`, `BACKEND_URL`,
`NEXT_BACKEND_URL`, and non-secret runtime variables. It does not inherit
provider, email, Slack, or Dr.XAS database secrets.

The active release stays on `3004` and `8006`. Before any cutover, the
deployer runs the target release in the two candidate screens on private
loopback `13004` and `18006`. It records each exact screen session PID and
listener child PID together with the observed command line, executable,
working directory, owners, port, and release SHA. It then requires exact
process ancestry, recorded identity, listener, frontend/backend/proxy health,
and candidate release identity. The active release remains untouched through
this staging check.

Only then does a brief, app-only handoff stop the two verified active
processes, wait for their exact listener PIDs and ports to disappear, and
start the already staged release under the final screen names and final ports.
The deployer validates the newly recorded final screen/listener identities
before atomically replacing `current` and `state/last-successful`, then stops
only the recorded staging processes. This is not zero downtime. If any stage,
handoff, final-health, or activation-state operation fails, guarded cleanup
stops only recorded target/candidate processes, restores the preceding
symlink/state, and restarts plus health-checks the prior release. A same-named
screen, changed PID, unexpected command, non-canonical release, or listener
ownership mismatch is a fail-closed collision and is never stopped.

`recover` validates that `current` and `state/last-successful` name the
requested immutable release. If the release is already healthy it makes no
application change. Otherwise it reuses the guarded candidate and activation
path to restore the same SHA. A reboot state with both final screens and
listeners absent may remove only matching stale process records before launch;
any ambiguous screen, listener, record, symlink, or identity fails closed.
The action never builds a release or changes the canonical release SHA.

## Legacy process-record migration

Installations created before launch-time process records require an explicit
bootstrap before deploy or health:

```bash
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh migrate <full-sha>
```

The command takes the deployment lock, verifies `current`,
`state/last-successful`, the requested release, both final listeners and their
exact GNU screen/process identities, then atomically writes both private
records. It never stops processes or changes `current`, state, application data,
or sibling services. A write or verification failure removes only records
created by that invocation. Existing matching records are accepted; partial,
symlinked, mismatched, duplicate, or colliding state fails closed. Deploy and
health do not silently migrate; the checker remains read-only.

## Runtime commands

The backend runs from the release `backend/` directory:

```bash
backend/.venv/bin/python -m uvicorn xraylarch_web.main:app --host 127.0.0.1 --port 8006
```

The frontend runs from the release `frontend/` directory using the
release-local `next start -H 0.0.0.0 -p 3004`, with both backend URL variables
set to `http://127.0.0.1:8006`.

## Health and release evidence

The read-only checker is installed as
`/local/apps/xraylarch-web/ops/check-xraylarch-web.sh` and accepts:

```bash
/local/apps/xraylarch-web/ops/check-xraylarch-web.sh check <full-sha>
```

An active release is healthy only when all of the following hold:

- frontend `/` returns HTTP 200;
- backend `/health` returns HTTP 200 and JSON `status` is `ok`;
- same-origin `/api/backend/health` returns HTTP 200;
- `current`, detached release `HEAD`, and release metadata equal the requested
  SHA;
- `state/last-successful` is a regular, non-symlink file whose SHA and
  canonical release path match the requested active release;
- exactly one final screen session exists for each name; listeners are exactly
  `0.0.0.0:3004` and `127.0.0.1:8006`; each listener PID is a recorded
  descendant of its screen PID and still matches the launch-time executable,
  command line, owners, release marker, and active release `frontend/` or
  `backend/` working directory; and
- existing Dr.XAS services remain healthy on `3000`, `3001`, `8000`, `8001`,
  `8002`, and `8003` with their established expected HTTP responses.

The checker only reads process, listener, filesystem, Git, and HTTP state. It
never stops processes or changes host state.

The default sibling-service profile is `drxas` and validates the established
Dr.XAS production, development, and bot endpoints listed above. Goldendale is
an approved alternate host profile because its production pair is intentionally
absent while the dev pair remains active. On Goldendale, set
`XRAYLARCH_WEB_SIBLING_PROFILE=goldendale` for deploy, health, and checker
commands; that profile validates only the existing `3001` frontend and `8001`
backend. It changes no XrayLarch listener, release, data, or process-identity
contract.

## Deployment watcher

The approved watcher is installed as
`/local/apps/xraylarch-web/ops/start-watcher.sh` and runs in the detached GNU
`screen` session `xraylarch-web-watch`. The idempotent bootstrap helper is
installed as `/local/apps/xraylarch-web/ops/ensure-watcher.sh`; it recreates
only a missing exact watcher screen and never stops a collision. On Goldendale,
the helper is registered in the existing persistence paths with the explicit
profile and conda-containing PATH:

```cron
@reboot /usr/bin/env PATH="$HOME/miniconda3/bin:/usr/local/bin:/usr/bin:/bin" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale /local/apps/xraylarch-web/ops/ensure-watcher.sh >> /tmp/xraylarch-web-watchdog.log 2>&1
```

The existing five-minute watcher-liveness job invokes the same helper after its
other scoped watcher checks. The watcher polls
`origin/codex/xraylarch-web-v1` every 60 seconds, resolves the branch to an
exact full SHA, health-checks the canonical active SHA, invokes `recover` when
health fails, and only then invokes `deploy` for a new SHA. The deployer remains
the sole authority for candidate staging, process identity, cutover, rollback,
health validation, and `state/last-successful`; the watcher never performs port
or process control itself. A failed health, recovery, or deployment operation
is retried on a later poll and is not recorded as watcher success.

Watcher bookkeeping is private and separate from the deployer's canonical
activation state:

- `/local/apps/xraylarch-web/state/watcher/last-observed-remote-sha`
- `/local/apps/xraylarch-web/state/watcher/last-observed-remote-at`
- `/local/apps/xraylarch-web/state/watcher/last-successful-sha`
- `/local/apps/xraylarch-web/state/watcher/last-successful-at`
- `/tmp/xraylarch-web-watch.log`

The read-only status command is
`/local/apps/xraylarch-web/ops/check-xraylarch-web-watcher.sh status`.

## Explicitly out of scope

This authorization covers only the xraylarch-web watcher and its existing
port-3004/8006 deployment. No firewall, reverse proxy, database, Dr.XAS shared
data root, provider secret, global process restart, or change to Dr.XAS or
xray-sample-db services is authorized. Do not add unrelated cron jobs, boot
entries, or service changes. A push of the exact branch revision and every
host write remain explicit approval gates.
