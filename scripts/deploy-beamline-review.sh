#!/usr/bin/env bash
# Independent preview. Port 3005 on loopback belongs to the Dr.XAS kiosk.
set -Eeuo pipefail
umask 077

APP_ROOT=/local/apps/xraylarch-web-beamline-review
BRANCH=codex/beamline-review-20261010
FRONTEND_HOST=164.54.109.10
FRONTEND_PORT=3005
BACKEND_HOST=127.0.0.1
BACKEND_PORT=8009
NODE_ROOT=/home/beams/HUANG.JEFFREY/miniconda3/envs/drxas-node22
PYTHON=/home/beams/HUANG.JEFFREY/miniconda3/envs/drxas-deploy/bin/python
SAFE_PATH="$NODE_ROOT/bin:/usr/local/bin:/usr/bin:/bin"
STATE_ROOT="$APP_ROOT/state"
DATA_ROOT="$APP_ROOT/data"
LOG_ROOT="$APP_ROOT/logs"
RELEASES_ROOT="$APP_ROOT/releases"
SCREEN_PREFIX=app-xraylarch-web-beamline-review

fail() { printf 'ERROR: %s\n' "$*" >&2; return 1; }
validate_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail 'expected a full 40-character commit SHA'; }
release_path() { printf '%s/%s\n' "$RELEASES_ROOT" "$1"; }

validate_release() {
  local sha="$1" release
  validate_sha "$sha" || return 1
  release=$(release_path "$sha")
  [[ -d "$release/.git" && ! -L "$release" ]] || { fail "missing regular checkout: $release"; return 1; }
  [[ "$(realpath "$release")" == "$release" ]] || { fail 'release path contains a symlink'; return 1; }
  [[ "$(git -C "$release" rev-parse HEAD)" == "$sha" ]] || { fail 'checkout revision differs'; return 1; }
  [[ "$(git -C "$release" rev-parse "refs/heads/$BRANCH")" == "$sha" ]] || { fail 'preview branch differs'; return 1; }
  git -C "$release" diff --quiet && git -C "$release" diff --cached --quiet || { fail 'tracked source files changed'; return 1; }
}

prepare_paths() {
  local path
  for path in "$APP_ROOT" "$STATE_ROOT" "$DATA_ROOT" "$LOG_ROOT" "$DATA_ROOT/home" \
    "$DATA_ROOT/cache/npm" "$DATA_ROOT/runtime/pycache" "$DATA_ROOT/candidates"; do
    [[ ! -L "$path" ]] || { fail "refusing symlink directory: $path"; return 1; }
    install -d -m 0700 "$path"
  done
}

clean_env() {
  env -i PATH="$SAFE_PATH" HOME="$DATA_ROOT/home" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    XRAYLARCH_DATA_ROOT="$DATA_ROOT" XRAYLARCH_GIT_REVISION="$SHA" \
    XRAYLARCH_XRF_WORKERS=2 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
    BACKEND_URL="http://$BACKEND_HOST:$BACKEND_PORT" NEXT_BACKEND_URL="http://$BACKEND_HOST:$BACKEND_PORT" \
    APP_BUILD_SHA="$SHA" NEXT_TELEMETRY_DISABLED=1 NPM_CONFIG_CACHE="$DATA_ROOT/cache/npm" \
    PYTHONPYCACHEPREFIX="$DATA_ROOT/runtime/pycache" PYTHONUNBUFFERED=1 "$@"
}

