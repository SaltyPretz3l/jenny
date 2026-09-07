#!/bin/sh
set -u
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/scripts/uninstall.js" ]; then
  exec node "$SCRIPT_DIR/scripts/uninstall.js" "$@"
fi

APP_PATH="/Applications/Jenny.app"
if [ ! -x "$APP_PATH/Contents/MacOS/Jenny" ]; then
  printf '%s\n' "Jenny is not installed in /Applications."
  exit 1
fi

remove_profile_child() {
  TARGET="$PROFILE_ROOT/$1"
  if [ -L "$TARGET" ]; then
    printf '%s\n' "Jenny retained an unsafe linked profile item. The app was retained so cleanup can be reviewed."
    exit 1
  fi
  if ! rm -rf -- "$TARGET" || [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    printf '%s\n' "Jenny could not remove a known profile item. The app was retained so cleanup can be retried."
    exit 1
  fi
}

"$APP_PATH/Contents/MacOS/Jenny" --uninstall-assistant --parent=macos
RESULT=$?
case "$RESULT" in
  20) exit 0 ;;
  21) ;;
  22|23)
    PROFILE_ROOT="$HOME/Library/Application Support/jenny"
    if [ "$PROFILE_ROOT" = "$HOME/Library/Application Support/jenny" ] && [ ! -L "$PROFILE_ROOT" ]; then
      remove_profile_child ".jenny"
      remove_profile_child "attachments"
      remove_profile_child "backend-sidecar"
      remove_profile_child "background-memory"
      remove_profile_child "blob_storage"
      remove_profile_child "Cache"
      remove_profile_child "Code Cache"
      remove_profile_child "Cookies"
      remove_profile_child "Cookies-journal"
      remove_profile_child "cost-tracker.json"
      remove_profile_child "Crashpad"
      remove_profile_child "data-lifecycle"
      remove_profile_child "databases"
      remove_profile_child "DawnGraphiteCache"
      remove_profile_child "DawnWebGPUCache"
      remove_profile_child "diagnostics"
      remove_profile_child "Dictionary"
      remove_profile_child "disabled-startup-shortcuts"
      remove_profile_child "GPUCache"
      remove_profile_child "GrShaderCache"
      remove_profile_child "home-calendar.json"
      remove_profile_child "IndexedDB"
      remove_profile_child "knowledge.json"
      remove_profile_child "llama-server.pid"
      remove_profile_child "Local State"
      remove_profile_child "Local Storage"
      remove_profile_child "logs"
      remove_profile_child "mcp-servers.json"
      remove_profile_child "model-recommendation-catalog.json"
      remove_profile_child "model-recommendation-catalog.json.meta.json"
      remove_profile_child "Network"
      remove_profile_child "Network Persistent State"
      remove_profile_child "ollama-process.json"
      remove_profile_child "personality"
      remove_profile_child "plugins"
      remove_profile_child "Preferences"
      remove_profile_child "QuotaManager"
      remove_profile_child "QuotaManager-journal"
      remove_profile_child "secure-state.json"
      remove_profile_child "session-shadow.json"
      remove_profile_child "Session Storage"
      remove_profile_child "sessions"
      remove_profile_child "sessions.json"
      remove_profile_child "Shared Dictionary"
      remove_profile_child "SharedStorage"
      remove_profile_child "SharedStorage-wal"
      remove_profile_child "shell-config.json"
      remove_profile_child "sidecar-memory.db"
      remove_profile_child "SingletonCookie"
      remove_profile_child "SingletonLock"
      remove_profile_child "SingletonSocket"
      remove_profile_child "terminal-repairs.json"
      remove_profile_child "tool-permissions.json"
      remove_profile_child "TransportSecurity"
      remove_profile_child "Trust Tokens"
      remove_profile_child "Trust Tokens-journal"
      remove_profile_child "turn-event-journal.json"
      remove_profile_child "update-state.json"
      remove_profile_child "usage-history.json"
      remove_profile_child "VideoDecodeStats"
      remove_profile_child "vllm-process.json"
      remove_profile_child "WebStorage"
      remove_profile_child "window-state.json"
      remove_profile_child "workspace-snapshots"
      if ! rmdir "$PROFILE_ROOT" 2>/dev/null && [ -d "$PROFILE_ROOT" ]; then
        printf '%s\n' "Jenny retained unrecognized profile items in $PROFILE_ROOT for your review."
      fi
    else
      printf '%s\n' "Jenny profile path validation failed; data was retained."
      exit 1
    fi
    ;;
  *)
    printf '%s' "Jenny's helper failed. Remove only the app and preserve all data? [y/N] "
    read -r ANSWER
    case "$ANSWER" in y|Y|yes|YES) ;; *) exit 1 ;; esac
    ;;
esac

if ! osascript -e 'tell application "Finder" to delete POSIX file "/Applications/Jenny.app"'; then
  printf '%s\n' "Jenny data handling completed, but the app could not be moved to Trash."
  exit 1
fi
printf '%s\n' "Jenny was moved to Trash. Any retained data remains available for reinstall."
