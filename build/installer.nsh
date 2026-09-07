!include "LogicLib.nsh"

; Both variables are only read and written inside the uninstaller macros
; below, which electron-builder inserts solely in its BUILD_UNINSTALLER pass.
; Declaring them in the installer pass too leaves them unreferenced there, and
; makensis runs with -WX, so warning 6001 fails the whole NSIS build.
!ifdef BUILD_UNINSTALLER
  Var JennyRemovalMode
  Var JennyCleanupIncomplete
!endif

!macro RemoveJennyProfileChild name
  !define JennyRemove_ID "JennyRemove_${__LINE__}"
  IfFileExists "$APPDATA\jenny\${name}" 0 ${JennyRemove_ID}_done
  System::Call 'kernel32::GetFileAttributesW(t "$APPDATA\jenny\${name}") i .r0'
  IntOp $1 $0 & 0x400
  StrCmp $1 "0" ${JennyRemove_ID}_remove
  StrCpy $JennyCleanupIncomplete "1"
  Goto ${JennyRemove_ID}_done
  ${JennyRemove_ID}_remove:
  RMDir /r "$APPDATA\jenny\${name}"
  Delete "$APPDATA\jenny\${name}"
  IfFileExists "$APPDATA\jenny\${name}" 0 +2
  StrCpy $JennyCleanupIncomplete "1"
  ${JennyRemove_ID}_done:
  !undef JennyRemove_ID
!macroend

!macro customUnInit
  StrCpy $JennyRemovalMode "preserve"
  ${ifNot} ${isUpdated}
    IfSilent done
    IfFileExists "$INSTDIR\Jenny.exe" 0 helper_failure
    ExecWait '"$INSTDIR\Jenny.exe" --uninstall-assistant --parent=nsis' $0
    StrCmp $0 20 cancel
    StrCmp $0 21 done
    StrCmp $0 22 cleanup
    StrCmp $0 23 cleanup
    Goto helper_failure

    cleanup:
      StrCpy $JennyRemovalMode "cleanup"
      Goto done
    helper_failure:
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "Jenny could not open the removal assistant. Remove only the app and keep all Jenny data?" IDYES done IDNO cancel
    cancel:
      Abort
    done:
  ${endIf}
!macroend

!macro customUnInstall
  StrCmp $JennyRemovalMode "cleanup" 0 done
  StrCpy $JennyCleanupIncomplete "0"
  !insertmacro RemoveJennyProfileChild ".jenny"
  !insertmacro RemoveJennyProfileChild "attachments"
  !insertmacro RemoveJennyProfileChild "backend-sidecar"
  !insertmacro RemoveJennyProfileChild "background-memory"
  !insertmacro RemoveJennyProfileChild "blob_storage"
  !insertmacro RemoveJennyProfileChild "Cache"
  !insertmacro RemoveJennyProfileChild "Code Cache"
  !insertmacro RemoveJennyProfileChild "Cookies"
  !insertmacro RemoveJennyProfileChild "Cookies-journal"
  !insertmacro RemoveJennyProfileChild "cost-tracker.json"
  !insertmacro RemoveJennyProfileChild "usage-history.json"
  !insertmacro RemoveJennyProfileChild "Crashpad"
  !insertmacro RemoveJennyProfileChild "data-lifecycle"
  !insertmacro RemoveJennyProfileChild "databases"
  !insertmacro RemoveJennyProfileChild "DawnGraphiteCache"
  !insertmacro RemoveJennyProfileChild "DawnWebGPUCache"
  !insertmacro RemoveJennyProfileChild "diagnostics"
  !insertmacro RemoveJennyProfileChild "Dictionary"
  !insertmacro RemoveJennyProfileChild "disabled-startup-shortcuts"
  !insertmacro RemoveJennyProfileChild "GPUCache"
  !insertmacro RemoveJennyProfileChild "GrShaderCache"
  !insertmacro RemoveJennyProfileChild "home-calendar.json"
  !insertmacro RemoveJennyProfileChild "IndexedDB"
  !insertmacro RemoveJennyProfileChild "knowledge.json"
  !insertmacro RemoveJennyProfileChild "llama-server.pid"
  !insertmacro RemoveJennyProfileChild "Local State"
  !insertmacro RemoveJennyProfileChild "Local Storage"
  !insertmacro RemoveJennyProfileChild "logs"
  !insertmacro RemoveJennyProfileChild "mcp-servers.json"
  !insertmacro RemoveJennyProfileChild "model-recommendation-catalog.json"
  !insertmacro RemoveJennyProfileChild "model-recommendation-catalog.json.meta.json"
  !insertmacro RemoveJennyProfileChild "Network"
  !insertmacro RemoveJennyProfileChild "Network Persistent State"
  !insertmacro RemoveJennyProfileChild "ollama-process.json"
  !insertmacro RemoveJennyProfileChild "personality"
  !insertmacro RemoveJennyProfileChild "plugins"
  !insertmacro RemoveJennyProfileChild "Preferences"
  !insertmacro RemoveJennyProfileChild "QuotaManager"
  !insertmacro RemoveJennyProfileChild "QuotaManager-journal"
  !insertmacro RemoveJennyProfileChild "secure-state.json"
  !insertmacro RemoveJennyProfileChild "session-shadow.json"
  !insertmacro RemoveJennyProfileChild "Session Storage"
  !insertmacro RemoveJennyProfileChild "sessions"
  !insertmacro RemoveJennyProfileChild "sessions.json"
  !insertmacro RemoveJennyProfileChild "Shared Dictionary"
  !insertmacro RemoveJennyProfileChild "SharedStorage"
  !insertmacro RemoveJennyProfileChild "SharedStorage-wal"
  !insertmacro RemoveJennyProfileChild "shell-config.json"
  !insertmacro RemoveJennyProfileChild "sidecar-memory.db"
  !insertmacro RemoveJennyProfileChild "SingletonCookie"
  !insertmacro RemoveJennyProfileChild "SingletonLock"
  !insertmacro RemoveJennyProfileChild "SingletonSocket"
  !insertmacro RemoveJennyProfileChild "terminal-repairs.json"
  !insertmacro RemoveJennyProfileChild "tool-permissions.json"
  !insertmacro RemoveJennyProfileChild "TransportSecurity"
  !insertmacro RemoveJennyProfileChild "Trust Tokens"
  !insertmacro RemoveJennyProfileChild "Trust Tokens-journal"
  !insertmacro RemoveJennyProfileChild "turn-event-journal.json"
  !insertmacro RemoveJennyProfileChild "update-state.json"
  !insertmacro RemoveJennyProfileChild "VideoDecodeStats"
  !insertmacro RemoveJennyProfileChild "vllm-process.json"
  !insertmacro RemoveJennyProfileChild "WebStorage"
  !insertmacro RemoveJennyProfileChild "window-state.json"
  !insertmacro RemoveJennyProfileChild "workspace-snapshots"
  StrCmp $JennyCleanupIncomplete "1" incomplete
  RMDir "$APPDATA\jenny"
  IfFileExists "$APPDATA\jenny\*.*" 0 done
  MessageBox MB_OK|MB_ICONINFORMATION "Jenny retained models, runtimes, or unrecognized profile items under $APPDATA\jenny for your review."
  Goto done
  incomplete:
  MessageBox MB_OK|MB_ICONEXCLAMATION "Jenny could not remove one or more known profile items under $APPDATA\jenny. Close programs using those files and retry cleanup manually."
  SetErrorLevel 24
  done:
!macroend
