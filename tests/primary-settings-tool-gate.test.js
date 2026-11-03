'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PRIMARY_APP_VIEW_TOOL_NAMES, PRIMARY_EXPORT_TOOL_NAMES, PRIMARY_TERMINAL_TOOL_NAMES, primaryAppViewToolsOffered, primaryExportToolsOffered, primaryTerminalToolsOffered, PRIMARY_CHAT_MANAGE_TOOL_NAMES, PRIMARY_CHAT_PLACEMENT_TOOL_NAMES, PRIMARY_DIGEST_TOOL_NAMES, PRIMARY_SCHEDULE_TOOL_NAMES,
  primaryChatManageToolsOffered, primaryChatPlacementToolsOffered,
  primaryDigestToolsOffered, primaryScheduleToolsOffered, primarySettingsToolsOffered, withPrimarySettingsToolGate,
} = require('../services/backend/primary-settings-tool-gate');
const { managedToolPreferenceInput } = require('../services/backend/managed-sidecar-chat-helpers');
const { PRIMARY_SETTINGS_TOOL_NAMES } = require('../services/primary-settings-contract');
const { ALWAYS_ON_TOOL_NAMES, surfaceFamilyForTool } = require('../services/tools/tool-surface-families');

const SETTINGS = ['settings_change', 'settings_get'];
const CHAT = ['chat_configure', 'chat_organize']; // row 94 P1
const PLACEMENT = ['project_create', 'projects_list']; // row 94 P2
const SCHEDULE = ['schedule_change', 'schedule_list']; // row 85
const VIEW = ['app_view']; // row 94 P3
const P4 = ['session_export', 'terminal_run']; // row 94 P4: the export and terminal_run (same gate; terminal_read reaches project chats)
const NAMES = [...VIEW, ...CHAT, ...PLACEMENT, ...SCHEDULE, 'session_export', ...SETTINGS, 'terminal_run']; // sorted, as the gate sorts a deny list
const PRIMARY = { id: 'p', session_role: 'primary' };

test('the gate names the settings and chat tools, which are Helpers tools and not always on (so the deny list holds)', () => {
  assert.deepEqual([...PRIMARY_SETTINGS_TOOL_NAMES].sort(), SETTINGS);
  assert.deepEqual([...PRIMARY_CHAT_MANAGE_TOOL_NAMES].sort(), CHAT);
  assert.deepEqual([...PRIMARY_SCHEDULE_TOOL_NAMES].sort(), SCHEDULE);
  assert.deepEqual([...PRIMARY_CHAT_PLACEMENT_TOOL_NAMES].sort(), PLACEMENT);
  assert.deepEqual([...PRIMARY_APP_VIEW_TOOL_NAMES], VIEW);
  assert.deepEqual([...PRIMARY_EXPORT_TOOL_NAMES, ...PRIMARY_TERMINAL_TOOL_NAMES], P4);
  for (const name of NAMES) {
    assert.equal(ALWAYS_ON_TOOL_NAMES.includes(name), false, name);
    assert.equal(surfaceFamilyForTool(name), 'helpers', name);
  }
});

test('an ordinary chat gets every primary-only tool added to its deny list, keeping what it already denied', () => {
  const service = {};
  const session = { id: 's1' };
  assert.equal(primarySettingsToolsOffered(service, { sessionId: 's1', session }), false);
  assert.equal(primaryChatManageToolsOffered(service, { sessionId: 's1', session }), false);
  assert.equal(primaryScheduleToolsOffered(service, { sessionId: 's1', session }), false);
  assert.deepEqual(withPrimarySettingsToolGate(service, { session }, undefined), { disabled_tools: NAMES });
  assert.deepEqual(withPrimarySettingsToolGate(service, { session },
    { disabled_tools: ['read_file', 'settings_get'], disabled_tool_families: ['web'] }),
  { disabled_tools: [...VIEW, ...CHAT, ...PLACEMENT, 'read_file', ...SCHEDULE, 'session_export', ...SETTINGS, 'terminal_run'], disabled_tool_families: ['web'] });
  assert.deepEqual(withPrimarySettingsToolGate(service, { session }, ['not', 'an', 'object']), { disabled_tools: NAMES });
});