build_release() {
  local release="$1"
  [[ ! -e "$release/.beamline-review-built" ]] || { fail 'release already built; use start or health'; return 1; }
  "$NODE_ROOT/bin/node" -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)' || { fail 'Node 22 or newer is required'; return 1; }
  [[ -x "$release/backend/.venv/bin/python" ]] || clean_env "$PYTHON" -m venv "$release/backend/.venv"
  # Reuse the constrained release installer and its API/persistence checks.
  (
    local preview_root="$APP_ROOT" preview_sha="$SHA" preview_path="$SAFE_PATH"
    XRAYLARCH_WEB_TEST_MODE=1 source "$release/scripts/deploy-xraylarch-web.sh"
    DATA_ROOT="$preview_root/data"
    SAFE_PATH="$preview_path"
    CLEAN_HOME="$DATA_ROOT/home"
    CANDIDATE_DATA="$DATA_ROOT/candidates"
    FINAL_BACKEND_URL=http://127.0.0.1:8009
    APP_BASE_PATH=''
    REQUESTED_SHA="$preview_sha"
    install -d -m 0700 "$CANDIDATE_DATA/cache/npm" "$CANDIDATE_DATA/runtime/pycache"
    install_release_backend "$release"
    verify_release_backend "$release"
  )
  (
    cd "$release/frontend"
    clean_env "$NODE_ROOT/bin/npm" ci
    clean_env "$NODE_ROOT/bin/npm" run build
  )
  [[ -s "$release/frontend/.next/BUILD_ID" ]] || { fail 'frontend build artifact is missing'; return 1; }
  printf '%s\n' "$SHA" > "$release/.beamline-review-built"
  printf 'branch=%s\nsha=%s\nbuilt_at=%s\n' "$BRANCH" "$SHA" "$(date -u +%FT%TZ)" > "$release/.beamline-review-manifest"
}

require_built() {
  local release="$1"
  [[ -f "$release/.beamline-review-built" && ! -L "$release/.beamline-review-built" ]] && \
    [[ "$(cat "$release/.beamline-review-built")" == "$SHA" ]] && \
    [[ -x "$release/backend/.venv/bin/python" && -s "$release/frontend/.next/BUILD_ID" ]] \
    || { fail 'build marker or runtime artifacts are missing'; return 1; }
}

component_values() {
  case "$1" in
    api) COMPONENT_HOST="$BACKEND_HOST"; COMPONENT_PORT="$BACKEND_PORT"; COMPONENT_DIR=backend ;;
    web) COMPONENT_HOST="$FRONTEND_HOST"; COMPONENT_PORT="$FRONTEND_PORT"; COMPONENT_DIR=frontend ;;
    *) fail 'unknown component'; return 1 ;;
  esac
  COMPONENT_NAME="$SCREEN_PREFIX-$1"
  COMPONENT_RECORD="$STATE_ROOT/$1.record"
}

screen_pid() {
  screen -ls 2>/dev/null | awk -v name="$1" '
    $1 ~ /^[0-9]+\./ { split($1, part, "."); if (substr($1, length(part[1])+2) == name) print part[1] }
  ' || true
}

listener_pid() {
  # Match the address as well as the port. Kiosk's 127.0.0.1:3005 is unrelated.
  local host="$1" port="$2"
  ss -ltnpH "sport = :$port" | awk -v wanted="$host:$port" '
    $4 == wanted { print }
  ' | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p'
}

assert_bind_available() {
  "$PYTHON" - "$1" "$2" <<'PY'
import socket, sys
with socket.socket() as sock:
    sock.bind((sys.argv[1], int(sys.argv[2])))
PY
}

process_start() {
  # Linux /proc field 22; splitting after the final parenthesis handles spaces.
  "$PYTHON" - "$1" <<'PY'
import pathlib, sys
print(pathlib.Path('/proc', sys.argv[1], 'stat').read_text().rsplit(')', 1)[1].split()[19])
PY
}
process_parent() { awk '/^PPid:/ { print $2 }' "/proc/$1/status"; }
process_uid() { awk '/^Uid:/ { print $2 }' "/proc/$1/status"; }
process_cwd() { readlink "/proc/$1/cwd"; }
process_env() { tr '\0' '\n' < "/proc/$1/environ"; }
process_args() { tr '\0' ' ' < "/proc/$1/cmdline"; }

assert_descendant() {
  local child="$1" ancestor="$2" count=0
  while [[ "$child" =~ ^[0-9]+$ && "$child" -gt 1 && "$count" -lt 30 ]]; do
    [[ "$child" != "$ancestor" ]] || return 0
    child=$(process_parent "$child") || return 1
    count=$((count + 1))
  done
  fail 'listener is not a child of the recorded screen'
}

