'use strict';

const { ToolRegistry } = require('./tool-registry');
const { ToolPathPolicy } = require('./tool-path-policy');
const { ToolPermissionStore } = require('./tool-permission-store');
const { ToolExecutor } = require('./tool-executor');
const { withManifestSchema } = require('./tool-manifest-index');

const jennyStatusTool = require('./builtin/jenny-status-tool');
const worktreeListTool = require('./builtin/worktree-list-tool');
const worktreeCreateTool = require('./builtin/worktree-create-tool');
const worktreeSelectTool = require('./builtin/worktree-select-tool');
const worktreeDeleteTool = require('./builtin/worktree-delete-tool');
const automationListTool = require('./builtin/automation-list-tool');
const automationReadTool = require('./builtin/automation-read-tool');
const workspacePresentTool = require('./builtin/workspace-present-tool');
const previewTestTool = require('./builtin/preview-test-tool');
const verifyTool = require('./builtin/verify-tool');
const homeTool = require('./builtin/home-tool');
const taskBoardTool = require('./builtin/task-board-tool');
const projectNotesTool = require('./builtin/project-notes-tool');
const { conversationsRecentTool, conversationOpenTool, conversationsSearchTool } = require('./builtin/conversations-tool');
const exitPlanModeTool = require('./builtin/exit-plan-mode-tool');
const askUserTool = require('./builtin/ask-user-tool');
const suggestNextStepTool = require('./builtin/suggest-next-step-tool');
const proposeGitActionTool = require('./builtin/propose-git-action-tool');
const proposeCommandTool = require('./builtin/propose-command-tool');
const proposeSessionTool = require('./builtin/propose-session-tool');
const completeSessionHandoffTool = require('./builtin/complete-session-handoff-tool');
const sessionMessageTool = require('./builtin/session-message-tool');
const sessionsListTool = require('./builtin/sessions-list-tool');
const sessionStatusTool = require('./builtin/session-status-tool');
const sessionTranscriptTool = require('./builtin/session-transcript-tool');
const sessionStopTool = require('./builtin/session-stop-tool');
const settingsGetTool = require('./builtin/settings-get-tool');
const settingsChangeTool = require('./builtin/settings-change-tool');
const chatOrganizeTool = require('./builtin/chat-organize-tool');
const projectCreateTool = require('./builtin/project-create-tool');
const projectsListTool = require('./builtin/projects-list-tool');
const appViewTool = require('./builtin/app-view-tool');
const sessionExportTool = require('./builtin/session-export-tool');
const terminalReadTool = require('./builtin/terminal-read-tool');
const terminalRunTool = require('./builtin/terminal-run-tool');
const chatConfigureTool = require('./builtin/chat-configure-tool');
const scheduleListTool = require('./builtin/schedule-list-tool');
const scheduleChangeTool = require('./builtin/schedule-change-tool');
const awayDigestTool = require('./builtin/away-digest-tool');
const jennyHelpTool = require('./builtin/jenny-help-tool');

