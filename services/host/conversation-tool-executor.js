'use strict';

const { ToolRegistry } = require('../tools/tool-registry');
const { ToolExecutor } = require('../tools/tool-executor');
const { manifestEntry, withManifestSchema } = require('../tools/tool-manifest-index');
const askUser = require('../tools/builtin/ask-user-tool');
const exitPlanMode = require('../tools/builtin/exit-plan-mode-tool');

// Reuse the canonical owner handlers with a deliberately closed registry.
// No workspace executor, plugin provider, Git, browser, or native service is
// composed here. Sidecar blocking decisions still precede preapproved calls.
function createConversationToolExecutor({ configService, logger, permissionStore = null }) {
  const registry = new ToolRegistry();
  for (const definition of [askUser, exitPlanMode]) {
    if (manifestEntry(definition.name)?.owner !== 'electron') {
      throw new Error('host_conversation_tool_contract_missing');
    }
    registry.registerTool(withManifestSchema(definition));
  }
  return new ToolExecutor({ registry, configService, logger, permissionStore, pathPolicy: null });
}

module.exports = { createConversationToolExecutor };
