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
| Release root | `/local/apps/xraylarch-web/releases` |
| Active release link | `/local/apps/xraylarch-web/current` |
| Mutable data root | `/local/apps/xraylarch-web/data` |
| Frontend screen | `xraylarch-web-frontend` |
| Backend screen | `xraylarch-web-backend` |

V1 is a trusted-network, single-user application. It has no authentication.

## Release contract

The approved host deployer is installed as
`/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh`. It accepts only a
full 40-character SHA:

```bash
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh deploy <full-sha>
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh rollback <full-sha>
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh health <full-sha>
```

`deploy` first requires `refs/heads/codex/xraylarch-web-v1` at the remote to
equal the requested SHA. It builds a new detached checkout under
`releases/<sha>`, creates a release-local backend virtual environment from
`drxas-deploy`, records `pip freeze`, runs `pip check`, and runs `npm ci` plus
the production frontend build through `drxas-node20`. Release inputs and
artifacts are made read-only after integrity metadata is written. The
repository checkout is never used as a shared host clone.

The only mutable application state is below
`/local/apps/xraylarch-web/data`, including private candidate cache, runtime,
and temporary-home directories. The deployer starts child processes with a
clean environment and provides only `XRAYLARCH_DATA_ROOT`, `BACKEND_URL`,
`NEXT_BACKEND_URL`, and non-secret runtime variables. It does not inherit
provider, email, Slack, or Dr.XAS database secrets.

The fixed listeners and fixed screen names cannot bind a second release while
the active release owns `3004` and `8006`. Therefore the existing release
remains untouched through remote verification and build, then the deployer
performs a short, namespaced handoff at activation: it stops only the two
named XrayLarch screens, starts the candidate from its absolute release path,
requires candidate health and process identity, and atomically replaces
`current` and `state/last-successful`. If activation fails, it stops only the
candidate screens, restores the prior `current` symlink, starts only the prior
release screens, and checks that prior release. No unrelated service is
restarted.

## Runtime commands

The backend runs from the release `backend/` directory:

```bash
backend/.venv/bin/uvicorn xraylarch_web.main:app --host 127.0.0.1 --port 8006
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
- the exact two named screens exist; listeners are exactly `0.0.0.0:3004` and
  `127.0.0.1:8006`; their listener process working directories are the active
  release `frontend/` and `backend/` directories; and
- existing Dr.XAS services remain healthy on `3000`, `3001`, `8000`, `8001`,
  `8002`, and `8003` with their established expected HTTP responses.

The checker only reads process, listener, filesystem, Git, and HTTP state. It
never stops processes or changes host state.

## Explicitly out of scope

No watcher, cron job, boot entry, firewall, reverse proxy, database, Dr.XAS
shared data root, provider secret, global process restart, or service change
is authorized. Do not add any of them as part of this deployment. A push of
the exact branch revision and every host write remain explicit approval gates.