function createDefaultRegistry(options = {}) {
  const registry = new ToolRegistry();
  registry.registerTool(withManifestSchema(jennyStatusTool));
  for (const tool of require('./builtin/session-runtime-tools')) registry.registerTool(withManifestSchema(tool));
  registry.registerTool(withManifestSchema(exitPlanModeTool));
  registry.registerTool(withManifestSchema(askUserTool));
  registry.registerTool(withManifestSchema(proposeGitActionTool));
  registry.registerTool(withManifestSchema(proposeCommandTool));
  registry.registerTool(withManifestSchema(proposeSessionTool));
  registry.registerTool(withManifestSchema(completeSessionHandoffTool));
  registry.registerTool(withManifestSchema(sessionMessageTool));
  // Row 69 W4b: the bundled app guide; flag-less and read-only, so it is always registered.
  registry.registerTool(withManifestSchema(jennyHelpTool));
  if (options.toolsWorktreeEnabled === true) {
    registry.registerTool(withManifestSchema(worktreeListTool));
    registry.registerTool(withManifestSchema(worktreeCreateTool));
    registry.registerTool(withManifestSchema(worktreeSelectTool));
    registry.registerTool(withManifestSchema(worktreeDeleteTool));
  }
  if (options.toolsAutomationsEnabled === true) {
    registry.registerTool(withManifestSchema(automationListTool));
    registry.registerTool(withManifestSchema(automationReadTool));
  }
  if (options.toolsWorkspacePresentEnabled === true) {
    registry.registerTool(withManifestSchema(workspacePresentTool));
  }
  if (options.toolsPreviewTestEnabled === true) {
    registry.registerTool(withManifestSchema(previewTestTool));
  }
  if (options.toolsVerifyEnabled === true) {
    registry.registerTool(withManifestSchema(verifyTool));
  }
  if (options.toolsImageGenerateEnabled === true) {
    registry.registerTool(withManifestSchema(require('./builtin/image-generate-tool')));
  }
  if (options.toolsHomeEnabled === true) {
    registry.registerTool(withManifestSchema(homeTool));
  }
  if (options.toolsNextStepEnabled === true) {
    registry.registerTool(withManifestSchema(suggestNextStepTool));
  }
  if (options.toolsTaskBoardEnabled === true) {
    registry.registerTool(withManifestSchema(taskBoardTool));
  }
  if (options.toolsProjectNotesEnabled === true) {
    registry.registerTool(withManifestSchema(projectNotesTool));
  }
  if (options.toolsConversationsEnabled === true) {
    registry.registerTool(withManifestSchema(conversationsRecentTool));
    registry.registerTool(withManifestSchema(conversationOpenTool));
    registry.registerTool(withManifestSchema(conversationsSearchTool));
  }
  if (options.toolsSessionDirectoryEnabled === true) {
    for (const tool of [sessionsListTool, sessionStatusTool, sessionTranscriptTool, sessionStopTool]) registry.registerTool(withManifestSchema(tool));
  }
  if (options.toolsPrimarySettingsEnabled === true) {
    for (const tool of [settingsGetTool, settingsChangeTool]) registry.registerTool(withManifestSchema(tool));
  }
  if (options.toolsPrimaryChatManageEnabled === true) {
    for (const tool of [chatOrganizeTool, chatConfigureTool]) registry.registerTool(withManifestSchema(tool));
  }
  // Row 94 P2: the caller passes `primary_chat !== false && primary_chat_placement !== false`.
  if (options.toolsPrimaryChatPlacementEnabled === true) {
    for (const tool of [projectCreateTool, projectsListTool]) registry.registerTool(withManifestSchema(tool));
  }
  // Row 94 P3: the caller passes `primary_chat !== false && primary_app_view !== false`.
  if (options.toolsPrimaryAppViewEnabled === true) registry.registerTool(withManifestSchema(appViewTool));
  // Row 94 P4: `primary_chat !== false && primary_chat_export !== false`; the terminal pair needs `terminal_tools !== false`,
  // and terminal_run also the Jenny chat (primary-settings-tool-gate.js denies it to every other chat).
  if (options.toolsPrimaryChatExportEnabled === true) registry.registerTool(withManifestSchema(sessionExportTool));
  if (options.toolsTerminalEnabled === true) registry.registerTool(withManifestSchema(terminalReadTool));
  if (options.toolsTerminalRunEnabled === true) registry.registerTool(withManifestSchema(terminalRunTool));
  if (options.toolsPrimarySchedulesEnabled === true) {
    for (const tool of [scheduleListTool, scheduleChangeTool]) registry.registerTool(withManifestSchema(tool));
  }
  // Row 86: default off; the caller passes `primary_chat !== false && primary_digests === true`.
  if (options.toolsPrimaryDigestsEnabled === true) registry.registerTool(withManifestSchema(awayDigestTool));
  return registry;
}

module.exports = {
  createDefaultRegistry,
  ToolRegistry,
  ToolPathPolicy,
  ToolPermissionStore,
  ToolExecutor,
  withManifestSchema,
};
