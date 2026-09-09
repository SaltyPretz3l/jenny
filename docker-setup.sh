#!/usr/bin/env bash
# Jenny Docker setup — macOS / Linux entry point.
#
# The launcher intentionally owns no application state. It only validates the
# local Docker client/daemon and invokes the fixed easy Compose project.

set -uo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)" || {
  printf 'Could not resolve the launcher directory.\n' >&2
  exit 10
}
REPO_DIR="$SCRIPT_DIR"
COMPOSE_FILE="$REPO_DIR/compose.host.easy.yml"
COMPOSE=(docker compose --project-directory "$REPO_DIR" -f "$COMPOSE_FILE" --project-name jenny-host)
HOST_RUNNING_PROBE_FAILED=0
HOST_RUNNING_PROBE_STATUS=0

usage() {
  cat <<'EOF'
Jenny Docker setup

Usage:
  ./docker-setup.sh             Initialize (if needed) and start Jenny.
  ./docker-setup.sh doctor      Check configuration and readiness without build/up.
  ./docker-setup.sh configure   Change setup while Jenny is stopped, then start it.
  ./docker-setup.sh help

Docker Compose 2.24.4+ and a running Linux Docker daemon are required.
The setup and configure commands require an interactive terminal.
EOF
}

error() {
  printf 'docker-setup: %s\n' "$1" >&2
}

followups() {
  printf '  Diagnosis: bash %q doctor\n' "$SCRIPT_PATH" >&2
  printf '  Logs: docker compose --project-directory %q -f %q --project-name jenny-host logs --tail 100 jenny\n' \
    "$REPO_DIR" "$COMPOSE_FILE" >&2
}

fail_step() {
  local label="$1"
  local status="$2"
  error "$label failed (exit $status)."
  followups
  return "$status"
}

require_interactive() {
  if [[ ! -t 0 || ! -t 1 ]]; then
    error "an interactive terminal is required for '$1'; run it from a terminal, then retry."
    return 11
  fi
  return 0
}

compose_version_ok() {
  local raw="$1"
  local major minor patch
  if [[ ! "$raw" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    return 1
  fi
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  if (( major > 2 )); then
    return 0
  fi
  if (( major < 2 || minor < 24 || (minor == 24 && patch < 4) )); then
    return 1
  fi
  return 0
}

preflight() {
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    error "easy Compose file not found: $COMPOSE_FILE"
    return 10
  fi
  if ! command -v docker >/dev/null 2>&1; then
    error "Docker CLI was not found. Install Docker Desktop or Docker Engine, then retry."
    return 10
  fi

  local compose_output compose_status daemon_output daemon_status daemon_os
  compose_output="$(docker compose version --short 2>/dev/null)"
  compose_status=$?
  if (( compose_status != 0 )) || ! compose_version_ok "$compose_output"; then
    error "Docker Compose 2.24.4 or newer is required. Run 'docker compose version' to inspect the installed version."
    return 10
  fi

  daemon_output="$(docker info --format '{{.OSType}}' 2>/dev/null)"
  daemon_status=$?
  daemon_os="${daemon_output//$'\r'/}"
  daemon_os="${daemon_os//$'\n'/}"
  if (( daemon_status != 0 )); then
    error "Docker daemon is unavailable. Start Docker Desktop or Docker Engine, then retry."
    return 10
  fi
  if [[ "$(printf '%s' "$daemon_os" | tr '[:upper:]' '[:lower:]')" != "linux" ]]; then
    if [[ -n "$daemon_os" ]]; then
      error "A Linux Docker daemon is required; the current daemon reports '$daemon_os'."
    else
      error "A Linux Docker daemon is required; Docker did not report its operating system."
    fi
    return 10
  fi
  return 0
}

run_compose_step() {
  local label="$1"
  shift
  "${COMPOSE[@]}" "$@"
  local status=$?
  if (( status != 0 )); then
    fail_step "$label" "$status"
    return "$status"
  fi
  return 0
}

host_running() {
  local output status line
  HOST_RUNNING_PROBE_FAILED=0
  HOST_RUNNING_PROBE_STATUS=0
  output="$("${COMPOSE[@]}" ps --services --filter status=running jenny 2>/dev/null)"
  status=$?
  if (( status != 0 )); then
    HOST_RUNNING_PROBE_FAILED=1
    HOST_RUNNING_PROBE_STATUS=$status
    error "could not determine whether Jenny is running (exit $status)."
    followups
    return "$status"
  fi
  while IFS= read -r line; do
    [[ "$line" == "jenny" ]] && return 0
  done <<< "$output"
  return 1
}

run_doctor() {
  run_compose_step "doctor" run --rm --no-deps -T setup doctor
}

run_status() {
  run_compose_step "status" run --rm --no-deps -T setup status
}

main() {
  local mode=setup
  if (( $# == 1 )); then
    case "$1" in
      help|-h|--help)
        usage
        return 0
        ;;
      doctor|configure)
        mode="$1"
        ;;
      setup)
        mode=setup
        ;;
      --*)
        error "unknown option '$1'."
        usage >&2
        return 2
        ;;
      *)
        error "unknown command '$1'. Use 'help' for usage."
        usage >&2
        return 2
        ;;
    esac
  elif (( $# != 0 )); then
    error "expected one command at most. Use 'help' for usage."
    usage >&2
    return 2
  fi

  if [[ "$mode" == setup || "$mode" == configure ]]; then
    require_interactive "$mode" || return $?
  fi
  preflight || return $?

  if [[ "$mode" == doctor ]]; then
    run_doctor
    return $?
  fi

  if host_running; then
    if [[ "$mode" == configure ]]; then
      error "Jenny is already running; configure requires a stopped host. No changes were made."
      followups
      return 11
    fi
    printf 'Jenny is already running; no build or restart is needed. Running doctor.\n'
    run_doctor
    return $?
  else
    if (( HOST_RUNNING_PROBE_FAILED != 0 )); then
      return "$HOST_RUNNING_PROBE_STATUS"
    fi
  fi

  run_compose_step "image build" build jenny || return $?
  if [[ "$mode" == configure ]]; then
    run_compose_step "interactive configure" run --rm --no-deps setup configure || return $?
  else
    run_compose_step "interactive owner initialization" run --rm --no-deps setup init || return $?
  fi
  run_compose_step "start" up --wait --wait-timeout 120 -d jenny || return $?
  run_status
}

main "$@"
exit $?
