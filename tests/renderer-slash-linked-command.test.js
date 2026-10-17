'use strict';

// /linked <request> (row 59 checkpoint 5a-2): an ordinary user message plus a launch grant bound
// to that message's runtime admission receipt. Empty input sends nothing; every failure of the
// grant is a calm notice while the turn itself continues.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLinkedCommandHandler, LINKED_PROMPT_PREFIX } = require('../renderer/chat/renderer-slash-linked-command');
const { registerBuiltInSlashCommands, createSlashCommandRegistry } = require('../renderer/shell/renderer-slash-command-registry');

const SESSION_ID = 'sess_1';
const RECEIPT = Object.freeze({ work_id: 'work_1', turn_id: 'turn_1', session_id: SESSION_ID, stream_id: 'stream_1', user_message_id: 'user_msg_1', idempotency_key: 'durable_x' });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(overrides = {}) {
  const calls = { sends: [], grants: [], notices: [], logs: [] };
  const state = { sessions: [{ id: SESSION_ID, project_id: 'project-jenny', session_incarnation: 'inc_abc' }], ...overrides.state };
  const sessionProposals = 'sessionProposals' in overrides ? overrides.sessionProposals : {
    authorizeLaunch: async (request) => { calls.grants.push(request); return { ok: true, authorization_ref: 'ref', remaining: 1 }; },
  };
  const startPromptSend = overrides.startPromptSend || (async (prompt, options) => {
    calls.sends.push({ prompt, options });
    options.onAdmission?.({ ...RECEIPT });
    return { durable: true, work_id: 'work_1', turn_id: 'turn_1', sessionId: SESSION_ID };
  });
  const handler = createLinkedCommandHandler({
    state,
    getStartPromptSend: () => startPromptSend,
    getSessionProposals: () => sessionProposals,
    setNotice: (text) => calls.notices.push(text),
    appendClientLog: (...args) => calls.logs.push(args),
    newActionId: () => '11111111-2222-4333-8444-555555555555',
    ...(overrides.getChatWorkspace ? { getChatWorkspace: overrides.getChatWorkspace } : {}),
  });
  return { calls, handler };
}

test('a request is sent as an ordinary user message, then the grant is bound to its admission receipt', async () => {
  const { calls, handler } = harness();
  const result = await handler({ sessionId: SESSION_ID, args: '  split the benchmark into its own chat  ' });
  await tick();
  assert.deepEqual(result, { ok: true, code: 'linked_sent' });
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.sends[0].prompt, 'Start a linked chat: split the benchmark into its own chat');
  assert.equal(LINKED_PROMPT_PREFIX, 'Start a linked chat: ');
  assert.equal(calls.sends[0].options.sessionIdOverride, SESSION_ID);
  assert.equal(calls.sends[0].options.preserveComposerDraft, true, 'the slash dispatch clears the composer, not the nested send');
  assert.deepEqual(calls.grants, [{
    schema_version: 1,
    session_id: SESSION_ID,
    source_user_message_id: 'user_msg_1',
    expected_session_incarnation: 'inc_abc',
    max_children: 1,
    destination_project_ids: ['project-jenny'],
    action_id: '11111111-2222-4333-8444-555555555555',
  }]);
  assert.deepEqual(calls.notices, []);
});

test('empty /linked shows a notice and sends nothing', async () => {
  const { calls, handler } = harness();
  for (const args of ['', '   ', undefined]) {
    const result = await handler({ sessionId: SESSION_ID, args });
    assert.deepEqual(result, { ok: false, handled: true, code: 'empty_args' });
  }
  assert.equal(calls.sends.length, 0);
  assert.equal(calls.grants.length, 0);
  assert.equal(calls.notices.length, 3);
});

test('a chat without a project grants for the General destination (null)', async () => {
  const { calls, handler } = harness({ state: { sessions: [{ id: SESSION_ID, project_id: '', session_incarnation: 'inc_abc' }] } });
  await handler({ sessionId: SESSION_ID, args: 'go' });
  await tick();
  assert.deepEqual(calls.grants[0].destination_project_ids, [null]);
});