assert_process_identity() {
  local component="$1" release="$2" screen_id="$3" listener_id="$4"
  [[ "$screen_id" =~ ^[0-9]+$ && "$listener_id" =~ ^[0-9]+$ ]] || { fail 'missing or duplicate process IDs'; return 1; }
  [[ "$(process_uid "$screen_id")" == "$(id -u)" && "$(process_uid "$listener_id")" == "$(id -u)" ]] || { fail 'process owner changed'; return 1; }
  assert_descendant "$listener_id" "$screen_id" || return 1
  [[ "$(process_cwd "$listener_id")" == "$release/$COMPONENT_DIR" ]] || { fail 'listener working directory differs'; return 1; }
  process_env "$listener_id" | grep -Fxq "XRAYLARCH_GIT_REVISION=$SHA" || { fail 'listener revision differs'; return 1; }
  process_env "$listener_id" | grep -Fxq "XRAYLARCH_DATA_ROOT=$DATA_ROOT" || { fail 'listener data root differs'; return 1; }
  case "$component" in
    api) [[ "$(process_args "$listener_id")" == "$release/backend/.venv/bin/python -m uvicorn xraylarch_web.main:app --host $BACKEND_HOST --port $BACKEND_PORT " ]] || { fail 'backend command differs'; return 1; } ;;
    web) [[ "$(process_args "$listener_id")" == next-server* ]] || { fail 'frontend command differs'; return 1; } ;;
  esac
}

write_record() {
  local component="$1" release="$2" screen_id listener_id screen_start listener_start
  component_values "$component"
  screen_id=$(screen_pid "$COMPONENT_NAME")
  listener_id=$(listener_pid "$COMPONENT_HOST" "$COMPONENT_PORT")
  assert_process_identity "$component" "$release" "$screen_id" "$listener_id" || return 1
  screen_start=$(process_start "$screen_id") || return 1
  listener_start=$(process_start "$listener_id") || return 1
  [[ "$screen_start" =~ ^[0-9]+$ && "$listener_start" =~ ^[0-9]+$ ]] || return 1
  printf '%s %s %s %s %s\n' "$SHA" "$screen_id" "$screen_start" \
    "$listener_id" "$listener_start" > "$COMPONENT_RECORD.tmp" || return 1
  mv "$COMPONENT_RECORD.tmp" "$COMPONENT_RECORD"
}

verify_record() {
  local component="$1" release="$2" recorded_sha screen_id screen_start listener_id listener_start extra
  component_values "$component"
  [[ -f "$COMPONENT_RECORD" && ! -L "$COMPONENT_RECORD" ]] || { fail 'process record missing or symlinked'; return 1; }
  read -r recorded_sha screen_id screen_start listener_id listener_start extra < "$COMPONENT_RECORD"
  [[ -z "${extra:-}" && "$recorded_sha" == "$SHA" ]] || { fail 'process record revision differs'; return 1; }
  [[ "$(screen_pid "$COMPONENT_NAME")" == "$screen_id" && "$(listener_pid "$COMPONENT_HOST" "$COMPONENT_PORT")" == "$listener_id" ]] || { fail 'screen or listener changed'; return 1; }
  [[ "$(process_start "$screen_id")" == "$screen_start" && "$(process_start "$listener_id")" == "$listener_start" ]] || { fail 'process ID was reused'; return 1; }
  assert_process_identity "$component" "$release" "$screen_id" "$listener_id"
}

wait_http() {
  local url="$1" attempt
  for attempt in $(seq 1 60); do
    [[ "$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)" != 200 ]] || return 0
    sleep 2
  done
  fail "HTTP health did not become ready: $url"
}

