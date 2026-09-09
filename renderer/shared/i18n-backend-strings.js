(function exposeJennyBackendStrings(globalScope, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  if (globalScope && typeof globalScope === 'object') {
    globalScope.jennyBackendStrings = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function i18nBackendStringsFactory() {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var ERROR_TEXT_BY_CODE = Object.freeze({
    'CMP-UPD-0001': function () { return jt('updates.service.checkFailed', 'Could not check GitHub. Check your connection and try again.'); },
    'CMP-UPD-0002': function () { return jt('updates.service.downloadFailed', 'Could not download and verify the update. Try the download again.'); },
    'CMP-UPD-0003': function () { return jt('updates.service.installFailed', 'Could not hand off the installer. Try again or open the releases page.'); },
    'CMP-AI-0001': function () { return jt('error.ai.modelNotLoaded', 'No model is loaded.'); },
    'CMP-AI-0002': function () { return jt('error.ai.engineConnectionLost', 'Lost connection to model engine.'); },
    'CMP-AI-0003': function () { return jt('error.ai.rateLimited', 'Rate-limited; retrying...'); },
    'CMP-AI-0005': function () { return jt('error.ai.generationFailed', 'Model generation failed.'); },
    'CMP-AI-0006': function () { return jt('error.ai.unsupportedModality', 'This model doesn\'t support {modality}.'); },
    'CMP-APPROVAL-REJECTED': function () { return jt('error.approval.rejected', 'Tool execution was denied.'); },
    'CMP-ARTIFACT-0001': function () { return jt('error.artifact.workspaceRootMissing', 'Tools workspace root is not configured.'); },
    'CMP-ARTIFACT-0002': function () { return jt('error.artifact.workspaceRootUnavailable', 'Tools workspace root is unavailable.'); },
    'CMP-ARTIFACT-0003': function () { return jt('error.artifact.extensionInvalid', 'Artifact extension must be a simple file extension.'); },
    'CMP-ARTIFACT-0004': function () { return jt('error.artifact.pathOutsideRoot', 'Artifact path is outside the configured workspace root.'); },
    'CMP-ARTIFACT-0005': function () { return jt('error.artifact.pathOutsideScratch', 'Artifact path is outside the session scratch directory.'); },
    'CMP-ARTIFACT-0006': function () { return jt('error.artifact.realPathEscapes', 'Artifact real path escapes the session scratch directory.'); },
    'CMP-ARTIFACT-0007': function () { return jt('error.artifact.notEditable', 'Artifact is not editable in Jenny.'); },
    'CMP-ARTIFACT-0008': function () { return jt('error.artifact.oversized', 'Artifact exceeds Jenny\'s 512 KB inline editor limit.'); },
    'CMP-ARTIFACT-0009': function () { return jt('error.artifact.fileUnavailable', 'Artifact file is unavailable.'); },
    'CMP-ARTIFACT-0010': function () { return jt('error.artifact.notFound', 'Artifact not found for this session.'); },
    'CMP-ARTIFACT-0011': function () { return jt('error.artifact.revealUnavailable', 'Reveal in folder is unavailable.'); },
    'CMP-ARTIFACT-0012': function () { return jt('error.artifact.openUnavailable', 'Open externally is unavailable.'); },
    'CMP-ARTIFACT-0013': function () { return jt('error.artifact.dangerousExtension', 'Artifact extension is dangerous and cannot be opened externally.'); },
    'CMP-ARTIFACT-0014': function () { return jt('error.artifact.invalidSession', 'A valid session id is required for artifact operations.'); },
    'CMP-ARTIFACT-0015': function () { return jt('error.artifact.invalidArtifactId', 'Artifact id is required.'); },
    'CMP-ARTIFACT-0016': function () { return jt('error.artifact.workspaceRootStateDirectory', 'Tools workspace root cannot be Jenny\'s own internal state directory (.jenny).'); },
    'CMP-CFG-0001': function () { return jt('error.config.workspaceRootRequired', 'Every enabled tool requires a workspace root, but none is configured. Set a workspace root in Settings, then try again.'); },
    'CMP-CHAT-0002': function () { return jt('error.chat.streamFailed', 'Chat stream failed.'); },
    'CMP-CHAT-0013': function () { return jt('error.chat.reasoningAfterVisibleText', 'Transcript protocol error: reasoning after visible text.'); },
    'CMP-COMPANION-0001': function () { return jt('error.companion.followUpInvalid', 'Follow-up label/body exceeds the configured limit.'); },
    'CMP-CTX-0001': function () { return jt('error.context.skillLoadFailed', 'Skill {name} failed to load.'); },
    'CMP-CTX-0002': function () { return jt('error.context.activeContextTooLarge', 'Start a new thread or reduce the active context.'); },
    'CMP-DATA-0001': function () { return jt('error.data.invalidRequest', 'The data operation request was invalid.'); },
    'CMP-DATA-0002': function () { return jt('error.data.busy', 'Another data operation is already running.'); },
    'CMP-DATA-0003': function () { return jt('error.data.unsafePath', 'Jenny refused an unsafe path.'); },
    'CMP-DATA-0004': function () { return jt('error.data.sourceUnreadable', 'A source file could not be archived safely.'); },
    'CMP-DATA-0005': function () { return jt('error.data.insufficientSpace', 'The archive destination needs more free space.'); },
    'CMP-DATA-0006': function () { return jt('error.data.authenticationFailed', 'Archive authentication failed.'); },
    'CMP-DATA-0007': function () { return jt('error.data.archiveCorrupt', 'This archive is incomplete or damaged.'); },
    'CMP-DATA-0008': function () { return jt('error.data.unsupportedVersion', 'This Jenny archive version is not supported.'); },
    'CMP-DATA-0009': function () { return jt('error.data.restoreConflict', 'Use session import because this profile already contains data.'); },
    'CMP-DATA-0010': function () { return jt('error.data.cleanupIncomplete', 'Cleanup was incomplete; review the receipt and retry.'); },
    'CMP-GIT-0001': function () { return jt('error.git.workspaceRootMissing', 'No workspace root is configured; choose a workspace folder first.'); },
    'CMP-GIT-0002': function () { return jt('error.git.pathInvalid', 'Path must be a workspace-relative path.'); },
    'CMP-GIT-0003': function () { return jt('error.git.pathOutsideRoot', 'Path resolves outside the workspace root.'); },
    'CMP-GIT-0004': function () { return jt('error.git.notTopLevel', 'Git write actions require the workspace root to be the repository\'s top-level folder.'); },
    'CMP-GIT-0010': function () { return jt('error.git.refInvalid', 'Invalid branch or ref name.'); },
    'CMP-GIT-0011': function () { return jt('error.git.lineRangeInvalid', 'Invalid line range for blame.'); },
    'CMP-GIT-0020': function () { return jt('error.git.commitMessageEmpty', 'Commit message cannot be empty.'); },
    'CMP-GIT-0040': function () { return jt('error.git.commandFailed', 'Git command failed.'); },
    'CMP-HARN-0001': function () { return jt('error.harness.turnNotFound', 'Turn not found.'); },
    'CMP-HOST-0001': function () { return jt('error.host.invalid', 'Invalid hosted request.'); },
    'CMP-HOST-0002': function () { return jt('error.host.unauthorized', 'Sign in again.'); },
    'CMP-HOST-0003': function () { return jt('error.host.forbidden', 'Control or permission required.'); },
    'CMP-HOST-0004': function () { return jt('error.host.conflict', 'The hosted state changed. Refresh and try again.'); },
    'CMP-HOST-0005': function () { return jt('error.host.unavailable', 'Host unavailable.'); },
    'CMP-HOST-0006': function () { return jt('error.host.persistence', 'Persistence failed.'); },
    'CMP-HOST-0007': function () { return jt('error.host.limit', 'Resource limit reached.'); },
    'CMP-INTERACTIVE-0001': function () { return jt('error.interactive.mixedTextAndBatch', 'Interactive protocol error: mixed text and batch.'); },
    'CMP-INTERACTIVE-0002': function () { return jt('error.interactive.invalidBatchPayload', 'Interactive protocol error: invalid batch payload.'); },
    'CMP-INTERACTIVE-0003': function () { return jt('error.interactive.textAfterBatch', 'Interactive protocol error: text after batch.'); },
    'CMP-INTERACTIVE-0004': function () { return jt('error.interactive.mixedTextAndPlanProposal', 'Interactive protocol error: mixed text and plan proposal in one turn.'); },
    'CMP-INTERACTIVE-0005': function () { return jt('error.interactive.invalidPlanProposal', 'Interactive protocol error: invalid plan proposal payload.'); },
    'CMP-INTERACTIVE-0006': function () { return jt('error.interactive.invalidContinuation', 'Interactive continuation is no longer valid.'); },
    'CMP-LOOP-0001': function () { return jt('error.loop.maxIterations', 'Tool loop reached its iteration limit.'); },
    'CMP-LOOP-0002': function () { return jt('error.loop.invalidToolCall', 'Invalid tool call from model.'); },
    'CMP-LOOP-0003': function () { return jt('error.loop.generationFailed', 'Generation failed: {detail}.'); },
    'CMP-LOOP-0004': function () { return jt('error.loop.textAndToolCalls', 'Loop protocol error: text and tool calls in same response.'); },
    'CMP-LOOP-0010': function () { return jt('error.loop.timedOut', 'Tool loop timed out.'); },
    'CMP-LOOP-0011': function () { return jt('error.loop.budgetExceeded', 'Tool loop budget exceeded.'); },
    'CMP-LOOP-0013': function () { return jt('error.loop.toolInterrupted', 'System error: tool execution interrupted. Retry if needed.'); },
    'CMP-LOOP-0014': function () { return jt('error.loop.cycleDetected', 'Tool loop is repeating itself; stopping.'); },
    'CMP-LOOP-0015': function () { return jt('error.loop.engineStalled', 'The active provider stopped streaming. Retry or adjust the provider timeout.'); },
    'CMP-LOOP-0016': function () { return jt('error.loop.toolInputInvalid', 'Tool argument validation failed: {detail}.'); },
    'CMP-LOOP-0017': function () { return jt('error.loop.repeatedErrors', 'Tool loop is repeating errors; stopping.'); },
    'CMP-LOOP-0018': function () { return jt('error.loop.repeatedObservations', 'Tool loop is repeating observations; stopping.'); },
    'CMP-LOOP-0019': function () { return jt('error.loop.stuckSuspected', 'Tool loop appears stuck; stopping.'); },
    'CMP-MCP-0001': function () { return jt('error.mcp.configInvalid', 'MCP server config invalid: {detail}.'); },
    'CMP-MCP-0002': function () { return jt('error.mcp.sseDisabled', 'MCP SSE transport disabled.'); },
    'CMP-MCP-0003': function () { return jt('error.mcp.toolNotFound', 'MCP tool not found: {name}.'); },
    'CMP-MCP-0004': function () { return jt('error.mcp.serverFailed', 'MCP server error: {detail}.'); },
    'CMP-MCP-0005': function () { return jt('error.mcp.protocolFailed', 'MCP protocol error.'); },
    'CMP-MCP-0006': function () { return jt('error.mcp.resourceUnsupported', 'MCP resource is unsupported.'); },
    'CMP-MCP-0007': function () { return jt('error.mcp.resourceNotFound', 'MCP resource not found.'); },
    'CMP-MCP-0008': function () { return jt('error.mcp.resourceInvalid', 'MCP resource request is invalid.'); },
    'CMP-MCP-0009': function () { return jt('error.mcp.toolSurfaceChanged', 'MCP tool review is stale; review this connection again.'); },
    'CMP-MEM-0001': function () { return jt('error.memory.operationFailed', 'Memory operation failed.'); },
    'CMP-MEM-0002': function () { return jt('error.memory.duplicateEntry', 'Duplicate memory entry.'); },
    'CMP-MEM-0003': function () { return jt('error.memory.invalidKind', 'Invalid memory kind: {kind}.'); },
    'CMP-MEM-0004': function () { return jt('error.memory.notFound', 'Memory entry not found.'); },
    'CMP-MEM-0005': function () { return jt('error.memory.schemaMigrationFailed', 'Memory database upgrade failed.'); },
    'CMP-MEM-0006': function () { return jt('error.memory.familyUnresolved', 'Memory family unresolved.'); },
    'CMP-MEM-0007': function () { return jt('error.memory.capacityExceeded', 'Memory storage capacity exceeded.'); },
    'CMP-MEM-0008': function () { return jt('error.memory.rowQuarantined', 'A malformed memory row was quarantined.'); },
    'CMP-MEM-0009': function () { return jt('error.memory.backgroundTaskTimedOut', 'A background memory task timed out.'); },
    'CMP-MODE-0002': function () { return jt('error.mode.toolUnavailable', 'This tool is unavailable in {mode} mode.'); },
    'CMP-PERS-0001': function () { return jt('error.personality.savePartialFailure', 'Some of your personality changes could not be saved.'); },
    'CMP-PERS-0002': function () { return jt('error.personality.fileTooLarge', 'That file is larger than the 64 KiB personality limit.'); },
    'CMP-PERSIST-0001': function () { return jt('error.persistence.importParseError', 'Session import failed because the selected file is not valid JSON.'); },
    'CMP-PERSIST-0002': function () { return jt('error.persistence.importFormatMismatch', 'Session import failed because the selected file is not a Jenny session export.'); },
    'CMP-PERSIST-0003': function () { return jt('error.persistence.importAttachmentFailed', 'Session import failed while restoring media attachment.'); },
    'CMP-PLUGIN-0001': function () { return jt('error.plugin.manifestInvalid', 'This plugin\'s manifest is invalid.'); },
    'CMP-PLUGIN-0002': function () { return jt('error.plugin.contractVersionUnsupported', 'This plugin requires a newer version of Jenny.'); },
    'CMP-PLUGIN-0003': function () { return jt('error.plugin.archiveRejected', 'This plugin package is malformed and was rejected.'); },
    'CMP-PLUGIN-0004': function () { return jt('error.plugin.integrityFailed', 'This plugin failed integrity verification.'); },
    'CMP-PLUGIN-0005': function () { return jt('error.plugin.signatureInvalid', 'This plugin\'s signature could not be verified.'); },
    'CMP-PLUGIN-0006': function () { return jt('error.plugin.publisherUntrusted', 'This plugin\'s publisher is not trusted.'); },
    'CMP-PLUGIN-0010': function () { return jt('error.plugin.leaseBusy', 'Another plugin operation is in progress.'); },
    'CMP-PLUGIN-0011': function () { return jt('error.plugin.generationConflict', 'Plugin state changed underneath this operation; retry.'); },
    'CMP-PLUGIN-0015': function () { return jt('error.plugin.policyBlocked', 'Policy blocks this plugin.'); },
    'CMP-PLUGIN-0016': function () { return jt('error.plugin.quarantined', 'This plugin is quarantined.'); },
    'CMP-PLUGIN-0017': function () { return jt('error.plugin.dependencyUnavailable', 'A plugin this depends on is unavailable.'); },
    'CMP-PLUGIN-0018': function () { return jt('error.plugin.dataIncompatible', 'This plugin\'s data is incompatible with the installed version.'); },
    'CMP-PLUGIN-0019': function () { return jt('error.plugin.cleanupPendingRestart', 'Cleanup will finish after a restart.'); },
    'CMP-PLUGIN-0021': function () { return jt('error.plugin.safeModeActive', 'Plugins are disabled in safe mode.'); },
    'CMP-PLUGIN-0022': function () { return jt('error.plugin.featureDisabled', 'The plugin system is not enabled.'); },
    'CMP-PLUGIN-0023': function () { return jt('error.plugin.consentRequired', 'This action needs explicit confirmation.'); },
    'CMP-PLUGIN-0025': function () { return jt('error.plugin.storeWriteFailed', 'Saving plugin state failed.'); },
    'CMP-PLUGIN-0026': function () { return jt('error.plugin.sourceUnavailable', 'This plugin source is unavailable.'); },
    'CMP-PLUGIN-0027': function () { return jt('error.plugin.updateMetadataInvalid', 'Plugin update metadata is invalid.'); },
    'CMP-PLUGIN-0028': function () { return jt('error.plugin.rollbackDetected', 'A stale or rolled-back update was blocked.'); },
    'CMP-PLUGIN-0029': function () { return jt('error.plugin.advisoryBlocked', 'A security advisory blocks this plugin version.'); },
    'CMP-PLUGIN-0030': function () { return jt('error.plugin.remoteAuthRequired', 'This remote plugin connection needs authorization.'); },
    'CMP-PLUGIN-0031': function () { return jt('error.plugin.remoteAuthFailed', 'Remote plugin authorization failed.'); },
    'CMP-PLUGIN-0032': function () { return jt('error.plugin.remoteProtocolUnsupported', 'This remote MCP server is not supported.'); },
    'CMP-PLUGIN-0033': function () { return jt('error.plugin.remoteTransportFailed', 'The remote MCP request failed.'); },
    'CMP-PLUGIN-0034': function () { return jt('error.plugin.operationCancelled', 'The plugin operation was cancelled.'); },
    'CMP-PLUGIN-0035': function () { return jt('error.plugin.resourceLimitExceeded', 'This plugin operation exceeded a safety limit.'); },
    'CMP-PLUGIN-0036': function () { return jt('error.plugin.hostFailed', 'The privileged plugin host could not complete this request.'); },
    'CMP-PROACTIVE-0001': function () { return jt('error.proactive.reminderInvalid', 'Reminder label/prompt/count exceeds the configured limit.'); },
    'CMP-PROTO-0003': function () { return jt('error.protocol.invalidRequest', 'Invalid JSON-RPC request.'); },
    'CMP-ROUTE-FAIL-CLOSED': function () { return jt('error.route.failedClosed', 'Tool routing failed closed.'); },
    'CMP-ROUTE-TOOL-DISABLED': function () { return jt('error.route.toolDisabled', 'This tool is disabled.'); },
    'CMP-RUNTASK-0001': function () { return jt('error.runTask.workspaceRootMissing', 'No workspace root is configured; choose a workspace folder first.'); },
    'CMP-RUNTASK-0010': function () { return jt('error.runTask.alreadyRunning', 'A task is already running.'); },
    'CMP-RUNTASK-0030': function () { return jt('error.runTask.spawnFailed', 'Could not start the task.'); },
    'CMP-RUNTASK-0040': function () { return jt('error.runTask.noTask', 'The run-task service has been disposed.'); },
    'CMP-RUNTIME-0001': function () { return jt('error.runtime.resourceLimitExceeded', 'Resource limit exceeded.'); },
    'CMP-SETUP-0001': function () { return jt('error.setup.endpointInvalid', 'Endpoint validation failed. Review the details and try again.'); },
    'CMP-SETUP-0002': function () { return jt('error.setup.endpointTimeout', 'Endpoint validation timed out.'); },
    'CMP-SETUP-0003': function () { return jt('error.setup.configRefreshFailed', 'The saved engine settings could not be applied. Check readiness and try again.'); },
    'CMP-SETUP-0004': function () { return jt('error.setup.terminationFailed', 'The setup process could not be confirmed stopped.'); },
    'CMP-SIDECAR-0001': function () { return jt('error.sidecar.timeout', 'Local engine timed out.'); },
    'CMP-SPELL-0001': function () { return jt('error.spellcheck.invalidWord', 'That word could not be corrected.'); },
    'CMP-SPELL-0002': function () { return jt('error.spellcheck.unavailable', 'Spellcheck corrections are unavailable in this window.'); },
    'CMP-SPELL-0003': function () { return jt('error.spellcheck.nativeFailed', 'The correction could not be applied.'); },
    'CMP-STREAM-INCOMPLETE': function () { return jt('error.stream.incomplete', 'The response was cut off before it finished.'); },
    'CMP-STREAM-REASONING-ONLY': function () { return jt('error.stream.reasoningOnly', 'The model returned reasoning without an answer.'); },
    'CMP-TERMINAL-0001': function () { return jt('error.terminal.spawnFailed', 'Could not start the terminal shell.'); },
    'CMP-TERMINAL-0002': function () { return jt('error.terminal.workspaceRootMissing', 'No workspace root is configured; choose a workspace folder first.'); },
    'CMP-TERMINAL-0003': function () { return jt('error.terminal.noSession', 'No terminal session is running.'); },
    'CMP-TERMINAL-0004': function () { return jt('error.terminal.moduleLoadFailed', 'The terminal engine could not be loaded.'); },
    'CMP-TESTRUNNER-0001': function () { return jt('error.testRunner.workspaceRootMissing', 'No workspace root is configured; choose a workspace folder first.'); },
    'CMP-TESTRUNNER-0002': function () { return jt('error.testRunner.configNotFound', 'That test configuration no longer exists.'); },
    'CMP-TESTRUNNER-0003': function () { return jt('error.testRunner.cwdOutsideRoot', 'The test working directory must stay inside the workspace.'); },
    'CMP-TESTRUNNER-0004': function () { return jt('error.testRunner.configActiveRun', 'That configuration has an active test run and cannot be removed until it finishes or is stopped.'); },
    'CMP-TESTRUNNER-0010': function () { return jt('error.testRunner.alreadyRunning', 'A test run is already in progress.'); },
    'CMP-TESTRUNNER-0030': function () { return jt('error.testRunner.spawnFailed', 'Could not start the test command.'); },
    'CMP-TOOL-0001': function () { return jt('error.tool.approvalDenied', 'Tool execution was denied.'); },
    'CMP-TOOL-0002': function () { return jt('error.tool.disabled', 'Tool is disabled in this mode.'); },
    'CMP-TOOL-0005': function () { return jt('error.tool.unknown', 'Unknown tool: {name}.'); },
    'CMP-TOOL-0006': function () { return jt('error.tool.fileOperationFailed', 'File operation failed: {detail}.'); },
    'CMP-TOOL-0014': function () { return jt('error.tool.todoUpdateFailed', 'Todo list update failed: {detail}.'); },
    'CMP-TOOL-0015': function () { return jt('error.tool.todoCapacityExceeded', 'Todo list capacity exceeded.'); },
    'CMP-TOOL-0016': function () { return jt('error.tool.backgroundTaskNotFound', 'Background task not found.'); },
    'CMP-TOOL-0018': function () { return jt('error.tool.readBeforeEdit', 'Read the file before editing it.'); },
    'CMP-TOOL-0019': function () { return jt('error.tool.fileChangedSinceRead', 'File changed since last read; re-read and retry.'); },
    'CMP-TOOL-0025': function () { return jt('error.tool.patchParseFailed', 'Patch could not be parsed: {detail}.'); },
    'CMP-TOOL-0026': function () { return jt('error.tool.patchPreimageMismatch', 'Patch preimage did not match file contents.'); },
    'CMP-TOOL-0027': function () { return jt('error.tool.patchRollbackFailed', 'Patch failed; some files could not be restored.'); },
    'CMP-TOOL-0028': function () { return jt('error.tool.addTargetExists', 'Cannot add file: target already exists.'); },
    'CMP-TOOL-0029': function () { return jt('error.tool.modifyTargetMissing', 'Cannot modify file: target does not exist.'); },
    'CMP-TOOL-0030': function () { return jt('error.tool.subAgentPromptInvalid', 'Sub-agent prompt invalid.'); },
    'CMP-TOOL-0031': function () { return jt('error.tool.subAgentGrantsInvalid', 'Sub-agent grants invalid.'); },
    'CMP-TOOL-0032': function () { return jt('error.tool.subAgentNested', 'Sub-agents cannot nest.'); },
    'CMP-TOOL-0033': function () { return jt('error.tool.subAgentWorktreeRequired', 'Mutating sub-agent requires a worktree.'); },
    'CMP-TOOL-0034': function () { return jt('error.tool.subAgentBudgetExceeded', 'The sub-agent stopped before producing an answer.'); },
    'CMP-TOOL-0035': function () { return jt('error.tool.adapterMismatch', 'File type does not match the requested adapter.'); },
    'CMP-TOOL-0036': function () { return jt('error.tool.richFileTooLarge', 'File exceeds the rich-file size limit.'); },
    'CMP-TOOL-0037': function () { return jt('error.tool.adapterUnsupported', 'Unsupported file type for this adapter.'); },
    'CMP-TOOL-0038': function () { return jt('error.tool.optionalDependencyMissing', 'Optional dependency missing for this file type.'); },
    'CMP-TOOL-0039': function () { return jt('error.tool.policyDenied', 'Tool was denied by policy.'); },
    'CMP-TOOL-0040': function () { return jt('error.tool.skillUnknown', 'unknown skill \'{name}\'. Available skills: ...'); },
    'CMP-TOOL-0041': function () { return jt('error.tool.commandCancelled', 'Command aborted by user cancellation.'); },
    'CMP-TOOL-0042': function () { return jt('error.tool.approvalWindowDropped', 'Tool was not executed: it was not part of the approved execution window for this turn.'); },
    'CMP-TOOL-0043': function () { return jt('error.tool.worktreeBaselineMissing', 'Worktree baseline is missing or expired; capture a new workspace_change_baseline.'); },
    'CMP-TOOL-0044': function () { return jt('error.tool.placeholderArgumentsRejected', 'Tool \'{name}\' was not executed: the arguments are the schema example placeholders, not real values. Supply real arguments, or if no tool is needed, answer the user directly.'); },
    'CMP-TOOL-0045': function () { return jt('error.tool.gitRepositoryRequired', 'Worktree operations require a Git repository within the workspace.'); },
    'CMP-TOOL-0046': function () { return jt('error.tool.autoRunPaused', 'Tool \'{tool_id}\' was not executed: auto run was paused because the user stepped away. Re-issue the call; it will ask for approval.'); },
    'CMP-TSRCH-0002': function () { return jt('error.toolSearch.invalidQuery', 'Tool search query invalid.'); },
    'CMP-TSRCH-0003': function () { return jt('error.toolSearch.deferredTool', 'Tool requires search-then-call.'); },
    'CMP-WEB-0001': function () { return jt('error.web.privateNetworkBlocked', 'Blocked: URL resolves to private network.'); },
    'CMP-WEB-0002': function () { return jt('error.web.rateLimited', 'Rate-limited; wait before retrying.'); },
    'CMP-WEB-0004': function () { return jt('error.web.fetchFailed', 'Fetch failed: {detail}.'); },
    'CMP-WEB-0005': function () { return jt('error.web.redirectBlocked', 'Redirect blocked.'); },
    'CMP-WEB-0006': function () { return jt('error.web.responseTooLarge', 'Response too large.'); },
    'CMP-WEB-0007': function () { return jt('error.web.invalidUrl', 'Invalid URL: {url}.'); },
    'CMP-WORKSPACEFS-0001': function () { return jt('error.workspaceFs.rootMissing', 'No workspace root is configured; choose a workspace folder first.'); },
    'CMP-WORKSPACEFS-0002': function () { return jt('error.workspaceFs.pathInvalid', 'Path must be a workspace-relative path.'); },
    'CMP-WORKSPACEFS-0003': function () { return jt('error.workspaceFs.pathOutsideRoot', 'Path resolves outside the workspace root.'); },
    'CMP-WORKSPACEFS-0004': function () { return jt('error.workspaceFs.notFound', 'File not found in the workspace.'); },
    'CMP-WORKSPACEFS-0005': function () { return jt('error.workspaceFs.notAFile', 'Path is not a regular file.'); },
    'CMP-WORKSPACEFS-0006': function () { return jt('error.workspaceFs.notADirectory', 'Path is not a directory.'); },
    'CMP-WORKSPACEFS-0007': function () { return jt('error.workspaceFs.rootInvalid', 'The workspace root folder is missing or invalid; re-select the workspace folder.'); },
    'CMP-WORKSPACEFS-0008': function () { return jt('error.workspaceFs.rootTransitioning', 'The workspace root is changing; retry after the transition completes.'); },
    'CMP-WORKSPACEFS-0009': function () { return jt('error.workspaceFs.staleGeneration', 'Reload the file in the current workspace before saving.'); },
    'CMP-WORKSPACEFS-0010': function () { return jt('error.workspaceFs.binaryFile', 'File appears to be binary and cannot be opened as text.'); },
    'CMP-WORKSPACEFS-0011': function () { return jt('error.workspaceFs.fileTooLarge', 'File is too large to open or save in the editor.'); },
    'CMP-WORKSPACEFS-0012': function () { return jt('error.workspaceFs.imageTooLarge', 'Image is too large to preview.'); },
    'CMP-WORKSPACEFS-0013': function () { return jt('error.workspaceFs.unsupportedEncoding', 'File is not valid editable UTF-8 text.'); },
    'CMP-WORKSPACEFS-0014': function () { return jt('error.workspaceFs.imageUnsupported', 'Only supported workspace image files can be opened as images.'); },
    'CMP-WORKSPACEFS-0020': function () { return jt('error.workspaceFs.writeConflict', 'File changed on disk since it was last loaded.'); },
    'CMP-WORKSPACEFS-0021': function () { return jt('error.workspaceFs.atomicWriteFailed', 'The file could not be replaced atomically; the original was left intact.'); },
    'CMP-WORKSPACEFS-0022': function () { return jt('error.workspaceFs.ioFailed', 'The workspace file operation failed safely.'); },
    'CMP-WORKSPACEFS-0023': function () { return jt('error.workspaceFs.writeQueueFull', 'Too many workspace file writes are pending; retry shortly.'); },
    'CMP-WORKSPACEFS-0030': function () { return jt('error.workspaceFs.exists', 'A file or folder with that name already exists.'); },
    'CMP-WORKSPACEFS-0040': function () { return jt('error.workspaceFs.trashFailed', 'Could not move the item to the recycle bin.'); },
    'CMP-WORKSPACEFS-0050': function () { return jt('error.workspaceFs.watchFailed', 'Could not watch the workspace folder for changes.'); },
    'CMP-WORKSPACEFS-0060': function () { return jt('error.workspaceFs.revealUnavailable', 'Reveal in File Explorer is unavailable in this shell mode.'); },
    'CMP-WORKSPACEFS-0061': function () { return jt('error.workspaceFs.openUnavailable', 'Open in Default App is unavailable in this shell mode.'); },
    'CMP-WORKSPACEFS-0062': function () { return jt('error.workspaceFs.openFailed', 'The OS could not open the item.'); },
  });

  var APPROVAL_SCOPE_BY_TEXT = Object.freeze({
    'Local command execution': function () { return jt('approval.scope.localCommandExecution', 'Local command execution'); },
    'Workspace files': function () { return jt('approval.scope.workspaceFiles', 'Workspace files'); },
    'Web and browser session': function () { return jt('approval.scope.webAndBrowserSession', 'Web and browser session'); },
    'Jenny work items': function () { return jt('approval.scope.jennyWorkItems', 'Jenny work items'); },
    'Jenny content': function () { return jt('approval.scope.jennyContent', 'Jenny content'); },
    'Local computer': function () { return jt('approval.scope.localComputer', 'Local computer'); },
    'Requested tool': function () { return jt('approval.scope.requestedTool', 'Requested tool'); },
  });

  var APPROVAL_CONSEQUENCE_BY_TEXT = Object.freeze({
    'May run a local command and change local state.': function () { return jt('approval.consequence.mayRunLocalCommandAndChangeLocalState', 'May run a local command and change local state.'); },
    'May change data in this scope.': function () { return jt('approval.consequence.mayChangeDataInThisScope', 'May change data in this scope.'); },
    'May read data in this scope.': function () { return jt('approval.consequence.mayReadDataInThisScope', 'May read data in this scope.'); },
    'Review requested input': function () { return jt('approval.consequence.reviewRequestedInput', 'Review requested input'); },
  });

  function activeLanguageIsEnglish() {
    try {
      return !globalThis.jennyI18n
        || typeof globalThis.jennyI18n.tag !== 'function'
        || globalThis.jennyI18n.tag() === 'en';
    } catch (_error) {
      return true;
    }
  }

  function translateExact(table, text) {
    if (typeof text !== 'string') return '';
    var translate = Object.prototype.hasOwnProperty.call(table, text) ? table[text] : null;
    if (!translate) return text;
    try {
      var translated = translate();
      return typeof translated === 'string' ? translated : text;
    } catch (_error) {
      return text;
    }
  }

  function errorText(code, backendMessage) {
    if (typeof code !== 'string' || typeof backendMessage !== 'string') return '';
    if (activeLanguageIsEnglish()) return backendMessage;
    var translate = Object.prototype.hasOwnProperty.call(ERROR_TEXT_BY_CODE, code)
      ? ERROR_TEXT_BY_CODE[code]
      : null;
    if (!translate) return backendMessage;
    try {
      var translated = translate();
      // A canonical sentence that still carries a {placeholder} would replace
      // the backend's specifics ("Invalid URL: {url}.") with a hole; the
      // backend text wins until the parameters travel with the error.
      if (typeof translated !== 'string' || /\{[A-Za-z0-9_]+\}/.test(translated)) return backendMessage;
      return translated;
    } catch (_error) {
      return backendMessage;
    }
  }

  return {
    errorText: errorText,
    approvalScope: function approvalScope(text) { return translateExact(APPROVAL_SCOPE_BY_TEXT, text); },
    approvalConsequence: function approvalConsequence(text) { return translateExact(APPROVAL_CONSEQUENCE_BY_TEXT, text); },
  };
});
