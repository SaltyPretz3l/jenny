#!/usr/bin/env bash
# Real Linux install harness for the one-command installer (row 47).
# Runs the REAL install.sh against the latest public release inside disposable
# Docker containers: install, boot to onboarding, running-app refusal, rerun on an
# existing profile and (optionally) an upgrade from an earlier release.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/packaging/install-native-linux.sh [options]

  --route deb|appimage|all   Route(s) to exercise (default: all).
                             deb      = ubuntu:22.04, non-root user with passwordless sudo
                             appimage = debian:12 without sudo (installer falls back to AppImage)
  --from-release vX.Y.Z      Install and boot that release first, then upgrade with install.sh.
  --keep-images              Keep the built images (containers are always removed).
  --log-dir DIR              Log directory (default: artifacts/logs under the repo root).
  -h, --help                 Show this help.

Environment:
  JENNY_INSTALL_NATIVE_SCRIPT=PATH     Installer to mount instead of the repo's install.sh
                                       (used for negative controls; mounted read-only).
  JENNY_INSTALL_NATIVE_SHIM_KERNEL=0|1 Force the uname -r shim off/on. By default it is
                                       installed only when the Docker kernel is a WSL2
                                       ("microsoft") kernel, which install.sh refuses by design.

Logs: <log-dir>/install-native-<route>.log and <log-dir>/install-native-<route>-shell.log.
Each passing route prints one "RESULT route=..." line; the exit status is non-zero if
any route failed. Downloads: the installer fetches about 290-325 MB per route, plus the
prior release when --from-release is given.
EOF
}

die() { echo "install-native-linux: $*" >&2; exit 2; }

route=all
prior=
keep_images=0
log_dir=
while (($#)); do
  case "$1" in
    --route) (($# >= 2)) || die "--route needs a value"; route=$2; shift 2 ;;
    --route=*) route=${1#*=}; shift ;;
    --from-release) (($# >= 2)) || die "--from-release needs a value"; prior=$2; shift 2 ;;
    --from-release=*) prior=${1#*=}; shift ;;
    --keep-images) keep_images=1; shift ;;
    --log-dir) (($# >= 2)) || die "--log-dir needs a value"; log_dir=$2; shift 2 ;;
    --log-dir=*) log_dir=${1#*=}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

case "$route" in
  deb|appimage) routes=("$route") ;;
  all) routes=(deb appimage) ;;
  *) die "--route must be deb, appimage or all" ;;
esac
if [[ -n "$prior" && ! "$prior" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "--from-release must look like vX.Y.Z"
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
context="$here/install-native-linux"
installer="${JENNY_INSTALL_NATIVE_SCRIPT:-$repo_root/install.sh}"
[[ -f "$installer" ]] || die "installer not found: $installer"
installer="$(cd "$(dirname "$installer")" && pwd)/$(basename "$installer")"
log_dir="${log_dir:-$repo_root/artifacts/logs}"
mkdir -p "$log_dir"
log_dir="$(cd "$log_dir" && pwd)"

command -v docker >/dev/null 2>&1 || die "docker is required"
# Git Bash on Windows: never let MSYS rewrite container paths; host paths handed to
# docker are converted explicitly to native form instead.
export MSYS_NO_PATHCONV=1
host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

kernel="$(docker info --format '{{.KernelVersion}}' 2>/dev/null)" || die "docker info failed; is the daemon running?"
case "${JENNY_INSTALL_NATIVE_SHIM_KERNEL:-auto}" in
  0|1) shim=$JENNY_INSTALL_NATIVE_SHIM_KERNEL ;;
  auto) if [[ "${kernel,,}" == *microsoft* ]]; then shim=1; else shim=0; fi ;;
  *) die "JENNY_INSTALL_NATIVE_SHIM_KERNEL must be 0 or 1" ;;
esac
if [[ "$shim" == 1 ]]; then
  echo "NOTICE: Docker kernel '$kernel' looks like WSL2. install.sh refuses WSL kernels by design,"
  echo "NOTICE: so this run shims 'uname -r' (to 6.8.0-harness) inside the disposable images only."
  echo "NOTICE: Set JENNY_INSTALL_NATIVE_SHIM_KERNEL=0 to disable. On a real Linux host no shim is used."
fi

run_tag="${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"
images=()
containers=()

cleanup() {
  local result=$?
  local c i
  for c in ${containers[@]+"${containers[@]}"}; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  if [[ "$keep_images" == 0 ]]; then
    for i in ${images[@]+"${images[@]}"}; do
      docker rmi -f "$i" >/dev/null 2>&1 || true
    done
  fi
  exit "$result"
}
trap cleanup EXIT

run_route() {
  local r=$1 rc
  local image="jenny-install-native-$r:$run_tag"
  local container="jenny-install-native-$r-$run_tag"
  local log="$log_dir/install-native-$r.log"
  local shell_log="$log_dir/install-native-$r-shell.log"
  : >"$log"
  rm -f "$shell_log"
  echo "== [$r] building $image (shim_kernel=$shim)" | tee -a "$log"
  images+=("$image")
  if ! docker build --progress=plain --build-arg "SHIM_KERNEL=$shim" -t "$image" \
      -f "$(host_path "$context/Dockerfile.$r")" "$(host_path "$context")" >>"$log" 2>&1; then
    echo "FAIL route=$r step=image-build (see $log)" | tee -a "$log"
    return 1
  fi
  echo "== [$r] running scenario in $container (installer: $installer)" | tee -a "$log"
  containers+=("$container")
  set +e
  # seccomp=unconfined lets Chromium create its user-namespace sandbox; the app
  # itself always runs with its sandbox enabled. --init reaps orphaned app processes.
  docker run --name "$container" --init \
    --security-opt seccomp=unconfined --shm-size=1g \
    --mount "type=bind,src=$(host_path "$installer"),dst=/work/install.sh,readonly" \
    -e "JENNY_ROUTE=$r" -e "JENNY_PRIOR_TAG=$prior" \
    "$image" 2>&1 | tee -a "$log"
  rc=${PIPESTATUS[0]}
  set -e
  if docker cp "$container:/home/tester/.config/jenny/logs/shell.log" "$(host_path "$shell_log")" >/dev/null 2>&1; then
    echo "== [$r] copied shell.log to $shell_log" | tee -a "$log"
  else
    echo "== [$r] no shell.log to copy (the app never wrote one)" | tee -a "$log"
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  echo "== [$r] scenario exit=$rc" | tee -a "$log"
  return "$rc"
}

failed=()
for r in "${routes[@]}"; do
  if ! run_route "$r"; then failed+=("$r"); fi
done

echo "== summary"
for r in "${routes[@]}"; do
  grep -h '^RESULT ' "$log_dir/install-native-$r.log" 2>/dev/null || echo "RESULT route=$r status=fail step=no-result"
done
if ((${#failed[@]})); then
  echo "install-native-linux: FAILED routes: ${failed[*]} (logs in $log_dir)" >&2
  exit 1
fi
echo "install-native-linux: all routes passed (logs in $log_dir)"
