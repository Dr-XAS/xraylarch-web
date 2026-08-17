#!/usr/bin/env bash
# Read-only health and identity checks for the active XrayLarch Web release.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
XRAYLARCH_WEB_TEST_MODE=1 source "${SCRIPT_DIR}/deploy-xraylarch-web.sh"

usage() {
  cat <<'EOF'
Usage:
  check-xraylarch-web.sh check <full-sha>

Runs read-only HTTP, screen, listener, process-working-directory, command, and
release checks. A full SHA is exactly 40 lowercase hexadecimal characters.
--help performs no host write.
EOF
}

parse_check_arguments() {
  case "${1:-}" in
    --help|-h) usage; exit 0 ;;
    check)
      REQUESTED_SHA="${2:-}"
      [[ $# -eq 2 ]] || { fail "check requires exactly one full SHA"; return 1; }
      validate_sha "$REQUESTED_SHA"
      ;;
    *) usage >&2; return 2 ;;
  esac
}

check_release() {
  [[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" ]] || { fail "private mutable data root is absent or symlinked"; return 1; }
  read_current_release || { fail "current release symlink is absent or invalid"; return 1; }
  [[ "$CURRENT_SHA" == "$REQUESTED_SHA" ]] || { fail "current release is not the requested SHA"; return 1; }
  capture_component_record CHECK_FRONTEND "$FRONTEND_SCREEN" "$CURRENT_RELEASE" frontend \
    "$FINAL_FRONTEND_HOST" "$FINAL_FRONTEND_PORT" || return 1
  capture_component_record CHECK_BACKEND "$BACKEND_SCREEN" "$CURRENT_RELEASE" backend \
    "$FINAL_BACKEND_HOST" "$FINAL_BACKEND_PORT" || return 1
  verify_component_pair CHECK_FRONTEND CHECK_BACKEND "$FINAL_FRONTEND_HOST" \
    "$FINAL_FRONTEND_PORT" "$FINAL_BACKEND_URL" 1 || return 1
  printf 'healthy sha=%s release=%s\n' "$REQUESTED_SHA" "$CURRENT_RELEASE"
}

main() {
  parse_check_arguments "$@" || return $?
  initialize_commands || return 1
  check_release
}

main "$@"
