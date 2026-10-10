# Beamline review preview on Dr.XAS

This preview runs the committed `codex/beamline-review-20261010` branch at
`http://drxas.xray.aps.anl.gov:3005/`. It has its own release checkout, Python
environment, data, caches, process records, and logs under
`/local/apps/xraylarch-web-beamline-review`.

| Component | Listener | Screen |
| --- | --- | --- |
| Frontend | `164.54.109.10:3005` | `app-xraylarch-web-beamline-review-web` |
| Backend | `127.0.0.1:8009` | `app-xraylarch-web-beamline-review-api` |

Bind the frontend to that exact external IPv4 address. The Dr.XAS kiosk already
uses `127.0.0.1:3005`; binding to `0.0.0.0:3005` would conflict with it. A request
to `localhost:3005` on the workstation reaches the kiosk. Use the hostname or
`164.54.109.10:3005` to reach this preview.

The script does not change the existing public instance on `3004/8007`, the
mounted instance on `3006/8006`, or any Dr.XAS services. It does not install a
watcher or cron entry. GNU screen keeps the preview alive after SSH logout;
after a workstation reboot, run `start` again with the same revision. A start
removes old process records only after confirming that their processes are gone
and both preview addresses are available.

## Transfer a committed branch

Run these commands from the branch checkout on the development machine after
committing and testing the changes. A Git bundle preserves the branch and
version tags without publishing it to GitHub.

```bash
preview_sha=$(git rev-parse HEAD)
preview_bundle="/tmp/xraylarch-beamline-review-${preview_sha}.bundle"
git bundle create "$preview_bundle" codex/beamline-review-20261010 --tags
git bundle verify "$preview_bundle"
scp "$preview_bundle" "drxas:$preview_bundle"
ssh drxas bash -s -- "$preview_sha" "$preview_bundle" <<'REMOTE'
set -Eeuo pipefail
preview_root=/local/apps/xraylarch-web-beamline-review
preview_release="$preview_root/releases/$1"
install -d -m 0700 "$preview_root" "$preview_root/releases"
test ! -e "$preview_release"
git clone --branch codex/beamline-review-20261010 "$2" "$preview_release"
git -C "$preview_release" checkout --detach "$1"
test "$(git -C "$preview_release" rev-parse HEAD)" = "$1"
REMOTE
```

## Build and start

The build uses the existing Python 3.12 interpreter in `drxas-deploy` to create a
new release-local `backend/.venv`. It runs the shared constrained dependency
installer and API/persistence verification, followed by `npm ci` and a production
build using Node 22 from `drxas-node22`. Neither shared conda environment changes.
Keep the checkout at its final path before creating the virtual environment.

```bash
ssh drxas bash -s -- "$preview_sha" <<'REMOTE'
set -Eeuo pipefail
preview_release="/local/apps/xraylarch-web-beamline-review/releases/$1"
bash "$preview_release/tests/test_deploy_beamline_review.sh"
bash "$preview_release/scripts/deploy-beamline-review.sh" build "$1"
bash "$preview_release/scripts/deploy-beamline-review.sh" start "$1"
bash "$preview_release/scripts/deploy-beamline-review.sh" health "$1"
REMOTE
curl --fail --noproxy '*' http://drxas.xray.aps.anl.gov:3005/api/backend/health
```

The health command checks both recorded process identities, the frontend's
rendered build revision, the direct backend's exact revision, and proxy status.
The proxy intentionally omits the backend revision from its public response.
Run the scientific tests and browser acceptance checks separately before
delivering the preview. Confirm the existing `3000`, `3001`, `3004`, mounted
`3006/advanced-xas/app`, and kiosk `3002` endpoints still return HTTP 200.

## Operate the preview

On Dr.XAS, set the immutable revision and use the script from that release:

```bash
preview_sha=$(git -C /local/apps/xraylarch-web-beamline-review/current rev-parse HEAD)
preview_script="/local/apps/xraylarch-web-beamline-review/releases/$preview_sha/scripts/deploy-beamline-review.sh"
bash "$preview_script" health "$preview_sha"
bash "$preview_script" restart "$preview_sha"
bash "$preview_script" stop "$preview_sha"
bash "$preview_script" start "$preview_sha"
```

`restart` and `stop` verify both live components before stopping either.
Mismatched process IDs, start times, owners, ancestry, working directories,
revision variables, or data roots cause the operation to stop with an error.
They never kill a process merely because it occupies port 3005. A failed start
cleans up the components it successfully recorded, after rechecking ownership.
If a component fails before its identity can be recorded, inspect `logs/api.log`,
`logs/web.log`, and the named screens before attempting recovery. An unrecorded
or ambiguous process needs operator inspection.

Application state is under `data/`, separate from every existing deployment.
The clean environment includes no provider, integration, email, or Slack
credentials. Bundled structure search and uploaded CIF files work without
credentials; Materials Project search requires a separately authorized backend
configuration. XRF uses two detector workers and one native numerical thread
per process in this preview.

To replace the preview with a different committed revision, build the new
release first, stop the current revision using its own script, and start the
new one. The previous checkout and data remain available for a manual rollback.
No process follows future branch commits automatically.
