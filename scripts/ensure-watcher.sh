#!/usr/bin/env bash
# Idempotently ensure that the host-only XrayLarch Web watcher has one screen.
set -Eeuo pipefail
umask 077

APP_ROOT="${XRAYLARCH_WEB_APP_ROOT:-/local/apps/xraylarch-web}"
SCREEN_NAME="${XRAYLARCH_WEB_WATCH_SCREEN:-xraylarch-web-watch}"
WATCHER_SCRIPT="${XRAYLARCH_WEB_WATCHER_SCRIPT:-${APP_ROOT}/ops/start-watcher.sh}"
STATE_ROOT="${XRAYLARCH_WEB_WATCH_STATE_ROOT:-${APP_ROOT}/state/watcher}"
SIBLING_PROFILE="${XRAYLARCH_WEB_SIBLING_PROFILE:-drxas}"
WATCH_PATH="${XRAYLARCH_WEB_WATCH_PATH:-${HOME:-/home/beams/HUANG.JEFFREY}/miniconda3/bin:/usr/local/bin:/usr/bin:/bin}"
SCREEN_BIN="${SCREEN_BIN:-/usr/bin/screen}"
FLOCK_BIN="${FLOCK_BIN:-$(command -v flock 2>/dev/null || true)}"

REPO_DIR="${XRAYLARCH_WEB_REPO_DIR:-${APP_ROOT}/control}"
DEPLOY_SCRIPT="${XRAYLARCH_WEB_DEPLOY_SCRIPT:-${APP_ROOT}/ops/deploy-xraylarch-web.sh}"
BRANCH="${XRAYLARCH_WEB_BRANCH:-codex/xraylarch-web-v1}"
LAST_SUCCESSFUL_STATE="${XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE:-${APP_ROOT}/state/last-successful}"
LOG="${XRAYLARCH_WEB_WATCH_LOG:-/tmp/xraylarch-web-watch.log}"
POLL_INTERVAL="${XRAYLARCH_WEB_WATCH_INTERVAL:-60}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  return 1
}

log() {
  printf '[watcher-bootstrap] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

[[ "$SCREEN_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || {
  fail "watcher screen name contains unsupported characters"
  exit 2
}
case "$SIBLING_PROFILE" in
  drxas|goldendale) ;;
  *)
    fail "unsupported sibling service profile: $SIBLING_PROFILE"
    exit 2
    ;;
esac
[[ -x "$SCREEN_BIN" && ! -L "$SCREEN_BIN" ]] || {
  fail "screen binary is absent, non-executable, or symlinked: $SCREEN_BIN"
  exit 1
}
[[ -n "$FLOCK_BIN" && -x "$FLOCK_BIN" && ! -L "$FLOCK_BIN" ]] || {
  fail "flock binary is absent, non-executable, or symlinked: $FLOCK_BIN"
  exit 1
}
[[ -f "$WATCHER_SCRIPT" && ! -L "$WATCHER_SCRIPT" && -x "$WATCHER_SCRIPT" ]] || {
  fail "watcher script is absent, non-executable, or symlinked: $WATCHER_SCRIPT"
  exit 1
}
[[ -n "$WATCH_PATH" ]] || {
  fail "watcher PATH must not be empty"
  exit 2
}
[[ "$POLL_INTERVAL" =~ ^[1-9][0-9]*$ ]] || {
  fail "watcher interval must be a positive integer"
  exit 2
}

if [[ -e "$STATE_ROOT" || -L "$STATE_ROOT" ]]; then
  [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || {
    fail "watcher state root is absent, non-directory, or symlinked: $STATE_ROOT"
    exit 1
  }
else
  install -d -m 0700 "$STATE_ROOT"
fi

LOCK_FILE="$STATE_ROOT/ensure.lock"
[[ ! -L "$LOCK_FILE" ]] || {
  fail "watcher lock is symlinked: $LOCK_FILE"
  exit 1
}
exec 9>"$LOCK_FILE"
if "$FLOCK_BIN" -n 9; then
  :
else
  lock_status=$?
  if [[ "$lock_status" -eq 1 ]]; then
    log "another bootstrap invocation is reconciling the watcher"
    exit 0
  fi
  fail "flock failed while reconciling the watcher: status=$lock_status"
  exit 1
fi

screen_sessions_for_name() {
  "$SCREEN_BIN" -ls 2>/dev/null |
    awk -v target="$SCREEN_NAME" '$1 ~ ("^[0-9]+\\." target "$") { print $1 }'
}

sessions=()
while IFS= read -r session; do
  [[ -z "$session" ]] || sessions+=("$session")
done < <(screen_sessions_for_name)
case "${#sessions[@]}" in
  0)
    env_args=(
      "PATH=$WATCH_PATH"
      "XRAYLARCH_WEB_SIBLING_PROFILE=$SIBLING_PROFILE"
      "XRAYLARCH_WEB_REPO_DIR=$REPO_DIR"
      "XRAYLARCH_WEB_DEPLOY_SCRIPT=$DEPLOY_SCRIPT"
      "XRAYLARCH_WEB_BRANCH=$BRANCH"
      "XRAYLARCH_WEB_WATCH_STATE_ROOT=$STATE_ROOT"
      "XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE=$LAST_SUCCESSFUL_STATE"
      "XRAYLARCH_WEB_WATCH_LOG=$LOG"
      "XRAYLARCH_WEB_WATCH_INTERVAL=$POLL_INTERVAL"
    )
    log "starting screen $SCREEN_NAME with sibling_profile=$SIBLING_PROFILE"
    "$SCREEN_BIN" -dmS "$SCREEN_NAME" /usr/bin/env "${env_args[@]}" bash "$WATCHER_SCRIPT"
    ;;
  1)
    log "screen $SCREEN_NAME already running"
    ;;
  *)
    fail "multiple exact watcher screens found: ${sessions[*]}"
    exit 1
    ;;
esac
