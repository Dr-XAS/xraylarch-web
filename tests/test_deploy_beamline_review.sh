#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BEAMLINE_REVIEW_TEST_MODE=1 source "$REPO_ROOT/scripts/deploy-beamline-review.sh"
TEST_ROOT=$(mktemp -d)
TEST_ROOT=$(cd "$TEST_ROOT" && pwd -P)
trap 'rm -rf "$TEST_ROOT"' EXIT
SHA=0123456789012345678901234567890123456789
APP_ROOT="$TEST_ROOT/app"
STATE_ROOT="$APP_ROOT/state"
DATA_ROOT="$APP_ROOT/data"
RELEASES_ROOT="$APP_ROOT/releases"
mkdir -p "$STATE_ROOT"
PYTHON=$(command -v python3)
passed=0

expect_failure() {
  if "$@" >/dev/null 2>&1; then
    printf 'Expected failure: %s\n' "$*" >&2
    exit 1
  fi
}

run_test() {
  ( "$1" )
  passed=$((passed + 1))
  printf 'PASS %s\n' "$1"
}

test_sha_and_build_marker() {
  validate_sha "$SHA"
  expect_failure validate_sha abc123
  expect_failure validate_sha '../../another-app'
  local release="$TEST_ROOT/release"
  mkdir -p "$release/frontend/.next" "$release/backend/.venv/bin"
  expect_failure require_built "$release"
  printf '%s\n' "$SHA" > "$release/.beamline-review-built"
  printf 'build\n' > "$release/frontend/.next/BUILD_ID"
  touch "$release/backend/.venv/bin/python"
  chmod +x "$release/backend/.venv/bin/python"
  require_built "$release"
  printf 'wrong revision\n' > "$release/.beamline-review-built"
  expect_failure require_built "$release"
}

test_exact_listener_and_screen_matching() {
  ss() {
    cat <<'SS'
LISTEN 0 511 127.0.0.1:3005 0.0.0.0:* users:(("next-server",pid=100,fd=21))
LISTEN 0 511 164.54.109.10:3005 0.0.0.0:* users:(("next-server",pid=200,fd=21))
LISTEN 0 511 0.0.0.0:3004 0.0.0.0:* users:(("next-server",pid=300,fd=21))
SS
  }
  screen() {
    printf '100.drxas-kiosk-web\n200.app-xraylarch-web-beamline-review-web\n300.app-xraylarch-web-beamline-review-web-extra\n'
  }
  [[ "$(listener_pid 164.54.109.10 3005)" == 200 ]]
  [[ "$(listener_pid 127.0.0.1 3005)" == 100 ]]
  [[ "$(screen_pid "$SCREEN_PREFIX-web")" == 200 ]]
}

test_real_bind_collision() {
  "$PYTHON" - "$REPO_ROOT" <<'PY'
import os, socket, subprocess, sys
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    sock.listen()
    port = str(sock.getsockname()[1])
    code = '''BEAMLINE_REVIEW_TEST_MODE=1 source "$1/scripts/deploy-beamline-review.sh"
PYTHON="$2"
assert_bind_available 127.0.0.1 "$3"
'''
    result = subprocess.run(['bash', '-c', code, 'test-bind', sys.argv[1], sys.executable, port], capture_output=True)
    assert result.returncode != 0, 'occupied address was accepted'
PY
}

identity_fixture() {
  fixture_release="$TEST_ROOT/release"
  fixture_screen=100
  fixture_listener=200
  fixture_start=1234
  fixture_uid=$(id -u)
  fixture_parent=100
  fixture_cwd="$fixture_release/backend"
  fixture_revision="$SHA"
  fixture_frontend_revision="$SHA"
  fixture_data="$DATA_ROOT"
  screen_pid() { printf '%s\n' "$fixture_screen"; }
  listener_pid() { printf '%s\n' "$fixture_listener"; }
  process_start() { printf '%s\n' "$fixture_start"; }
  process_uid() { printf '%s\n' "$fixture_uid"; }
  process_parent() { printf '%s\n' "$fixture_parent"; }
  process_cwd() { printf '%s\n' "$fixture_cwd"; }
  process_env() { printf 'XRAYLARCH_GIT_REVISION=%s\nXRAYLARCH_DATA_ROOT=%s\n' "$fixture_revision" "$fixture_data"; }
  process_args() { printf '%s/backend/.venv/bin/python -m uvicorn xraylarch_web.main:app --host 127.0.0.1 --port 8009 ' "$fixture_release"; }
  printf '%s 100 1234 200 1234\n' "$SHA" > "$STATE_ROOT/api.record"
}

test_identity_rejects_collisions() {
  identity_fixture
  verify_record api "$fixture_release"
  fixture_listener=201
  expect_failure verify_record api "$fixture_release"
  fixture_listener=200
  fixture_start=9999
  expect_failure verify_record api "$fixture_release"
  fixture_start=1234
  fixture_cwd=/some/other/app/backend
  expect_failure verify_record api "$fixture_release"
  fixture_cwd="$fixture_release/backend"
  fixture_revision=another-revision
  expect_failure verify_record api "$fixture_release"
  fixture_revision="$SHA"
  fixture_data=/other/data
  expect_failure verify_record api "$fixture_release"
  fixture_data="$DATA_ROOT"
  fixture_uid=999999
  expect_failure verify_record api "$fixture_release"
  fixture_uid=$(id -u)
  fixture_parent=1
  expect_failure verify_record api "$fixture_release"
}

