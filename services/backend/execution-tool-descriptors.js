'use strict';

const toolManifest = require('../tools/tool-manifest.json');

// Capture built-in execution metadata once; callers cannot mutate the registry.
const descriptors = new Map(toolManifest.tools.map(tool => [tool.name, Object.freeze({
  name: tool.name,
  side_effecting: tool.side_effecting === true,
  read_only: tool.read_only === true,
  tool_family: String(tool.tool_family || ''),
  source_kind: String(tool.source_kind || tool.category || ''),
  server_name: '',
  actions: tool.actions,
  plan_mode_only: tool.availability?.plan_mode_only === true,
  plan_mode_artifact_write: tool.availability?.plan_mode_artifact_write === true,
  workspace_required: tool.availability?.workspace_required !== false,
})]));

function builtinExecutionDescriptor(name) { return descriptors.get(name); }

module.exports = { builtinExecutionDescriptor };
