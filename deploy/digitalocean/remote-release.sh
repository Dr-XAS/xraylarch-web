#!/usr/bin/env bash
# Installed once at /opt/xraylarch-autodeploy/remote-release.sh by the local installer.
# Input is an exact Git archive, never a checkout or an rsync of uncommitted files.
set -Eeuo pipefail
umask 077

revision=${1:-}
archive_digest=${2:-}
[[ $# == 2 && $revision =~ ^[0-9a-f]{40}$ && $archive_digest =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Usage: remote-release.sh FULL_GIT_SHA ARCHIVE_SHA256\n' >&2
  exit 64
}
# This override also permits isolated filesystem/command-fake regression tests.
root=${LARCH_DEPLOY_ROOT:-/opt}
[[ $root == /* && $root != / ]] || exit 64
state_dir=$root/xraylarch-autodeploy
release=$root/xraylarch-releases/$revision
archive=$root/xraylarch-incoming/$revision.tar.gz
current=$root/xraylarch-current
status_file=$state_dir/$revision.status
candidate_file=$state_dir/$revision.candidate.json
candidate_project=larch-candidate-${revision:0:16}
previous=
backup=
phase=waiting
candidate_started=0
activation_started=0
# A parent shell must not override the per-release .env during rollback.
unset LARCH_RELEASE_TAG XRAYLARCH_GIT_REVISION
install -d -m 0700 "$state_dir"

status() {
  python3 - "$status_file" "$1" "$phase" "$revision" "$2" "$backup" <<'PY'
import datetime, json, os, pathlib, sys
filename, status, phase, revision, message, backup = sys.argv[1:]
data = dict(status=status, phase=phase, revision=revision, message=message,
            backup=backup or None, updated_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
p = pathlib.Path(filename)
tmp = p.with_suffix('.status.tmp')
with tmp.open('w') as stream:
    json.dump(data, stream)
    stream.write('\n')
os.replace(tmp, p)
PY
}
production() {
  docker compose -p xraylarch-beta --env-file "$release/deploy/digitalocean/.env" \
    -f "$release/deploy/digitalocean/compose.yml" "$@"
}
old_production() {
  docker compose -p xraylarch-beta --env-file "$previous/deploy/digitalocean/.env" \
    -f "$previous/deploy/digitalocean/compose.yml" "$@"
}
candidate() {
  docker compose -p "$candidate_project" -f "$candidate_file" "$@"
}
cleanup_candidate() {
  if (( candidate_started )); then
    candidate down --volumes --remove-orphans
    candidate_started=0
  fi
}
set_current() {
  local destination=$1
  ln -s "$destination" "$current.next.$$"
  mv -Tf "$current.next.$$" "$current"
}
failure() {
  local result=$1 reason=$2 rollback_result=0
  trap - ERR INT TERM
  set +e
  printf 'Deployment failed in %s: %s\n' "$phase" "$reason" >&2
  cleanup_candidate
  if (( activation_started )); then
    printf 'Restoring previous production containers: %s\n' "$previous" >&2
    old_production up -d --no-build --wait --wait-timeout 180
    rollback_result=$?
    set_current "$previous" || rollback_result=1
    if (( rollback_result )); then
      reason="$reason; ROLLBACK FAILED: inspect server journal and backup $backup"
    else
      reason="$reason; previous production release restored"
    fi
  fi
  status failed "$reason (exit $result)"
  exit 1
}
trap 'failure $? "command failed on line $LINENO"' ERR
trap 'failure 130 "interrupted"' INT
trap 'failure 143 "terminated"' TERM
status building 'Waiting for exclusive deployment lock'
exec 9>"$state_dir/deploy.lock"
flock -w 3300 9
[[ $(hostname) == larch-web-beta ]] || failure 1 "Unexpected server hostname"
[[ -L $current ]] || failure 1 "Missing current release symlink"
previous=$(readlink -f "$current")
[[ -f $previous/deploy/digitalocean/compose.yml && -f $previous/deploy/digitalocean/.env ]] || failure 1 "Current release configuration missing"

verify_revision() {
  local target=$1
  "$target" exec -T backend python -c \
    'import json,sys,urllib.request; data=json.load(urllib.request.urlopen("http://127.0.0.1:8006/health", timeout=10)); assert data["status"] == "ok" and data.get("git_revision") == sys.argv[1], data' "$revision"
}
if [[ $previous == "$release" ]]; then
  phase=verifying
  verify_revision production
  status succeeded 'This exact commit is already active'
  exit 0
fi

phase=validating
status building 'Validating archive and production configuration'
[[ -f $archive ]] || failure 1 "Source archive missing"
printf '%s  %s\n' "$archive_digest" "$archive" | sha256sum --check --status
install -d -m 0700 "$root/xraylarch-releases" "$root/xraylarch-backups"
# Keep a failed release inspectable, but do not overwrite it with different content.
if [[ -d $release ]]; then
  [[ -f $release/.archive-sha256 && $(cat "$release/.archive-sha256") == "$archive_digest" ]] || failure 1 "Existing release archive identity mismatch"
else
  extraction=$root/xraylarch-releases/.extract-$revision-$$
  mkdir "$extraction"
  python3 - "$archive" "$extraction" <<'PY'
import pathlib, shutil, sys, tarfile
source, target = sys.argv[1:]
with tarfile.open(source, 'r:gz') as archive:
    members = archive.getmembers()
    if sum(member.size for member in members) > 3 * 1024 ** 3:
        raise ValueError('Expanded archive exceeds 3 GiB')
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
            raise ValueError(f'Unsafe archive entry: {member.name}')
        if '.git' in path.parts or any(part == '.env' or part.startswith('.env.') for part in path.parts):
            raise ValueError(f'Archive includes credentials or Git internals: {member.name}')
    for member in members:
        destination = pathlib.Path(target) / member.name
        if member.isdir():
            destination.mkdir(parents=True, exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, destination.open('wb') as output:
                shutil.copyfileobj(source, output)
            destination.chmod(0o755 if member.mode & 0o111 else 0o644)
PY
  printf '%s\n' "$archive_digest" > "$extraction/.archive-sha256"
  mv -T "$extraction" "$release"
fi
# COPY preserves source directory modes. Keep release root private on the host,
# but let the non-root image users traverse the application directories.
python3 - "$release" <<'PYMODE'
import pathlib, sys
for path in pathlib.Path(sys.argv[1]).rglob('*'):
    if path.is_dir():
        path.chmod(0o755)
PYMODE
for task_file in compose.yml Dockerfile.backend Dockerfile.frontend smoke_test.py; do
  [[ -f $release/deploy/digitalocean/$task_file ]] || failure 1 "Required deployment file missing: $task_file"
done
cp "$previous/deploy/digitalocean/.env" "$release/deploy/digitalocean/.env"
python3 - "$release/deploy/digitalocean/.env" "$revision" <<'PY'
import pathlib, re, sys
p, revision = pathlib.Path(sys.argv[1]), sys.argv[2]
lines = [line for line in p.read_text().splitlines()
         if not re.match(r'^\s*(?:export\s+)?(?:LARCH_RELEASE_TAG|XRAYLARCH_GIT_REVISION)\s*=', line)]
lines.extend([f'LARCH_RELEASE_TAG={revision}', f'XRAYLARCH_GIT_REVISION={revision}'])
p.write_text('\n'.join(lines) + '\n')
p.chmod(0o600)
PY
production config --format json > "$state_dir/$revision.compose.json"
python3 - "$state_dir/$revision.compose.json" "$revision" <<'PY'
import json, sys
config = json.load(open(sys.argv[1]))
revision = sys.argv[2]
services = config['services']
assert set(services) == {'backend', 'frontend', 'caddy'}, 'Unexpected production services'
for service in ['backend', 'frontend']:
    assert services[service]['image'] == f'xraylarch-beta-{service}:{revision}'
    assert not services[service].get('ports'), 'Application port must stay private'
    assert str(services[service]['environment']['XRAYLARCH_PUBLIC_MODE']).lower() == 'true'
    assert services[service]['build']['args']['XRAYLARCH_GIT_REVISION'] == revision
assert services['backend']['environment']['XRAYLARCH_GIT_REVISION'] == revision
assert str(services['backend']['environment'].get('XRAYLARCH_SESSION_COOKIE_SECURE', 'true')).lower() == 'true'
assert services['caddy']['environment']['DOMAIN'] == 'larch-web.dr-xas.org'
assert any(v['type'] == 'volume' and v['source'] == 'app_data' and v['target'] == '/data'
           for v in services['backend']['volumes'])
for volume in ['app_data', 'caddy_data', 'caddy_config']:
    assert config['volumes'][volume]['name'] == f'xraylarch-beta_{volume}', 'Persistent volume renamed'
PY

phase=building
status building 'Building exact-commit backend and frontend images while current site stays live'
# Serial builds avoid competing build workloads on the 2 GiB beta server.
production build backend
production build frontend
for service in backend frontend; do
  actual_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "xraylarch-beta-$service:$revision")
  [[ $actual_revision == "$revision" ]] || failure 1 "Image revision mismatch: $service"
done

phase=candidate
status building 'Testing isolated candidate with fresh visitor data'
python3 - "$state_dir/$revision.compose.json" "$candidate_file" <<'PY'
import json, sys
source = json.load(open(sys.argv[1]))
# Preserve runtime limits/settings while excluding build, Caddy, and production volumes.
services = {}
for name in ['backend', 'frontend']:
    original = source['services'][name]
    services[name] = {key: original[key] for key in ['image', 'environment', 'init', 'security_opt', 'logging', 'platform'] if key in original}
    services[name]['restart'] = 'no'
services['backend']['environment']['XRAYLARCH_SESSION_COOKIE_SECURE'] = 'false'
services['backend']['volumes'] = ['candidate_data:/data']
services['frontend']['ports'] = ['127.0.0.1:13004:3000']
services['frontend']['depends_on'] = {'backend': {'condition': 'service_healthy'}}
json.dump({'services': services, 'volumes': {'candidate_data': {}}}, open(sys.argv[2], 'w'))
PY
candidate_started=1
candidate up -d --no-build --wait --wait-timeout 180
verify_revision candidate
timeout 600 python3 "$release/deploy/digitalocean/smoke_test.py" http://127.0.0.1:13004
cleanup_candidate

phase=backup
status building 'Pausing application briefly for a consistent protected data backup'
backend_id=$(old_production ps -q backend)
[[ -n $backend_id ]] || failure 1 "Current backend container missing"
old_image=$(docker inspect --format '{{.Image}}' "$backend_id")
# Capture the real data mount before stopping anything; never silently back up an empty volume.
actual_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$backend_id")
[[ $actual_volume == xraylarch-beta_app_data ]] || failure 1 "Production data volume identity mismatch"
activation_started=1
old_production stop frontend backend
backup=$root/xraylarch-backups/before-${revision:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz
# Favor short downtime over maximum compression; the complete tar is still verified below.
docker run --rm --log-driver none --network none --read-only -v "$actual_volume:/data:ro" \
  --entrypoint python "$old_image" -c \
  'import sys,tarfile; archive=tarfile.open(fileobj=sys.stdout.buffer, mode="w|gz", compresslevel=1); archive.add("/data", arcname="data"); archive.close()' > "$backup"
[[ -s $backup ]] || failure 1 "Data backup is empty"
gzip -t "$backup"

phase=activating
status building 'Starting new production release and checking the public website'
production up -d --no-build --wait --wait-timeout 180
verify_revision production
timeout 600 python3 "$release/deploy/digitalocean/smoke_test.py" https://larch-web.dr-xas.org
set_current "$release"
phase=complete
status succeeded 'Exact commit is live; candidate and public smoke tests passed; previous release and backup retained'
activation_started=0
trap - ERR INT TERM
printf 'Deployed %s; backup %s\n' "$revision" "$backup"