test('a summary without session_incarnation skips the grant with a calm notice; the turn still runs', async () => {
  const { calls, handler } = harness({ state: { sessions: [{ id: SESSION_ID, project_id: 'p' }] } });
  const result = await handler({ sessionId: SESSION_ID, args: 'go' });
  await tick();
  assert.equal(result.ok, true);
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.grants.length, 0);
  assert.equal(calls.notices.length, 1);
});

test('no authorizeLaunch bridge skips the grant the same way', async () => {
  const { calls, handler } = harness({ sessionProposals: {} });
  const result = await handler({ sessionId: SESSION_ID, args: 'go' });
  await tick();
  assert.equal(result.ok, true);
  assert.equal(calls.notices.length, 1);
});

test('a refused or throwing grant is a calm notice, never a failed send', async () => {
  for (const authorizeLaunch of [async () => ({ ok: false, code: 'CMP-PROPOSAL-0008' }), async () => { throw new Error('boom'); }]) {
    const { calls, handler } = harness({ sessionProposals: { authorizeLaunch } });
    const result = await handler({ sessionId: SESSION_ID, args: 'secret request text' });
    await tick();
    assert.deepEqual(result, { ok: true, code: 'linked_sent' });
    assert.equal(calls.notices.length, 1);
    assert.ok(calls.logs.some((entry) => entry[1] === 'slash.linked_grant_failed'));
    assert.equal(JSON.stringify(calls.logs).includes('secret request text'), false, 'the request text is never logged');
  }
});

test('a receipt for another session never authorizes', async () => {
  const { calls, handler } = harness({
    startPromptSend: async (prompt, options) => { options.onAdmission({ ...RECEIPT, session_id: 'sess_other' }); return { durable: true, work_id: 'w' }; },
  });
  await handler({ sessionId: SESSION_ID, args: 'go' });
  await tick();
  assert.equal(calls.grants.length, 0);
  assert.equal(calls.notices.length, 1);
});

test('a send that did not start reports not-started and requests no grant', async () => {
  const { calls, handler } = harness({ startPromptSend: async () => null });
  assert.deepEqual(await handler({ sessionId: SESSION_ID, args: 'go' }), { ok: false, handled: true, code: 'send_not_started' });
  assert.equal(calls.grants.length, 0);
});

test('a send queued behind another turn authorizes when it is finally admitted', async () => {
  let admit;
  const { calls, handler } = harness({
    startPromptSend: async (prompt, options) => { admit = () => options.onAdmission({ ...RECEIPT }); return { durable: true, queued: true, work_id: 'w' }; },
  });
  await handler({ sessionId: SESSION_ID, args: 'go' });
  await tick();
  assert.equal(calls.grants.length, 0, 'no admission yet, no grant');
  admit();
  await tick();
  assert.equal(calls.grants.length, 1);
});

test('registered beside /note as an insert command with autocomplete text', () => {
  const registry = createSlashCommandRegistry({ state: { currentSessionId: SESSION_ID } });
  const linkedHandler = async () => ({ ok: true });
  assert.equal(registerBuiltInSlashCommands({ registry, linkedHandler }), true);
  const entry = registry.listCommands().find((command) => command.name === '/linked');
  assert.ok(entry);
  assert.equal(entry.action, 'insert');
  assert.equal(entry.requiresSession, true);
  assert.equal(entry.description, 'Start a separate chat linked to this one');
});

test('review fix: a chat whose incarnation is minted on this turn reads it at admission from the live summary', async () => {
  const reads = [];
  const { calls, handler } = harness({
    state: { sessions: [{ id: SESSION_ID, project_id: 'p' }] },
    getChatWorkspace: () => ({ getSummary: async (request) => { reads.push(request); return { ok: true, summary: { session_incarnation: 'inc_new' } }; } }),
  });
  const result = await handler({ sessionId: SESSION_ID, args: 'go' });
  await tick();
  await tick();
  assert.equal(result.ok, true);
  assert.deepEqual(reads, [{ schema_version: 1, session_id: SESSION_ID }]);
  assert.equal(calls.grants.length, 1);
  assert.equal(calls.grants[0].expected_session_incarnation, 'inc_new');
});
