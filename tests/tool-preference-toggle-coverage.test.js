// Red-first (W6, spec section 6.4): the composer toggle groups have a documented
// incident class — because a non-empty enabled_tools acts as an exclusive
// allowlist in sidecar/ai/tools/assembly.py, any tool id that drifts out of
// TOOL_PREFERENCE_TOGGLE_TO_TOOL_IDS silently vanishes from the model's offer
// the moment one toggle is set (this dropped mermaid_generate once, and
// delete_file/tool_search/git_* until 2026-07). NON_TOGGLE_GROUP_TOOL_IDS is
// derived from the manifest, so the two live risks are the inverse directions:
// a toggle group naming a tool the manifest no longer has (a rename that missed
// this file), and a tool silently falling OFF a toggle group into the derived
// off-group set. Both must break loudly here before any W7 rename lands.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TOOL_PREFERENCE_TOGGLE_TO_TOOL_IDS,
  NON_TOGGLE_GROUP_TOOL_IDS,
} = require('../services/backend/backend-service-utils.js');
const manifest = require('../services/tools/tool-manifest.json');

const manifestToolIds = new Set(manifest.tools.map((tool) => String(tool.name || '')));

test('every toggle-group tool id exists in the canonical manifest', () => {
  const stale = [];
  for (const [toggleKey, toolIds] of Object.entries(TOOL_PREFERENCE_TOGGLE_TO_TOOL_IDS)) {
    for (const toolId of toolIds) {
      if (!manifestToolIds.has(toolId)) {
        stale.push(`${toggleKey}: ${toolId}`);
      }
    }
  }
  assert.deepEqual(
    stale,
    [],
    'toggle groups reference tool ids missing from tool-manifest.json — a rename or ' +
      'retirement missed backend-service-utils.js (see the 6.4 incident note)'
  );
});

test('every manifest tool is deliberately grouped or deliberately off-group', () => {
  const grouped = new Set(Object.values(TOOL_PREFERENCE_TOGGLE_TO_TOOL_IDS).flat());
  const offGroup = new Set(NON_TOGGLE_GROUP_TOOL_IDS);
  const uncovered = [...manifestToolIds].filter(
    (name) => name && !grouped.has(name) && !offGroup.has(name)
  );
  assert.deepEqual(uncovered, [], 'manifest tool covered by neither surface');
});

test('the off-group surface matches the reviewed snapshot', () => {
  // Deliberate LITERAL pin (not a recomputation of the production derivation,
  // which would be a vacuous oracle): a tool leaving a toggle group, or a new
  // tool landing off-group, changes composer behavior and must be a conscious
  // edit here — never a silent side effect of a manifest change.
  const expected = [
    'ask_user',
    'automation_list', 'automation_read', 'check_monitor', 'connections_list',
    'delegate', 'exit_plan_mode', 'git_diff', 'git_log',
    'git_show', 'git_status', 'home', 'jenny_status',
    'knowledge_exec', 'knowledge_search', 'knowledge_view', 'load_skill',
    'lsp', 'monitor', 'operation_status', 'preview_test', 'task_board', 'todo_read', 'todo_write',
    'tool_search', 'verify', 'workspace_change_baseline', 'workspace_change_delta',
    'workspace_manifest_read', 'workspace_present', 'worktree_create',
    'worktree_delete', 'worktree_list', 'worktree_select',
  ];
  assert.deepEqual([...NON_TOGGLE_GROUP_TOOL_IDS].sort(), expected);
});
