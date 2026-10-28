'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHAT_WORKSPACE_VERSION, EMPTY_CHAT_WORKSPACE_CAPABILITIES, REQUESTED_CHAT_WORKSPACE_CAPABILITIES, intersectCapabilities,
} = require('../services/backend/chat-workspace-capabilities');

const TOOLS = ['propose_session', 'complete_session_handoff'];
const KINDS = ['session_message', 'session_handoff'];
const ack = (over = {}) => ({
  schema_version: 1, producer_tools: [...TOOLS], context_kinds: [...KINDS], session_messages: true, mid_turn_mail: true, ...over,
});

test('the frozen request asks for addressed session messages, the handoff context kind and the two session tools', () => {
  assert.equal(CHAT_WORKSPACE_VERSION, 1);
  assert.deepEqual(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, {
    schema_version: 1, producer_tools: TOOLS, context_kinds: KINDS, session_messages: true, mid_turn_mail: true });
  assert.deepEqual(EMPTY_CHAT_WORKSPACE_CAPABILITIES, {
    schema_version: 1, producer_tools: [], context_kinds: [], session_messages: false, mid_turn_mail: false });
  for (const value of [REQUESTED_CHAT_WORKSPACE_CAPABILITIES, EMPTY_CHAT_WORKSPACE_CAPABILITIES]) {
    assert.equal(Object.isFrozen(value), true);
    assert.equal(Object.isFrozen(value.producer_tools), true);
    assert.equal(Object.isFrozen(value.context_kinds), true);
  }
  assert.equal(REQUESTED_CHAT_WORKSPACE_CAPABILITIES.context_kinds.includes('session_message_receipt'), false);
});

test('an exact acknowledgment intersects to the requested set', () => {
  assert.deepEqual(intersectCapabilities(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, ack()), REQUESTED_CHAT_WORKSPACE_CAPABILITIES);
});

test('values the sidecar acknowledged but Electron did not request are dropped', () => {
  const result = intersectCapabilities(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, ack({
    producer_tools: ['propose_command', ...TOOLS, 'propose_session'], context_kinds: ['session_message_receipt', ...KINDS, 'session_message'] }));
  assert.deepEqual(result, REQUESTED_CHAT_WORKSPACE_CAPABILITIES);
});

test('values requested but not acknowledged are dropped and the flag follows the kind', () => {
  assert.deepEqual(intersectCapabilities(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, ack({ context_kinds: [], producer_tools: [] })),
    { schema_version: 1, producer_tools: [], context_kinds: [], session_messages: false, mid_turn_mail: false });
  assert.deepEqual(intersectCapabilities(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, ack({ session_messages: false })), {
    schema_version: 1, producer_tools: TOOLS, context_kinds: KINDS, session_messages: false, mid_turn_mail: false });
  // The handoff kind and the tools are negotiated independently of the session-message kind.
  assert.deepEqual(intersectCapabilities(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, ack({
    context_kinds: ['session_handoff'], producer_tools: ['complete_session_handoff'] })), {
    schema_version: 1, producer_tools: ['complete_session_handoff'], context_kinds: ['session_handoff'], session_messages: false,
    mid_turn_mail: false });
  const wide = { schema_version: 1, producer_tools: ['a', 'b'], context_kinds: ['session_message'], session_messages: true };
  assert.deepEqual(intersectCapabilities(wide, ack({ producer_tools: ['b', 'c'] })).producer_tools, ['b']);
});

test('a malformed or non-closed acknowledgment negotiates nothing', () => {
  for (const malformed of [undefined, null, 'yes', 7, [], {}, ack({ extra: 1 }), ack({ schema_version: 2 }),
    ack({ schema_version: true }), ack({ session_messages: 'true' }), ack({ context_kinds: 'session_message' }),
    ack({ producer_tools: [1] }), ack({ context_kinds: [null] }), ack({ mid_turn_mail: 1 })]) {
    assert.equal(intersectCapabilities(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, malformed), EMPTY_CHAT_WORKSPACE_CAPABILITIES,
      JSON.stringify(malformed));
  }
  assert.equal(intersectCapabilities(null, ack()), EMPTY_CHAT_WORKSPACE_CAPABILITIES);
});

test('mid-turn mail is optional in the acknowledgment and rides only on negotiated session messages', () => {
  const { mid_turn_mail: _omitted, ...withoutKey } = ack();
  assert.deepEqual(intersectCapabilities(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, withoutKey),
    { ...REQUESTED_CHAT_WORKSPACE_CAPABILITIES, mid_turn_mail: false });
  assert.equal(intersectCapabilities(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, ack({ mid_turn_mail: false })).mid_turn_mail, false);
  assert.equal(intersectCapabilities(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, ack({ context_kinds: ['session_handoff'] })).mid_turn_mail, false);
  const notRequested = { ...REQUESTED_CHAT_WORKSPACE_CAPABILITIES, mid_turn_mail: false };
  assert.equal(intersectCapabilities(notRequested, ack()).mid_turn_mail, false);
});

test('the intersection is a fresh frozen copy that never aliases the acknowledgment', () => {
  const source = ack();
  const result = intersectCapabilities(REQUESTED_CHAT_WORKSPACE_CAPABILITIES, source);
  source.context_kinds.push('session_message_receipt');
  assert.deepEqual(result.context_kinds, KINDS);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.context_kinds), true);
});

test('managed initialize sends the frozen chat-workspace request to the sidecar client', async () => {
  const { initializeManagedSidecar } = require('../services/backend/managed-sidecar-lifecycle');
  const process = {};
  const payloads = [];
  const service = {
    currentEngineType: 'mock', currentModel: 'mock', options: { userDataPath: require('node:os').tmpdir() },
    configService: { getState: () => ({ commandSandbox: { enabled: false } }), getToolsWorkspaceRoot: () => '' },
    sidecarManager: { process },
    sidecarClient: { process, connected: true, initialize: async payload => { payloads.push(payload); return {}; } },
  };
  await initializeManagedSidecar(service, { applyResult: false });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].chatWorkspaceCapabilities, REQUESTED_CHAT_WORKSPACE_CAPABILITIES);
});
