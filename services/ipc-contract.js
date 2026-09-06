/**
 * Type-safe IPC contract for the Jenny preload bridge.
 *
 * JSDoc typedefs for the payload shapes live in ipc-contract-types.js;
 * JENNY_SHELL_BRIDGE_DESCRIPTORS below is the single runtime authority for
 * the JennyShellBridge surface.
 *
 * @module ipc-contract
 */

function createBridgeMethod(kind, channel) {
  return Object.freeze({
    kind,
    channel,
  });
}

const invokeMethod = (channel) => createBridgeMethod('invoke', channel);
const subscribeMethod = (channel) => createBridgeMethod('subscribe', channel);
const sendMethod = (channel) => createBridgeMethod('send', channel);
// 'local' methods run entirely inside the preload context (no IPC channel):
// needed for Electron APIs that must receive renderer-world objects directly,
// e.g. webUtils.getPathForFile(File).
const localMethod = (impl) => Object.freeze({ kind: 'local', impl });

const JENNY_SHELL_BRIDGE_DESCRIPTORS = Object.freeze({
  'backend.getStatus': invokeMethod('backend:get-status'),
  'backend.retryStart': invokeMethod('backend:retry-start'),
  'backend.onStatus': subscribeMethod('backend:status'),
  'auth.getState': invokeMethod('auth:get-state'),
  'auth.updateLocalProfile': invokeMethod('auth:update-local-profile'),
  'auth.onState': subscribeMethod('auth:state'),
  'sessions.list': invokeMethod('sessions:list'),
  'sessions.create': invokeMethod('sessions:create'),
  'sessions.rename': invokeMethod('sessions:rename'),
  'sessions.delete': invokeMethod('sessions:delete'),
  'sessions.getMessages': invokeMethod('sessions:get-messages'),
  'sessions.setPreferences': invokeMethod('sessions:set-preferences'),
  'sessions.setMeta': invokeMethod('sessions:set-meta'),
  'sessions.sweepEmpty': invokeMethod('sessions:sweep-empty'),
  'sessions.updateMessage': invokeMethod('sessions:update-message'),
  'sessions.editAndTruncate': invokeMethod('sessions:edit-and-truncate'),
  'sessions.exportSession': invokeMethod('sessions:export'),
  'sessions.importSession': invokeMethod('sessions:import'),
  'sessions.forkSession': invokeMethod('sessions:fork'),
  'models.list': invokeMethod('models:list'),
  // Raw installed Ollama tags (engine-scoped to ollama), independent of the chat
  // engine — feeds the Editor "Completion model" (FIM) picker so a freshly-pulled
  // Ollama coder model is selectable even when chat runs on another engine.
  'models.listOllamaTags': invokeMethod('models:list-ollama-tags'),
  'models.load': invokeMethod('models:load'),
  'models.unload': invokeMethod('models:unload'),
  'models.delete': invokeMethod('models:delete'),
  // Engine settings snapshot (shell-config localEngines + preferredEngineType)
  // for the Settings → Offline "Local engines" panel and its ChatGPT connect card.
  'engines.getSettings': invokeMethod('engines:get-settings'),
  'engines.updateSettings': invokeMethod('engines:update-settings'),
  'status.get': invokeMethod('status:get'),
  'lifecycle.onProgress': subscribeMethod('lifecycle:progress'),
  'lifecycle.signalReady': sendMethod('renderer:ready'),
  'system.getStats': invokeMethod('system:get-stats'),
  // Manual, forced, throttle-bypassed refresh from a titlebar metric-strip click.
  // The sample controller rate-limits it; the 2s system.onStats push is unchanged,
  // so this does not introduce renderer polling.
  'system.refreshStats': invokeMethod('system:refresh-stats'),
  'system.onStats': subscribeMethod('system:stats'),
  // displayMediaPicker.*: main-process getDisplayMedia source picker. onRequest
  // pushes the enumerated screen/window sources for the renderer picker UI;
  // onCancel fires if the request is superseded/aborted before a pick is made;
  // respond carries the user's pick (or null to cancel) back to the pending
  // session.setDisplayMediaRequestHandler callback.
  'displayMediaPicker.onRequest': subscribeMethod('display-media-picker:request'),
  'displayMediaPicker.onCancel': subscribeMethod('display-media-picker:cancel'),
  'displayMediaPicker.respond': invokeMethod('display-media-picker:respond'),
  // workspacePresentation.onRequest: ONE-SHOT main→renderer push from the
  // `workspace_present` builtin tool (services/workspace-presentation-service.js).
  // Deliberately a live event, never transcript metadata, so a presentation
  // request can never replay on reload/rehydrate. Emitted via sendBridgeEvent,
  // which is structurally main-workspace-window-only (overlay/comet windows
  // never receive it). Payload: { view, path, request_id, source } —
  // snake_case wire keys, workspace-relative path only.
  'workspacePresentation.onRequest': subscribeMethod('workspace-presentation:request'),
  'logs.list': invokeMethod('logs:list'),
  'logs.onAppend': subscribeMethod('logs:append'),
  // Fire-and-forget renderer→main log batches mirrored into shell.log.
  'logs.clientAppend': sendMethod('logs:client-append'),
  'diagnostics.logs.getSnapshot': invokeMethod('diagnostics:logs:snapshot'),
  'diagnostics.logs.onEntry': subscribeMethod('diagnostics:logs:entry'),
  'diagnostics.logs.appendRendererBatch': sendMethod('diagnostics:logs:renderer-batch'),
  'diagnostics.reportRendererError': invokeMethod('diagnostics:renderer-error'),
  // Per-stream renderer render/paint counters merged into the turn diagnostic
  // dump (client_timing) at stream terminal.
  'diagnostics.reportClientStreamMetrics': invokeMethod('diagnostics:client-stream-metrics'),
  'diagnostics.getStartupAuditConfig': invokeMethod('diagnostics:startup-audit-config'),
  'diagnostics.reportStartupMark': invokeMethod('diagnostics:startup-mark'),
  'diagnostics.reportStartupMarksBatch': invokeMethod('diagnostics:startup-marks-batch'),
  'diagnostics.getJennyStatus': invokeMethod('diagnostics:jenny-status'),
  'diagnostics.phasePercentiles.get': invokeMethod('diagnostics:phase-percentiles:get'),
  'diagnostics.phasePercentiles.reset': invokeMethod('diagnostics:phase-percentiles:reset'),
  'codexCli.getState': invokeMethod('codex-cli:get-state'),
  'codexCli.openLoginTerminal': invokeMethod('codex-cli:open-login-terminal'),
  'codexCli.refresh': invokeMethod('codex-cli:refresh'),
  'workspace.getState': invokeMethod('workspace:get-state'),
  'workspace.updateState': invokeMethod('workspace:update-state'),
  'chatUi.getState': invokeMethod('chat-ui:get-state'),
  'chatUi.updateSettings': invokeMethod('chat-ui:update-settings'),
  'windowUi.getState': invokeMethod('window-ui:get-state'),
  'windowUi.updateSettings': invokeMethod('window-ui:update-settings'),
  'modelTuning.getState': invokeMethod('model-tuning:get-state'),
  'modelTuning.update': invokeMethod('model-tuning:update'),
  'engineTuning.getState': invokeMethod('engine-tuning:get-state'),
  'engineTuning.update': invokeMethod('engine-tuning:update'),
  'engineTuning.reset': invokeMethod('engine-tuning:reset'),
  'compaction.getTuning': invokeMethod('compaction:get-tuning'),
  'compaction.setTuning': invokeMethod('compaction:set-tuning'),
  'chat.getNextTurnContextSummary': invokeMethod('chat:next-turn-context-summary'),
  'workspaceRoot.getState': invokeMethod('workspace-root:get-state'),
  'workspaceRoot.captureContext': invokeMethod('workspace-root:capture-context'),
  'workspaceRoot.prepareChoose': invokeMethod('workspace-root:prepare-choose'),
  'workspaceRoot.prepareClear': invokeMethod('workspace-root:prepare-clear'),
  'workspaceRoot.commit': invokeMethod('workspace-root:commit'),
  'workspaceRoot.cancel': invokeMethod('workspace-root:cancel'),
  'workspaceRoot.onExternalTransitionRequested': subscribeMethod('workspace-root:external-transition-requested'),
  'workspaceRoot.respondExternalTransition': invokeMethod('workspace-root:respond-external-transition'),
  'workspaceFs.getRootState': invokeMethod('workspace-fs:get-root-state'),
  'workspaceFs.readFile': invokeMethod('workspace-fs:read-file'),
  'workspaceFs.readFileBase64': invokeMethod('workspace-fs:read-file-base64'),
  'workspaceFs.stat': invokeMethod('workspace-fs:stat'),
  'workspaceFs.writeFile': invokeMethod('workspace-fs:write-file'),
  'workspaceFs.readText': invokeMethod('workspace-fs:read-text'),
  'workspaceFs.readImage': invokeMethod('workspace-fs:read-image'),
  'workspaceFs.writeText': invokeMethod('workspace-fs:write-text'),
  'workspaceFs.listDirectory': invokeMethod('workspace-fs:list-directory'),
  'workspaceFs.listAllFiles': invokeMethod('workspace-fs:list-all-files'),
  'workspaceFs.createFile': invokeMethod('workspace-fs:create-file'),
  'workspaceFs.createDirectory': invokeMethod('workspace-fs:create-directory'),
  'workspaceFs.rename': invokeMethod('workspace-fs:rename'),
  'workspaceFs.copyEntry': invokeMethod('workspace-fs:copy-entry'),
  'workspaceFs.previewImport': invokeMethod('workspace-fs:preview-import'),
  'workspaceFs.importExternal': invokeMethod('workspace-fs:import-external'),
  'workspaceFs.cancelImport': invokeMethod('workspace-fs:cancel-import'),
  'workspaceFs.delete': invokeMethod('workspace-fs:delete'),
  'workspaceFs.searchInFiles': invokeMethod('workspace-fs:search-in-files'),
  'workspaceFs.revealInFolder': invokeMethod('workspace-fs:reveal-in-folder'),
  'workspaceFs.openInDefaultApp': invokeMethod('workspace-fs:open-in-default-app'),
  'workspaceFs.readPreChange': invokeMethod('workspace-fs:read-pre-change'),
  'workspaceFs.watchStart': invokeMethod('workspace-fs:watch-start'),
  'workspaceFs.watchStop': invokeMethod('workspace-fs:watch-stop'),
  'workspaceFs.onChange': subscribeMethod('workspace-fs:changed'),
  'workspaceFs.onImportProgress': subscribeMethod('workspace-fs:import-progress'),
  'workspaceFs.onGitMetaChange': subscribeMethod('workspace-fs:git-meta-changed'),
  // WIDE-028: typed watcher lifecycle ({phase:'watching'|'stopped'|'degraded',
  // reason, context}) so a silent native watcher death can't strand the
  // renderer's watch latch (no other main->renderer signal existed).
  'workspaceFs.onWatchLifecycle': subscribeMethod('workspace-fs:watch-lifecycle'),
  // User-initiated WO-25 workspace recovery; never model-invocable.
  'workspaceRecovery.listChangeSets': invokeMethod('workspace-recovery:list-change-sets'),
  'workspaceRecovery.preflightUndo': invokeMethod('workspace-recovery:preflight-undo'),
  'workspaceRecovery.undoChangeSet': invokeMethod('workspace-recovery:undo-change-set'),
  'workspaceRecovery.restoreTrashEntry': invokeMethod('workspace-recovery:restore-trash-entry'),
  'workspaceRecovery.abandonRestore': invokeMethod('workspace-recovery:abandon-restore'),
  'workspaceGit.getStatus': invokeMethod('workspace-git:get-status'),
  'workspaceGit.getDiff': invokeMethod('workspace-git:get-diff'),
  'workspaceGit.getCommitDiff': invokeMethod('workspace-git:get-commit-diff'),
  'workspaceGit.getFileAtHead': invokeMethod('workspace-git:get-file-at-head'),
  'workspaceGit.getLog': invokeMethod('workspace-git:get-log'),
  'workspaceGit.getBranches': invokeMethod('workspace-git:get-branches'),
  'workspaceGit.blameRange': invokeMethod('workspace-git:blame-range'),
  'workspaceGit.stage': invokeMethod('workspace-git:stage'),
  'workspaceGit.unstage': invokeMethod('workspace-git:unstage'),
  'workspaceGit.commit': invokeMethod('workspace-git:commit'),
  'workspaceGit.discardFile': invokeMethod('workspace-git:discard-file'),
  'workspaceGit.checkout': invokeMethod('workspace-git:checkout'),
  'workspaceGit.stash': invokeMethod('workspace-git:stash'),
  'workspaceGit.undoLastCommit': invokeMethod('workspace-git:undo-last-commit'),
  'workspaceIde.getState': invokeMethod('workspace-ide:get-state'),
  'workspaceIde.updateSettings': invokeMethod('workspace-ide:update-settings'),
  'workspaceIde.updateState': invokeMethod('workspace-ide:update-state'),
  'workspaceTerminal.start': invokeMethod('workspace-terminal:start'),
  'workspaceTerminal.write': invokeMethod('workspace-terminal:write'),
  'workspaceTerminal.signal': invokeMethod('workspace-terminal:signal'),
  'workspaceTerminal.kill': invokeMethod('workspace-terminal:kill'),
  'workspaceTerminal.onData': subscribeMethod('workspace-terminal:data'),
  'workspaceTerminal.onExit': subscribeMethod('workspace-terminal:exit'),
  'workspacePty.spawn': invokeMethod('workspace-pty:spawn'),
  'workspacePty.write': invokeMethod('workspace-pty:write'),
  'workspacePty.resize': invokeMethod('workspace-pty:resize'),
  'workspacePty.kill': invokeMethod('workspace-pty:kill'),
  'workspacePty.onData': subscribeMethod('workspace-pty:data'),
  'workspacePty.onExit': subscribeMethod('workspace-pty:exit'),
  // UIUX-014: main-owned run-task identity/exit (see workspace-run-task-service.js).
  'workspaceRunTask.start': invokeMethod('workspace-run-task:start'),
  'workspaceRunTask.kill': invokeMethod('workspace-run-task:kill'),
  'workspaceRunTask.onData': subscribeMethod('workspace-run-task:data'),
  'workspaceRunTask.onExit': subscribeMethod('workspace-run-task:exit'),
  'workspaceFileMap.getGraph': invokeMethod('workspace-file-map:get-graph'),
  'workspaceFileMap.refresh': invokeMethod('workspace-file-map:refresh'),
  'workspaceTestRunner.listConfigs': invokeMethod('workspace-test-runner:list-configs'),
  'workspaceTestRunner.run': invokeMethod('workspace-test-runner:run'),
  'workspaceTestRunner.abort': invokeMethod('workspace-test-runner:abort'),
  'workspaceTestRunner.saveConfigs': invokeMethod('workspace-test-runner:save-configs'),
  'workspaceTestRunner.getState': invokeMethod('workspace-test-runner:get-state'),
  'workspaceTestRunner.onStateChanged': subscribeMethod('workspace-test-runner:state-changed'),
  'setup.getState': invokeMethod('setup:get-state'),
  'setup.updateState': invokeMethod('setup:update-state'),
  'setup.complete': invokeMethod('setup:complete'),
  'setup.reset': invokeMethod('setup:reset'),
  'setup.factoryReset': invokeMethod('setup:factory-reset'),
  'setup.validateEndpoint': invokeMethod('setup:validate-endpoint'),
  'setup.saveEndpoint': invokeMethod('setup:save-endpoint'),
  'setup.startOllamaPull': invokeMethod('setup:start-ollama-pull'),
  'setup.cancelOllamaPull': invokeMethod('setup:cancel-ollama-pull'),
  'setup.onModelPullProgress': subscribeMethod('setup:model-pull-progress'),
  'setup.detectOllama': invokeMethod('setup:detect-ollama'),
  'setup.getOllamaInstallPlan': invokeMethod('setup:get-ollama-install-plan'),
  'setup.installOllama': invokeMethod('setup:install-ollama'),
  'setup.cancelOllamaInstall': invokeMethod('setup:cancel-ollama-install'),
  'setup.onOllamaInstallProgress': subscribeMethod('setup:ollama-install-progress'),
  'mcpDiscovery.getState': invokeMethod('mcp-discovery:get-state'),
  'mcpDiscovery.refresh': invokeMethod('mcp-discovery:refresh'),
  'mcpDiscovery.createServer': invokeMethod('mcp-discovery:create-server'),
  'mcpDiscovery.updateServer': invokeMethod('mcp-discovery:update-server'),
  'mcpDiscovery.removeServer': invokeMethod('mcp-discovery:remove-server'),
  'mcpDiscovery.testServer': invokeMethod('mcp-discovery:test-server'),
  'mcpDiscovery.approveServer': invokeMethod('mcp-discovery:approve-server'),
  'mcpDiscovery.setServerEnabled': invokeMethod('mcp-discovery:set-server-enabled'),
  // mcpAuth.* namespace: presence-booleans-only auth status + save/clear for
  // an MCP server's secret_ref-backed token (SECURITY: getStatus must never
  // return a decrypted secret value; see services/mcp-discovery-service.js).
  'mcpAuth.getStatus': invokeMethod('mcp-auth:get-status'),
  'mcpAuth.set': invokeMethod('mcp-auth:set'),
  'mcpAuth.delete': invokeMethod('mcp-auth:delete'),
  'skills.getState': invokeMethod('skills:get-state'),
  'skills.updateSettings': invokeMethod('skills:update-settings'),
  'skills.openScopeFolder': invokeMethod('skills:open-scope-folder'),
  'skills.onChanged': subscribeMethod('skills:changed'),
  'tips.getState': invokeMethod('tips:get-state'),
  'tips.updateSettings': invokeMethod('tips:update-settings'),
  'tips.onChanged': subscribeMethod('tips:changed'),
  'scheduler.getState': invokeMethod('scheduler:get-state'),
  'scheduler.onChanged': subscribeMethod('scheduler:changed'),
  'knowledge.getState': invokeMethod('knowledge:get-state'),
  'knowledge.addFolder': invokeMethod('knowledge:add-folder'),
  'knowledge.removeFolder': invokeMethod('knowledge:remove-folder'),
  'knowledge.chooseFolder': invokeMethod('knowledge:choose-folder'),
  'knowledge.onChanged': subscribeMethod('knowledge:changed'),
  'home.getConfig': invokeMethod('home:get-config'),
  'home.updateConfig': invokeMethod('home:update-config'),
  'home.getAiJournal': invokeMethod('home:get-ai-journal'),
  'home.undoAiEntry': invokeMethod('home:undo-ai-entry'),
  'home.onAiChanged': subscribeMethod('home:ai-changed'),
  'weather.getState': invokeMethod('weather:get-state'),
  'weather.onChanged': subscribeMethod('weather:changed'),
  'linkStatus.getState': invokeMethod('link-status:get-state'),
  'linkStatus.onChanged': subscribeMethod('link-status:changed'),
  'calendar.getState': invokeMethod('calendar:get-state'),
  'calendar.createEvent': invokeMethod('calendar:create-event'),
  'calendar.updateEvent': invokeMethod('calendar:update-event'),
  'calendar.deleteEvent': invokeMethod('calendar:delete-event'),
  'calendar.onChanged': subscribeMethod('calendar:changed'),
  'features.getState': invokeMethod('features:get-state'),
  'features.updateSettings': invokeMethod('features:update-settings'),
  'features.getWebSearchSecretStatus': invokeMethod('features:get-web-search-secret-status'),
  'features.setWebSearchSecret': invokeMethod('features:set-web-search-secret'),
  'features.onChanged': subscribeMethod('features:changed'),
  'updates.getState': invokeMethod('updates:get-state'),
  'updates.check': invokeMethod('updates:check'),
  'updates.download': invokeMethod('updates:download'),
  'updates.install': invokeMethod('updates:install'),
  'updates.skip': invokeMethod('updates:skip'),
  'updates.onChanged': subscribeMethod('updates:changed'),
  'personality.getState': invokeMethod('personality:get-state'),
  'personality.save': invokeMethod('personality:save'),
  'personality.clear': invokeMethod('personality:clear'),
  'personality.openWorkspaceFolder': invokeMethod('personality:open-workspace-folder'),
  'memory.contextFiles.getState': invokeMethod('memory:context-files:get-state'),
  'memory.contextFiles.writeFile': invokeMethod('memory:context-files:write-file'),
  'memory.contextFiles.resetFile': invokeMethod('memory:context-files:reset-file'),
  // artifactFrame.stage: one-shot document staging for the sandboxed HTML
  // preview frame (renderer-html-artifact-frame-utils.js ->
  // services/artifact-frame-protocol.js). Returns { ok, url } where url is a
  // single-use jenny-artifact:// URL the factory assigns to iframe.src.
  'artifactFrame.stage': invokeMethod('artifact-frame:stage'),
  'artifacts.read': invokeMethod('artifacts:read'),
  'artifacts.save': invokeMethod('artifacts:save'),
  'artifacts.reveal': invokeMethod('artifacts:reveal'),
  'artifacts.openExternal': invokeMethod('artifacts:open-external'),
  'artifacts.delete': invokeMethod('artifacts:delete'),
  'artifacts.deleteSession': invokeMethod('artifacts:delete-session'),
  'memory.suggestForSession': invokeMethod('memory:suggest-for-session'),
  'memory.status': invokeMethod('memory:status'),
  'memory.save': invokeMethod('memory:save'),
  'memory.listApproved': invokeMethod('memory:list-approved'),
  'memory.listPending': invokeMethod('memory:list-pending'),
  'memory.update': invokeMethod('memory:update'),
  'memory.delete': invokeMethod('memory:delete'),
  'memory.deletePending': invokeMethod('memory:delete-pending'),
  'memory.dismiss': invokeMethod('memory:dismiss'),
  'harness.inspect': invokeMethod('harness:inspect'),
  'proactive.getState': invokeMethod('proactive:get-state'),
  'proactive.chooseWorkspaceRoot': invokeMethod('proactive:choose-workspace-root'),
  'proactive.clearWorkspaceRoot': invokeMethod('proactive:clear-workspace-root'),
  'proactive.upsertReminder': invokeMethod('proactive:upsert-reminder'),
  'proactive.deleteReminder': invokeMethod('proactive:delete-reminder'),
  'companion.getState': invokeMethod('companion:get-state'),
  'companion.setMode': invokeMethod('companion:set-mode'),
  'companion.addFollowUp': invokeMethod('companion:add-follow-up'),
  'companion.updateFollowUp': invokeMethod('companion:update-follow-up'),
  'companion.deferFollowUp': invokeMethod('companion:defer-follow-up'),
  'companion.activateFollowUp': invokeMethod('companion:activate-follow-up'),
  'companion.resolveFollowUp': invokeMethod('companion:resolve-follow-up'),
  'companion.archiveFollowUp': invokeMethod('companion:archive-follow-up'),
  'companion.unarchiveFollowUp': invokeMethod('companion:unarchive-follow-up'),
  'companion.deleteFollowUp': invokeMethod('companion:delete-follow-up'),
  'suggestions.generate': invokeMethod('suggestions:generate'),
  // One-shot, off-transcript local-model commit-message generation from a
  // staged diff (Source Control panel "Write message"). Backed by the backend
  // service (sidecar), so the handler is registered with the auxiliary
  // backend-aware handlers, not the git-service-only workspaceGit block.
  'commit.generateMessage': invokeMethod('commit:generate-message'),
  // One-shot, off-transcript fill-in-the-middle code completion for the editor
  // cursor (inline completion ghost text). Backed by the backend service (sidecar),
  // so it lives with the auxiliary backend-aware handlers.
  'inline.complete': invokeMethod('inline:complete'),
  // Which Ollama models are currently loaded (for the IDE completion menu's live
  // loaded/unloaded indicator), and evict a specific FIM model by tag.
  'inline.loadedModels': invokeMethod('inline:loaded-models'),
  'inline.unloadModel': invokeMethod('inline:unload'),
  // ollamaTray.* namespace: owner-triggered remediation for the Ollama
  // tray-app conflict (detection lives in ollama-tray-conflict.js). Explicit-
  // click actions only — never automatic.
  'ollamaTray.status': invokeMethod('ollama-tray:status'),
  'ollamaTray.quitTrayApp': invokeMethod('ollama-tray:quit'),
  'ollamaTray.disableStartupShortcut': invokeMethod('ollama-tray:disable-startup'),
  'ollamaTray.restartEngine': invokeMethod('ollama-tray:restart-engine'),
  // llamaServer.* namespace: explicit control and local GGUF discovery for the
  // single managed llama-server process. The manager remains main-process-owned.
  'llamaServer.getStatus': invokeMethod('llama-server:status'),
  'llamaServer.start': invokeMethod('llama-server:start'),
  'llamaServer.stop': invokeMethod('llama-server:stop'),
  'llamaServer.restart': invokeMethod('llama-server:restart'),
  'llamaServer.listLocalGgufs': invokeMethod('llama-server:list-local-ggufs'),
  'llamaServer.chooseGguf': invokeMethod('llama-server:choose-gguf'),
  'llamaServer.chooseLibraryFolder': invokeMethod('llama-server:choose-library-folder'),
  'offline.getState': invokeMethod('offline:get-state'),
  'offline.getDiagnostics': invokeMethod('offline:get-diagnostics'),
  'offline.updateSettings': invokeMethod('offline:update-settings'),
  'chat.startStream': invokeMethod('chat:start-stream'),
  'chat.editAndRegenerate': invokeMethod('chat:edit-and-regenerate'),
  'chat.retryUnsavedReply': invokeMethod('chat:retry-unsaved-reply'),
  'chat.discardUnsavedReply': invokeMethod('chat:discard-unsaved-reply'),
  'chat.getActiveTurnState': invokeMethod('chat:get-active-turn-state'),
  'chat.cancelStream': invokeMethod('chat:cancel-stream'),
  'chat.compactNow': invokeMethod('chat:compact-now'),
  'chat.hasPendingUserQuestions': invokeMethod('chat:has-pending-user-questions'),
  'chat.answerUserQuestions': invokeMethod('chat:answer-user-questions'),
  'chat.declineUserQuestions': invokeMethod('chat:decline-user-questions'),
  'chat.onStream': subscribeMethod('chat:stream'),
  'chat.onStreamEnvelope': subscribeMethod('chat:stream-envelope'),
  'chat.onStreamRecoveryRequired': subscribeMethod('chat:stream-recovery-required'),
  'chat.ackEnvelopeReceipt': invokeMethod('chat:ack-envelope-receipt'),
  'attachments.pick': invokeMethod('attachments:pick'),
  'attachments.prepare': invokeMethod('attachments:prepare'),
  'attachments.getPathForFile': localMethod('getPathForFile'),
  'attachments.saveImageAsset': invokeMethod('attachments:save-image-asset'),
  'attachments.saveAudioAsset': invokeMethod('attachments:save-audio-asset'),
  'attachments.releaseAssets': invokeMethod('attachments:release-assets'),
  // WIDE-019: bounded ID-based read of an ingested tool-result attachment.
  'attachments.readToolResultAsset': invokeMethod('attachments:read-tool-result-asset'),
  // spellcheck.*: composer spellcheck bridge (services/main/spellcheck-menu-bridge.js).
  // `params.misspelledWord` / `params.dictionarySuggestions` are reachable only
  // from the main-process `webContents.on('context-menu')` event, and Blink
  // emits that event only for an UNCANCELLED DOM contextmenu — a renderer
  // `preventDefault()` silently kills this whole surface.
  // onContext pushes ONLY that slice — { misspelled_word, dictionary_suggestions,
  // x, y }, snake_case wire keys — on every right-click, including a cleared
  // payload when nothing is misspelled so the renderer's bounded wait always
  // resolves. replaceMisspelling/addToDictionary are the two natively-owned
  // corrections; both validate a bounded (<=256 char) word and resolve
  // { ok, code } rather than throwing across the seam.
  'spellcheck.onContext': subscribeMethod('spellcheck:context'),
  'spellcheck.replaceMisspelling': invokeMethod('spellcheck:replace-misspelling'),
  'spellcheck.addToDictionary': invokeMethod('spellcheck:add-to-dictionary'),
  'clipboard.writeText': invokeMethod('clipboard:write-text'),
  // F4/F5/F6: save-file IPC for renderer-built content
  'dialog.saveFile': invokeMethod('dialog:save-file'),
  // backgroundJobs.*: chip visibility + kill for backgrounded run_command
  // jobs (W2-2). Snapshots push over the bridge-event bus (main-workspace
  // window only); kill is trusted-sender-authorized in
  // services/main/ipc-handler-registration.js.
  'backgroundJobs.getState': invokeMethod('background-jobs:get-state'),
  'backgroundJobs.kill': invokeMethod('background-jobs:kill'),
  'backgroundJobs.onChanged': subscribeMethod('background-jobs:changed'),
  'tools.list': invokeMethod('tools:list'),
  'tools.approve': invokeMethod('tools:approve'),
  'tools.deny': invokeMethod('tools:deny'),
  'tools.getPermissions': invokeMethod('tools:get-permissions'),
  'tools.setPermission': invokeMethod('tools:set-permission'),
  'tools.clearPermission': invokeMethod('tools:clear-permission'),
  'tools.removePermissionRule': invokeMethod('tools:remove-permission-rule'),
  'templates.list': invokeMethod('templates:list'),
  'templates.save': invokeMethod('templates:save'),
  'templates.delete': invokeMethod('templates:delete'),
  'templates.apply': invokeMethod('templates:apply'),
  'usage.getSnapshot': invokeMethod('usage:get-snapshot'),
  'usage.clearHistory': invokeMethod('usage:clear-history'),
  'window.getState': invokeMethod('window:get-state'),
  'window.onStateChanged': subscribeMethod('window:state-changed'),
  // UIUX-003 window-exit dirty guard: main→renderer one-shot request to run the
  // dirty-buffer preflight before a native close, and the renderer→main reply
  // carrying the user's decision (proceed).
  'window.onExitPreflightRequest': subscribeMethod('window:exit-preflight-request'),
  'window.respondExitPreflight': invokeMethod('window:exit-preflight-respond'),
  // Plugin descriptors are registered behind the default-on `plugins` kill switch.
  // Handlers authorize the Jenny sender and return structured results; contribution
  // authority is enforced by the plugin control-plane owner.
  'plugins.getState': invokeMethod('plugins:get-state'),
  'plugins.getDetails': invokeMethod('plugins:get-details'),
  'plugins.getPolicyStatus': invokeMethod('plugins:policy-status'),
  'plugins.getOperation': invokeMethod('plugins:operation'),
  'plugins.installLocalPackage': invokeMethod('plugins:install-local-package'),
  'plugins.installLocalPackageFromPath': invokeMethod('plugins:install-local-package-from-path'),
  'plugins.enable': invokeMethod('plugins:enable'),
  'plugins.disable': invokeMethod('plugins:disable'),
  'plugins.setContributionEnabled': invokeMethod('plugins:set-contribution-enabled'),
  'plugins.updateSettings': invokeMethod('plugins:update-settings'),
  'plugins.uninstall': invokeMethod('plugins:uninstall'),
  'plugins.exportAudit': invokeMethod('plugins:export-audit'),
  'plugins.getDistributionState': invokeMethod('plugins:distribution-state'),
  'plugins.getCatalogState': invokeMethod('plugins:catalog-state'),
  'plugins.refreshCatalogs': invokeMethod('plugins:refresh-catalogs'),
  'plugins.installFromCatalog': invokeMethod('plugins:install-from-catalog'),
  'plugins.updateFromCatalog': invokeMethod('plugins:update-from-catalog'),
  'plugins.listRollbackCandidates': invokeMethod('plugins:list-rollback-candidates'),
  'plugins.rollback': invokeMethod('plugins:rollback'),
  'plugins.retryRecovery': invokeMethod('plugins:retry-recovery'),
  'plugins.selectOfflineMirror': invokeMethod('plugins:select-offline-mirror'),
  'plugins.startDistributionOperation': invokeMethod('plugins:start-distribution-operation'),
  'plugins.cancelOperation': invokeMethod('plugins:cancel-operation'),
  'plugins.setNetworkConsent': invokeMethod('plugins:set-network-consent'),
  'plugins.beginRemoteMcpAuthorization': invokeMethod('plugins:begin-remote-mcp-authorization'),
  'plugins.revokeRemoteMcpAuthorization': invokeMethod('plugins:revoke-remote-mcp-authorization'),
  'plugins.openView': invokeMethod('plugins:open-view'),
  'plugins.setViewBounds': invokeMethod('plugins:set-view-bounds'),
  'plugins.setViewZoom': invokeMethod('plugins:set-view-zoom'),
  'plugins.closeView': invokeMethod('plugins:close-view'),
  'plugins.focusView': invokeMethod('plugins:focus-view'),
  'plugins.viewBridge': invokeMethod('plugins:view-bridge'),
  'plugins.onViewHostCommand': subscribeMethod('plugins:view-host-command'),
  'plugins.onChanged': subscribeMethod('plugins:changed'),
  'plugins.onOperationProgress': subscribeMethod('plugins:operation-progress'),
  'dataLifecycle.getOverview': invokeMethod('data-lifecycle:get-overview'),
  'dataLifecycle.chooseArchiveDestination': invokeMethod('data-lifecycle:choose-archive-destination'),
  'dataLifecycle.createArchive': invokeMethod('data-lifecycle:create-archive'),
  'dataLifecycle.previewWorkspaceArchive': invokeMethod('data-lifecycle:preview-workspace-archive'),
  'dataLifecycle.findRestoreCandidates': invokeMethod('data-lifecycle:find-restore-candidates'),
  'dataLifecycle.stageRestore': invokeMethod('data-lifecycle:stage-restore'),
  'dataLifecycle.previewWorkspaceRestore': invokeMethod('data-lifecycle:preview-workspace-restore'),
  'dataLifecycle.restoreWorkspace': invokeMethod('data-lifecycle:restore-workspace'),
  'dataLifecycle.launchUninstallAssistant': invokeMethod('data-lifecycle:launch-uninstall-assistant'),
  'dataLifecycle.syncPortablePreferences': invokeMethod('data-lifecycle:sync-portable-preferences'),
  'dataLifecycle.onProgress': subscribeMethod('data-lifecycle:progress'),
  // chatgptPlanUsage.*: composer footer plan-usage ring for the ChatGPT
  // subscription provider (host-owned engine, not the plugin package).
  // getSnapshot is a pull for first paint; onSnapshot pushes on every store
  // change, auth status change, or backend engine-status change. Flag-off
  // (chatgpt_plan_meter) or a missing backendService registers neither
  // channel -- byte-identical rollback. See docs/plans "ChatGPT plan-usage
  // meter" W2 and services/main/chatgpt-plan-usage-ipc.js.
  'chatgptPlanUsage.getSnapshot': invokeMethod('chatgpt-plan-usage:get-snapshot'),
  'chatgptPlanUsage.onSnapshot': subscribeMethod('chatgpt-plan-usage:snapshot'),
  windowControl: invokeMethod('window:control'),
  'comet.sendOverlayState': sendMethod('comet:overlay-state'),
  'comet.toggleOverlay': sendMethod('comet:overlay-toggle'),
});

