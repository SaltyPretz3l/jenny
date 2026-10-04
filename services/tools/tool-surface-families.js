'use strict';

const manifest = require('./tool-manifest.json');

const SURFACE_FAMILIES = Object.freeze([
  { id: 'files', section: 'project', sidecarFamilies: ['filesystem'], toolNames: [] },
  { id: 'terminal', section: 'project', sidecarFamilies: ['shell'], toolNames: [] },
  { id: 'git', section: 'project', sidecarFamilies: ['git'], toolNames: [] },
  { id: 'python', section: 'project', sidecarFamilies: ['python'], toolNames: [] },
  { id: 'code', section: 'project', sidecarFamilies: ['code_intelligence'], toolNames: [] },
  { id: 'checks', section: 'project', sidecarFamilies: [], toolNames: ['workspace_present', 'preview_test', 'verify'] },
  { id: 'artifacts', section: 'create', sidecarFamilies: ['artifact', 'diagram'], toolNames: [] },
  { id: 'images', section: 'create', sidecarFamilies: [], toolNames: ['image_generate'] },
  { id: 'web', section: 'reach', sidecarFamilies: ['web'], toolNames: [] },
  { id: 'knowledge', section: 'reach', sidecarFamilies: ['knowledge'], toolNames: [] },
  { id: 'home', section: 'reach', sidecarFamilies: ['home'], toolNames: ['automation_list', 'automation_read'] },
  { id: 'helpers', section: 'reach', sidecarFamilies: [], toolNames: ['delegate'] },
].map(family => Object.freeze({ ...family,
  sidecarFamilies: Object.freeze(family.sidecarFamilies), toolNames: Object.freeze(family.toolNames) })));

const ALWAYS_ON_TOOL_NAMES = Object.freeze([
  'ask_user', 'exit_plan_mode', 'todo_write', 'todo_read', 'operation_status', 'jenny_status',
  'tool_search', 'load_skill', 'connections_list', 'session_spawn', 'session_wait', 'session_result',
]);

const LEGACY_TOGGLE_TO_SURFACE = Object.freeze({
  web_search: 'web', Bash: 'terminal', python_execute: 'python', file_tools: 'files',
});

const manifestToolFamilies = new Map(manifest.tools.map(tool => [tool.name, tool.tool_family]));

function surfaceFamilyForTool(name, toolFamily) {
  const explicit = SURFACE_FAMILIES.find(family => family.toolNames.includes(name));
  if (explicit) return explicit.id;
  const sidecarFamily = toolFamily || manifestToolFamilies.get(name);
  return SURFACE_FAMILIES.find(family => family.sidecarFamilies.includes(sidecarFamily))?.id || '';
}

// Builtin and plugin tools share these transport names, so they never identify
// a connection (plugins carry an explicit connection_id instead).
const BRIDGE_SERVER_NAMES = new Set(['jenny_local_tools', 'electron_tool_bridge']);

function connectionIdForTool(name, entry) {
  if (typeof entry?.connection_id === 'string' && entry.connection_id.trim()) return entry.connection_id;
  if (entry?.source_kind === 'mcp' && typeof entry.server_name === 'string' && entry.server_name.trim()
    && !BRIDGE_SERVER_NAMES.has(entry.server_name)) {
    return `mcp:${entry.server_name}`;
  }
  return '';
}

function resolveRequestToolPreferences(raw, catalog) {
  const families = raw?.families && typeof raw.families === 'object' && !Array.isArray(raw.families)
    ? raw.families : {};
  const connections = raw?.connections && typeof raw.connections === 'object' && !Array.isArray(raw.connections)
    ? raw.connections : {};
  const disabledFamilies = new Set(SURFACE_FAMILIES.filter(family => families[family.id] === false)
    .map(family => family.id));
  if (families.files === false && typeof families.artifacts !== 'boolean') disabledFamilies.add('artifacts');
  const disabledConnections = new Set(Object.keys(connections).filter(id => connections[id] === false));
  const disabledTools = new Set();
  for (const tool of manifest.tools) {
    if (disabledFamilies.has(surfaceFamilyForTool(tool.name, tool.tool_family))) disabledTools.add(tool.name);
  }
  if (catalog && typeof catalog === 'object' && !Array.isArray(catalog)) {
    for (const [name, entry] of Object.entries(catalog)) {
      const connectionId = connectionIdForTool(name, entry);
      if (disabledFamilies.has(surfaceFamilyForTool(name, entry?.tool_family))
        || (connectionId && disabledConnections.has(connectionId))) disabledTools.add(name);
    }
  }
  for (const name of ALWAYS_ON_TOOL_NAMES) disabledTools.delete(name);
  return disabledTools.size ? { disabled_tools: [...disabledTools].sort() } : undefined;
}

module.exports = { SURFACE_FAMILIES, ALWAYS_ON_TOOL_NAMES, LEGACY_TOGGLE_TO_SURFACE,
  surfaceFamilyForTool, connectionIdForTool, resolveRequestToolPreferences };
