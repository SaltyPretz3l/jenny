'use strict';

// new-test-file: server/team-conversation-preferences.js on its own (row 172), no router, store or host: the team
// keys split off a preferences command, the turn's tool narrowing against a catalog, and the file-tool reading. The
// router and store path is in tests/server/team-allowed-nodes.test.js.

const assert = require('node:assert/strict');
const test = require('node:test');

const { TEAM_CONVERSATION_PREFERENCES, teamPreferencesPatch } = require('../../services/backend/session-normalizers');
const {
  FILE_TOOLS_REASONS, TOOL_GROUPS, fileToolsReason, fileToolsState, teamPreferenceChange, teamSnapshotFields,
  turnToolPreferences, withTeamPreferences,
} = require('../../server/team-conversation-preferences');
const { FILE_TOOLS_REASONS: CLIENT_FILE_TOOLS_REASONS } = require('../../services/team/project-answers');

const command = { request_id: 'req_1' };
const backend = (models) => ({ turnRoute: { offeredModels: () => models } });
const author = { member_id: 'member_a' };
const reasonOf = (fn) => { try { fn(); return 'ok'; } catch (error) { return error.routerFailure?.error?.reason ?? error.message; } };

test('the team keys split off; a non-team host and a model not offered now are refused with their reasons', () => {
  const at = Date.parse('2026-11-16T10:00:00Z');
  const split = teamPreferenceChange(command, { plan_mode: true, preferred_model: 'm1', reasoning_effort: 'low',
    team_tools: { write: false } }, { teamHost: true, backend: backend(['m1']), author: { member_id: 'member_a' }, now: () => at });
  assert.deepEqual(split.rest, { plan_mode: true });
  assert.deepEqual(split.change, { by: 'member_a', at: '2026-11-16T10:00:00.000Z', plan: true, model: 'm1', effort: 'low',
    tools: { write: false } });
  const preferences = withTeamPreferences(split.rest, split.change);
  assert.deepEqual(preferences[TEAM_CONVERSATION_PREFERENCES], split.change);
  assert.equal(JSON.stringify(preferences), '{"plan_mode":true}', 'the change rides only the symbol key');
  assert.deepEqual(teamPreferenceChange(command, { run_mode: 'ask' }, { teamHost: false }), { rest: { run_mode: 'ask' }, change: null });
  assert.equal(reasonOf(() => teamPreferenceChange(command, { team_tools: { read: false } }, { teamHost: false })),
    'team_preference_unsupported');
  for (const [model, models] of [['m2', ['m1']], ['m1', []], ['team-pool', ['team-pool']]]) {
    assert.equal(reasonOf(() => teamPreferenceChange(command, { preferred_model: model }, { teamHost: true, backend: backend(models), author })),
      'conversation_model_not_offered', model);
  }
  const throwing = { turnRoute: { offeredModels: () => { throw new Error('down'); } } };
  assert.equal(reasonOf(() => teamPreferenceChange(command, { preferred_model: 'm1' }, { teamHost: true, backend: throwing, author })),
    'conversation_model_not_offered', 'a pool that cannot answer offers nothing');
  assert.equal(teamPreferenceChange(command, { preferred_model: null }, { teamHost: true, backend: {}, author }).change.model, null,
    'the team default needs no pool');
  assert.equal(reasonOf(() => teamPreferenceChange(command, { team_tools: { read: false } }, { teamHost: true })), 'member_author_required',
    'a change needs a member author, as a send does');
  assert.equal(reasonOf(() => teamPreferenceChange(command, { team_tools: { read: false } }, { teamHost: true, author, busy: true })),
    'session_active', 'nothing changes while a turn runs');
});

test('the turn: both switches on keep the session\'s own preferences; a switch off resolves them and adds its group', () => {
  const session = { tool_category_overrides: { web: false }, tool_connection_overrides: {}, team_tool_switches: { read: true, write: true } };
  assert.deepEqual(turnToolPreferences(session, { teamHost: true }), { families: { web: false }, connections: {} });
  assert.equal(turnToolPreferences({}, { teamHost: true }), undefined);
  const narrowed = { ...session, team_tool_switches: { read: false, write: false } };
  assert.deepEqual(turnToolPreferences(narrowed, { teamHost: false }), { families: { web: false }, connections: {} },
    'any other host ignores the switches');
  const catalog = { mcp_tool: { available: true, tool_family: 'web' } };
  const { disabled_tools: disabled } = turnToolPreferences(narrowed, { teamHost: true, catalog });
  for (const tool of [...TOOL_GROUPS.read, ...TOOL_GROUPS.write, 'web_search', 'mcp_tool']) assert.ok(disabled.includes(tool), tool);
  assert.deepEqual(disabled, [...disabled].sort(), 'sorted, no repeats');
  assert.equal(new Set(disabled).size, disabled.length);
});