function getBridgeDescriptor(methodPath) {
  return JENNY_SHELL_BRIDGE_DESCRIPTORS[String(methodPath || '').trim()] || null;
}

function getBridgeChannel(methodPath, expectedKind = '') {
  const descriptor = getBridgeDescriptor(methodPath);
  if (!descriptor) {
    throw new Error(`Unknown Jenny IPC bridge path: ${methodPath}`);
  }
  if (expectedKind && descriptor.kind !== expectedKind) {
    throw new Error(
      `Jenny IPC bridge path "${methodPath}" must be "${expectedKind}", received "${descriptor.kind}".`
    );
  }
  return descriptor.channel;
}

function assignBridgeMethod(target, methodPath, value) {
  const segments = String(methodPath || '').split('.').filter(Boolean);
  if (!segments.length) {
    throw new Error('Jenny IPC bridge paths must not be empty.');
  }
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!cursor[segment] || typeof cursor[segment] !== 'object') {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
}

function subscribeToBridgeChannel(ipcRenderer, channel, listener) {
  if (typeof listener !== 'function') {
    throw new TypeError(`Jenny IPC bridge listener for "${channel}" must be a function.`);
  }
  const wrapped = (_, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

function createJennyShellBridge({
  ipcRenderer,
  subscribe = subscribeToBridgeChannel,
  localImplementations = {},
} = {}) {
  if (!ipcRenderer) {
    throw new Error('createJennyShellBridge requires ipcRenderer.');
  }
  if (typeof subscribe !== 'function') {
    throw new TypeError('createJennyShellBridge requires subscribe to be a function.');
  }
  const bridge = {};
  for (const [methodPath, descriptor] of Object.entries(JENNY_SHELL_BRIDGE_DESCRIPTORS)) {
    let bridgeMethod;
    if (descriptor.kind === 'invoke') {
      bridgeMethod = (...args) => ipcRenderer.invoke(descriptor.channel, ...args);
    } else if (descriptor.kind === 'send') {
      bridgeMethod = (...args) => ipcRenderer.send(descriptor.channel, ...args);
    } else if (descriptor.kind === 'subscribe') {
      bridgeMethod = (listener) => subscribe(ipcRenderer, descriptor.channel, listener);
    } else if (descriptor.kind === 'local') {
      const impl = localImplementations[descriptor.impl];
      // Fail-soft when the hosting context did not provide the implementation
      // (e.g. test harnesses): the method exists but reports no result.
      bridgeMethod = typeof impl === 'function' ? impl : () => '';
    } else {
      throw new Error(`Unsupported Jenny IPC bridge method kind: ${descriptor.kind}`);
    }
    assignBridgeMethod(bridge, methodPath, bridgeMethod);
  }
  return bridge;
}

function registerIpcInvokeHandlers(
  ipcMainLike,
  handlersByPath = {},
  { authorize = null, unauthorizedResult = null } = {}
) {
  if (!ipcMainLike || typeof ipcMainLike.handle !== 'function') {
    throw new TypeError('registerIpcInvokeHandlers requires an ipcMain-like object with handle().');
  }
  const registeredChannels = [];
  for (const [methodPath, handler] of Object.entries(handlersByPath)) {
    if (typeof handler !== 'function') {
      throw new TypeError(`Jenny IPC bridge handler for "${methodPath}" must be a function.`);
    }
    const channel = getBridgeChannel(methodPath, 'invoke');
    const registeredHandler = typeof authorize === 'function'
      ? (event, ...args) => {
          let allowed = false;
          try {
            allowed = authorize(event, { methodPath, channel }) === true;
          } catch (_error) {
            /* authorization failures are denials */
          }
          if (!allowed) {
            return typeof unauthorizedResult === 'function'
              ? unauthorizedResult({ methodPath, channel })
              : { ok: false, authorized: false, code: 'ipc_sender_unauthorized' };
          }
          return handler(event, ...args);
        }
      : handler;
    ipcMainLike.handle(channel, registeredHandler);
    registeredChannels.push(channel);
  }
  return registeredChannels;
}

function listBridgeMethodPaths({ kind = '' } = {}) {
  return Object.keys(JENNY_SHELL_BRIDGE_DESCRIPTORS)
    .filter((methodPath) => !kind || JENNY_SHELL_BRIDGE_DESCRIPTORS[methodPath].kind === kind)
    .sort();
}

module.exports = {
  JENNY_SHELL_BRIDGE_DESCRIPTORS,
  createJennyShellBridge,
  getBridgeChannel,
  getBridgeDescriptor,
  listBridgeMethodPaths,
  registerIpcInvokeHandlers,
  subscribeToBridgeChannel,
};