test_stop_never_signals_collision() {
  identity_fixture
  fixture_listener=201
  screen() { touch "$TEST_ROOT/signal-sent"; }
  expect_failure stop_component api "$fixture_release"
  [[ ! -e "$TEST_ROOT/signal-sent" ]]
}

test_stale_record_cleanup_is_guarded() {
  identity_fixture
  screen_pid() { :; }
  assert_bind_available() { :; }
  expect_failure discard_stopped_records
  [[ -f "$STATE_ROOT/api.record" ]]
  process_start() { return 1; }
  discard_stopped_records
  [[ ! -e "$STATE_ROOT/api.record" ]]
  printf '%s 100 1234 200 1234\n' "$SHA" > "$STATE_ROOT/api.record"
  assert_bind_available() { [[ "$2" != 3005 ]]; }
  expect_failure discard_stopped_records
  [[ -f "$STATE_ROOT/api.record" ]]
}

test_clean_environment() {
  SHA="$SHA" MP_API_KEY=must-not-leak DRXAS_SECRET=must-not-leak clean_env /usr/bin/env > "$TEST_ROOT/env"
  ! grep -q 'must-not-leak' "$TEST_ROOT/env"
  grep -q '^XRAYLARCH_DATA_ROOT=' "$TEST_ROOT/env"
  grep -q '^BACKEND_URL=http://127.0.0.1:8009$' "$TEST_ROOT/env"
  grep -q "^XRAYLARCH_GIT_REVISION=$SHA$" "$TEST_ROOT/env"
}

test_direct_revision_and_status_only_proxy() {
  fixture_revision="$SHA"
  fixture_frontend_revision="$SHA"
  fixture_proxy_status=ok
  verify_record() { :; }
  curl() {
    case "${!#}" in
      http://127.0.0.1:8009/health) printf '{"status":"ok","git_revision":"%s"}' "$fixture_revision" ;;
      http://164.54.109.10:3005/api/backend/health) printf '{"status":"%s"}' "$fixture_proxy_status" ;;
      http://164.54.109.10:3005/) printf '<div data-build-sha="%s">version</div>' "$fixture_frontend_revision" ;;
      *) return 1 ;;
    esac
  }
  health "$TEST_ROOT/release" >/dev/null
  fixture_revision=wrong
  expect_failure health "$TEST_ROOT/release"
  fixture_revision="$SHA"
  fixture_proxy_status=failed
  expect_failure health "$TEST_ROOT/release"
  fixture_proxy_status=ok
  fixture_frontend_revision=stale
  expect_failure health "$TEST_ROOT/release"
}

test_release_revision_and_source_validation() {
  local release seed
  seed="$TEST_ROOT/git-seed"
  mkdir -p "$seed" "$RELEASES_ROOT"
  git -C "$seed" init --quiet
  git -C "$seed" checkout -qb "$BRANCH"
  printf 'committed source\n' > "$seed/source.txt"
  git -C "$seed" add source.txt
  git -C "$seed" -c user.name=Test -c user.email=test@example.invalid commit -qm fixture
  SHA=$(git -C "$seed" rev-parse HEAD)
  release=$(release_path "$SHA")
  mv "$seed" "$release"
  validate_release "$SHA"
  printf 'changed source\n' > "$release/source.txt"
  expect_failure validate_release "$SHA"
  git -C "$release" checkout -- source.txt
  git -C "$release" branch -m another-branch
  expect_failure validate_release "$SHA"
}

test_partial_launch_cleanup() {
  local release="$TEST_ROOT/release"
  rm -f "$STATE_ROOT/api.record" "$STATE_ROOT/web.record"
  discard_stopped_records() { :; }
  screen_pid() { :; }
  assert_bind_available() { :; }
  launch_component() {
    [[ "$1" != web ]] || return 1
    printf 'newly created\n' > "$STATE_ROOT/api.record"
  }
  wait_http() { :; }
  stop_component() {
    [[ "$1" == api ]] || exit 1
    rm "$STATE_ROOT/api.record"
    touch "$TEST_ROOT/cleaned-api"
  }
  expect_failure start_pair "$release"
  [[ -f "$TEST_ROOT/cleaned-api" && ! -e "$STATE_ROOT/api.record" ]]
}

test_pending_current_link_collision() {
  local release="$TEST_ROOT/release"
  ln -s "$release" "$STATE_ROOT/current.next"
  prepare_current_link "$release"
  [[ ! -L "$STATE_ROOT/current.next" ]]
  ln -s /other/application "$STATE_ROOT/current.next"
  expect_failure prepare_current_link "$release"
  [[ "$(readlink "$STATE_ROOT/current.next")" == /other/application ]]
}

run_test test_sha_and_build_marker
run_test test_exact_listener_and_screen_matching
run_test test_real_bind_collision
run_test test_identity_rejects_collisions
run_test test_stop_never_signals_collision
run_test test_stale_record_cleanup_is_guarded
run_test test_clean_environment
run_test test_direct_revision_and_status_only_proxy
run_test test_release_revision_and_source_validation
run_test test_partial_launch_cleanup
run_test test_pending_current_link_collision
printf '%s deployment tests passed\n' "$passed"