// Team host file tools (row 123): the main sidecar lists both typed file tools as needing a workspace (its own process
// has no root), so `available` follows the worker's report (`hosted_files`) with both tools registered.
const workspaceRequired = { available: false, reason: 'workspace_required' };
const status = ({ hosted, registered }) => ({ currentStatus: {
  tools_status: registered ? { read_file: workspaceRequired, write_file: workspaceRequired } : { ask_user: { available: true } },
  ...(hosted === undefined ? {} : { hosted_files: hosted }),
} });

test('file tools read as available only with the worker reporting them and both typed tools registered (four cases)', () => {
  const on = { available: true, reason: null };
  const refused = { available: false, reason: 'file_access_switch_off' };
  assert.equal(fileToolsState(status({ hosted: on, registered: true })), 'available');
  assert.equal(fileToolsState(status({ hosted: on, registered: false })), 'unavailable');
  assert.equal(fileToolsState(status({ hosted: refused, registered: true })), 'unavailable');
  assert.equal(fileToolsState(status({ hosted: refused, registered: false })), 'unavailable');
  for (const value of [status({ registered: true }), {}, { currentStatus: { tools_status: [] } }, null]) {
    assert.equal(fileToolsState(value), 'unavailable', 'no report (the setting off) is unavailable');
  }
  assert.equal(fileToolsReason(status({ hosted: on, registered: true })), null);
  assert.equal(fileToolsReason(status({ hosted: refused, registered: true })), 'file_access_switch_off');
  assert.equal(fileToolsReason(status({ hosted: on, registered: false })), 'file_access_unavailable');
  assert.equal(fileToolsReason(status({ registered: true })), null, 'the setting off carries no reason');
  assert.deepEqual(teamSnapshotFields({}, status({ hosted: refused, registered: true })).file_tools_reason,
    'file_access_switch_off');
  assert.equal(Object.hasOwn(teamSnapshotFields({}, status({ hosted: on, registered: true })), 'file_tools_reason'), false);
});

test('an unknown reason word becomes the one generic word, and host and client share one closed list', () => {
  for (const reason of ['file_access_made_up', 'C:\\Users\\owner', null, 7]) {
    assert.equal(fileToolsReason(status({ hosted: { available: false, reason }, registered: true })),
      'file_access_unavailable', String(reason));
  }
  assert.deepEqual([...FILE_TOOLS_REASONS], [...CLIENT_FILE_TOOLS_REASONS]);
  assert.ok(FILE_TOOLS_REASONS.includes('file_access_unavailable'));
});

test('the snapshot fields default for an old record', () => {
  assert.deepEqual(teamSnapshotFields({ preferred_model: 'team-pool', reasoning_effort: 'xhigh' }, null), {
    preferred_model: null, reasoning_effort: 'default', team_tools: { read: true, write: true }, preference_log: [],
    file_tools: 'unavailable' });
  assert.deepEqual(teamSnapshotFields({ team_tool_switches: { read: 'yes' } }, null).team_tools, { read: false, write: true },
    'a damaged stored switch reads as off');
});

test('row 175 item 7: on a team host plan_mode alone is a team change with its author; it stays in rest for the store', () => {
  const at = Date.parse('2026-11-17T10:00:00Z');
  const split = teamPreferenceChange(command, { plan_mode: false }, { teamHost: true, author, now: () => at });
  assert.deepEqual(split, { rest: { plan_mode: false }, change: { by: 'member_a', at: '2026-11-17T10:00:00.000Z', plan: false } });
  assert.equal(reasonOf(() => teamPreferenceChange(command, { plan_mode: true }, { teamHost: true })), 'member_author_required');
  assert.equal(reasonOf(() => teamPreferenceChange(command, { plan_mode: true }, { teamHost: true, author, busy: true })), 'session_active');
  assert.deepEqual(teamPreferenceChange(command, { plan_mode: true }, { teamHost: false }), { rest: { plan_mode: true }, change: null },
    'any other host takes plan_mode as before');
});

test('row 175 item 7: a plan mode change writes a preference log entry with its author', () => {
  const at = '2026-11-17T10:00:00.000Z';
  const patch = teamPreferencesPatch({ by: 'member_a', at, plan: true }, { plan_mode: false });
  const entry = patch.preference_log.at(-1);
  assert.deepEqual([entry.by, entry.from.plan, entry.to.plan], ['member_a', false, true]);
  assert.equal(Object.hasOwn(patch, 'plan_mode'), false, 'the store write stays the rest of the change');
  assert.equal(teamPreferencesPatch({ by: 'member_a', at, plan: true }, { plan_mode: true }).preference_log, undefined,
    'no change, no entry');
});
