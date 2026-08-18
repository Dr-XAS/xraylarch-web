#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
XRAYLARCH_WEB_TEST_MODE=1 source "$repo_root/scripts/deploy-xraylarch-web.sh"

test_fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

if validate_sha not-a-sha >/dev/null 2>&1; then
  test_fail "invalid SHA must return nonzero"
fi
validate_sha 0123456789abcdef0123456789abcdef01234567

state_test_root=$(mktemp -d)
state_test_root=$(cd "$state_test_root" && pwd -P)
trap 'rm -rf -- "$state_test_root"' EXIT
RELEASES_ROOT="${state_test_root}/releases"
STATE_ROOT="${state_test_root}/state"
PROCESS_RECORD_ROOT="${STATE_ROOT}/processes"
CURRENT_LINK="${state_test_root}/current"
state_sha=0123456789abcdef0123456789abcdef01234567
state_release="${RELEASES_ROOT}/${state_sha}"
mkdir -p "$state_release" "$PROCESS_RECORD_ROOT"
printf '%s\n' "$state_sha" >"${state_release}/.xraylarch-release.sha"
printf 'sha=%s\nrelease=%s\nactivated_at_utc=2026-08-17T12:00:00Z\n' "$state_sha" "$state_release" >"${STATE_ROOT}/last-successful"
assert_last_successful_state "$state_sha" "$state_release" || test_fail "matching last-successful state must pass"

printf 'sha=%s\nrelease=%s\nactivated_at_utc=2026-08-17T12:00:00Z\n' 1111111111111111111111111111111111111111 "$state_release" >"${STATE_ROOT}/last-successful"
if assert_last_successful_state "$state_sha" "$state_release" >/dev/null 2>&1; then
  test_fail "stale last-successful SHA must fail"
fi
rm -f "${STATE_ROOT}/last-successful"
ln -s "${STATE_ROOT}/missing-state-target" "${STATE_ROOT}/last-successful"
REQUESTED_SHA="$state_sha"
if snapshot_prior_state >/dev/null 2>&1; then
  test_fail "broken-symlink last-successful state must fail before activation"
fi
rm -f "${STATE_ROOT}/last-successful"
if assert_last_successful_state "$state_sha" "$state_release" >/dev/null 2>&1; then
  test_fail "missing last-successful state must fail"
fi
printf 'sha=%s\nrelease=%s\nactivated_at_utc=2026-08-17T12:00:00Z\n' "$state_sha" "$state_release" >"${STATE_ROOT}/state-target"
ln -s "${STATE_ROOT}/state-target" "${STATE_ROOT}/last-successful"
if assert_last_successful_state "$state_sha" "$state_release" >/dev/null 2>&1; then
  test_fail "symlinked last-successful state must fail"
fi
rm -f "${STATE_ROOT}/last-successful"

read_process_argv() { PROCESS_ARGV=("next-server (v16.3.1)"); }
process_executable() { printf '/opt/drxas-node20/bin/node\n'; }
component_command_matches 501 /release frontend 127.0.0.1 13004 || test_fail "Next listener title must be accepted without a node_modules argv path"
read_process_argv() { PROCESS_ARGV=("next-server (v16.3.1)" "" "" ""); }
component_command_matches 501 /release frontend 127.0.0.1 13004 || test_fail "Next listener title must allow trailing empty argv entries"
read_process_argv() { PROCESS_ARGV=("next-server (v16.3.1)" "" "unexpected"); }
if component_command_matches 501 /release frontend 127.0.0.1 13004 >/dev/null 2>&1; then
  test_fail "changed Next listener argv must fail exact identity"
fi

set_component_record RECORD xraylarch-web-candidate-frontend 501.xraylarch-web-candidate-frontend 501 502 13004 "$state_release" frontend 127.0.0.1
RECORD_RELEASE_SHA="$state_sha"
RECORD_CWD="${state_release}/frontend"
RECORD_EXE=/opt/drxas-node20/bin/node
RECORD_CMDLINE_B64=bmV4dC1zZXJ2ZXIA==
RECORD_SCREEN_OWNER=drxas
RECORD_LISTENER_OWNER=drxas
write_component_record RECORD || test_fail "candidate process record must be written atomically"
if assert_component_record_available xraylarch-web-candidate-frontend >/dev/null 2>&1; then
  test_fail "candidate launch must refuse an existing process record"