health() {
  local release="$1" body
  verify_record api "$release" && verify_record web "$release" || return 1
  body=$(curl --noproxy '*' -fsS --max-time 10 "http://$BACKEND_HOST:$BACKEND_PORT/health") || return 1
  "$PYTHON" -c 'import json,sys; b=json.loads(sys.argv[1]); assert b["status"]=="ok" and b["git_revision"]==sys.argv[2]' "$body" "$SHA" || return 1
  # The browser proxy intentionally exposes status only, without the revision.
  body=$(curl --noproxy '*' -fsS --max-time 10 "http://$FRONTEND_HOST:$FRONTEND_PORT/api/backend/health") || return 1
  "$PYTHON" -c 'import json,sys; assert json.loads(sys.argv[1])["status"]=="ok"' "$body" || return 1
  curl --noproxy '*' -fsS --max-time 20 "http://$FRONTEND_HOST:$FRONTEND_PORT/" | "$PYTHON" -c '
import sys
from html.parser import HTMLParser
class BuildParser(HTMLParser):
    revisions = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "data-build-sha" in attrs:
            self.revisions.append(attrs["data-build-sha"])
parser = BuildParser()
parser.feed(sys.stdin.read())
assert parser.revisions and set(parser.revisions) == {sys.argv[1]}, "frontend build revision differs"
' "$SHA" || return 1
  printf 'healthy branch=%s sha=%s url=http://drxas.xray.aps.anl.gov:%s/\n' "$BRANCH" "$SHA" "$FRONTEND_PORT"
}

launch_component() {
  local component="$1" release="$2" attempt
  local -a command
  component_values "$component"
  [[ -z "$(screen_pid "$COMPONENT_NAME")" && ! -e "$COMPONENT_RECORD" && ! -L "$COMPONENT_RECORD" ]] || { fail 'screen or record already exists'; return 1; }
  assert_bind_available "$COMPONENT_HOST" "$COMPONENT_PORT" || return 1
  if [[ "$component" == api ]]; then
    command=("$release/backend/.venv/bin/python" -m uvicorn xraylarch_web.main:app --host "$COMPONENT_HOST" --port "$COMPONENT_PORT")
  else
    command=("$NODE_ROOT/bin/node" "$release/frontend/node_modules/next/dist/bin/next" start -H "$COMPONENT_HOST" -p "$COMPONENT_PORT")
  fi
  (
    cd "$release/$COMPONENT_DIR" || exit 1
    # Detached children must not inherit and retain the deployment lock.
    exec 9>&-
    clean_env screen -L -Logfile "$LOG_ROOT/$component.log" -dmS "$COMPONENT_NAME" "${command[@]}"
  ) || return 1
  # Record only listeners that pass ancestry, owner, cwd, and release checks.
  for attempt in $(seq 1 60); do
    if [[ -n "$(listener_pid "$COMPONENT_HOST" "$COMPONENT_PORT")" ]]; then
      write_record "$component" "$release"
      return $?
    fi
    sleep 2
  done
  fail "component failed to listen; inspect $LOG_ROOT/$component.log and screen $COMPONENT_NAME"
}

stop_component() {
  local component="$1" release="$2" recorded_sha screen_id screen_start listener_id listener_start attempt
  verify_record "$component" "$release" || return 1
  read -r recorded_sha screen_id screen_start listener_id listener_start < "$COMPONENT_RECORD"
  screen -S "$screen_id.$COMPONENT_NAME" -X quit || return 1
  for attempt in $(seq 1 30); do
    if [[ -z "$(screen_pid "$COMPONENT_NAME")" && -z "$(listener_pid "$COMPONENT_HOST" "$COMPONENT_PORT")" ]]; then
      rm "$COMPONENT_RECORD" || return 1
      return 0
    fi
    sleep 1
  done
  fail 'recorded component did not stop'
}

discard_stopped_records() {
  local component recorded_sha screen_id screen_start listener_id listener_start extra
  # A reboot leaves records behind. Remove them only after checking both slots.
  for component in api web; do
    component_values "$component"
    [[ -z "$(screen_pid "$COMPONENT_NAME")" ]] || { fail 'preview screen still exists'; return 1; }
    assert_bind_available "$COMPONENT_HOST" "$COMPONENT_PORT" || return 1
    if [[ -e "$COMPONENT_RECORD" || -L "$COMPONENT_RECORD" ]]; then
      [[ -f "$COMPONENT_RECORD" && ! -L "$COMPONENT_RECORD" ]] || { fail 'invalid process record'; return 1; }
      read -r recorded_sha screen_id screen_start listener_id listener_start extra < "$COMPONENT_RECORD"
      [[ "$recorded_sha" == "$SHA" && -z "${extra:-}" && "$screen_id" =~ ^[0-9]+$ && "$listener_id" =~ ^[0-9]+$ ]] || { fail 'stale record revision or IDs differ'; return 1; }
      [[ "$(process_start "$screen_id" 2>/dev/null || true)" != "$screen_start" && \
        "$(process_start "$listener_id" 2>/dev/null || true)" != "$listener_start" ]] || { fail 'recorded process is still alive'; return 1; }
    fi
  done
  for component in api web; do
    component_values "$component"
    [[ ! -f "$COMPONENT_RECORD" ]] || rm "$COMPONENT_RECORD"
  done
}

