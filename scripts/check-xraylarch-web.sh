#!/usr/bin/env bash
# Read-only health and identity checks for the active XrayLarch Web release.
set -Eeuo pipefail
umask 077

APP_SLUG="xraylarch-web"
APP_ROOT="/local/apps/${APP_SLUG}"
RELEASES_ROOT="${APP_ROOT}/releases"
CURRENT_LINK="${APP_ROOT}/current"
DATA_ROOT="${APP_ROOT}/data"
BACKEND_HOST="127.0.0.1"
BACKEND_PORT="8006"
FRONTEND_HOST="0.0.0.0"
FRONTEND_PORT="3004"
BACKEND_URL="http://${BACKEND_HOST}:${BACKEND_PORT}"
FRONTEND_SCREEN="xraylarch-web-frontend"
BACKEND_SCREEN="xraylarch-web-backend"

REQUESTED_SHA=""
SCREEN_BIN=""

usage() {
  cat <<'EOF'
Usage:
  check-xraylarch-web.sh check <full-sha>

Runs read-only HTTP, screen, listener, process-working-directory, release, and
sibling-service checks. A full SHA is exactly 40 lowercase hexadecimal
characters. --help performs no host write.
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
    check)
      REQUESTED_SHA="${2:-}"
      [[ $# -eq 2 ]] || die "check requires exactly one full SHA"
      validate_sha "$REQUESTED_SHA"
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

initialize_commands() {
  local command
  for command in awk curl git lsof readlink screen ss grep; do
    require_command "$command"
  done
  SCREEN_BIN=$(command -v screen)
}

release_path() {
  printf '%s/releases/%s\n' "$APP_ROOT" "$1"
}

assert_release_identity() {
  local release="$1"
  [[ "$release" == "${RELEASES_ROOT}/"* ]] || die "release path escapes the app release root"
  [[ -d "$release/.git" ]] || die "release is missing its detached Git checkout"
  [[ -f "$release/.xraylarch-release.sha" ]] || die "release metadata is missing"
  [[ "$(<"$release/.xraylarch-release.sha")" == "$REQUESTED_SHA" ]] || die "release metadata SHA mismatch"
  [[ "$(git -C "$release" rev-parse HEAD)" == "$REQUESTED_SHA" ]] || die "release HEAD mismatch"
}

screen_exists() {
  "$SCREEN_BIN" -ls 2>/dev/null | awk -v target="$1" '$1 ~ ("\\." target "$") { found=1 } END { exit !found }'
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

assert_backend_body() {
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

check_release() {
  local release
  [[ -d "$DATA_ROOT" ]] || die "private mutable data root is absent"
  release=$(release_path "$REQUESTED_SHA")
  [[ -L "$CURRENT_LINK" ]] || die "current release symlink is absent"
  [[ "$(readlink -f "$CURRENT_LINK")" == "$release" ]] || die "current release is not the requested SHA"
  assert_release_identity "$release"
  screen_exists "$FRONTEND_SCREEN" || die "frontend screen is absent"
  screen_exists "$BACKEND_SCREEN" || die "backend screen is absent"
  assert_listener "${FRONTEND_HOST}:${FRONTEND_PORT}"
  assert_listener "${BACKEND_HOST}:${BACKEND_PORT}"
  assert_listener_cwd "$FRONTEND_PORT" "${release}/frontend"
  assert_listener_cwd "$BACKEND_PORT" "${release}/backend"
  http_200 "http://127.0.0.1:${FRONTEND_PORT}/"
  http_200 "${BACKEND_URL}/health"
  assert_backend_body
  http_200 "http://127.0.0.1:${FRONTEND_PORT}/api/backend/health"
  assert_sibling_services_healthy
  printf 'healthy sha=%s release=%s\n' "$REQUESTED_SHA" "$release"
}

main() {
  parse_arguments "$@"
  initialize_commands
  check_release
}

main "$@"