fi
load_component_record LOADED xraylarch-web-candidate-frontend "$state_release" frontend 127.0.0.1 13004 || test_fail "candidate process record must be loadable"
[[ "$LOADED_LISTENER_PID" == 502 ]] || test_fail "listener PID must round-trip through the process record"
[[ "$LOADED_CMDLINE_B64" == "$RECORD_CMDLINE_B64" ]] || test_fail "exact listener command line must round-trip through the process record"
[[ "$LOADED_CWD" == "${state_release}/frontend" ]] || test_fail "release cwd must round-trip through the process record"
rm -f "$RECORD_RECORD_FILE"
assert_component_record_available xraylarch-web-candidate-frontend || test_fail "candidate launch may use an unused process record name"

set_component_record RECORD xraylarch-web-candidate-frontend 501.xraylarch-web-candidate-frontend 501 502 13004 "$state_release" frontend 127.0.0.1
RECORD_RELEASE_SHA="$state_sha"; RECORD_CWD="${state_release}/frontend"; RECORD_EXE=/opt/drxas-node20/bin/node
RECORD_CMDLINE_B64=bmV4dC1zZXJ2ZXIA==; RECORD_SCREEN_OWNER=drxas; RECORD_LISTENER_OWNER=drxas
write_component_record RECORD || test_fail "record fixture must be rewritable"
printf 'version=1\n' >>"$RECORD_RECORD_FILE"
if load_component_record LOADED xraylarch-web-candidate-frontend "$state_release" frontend 127.0.0.1 13004 >/dev/null 2>&1; then
  test_fail "duplicate process-record fields must fail closed"
fi
rm -f "$RECORD_RECORD_FILE"

lsof() { printf '999\n'; }
ss() { return 0; }
if assert_port_unbound 13004 >/dev/null 2>&1; then
  test_fail "candidate launch must refuse an occupied staging port"
fi
lsof() { return 0; }
assert_port_unbound 13004 || test_fail "candidate launch may use an unbound staging port"

release_probe=$(mktemp)
rm -f "$release_probe"
ss() {
  if [[ "${1:-}" == -ltnpH && ! -e "$release_probe" ]]; then
    : >"$release_probe"
    printf 'LISTEN 0 511 127.0.0.1:13004 0.0.0.0:* users:(("next-server (v16.3.1)",pid=777,fd=21))\n'
  fi
  return 0
}
lsof() { return 0; }
listener_pid 13004 | grep -Fx 777 || test_fail "listener PID must fall back to ss when lsof is empty"
rm -f "$release_probe"
wait_for_listener_release 13004 777 >/dev/null 2>&1 || test_fail "listener release must use ss fallback when lsof is empty"
rm -f "$release_probe"

screen_mock() {
  if [[ "$1" == -ls ]]; then
    printf '401.xraylarch-web-frontend\t(Detached)\n'
    printf '402.xraylarch-web-frontend\t(Detached)\n'
  fi
}
SCREEN_BIN=screen_mock
if exact_screen_session xraylarch-web-frontend >/dev/null 2>&1; then
  test_fail "multiple same-named screen sessions must be a collision"
fi

raw_stop_events=()
mock_sessions=""
screen_control() {
  case "$1" in
    -ls) printf '%s\n' "$mock_sessions" ;;
    -S)
      [[ "$3" == -X && "$4" == quit ]] || test_fail "screen stop must target one exact session"
      raw_stop_events+=("$2")
      mock_sessions=""
      ;;
    *) test_fail "unexpected screen invocation: $*" ;;
  esac
}
lsof() { return 0; }
ss() { return 0; }
SCREEN_BIN=screen_control

mock_sessions="405.xraylarch-web-candidate-frontend"
stop_recorded_component xraylarch-web-candidate-frontend 405 "" 13004 /release frontend 127.0.0.1 || test_fail "staged startup cleanup must stop its recorded screen"
[[ "${raw_stop_events[*]-}" == *"405.xraylarch-web-candidate-frontend"* ]] || test_fail "staged startup failure must leave no candidate screen"

mock_sessions="401.xraylarch-web-frontend"
stop_recorded_component xraylarch-web-frontend 401 "" 3004 /release frontend 0.0.0.0 || test_fail "final startup cleanup must stop its recorded screen"
[[ "${raw_stop_events[*]-}" == *"401.xraylarch-web-frontend"* ]] || test_fail "final startup failure must release the final screen name"

recovery_events=()
restore_prior_link_and_state() { recovery_events+=(restore-state); }
restart_previous_release() { recovery_events+=(restart-prior-healthy); }

