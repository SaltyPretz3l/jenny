'use strict';

// Row 166 D10: one answer for a round of file edits. The first card of a round shows every later edit of the same
// tool whole and may be answered "Allow all"; each later call still makes its own request, and is answered without a
// card only when it is the next call of that round and asks for exactly what the card showed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
const { approveToolCall } = require('../services/backend/backend-chat-stream');
const { getManagedActiveTurnState } = require('../services/backend/backend-active-turn-state');
const { buildExactApprovalPresentation } = require('../services/backend/chat-stream-exact-approval');
const { MAX_ROUND_CALLS, roundOfferFor } = require('../services/backend/round-approval-gate');

const edit = (n) => ({ file_path: `src/file-${n}.js`, old_string: `before ${n}`, new_string: `after ${n}` });
const hint = (n, toolName = 'edit_file', input = edit(n)) => ({ tool_call_id: `call-${n}`, tool_name: toolName, tool_input: input });

function harness(extra = {}) {
  const messages = [];
  const emitted = [];
  const service = {
    sessionStore: {
      getSessionMessages: () => messages,
      appendMessage(_sessionId, message) { messages.push(message); },
      updateMessage(_sessionId, messageId, patch) {
        const index = messages.findIndex((message) => message.id === messageId);
        if (index !== -1) messages[index] = { ...messages[index], ...patch };
      },
    },
    emit(_event, payload) { emitted.push(payload); },
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
    sessionExecutionAuthority: { requireCurrent() {} },
    configService: { getChatUiState: () => ({ safetyMode: 'normal' }) },
    ...extra,
  };
  const controller = new AbortController();
  const turnEvents = [];
  // One stream, one controller: every request of the turn waits on the same one, as in the app.
  const ask = (n, { toolName = 'edit_file', input = edit(n), later = [], ...params } = {}) => waitForToolApproval(
    service, 'stream-1', 'session-1', 'req-1',
    { tool_name: toolName, tool_call_id: `call-${n}`, tool_input: input, ...(later.length ? { round_calls: later } : {}), ...params },
    controller, { noteEvent(event) { turnEvents.push(event); return event; } }, null);
  const cards = () => emitted.filter((event) => event.type === 'tool_approval_needed');
  const pending = () => [...service.pendingToolApprovals.values()];
  const answer = (options) => approveToolCall(service, pending()[0].approvalId, options);
  const receipt = (n) => emitted.findLast((event) => event.type === 'tool_use' && event.callId === `call-${n}` && event.status === 'approved');
  return { service, controller, emitted, messages, turnEvents, ask, cards, pending, answer, receipt };
}

// The first card of a three-edit round, answered with the given options.
async function firstCard(h, options) {
  const first = h.ask(1, { later: [hint(2), hint(3)] });
  assert.equal(h.cards().length, 1);
  assert.equal(h.answer(options), true);
  assert.equal(await first, true);
}

test('the first card of a round shows each later edit whole', async () => {
  const h = harness();
  const first = h.ask(1, { later: [hint(2), hint(3)] });

  const [card] = h.cards();
  assert.deepEqual(card.round_approval.calls.map((call) => call.call_id), ['call-2', 'call-3']);
  assert.deepEqual(card.round_approval.calls[0].exact_approval, buildExactApprovalPresentation('edit_file', edit(2)));
  assert.equal(typeof card.round_approval.calls[0].summary, 'string');
  // Live only, like the exact presentation: nothing stored or journaled carries the other calls.
  assert.equal(JSON.stringify(h.messages).includes('after 2'), false);
  assert.equal(JSON.stringify(h.turnEvents).includes('after 2'), false);

  h.pending()[0].resolve(false, 'denied');
  assert.equal(await first, false);
});

test('Allow all answers the next calls of the round without a card, each on its own records', async () => {
  const h = harness();
  await firstCard(h, { round: true });
  assert.equal(h.receipt(1).approvalScope, 'round');

  assert.equal(await h.ask(2, { later: [hint(3)] }), true);
  assert.equal(await h.ask(3), true);

  assert.equal(h.cards().length, 1, 'only the first call showed a card');
  assert.equal(h.pending().length, 0);
  for (const n of [2, 3]) {
    assert.equal(h.receipt(n).approvalScope, 'round');
    assert.equal(h.messages.find((message) => message.tool_call?.call_id === `call-${n}`).tool_call.approval_state, 'approved');
    const resolved = h.turnEvents.find((event) => event.type === 'tool_approval_resolved' && event.tool_call_id === `call-${n}`);
    assert.equal(resolved.payload.approval_scope, 'round');
  }
  assert.equal(h.controller.roundApprovalGrants.size, 0, 'each grant is used once');
});

