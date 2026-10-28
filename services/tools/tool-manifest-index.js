'use strict';

/* services/tools/tool-manifest-index.js — the one index over tool-manifest.json.
 *
 * Every Electron consumer (the default registry, the host/CLI conversation
 * registry, the surface families, the execution descriptors) reads manifest
 * entries through here, so a manifest fact has one projection: the manifest's
 * schema and availability win over a module's local definition. */

const toolManifest = require('./tool-manifest.json');

const MANIFEST_TOOLS = Object.freeze(toolManifest.tools.slice());
const manifestEntriesByName = new Map(MANIFEST_TOOLS.map((entry) => [entry.name, entry]));

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function manifestEntry(name) {
  return manifestEntriesByName.get(name);
}

// The policy source kind: the explicit source_kind, else the legacy category.
function manifestSourceKind(entry) {
  return String(entry?.source_kind || entry?.category || '');
}

// Overlay an Electron-owned tool definition with its manifest contract. A tool
// the manifest does not list as Electron-owned is returned unchanged.
function withManifestSchema(toolDefinition) {
  const entry = manifestEntriesByName.get(toolDefinition.name);
  if (!entry || entry.owner !== 'electron') {
    return toolDefinition;
  }
  return {
    ...toolDefinition,
    parameters: cloneJson(entry.parameters),
    readOnly: entry.read_only === true,
    sideEffecting: entry.side_effecting === true,
    workflowEligible: entry.workflow_eligible === true,
    toolFamily: typeof entry.tool_family === 'string' ? entry.tool_family : '',
    sourceKind: manifestSourceKind(entry),
    workspaceRequired: entry.availability?.workspace_required !== false,
    planModeOnly: entry.availability?.plan_mode_only === true,
    proposeModeOnly: entry.availability?.propose_mode_only === true,
    actions: entry.actions ? cloneJson(entry.actions) : undefined,
  };
}

module.exports = {
  MANIFEST_TOOLS,
  manifestEntry,
  manifestSourceKind,
  withManifestSchema,
};
