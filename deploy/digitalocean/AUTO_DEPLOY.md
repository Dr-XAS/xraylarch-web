# Local internal-testing deployment

Local Git hooks package each committed `internal_testing` revision into a private upload queue. The Mac checks that queue every 60 seconds while the user is logged in and uploads it directly over SSH to the existing DigitalOcean Droplet. There is no GitHub push, remote Git fetch, GitHub Actions workflow, or additional hosting service.

Only committed contents of `refs/heads/internal_testing` are packaged. Unsaved and uncommitted edits, commits on other branches, local dependencies, environment secrets, and application data are excluded. If several commits arrive before a deployment starts, the latest commit is deployed. If a deployment is already running, it finishes before the latest queued commit is considered.

The working copy for this branch is:

```text
/Users/juanjuanhuang/.codex/worktrees/master-public-beta/xraylarch-web
```

Create commits there as usual; packaging adds a few seconds to a commit. If a Git tool explicitly bypasses hooks, queue the latest commit manually with `python3 deploy/digitalocean/local_autodeploy.py enqueue`. To inspect deployment state from that directory:

```sh
python3 deploy/digitalocean/local_autodeploy.py status
```

`deployed_sha` identifies the last confirmed live commit. `pending_sha` means a server job is still running. `failed_sha` indicates a failed build or deployment; inspect the local message and server journal. Deployment status is refreshed on the next worker check, so it may lag the server by one minute.

## Release checks and recovery

Each release uses its full Git commit SHA for the archive, source directory, image tags, and backend version. The server:

1. Checks the uploaded archive checksum and production configuration.
2. Builds the backend and frontend sequentially while the current site stays running.
3. Starts a private candidate with disposable data, checks its revision, and runs the full visitor-isolation, spectrum, export, and Artemis smoke test.
4. Stops the old application briefly to make a consistent protected data backup.
5. Starts the new application with the existing data/certificate volumes and checks the public HTTPS website.
6. Updates `/opt/xraylarch-current` only after the checks succeed.

A failed build or candidate check leaves the existing release running. An activation failure triggers restoration of the previous containers. Backups and prior releases are retained for manual recovery; rollback does not automatically rewind user data. Incompatible data-format migrations require their own migration and restore plan.

A failed commit is not retried endlessly. Correct the cause and commit again, or explicitly retry the same commit:

```sh
python3 deploy/digitalocean/local_autodeploy.py retry
```

## Pause and resume

```sh
python3 deploy/digitalocean/local_autodeploy.py disable
python3 deploy/digitalocean/local_autodeploy.py enable
```

Disabling prevents new deployments; a job already submitted to the server continues. Commits made while disabled are retained, and the latest is considered when enabled again.

The Mac must be awake, logged in, and online to upload a new release. After sleep, logout, a reboot, or a network interruption, the worker resumes checking when the login session and connection return. Once submitted, the server build runs independently of the Mac. SSH/network errors retry with a delay of 1–15 minutes. Deployment takes longer than the one-minute detection interval because production images and scientific checks run on the server.

## Installation and maintenance

Public bug reports are stored privately in the existing data volume and cannot
be read through an API. Project attachments resolve only inside the reporting
visitor's session. Anonymous submissions stop when the report library would
exceed 500 MiB or leave less than 1 GiB free on its filesystem; a cross-process
lock serializes capacity checks and writes. Reports and project data are never
automatically deleted. Slack notification remains off unless separately configured.

The reviewed local controller is installed at `~/Library/Application Support/LarchWebDeploy/`. That directory holds machine-specific configuration, committed source archives, logs, and status; none are committed. Git `post-commit`, `post-merge`, and `post-rewrite` hooks package revisions in the Git client's user context. The background worker reads only the queue and never opens the Desktop repository, avoiding macOS protected-folder access restrictions. Existing unrelated hooks are preserved by refusing to overwrite them. The SSH private key stays at `~/.ssh/id_ed25519_larch_web_do`. The LaunchAgent is `~/Library/LaunchAgents/org.dr-xas.larch-public-deploy.plist`.

The server runner is installed separately at `/opt/xraylarch-autodeploy/remote-release.sh`. These installed control scripts are snapshots, so editing them in the checkout does not execute uncommitted deployment code. Changes to the controller or remote runner require testing and reinstalling the corresponding script. Ordinary application commits need no reinstall.

To reinstall the local controller from this worktree after reviewing its changes:

```sh
python3 deploy/digitalocean/local_autodeploy.py install
```

Server logs for a commit:

```sh
ssh -i ~/.ssh/id_ed25519_larch_web_do -o IdentitiesOnly=yes root@161.35.110.95 \
  'journalctl -u larch-deploy-FULL_COMMIT_SHA.service --no-pager'
```

Each job also writes `/opt/xraylarch-autodeploy/FULL_COMMIT_SHA.status` as JSON. Server jobs are serialized and time out after one hour, with additional time for rollback. Source archives, old images, and protected backups currently remain on the server; check disk usage periodically before removing obsolete releases.

`source-manifest.json` is a frozen checksum record of the initial `master@f99be876` plus isolation deployment, saved in local commit `db48c66df`. It is historical evidence, not a checksum of later commits. Automatic releases identify their complete committed contents by Git SHA and the uploaded archive checksum instead.
