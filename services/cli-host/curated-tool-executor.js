'use strict';

const { createConversationToolExecutor } = require('../host/conversation-tool-executor');
const { CLI_ERROR_CODES, cliError } = require('./local-only-providers');
// One desktop-only list for the whole CLI: the registry fence here and the
// run ceiling share it, so the two can never disagree on a tool.
const { DESKTOP_ONLY_TOOLS } = require('./run-permission-policy');

// The Electron-owned tools the CLI serves itself. Sidecar-owned tools run in
// the sidecar's builtin host and never pass through this registry.
const CLI_CURATED_TOOLS = Object.freeze(['ask_user', 'exit_plan_mode']);

function assertCuratedRegistry(registry) {
  const names = registry.getAllTools().map((tool) => tool.name).sort();
  const exact = names.length === CLI_CURATED_TOOLS.length
    && names.every((name, index) => name === CLI_CURATED_TOOLS[index]);
  if (!exact || DESKTOP_ONLY_TOOLS.some((name) => registry.getTool(name) !== undefined)) {
    throw cliError(Error, CLI_ERROR_CODES.TOOL_REGISTRY_DRIFT, 'cli_tool_registry_drift',
      'The CLI tool registry no longer matches its curated set.');
  }
  return registry;
}

function createCuratedToolExecutor({ configService, permissionStore = null, logger } = {}) {
  const executor = createConversationToolExecutor({ configService, permissionStore, logger });
  assertCuratedRegistry(executor.registry);
  return executor;
}

module.exports = {
  CLI_CURATED_TOOLS,
  DESKTOP_ONLY_TOOLS,
  assertCuratedRegistry,
  createCuratedToolExecutor,
};
