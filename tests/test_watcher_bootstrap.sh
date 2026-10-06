#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
helper="$repo_root/scripts/ensure-watcher.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# Resolve the host's real flock before the stub directory shadows it on PATH.
real_flock=$(command -v flock 2>/dev/null || true)

# Run the helper for a case that must fail closed. Its stderr goes to a file
# and must contain the exact refusal, so an unrelated earlier failure (missing
# screen, bad state root, ...) cannot satisfy the case by accident.
expect_refusal() {
  local label="$1" expected="$2"
  shift 2
  local stderr_file="$test_root/refusal.err"
  if env "${common_env[@]}" "$@" "$helper" 2>"$stderr_file"; then
    fail "$label: helper must fail closed"
  fi
  grep -Fx "ERROR: $expected" "$stderr_file" >/dev/null || {
    cat "$stderr_file" >&2
    fail "$label: expected refusal 'ERROR: $expected'"
  }
  printf 'ok: %s refused as expected: %s\n' "$label" "$expected"
}

test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/state/watcher"
: >"$test_root/sessions"

cat >"$test_root/bin/screen" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

root="${TEST_SCREEN_ROOT:?}"
sessions="$root/sessions"
starts="$root/screen-start.log"

case "${1:-}" in
  -ls)
    cat "$sessions"
    ;;
  -dmS)
    name="${2:?missing screen name}"
    shift 2
    printf 'start\n' >>"$starts"
    for argument in "$@"; do
      case "$argument" in
        PATH=*|XRAYLARCH_WEB_SIBLING_PROFILE=*|XRAYLARCH_WEB_REPO_DIR=*|XRAYLARCH_WEB_DEPLOY_SCRIPT=*|XRAYLARCH_WEB_BRANCH=*|XRAYLARCH_WEB_WATCH_STATE_ROOT=*|XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE=*|XRAYLARCH_WEB_WATCH_LOG=*|XRAYLARCH_WEB_WATCH_INTERVAL=*)
          printf '%s\n' "$argument" >>"$starts"
          ;;
      esac
    done
    printf '101.%s (Detached)\n' "$name" >"$sessions"
    ;;
  *)
    printf 'unexpected screen invocation: %s\n' "$*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$test_root/bin/screen"
cat >"$test_root/bin/flock" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == -n && "${2:-}" == 9 ]] || {
  printf 'unexpected flock invocation: %s\n' "$*" >&2
  exit 1
}
printf 'flock %s\n' "$*" >>"${TEST_SCREEN_ROOT:?}/flock.log"
EOF
chmod +x "$test_root/bin/flock"
cat >"$test_root/bin/bad-flock" <<'EOF'
#!/usr/bin/env bash
exit 2
EOF
chmod +x "$test_root/bin/bad-flock"

common_env=(
  TEST_SCREEN_ROOT="$test_root"
  PATH="$test_root/bin:$PATH"
  SCREEN_BIN="$test_root/bin/screen"
  XRAYLARCH_WEB_WATCH_SCREEN=xraylarch-web-watch
  XRAYLARCH_WEB_WATCHER_SCRIPT="$repo_root/scripts/start-watcher.sh"
  XRAYLARCH_WEB_WATCH_STATE_ROOT="$test_root/state/watcher"
  XRAYLARCH_WEB_REPO_DIR="$test_root/repo"
  XRAYLARCH_WEB_DEPLOY_SCRIPT="$test_root/deploy.sh"
  XRAYLARCH_WEB_BRANCH=master
  XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE="$test_root/last-successful"
  XRAYLARCH_WEB_WATCH_LOG="$test_root/watcher.log"
  XRAYLARCH_WEB_WATCH_INTERVAL=60
)

env "${common_env[@]}" \
  XRAYLARCH_WEB_SIBLING_PROFILE=goldendale \
  XRAYLARCH_WEB_WATCH_PATH=/opt/miniconda/bin:/usr/bin \
  "$helper" || fail "missing watcher screen must be created"
grep -Fx 'XRAYLARCH_WEB_BRANCH=master' "$test_root/screen-start.log" >/dev/null ||
  fail "bootstrap must default to the live master branch"
grep -Fx 'XRAYLARCH_WEB_SIBLING_PROFILE=goldendale' "$test_root/screen-start.log" >/dev/null ||
  fail "bootstrap must pass the Goldendale profile"
grep -Fx 'PATH=/opt/miniconda/bin:/usr/bin' "$test_root/screen-start.log" >/dev/null ||
  fail "bootstrap must pass the configured executable PATH"
[[ "$(grep -c '^start$' "$test_root/screen-start.log")" -eq 1 ]] ||
  fail "bootstrap must create one watcher screen"

env "${common_env[@]}" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale "$helper" ||
  fail "existing exact watcher screen must be accepted"
