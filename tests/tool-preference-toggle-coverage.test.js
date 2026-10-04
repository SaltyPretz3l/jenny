'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SURFACE_FAMILIES, ALWAYS_ON_TOOL_NAMES, surfaceFamilyForTool,
  resolveRequestToolPreferences } = require('../services/tools/tool-surface-families');
const manifest = require('../services/tools/tool-manifest.json');

test('every explicit surface tool and always-on tool exists in the manifest', () => {
  const names = new Set(manifest.tools.map(tool => tool.name));
  for (const name of [...SURFACE_FAMILIES.flatMap(family => family.toolNames), ...ALWAYS_ON_TOOL_NAMES]) {
    assert.ok(names.has(name), name);
  }
});

test('every manifest tool has exactly one surface or is always on', () => {
  for (const tool of manifest.tools) {
    const matches = SURFACE_FAMILIES.filter(family => family.toolNames.includes(tool.name)
      || family.sidecarFamilies.includes(tool.tool_family));
    assert.equal(matches.length + Number(ALWAYS_ON_TOOL_NAMES.includes(tool.name)), 1, tool.name);
    assert.equal(surfaceFamilyForTool(tool.name), matches[0]?.id || '', tool.name);
  }
});

test('the always-on tool surface matches the reviewed literal contract', () => {
  assert.deepEqual(ALWAYS_ON_TOOL_NAMES, [
    'ask_user', 'exit_plan_mode', 'todo_write', 'todo_read', 'operation_status', 'jenny_status',
    'tool_search', 'load_skill', 'connections_list', 'session_spawn', 'session_wait', 'session_result',
  ]);
});

test('disabling every surface leaves every always-on tool untouched', () => {
  const families = Object.fromEntries(SURFACE_FAMILIES.map(family => [family.id, false]));
  const result = resolveRequestToolPreferences({ families });
  for (const tool of manifest.tools) {
    assert.equal(result.disabled_tools.includes(tool.name), !ALWAYS_ON_TOOL_NAMES.includes(tool.name), tool.name);
  }
  assert.equal(result.enabled_tools, undefined);
});
