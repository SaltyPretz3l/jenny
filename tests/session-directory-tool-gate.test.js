'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DIRECTORY_TOOL_NAMES, directoryToolsOffered, withDirectoryToolGate,
} = require('../services/backend/session-directory-tool-gate');
const { managedToolPreferenceInput } = require('../services/backend/managed-sidecar-chat-helpers');
const { previewContext } = require('../services/backend/context-preview');
const { buildFeatureFlagDefaults, INTERNAL_FEATURE_FLAG_KEYS } = require('../services/feature-flags');
const { ALWAYS_ON_TOOL_NAMES, surfaceFamilyForTool } = require('../services/tools/tool-surface-families');

const DIRECTORY = ['session_status', 'session_stop', 'session_transcript', 'sessions_list'];

function serviceWith(sessions = [], featureFlags = undefined) {
  const service = { calls: 0, sessionStore: { listSessions: () => { service.calls += 1; return sessions; } } };
  if (featureFlags) service.featureFlags = featureFlags;
  return service;
}

test('the gate names the four directory tools, which are no longer always on', () => {
  assert.deepEqual([...DIRECTORY_TOOL_NAMES].sort(), DIRECTORY);
  for (const name of DIRECTORY) {
    assert.equal(ALWAYS_ON_TOOL_NAMES.includes(name), false, name);
    assert.equal(surfaceFamilyForTool(name), 'helpers', name);
  }
  assert.ok(ALWAYS_ON_TOOL_NAMES.includes('jenny_help'));
  assert.ok(ALWAYS_ON_TOOL_NAMES.includes('session_message'));
});

test('an unlinked ordinary chat gets the directory tools added to its deny list', () => {
  const service = serviceWith([{ id: 's1' }, { id: 'other', spawned_from: { parent_session_id: 'elsewhere' } }]);
  const session = { id: 's1', linked_session_ids: ['other'] }; // a branch relation is not linkage
  assert.equal(directoryToolsOffered(service, { sessionId: 's1', session }), false);
  assert.deepEqual(withDirectoryToolGate(service, { sessionId: 's1', session }, undefined), { disabled_tools: DIRECTORY });
  assert.deepEqual(withDirectoryToolGate(service, { sessionId: 's1', session },
    { disabled_tools: ['read_file', 'session_stop'], disabled_tool_families: ['web'] }),
  { disabled_tools: ['read_file', ...DIRECTORY], disabled_tool_families: ['web'] });
  assert.equal(service.calls, 3, 'one session listing per gate decision');
});

test('the primary chat, a spawned child and a parent with a child keep the directory tools', () => {
  const primary = serviceWith([]);
  assert.equal(directoryToolsOffered(primary, { sessionId: 'p', session: { id: 'p', session_role: 'primary' } }), true);
  assert.equal(primary.calls, 0, 'the primary needs no session scan');

  const child = serviceWith([]);
  const childSession = { id: 'c', spawned_from: { parent_session_id: 'p1' } };
  assert.equal(directoryToolsOffered(child, { sessionId: 'c', session: childSession }), true);
  assert.equal(child.calls, 0, 'a spawned chat needs no session scan');

  const parent = serviceWith([{ id: 'p1' }, { id: 'c', spawned_from: { parent_session_id: 'p1' } }]);
  const prefs = { disabled_tools: ['read_file'] };
  assert.equal(withDirectoryToolGate(parent, { sessionId: 'p1', session: { id: 'p1' } }, prefs), prefs);
  assert.equal(parent.calls, 1);
});

test('the primary_chat kill switch scopes the primary like any other chat', () => {
  const service = serviceWith([], { primary_chat: false });
  assert.equal(directoryToolsOffered(service, { sessionId: 'p', session: { id: 'p', session_role: 'primary' } }), false);
});

test('kill switches: the gate flag off or the directory flag off leave the request unchanged', () => {
  for (const featureFlags of [{ session_directory_tool_gate: false }, { tools_session_directory_enabled: false }]) {
    const service = serviceWith([], featureFlags);
    assert.equal(withDirectoryToolGate(service, { sessionId: 's1', session: { id: 's1' } }, undefined), undefined);
    assert.equal(service.calls, 0);
  }
  assert.equal(buildFeatureFlagDefaults({}).session_directory_tool_gate, true);
  assert.equal(buildFeatureFlagDefaults({ JENNY_ENABLE_SESSION_DIRECTORY_TOOL_GATE: '0' }).session_directory_tool_gate, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('session_directory_tool_gate'));
});

test('an unreadable session listing gates the tools (fail closed)', () => {
  const service = { sessionStore: { listSessions: () => { throw new Error('index unavailable'); } } };
  assert.equal(directoryToolsOffered(service, { sessionId: 's1', session: { id: 's1' } }), false);
  assert.equal(directoryToolsOffered({}, { sessionId: 's1', session: { id: 's1' } }), false);
});

test('managedToolPreferenceInput applies the gate to ordinary turns but never to a handoff preparation turn', () => {
  const service = serviceWith([]);
  const options = { service, sessionId: 's1', session: { id: 's1' } };
  assert.deepEqual(managedToolPreferenceInput({ disabled_tools: ['read_file'] }, options),
    { disabled_tools: ['read_file', ...DIRECTORY] });
  assert.deepEqual(managedToolPreferenceInput(undefined, options), { disabled_tools: DIRECTORY });
  assert.deepEqual(managedToolPreferenceInput(undefined, { ...options, handoffPreparation: { proposal_id: 'p' } }),
    { enabled_tools: ['complete_session_handoff'], disabled_tools: [], disabled_tool_families: [] });
  assert.equal(managedToolPreferenceInput(undefined), undefined, 'no service, no gate');
});

test('the context preview mirrors the gate so the context ring does not count hidden schemas', async () => {
  const sessions = [];
  const session = { id: 's1', messages: [], context_preferences: { include_personality: false } };
  const calls = [];
  const service = {
    sessionStore: { peekSession: () => session, listSessions: () => sessions },
    sidecarClient: { process: {}, request: async (method, params) => { calls.push(params); return { status: 'estimated' }; } },
    sessionExecutionAuthority: {
      captureSession: () => ({}), toExecutionContext: () => ({ project_id: 'project_general', root_path: null }),
      requireCurrent: () => {}, close: () => {},
    },
  };
  await previewContext(service, 's1');
  assert.deepEqual(calls.at(-1).tool_preferences.disabled_tools, DIRECTORY);
  sessions.push({ id: 'c', spawned_from: { parent_session_id: 's1' } });
  session.updated_at = 'linked';
  await previewContext(service, 's1');
  assert.deepEqual(calls.at(-1).tool_preferences.disabled_tools, []);
});

test('the child check reads the raw index without listSessions, and a parent keeps the tools once offered', () => {
  let index = [{ id: 'kid', spawned_from: { parent_session_id: 'parent' } }];
  const service = { sessionStore: {
    listSessions: () => assert.fail('listSessions sorts and copies every chat'),
    getSessionIds: () => index.map((summary) => summary.id),
    peekSessionSummary: (id) => index.find((summary) => summary.id === id) || null,
  } };
  const target = { sessionId: 'parent', session: { id: 'parent' } };
  assert.equal(directoryToolsOffered(service, target), true);
  index = []; // the child is deleted
  assert.equal(directoryToolsOffered(service, target), true, 'no schema flip (and full re-prefill) on child deletion');
  assert.equal(directoryToolsOffered(service, { sessionId: 'loner', session: { id: 'loner' } }), false);
});