cleanup_failed_start() {
  local release="$1" component
  for component in web api; do
    component_values "$component"
    if [[ -f "$COMPONENT_RECORD" && ! -L "$COMPONENT_RECORD" ]]; then
      # The start preflight established that neither record existed before launch.
      stop_component "$component" "$release" || printf 'Cleanup left an unverified %s process for inspection.\n' "$component" >&2
    fi
  done
}

prepare_current_link() {
  if [[ -e "$STATE_ROOT/current.next" || -L "$STATE_ROOT/current.next" ]]; then
    [[ -L "$STATE_ROOT/current.next" && "$(readlink "$STATE_ROOT/current.next")" == "$1" ]] \
      || { fail 'unexpected pending current link'; return 1; }
    rm "$STATE_ROOT/current.next" || return 1
  fi
  [[ ! -e "$APP_ROOT/current" || -L "$APP_ROOT/current" ]] || { fail 'current is not a symlink'; return 1; }
}

start_pair() {
  local release="$1" component
  prepare_current_link "$release" || return 1
  discard_stopped_records || return 1
  # Check both addresses and names before starting either component.
  for component in api web; do
    component_values "$component"
    [[ -z "$(screen_pid "$COMPONENT_NAME")" && ! -e "$COMPONENT_RECORD" && ! -L "$COMPONENT_RECORD" ]] || { fail 'preview process state exists; use health or restart'; return 1; }
    assert_bind_available "$COMPONENT_HOST" "$COMPONENT_PORT" || return 1
  done
  launch_component api "$release" || { cleanup_failed_start "$release"; return 1; }
  wait_http "http://$BACKEND_HOST:$BACKEND_PORT/health" || { cleanup_failed_start "$release"; return 1; }
  launch_component web "$release" || { cleanup_failed_start "$release"; return 1; }
  wait_http "http://$FRONTEND_HOST:$FRONTEND_PORT/" || { cleanup_failed_start "$release"; return 1; }
  health "$release" || { cleanup_failed_start "$release"; return 1; }
  ln -s "$release" "$STATE_ROOT/current.next" || { cleanup_failed_start "$release"; return 1; }
  mv -Tf "$STATE_ROOT/current.next" "$APP_ROOT/current" || { cleanup_failed_start "$release"; return 1; }
}

main() {
  [[ $# == 2 ]] || { fail 'usage: deploy-beamline-review.sh build|start|health|stop|restart <full-sha>'; return 2; }
  local action="$1" release
  SHA="$2"
  case "$action" in build|start|health|stop|restart) ;; *) fail 'unknown action'; return 2 ;; esac
  validate_release "$SHA"
  release=$(release_path "$SHA")
  if [[ "$action" == health ]]; then require_built "$release"; health "$release"; return; fi
  prepare_paths
  exec 9>"$STATE_ROOT/deploy.lock"
  flock -n 9 || { fail 'another preview operation is running'; return 1; }
  if [[ "$action" == build ]]; then build_release "$release"; return; fi
  require_built "$release"
  case "$action" in
    start) start_pair "$release" ;;
    stop|restart)
      # Verify both before stopping either. A collision leaves the pair untouched.
      verify_record api "$release" && verify_record web "$release" || return 1
      stop_component web "$release"
      stop_component api "$release"
      [[ "$action" != restart ]] || start_pair "$release"
      ;;
  esac
}

if [[ "${BEAMLINE_REVIEW_TEST_MODE:-0}" != 1 ]]; then main "$@"; fi
