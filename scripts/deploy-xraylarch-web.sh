#!/usr/bin/env bash
# Host-only deployer for the isolated XrayLarch Web V1 release namespace.
set -Eeuo pipefail
umask 077

APP_SLUG="xraylarch-web"
REPOSITORY="https://github.com/Dr-XAS/xraylarch-web.git"
APPROVED_BRANCH="codex/xraylarch-web-v1"
APP_ROOT="/local/apps/${APP_SLUG}"
RELEASES_ROOT="${APP_ROOT}/releases"
CURRENT_LINK="${APP_ROOT}/current"
DATA_ROOT="${APP_ROOT}/data"
STATE_ROOT="${APP_ROOT}/state"
LOCK_FILE="${STATE_ROOT}/deploy.lock"
BACKEND_HOST="127.0.0.1"
BACKEND_PORT="8006"
FRONTEND_HOST="0.0.0.0"
FRONTEND_PORT="3004"
BACKEND_URL="http://${BACKEND_HOST}:${BACKEND_PORT}"
FRONTEND_SCREEN="xraylarch-web-frontend"
BACKEND_SCREEN="xraylarch-web-backend"

ACTION=""
REQUESTED_SHA=""
CANDIDATE_DATA=""
CLEAN_HOME=""
CONDA_BIN=""
SCREEN_BIN=""
SAFE_PATH=""

usage() {
  cat <<'EOF'
Usage:
  deploy-xraylarch-web.sh deploy <full-sha>
  deploy-xraylarch-web.sh rollback <full-sha>
  deploy-xraylarch-web.sh health <full-sha>

Host-only release control for XrayLarch Web. A full SHA is exactly 40 lowercase
hexadecimal characters. --help performs no host write.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

validate_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "expected a full lowercase 40-character SHA"
}

