#!/bin/sh
# Readiness markers for the real-install harnesses: did ONE new app run reach a
# successful renderer start and a managed-sidecar initialization?
#
#   sh markers.sh <shell.log> <line-offset>
#
# Only lines after <line-offset> are considered (0 = whole file). Exit codes:
#   0  success: prints "run_id=<id> boot_ms=<startupMs>"
#   1  not yet: no window.ready for a new run, or its sidecar marker is missing
#   2  failure: the first window.ready after the offset reports a failed renderer
#      start (source did-fail-load or startup-timeout); prints "FAIL source=<x>"
# The app also logs window.ready after a failed load or a startup timeout, so the
# source field decides, not the event name.
set -u
log=${1:-}
offset=${2:-0}
[ -n "$log" ] && [ -f "$log" ] || exit 1
case "$offset" in ''|*[!0-9]*) offset=0 ;; esac
lines=$(wc -l <"$log" | tr -d ' ')
[ "$lines" -ge "$offset" ] || offset=0 # the log was rotated or truncated
ready=$(tail -n +"$((offset + 1))" "$log" | grep -F '"event":"window.ready"' | head -n 1)
[ -n "$ready" ] || exit 1
source=$(printf '%s\n' "$ready" | sed -n 's/.*"details":{"source":"\([^"]*\)".*/\1/p')
case "$source" in
    ready-to-show|did-finish-load|renderer-ready|ready-to-show+renderer-ready|did-finish-load+renderer-ready) ;;
    *) printf 'FAIL source=%s\n' "${source:-unknown}"; exit 2 ;;
esac
run_id=$(printf '%s\n' "$ready" | sed -n 's/.*"run_id":"\([^"]*\)".*/\1/p')
[ -n "$run_id" ] || exit 1
tail -n +"$((offset + 1))" "$log" | grep -F '"event":"backend.managed_sidecar_initialized"' \
    | grep -qF "\"run_id\":\"$run_id\"" || exit 1
boot_ms=$(printf '%s\n' "$ready" | sed -n 's/.*"startupMs":\([0-9][0-9]*\).*/\1/p')
printf 'run_id=%s boot_ms=%s\n' "$run_id" "${boot_ms:-unknown}"
exit 0
