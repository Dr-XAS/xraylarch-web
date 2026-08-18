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
PROCESS_RECORD_ROOT="${STATE_ROOT}/processes"
LOCK_FILE="${STATE_ROOT}/deploy.lock"
FINAL_BACKEND_HOST="127.0.0.1"
FINAL_BACKEND_PORT="8006"
FINAL_FRONTEND_HOST="0.0.0.0"
FINAL_FRONTEND_PORT="3004"
STAGE_BACKEND_HOST="127.0.0.1"
STAGE_BACKEND_PORT="18006"
STAGE_FRONTEND_HOST="127.0.0.1"
STAGE_FRONTEND_PORT="13004"
FINAL_BACKEND_URL="http://${FINAL_BACKEND_HOST}:${FINAL_BACKEND_PORT}"
STAGE_BACKEND_URL="http://${STAGE_BACKEND_HOST}:${STAGE_BACKEND_PORT}"
FRONTEND_SCREEN="xraylarch-web-frontend"
BACKEND_SCREEN="xraylarch-web-backend"
STAGE_FRONTEND_SCREEN="xraylarch-web-candidate-frontend"
STAGE_BACKEND_SCREEN="xraylarch-web-candidate-backend"

ACTION=""
REQUESTED_SHA=""
CANDIDATE_DATA=""
CLEAN_HOME=""
CONDA_BIN=""
SCREEN_BIN=""
SAFE_PATH=""
CURRENT_RELEASE=""
CURRENT_SHA=""
ACTIVATION_IN_PROGRESS=0
ACTIVATION_PREVIOUS_STOPPED=0
ACTIVATION_PREVIOUS_FRONTEND_STOPPED=0
ACTIVATION_PREVIOUS_BACKEND_STOPPED=0
ACTIVATION_PREVIOUS_RELEASE=""
ACTIVATION_PREVIOUS_SHA=""
ACTIVATION_TARGET_RELEASE=""
ACTIVATION_STATE_SNAPSHOT=""
ACTIVATION_STATE_WAS_PRESENT=0
ACTIVATION_STATE_WRITTEN=0

usage() {
  cat <<'EOF'
Usage:
  deploy-xraylarch-web.sh deploy <full-sha>
  deploy-xraylarch-web.sh rollback <full-sha>
  deploy-xraylarch-web.sh health <full-sha>
  deploy-xraylarch-web.sh migrate <full-sha>

Host-only release control for XrayLarch Web. A full SHA is exactly 40 lowercase
hexadecimal characters. --help performs no host write.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || { fail "required command is unavailable: $1"; return 1; }
}

validate_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || { fail "expected a full lowercase 40-character SHA"; return 1; }
}

parse_arguments() {
  case "${1:-}" in
    --help|-h) usage; exit 0 ;;
    deploy|rollback|health|migrate)
      ACTION="$1"
      REQUESTED_SHA="${2:-}"
      [[ $# -eq 2 ]] || { fail "${ACTION} requires exactly one full SHA"; return 1; }
      validate_sha "$REQUESTED_SHA" || return 1
      ;;
    *) usage >&2; return 2 ;;
  esac
}

initialize_host_paths() {
  install -d -m 0755 "$APP_ROOT" "$RELEASES_ROOT" || return 1
  install -d -m 0700 "$DATA_ROOT" "$STATE_ROOT" "$PROCESS_RECORD_ROOT" "${DATA_ROOT}/candidates" || return 1
  exec 9>"$LOCK_FILE"
  flock -n 9 || { fail "another ${APP_SLUG} deployment is already running"; return 1; }
}

initialize_commands() {
  local command
  for command in base64 conda curl flock git lsof readlink screen sha256sum ss awk grep install mv chmod cp ps tr; do
    require_command "$command" || return 1
  done
  CONDA_BIN=$(type -P conda) || { fail "conda must resolve to an executable"; return 1; }
  SCREEN_BIN=$(type -P screen) || { fail "screen must resolve to an executable"; return 1; }
  SAFE_PATH="$(dirname "$CONDA_BIN"):/usr/local/bin:/usr/bin:/bin"
}

prepare_candidate_data() {
  validate_sha "$REQUESTED_SHA" || return 1
  CANDIDATE_DATA="${DATA_ROOT}/candidates/${REQUESTED_SHA}"
  CLEAN_HOME="${CANDIDATE_DATA}/home"
  install -d -m 0700 "$CANDIDATE_DATA" "${CANDIDATE_DATA}/cache/npm" \
    "${CANDIDATE_DATA}/runtime/pycache" "$CLEAN_HOME"
}

run_clean() {
  env -i PATH="$SAFE_PATH" HOME="$CLEAN_HOME" LANG="${LANG:-C.UTF-8}" \
    LC_ALL="${LC_ALL:-C.UTF-8}" XRAYLARCH_DATA_ROOT="$DATA_ROOT" \
    BACKEND_URL="$FINAL_BACKEND_URL" NEXT_BACKEND_URL="$FINAL_BACKEND_URL" \
    NPM_CONFIG_CACHE="${CANDIDATE_DATA}/cache/npm" PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPYCACHEPREFIX="${CANDIDATE_DATA}/runtime/pycache" PYTHONUNBUFFERED=1 "$@"
}

release_path() {
  validate_sha "$1" || return 1
  printf '%s/%s\n' "$RELEASES_ROOT" "$1"
}

canonical_release_for_sha() {
  local sha="$1" release resolved
  validate_sha "$sha" || return 1
  release=$(release_path "$sha") || return 1
  [[ -d "$release" && ! -L "$release" ]] || { fail "release is absent or symlinked: $release"; return 1; }
  resolved=$(readlink -f -- "$release") || return 1
  [[ "$resolved" == "$release" && "$resolved" == "${RELEASES_ROOT}/"* ]] || { fail "release target is not canonical: $release"; return 1; }
  printf '%s\n' "$resolved"
}

release_sha_from_path() {
  local release="$1" sha
  [[ "$release" == "${RELEASES_ROOT}/"* && -d "$release" && ! -L "$release" ]] || { fail "release path is not canonical"; return 1; }
  [[ -f "$release/.xraylarch-release.sha" && ! -L "$release/.xraylarch-release.sha" ]] || { fail "release metadata is absent or symlinked"; return 1; }
  sha=$(<"$release/.xraylarch-release.sha")
  validate_sha "$sha" || return 1
  [[ "$release" == "$(release_path "$sha")" ]] || { fail "release metadata does not name its path"; return 1; }
  printf '%s\n' "$sha"
}

assert_release_identity() {
  local sha="$1" release metadata_sha
  validate_sha "$sha" || return 1
  release=$(canonical_release_for_sha "$sha") || return 1
  metadata_sha=$(release_sha_from_path "$release") || return 1
  [[ "$metadata_sha" == "$sha" ]] || { fail "release metadata SHA mismatch"; return 1; }
  [[ -d "$release/.git" && ! -L "$release/.git" ]] || { fail "release is missing detached Git metadata"; return 1; }
  [[ "$(git -C "$release" rev-parse HEAD)" == "$sha" ]] || { fail "release HEAD mismatch"; return 1; }
}