parse_arguments() {
  case "${1:-}" in
    --help|-h)
      usage
      exit 0
      ;;
    deploy|rollback|health)
      ACTION="$1"
      REQUESTED_SHA="${2:-}"
      [[ $# -eq 2 ]] || die "${ACTION} requires exactly one full SHA"
      validate_sha "$REQUESTED_SHA"
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

initialize_host_paths() {
  install -d -m 0755 "$APP_ROOT" "$RELEASES_ROOT"
  install -d -m 0700 "$DATA_ROOT" "$STATE_ROOT" "${DATA_ROOT}/candidates"
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "another ${APP_SLUG} deployment is already running"
}

initialize_commands() {
  local command
  for command in conda curl flock git lsof readlink screen sha256sum ss awk grep install mv chmod; do
    require_command "$command"
  done
  CONDA_BIN=$(command -v conda)
  SCREEN_BIN=$(command -v screen)
  SAFE_PATH="$(dirname "$CONDA_BIN"):/usr/local/bin:/usr/bin:/bin"
}

prepare_candidate_data() {
  CANDIDATE_DATA="${DATA_ROOT}/candidates/${REQUESTED_SHA}"
  CLEAN_HOME="${CANDIDATE_DATA}/home"
  install -d -m 0700 \
    "$CANDIDATE_DATA" \
    "${CANDIDATE_DATA}/cache/npm" \
    "${CANDIDATE_DATA}/runtime/pycache" \
    "$CLEAN_HOME"
}

run_clean() {
  env -i \
    PATH="$SAFE_PATH" \
    HOME="$CLEAN_HOME" \
    LANG="${LANG:-C.UTF-8}" \
    LC_ALL="${LC_ALL:-C.UTF-8}" \
    XRAYLARCH_DATA_ROOT="$DATA_ROOT" \
    BACKEND_URL="$BACKEND_URL" \
    NEXT_BACKEND_URL="$BACKEND_URL" \
    NPM_CONFIG_CACHE="${CANDIDATE_DATA}/cache/npm" \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPYCACHEPREFIX="${CANDIDATE_DATA}/runtime/pycache" \
    PYTHONUNBUFFERED=1 \
    "$@"
}

release_path() {
  printf '%s/releases/%s\n' "$APP_ROOT" "$1"
}

assert_release_path() {
  [[ "$1" == "${RELEASES_ROOT}/"* ]] || die "release path escapes the app release root"
}

assert_release_identity() {
  local sha="$1"
  local release
  release=$(release_path "$sha")
  [[ -d "$release/.git" ]] || die "release is missing its detached Git checkout: $release"
  [[ -f "$release/.xraylarch-release.sha" ]] || die "release metadata is missing: $release"
  [[ "$(<"$release/.xraylarch-release.sha")" == "$sha" ]] || die "release metadata SHA mismatch: $release"
  [[ "$(git -C "$release" rev-parse HEAD)" == "$sha" ]] || die "release HEAD mismatch: $release"
}

read_current_release() {
  [[ -L "$CURRENT_LINK" ]] || return 1
  local resolved
  resolved=$(readlink -f "$CURRENT_LINK")
  assert_release_path "$resolved"
  [[ -f "$resolved/.xraylarch-release.sha" ]] || die "current target lacks release metadata"
  printf '%s\n' "$resolved"
}

screen_exists() {
  "$SCREEN_BIN" -ls 2>/dev/null | awk -v target="$1" '$1 ~ ("\\." target "$") { found=1 } END { exit !found }'
}

wait_for_screen_absent() {
  local name="$1" attempt
  for attempt in {1..20}; do
    if ! screen_exists "$name"; then
      return 0
    fi
    sleep 1
  done
  die "screen did not exit: $name"
}

stop_owned_screens() {
  local name
  for name in "$FRONTEND_SCREEN" "$BACKEND_SCREEN"; do
    if screen_exists "$name"; then
      "$SCREEN_BIN" -S "$name" -X quit
      wait_for_screen_absent "$name"
    fi
  done
}

quote_command() {
  local quoted
  printf -v quoted '%q ' "$@"
  printf 'exec %s' "$quoted"
}

launch_screen() {
  local name="$1" working_directory="$2"
  shift 2
  screen_exists "$name" && die "screen name collision: $name"
  (
    cd "$working_directory"
    "$SCREEN_BIN" -dmS "$name" bash -c "$(quote_command \
      env -i \
      "PATH=$SAFE_PATH" \
      "HOME=$CLEAN_HOME" \
      "LANG=${LANG:-C.UTF-8}" \
      "LC_ALL=${LC_ALL:-C.UTF-8}" \
      "XRAYLARCH_DATA_ROOT=$DATA_ROOT" \
      "BACKEND_URL=$BACKEND_URL" \
      "NEXT_BACKEND_URL=$BACKEND_URL" \
      "PYTHONPYCACHEPREFIX=${CANDIDATE_DATA}/runtime/pycache" \
      "PYTHONUNBUFFERED=1" \
      "$@")"
  )
}

start_release_screens() {
  local release="$1" sha="$2"
  assert_release_path "$release"
  assert_release_identity "$sha"
  screen_exists "$FRONTEND_SCREEN" && die "frontend screen is already occupied"
  screen_exists "$BACKEND_SCREEN" && die "backend screen is already occupied"
  launch_screen "$BACKEND_SCREEN" "${release}/backend" \
    "${release}/backend/.venv/bin/uvicorn" xraylarch_web.main:app \
    --host "$BACKEND_HOST" --port "$BACKEND_PORT"
  if ! launch_screen "$FRONTEND_SCREEN" "${release}/frontend" \
    "$CONDA_BIN" run --no-capture-output -n drxas-node20 \
    "${release}/frontend/node_modules/.bin/next" start \
    -H "$FRONTEND_HOST" -p "$FRONTEND_PORT"; then
    stop_owned_screens
    return 1
  fi
}

assert_listener() {
  ss -ltnH | awk -v expected="$1" '$4 == expected { found=1 } END { exit !found }' || die "expected listener is absent: $1"
}

listener_pid() {
  local port="$1"
  local -a pids=()
  mapfile -t pids < <(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN)
  [[ ${#pids[@]} -eq 1 ]] || die "expected one listener process on port $port, found ${#pids[@]}"
  printf '%s\n' "${pids[0]}"
}

assert_listener_cwd() {
  local pid cwd
  pid=$(listener_pid "$1")
  cwd=$(readlink -f "/proc/${pid}/cwd")
  [[ "$cwd" == "$2" ]] || die "listener on $1 has cwd $cwd, expected $2"
}

http_200() {
  local code
  code=$(curl --fail --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "$1")
  [[ "$code" == "200" ]] || die "expected HTTP 200 from $1, received $code"
}

backend_health_ok() {
  local body
  body=$(curl --fail --silent --show-error --max-time 10 "$BACKEND_URL/health")
  printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' || die "backend health body does not report status ok"
}

assert_sibling_services_healthy() {
  http_200 "http://127.0.0.1:3000/"
  http_200 "http://127.0.0.1:3001/"
  http_200 "http://127.0.0.1:8000/docs"
  http_200 "http://127.0.0.1:8001/docs"
  local port code
  for port in 8002 8003; do
    code=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}/")
    [[ "$code" == "404" ]] || die "expected existing Dr.XAS sibling on ${port} to return HTTP 404, received $code"
  done
}

verify_release_runtime() {
  local sha="$1" release
  release=$(release_path "$sha")
  assert_release_identity "$sha"
  screen_exists "$FRONTEND_SCREEN" || die "frontend screen is absent"
  screen_exists "$BACKEND_SCREEN" || die "backend screen is absent"
  assert_listener "${FRONTEND_HOST}:${FRONTEND_PORT}"
  assert_listener "${BACKEND_HOST}:${BACKEND_PORT}"
  assert_listener_cwd "$FRONTEND_PORT" "${release}/frontend"
  assert_listener_cwd "$BACKEND_PORT" "${release}/backend"
  http_200 "http://127.0.0.1:${FRONTEND_PORT}/"
  http_200 "${BACKEND_URL}/health"
  backend_health_ok
  http_200 "http://127.0.0.1:${FRONTEND_PORT}/api/backend/health"
  assert_sibling_services_healthy
}

write_current_link() {
  local replacement="${APP_ROOT}/.current.${REQUESTED_SHA}.$$"
  ln -s "$1" "$replacement"
  mv -Tf "$replacement" "$CURRENT_LINK"
}

write_last_successful() {
  local release="$1" temporary="${STATE_ROOT}/.last-successful.${REQUESTED_SHA}.$$"
  {
    printf 'sha=%s\n' "$REQUESTED_SHA"
    printf 'release=%s\n' "$release"
    printf 'activated_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$temporary"
  mv -f "$temporary" "${STATE_ROOT}/last-successful"
}

restore_previous_release() {
  local previous_release="$1" previous_sha="$2"
  stop_owned_screens
  [[ -n "$previous_release" ]] || return 0
  ln -s "$previous_release" "${APP_ROOT}/.restore-current.$$"
  mv -Tf "${APP_ROOT}/.restore-current.$$" "$CURRENT_LINK"
  REQUESTED_SHA="$previous_sha"
  prepare_candidate_data
  start_release_screens "$previous_release" "$previous_sha"
  verify_release_runtime "$previous_sha"
}

activate_release() {
  local target_sha="$1" target_release previous_release="" previous_sha=""
  target_release=$(release_path "$target_sha")
  assert_release_identity "$target_sha"
  if previous_release=$(read_current_release); then
    previous_sha=$(<"${previous_release}/.xraylarch-release.sha")
    verify_release_runtime "$previous_sha"
  else
    screen_exists "$FRONTEND_SCREEN" && die "frontend screen collision without an active release"
    screen_exists "$BACKEND_SCREEN" && die "backend screen collision without an active release"
  fi
  stop_owned_screens
  REQUESTED_SHA="$target_sha"
  prepare_candidate_data
  if ! start_release_screens "$target_release" "$target_sha" || ! verify_release_runtime "$target_sha"; then
    restore_previous_release "$previous_release" "$previous_sha"
    die "candidate activation failed; prior release was restored"
  fi
  if ! write_current_link "$target_release" || ! write_last_successful "$target_release"; then
    restore_previous_release "$previous_release" "$previous_sha"
    die "activation state update failed; prior release was restored"
  fi
  REQUESTED_SHA="$target_sha"
  verify_release_runtime "$target_sha"
  [[ "$(readlink -f "$CURRENT_LINK")" == "$target_release" ]] || die "current link does not resolve to activated release"
}

verify_remote_branch_tip() {
  local remote_ref
  remote_ref=$(run_clean git ls-remote --refs "$REPOSITORY" "refs/heads/${APPROVED_BRANCH}")
  [[ "$remote_ref" == "${REQUESTED_SHA}"$'\t'"refs/heads/${APPROVED_BRANCH}" ]] || die "remote approved branch is not the requested SHA"
}

build_release() {
  local release temporary
  release=$(release_path "$REQUESTED_SHA")
  [[ ! -e "$release" ]] || die "immutable release path already exists: $release"
  temporary=$(mktemp -d "${RELEASES_ROOT}/.${REQUESTED_SHA}.build.XXXXXX")
  trap '[[ -n "${temporary:-}" && -d "$temporary" ]] && rm -rf -- "$temporary"' RETURN
  run_clean git init --quiet "$temporary"
  run_clean git -C "$temporary" remote add origin "$REPOSITORY"
  run_clean git -C "$temporary" fetch --depth=1 origin "refs/heads/${APPROVED_BRANCH}:refs/remotes/origin/${APPROVED_BRANCH}"
  [[ "$(run_clean git -C "$temporary" rev-parse "refs/remotes/origin/${APPROVED_BRANCH}")" == "$REQUESTED_SHA" ]] || die "fetched remote branch changed during build"
  run_clean git -C "$temporary" checkout --quiet --detach "$REQUESTED_SHA"
  [[ "$(run_clean git -C "$temporary" rev-parse HEAD)" == "$REQUESTED_SHA" ]] || die "detached checkout does not match requested SHA"
  run_clean "$CONDA_BIN" run --no-capture-output -n drxas-deploy python -m venv "${temporary}/backend/.venv"
  (
    cd "${temporary}/backend"
    run_clean "${temporary}/backend/.venv/bin/python" -m pip install --requirement requirements.txt
    run_clean "${temporary}/backend/.venv/bin/python" -m pip check
    run_clean "${temporary}/backend/.venv/bin/python" -m pip freeze --all > pip-freeze.txt
  )
  (
    cd "${temporary}/frontend"
    run_clean "$CONDA_BIN" run --no-capture-output -n drxas-node20 npm ci
    run_clean "$CONDA_BIN" run --no-capture-output -n drxas-node20 npm run build
  )
  printf '%s\n' "$REQUESTED_SHA" >"${temporary}/.xraylarch-release.sha"
  {
    printf 'repository=%s\n' "$REPOSITORY"
    printf 'branch=%s\n' "$APPROVED_BRANCH"
    printf 'sha=%s\n' "$REQUESTED_SHA"
    printf 'built_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"${temporary}/.xraylarch-release.manifest"
  sha256sum \
    "${temporary}/backend/requirements.txt" \
    "${temporary}/backend/pip-freeze.txt" \
    "${temporary}/frontend/package-lock.json" \
    >"${temporary}/.xraylarch-integrity.sha256"
  chmod -R a-w "$temporary"
  mv -T "$temporary" "$release"
  trap - RETURN
}

perform_deploy() {
  verify_remote_branch_tip
  build_release
  activate_release "$REQUESTED_SHA"
}

perform_rollback() {
  assert_release_identity "$REQUESTED_SHA"
  activate_release "$REQUESTED_SHA"
}

perform_health() {
  local current
  current=$(read_current_release) || die "current release symlink is absent"
  [[ "$(<"${current}/.xraylarch-release.sha")" == "$REQUESTED_SHA" ]] || die "current release is not the requested SHA"
  verify_release_runtime "$REQUESTED_SHA"
  printf 'healthy sha=%s release=%s\n' "$REQUESTED_SHA" "$current"
}

main() {
  parse_arguments "$@"
  initialize_commands
  case "$ACTION" in
    health) perform_health ;;
    deploy|rollback)
      initialize_host_paths
      prepare_candidate_data
      if [[ "$ACTION" == "deploy" ]]; then
        perform_deploy
      else
        perform_rollback
      fi
      ;;
  esac
}

main "$@"
