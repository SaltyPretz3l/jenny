'use strict';

const { ToolRegistry } = require('./tool-registry');
const { ToolPathPolicy } = require('./tool-path-policy');
const { ToolPermissionStore } = require('./tool-permission-store');
const { ToolExecutor } = require('./tool-executor');
const toolManifest = require('./tool-manifest.json');

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
const exitPlanModeTool = require('./builtin/exit-plan-mode-tool');
const askUserTool = require('./builtin/ask-user-tool');

const manifestEntriesByName = new Map(toolManifest.tools.map((entry) => [entry.name, entry]));

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function withManifestSchema(toolDefinition) {
  const manifestEntry = manifestEntriesByName.get(toolDefinition.name);
  if (!manifestEntry || manifestEntry.owner !== 'electron') {
    return toolDefinition;
  }
  return {
    ...toolDefinition,
    parameters: cloneJson(manifestEntry.parameters),
    readOnly: manifestEntry.read_only === true,
    sideEffecting: manifestEntry.side_effecting === true,
    workflowEligible: manifestEntry.workflow_eligible === true,
    toolFamily: typeof manifestEntry.tool_family === 'string' ? manifestEntry.tool_family : '',
    sourceKind: typeof manifestEntry.source_kind === 'string' ? manifestEntry.source_kind : '',
    workspaceRequired: manifestEntry.availability?.workspace_required !== false,
    planModeOnly: manifestEntry.availability?.plan_mode_only === true,
    actions: manifestEntry.actions ? cloneJson(manifestEntry.actions) : undefined,
  };
}

function createDefaultRegistry(options = {}) {
  const registry = new ToolRegistry();
  registry.registerTool(withManifestSchema(jennyStatusTool));
  registry.registerTool(withManifestSchema(exitPlanModeTool));
  registry.registerTool(withManifestSchema(askUserTool));
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
  if (options.toolsHomeEnabled === true) {
    registry.registerTool(withManifestSchema(homeTool));
  }
  if (options.toolsTaskBoardEnabled === true) {
    registry.registerTool(withManifestSchema(taskBoardTool));
  }
  return registry;
}

module.exports = {
  createDefaultRegistry,
  ToolRegistry,
  ToolPathPolicy,
  ToolPermissionStore,
  ToolExecutor,
};
