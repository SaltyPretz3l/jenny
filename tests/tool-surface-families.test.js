'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SURFACE_FAMILIES, ALWAYS_ON_TOOL_NAMES, LEGACY_TOGGLE_TO_SURFACE,
  surfaceFamilyForTool, connectionIdForTool, resolveRequestToolPreferences } = require('../services/tools/tool-surface-families');
const manifest = require('../services/tools/tool-manifest.json');

test('surface registry has the ordered sections and frozen public arrays', () => {
  assert.deepEqual(SURFACE_FAMILIES.map(({ id, section }) => [id, section]), [
    ['files', 'project'], ['terminal', 'project'], ['git', 'project'], ['python', 'project'],
    ['code', 'project'], ['checks', 'project'], ['artifacts', 'create'], ['images', 'create'],
    ['web', 'reach'], ['knowledge', 'reach'], ['home', 'reach'], ['helpers', 'reach'],
  ]);
  assert.ok(Object.isFrozen(SURFACE_FAMILIES));
  assert.ok(Object.isFrozen(ALWAYS_ON_TOOL_NAMES));
  assert.deepEqual(LEGACY_TOGGLE_TO_SURFACE, {
    web_search: 'web', Bash: 'terminal', python_execute: 'python', file_tools: 'files',
  });
});

test('every manifest tool belongs to exactly one family or always-on surface', () => {
  for (const tool of manifest.tools) {
    const matches = SURFACE_FAMILIES.filter(family => family.toolNames.includes(tool.name)
      || family.sidecarFamilies.includes(tool.tool_family));
    assert.equal(matches.length + Number(ALWAYS_ON_TOOL_NAMES.includes(tool.name)), 1, tool.name);
  }
});

test('explicit tool names win and manifest families provide the fallback', () => {
  assert.equal(surfaceFamilyForTool('image_generate', 'shell'), 'images');
  assert.equal(surfaceFamilyForTool('automation_list', 'web'), 'home');
  assert.equal(surfaceFamilyForTool('workspace_present', 'filesystem'), 'checks');
  assert.equal(surfaceFamilyForTool('delegate', 'shell'), 'helpers');
  assert.equal(surfaceFamilyForTool('read_file'), 'files');
  assert.equal(surfaceFamilyForTool('read_file', 'web'), 'web');
  assert.equal(surfaceFamilyForTool('unknown', 'diagram'), 'artifacts');
  assert.equal(surfaceFamilyForTool('unknown'), '');
});

test('terminal off disables all six shell tools including monitors', () => {
  assert.deepEqual(resolveRequestToolPreferences({ families: { terminal: false } }), {
    disabled_tools: ['check_background_job', 'check_monitor', 'monitor',
      'run_command', 'run_temp_script', 'stop_background_job'],
  });
});

test('files off also disables artifacts unless an explicit artifact boolean overrides compatibility', () => {
  for (const artifacts of [undefined, null, 'true', false]) {
    const result = resolveRequestToolPreferences({ families: { files: false, artifacts } });
    assert.ok(result.disabled_tools.includes('read_file'));
    assert.ok(result.disabled_tools.includes('workspace_manifest_read'));
    assert.ok(result.disabled_tools.includes('create_artifact'));
    assert.ok(result.disabled_tools.includes('mermaid_generate'));
    assert.equal(result.enabled_tools, undefined);
  }
  const result = resolveRequestToolPreferences({ families: { files: false, artifacts: true } });
  assert.ok(result.disabled_tools.includes('read_file'));
  assert.equal(result.disabled_tools.includes('create_artifact'), false);
  assert.equal(result.disabled_tools.includes('mermaid_generate'), false);
});

test('connection identity prefers explicit ids then MCP server names', () => {
  assert.equal(connectionIdForTool('search', { connection_id: 'custom', source_kind: 'mcp', server_name: 'github' }), 'custom');
  assert.equal(connectionIdForTool('search', { connection_id: '', source_kind: 'mcp', server_name: 'github' }), 'mcp:github');
  assert.equal(connectionIdForTool('search', { source_kind: 'mcp', server_name: 'github' }), 'mcp:github');
  for (const entry of [undefined, {}, { source_kind: 'builtin', server_name: 'github' },
    { source_kind: 'mcp', server_name: '' }, { source_kind: 'mcp', server_name: ' ' },
    { source_kind: 'mcp', server_name: 'electron_tool_bridge' }, { source_kind: 'mcp', server_name: 'jenny_local_tools' }]) {
    assert.equal(connectionIdForTool('search', entry), '');
  }
});

test('MCP connection off disables only matching catalog tools', () => {
  const catalog = {
    mcp__github__search: { available: true, source_kind: 'mcp', server_name: 'github' },
    mcp__other__search: { available: true, source_kind: 'mcp', server_name: 'other' },
    plugin_render: { source_kind: 'plugin', connection_id: 'plugin:render' },
    read_file: { available: true },
  };
  assert.deepEqual(resolveRequestToolPreferences({ connections: { 'mcp:github': false } }, catalog), {
    disabled_tools: ['mcp__github__search'],
  });
  assert.deepEqual(resolveRequestToolPreferences({ connections: { 'plugin:render': false } }, catalog), {
    disabled_tools: ['plugin_render'],
  });
});

test('catalog family members join manifest tools and always-on names cannot be disabled', () => {
  const catalog = {
    plugin_shell: { tool_family: 'shell', connection_id: 'plugin:shell', available: false },
    ask_user: { tool_family: 'shell', connection_id: 'plugin:shell' },
    mcp__github__search: { source_kind: 'mcp', server_name: 'github' },
  };
  const result = resolveRequestToolPreferences({ families: { terminal: false },
    connections: { 'plugin:shell': false } }, catalog);
  assert.deepEqual(result, { disabled_tools: ['check_background_job', 'check_monitor', 'monitor',
    'plugin_shell', 'run_command', 'run_temp_script', 'stop_background_job'] });
});

test('all-on, empty, unknown and non-boolean preferences emit no request arrays', () => {
  const allOn = Object.fromEntries(SURFACE_FAMILIES.map(family => [family.id, true]));
  for (const raw of [undefined, {}, { families: {} }, { families: allOn },
    { families: { unknown: false, files: 'false', terminal: 0 }, connections: { unknown: false } },
    { families: [], connections: [] }, { connections: { 'mcp:github': true } }]) {
    assert.equal(resolveRequestToolPreferences(raw), undefined);
  }
});