test('a spawned child, a parent with a child and a project chat are not offered the tools', () => {
  const service = {};
  for (const session of [{ id: 'c', spawned_from: { parent_session_id: 'p1' } }, { id: 'p1', linked_session_ids: ['c'] }, { id: 'x', project_id: 'a' }]) {
    assert.deepEqual(withPrimarySettingsToolGate(service, { session }, {}), { disabled_tools: NAMES });
  }
});

test('the primary chat keeps the tools and the same preferences object', () => {
  const service = {};
  const prefs = { disabled_tools: ['read_file'] };
  assert.equal(primarySettingsToolsOffered(service, { session: PRIMARY }), true);
  assert.equal(primaryChatManageToolsOffered(service, { session: PRIMARY }), true);
  assert.equal(primaryChatPlacementToolsOffered(service, { session: PRIMARY }), true);
  assert.equal(primaryScheduleToolsOffered(service, { session: PRIMARY }), true);
  assert.equal(withPrimarySettingsToolGate(service, { session: PRIMARY }, prefs), prefs);
});

test('the primary_chat kill switch and an unreadable session fail closed', () => {
  assert.equal(primarySettingsToolsOffered({ featureFlags: { primary_chat: false } }, { session: PRIMARY }), false);
  assert.equal(primaryChatManageToolsOffered({ featureFlags: { primary_chat: false } }, { session: PRIMARY }), false);
  assert.equal(primaryChatPlacementToolsOffered({ featureFlags: { primary_chat: false } }, { session: PRIMARY }), false);
  assert.equal(primaryScheduleToolsOffered({ featureFlags: { primary_chat: false } }, { session: PRIMARY }), false);
  assert.equal(primaryScheduleToolsOffered({}, { session: { get session_role() { throw new Error('boom'); } } }), false);
  assert.equal(primarySettingsToolsOffered({}, {}), false);
  assert.equal(primarySettingsToolsOffered({}, { session: null }), false);
  assert.equal(primaryChatManageToolsOffered(undefined, undefined), false);
  const hostile = { get session_role() { throw new Error('boom'); } };
  assert.equal(primarySettingsToolsOffered({}, { session: hostile }), false);
  assert.equal(primaryChatManageToolsOffered({}, { session: hostile }), false);
});

test('each kill switch leaves only its own tools alone (the tools are not registered)', () => {
  const prefs = { disabled_tools: ['read_file'] };
  const target = { session: { id: 's' } };
  const settingsOff = { featureFlags: { primary_settings_writes: false } };
  assert.equal(primarySettingsToolsOffered(settingsOff, target), true);
  assert.deepEqual(withPrimarySettingsToolGate(settingsOff, target, prefs), { disabled_tools: [...VIEW, ...CHAT, ...PLACEMENT, 'read_file', ...SCHEDULE, 'session_export', 'terminal_run'] });
  const chatOff = { featureFlags: { primary_chat_manage: false } };
  assert.equal(primaryChatManageToolsOffered(chatOff, target), true);
  assert.deepEqual(withPrimarySettingsToolGate(chatOff, target, prefs), { disabled_tools: [...VIEW, ...PLACEMENT, 'read_file', ...SCHEDULE, 'session_export', ...SETTINGS, 'terminal_run'] });
  const scheduleOff = { featureFlags: { primary_scheduled_checks: false } };
  assert.equal(primaryScheduleToolsOffered(scheduleOff, target), true);
  assert.deepEqual(withPrimarySettingsToolGate(scheduleOff, target, prefs), { disabled_tools: [...VIEW, ...CHAT, ...PLACEMENT, 'read_file', 'session_export', ...SETTINGS, 'terminal_run'] });
  const placementOff = { featureFlags: { primary_chat_placement: false } };
  assert.equal(primaryChatPlacementToolsOffered(placementOff, target), true);
  assert.deepEqual(withPrimarySettingsToolGate(placementOff, target, prefs), { disabled_tools: [...VIEW, ...CHAT, 'read_file', ...SCHEDULE, 'session_export', ...SETTINGS, 'terminal_run'] });
  const viewOff = { featureFlags: { primary_app_view: false } };
  assert.equal(primaryAppViewToolsOffered(viewOff, target), true);
  assert.deepEqual(withPrimarySettingsToolGate(viewOff, target, prefs), { disabled_tools: [...CHAT, ...PLACEMENT, 'read_file', ...SCHEDULE, 'session_export', ...SETTINGS, 'terminal_run'] });
  // Row 94 P4: each of the two new switches lifts only its own tool.
  const exportOff = { featureFlags: { primary_chat_export: false } };
  assert.equal(primaryExportToolsOffered(exportOff, target), true);
  assert.deepEqual(withPrimarySettingsToolGate(exportOff, target, prefs).disabled_tools.filter((name) => P4.includes(name)), ['terminal_run']);
  const terminalOff = { featureFlags: { terminal_tools: false } };
  assert.equal(primaryTerminalToolsOffered(terminalOff, target), true);
  assert.deepEqual(withPrimarySettingsToolGate(terminalOff, target, prefs).disabled_tools.filter((name) => P4.includes(name)), ['session_export']);
  const allOff = { featureFlags: { primary_settings_writes: false, primary_chat_manage: false, primary_chat_placement: false, primary_scheduled_checks: false, primary_app_view: false, primary_chat_export: false, terminal_tools: false } };
  assert.equal(withPrimarySettingsToolGate(allOff, target, prefs), prefs);
});