test('Allow once on the first card leaves every later call asking, and the next card offers what is left', async () => {
  const h = harness();
  await firstCard(h, {});
  assert.equal(h.receipt(1).approvalScope, 'once');

  const second = h.ask(2, { later: [hint(3)] });
  assert.equal(h.cards().length, 2);
  assert.deepEqual(h.cards()[1].round_approval.calls.map((call) => call.call_id), ['call-3']);
  h.pending()[0].resolve(false, 'denied');
  assert.equal(await second, false);
});

test('a later call that no longer asks for what the card showed gets its own card, and the round ends', async () => {
  const h = harness();
  await firstCard(h, { round: true });

  const second = h.ask(2, { input: { ...edit(2), new_string: 'something else' } });
  assert.equal(h.cards().length, 2, 'the changed edit is shown');
  assert.equal(h.answer({}), true);
  assert.equal(await second, true);

  const third = h.ask(3);
  assert.equal(h.cards().length, 3, 'the call behind it asks too');
  h.pending()[0].resolve(false, 'denied');
  assert.equal(await third, false);
});

test('a request out of order, or for anything else, ends the round', async () => {
  for (const next of [(h) => h.ask(3), (h) => h.ask(9, { toolName: 'run_command', input: { command: 'dir' } })]) {
    const h = harness();
    await firstCard(h, { round: true });

    const other = next(h);
    assert.equal(h.cards().length, 2);
    h.pending()[0].resolve(true, 'approved', '', null, 'once');
    assert.equal(await other, true);

    const second = h.ask(2);
    assert.equal(h.cards().length, 3, 'the round is over: its next call asks');
    h.pending()[0].resolve(false, 'denied');
    assert.equal(await second, false);
  }
});

test('a stopped turn, or one the inactivity guard paused, is answered nothing', async () => {
  const paused = harness();
  await firstCard(paused, { round: true });
  assert.equal(paused.controller.roundApprovalGrants.size, 2);
  paused.controller.unattendedPauseRequested = true;
  const shown = paused.ask(2);
  assert.equal(paused.cards().length, 2, 'the person who walked away finds a card');
  assert.equal(paused.controller.roundApprovalGrants.size, 0);
  paused.pending()[0].resolve(false, 'denied');
  assert.equal(await shown, false);

  const stopped = harness();
  await firstCard(stopped, { round: true });
  stopped.controller.abort();
  assert.equal(await stopped.ask(2), false, 'nothing is answered for a stopped turn');
  assert.equal(stopped.controller.roundApprovalGrants.size, 0);
});

test('a round answer on a card that offered no round is an ordinary Allow once', async () => {
  const h = harness();
  const only = h.ask(1);
  assert.equal(h.cards()[0].round_approval, undefined);
  assert.equal(h.answer({ round: true }), true);
  assert.equal(await only, true);
  assert.equal(h.receipt(1).approvalScope, 'once');
  assert.equal(h.controller.roundApprovalGrants, undefined);

  // The waiter itself refuses the scope too, whatever its caller passes.
  const direct = harness();
  const asked = direct.ask(1);
  direct.pending()[0].resolve(true, 'approved', '', null, 'round');
  assert.equal(await asked, true);
  assert.equal(direct.receipt(1).approvalScope, undefined);
  const next = direct.ask(2);
  assert.equal(direct.cards().length, 2);
  direct.pending()[0].resolve(false, 'denied');
  await next;
});

test('the offer stops at the first hint that is not a showable call of the same tool', () => {
  const desktop = { configService: { getChatUiState: () => ({ safetyMode: 'strict' }) } };
  const offer = (later, extra = {}) => roundOfferFor(desktop, {
    toolName: 'edit_file', callId: 'call-1', oneOffOnly: false,
    exactApproval: buildExactApprovalPresentation('edit_file', edit(1)), params: { round_calls: later }, ...extra,
  }).map((call) => call.callId);

  assert.deepEqual(offer([hint(2), hint(3)]), ['call-2', 'call-3']);
  assert.deepEqual(offer([hint(2), hint(3, 'write_file'), hint(4)]), ['call-2'], 'another tool');
  assert.deepEqual(offer([hint(2), hint(2), hint(3)]), ['call-2'], 'a repeated call');
  assert.deepEqual(offer([hint(1), hint(2)]), [], "the card's own call");
  assert.deepEqual(offer([hint(2), { tool_call_id: 'call-3', tool_name: 'edit_file', tool_input: 'text' }]), ['call-2']);
  assert.deepEqual(offer([hint(2), null, hint(3)]), ['call-2']);
  assert.deepEqual(offer([hint(2), { ...hint(3), tool_call_id: ' ' }]), ['call-2']);
  assert.deepEqual(offer([hint(2), hint(3, 'edit_file', { ...edit(3), new_string: 'x'.repeat(40 * 1024) })]), ['call-2'], 'too large to show');
  assert.equal(offer(Array.from({ length: 40 }, (_, index) => hint(index + 2))).length, MAX_ROUND_CALLS);
  const big = (n) => hint(n, 'edit_file', { ...edit(n), new_string: 'y'.repeat(30 * 1024) });
  assert.equal(offer([big(2), big(3), big(4), big(5), big(6)]).length, 4, 'the whole offer stays readable on one card');
  assert.deepEqual(offer('call-2'), []);
  assert.deepEqual(offer([hint(2)], { oneOffOnly: true }), [], 'a request that must be approved once');
  assert.deepEqual(offer([hint(2)], { exactApproval: { schema_version: 1, too_large: true } }), [], 'a card with no Allow');
  assert.deepEqual(offer([hint(2, 'run_command', { command: 'dir' })], { toolName: 'run_command' }), [], 'commands keep one card each');
  assert.deepEqual(roundOfferFor({ ...desktop, hostMode: 'server' }, {
    toolName: 'edit_file', callId: 'call-1', oneOffOnly: false,
    exactApproval: buildExactApprovalPresentation('edit_file', edit(1)), params: { round_calls: [hint(2)] },
  }), [], 'a team or hosted server records each approval by a person');
});