raw_stop_events=()
mock_sessions="405.xraylarch-web-candidate-frontend"
ACTIVATION_IN_PROGRESS=1
ACTIVATION_PREVIOUS_STOPPED=1
ACTIVATION_TARGET_FRONTEND_NAME=""
ACTIVATION_TARGET_BACKEND_NAME=""
ACTIVATION_STAGE_FRONTEND_NAME=xraylarch-web-candidate-frontend
ACTIVATION_STAGE_FRONTEND_SCREEN_PID=405
ACTIVATION_STAGE_FRONTEND_LISTENER_PID=""
ACTIVATION_STAGE_FRONTEND_PORT=13004
ACTIVATION_STAGE_BACKEND_NAME=""
recover_activation || test_fail "staged startup failure recovery must complete"
[[ "${raw_stop_events[*]-}" == *"405.xraylarch-web-candidate-frontend"* ]] || test_fail "staged startup failure must leave no candidate screen/process"
[[ "${recovery_events[*]}" == *"restore-state restart-prior-healthy"* ]] || test_fail "staged startup failure must restore the healthy prior release"

raw_stop_events=()
recovery_events=()
mock_sessions="401.xraylarch-web-frontend"
ACTIVATION_IN_PROGRESS=1
ACTIVATION_PREVIOUS_STOPPED=1
ACTIVATION_TARGET_FRONTEND_NAME=xraylarch-web-frontend
ACTIVATION_TARGET_FRONTEND_SCREEN_PID=401
ACTIVATION_TARGET_FRONTEND_LISTENER_PID=""
ACTIVATION_TARGET_FRONTEND_PORT=3004
ACTIVATION_TARGET_BACKEND_NAME=""
ACTIVATION_STAGE_FRONTEND_NAME=""
ACTIVATION_STAGE_BACKEND_NAME=""
recover_activation || test_fail "final startup failure recovery must complete"
[[ "${raw_stop_events[*]-}" == *"401.xraylarch-web-frontend"* ]] || test_fail "final startup failure must leave no final candidate screen/process"
[[ "${recovery_events[*]}" == *"restore-state restart-prior-healthy"* ]] || test_fail "final startup failure must restore the healthy prior release"

events=()
stop_recorded_component() {
  events+=("stop:$1:$2:$3:$4:$5")
}
restore_prior_link_and_state() {
  events+=(restore-state)
}
restart_previous_release() {
  events+=(restart-prior)
}

ACTIVATION_IN_PROGRESS=1
ACTIVATION_PREVIOUS_STOPPED=1
ACTIVATION_TARGET_FRONTEND_NAME=xraylarch-web-frontend
ACTIVATION_TARGET_FRONTEND_SCREEN_PID=401
ACTIVATION_TARGET_FRONTEND_LISTENER_PID=402
ACTIVATION_TARGET_FRONTEND_PORT=3004
ACTIVATION_TARGET_BACKEND_NAME=xraylarch-web-backend
ACTIVATION_TARGET_BACKEND_SCREEN_PID=403
ACTIVATION_TARGET_BACKEND_LISTENER_PID=404
ACTIVATION_TARGET_BACKEND_PORT=8006
ACTIVATION_STAGE_FRONTEND_NAME=xraylarch-web-candidate-frontend
ACTIVATION_STAGE_FRONTEND_SCREEN_PID=405
ACTIVATION_STAGE_FRONTEND_LISTENER_PID=406
ACTIVATION_STAGE_FRONTEND_PORT=13004
ACTIVATION_STAGE_BACKEND_NAME=xraylarch-web-candidate-backend
ACTIVATION_STAGE_BACKEND_SCREEN_PID=407
ACTIVATION_STAGE_BACKEND_LISTENER_PID=408
ACTIVATION_STAGE_BACKEND_PORT=18006

recover_activation || test_fail "guarded recovery must return successfully with mocked exact stops"

[[ "${events[*]}" == *"stop:xraylarch-web-frontend:401:402:3004"* ]] || test_fail "recovery must stop the recorded active frontend"
[[ "${events[*]}" == *"stop:xraylarch-web-backend:403:404:8006"* ]] || test_fail "recovery must stop the recorded active backend"
[[ "${events[*]}" == *"stop:xraylarch-web-candidate-frontend:405:406:13004"* ]] || test_fail "recovery must stop the recorded staging frontend"
[[ "${events[*]}" == *"stop:xraylarch-web-candidate-backend:407:408:18006"* ]] || test_fail "recovery must stop the recorded staging backend"
[[ "${events[*]}" == *"restore-state"* ]] || test_fail "recovery must restore the prior symlink and state"
[[ "${events[*]}" == *"restart-prior"* ]] || test_fail "recovery must restart the prior release after handoff failure"
[[ "$ACTIVATION_IN_PROGRESS" == 0 ]] || test_fail "recovery must clear the activation guard"

printf 'deployment activation regression checks passed\n'
