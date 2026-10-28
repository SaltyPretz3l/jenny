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

; The in-app "Install command-line tool" action (services/cli-path-service.js)
; may have put $INSTDIR\resources\bin on the current user's Path. Drop every
; entry equal to it (StrCmp is case-insensitive; %VAR% forms are expanded and
; trailing backslashes ignored for the comparison) and keep all other entries
; verbatim. HKCU only: the machine Path is never read or written. A value as
; long as the NSIS string buffer may have been truncated, so it is left alone
; rather than written back short. An update reuses the same directory, so the
; entry stays. This runs on every real uninstall, whatever the removal mode,
; and touches nothing under $APPDATA.
!define /math JennyCliPathReadLimit ${NSIS_MAX_STRLEN} - 1
!macro RemoveJennyCliPathEntry
  ${ifNot} ${isUpdated}
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $R6
    Push $R7
    Push $R8
    ClearErrors
    ReadRegStr $R0 HKCU "Environment" "Path"
    IfErrors jenny_cli_path_restore
    StrCmp $R0 "" jenny_cli_path_restore
    StrLen $R1 $R0
    IntCmp $R1 ${JennyCliPathReadLimit} jenny_cli_path_restore 0 jenny_cli_path_restore
    StrCpy $R2 0
    StrCpy $R3 ""
    StrCpy $R4 ""
    StrCpy $R5 0
    StrCpy $R8 0
    jenny_cli_path_scan:
      StrCpy $R6 $R0 1 $R2
      StrCmp $R6 "" jenny_cli_path_entry
      StrCmp $R6 ";" jenny_cli_path_entry
      StrCpy $R3 "$R3$R6"
      IntOp $R2 $R2 + 1
      Goto jenny_cli_path_scan
    jenny_cli_path_entry:
      ExpandEnvStrings $R7 $R3
    jenny_cli_path_trim:
      StrCpy $R1 $R7 1 -1
      StrCmp $R1 "\" 0 jenny_cli_path_compare
      StrCpy $R7 $R7 -1
      Goto jenny_cli_path_trim
    jenny_cli_path_compare:
      StrCmp $R7 "" jenny_cli_path_keep
      StrCmp $R7 "$INSTDIR\resources\bin" 0 jenny_cli_path_keep
      IntOp $R5 $R5 + 1
      Goto jenny_cli_path_next
    jenny_cli_path_keep:
      IntCmp $R8 0 jenny_cli_path_append
      StrCpy $R4 "$R4;"
    jenny_cli_path_append:
      StrCpy $R4 "$R4$R3"
      IntOp $R8 $R8 + 1
    jenny_cli_path_next:
      StrCmp $R6 "" jenny_cli_path_write
      StrCpy $R3 ""
      IntOp $R2 $R2 + 1
      Goto jenny_cli_path_scan
    jenny_cli_path_write:
      IntCmp $R5 0 jenny_cli_path_restore
      StrCmp $R4 "" jenny_cli_path_delete
      WriteRegExpandStr HKCU "Environment" "Path" $R4
      Goto jenny_cli_path_broadcast
    jenny_cli_path_delete:
      DeleteRegValue HKCU "Environment" "Path"
    jenny_cli_path_broadcast:
      ; HWND_BROADCAST, WM_SETTINGCHANGE: new terminals pick up the change.
      SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
    jenny_cli_path_restore:
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  ${endIf}
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
  !insertmacro RemoveJennyCliPathEntry
  StrCmp $JennyRemovalMode "cleanup" 0 done
  StrCpy $JennyCleanupIncomplete "0"
  ; A junction or symlink at the profile root would redirect every deletion
  ; below into its target. GetFileAttributesW returns -1 when the attributes
  ; cannot be read, and -1 & 0x400 is non-zero, so an unreadable root fails
  ; closed through the same test.
  IfFileExists "$APPDATA\jenny" 0 jenny_root_clear
  System::Call 'kernel32::GetFileAttributesW(t "$APPDATA\jenny") i .r0'
  IntOp $1 $0 & 0x400
  StrCmp $1 "0" jenny_root_clear
  MessageBox MB_OK|MB_ICONEXCLAMATION "Jenny left $APPDATA\jenny in place because the profile folder is a link or could not be inspected. Nothing inside it was removed."
  SetErrorLevel 24
  Goto done
  jenny_root_clear:
  !insertmacro RemoveJennyProfileChild ".jenny"
  !insertmacro RemoveJennyProfileChild "attachments"
  !insertmacro RemoveJennyProfileChild "backend-sidecar"
  !insertmacro RemoveJennyProfileChild "background-memory"
  !insertmacro RemoveJennyProfileChild "blob_storage"
  !insertmacro RemoveJennyProfileChild "Cache"
  !insertmacro RemoveJennyProfileChild "Code Cache"
  !insertmacro RemoveJennyProfileChild "compile-cache"
  !insertmacro RemoveJennyProfileChild "Cookies"
  !insertmacro RemoveJennyProfileChild "Cookies-journal"
  !insertmacro RemoveJennyProfileChild "cost-tracker.json"
  !insertmacro RemoveJennyProfileChild "conversation-index.db"
  !insertmacro RemoveJennyProfileChild "conversation-index.db-shm"
  !insertmacro RemoveJennyProfileChild "conversation-index.db-wal"
  !insertmacro RemoveJennyProfileChild "usage-history.json"
  !insertmacro RemoveJennyProfileChild "Crashpad"
  !insertmacro RemoveJennyProfileChild "data-lifecycle"
  !insertmacro RemoveJennyProfileChild "databases"
  !insertmacro RemoveJennyProfileChild "DawnGraphiteCache"
  !insertmacro RemoveJennyProfileChild "DawnWebGPUCache"
  !insertmacro RemoveJennyProfileChild "diagnostics"
  !insertmacro RemoveJennyProfileChild "Dictionary"
  !insertmacro RemoveJennyProfileChild "disabled-startup-shortcuts"
  !insertmacro RemoveJennyProfileChild "engines"
  !insertmacro RemoveJennyProfileChild "GPUCache"
  !insertmacro RemoveJennyProfileChild "GrShaderCache"
  !insertmacro RemoveJennyProfileChild "home-ai-journal.json"
  !insertmacro RemoveJennyProfileChild "home-calendar.json"
  !insertmacro RemoveJennyProfileChild "image-engine-scratch"
  !insertmacro RemoveJennyProfileChild "image-engine.pid"
  !insertmacro RemoveJennyProfileChild "image-engine.pid.tmp"
  !insertmacro RemoveJennyProfileChild "image-models.json"
  !insertmacro RemoveJennyProfileChild "image-models.json.part"
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
  !insertmacro RemoveJennyProfileChild "ollama-catalog.json"
  !insertmacro RemoveJennyProfileChild "ollama-process.json"
  !insertmacro RemoveJennyProfileChild "personality"
  !insertmacro RemoveJennyProfileChild "plugins"
  !insertmacro RemoveJennyProfileChild "Preferences"
  !insertmacro RemoveJennyProfileChild "project-delete-operations.json"
  !insertmacro RemoveJennyProfileChild "project-notes"
  !insertmacro RemoveJennyProfileChild "projects.json"
  !insertmacro RemoveJennyProfileChild "session-runtime"
  !insertmacro RemoveJennyProfileChild "session-runtime-budgets"
  !insertmacro RemoveJennyProfileChild "session-runtime-lineage"
  !insertmacro RemoveJennyProfileChild "session-runtime-checkpoints"
  !insertmacro RemoveJennyProfileChild "QuotaManager"
  !insertmacro RemoveJennyProfileChild "QuotaManager-journal"
  !insertmacro RemoveJennyProfileChild "secure-state.json"
  !insertmacro RemoveJennyProfileChild "semantic-catalog.db"
  !insertmacro RemoveJennyProfileChild "semantic-catalog.db-shm"
  !insertmacro RemoveJennyProfileChild "semantic-catalog.db-wal"
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
  !insertmacro RemoveJennyProfileChild "todo-lists"
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
  !insertmacro RemoveJennyProfileChild "workspace-backups"
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