test('paranoid safety mode, or one that cannot be read, keeps a card for every call', async () => {
  for (const configService of [
    { getChatUiState: () => ({ safetyMode: 'paranoid' }) },
    { getChatUiState: () => { throw new Error('unreadable'); } },
    { getChatUiState: () => ({}) },
    undefined,
  ]) {
    const h = harness({ configService });
    const first = h.ask(1, { later: [hint(2)] });
    assert.equal(h.cards()[0].round_approval, undefined, 'no round is offered');
    assert.equal(h.answer({ round: true }), true);
    assert.equal(await first, true);
    assert.equal(h.receipt(1).approvalScope, 'once');
    h.controller.roundApprovalGrants = new Map([['call-2', {
      toolName: 'edit_file', sha256: buildExactApprovalPresentation('edit_file', edit(2)).sha256,
    }]]);
    const second = h.ask(2);
    assert.equal(h.cards().length, 2, 'and a grant answers nothing');
    h.pending()[0].resolve(false, 'denied');
    await second;
  }

  // Switched on between the answer and the next call: that call asks.
  let safetyMode = 'normal';
  const h = harness({ configService: { getChatUiState: () => ({ safetyMode }) } });
  await firstCard(h, { round: true });
  safetyMode = 'paranoid';
  const second = h.ask(2);
  assert.equal(h.cards().length, 2);
  h.pending()[0].resolve(false, 'denied');
  await second;
});

test('a server host never offers or honours a round, and write_file rounds work like edit_file rounds', async () => {
  const server = harness({ hostMode: 'server' });
  const first = server.ask(1, { later: [hint(2)] });
  assert.equal(server.cards()[0].round_approval, undefined);
  server.controller.roundApprovalGrants = new Map([['call-1', {
    toolName: 'edit_file', sha256: buildExactApprovalPresentation('edit_file', edit(1)).sha256,
  }]]);
  server.pending()[0].resolve(false, 'denied');
  await first;
  server.controller.roundApprovalGrants.set('call-2', {
    toolName: 'edit_file', sha256: buildExactApprovalPresentation('edit_file', edit(2)).sha256,
  });
  const second = server.ask(2);
  assert.equal(server.cards().length, 2, 'a planted grant answers nothing on a server');
  server.pending()[0].resolve(false, 'denied');
  await second;

  const h = harness();
  const write = (n) => ({ path: `notes/${n}.md`, content: `note ${n}` });
  const asked = h.ask(1, { toolName: 'write_file', input: write(1), later: [hint(2, 'write_file', write(2))] });
  assert.equal(h.answer({ round: true }), true);
  assert.equal(await asked, true);
  assert.equal(await h.ask(2, { toolName: 'write_file', input: write(2) }), true);
  assert.equal(h.cards().length, 1);
});

test('a chat reopened mid-wait gets the round back from the active-turn snapshot', async () => {
  const h = harness();
  h.service.activeStreams = new Map([['stream-1', h.controller]]);
  h.service.sessionStore.getActiveTurn = () => ({ request_id: 'stream-1', stream_id: 'stream-1', status: 'streaming' });
  const first = h.ask(1, { later: [hint(2), hint(3)] });

  const snapshot = getManagedActiveTurnState(h.service, 'session-1');

  assert.deepEqual(snapshot.pending_approval.round_approval, h.cards()[0].round_approval);
  h.pending()[0].resolve(false, 'denied');
  await first;
});