test('the managed tool-preference input applies the settings gate next to the directory gate', () => {
  const service = { sessionStore: { listSessions: () => [] } };
  const ordinary = managedToolPreferenceInput({}, { service, sessionId: 's1', session: { id: 's1' }, catalog: undefined });
  for (const name of NAMES) assert.ok(ordinary.disabled_tools.includes(name), name);
  const primary = managedToolPreferenceInput({}, { service, sessionId: 'p', session: PRIMARY, catalog: undefined });
  for (const name of NAMES) assert.equal((primary?.disabled_tools || []).includes(name), false, name);
  const handoff = managedToolPreferenceInput({}, { service, handoffPreparation: true, sessionId: 's1', session: { id: 's1' } });
  assert.deepEqual(handoff.enabled_tools, ['complete_session_handoff']);
});

test('away_digest (row 86, default off) is denied to every other chat only once primary_digests is on', () => {
  assert.deepEqual([...PRIMARY_DIGEST_TOOL_NAMES], ['away_digest']);
  assert.equal(ALWAYS_ON_TOOL_NAMES.includes('away_digest'), false);
  assert.equal(surfaceFamilyForTool('away_digest'), 'helpers');
  const prefs = { disabled_tools: ['read_file'] };
  const ordinary = { session: { id: 's' } };
  // Off (the default) or not exactly true: the tool is not registered, so the gate leaves it alone.
  for (const featureFlags of [undefined, {}, { primary_digests: false }, { primary_digests: 'true' }]) {
    assert.equal(primaryDigestToolsOffered({ featureFlags }, ordinary), true, JSON.stringify(featureFlags));
    assert.equal(withPrimarySettingsToolGate({ featureFlags }, ordinary, prefs).disabled_tools.includes('away_digest'), false);
  }
  const on = { featureFlags: { primary_digests: true } };
  assert.equal(primaryDigestToolsOffered(on, ordinary), false);
  assert.deepEqual(withPrimarySettingsToolGate(on, ordinary, prefs).disabled_tools, [...VIEW, 'away_digest', ...CHAT, ...PLACEMENT, 'read_file', ...SCHEDULE, 'session_export', ...SETTINGS, 'terminal_run']);
  assert.equal(primaryDigestToolsOffered(on, { session: PRIMARY }), true);
  assert.equal(primaryDigestToolsOffered({ featureFlags: { primary_digests: true, primary_chat: false } }, { session: PRIMARY }), false);
  assert.equal(primaryDigestToolsOffered(on, { session: { get session_role() { throw new Error('boom'); } } }), false);
  const allOff = { featureFlags: { primary_settings_writes: false, primary_chat_manage: false, primary_chat_placement: false, primary_scheduled_checks: false, primary_app_view: false, primary_chat_export: false, terminal_tools: false } };
  assert.equal(withPrimarySettingsToolGate(allOff, ordinary, prefs), prefs);
});
