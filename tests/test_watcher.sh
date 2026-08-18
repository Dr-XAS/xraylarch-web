#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
watcher="$repo_root/scripts/start-watcher.sh"
status_script="$repo_root/scripts/check-xraylarch-web-watcher.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

bash -n "$watcher" || fail "watcher must have valid shell syntax"
bash -n "$status_script" || fail "status script must have valid shell syntax"

test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/state/watcher" "$test_root/repo"

sha=0123456789abcdef0123456789abcdef01234567
cat >"$test_root/bin/git" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$*" == *' fetch origin codex/xraylarch-web-v1 -q' ]]; then
  exit 0
fi
if [[ "$*" == *' rev-parse origin/codex/xraylarch-web-v1' ]]; then
  printf '%s\n' "${TEST_REMOTE_SHA:?}"
  exit 0
fi
printf 'unexpected git call: %s\n' "$*" >&2
exit 1
EOF
cat >"$test_root/bin/install" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
while [[ $# -gt 0 && "$1" == -* ]]; do
  case "$1" in
    -d) shift ;;
    -m) shift 2 ;;
    *) shift ;;
  esac
done
for path in "$@"; do
  /bin/mkdir -p "$path"
done
EOF
cat >"$test_root/bin/mktemp" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
pattern="$1"
dir="${pattern%/*}"
/bin/mkdir -p "$dir"
file="${pattern//XXXXXX/test}"
: >"$file"
printf '%s\n' "$file"
EOF
cat >"$test_root/bin/chmod" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
/usr/bin/chmod "$@"
EOF
cat >"$test_root/bin/mv" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
/usr/bin/mv "$@"
EOF
cat >"$test_root/bin/date" <<'EOF'
#!/usr/bin/env bash
printf '2026-08-18T00:00:00Z\n'
EOF
cat >"$test_root/bin/tee" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
file="${@: -1}"
/usr/bin/tee "$file"
EOF
cat >"$test_root/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$test_root/bin/timeout" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
shift
"$@" &
pid=$!
sleep 0.05
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
exit 0
EOF
cat >"$test_root/deploy.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${TEST_DEPLOY_LOG:?}"
exit "${TEST_DEPLOY_EXIT:-0}"
EOF
for utility in install mktemp chmod mv date tee sleep timeout; do
  /bin/mv "$test_root/bin/$utility" "$test_root/bin/$utility.mock"
done
chmod +x "$test_root/bin/git" "$test_root/deploy.sh"

printf 'sha=%s\nrelease=/release\n' "$sha" >"$test_root/last-successful"
printf '%s\n' "$sha" >"$test_root/remote-sha"

# The first poll is a no-op when the deployer's canonical marker is current.
TEST_REMOTE_SHA="$sha" TEST_DEPLOY_LOG="$test_root/deploy.log" \
PATH="$test_root/bin:$PATH" TEST_REMOTE_SHA="$sha" XRAYLARCH_WEB_REPO_DIR="$test_root/repo" \
XRAYLARCH_WEB_DEPLOY_SCRIPT="$test_root/deploy.sh" \
XRAYLARCH_WEB_WATCH_STATE_ROOT="$test_root/state/watcher" \
XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE="$test_root/last-successful" \
XRAYLARCH_WEB_WATCH_LOG="$test_root/watcher.log" \
XRAYLARCH_WEB_WATCH_INTERVAL=1 XRAYLARCH_WEB_WATCH_ONCE=1 "$watcher" >/dev/null 2>&1 || true
[[ ! -s "$test_root/deploy.log" ]] || fail "current SHA must not redeploy"
[[ "$(<"$test_root/state/watcher/last-observed-remote-sha")" == "$sha" ]] || fail "observed SHA must be recorded"

# A failed deploy must not advance watcher success state.
rm -f "$test_root/last-successful" "$test_root/state/watcher/last-successful-sha"
TEST_REMOTE_SHA="$sha" TEST_DEPLOY_EXIT=1 TEST_DEPLOY_LOG="$test_root/deploy.log" \
PATH="$test_root/bin:$PATH" TEST_REMOTE_SHA="$sha" XRAYLARCH_WEB_REPO_DIR="$test_root/repo" \
XRAYLARCH_WEB_DEPLOY_SCRIPT="$test_root/deploy.sh" \
XRAYLARCH_WEB_WATCH_STATE_ROOT="$test_root/state/watcher" \
XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE="$test_root/last-successful" \
XRAYLARCH_WEB_WATCH_LOG="$test_root/watcher.log" \
XRAYLARCH_WEB_WATCH_INTERVAL=1 XRAYLARCH_WEB_WATCH_ONCE=1 "$watcher" >/dev/null 2>&1 || true
[[ ! -e "$test_root/state/watcher/last-successful-sha" ]] || fail "failed deploy must not advance success state"
[[ "$(wc -l <"$test_root/deploy.log")" -ge 1 ]] || fail "new SHA must invoke deployer"

# The status command is read-only and reports configured state.
status_output=$(XRAYLARCH_WEB_WATCH_STATE_ROOT="$test_root/state/watcher" \
  XRAYLARCH_WEB_LAST_SUCCESSFUL_STATE="$test_root/last-successful" \
  XRAYLARCH_WEB_WATCH_LOG="$test_root/watcher.log" \
  XRAYLARCH_WEB_REPO_DIR="$test_root/repo" \
  "$status_script" status)
[[ "$status_output" == *"branch=codex/xraylarch-web-v1"* ]] || fail "status must report branch"
[[ "$status_output" == *"observed_sha=$sha"* ]] || fail "status must report observed SHA"
printf 'watcher tests passed\n'
