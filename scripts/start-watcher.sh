#!/usr/bin/env bash
# Exact-SHA polling watcher for the host-only XrayLarch Web deployer.
set -Eeuo pipefail
umask 077

REPO_DIR="${XRAYLARCH_WEB_REPO_DIR:-/local/xraylarch-web}"
DEPLOY_SCRIPT="${XRAYLARCH_WEB_DEPLOY_SCRIPT:-/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh}"
BRANCH="${XRAYLARCH_WEB_BRANCH:-codex/xraylarch-web-v1}"
STATE_ROOT="${XRAYLARCH_WEB_WATCH_STATE_ROOT:-/local/apps/xraylarch-web/state/watcher}"
LAST_SUCCESSFUL_STATE="${XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE:-/local/apps/xraylarch-web/state/last-successful}"
LOG="${XRAYLARCH_WEB_WATCH_LOG:-/tmp/xraylarch-web-watch.log}"
POLL_INTERVAL="${XRAYLARCH_WEB_WATCH_INTERVAL:-60}"
RUN_ONCE="${XRAYLARCH_WEB_WATCH_ONCE:-0}"

log() {
  printf '[watcher] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"
}

write_atomic() {
  local target="$1" value="$2" temporary
  install -d -m 0700 "$(dirname "$target")"
  temporary="$(mktemp "${target}.tmp.XXXXXX")"
  chmod 600 "$temporary"
  printf '%s\n' "$value" >"$temporary"
  mv -f "$temporary" "$target"
}

read_successful_sha() {
  local sha=""
  if [[ -f "$LAST_SUCCESSFUL_STATE" && ! -L "$LAST_SUCCESSFUL_STATE" ]]; then
    sha="$(awk -F= '$1 == "sha" { print $2; exit }' "$LAST_SUCCESSFUL_STATE")"
  fi
  if [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' "$sha"
  fi
}

[[ "$POLL_INTERVAL" =~ ^[1-9][0-9]*$ ]] || {
  printf 'ERROR: watcher interval must be a positive integer\n' >&2
  exit 2
}
install -d -m 0700 "$STATE_ROOT"
install -d -m 0700 "$(dirname "$LOG")"
log "started; polling origin/${BRANCH} every ${POLL_INTERVAL}s"

while true; do
  if git -C "$REPO_DIR" fetch origin "$BRANCH" -q 2>>"$LOG"; then
    remote_sha="$(git -C "$REPO_DIR" rev-parse "origin/${BRANCH}")"
    if [[ ! "$remote_sha" =~ ^[0-9a-f]{40}$ ]]; then
      log "refusing invalid remote SHA: ${remote_sha}"
      sleep "$POLL_INTERVAL"
      continue
    fi
    write_atomic "$STATE_ROOT/last-observed-remote-sha" "$remote_sha"
    write_atomic "$STATE_ROOT/last-observed-remote-at" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

    successful_sha="$(read_successful_sha || true)"
    if [[ "$remote_sha" == "$successful_sha" ]]; then
      log "${remote_sha:0:12} already active"
    else
      previous="${successful_sha:-none}"
      log "deploying ${remote_sha:0:12} (last success: ${previous:0:12})"
      if bash "$DEPLOY_SCRIPT" deploy "$remote_sha" >>"$LOG" 2>&1; then
        write_atomic "$STATE_ROOT/last-successful-sha" "$remote_sha"
        write_atomic "$STATE_ROOT/last-successful-at" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
        log "deployment succeeded for ${remote_sha:0:12}"
      else
        log "deployment failed for ${remote_sha:0:12}; retrying after the next poll"
      fi
    fi
  else
    log "fetch failed; retaining the active release and retrying after the next poll"
  fi
  [[ "$RUN_ONCE" == 1 ]] && exit 0
  sleep "$POLL_INTERVAL"
done
