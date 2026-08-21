#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
helper="$repo_root/scripts/ensure-watcher.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
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
  XRAYLARCH_WEB_BRANCH=codex/xraylarch-web-v1
  XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE="$test_root/last-successful"
  XRAYLARCH_WEB_WATCH_LOG="$test_root/watcher.log"
  XRAYLARCH_WEB_WATCH_INTERVAL=60
)

env "${common_env[@]}" \
  XRAYLARCH_WEB_SIBLING_PROFILE=goldendale \
  XRAYLARCH_WEB_WATCH_PATH=/opt/miniconda/bin:/usr/bin \
  "$helper" || fail "missing watcher screen must be created"
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

printf '301.xraylarch-web-watch (Detached)\n302.xraylarch-web-watch (Detached)\n' >"$test_root/sessions"
if env "${common_env[@]}" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale "$helper"; then
  fail "ambiguous exact watcher screens must fail closed"
fi
[[ "$(grep -c '^start$' "$test_root/screen-start.log")" -eq 2 ]] ||
  fail "ambiguous watcher screens must not be stopped or replaced"

printf '' >"$test_root/sessions"
if env "${common_env[@]}" FLOCK_BIN="$test_root/bin/bad-flock" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale "$helper"; then
  fail "lock command errors must fail closed"
fi

printf '' >"$test_root/sessions"
env "${common_env[@]}" HOME="$test_root/home" XRAYLARCH_WEB_WATCH_STATE_ROOT="$test_root/state/default-path" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale "$helper"
grep -F '/usr/sbin:/bin:/sbin' "$test_root/screen-start.log" >/dev/null ||
  fail "default watcher PATH must include system administration binaries"

printf 'watcher bootstrap tests passed\n'
