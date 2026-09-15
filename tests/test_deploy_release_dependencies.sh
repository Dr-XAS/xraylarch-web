#!/usr/bin/env bash
set -Eeuo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
XRAYLARCH_WEB_TEST_MODE=1 source "$repo_root/scripts/deploy-xraylarch-web.sh"
fail_test() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
release="$test_root/build"
mkdir -p "$release/backend/.venv/bin" "$release/deploy"
printf '%s\n' '-e ..' 'fastapi==0.116.1' 'xlwt==1.3.0' 'xlrd==2.0.2' > "$release/backend/requirements.txt"
printf '%s\n' 'fastapi==0.116.1' > "$release/deploy/python-release-constraints.txt"
run_clean() {
  printf '%s\n' "$PWD" > "$test_root/cwd"
  printf '%s\n' "$@" > "$test_root/args"
  if [[ "$*" == *'pip install'* ]]; then
    local previous='' argument
    for argument in "$@"; do
      [[ "$previous" != --requirement ]] || cp "$argument" "$test_root/installed-requirements"
      previous="$argument"
    done
  fi
  return "${command_status:-0}"
}
declare -F install_backend_requirements >/dev/null || fail_test 'backend requirement install helper is missing'
install_backend_requirements "$release" || fail_test 'backend dependency installation must succeed'
[[ "$(cat "$test_root/cwd")" == "$release/backend" ]] || fail_test 'requirements must resolve from backend cwd'
[[ "$(cat "$test_root/installed-requirements")" == $'fastapi==0.116.1\nxlwt==1.3.0\nxlrd==2.0.2' ]] || fail_test 'install backend dependencies while preserving wheel instead of editable root'
grep -Fx -- '--constraint' "$test_root/args" >/dev/null || fail_test 'constraints argument missing'
grep -Fx -- "$release/deploy/python-release-constraints.txt" "$test_root/args" >/dev/null || fail_test 'wrong constraints file'
command_status=7
if install_backend_requirements "$release"; then fail_test 'dependency installation failure must propagate'; fi
command_status=0
assert_backend_application_import "$release" || fail_test 'app import must succeed'
[[ "$(cat "$test_root/cwd")" == "$release/backend" ]] || fail_test 'app import must use backend cwd'
grep -Fx 'from xraylarch_web.main import app' "$test_root/args" >/dev/null || fail_test 'smoke must import complete application'
command_status=1
if assert_backend_application_import "$release"; then fail_test 'broken app import must fail'; fi
command_status=0


# CI and deployment must execute the same complete installer. Every dependency
# gate must fail before the immutable release or frontend can be published.
declare -F install_release_backend >/dev/null || fail_test 'shared release installer is missing'
for failure in constraints wheel backend app check freeze collection runtime; do
(
  XRAYLARCH_WEB_TEST_MODE=1 source "$repo_root/scripts/deploy-xraylarch-web.sh"
  RELEASES_ROOT="$test_root/build-releases-$failure"
  REQUESTED_SHA=0123456789abcdef0123456789abcdef01234567
  CONDA_BIN=/fake/conda
  CANDIDATE_DATA="$test_root/candidate-$failure"
  mkdir -p "$RELEASES_ROOT" "$CANDIDATE_DATA"
  events="$test_root/build-events-$failure"
  run_clean() {
    local stage=''
    case "$*" in
      'git init --quiet '*)
        local target="${@: -1}"
        mkdir -p "$target/backend/.venv/bin" "$target/frontend" "$target/deploy"
        printf '%s\n' '-e ..' 'xlwt==1.3.0' > "$target/backend/requirements.txt"
        : > "$target/deploy/python-release-constraints.txt"
        ;;
      *'rev-parse '*) printf '%s\n' "$REQUESTED_SHA" ;;
      *'git '*describe*) printf '1.0.0\n' ;;
      *'pip install --requirement '*'/deploy/python-release-constraints.txt '*) stage=constraints ;;
      *'pip wheel '*)
        stage=wheel
        mkdir -p ../.release-wheel
        : > ../.release-wheel/xraylarch-test.whl
        ;;
      *'pip install --requirement '*'.release-requirements.'*) stage=backend ;;
      *'from xraylarch_web.main import app'*) stage=app ;;
      *'pip check'*) stage=check ;;
      *'pip freeze'*) stage=freeze ;;
      *'pytest '*--collect-only*) stage=collection ;;
      *'pytest '*) stage=runtime ;;
      *'node -e '*|*'npm '*) fail_test 'frontend must not run after backend failure' ;;
    esac
    if [[ -n "$stage" ]]; then
      echo "$stage" >> "$events"
      [[ "$stage" != "$failure" ]] || return 7
    fi
  }
  if build_release; then fail_test "build must fail on $failure failure"; fi
  [[ "$(tail -n 1 "$events")" == "$failure" ]] || fail_test "build continued after $failure failure"
  [[ ! -e "$RELEASES_ROOT/$REQUESTED_SHA" ]] || fail_test "$failure failure published immutable release"
)
done
(
  XRAYLARCH_WEB_TEST_MODE=1 source "$repo_root/scripts/deploy-xraylarch-web.sh"
  RELEASES_ROOT="$test_root/helper-call"
  REQUESTED_SHA=0123456789abcdef0123456789abcdef01234567
  CONDA_BIN=/fake/conda
  mkdir -p "$RELEASES_ROOT"
  run_clean() {
    case "$*" in
      *'rev-parse '*) printf '%s\n' "$REQUESTED_SHA" ;;
      *'git '*describe*) printf '1.0.0\n' ;;
    esac
  }
  install_release_backend() { echo shared > "$test_root/shared-called"; return 7; }
  if build_release; then fail_test 'build ignored shared installer failure'; fi
  [[ "$(cat "$test_root/shared-called")" == shared ]] || fail_test 'production must call shared installer'
  [[ ! -e "$RELEASES_ROOT/$REQUESTED_SHA" ]] || fail_test 'shared installer failure published release'
)

