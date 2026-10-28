'use strict';

const { MANIFEST_TOOLS, manifestSourceKind } = require('../tools/tool-manifest-index');

// Capture built-in execution metadata once; callers cannot mutate the registry.
const descriptors = new Map(MANIFEST_TOOLS.map(tool => [tool.name, Object.freeze({
  name: tool.name,
  side_effecting: tool.side_effecting === true,
  read_only: tool.read_only === true,
  tool_family: String(tool.tool_family || ''),
  source_kind: manifestSourceKind(tool),
  server_name: '',
  actions: tool.actions,
  plan_mode_only: tool.availability?.plan_mode_only === true,
  propose_mode_only: tool.availability?.propose_mode_only === true,
  plan_mode_artifact_write: tool.availability?.plan_mode_artifact_write === true,
  workspace_required: tool.availability?.workspace_required !== false,
})]));

function builtinExecutionDescriptor(name) { return descriptors.get(name); }

const MCP_TOOL_PREFIX = 'mcp__';

// An approved, enabled standalone MCP server's tool (row 53, Astra W2 F1). The
// sidecar registers only the digest-approved surface and reports each tool's
// side_effecting in its tool status; Electron re-checks that the server is one
// the config store forwards (enabled, approved, digest current) and fails
// closed on anything else, so the per-call policy sees a descriptor with the
// same classification the sidecar applied (read_only_auto_allow included).
function externalMcpExecutionDescriptor(name, { statusEntry, approvedServerNames } = {}) {
  const toolName = String(name || '').trim();
  if (!toolName.startsWith(MCP_TOOL_PREFIX) || descriptors.has(toolName)) return undefined;
  if (!statusEntry || typeof statusEntry !== 'object' || Array.isArray(statusEntry)) return undefined;
  const serverName = String(statusEntry.server_name || '').trim();
  if (!serverName || statusEntry.available !== true
    || String(statusEntry.source_kind || '').trim() !== 'mcp'
    || !(approvedServerNames instanceof Set) || !approvedServerNames.has(serverName)
    || !toolName.startsWith(`${MCP_TOOL_PREFIX}${serverName}${'__'}`)) {
    return undefined;
  }
  const sideEffecting = statusEntry.side_effecting !== false;
  return Object.freeze({
    name: toolName,
    side_effecting: sideEffecting,
    read_only: !sideEffecting,
    tool_family: String(statusEntry.tool_family || 'other'),
    source_kind: 'mcp',
    server_name: serverName,
    actions: undefined,
    plan_mode_only: false,
    propose_mode_only: false,
    plan_mode_artifact_write: false,
    workspace_required: false,
  });
}

module.exports = { builtinExecutionDescriptor, externalMcpExecutionDescriptor };
