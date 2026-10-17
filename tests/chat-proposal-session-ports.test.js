'use strict';

/* The session-kind ports of chat-proposal-wiring (row 59 checkpoint 5a-1), resolved lazily from a
 * backend-shaped object: user-message turns, source-work settlement, the persisted boundary reason,
 * destinations, models and the handoff capability. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionPorts } = require('../services/chat-proposal-wiring');

function backend(overrides = {}) {
  const messages = [
    { id: 'u1', role: 'user', turn_id: 'turn_1' },
    { id: 'a1', role: 'assistant', turn_id: 'turn_1', completion_reason: 'awaiting_proposal' },
    { id: 'u2', role: 'user', client_message_id: 'client_2', turn_id: 'turn_2' },
    { id: 'a2', role: 'assistant', turn_id: 'turn_2' },
  ];
  return {
    sessionStore: {
      peekSessionMessages: () => messages,
      getActiveTurn: () => ({ user_message_id: 'u3', turn_id: 'turn_3' }),
      peekSession: (id) => (id === 'sess_a' ? { spawned_from: { parent_session_id: 'sess_p' } } : null),
    },
    projectService: { list: () => [{ id: 'proj_1', name: 'One' }, { id: 'proj_2', name: 'Two' }] },
    listModels: async () => ({ data: [{ id: 'm1', display_name: 'M one' }, { id: 'm2', available: false }, { id: 'm3', name: 'M three' }, null] }),
    ...overrides,
  };
}

test('resolveUserMessageTurn reads the persisted row (by id or client id), then the active turn; else null', () => {
  const ports = createSessionPorts(backend());
  assert.deepEqual(ports.resolveUserMessageTurn('s', 'u1'), { turn_id: 'turn_1' });
  assert.deepEqual(ports.resolveUserMessageTurn('s', 'client_2'), { turn_id: 'turn_2' });
  assert.deepEqual(ports.resolveUserMessageTurn('s', 'u3'), { turn_id: 'turn_3' });
  assert.equal(ports.resolveUserMessageTurn('s', 'u9'), null);
  assert.equal(createSessionPorts({}).resolveUserMessageTurn('s', 'u1'), null);
});

test('getTurnCompletionReason: the boundary reason, none for a normal terminal, null without a terminal row', () => {
  const ports = createSessionPorts(backend());
  assert.equal(ports.getTurnCompletionReason('s', 'turn_1'), 'awaiting_proposal');
  assert.equal(ports.getTurnCompletionReason('s', 'turn_2'), 'none');
  assert.equal(ports.getTurnCompletionReason('s', 'turn_9'), null);
});

test('getTurnCompletionReason: a failed, interrupted or cancelled turn reads as failed, also from its runtime work', () => {
  const rows = [
    { id: 't', role: 'assistant', turn_id: 'turn_t', kind: 'tool_use' },
    { id: 'e', role: 'assistant', turn_id: 'turn_t', stream_error: 'boom', terminal_status: 'error' },
    { id: 'i', role: 'assistant', turn_id: 'turn_i', terminal_status: 'interrupted' },
    { id: 'w', role: 'assistant', turn_id: 'turn_w', kind: 'tool_use' },
  ];
  const ports = createSessionPorts(backend({
    sessionStore: { peekSessionMessages: () => rows },
    sessionRuntime: { store: { listSummaries: () => ({ items: [{ turn_id: 'turn_w', status: 'failed' }, { turn_id: 'turn_x', status: 'cancelled' }], next_cursor: null }) } },
  }));
  assert.equal(ports.getTurnCompletionReason('s', 'turn_t'), 'failed');
  assert.equal(ports.getTurnCompletionReason('s', 'turn_i'), 'failed');
  assert.equal(ports.getTurnCompletionReason('s', 'turn_w'), 'failed', 'only a tool_use row, but the work failed');
  assert.equal(ports.getTurnCompletionReason('s', 'turn_x'), 'failed', 'no row at all after a crash, but the work was cancelled');
});

test('isSourceWorkSettled pages the runtime summaries: terminal true, running false, unknown null', () => {
  const pages = [
    { items: [{ turn_id: 'turn_a', status: 'running' }], next_cursor: 'c1' },
    { items: [{ turn_id: 'turn_b', status: 'completed' }, { turn_id: 'turn_c', status: 'cancelled' }, { turn_id: 'turn_d', status: 'paused' }], next_cursor: null },
  ];
  const seen = [];
  const ports = createSessionPorts(backend({
    sessionRuntime: { store: { listSummaries: (request) => { seen.push(request); return pages[request.cursor ? 1 : 0]; } } },
  }));
  assert.equal(ports.isSourceWorkSettled('s', 'turn_a'), false);
  assert.equal(ports.isSourceWorkSettled('s', 'turn_b'), true);
  assert.equal(ports.isSourceWorkSettled('s', 'turn_c'), true);
  assert.equal(ports.isSourceWorkSettled('s', 'turn_d'), false);
  assert.equal(ports.isSourceWorkSettled('s', 'turn_zzz'), null);
  assert.equal(seen[0].sessionId, 's');
  assert.equal(createSessionPorts(backend()).isSourceWorkSettled('s', 'turn_a'), null, 'no runtime store: unknown');
});

test('destinations, models and the handoff capability come from the backend and degrade safely', async () => {
  const ports = createSessionPorts(backend());
  assert.deepEqual(ports.listDestinations(), [
    { project_id: 'proj_1', label: 'One', available: true }, { project_id: 'proj_2', label: 'Two', available: true },
  ]);
  const options = await ports.listModelOptions();
  assert.deepEqual(options.models, [{ id: 'm1', label: 'M one' }, { id: 'm3', label: 'M three' }]);
  assert.ok(options.reasoning_efforts.includes('high'));
  assert.equal(createSessionPorts({}).listDestinations().length, 0);
  assert.equal(ports.supportsSessionHandoff(), false, 'no negotiated sidecar client: unsupported');
  assert.equal(ports.supportsProducerTool('propose_session'), false);
});

test('child creation, existence and provenance reads go through the backend; a missing creator is a refusal', () => {
  const calls = [];
  const ports = createSessionPorts(backend({ createLinkedChildSession: (spec) => { calls.push(spec); return { ok: true, session_id: 'sess_c' }; } }));
  assert.deepEqual(ports.createLinkedChildSession({ childSessionId: 'sess_c' }), { ok: true, session_id: 'sess_c' });
  assert.equal(calls.length, 1);
  assert.equal(ports.sessionExists('sess_a'), true);
  assert.equal(ports.sessionExists('sess_nope'), false);
  assert.deepEqual(ports.readSpawnedFrom('sess_a'), { parent_session_id: 'sess_p' });
  assert.equal(ports.readSpawnedFrom('sess_nope'), null);
  assert.deepEqual(createSessionPorts(backend()).createLinkedChildSession({}), { ok: false, code: 'unsupported' });
});