read_current_release() {
  local resolved sha expected
  CURRENT_RELEASE=""
  CURRENT_SHA=""
  [[ -L "$CURRENT_LINK" ]] || return 1
  resolved=$(readlink -f -- "$CURRENT_LINK") || return 1
  sha=$(release_sha_from_path "$resolved") || return 1
  expected=$(canonical_release_for_sha "$sha") || return 1
  [[ "$resolved" == "$expected" ]] || { fail "current target is not its canonical release"; return 1; }
  assert_release_identity "$sha" || return 1
  CURRENT_RELEASE="$resolved"
  CURRENT_SHA="$sha"
}

screen_sessions_for_name() {
  "$SCREEN_BIN" -ls 2>/dev/null | awk -v target="$1" '$1 ~ ("^[0-9]+\\." target "$") { print $1 }'
}

exact_screen_session() {
  local name="$1"
  local -a sessions=()
  local session
  while IFS= read -r session; do [[ -z "$session" ]] || sessions+=("$session"); done < <(screen_sessions_for_name "$name")
  [[ ${#sessions[@]} -eq 1 ]] || { fail "expected exactly one screen session named $name, found ${#sessions[@]}"; return 1; }
  printf '%s\n' "${sessions[0]}"
}

screen_pid_from_session() {
  [[ "$1" =~ ^([0-9]+)\. ]] || { fail "screen session has no PID prefix: $1"; return 1; }
  printf '%s\n' "${BASH_REMATCH[1]}"
}

listener_pid() {
  local port="$1"
  local -a pids=()
  local pid
  while IFS= read -r pid; do [[ -z "$pid" ]] || pids+=("$pid"); done < <(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [[ ${#pids[@]} -eq 1 ]] || { fail "expected exactly one listener on port $port, found ${#pids[@]}"; return 1; }
  printf '%s\n' "${pids[0]}"
}

assert_port_unbound() {
  local port="$1" pids
  pids=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [[ -z "$pids" ]] || { fail "listener collision on port $port"; return 1; }
  if ss -ltnH | awk -v suffix=":${port}" '$4 ~ (suffix "$" ) { found=1 } END { exit found ? 0 : 1 }'; then
    fail "listener collision on port $port"
    return 1
  fi
}

assert_listener_address() {
  ss -ltnH | awk -v expected="$1" '$4 == expected { found=1 } END { exit !found }' || { fail "expected listener is absent: $1"; return 1; }
}

process_cwd() {
  [[ -d "/proc/$1" ]] || { fail "recorded process is absent: $1"; return 1; }
  readlink -f "/proc/$1/cwd"
}

process_executable() {
  [[ -d "/proc/$1" ]] || { fail "recorded process is absent: $1"; return 1; }
  readlink -f "/proc/$1/exe"
}

process_owner() {
  local owner
  owner=$(ps -o user= -p "$1" 2>/dev/null | tr -d '[:space:]') || return 1
  [[ -n "$owner" ]] || { fail "process owner is unavailable: $1"; return 1; }
  printf '%s\n' "$owner"
}

process_cmdline_b64() {
  [[ -r "/proc/$1/cmdline" ]] || { fail "process command line is unavailable: $1"; return 1; }
  base64 <"/proc/$1/cmdline" | tr -d '\n'
}

read_process_argv() {
  local pid="$1" argument
  PROCESS_ARGV=()
  while IFS= read -r -d '' argument; do PROCESS_ARGV+=("$argument"); done <"/proc/${pid}/cmdline"
  [[ ${#PROCESS_ARGV[@]} -gt 0 ]] || { fail "process command line is empty: $pid"; return 1; }
}

pid_cwd_matches() {
  local pid="$1" expected="$2" cwd
  cwd=$(process_cwd "$pid") || return 1
  [[ "$cwd" == "$expected" ]] || { fail "process $pid has cwd $cwd, expected $expected"; return 1; }
}

pid_is_descendant_of() {
  local pid="$1" ancestor="$2" parent attempts=0
  while [[ "$pid" != "$ancestor" && "$pid" != 1 && $attempts -lt 32 ]]; do
    parent=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]') || return 1
    [[ "$parent" =~ ^[0-9]+$ ]] || return 1
    pid="$parent"
    ((attempts += 1))
  done
  [[ "$pid" == "$ancestor" ]] || { fail "listener is not a descendant of recorded screen"; return 1; }
}

component_command_matches() {
  local pid="$1" release="$2" kind="$3" host="$4" port="$5"
  local executable index frontend_title_pattern='^next-server \(v[0-9]+\.[0-9]+\.[0-9]+[^)]*\)$'
  local -a expected=()
  read_process_argv "$pid" || return 1
  case "$kind" in
    backend)
      expected=("${release}/backend/.venv/bin/python" -m uvicorn xraylarch_web.main:app --host "$host" --port "$port")
      [[ ${#PROCESS_ARGV[@]} -eq ${#expected[@]} ]] || { fail "backend listener argv length is unexpected"; return 1; }
      for index in "${!expected[@]}"; do
        [[ "${PROCESS_ARGV[$index]}" == "${expected[$index]}" ]] || { fail "backend listener argv differs at position $index"; return 1; }
      done
      ;;
    frontend)
      executable=$(process_executable "$pid") || return 1
      [[ "${executable##*/}" == node ]] || { fail "frontend listener executable is not node"; return 1; }
      [[ ${#PROCESS_ARGV[@]} -eq 1 && "${PROCESS_ARGV[0]}" =~ $frontend_title_pattern ]] || { fail "frontend listener title is not the Next server title"; return 1; }
      ;;
    *) fail "unknown component kind: $kind" ;;
  esac
}

component_record_path() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || { fail "invalid component record name"; return 1; }
  printf '%s/%s.record\n' "$PROCESS_RECORD_ROOT" "$1"
}

assert_component_record_available() {
  local record
  [[ -d "$PROCESS_RECORD_ROOT" && ! -L "$PROCESS_RECORD_ROOT" ]] || { fail "process record root is absent or symlinked"; return 1; }
  record=$(component_record_path "$1") || return 1
  [[ ! -e "$record" && ! -L "$record" ]] || { fail "component process record collision: $record"; return 1; }
}

set_component_record() {
  local prefix="$1" name="$2" session="$3" screen_pid="$4" listener_pid_value="$5" port="$6" release="$7" kind="$8" host="$9"
  printf -v "${prefix}_NAME" '%s' "$name"
  printf -v "${prefix}_SESSION" '%s' "$session"
  printf -v "${prefix}_SCREEN_PID" '%s' "$screen_pid"
  printf -v "${prefix}_LISTENER_PID" '%s' "$listener_pid_value"
  printf -v "${prefix}_PORT" '%s' "$port"
  printf -v "${prefix}_RELEASE" '%s' "$release"
  printf -v "${prefix}_KIND" '%s' "$kind"
  printf -v "${prefix}_HOST" '%s' "$host"
  printf -v "${prefix}_RECORD_FILE" '%s' "$(component_record_path "$name")"
}

observe_component_record() {
  local prefix="$1" listener_pid_value screen_pid release release_sha
  listener_pid_value=$(component_field "$prefix" LISTENER_PID)
  screen_pid=$(component_field "$prefix" SCREEN_PID)
  release=$(component_field "$prefix" RELEASE)
  release_sha=$(release_sha_from_path "$release") || return 1
  printf -v "${prefix}_CWD" '%s' "$(process_cwd "$listener_pid_value")" || return 1
  printf -v "${prefix}_EXE" '%s' "$(process_executable "$listener_pid_value")" || return 1
  printf -v "${prefix}_CMDLINE_B64" '%s' "$(process_cmdline_b64 "$listener_pid_value")" || return 1
  printf -v "${prefix}_SCREEN_OWNER" '%s' "$(process_owner "$screen_pid")" || return 1
  printf -v "${prefix}_LISTENER_OWNER" '%s' "$(process_owner "$listener_pid_value")" || return 1
  printf -v "${prefix}_RELEASE_SHA" '%s' "$release_sha"
}

write_component_record() {
  local prefix="$1" record temporary pair field key value
  record=$(component_field "$prefix" RECORD_FILE)
  [[ -d "$PROCESS_RECORD_ROOT" && ! -L "$PROCESS_RECORD_ROOT" ]] || { fail "process record root is absent or symlinked"; return 1; }
  assert_component_record_available "$(component_field "$prefix" NAME)" || return 1
  temporary="${record}.$$.tmp"
  : >"$temporary" || return 1
  printf 'version=1\n' >>"$temporary"
  [[ "${MIGRATION_RECORD:-0}" == 1 ]] && printf 'migration=1\n' >>"$temporary"
  for pair in NAME:name SESSION:session SCREEN_PID:screen_pid LISTENER_PID:listener_pid PORT:port RELEASE:release RELEASE_SHA:release_sha KIND:kind HOST:host CWD:cwd EXE:exe CMDLINE_B64:cmdline_b64 SCREEN_OWNER:screen_owner LISTENER_OWNER:listener_owner; do
    field=${pair%%:*}
    key=${pair#*:}
    value=$(component_field "$prefix" "$field")
    [[ -n "$value" && "$value" != *$'\n'* ]] || { rm -f -- "$temporary"; fail "component record field is invalid: $field"; return 1; }
    printf '%s=%s\n' "$key" "$value" >>"$temporary"
  done
  chmod 0600 "$temporary" || return 1
  mv -f "$temporary" "$record"
}

load_component_record() {
  local prefix="$1" expected_name="$2" expected_release="$3" expected_kind="$4" expected_host="$5" expected_port="$6"
  local record key value count=0 version="" migration="" name="" session="" screen_pid="" listener_pid_value="" port="" release="" release_sha="" kind="" host="" cwd="" exe="" cmdline_b64="" screen_owner="" listener_owner=""
  local seen_version=0 seen_migration=0 seen_name=0 seen_session=0 seen_screen_pid=0 seen_listener_pid=0 seen_port=0 seen_release=0 seen_release_sha=0 seen_kind=0 seen_host=0 seen_cwd=0 seen_exe=0 seen_cmdline_b64=0 seen_screen_owner=0 seen_listener_owner=0
  [[ -d "$PROCESS_RECORD_ROOT" && ! -L "$PROCESS_RECORD_ROOT" ]] || { fail "process record root is absent or symlinked"; return 1; }
  record=$(component_record_path "$expected_name") || return 1
  [[ -f "$record" && ! -L "$record" ]] || { fail "component process record is absent or symlinked: $expected_name"; return 1; }
  while IFS='=' read -r key value; do
    ((count += 1))
    case "$key" in
      version) ((seen_version += 1)); version="$value" ;;
      migration) ((seen_migration += 1)); migration="$value" ;;
      name) ((seen_name += 1)); name="$value" ;;
      session) ((seen_session += 1)); session="$value" ;;
      screen_pid) ((seen_screen_pid += 1)); screen_pid="$value" ;;
      listener_pid) ((seen_listener_pid += 1)); listener_pid_value="$value" ;;
      port) ((seen_port += 1)); port="$value" ;;
      release) ((seen_release += 1)); release="$value" ;;
      release_sha) ((seen_release_sha += 1)); release_sha="$value" ;;
      kind) ((seen_kind += 1)); kind="$value" ;;
      host) ((seen_host += 1)); host="$value" ;;
      cwd) ((seen_cwd += 1)); cwd="$value" ;;
      exe) ((seen_exe += 1)); exe="$value" ;;
      cmdline_b64) ((seen_cmdline_b64 += 1)); cmdline_b64="$value" ;;
      screen_owner) ((seen_screen_owner += 1)); screen_owner="$value" ;;
      listener_owner) ((seen_listener_owner += 1)); listener_owner="$value" ;;
      *) fail "component process record contains an unknown field"; return 1 ;;
    esac
  done <"$record"
  [[ "$count" -eq 15 || "$count" -eq 16 ]] || { fail "component process record has the wrong field count"; return 1; }
  [[ "$seen_version" -eq 1 && "$seen_name" -eq 1 && "$seen_session" -eq 1 && "$seen_screen_pid" -eq 1 && "$seen_listener_pid" -eq 1 && "$seen_port" -eq 1 && "$seen_release" -eq 1 && "$seen_release_sha" -eq 1 && "$seen_kind" -eq 1 && "$seen_host" -eq 1 && "$seen_cwd" -eq 1 && "$seen_exe" -eq 1 && "$seen_cmdline_b64" -eq 1 && "$seen_screen_owner" -eq 1 && "$seen_listener_owner" -eq 1 && "$seen_migration" -le 1 ]] || { fail "component process record has duplicate or missing fields"; return 1; }
  [[ "$version" == 1 && ( -z "$migration" || "$migration" == 1 ) && ( "$count" -eq 15 || "$seen_migration" -eq 1 ) ]] || { fail "component process record has the wrong shape"; return 1; }
  [[ "$name" == "$expected_name" && "$release" == "$expected_release" && "$kind" == "$expected_kind" && "$host" == "$expected_host" && "$port" == "$expected_port" ]] || { fail "component process record does not match the requested component"; return 1; }
  validate_sha "$release_sha" || return 1
  [[ "$screen_pid" =~ ^[0-9]+$ && "$listener_pid_value" =~ ^[0-9]+$ ]] || { fail "component process record has invalid PIDs"; return 1; }
  [[ "$session" == "${screen_pid}.${name}" && "$cwd" == "${release}/${kind}" && "$exe" == /* && -n "$cmdline_b64" && -n "$screen_owner" && -n "$listener_owner" ]] || { fail "component process record has invalid identity fields"; return 1; }
  set_component_record "$prefix" "$name" "$session" "$screen_pid" "$listener_pid_value" "$port" "$release" "$kind" "$host"
  printf -v "${prefix}_CWD" '%s' "$cwd"
  printf -v "${prefix}_EXE" '%s' "$exe"
  printf -v "${prefix}_CMDLINE_B64" '%s' "$cmdline_b64"
  printf -v "${prefix}_SCREEN_OWNER" '%s' "$screen_owner"
  printf -v "${prefix}_LISTENER_OWNER" '%s' "$listener_owner"
  printf -v "${prefix}_RELEASE_SHA" '%s' "$release_sha"
}

discover_component_record() {
  local prefix="$1" name="$2" release="$3" kind="$4" host="$5" port="$6"
  local session screen_pid listener_pid_value
  session=$(exact_screen_session "$name") || return 1
  screen_pid=$(screen_pid_from_session "$session") || return 1
  listener_pid_value=$(listener_pid "$port") || return 1
  pid_is_descendant_of "$listener_pid_value" "$screen_pid" || return 1
  pid_cwd_matches "$listener_pid_value" "${release}/${kind}" || return 1
  component_command_matches "$listener_pid_value" "$release" "$kind" "$host" "$port" || return 1
  set_component_record "$prefix" "$name" "$session" "$screen_pid" "$listener_pid_value" "$port" "$release" "$kind" "$host"
  observe_component_record "$prefix"
}

capture_component_record() {
  local prefix="$1" name="$2" release="$3" kind="$4" host="$5" port="$6"
  load_component_record "$prefix" "$name" "$release" "$kind" "$host" "$port" || return 1
  component_record_matches "$prefix"
}

capture_screen_record() {
  local prefix="$1" name="$2" release="$3" kind="$4" host="$5" port="$6" session screen_pid
  session=$(exact_screen_session "$name") || return 1
  screen_pid=$(screen_pid_from_session "$session") || return 1
  set_component_record "$prefix" "$name" "$session" "$screen_pid" "" "$port" "$release" "$kind" "$host"
}

component_record_matches() {
  local prefix="$1"
  local name session screen_pid listener_pid_value port release kind host observed_session observed_listener
  local cwd executable cmdline_b64 screen_owner listener_owner release_sha marker_sha
  name=$(component_field "$prefix" NAME)
  session=$(component_field "$prefix" SESSION)
  screen_pid=$(component_field "$prefix" SCREEN_PID)
  listener_pid_value=$(component_field "$prefix" LISTENER_PID)
  port=$(component_field "$prefix" PORT)
  release=$(component_field "$prefix" RELEASE)
  kind=$(component_field "$prefix" KIND)
  host=$(component_field "$prefix" HOST)
  cwd=$(component_field "$prefix" CWD)
  executable=$(component_field "$prefix" EXE)
  cmdline_b64=$(component_field "$prefix" CMDLINE_B64)
  screen_owner=$(component_field "$prefix" SCREEN_OWNER)
  listener_owner=$(component_field "$prefix" LISTENER_OWNER)
  release_sha=$(component_field "$prefix" RELEASE_SHA)
  [[ -n "$name" && -n "$session" && -n "$screen_pid" && -n "$listener_pid_value" ]] || { fail "component record is incomplete: $prefix"; return 1; }
  assert_release_identity "$release_sha" || return 1
  [[ "$release" == "$(canonical_release_for_sha "$release_sha")" ]] || { fail "component record release marker mismatch"; return 1; }
  marker_sha=$(<"${release}/.xraylarch-release.sha")
  [[ "$marker_sha" == "$release_sha" ]] || { fail "component release marker changed"; return 1; }
  observed_session=$(exact_screen_session "$name") || return 1
  [[ "$observed_session" == "$session" ]] || { fail "screen session changed for $name"; return 1; }
  [[ "$(screen_pid_from_session "$observed_session")" == "$screen_pid" ]] || { fail "screen PID changed for $name"; return 1; }
  observed_listener=$(listener_pid "$port") || return 1
  [[ "$observed_listener" == "$listener_pid_value" ]] || { fail "listener PID changed on port $port"; return 1; }
  pid_is_descendant_of "$observed_listener" "$screen_pid" || return 1
  [[ "$(process_owner "$screen_pid")" == "$screen_owner" ]] || { fail "screen owner changed for $name"; return 1; }
  [[ "$(process_owner "$observed_listener")" == "$listener_owner" ]] || { fail "listener owner changed on port $port"; return 1; }
  [[ "$cwd" == "${release}/${kind}" && "$(process_cwd "$observed_listener")" == "$cwd" ]] || { fail "listener cwd changed on port $port"; return 1; }
  [[ "$(process_executable "$observed_listener")" == "$executable" ]] || { fail "listener executable changed on port $port"; return 1; }
  [[ "$(process_cmdline_b64 "$observed_listener")" == "$cmdline_b64" ]] || { fail "listener command line changed on port $port"; return 1; }
}

component_field() {
  local variable="${1}_${2}"
  printf '%s' "${!variable:-}"
}

wait_for_component_record() {
  local prefix="$1" name="$2" release="$3" kind="$4" host="$5" port="$6" attempt
  for attempt in {1..20}; do
    if discover_component_record "$prefix" "$name" "$release" "$kind" "$host" "$port" >/dev/null 2>&1; then
      write_component_record "$prefix" || return 1
      component_record_matches "$prefix" || return 1
      return 0
    fi
    sleep 1
  done
  fail "component did not become an owned listener: $name"
}

wait_for_listener_release() {
  local port="$1" expected_pid="$2" attempt
  local -a pids=()
  for attempt in {1..20}; do
    pids=()
    while IFS= read -r pid; do [[ -z "$pid" ]] || pids+=("$pid"); done < <(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [[ ${#pids[@]} -eq 0 ]] && ! ss -ltnH | awk -v suffix=":${port}" '$4 ~ (suffix "$") { found=1 } END { exit found ? 0 : 1 }'; then return 0; fi
    if [[ ${#pids[@]} -ne 1 || "${pids[0]}" != "$expected_pid" ]]; then fail "listener ownership changed before port $port was released"; fi
    sleep 1
  done
  fail "listener PID $expected_pid still owns port $port"
}

wait_for_port_absent() {
  local port="$1" attempt
  local -a pids=()
  for attempt in {1..20}; do
    pids=()
    while IFS= read -r pid; do [[ -z "$pid" ]] || pids+=("$pid"); done < <(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [[ ${#pids[@]} -eq 0 ]] && ! ss -ltnH | awk -v suffix=":${port}" '$4 ~ (suffix "$") { found=1 } END { exit found ? 0 : 1 }'; then return 0; fi
    sleep 1
  done
  fail "port did not become unbound: $port"
}

recorded_process_still_matches() {
  local prefix="$1" listener_pid_value port observed
  listener_pid_value=$(component_field "$prefix" LISTENER_PID)
  port=$(component_field "$prefix" PORT)
  observed=$(listener_pid "$port") || return 1
  [[ "$observed" == "$listener_pid_value" ]] || return 1
  [[ "$(process_cwd "$observed")" == "$(component_field "$prefix" CWD)" ]] || return 1
  [[ "$(process_executable "$observed")" == "$(component_field "$prefix" EXE)" ]] || return 1
  [[ "$(process_cmdline_b64 "$observed")" == "$(component_field "$prefix" CMDLINE_B64)" ]] || return 1
  [[ "$(process_owner "$observed")" == "$(component_field "$prefix" LISTENER_OWNER)" ]]
}

stop_recorded_component() {
  local name="$1" screen_pid="$2" listener_pid_value="$3" port="$4" release="$5" kind="$6" host="$7"
  local prefix="${8:-}" session observed_screen_pid record_file=""
  [[ -n "$name" && -n "$screen_pid" ]] || return 0
  session=$(exact_screen_session "$name") || return 1
  observed_screen_pid=$(screen_pid_from_session "$session") || return 1
  [[ "$observed_screen_pid" == "$screen_pid" ]] || { fail "refusing to stop changed screen PID for $name"; return 1; }
  if [[ -z "$listener_pid_value" ]]; then
    "$SCREEN_BIN" -S "$session" -X quit || return 1
    wait_for_port_absent "$port"
    return
  fi
  [[ -n "$prefix" ]] || { fail "listener stop requires its launch record"; return 1; }
  component_record_matches "$prefix" || return 1
  record_file=$(component_field "$prefix" RECORD_FILE)
  "$SCREEN_BIN" -S "$session" -X quit || return 1
  if ! wait_for_listener_release "$port" "$listener_pid_value"; then
    recorded_process_still_matches "$prefix" || return 1
    kill -TERM "$listener_pid_value" || return 1
    wait_for_listener_release "$port" "$listener_pid_value" || return 1
  fi
  [[ -z "$record_file" ]] || rm -f -- "$record_file"
}

launch_screen() {
  local name="$1" working_directory="$2" backend_url="$3"
  shift 3
  local -a existing=()
  local session
  while IFS= read -r session; do [[ -z "$session" ]] || existing+=("$session"); done < <(screen_sessions_for_name "$name")
  [[ ${#existing[@]} -eq 0 ]] || { fail "screen name collision: $name"; return 1; }
  (
    cd "$working_directory" || exit 1
    "$SCREEN_BIN" -dmS "$name" bash -c "$(printf 'exec '; printf '%q ' env -i "PATH=$SAFE_PATH" "HOME=$CLEAN_HOME" "LANG=${LANG:-C.UTF-8}" "LC_ALL=${LC_ALL:-C.UTF-8}" "XRAYLARCH_DATA_ROOT=$DATA_ROOT" "BACKEND_URL=$backend_url" "NEXT_BACKEND_URL=$backend_url" "PYTHONPYCACHEPREFIX=${CANDIDATE_DATA}/runtime/pycache" "PYTHONUNBUFFERED=1" "$@")"
  )
}

launch_component() {
  local prefix="$1" name="$2" release="$3" kind="$4" host="$5" port="$6" backend_url="$7" sha
  sha=$(release_sha_from_path "$release") || return 1
  assert_release_identity "$sha" || return 1
  assert_component_record_available "$name" || return 1
  assert_port_unbound "$port" || return 1
  case "$kind" in
    backend) launch_screen "$name" "${release}/backend" "$backend_url" "${release}/backend/.venv/bin/python" -m uvicorn xraylarch_web.main:app --host "$host" --port "$port" || return 1 ;;
    frontend) launch_screen "$name" "${release}/frontend" "$backend_url" "$CONDA_BIN" run --no-capture-output -n drxas-node20 "${release}/frontend/node_modules/.bin/next" start -H "$host" -p "$port" || return 1 ;;
    *) fail "unknown component kind: $kind" ;;
  esac
  capture_screen_record "$prefix" "$name" "$release" "$kind" "$host" "$port" || return 1
  wait_for_component_record "$prefix" "$name" "$release" "$kind" "$host" "$port"
}

http_200() {
  local code
  code=$(curl --fail --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "$1") || return 1
  [[ "$code" == "200" ]] || { fail "expected HTTP 200 from $1, received $code"; return 1; }
}

backend_health_ok() {
  local url="$1" body
  body=$(curl --fail --silent --show-error --max-time 10 "$url/health") || return 1
  printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' || { fail "backend health body does not report status ok"; return 1; }
}

assert_sibling_services_healthy() {
  http_200 "http://127.0.0.1:3000/" || return 1
  http_200 "http://127.0.0.1:3001/" || return 1
  http_200 "http://127.0.0.1:8000/docs" || return 1
  http_200 "http://127.0.0.1:8001/docs" || return 1
  local port code
  for port in 8002 8003; do
    code=$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}/") || return 1
    [[ "$code" == "404" ]] || { fail "expected existing Dr.XAS sibling on ${port} to return 404, received $code"; return 1; }
  done
}

verify_component_pair() {
  local frontend_prefix="$1" backend_prefix="$2" frontend_host="$3" frontend_port="$4" backend_url="$5" require_siblings="$6"
  component_record_matches "$frontend_prefix" || return 1
  component_record_matches "$backend_prefix" || return 1
  assert_listener_address "${frontend_host}:${frontend_port}" || return 1
  assert_listener_address "${backend_url#http://}" || return 1
  http_200 "http://127.0.0.1:${frontend_port}/" || return 1
  http_200 "${backend_url}/health" || return 1
  backend_health_ok "$backend_url" || return 1
  http_200 "http://127.0.0.1:${frontend_port}/api/backend/health" || return 1
  [[ "$require_siblings" == 0 ]] || assert_sibling_services_healthy
}

reset_activation_records() {
  local variable
  for variable in $(compgen -A variable | grep -E '^ACTIVATION_(TARGET|STAGE)_(FRONTEND|BACKEND)_(NAME|SESSION|SCREEN_PID|LISTENER_PID|PORT|RELEASE|RELEASE_SHA|KIND|HOST|CWD|EXE|CMDLINE_B64|SCREEN_OWNER|LISTENER_OWNER|RECORD_FILE)$' || true); do printf -v "$variable" '%s' ""; done
}

snapshot_prior_state() {
  ACTIVATION_STATE_SNAPSHOT=""
  ACTIVATION_STATE_WAS_PRESENT=0
  if [[ -e "${STATE_ROOT}/last-successful" || -L "${STATE_ROOT}/last-successful" ]]; then
    [[ -f "${STATE_ROOT}/last-successful" && ! -L "${STATE_ROOT}/last-successful" ]] || { fail "last-successful is not a regular file"; return 1; }
    ACTIVATION_STATE_SNAPSHOT=$(mktemp "${STATE_ROOT}/.last-successful.before.${REQUESTED_SHA}.XXXXXX") || return 1
    cp --preserve=mode "${STATE_ROOT}/last-successful" "$ACTIVATION_STATE_SNAPSHOT" || return 1
    ACTIVATION_STATE_WAS_PRESENT=1
  fi
}

write_current_link() {
  local release="$1" replacement="${APP_ROOT}/.current.${REQUESTED_SHA}.$$"
  ln -s "$release" "$replacement" || return 1
  mv -Tf "$replacement" "$CURRENT_LINK"
}

write_last_successful() {
  local release="$1" temporary="${STATE_ROOT}/.last-successful.${REQUESTED_SHA}.$$"
  printf 'sha=%s\nrelease=%s\nactivated_at_utc=%s\n' "$REQUESTED_SHA" "$release" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$temporary" || return 1
  mv -f "$temporary" "${STATE_ROOT}/last-successful"
}

assert_last_successful_state() {
  local expected_sha="$1" expected_release="$2" state_file="${STATE_ROOT}/last-successful"
  local line1="" line2="" line3="" extra="" canonical timestamp_pattern='^activated_at_utc=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
  validate_sha "$expected_sha" || return 1
  canonical=$(canonical_release_for_sha "$expected_sha") || return 1
  [[ "$expected_release" == "$canonical" ]] || { fail "last-successful expected release is not canonical"; return 1; }
  [[ -f "$state_file" && ! -L "$state_file" ]] || { fail "last-successful is absent, non-regular, or symlinked"; return 1; }
  {
    IFS= read -r line1 || return 1
    IFS= read -r line2 || return 1
    IFS= read -r line3 || return 1
    if IFS= read -r extra; then fail "last-successful contains extra fields"; return 1; fi
  } <"$state_file"
  [[ "$line1" == "sha=${expected_sha}" ]] || { fail "last-successful SHA mismatch"; return 1; }
  [[ "$line2" == "release=${canonical}" ]] || { fail "last-successful release mismatch"; return 1; }
  [[ "$line3" =~ $timestamp_pattern ]] || { fail "last-successful activation timestamp is malformed"; return 1; }
}

restore_prior_link_and_state() {
  if [[ -n "$ACTIVATION_PREVIOUS_RELEASE" ]]; then
    ln -s "$ACTIVATION_PREVIOUS_RELEASE" "${APP_ROOT}/.restore-current.$$" || return 1
    mv -Tf "${APP_ROOT}/.restore-current.$$" "$CURRENT_LINK" || return 1
  elif [[ -L "$CURRENT_LINK" && "$(readlink -f -- "$CURRENT_LINK")" == "$ACTIVATION_TARGET_RELEASE" ]]; then
    rm -f -- "$CURRENT_LINK" || return 1
  fi
  if [[ "$ACTIVATION_STATE_WAS_PRESENT" == 1 ]]; then
    mv -Tf "$ACTIVATION_STATE_SNAPSHOT" "${STATE_ROOT}/last-successful" || return 1
    ACTIVATION_STATE_SNAPSHOT=""
  elif [[ "$ACTIVATION_STATE_WRITTEN" == 1 && -f "${STATE_ROOT}/last-successful" ]] && grep -Fx "sha=${REQUESTED_SHA}" "${STATE_ROOT}/last-successful" >/dev/null; then
    rm -f -- "${STATE_ROOT}/last-successful" || return 1
  fi
}

stop_recorded_prefix() {
  local prefix="$1" name screen_pid listener_pid_value port release kind host
  name=$(component_field "$prefix" NAME)
  screen_pid=$(component_field "$prefix" SCREEN_PID)
  listener_pid_value=$(component_field "$prefix" LISTENER_PID)
  port=$(component_field "$prefix" PORT)
  release=$(component_field "$prefix" RELEASE)
  kind=$(component_field "$prefix" KIND)
  host=$(component_field "$prefix" HOST)
  stop_recorded_component "$name" "$screen_pid" "$listener_pid_value" "$port" "$release" "$kind" "$host" "$prefix" || return 1
  printf -v "${prefix}_NAME" '%s' ""
  printf -v "${prefix}_SCREEN_PID" '%s' ""
  printf -v "${prefix}_LISTENER_PID" '%s' ""
}

restart_previous_release() {
  [[ -n "$ACTIVATION_PREVIOUS_RELEASE" ]] || return 0
  REQUESTED_SHA="$ACTIVATION_PREVIOUS_SHA"
  prepare_candidate_data || return 1
  if [[ "$ACTIVATION_PREVIOUS_BACKEND_STOPPED" == 1 || "$ACTIVATION_PREVIOUS_STOPPED" == 1 && "$ACTIVATION_PREVIOUS_FRONTEND_STOPPED" == 0 && "$ACTIVATION_PREVIOUS_BACKEND_STOPPED" == 0 ]]; then
    launch_component ACTIVATION_TARGET_BACKEND "$BACKEND_SCREEN" "$ACTIVATION_PREVIOUS_RELEASE" backend "$FINAL_BACKEND_HOST" "$FINAL_BACKEND_PORT" "$FINAL_BACKEND_URL" || return 1
  else
    capture_component_record ACTIVATION_TARGET_BACKEND "$BACKEND_SCREEN" "$ACTIVATION_PREVIOUS_RELEASE" backend "$FINAL_BACKEND_HOST" "$FINAL_BACKEND_PORT" || return 1
  fi
  if [[ "$ACTIVATION_PREVIOUS_FRONTEND_STOPPED" == 1 || "$ACTIVATION_PREVIOUS_STOPPED" == 1 && "$ACTIVATION_PREVIOUS_FRONTEND_STOPPED" == 0 && "$ACTIVATION_PREVIOUS_BACKEND_STOPPED" == 0 ]]; then
    launch_component ACTIVATION_TARGET_FRONTEND "$FRONTEND_SCREEN" "$ACTIVATION_PREVIOUS_RELEASE" frontend "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" "$FINAL_BACKEND_URL" || return 1
  else
    capture_component_record ACTIVATION_TARGET_FRONTEND "$FRONTEND_SCREEN" "$ACTIVATION_PREVIOUS_RELEASE" frontend "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" || return 1
  fi
  verify_component_pair ACTIVATION_TARGET_FRONTEND ACTIVATION_TARGET_BACKEND "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" "$FINAL_BACKEND_URL" 1
}

recover_activation() {
  local result=0 had_errexit=0
  (( ACTIVATION_IN_PROGRESS == 1 )) || return 0
  [[ $- == *e* ]] && had_errexit=1
  set +e
  stop_recorded_prefix ACTIVATION_TARGET_FRONTEND || result=1
  stop_recorded_prefix ACTIVATION_TARGET_BACKEND || result=1
  stop_recorded_prefix ACTIVATION_STAGE_FRONTEND || result=1
  stop_recorded_prefix ACTIVATION_STAGE_BACKEND || result=1
  restore_prior_link_and_state || result=1
  if (( ACTIVATION_PREVIOUS_STOPPED == 1 )); then restart_previous_release || result=1; fi
  ACTIVATION_IN_PROGRESS=0
  (( had_errexit == 0 )) || set -e
  return "$result"
}

guarded_exit() {
  local status="$1"
  trap - ERR EXIT
  if (( ACTIVATION_IN_PROGRESS == 1 )); then recover_activation || printf 'ERROR: guarded activation recovery was incomplete\n' >&2; fi
  exit "$status"
}

begin_activation() {
  local target_sha="$1"
  ACTIVATION_IN_PROGRESS=1
  ACTIVATION_PREVIOUS_STOPPED=0
  ACTIVATION_PREVIOUS_FRONTEND_STOPPED=0
  ACTIVATION_PREVIOUS_BACKEND_STOPPED=0
  ACTIVATION_PREVIOUS_RELEASE=""
  ACTIVATION_PREVIOUS_SHA=""
  ACTIVATION_STATE_WRITTEN=0
  ACTIVATION_TARGET_RELEASE=$(canonical_release_for_sha "$target_sha") || return 1
  reset_activation_records
  snapshot_prior_state || return 1
  if [[ -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]]; then
    [[ -L "$CURRENT_LINK" ]] || { fail "current path exists but is not a symlink"; return 1; }
    read_current_release || return 1
    assert_last_successful_state "$CURRENT_SHA" "$CURRENT_RELEASE" || return 1
    ACTIVATION_PREVIOUS_RELEASE="$CURRENT_RELEASE"
    ACTIVATION_PREVIOUS_SHA="$CURRENT_SHA"
    capture_component_record ACTIVATION_PREVIOUS_FRONTEND "$FRONTEND_SCREEN" "$CURRENT_RELEASE" frontend "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" || return 1
    capture_component_record ACTIVATION_PREVIOUS_BACKEND "$BACKEND_SCREEN" "$CURRENT_RELEASE" backend "$FINAL_BACKEND_HOST" "$FINAL_BACKEND_PORT" || return 1
    verify_component_pair ACTIVATION_PREVIOUS_FRONTEND ACTIVATION_PREVIOUS_BACKEND "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" "$FINAL_BACKEND_URL" 1 || return 1
  else
    [[ -z "$(screen_sessions_for_name "$FRONTEND_SCREEN")" ]] || { fail "active frontend screen collision without current release"; return 1; }
    [[ -z "$(screen_sessions_for_name "$BACKEND_SCREEN")" ]] || { fail "active backend screen collision without current release"; return 1; }
  fi
}

stage_target_release() {
  launch_component ACTIVATION_STAGE_BACKEND "$STAGE_BACKEND_SCREEN" "$ACTIVATION_TARGET_RELEASE" backend "$STAGE_BACKEND_HOST" "$STAGE_BACKEND_PORT" "$STAGE_BACKEND_URL" || return 1
  launch_component ACTIVATION_STAGE_FRONTEND "$STAGE_FRONTEND_SCREEN" "$ACTIVATION_TARGET_RELEASE" frontend "$STAGE_FRONTEND_HOST" "$STAGE_FRONTEND_PORT" "$STAGE_BACKEND_URL" || return 1
  verify_component_pair ACTIVATION_STAGE_FRONTEND ACTIVATION_STAGE_BACKEND "$STAGE_FRONTEND_HOST" "$STAGE_FRONTEND_PORT" "$STAGE_BACKEND_URL" 0
}

handoff_to_target() {
  if [[ -n "$ACTIVATION_PREVIOUS_RELEASE" ]]; then
    ACTIVATION_PREVIOUS_STOPPED=1
    stop_recorded_prefix ACTIVATION_PREVIOUS_FRONTEND || return 1
    ACTIVATION_PREVIOUS_FRONTEND_STOPPED=1
    stop_recorded_prefix ACTIVATION_PREVIOUS_BACKEND || return 1
    ACTIVATION_PREVIOUS_BACKEND_STOPPED=1
  fi
  launch_component ACTIVATION_TARGET_BACKEND "$BACKEND_SCREEN" "$ACTIVATION_TARGET_RELEASE" backend "$FINAL_BACKEND_HOST" "$FINAL_BACKEND_PORT" "$FINAL_BACKEND_URL" || return 1
  launch_component ACTIVATION_TARGET_FRONTEND "$FRONTEND_SCREEN" "$ACTIVATION_TARGET_RELEASE" frontend "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" "$FINAL_BACKEND_URL" || return 1
  verify_component_pair ACTIVATION_TARGET_FRONTEND ACTIVATION_TARGET_BACKEND "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" "$FINAL_BACKEND_URL" 1 || return 1
  stop_recorded_prefix ACTIVATION_STAGE_FRONTEND || return 1
  stop_recorded_prefix ACTIVATION_STAGE_BACKEND || return 1
}

activate_release() {
  local target_sha="$1"
  assert_release_identity "$target_sha" || return 1
  begin_activation "$target_sha" || { recover_activation || true; return 1; }
  stage_target_release || { recover_activation || true; return 1; }
  handoff_to_target || { recover_activation || true; return 1; }
  REQUESTED_SHA="$target_sha"
  write_current_link "$ACTIVATION_TARGET_RELEASE" || { recover_activation || true; return 1; }
  write_last_successful "$ACTIVATION_TARGET_RELEASE" || { recover_activation || true; return 1; }
  ACTIVATION_STATE_WRITTEN=1
  assert_last_successful_state "$target_sha" "$ACTIVATION_TARGET_RELEASE" || { recover_activation || true; return 1; }
  verify_component_pair ACTIVATION_TARGET_FRONTEND ACTIVATION_TARGET_BACKEND "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" "$FINAL_BACKEND_URL" 1 || { recover_activation || true; return 1; }
  [[ "$(readlink -f -- "$CURRENT_LINK")" == "$ACTIVATION_TARGET_RELEASE" ]] || { recover_activation || true; return 1; }
  [[ -z "$ACTIVATION_STATE_SNAPSHOT" ]] || rm -f -- "$ACTIVATION_STATE_SNAPSHOT"
  ACTIVATION_IN_PROGRESS=0
}

verify_remote_branch_tip() {
  local remote_ref
  remote_ref=$(run_clean git ls-remote --refs "$REPOSITORY" "refs/heads/${APPROVED_BRANCH}") || return 1
  [[ "$remote_ref" == "${REQUESTED_SHA}"$'\t'"refs/heads/${APPROVED_BRANCH}" ]] || { fail "remote approved branch is not the requested SHA"; return 1; }
}

assert_frontend_runtime_supported() {
  run_clean "$CONDA_BIN" run --no-capture-output -n drxas-node20 node -e \
    'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)' \
    || { fail "drxas-node20 must provide Node.js 20.9 or newer"; return 1; }
}

build_release() {
  local release temporary
  release=$(release_path "$REQUESTED_SHA") || return 1
  [[ ! -e "$release" ]] || { fail "immutable release path already exists: $release"; return 1; }
  temporary=$(mktemp -d "${RELEASES_ROOT}/.${REQUESTED_SHA}.build.XXXXXX") || return 1
  trap '[[ -n "${temporary:-}" && -d "$temporary" ]] && rm -rf -- "$temporary"' RETURN
  run_clean git init --quiet "$temporary" || return 1
  run_clean git -C "$temporary" remote add origin "$REPOSITORY" || return 1
  run_clean git -C "$temporary" fetch --depth=1 origin "refs/heads/${APPROVED_BRANCH}:refs/remotes/origin/${APPROVED_BRANCH}" || return 1
  [[ "$(run_clean git -C "$temporary" rev-parse "refs/remotes/origin/${APPROVED_BRANCH}")" == "$REQUESTED_SHA" ]] || { fail "fetched remote branch changed during build"; return 1; }
  run_clean git -C "$temporary" checkout --quiet --detach "$REQUESTED_SHA" || return 1
  run_clean "$CONDA_BIN" run --no-capture-output -n drxas-deploy python -m venv "${temporary}/backend/.venv" || return 1
  ( cd "${temporary}/backend" && run_clean "${temporary}/backend/.venv/bin/python" -m pip install --requirement requirements.txt && run_clean "${temporary}/backend/.venv/bin/python" -m pip install --force-reinstall --no-deps .. && run_clean "${temporary}/backend/.venv/bin/python" -m pip check && run_clean "${temporary}/backend/.venv/bin/python" -m pip freeze --all > pip-freeze.txt ) || return 1
  assert_frontend_runtime_supported || return 1
  ( cd "${temporary}/frontend" && run_clean "$CONDA_BIN" run --no-capture-output -n drxas-node20 npm ci && run_clean "$CONDA_BIN" run --no-capture-output -n drxas-node20 npm run build ) || return 1
  printf '%s\n' "$REQUESTED_SHA" >"${temporary}/.xraylarch-release.sha"
  printf 'repository=%s\nbranch=%s\nsha=%s\nbuilt_at_utc=%s\n' "$REPOSITORY" "$APPROVED_BRANCH" "$REQUESTED_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${temporary}/.xraylarch-release.manifest"
  sha256sum "${temporary}/backend/requirements.txt" "${temporary}/backend/pip-freeze.txt" "${temporary}/frontend/package-lock.json" >"${temporary}/.xraylarch-integrity.sha256"
  chmod -R a-w "$temporary"
  mv -T "$temporary" "$release"
  trap - RETURN
}

perform_deploy() { verify_remote_branch_tip && build_release && activate_release "$REQUESTED_SHA"; }
perform_rollback() { assert_release_identity "$REQUESTED_SHA" && activate_release "$REQUESTED_SHA"; }

perform_migrate() {
  local frontend_record backend_record
  read_current_release || { fail "current release symlink is absent"; return 1; }
  [[ "$CURRENT_SHA" == "$REQUESTED_SHA" ]] || { fail "current release is not the requested SHA"; return 1; }
  assert_release_identity "$REQUESTED_SHA" || return 1
  assert_last_successful_state "$REQUESTED_SHA" "$CURRENT_RELEASE" || return 1
  [[ -d "$PROCESS_RECORD_ROOT" && ! -L "$PROCESS_RECORD_ROOT" ]] || { fail "process record root is absent or symlinked"; return 1; }
  frontend_record=$(component_record_path "$FRONTEND_SCREEN") || return 1
  backend_record=$(component_record_path "$BACKEND_SCREEN") || return 1
  if [[ -e "$frontend_record" || -L "$frontend_record" || -e "$backend_record" || -L "$backend_record" ]]; then
    if [[ -f "$frontend_record" && ! -L "$frontend_record" && -f "$backend_record" && ! -L "$backend_record" ]]; then
      capture_component_record MIGRATE_FRONTEND "$FRONTEND_SCREEN" "$CURRENT_RELEASE" frontend "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" || return 1
      capture_component_record MIGRATE_BACKEND "$BACKEND_SCREEN" "$CURRENT_RELEASE" backend "$FINAL_BACKEND_HOST" "$FINAL_BACKEND_PORT" || return 1
      printf 'process records already valid sha=%s\n' "$REQUESTED_SHA"
      return 0
    fi
    # A partial pair is recoverable only when both files carry this migration's
    # marker. Never remove arbitrary or legacy state.
    migration_records=1
    for record in "$frontend_record" "$backend_record"; do
      if [[ -e "$record" || -L "$record" ]]; then
        [[ -f "$record" && ! -L "$record" ]] || { migration_records=0; break; }
        grep -Fx 'migration=1' "$record" >/dev/null 2>&1 || { migration_records=0; break; }
      fi
    done
    if (( migration_records == 1 )); then
      rm -f -- "$frontend_record" "$backend_record"
    else
      fail "partial or colliding process records require manual repair"
      return 1
    fi
  fi
  discover_component_record MIGRATE_FRONTEND "$FRONTEND_SCREEN" "$CURRENT_RELEASE" frontend "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" || return 1
  discover_component_record MIGRATE_BACKEND "$BACKEND_SCREEN" "$CURRENT_RELEASE" backend "$FINAL_BACKEND_HOST" "$FINAL_BACKEND_PORT" || return 1
  MIGRATION_RECORD=1 write_component_record MIGRATE_FRONTEND || return 1
  if ! MIGRATION_RECORD=1 write_component_record MIGRATE_BACKEND; then
    rm -f -- "$MIGRATE_FRONTEND_RECORD_FILE"
    return 1
  fi
  capture_component_record CHECK_FRONTEND "$FRONTEND_SCREEN" "$CURRENT_RELEASE" frontend "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" || { rm -f -- "$MIGRATE_FRONTEND_RECORD_FILE" "$MIGRATE_BACKEND_RECORD_FILE"; return 1; }
  capture_component_record CHECK_BACKEND "$BACKEND_SCREEN" "$CURRENT_RELEASE" backend "$FINAL_BACKEND_HOST" "$FINAL_BACKEND_PORT" || { rm -f -- "$MIGRATE_FRONTEND_RECORD_FILE" "$MIGRATE_BACKEND_RECORD_FILE"; return 1; }
  printf 'process records migrated sha=%s\n' "$REQUESTED_SHA"
}

perform_health() {
  read_current_release || { fail "current release symlink is absent"; return 1; }
  [[ "$CURRENT_SHA" == "$REQUESTED_SHA" ]] || { fail "current release is not the requested SHA"; return 1; }
  assert_last_successful_state "$REQUESTED_SHA" "$CURRENT_RELEASE" || return 1
  capture_component_record CHECK_FRONTEND "$FRONTEND_SCREEN" "$CURRENT_RELEASE" frontend "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" || return 1
  capture_component_record CHECK_BACKEND "$BACKEND_SCREEN" "$CURRENT_RELEASE" backend "$FINAL_BACKEND_HOST" "$FINAL_BACKEND_PORT" || return 1
  verify_component_pair CHECK_FRONTEND CHECK_BACKEND "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" "$FINAL_BACKEND_URL" 1 || return 1
  printf 'healthy sha=%s release=%s\n' "$CURRENT_SHA" "$CURRENT_RELEASE"
}

main() {
  parse_arguments "$@" || return $?
  initialize_commands || return 1
  case "$ACTION" in
    health) perform_health ;;
    migrate)
      initialize_host_paths || return 1
      perform_migrate
      ;;
    deploy|rollback)
      initialize_host_paths || return 1
      prepare_candidate_data || return 1
      if [[ "$ACTION" == deploy ]]; then perform_deploy; else perform_rollback; fi
      ;;
  esac
}

if [[ "${XRAYLARCH_WEB_TEST_MODE:-0}" != 1 ]]; then
  trap 'guarded_exit $?' EXIT
  trap 'exit 1' ERR
  main "$@"
fi
