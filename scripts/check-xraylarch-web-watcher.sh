#!/usr/bin/env bash
# Read-only status report for the XrayLarch Web deployment watcher.
set -Eeuo pipefail
umask 077

APP_ROOT="${XRAYLARCH_WEB_APP_ROOT:-/local/apps/xraylarch-web}"
STATE_ROOT="${XRAYLARCH_WEB_WATCH_STATE_ROOT:-${APP_ROOT}/state/watcher}"
DEPLOY_STATE="${XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE:-${APP_ROOT}/state/last-successful}"
LOG="${XRAYLARCH_WEB_WATCH_LOG:-/tmp/xraylarch-web-watch.log}"
SCREEN_NAME="${XRAYLARCH_WEB_WATCH_SCREEN:-xraylarch-web-watch}"
REPO_DIR="${XRAYLARCH_WEB_REPO_DIR:-/local/apps/xraylarch-web/control}"
BRANCH="${XRAYLARCH_WEB_BRANCH:-codex/xraylarch-web-v1}"

usage() {
  printf 'Usage: %s status\n' "$(basename "$0")"
}

screen_status() {
  if ! command -v screen >/dev/null 2>&1; then
    printf 'screen=unavailable\n'
  elif screen -ls 2>/dev/null | grep -Eq "^[[:space:]]*[0-9]+\.${SCREEN_NAME}[[:space:]]"; then
    printf 'screen=running name=%s\n' "$SCREEN_NAME"
  else
    printf 'screen=stopped name=%s\n' "$SCREEN_NAME"
  fi
}

state_value() {
  local file="$1"
  if [[ -f "$file" && ! -L "$file" ]]; then
    tr '\n' ' ' <"$file"
    printf '\n'
  else
    printf 'missing\n'
  fi
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  status)
    screen_status
    printf 'repo=%s\nbranch=%s\n' "$REPO_DIR" "$BRANCH"
    printf 'observed_sha='; state_value "$STATE_ROOT/last-observed-remote-sha"
    printf 'observed_at='; state_value "$STATE_ROOT/last-observed-remote-at"
    printf 'watcher_success_sha='; state_value "$STATE_ROOT/last-successful-sha"
    printf 'watcher_success_at='; state_value "$STATE_ROOT/last-successful-at"
    printf 'deployer_success_state='; state_value "$DEPLOY_STATE"
    printf 'log=%s\n' "$LOG"
    ;;
  *) usage >&2; exit 2 ;;
esac