[[ "$(grep -c '^start$' "$test_root/screen-start.log")" -eq 1 ]] ||
  fail "existing exact watcher screen must not be duplicated"

printf '202.xraylarch-web-watch-extra (Detached)\n' >"$test_root/sessions"
env "${common_env[@]}" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale "$helper" ||
  fail "prefixed non-matching screen must not block bootstrap"
[[ "$(grep -c '^start$' "$test_root/screen-start.log")" -eq 2 ]] ||
  fail "prefixed screen name must not count as the watcher"

[[ "$(grep -c '^flock -n 9$' "$test_root/flock.log")" -eq 3 ]] ||
  fail "every reconcile must take the watcher lock before inspecting screens"

printf '301.xraylarch-web-watch (Detached)\n302.xraylarch-web-watch (Detached)\n' >"$test_root/sessions"
expect_refusal "ambiguous exact watcher screens" \
  "multiple exact watcher screens found: 301.xraylarch-web-watch 302.xraylarch-web-watch" \
  XRAYLARCH_WEB_SIBLING_PROFILE=goldendale
[[ "$(grep -c '^start$' "$test_root/screen-start.log")" -eq 2 ]] ||
  fail "ambiguous watcher screens must not be stopped or replaced"

# bad-flock is a stub that exits 2, standing in for a flock usage or I/O error.
# The helper must treat any status other than 0 (locked) or 1 (held elsewhere)
# as fatal and must not touch screen.
printf '' >"$test_root/sessions"
expect_refusal "flock error status 2" \
  "flock failed while reconciling the watcher: status=2" \
  FLOCK_BIN="$test_root/bin/bad-flock" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale
[[ "$(grep -c '^start$' "$test_root/screen-start.log")" -eq 2 ]] ||
  fail "a flock error must not start a watcher screen"

printf '' >"$test_root/sessions"
env "${common_env[@]}" HOME="$test_root/home" XRAYLARCH_WEB_WATCH_STATE_ROOT="$test_root/state/default-path" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale "$helper"
grep -F '/usr/sbin:/bin:/sbin' "$test_root/screen-start.log" >/dev/null ||
  fail "default watcher PATH must include system administration binaries"

# The cases above use a stub flock. Exercise the real util-linux flock so the
# lock itself, and the "already held" path, are checked on Linux hosts and CI.
if [[ -z "$real_flock" ]]; then
  if [[ -n "${GITHUB_ACTIONS:-}" || -n "${CI:-}" ]]; then
    fail "real flock is required in CI to check watcher lock contention"
  fi
  printf 'SKIP: real flock lock checks (no flock on this host; they run on Linux CI)\n'
else
  real_state="$test_root/state/real-flock"
  real_env=(FLOCK_BIN="$real_flock" XRAYLARCH_WEB_WATCH_STATE_ROOT="$real_state" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale)
  starts_before=$(grep -c '^start$' "$test_root/screen-start.log")

  printf '' >"$test_root/sessions"
  env "${common_env[@]}" "${real_env[@]}" "$helper" ||
    fail "real flock: uncontended reconcile must succeed"
  [[ "$(grep -c '^start$' "$test_root/screen-start.log")" -eq $((starts_before + 1)) ]] ||
    fail "real flock: uncontended reconcile must start the missing watcher"
  [[ -f "$real_state/ensure.lock" ]] || fail "real flock: lock file must be created"
  printf 'ok: real flock (%s) took the watcher lock and started the screen\n' "$real_flock"

  # Hold the lock from this shell on a separate open file description, as a
  # concurrent bootstrap would, then reconcile with no watcher screen present.
  printf '' >"$test_root/sessions"
  exec 8>"$real_state/ensure.lock"
  "$real_flock" -n 8 || fail "real flock: test could not take the watcher lock"
  contended_out=$(env "${common_env[@]}" "${real_env[@]}" "$helper") ||
    fail "real flock: a held lock must be treated as another reconcile, not an error"
  exec 8>&-
  grep -F 'another bootstrap invocation is reconciling the watcher' <<<"$contended_out" >/dev/null ||
    fail "real flock: held lock must report the concurrent reconcile"
  [[ "$(grep -c '^start$' "$test_root/screen-start.log")" -eq $((starts_before + 1)) ]] ||
    fail "real flock: held lock must not start a second watcher"
  printf 'ok: real flock held by another process exits 0 without starting a screen\n'

  env "${common_env[@]}" "${real_env[@]}" "$helper" ||
    fail "real flock: reconcile after the lock is released must succeed"
  [[ "$(grep -c '^start$' "$test_root/screen-start.log")" -eq $((starts_before + 2)) ]] ||
    fail "real flock: released lock must allow the watcher to start"
  printf 'ok: real flock released lock lets the next reconcile start the screen\n'
fi

printf 'watcher bootstrap tests passed\n'
