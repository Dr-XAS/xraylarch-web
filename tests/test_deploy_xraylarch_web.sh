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
