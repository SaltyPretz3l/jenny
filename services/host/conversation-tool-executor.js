'use strict';

const { ToolRegistry } = require('../tools/tool-registry');
const { ToolExecutor } = require('../tools/tool-executor');
const manifest = require('../tools/tool-manifest.json');
const askUser = require('../tools/builtin/ask-user-tool');
const exitPlanMode = require('../tools/builtin/exit-plan-mode-tool');

// Reuse the canonical owner handlers with a deliberately closed registry.
// No workspace executor, plugin provider, Git, browser, or native service is
// composed here. Sidecar blocking decisions still precede preapproved calls.
function createConversationToolExecutor({ configService, logger }) {
  const registry = new ToolRegistry();
  for (const definition of [askUser, exitPlanMode]) {
    const entry = manifest.tools.find((tool) => tool.name === definition.name && tool.owner === 'electron');
    if (!entry) throw new Error('host_conversation_tool_contract_missing');
    registry.registerTool({ ...definition, parameters: structuredClone(entry.parameters),
      readOnly: entry.read_only === true, sideEffecting: entry.side_effecting === true,
      toolFamily: entry.tool_family, sourceKind: entry.source_kind,
      workspaceRequired: entry.availability?.workspace_required !== false,
      planModeOnly: entry.availability?.plan_mode_only === true });
  }
  return new ToolExecutor({ registry, configService, logger, permissionStore: null, pathPolicy: null });
}

module.exports = { createConversationToolExecutor };