# Runtime checks may mutate workspace data: use disposable candidate data even
# when the enclosing deployer points at the live database.
for failure in none collection runtime; do
(
  XRAYLARCH_WEB_TEST_MODE=1 source "$repo_root/scripts/deploy-xraylarch-web.sh"
  CANDIDATE_DATA="$test_root/verification-$failure"
  DATA_ROOT="$test_root/live-data"
  mkdir -p "$CANDIDATE_DATA" "$DATA_ROOT"
  printf 'preserve\n' > "$DATA_ROOT/sentinel"
  run_clean() {
    [[ "$DATA_ROOT" == "$CANDIDATE_DATA"/backend-verification.* ]] || fail_test 'verification used live data root'
    [[ -d "$DATA_ROOT" ]] || fail_test 'verification data root must exist'
    printf '%s\n' "$DATA_ROOT" >> "$CANDIDATE_DATA/observed-roots"
    local stage=runtime
    [[ "$*" != *--collect-only* ]] || stage=collection
    [[ "$stage" != "$failure" ]] || return 7
  }
  if verify_release_backend "$test_root/build"; then
    [[ "$failure" == none ]] || fail_test 'verification ignored test failure'
  else
    [[ "$failure" != none ]] || fail_test 'verification failed successful checks'
  fi
  [[ "$DATA_ROOT" == "$test_root/live-data" && "$(cat "$DATA_ROOT/sentinel")" == preserve ]] || fail_test 'verification altered live data'
  while IFS= read -r root; do
    [[ ! -e "$root" ]] || fail_test 'verification data was not cleaned up'
  done < "$CANDIDATE_DATA/observed-roots"
)
done
grep -F 'verify_release_backend "$GITHUB_WORKSPACE"' "$repo_root/.github/workflows/test-web-backend-release.yml" >/dev/null || fail_test 'CI must invoke shared runtime verification'

RELEASES_ROOT="$test_root/releases"
REQUESTED_SHA=0123456789abcdef0123456789abcdef01234567
mkdir -p "$RELEASES_ROOT"
release="$RELEASES_ROOT/$REQUESTED_SHA"
events="$test_root/events"
verify_remote_branch_tip() { echo remote >> "$events"; return "${remote_status:-0}"; }
build_release() { echo build >> "$events"; }
activate_release() { echo activate >> "$events"; }
assert_release_identity() {
  echo identity >> "$events"
  [[ -d "$release" && ! -L "$release" && -f "$release/.xraylarch-release.sha" ]]
}
assert_backend_application_import() { echo smoke >> "$events"; return "${smoke_status:-0}"; }
: > "$events"
perform_deploy || fail_test 'absent release must build'
[[ "$(cat "$events")" == $'remote\nbuild\nactivate' ]] || fail_test 'new release must build after remote verification'
mkdir -p "$release"
printf '%s\n' "$REQUESTED_SHA" > "$release/.xraylarch-release.sha"
: > "$events"
perform_deploy || fail_test 'completed release must be retryable'
[[ "$(cat "$events")" == $'remote\nidentity\nsmoke\nactivate' ]] || fail_test 'retry must validate and smoke existing release without rebuilding'
smoke_status=1
: > "$events"
if perform_deploy; then fail_test 'broken existing application must fail'; fi
! grep -Eq 'build|activate' "$events" || fail_test 'broken existing app must remain untouched'
smoke_status=0
rm "$release/.xraylarch-release.sha"
: > "$events"
if perform_deploy; then fail_test 'incomplete release must fail'; fi
! grep -Eq 'build|activate|smoke' "$events" || fail_test 'incomplete release must remain untouched'
rmdir "$release"
ln -s "$test_root/missing" "$release"
: > "$events"
if perform_deploy; then fail_test 'broken symlink release must fail'; fi
[[ -L "$release" ]] || fail_test 'symlink must not be removed'
! grep -Eq 'build|activate|smoke' "$events" || fail_test 'symlink release must remain untouched'
remote_status=1
: > "$events"
if perform_deploy; then fail_test 'remote mismatch must fail'; fi
[[ "$(cat "$events")" == remote ]] || fail_test 'remote must be verified before release actions'
printf 'release dependency and retry tests passed\n'
