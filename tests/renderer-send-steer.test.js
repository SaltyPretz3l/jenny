// new-test-file: the steer eligibility rules and the offer/withdraw/release controller are a new surface;
// the outbox and dispatch test files cover the queue itself.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSendOutbox } = require('../renderer/chat/renderer-send-outbox');
const {
  createQueuedSendDispatcher, createSteerController, evaluateSteerEligibility,
} = require('../renderer/chat/renderer-send-outbox-dispatch');

const PREFS = Object.freeze({
  preferredModel: 'local-a', reasoningEffort: 'medium', runMode: 'ask', planMode: false,
  contextPreferences: { historyScope: 'session' },
});

function entry(overrides = {}) {
  return { id: 'outbox_a', status: 'ready', prompt: 'hello', meta: {}, runtimePreferences: { ...PREFS }, ...overrides };
}

test('eligibility names each reason and keeps the FIFO rule', () => {
  const ask = (item, extra = {}) => evaluateSteerEligibility({
    item, queue: [item], busy: true, liveRuntimePreferences: { ...PREFS }, ...extra,
  });
  assert.deepEqual(ask(entry()), { eligible: true });
  assert.deepEqual(ask(entry(), { busy: false }), { eligible: false, reason: 'not_busy' });
  assert.equal(ask(entry({ meta: { skillInvocation: { id: 'x' } } })).reason, 'slash_command');
  for (const key of ['imageEditSnapshot', 'promptBlock', 'imagePromptPin', 'boardId']) {
    assert.equal(ask(entry({ meta: { [key]: key === 'boardId' ? 'board_1' : { id: 1 } } })).reason, 'needs_new_turn', key);
  }
  assert.equal(ask(entry({ meta: { mentionContentsSnapshot: [{ path: 'a.js' }] } })).reason, 'mentions');
  assert.deepEqual(ask(entry({ meta: { mentionContentsSnapshot: [] } })), { eligible: true });
  assert.equal(ask(entry({ runtimePreferences: { ...PREFS, preferredModel: 'local-b' } })).reason, 'model_change');
  assert.equal(ask(entry({ runtimePreferences: { ...PREFS, reasoningEffort: 'high' } })).reason, 'model_change');
  assert.equal(ask(entry({ runtimePreferences: { ...PREFS, runMode: 'auto' } })).reason, 'mode_change');
  assert.equal(ask(entry({ runtimePreferences: { ...PREFS, planMode: true } })).reason, 'mode_change');
  // Context toggles do not change what the live turn already holds.
  assert.deepEqual(ask(entry({ runtimePreferences: { ...PREFS, contextPreferences: { historyScope: 'recent' } } })), { eligible: true });

  const waiting = entry({ id: 'outbox_w', meta: { skillInvocation: { id: 'x' } } });
  const behind = entry({ id: 'outbox_b' });
  const queue = [waiting, behind];
  assert.deepEqual(ask(behind, { queue }), { eligible: false, reason: 'behind_waiting_item' });
  assert.deepEqual(ask(behind, { queue: [{ ...waiting, status: 'offered' }, behind] }), { eligible: true });
  assert.deepEqual(ask(behind, { queue: [{ ...waiting, status: 'taken' }, behind] }), { eligible: true });
  // An item that is itself ineligible keeps its own, more specific reason.
  assert.equal(ask(entry({ id: 'outbox_c', meta: { skillInvocation: { id: 'y' } } }), { queue: [waiting, entry({ id: 'outbox_c' })] }).reason, 'slash_command');
});

function createHarness(options = {}) {
  const state = {};
  const released = [];
  const outbox = createSendOutbox(state, { releaseAssets: (paths) => { released.push(paths); } });
  const calls = { offer: [], withdraw: [], changes: 0, dispatched: [] };
  let busy = options.busy !== false;
  let streamId = options.streamId === undefined ? 'stream-1' : options.streamId;
  const timers = [];
  const bridge = options.bridge || {
    offerSteer: async (payload) => { calls.offer.push(payload); return options.offerResult || { ok: true }; },
    withdrawSteer: async (payload) => { calls.withdraw.push(payload); return options.withdrawResult || { ok: true }; },
  };
  const steer = createSteerController({
    state,
    sendOutbox: outbox,
    getBridge: () => bridge,
    isSessionBusy: () => busy,
    getStreamId: () => streamId,
    dispatchQueuedSend: (sessionId) => { calls.dispatched.push(sessionId); return Promise.resolve(null); },
    onChange: () => { calls.changes += 1; },
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl: () => {},
  });
  steer.noteTurnStart('s1', { ...PREFS });
  const add = (overrides = {}) => outbox.enqueue('s1', {
    prompt: 'one', status: 'ready', runtimePreferences: { ...PREFS }, meta: { mentionContentsSnapshot: [] }, ...overrides,
  });
  return {
    state, outbox, steer, calls, released, timers, add,
    setBusy(value) { busy = value; },
    setStreamId(value) { streamId = value; },
    current: (id) => outbox.list('s1').find((item) => item.id === id),
  };
}

const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

test('enqueue while busy offers the first eligible item exactly once', async () => {
  const h = createHarness();
  const first = h.add({ prompt: 'one', attachments: [{ assetPath: 'a/b.png' }] });
  await h.steer.maybeOffer('s1');
  await flush();
  await h.steer.maybeOffer('s1');
  await flush();
  assert.equal(h.calls.offer.length, 1);
  assert.deepEqual(h.calls.offer[0], {
    sessionId: 's1', itemId: first.id, prompt: 'one', attachments: [{ assetPath: 'a/b.png' }],
  });
  assert.equal(h.current(first.id).status, 'offered');
});

test('canOffer says whether a Send behind the live turn should take the outbox', async () => {
  const h = createHarness();
  assert.equal(h.steer.canOffer('s1'), true);
  h.state.features = { featureFlags: { mid_turn_steer: false } };
  assert.equal(h.steer.canOffer('s1'), false, 'the kill switch keeps the durable queue');
  h.state.features = {};
  h.setStreamId('');
  assert.equal(h.steer.canOffer('s1'), false, 'no live turn');
  h.setStreamId('stream-1');
  assert.equal(createHarness({ bridge: {} }).steer.canOffer('s1'), false, 'no offer bridge');
  const refused = createHarness({ offerResult: { ok: false, reason: 'unsupported' } });
  refused.add();
  await refused.steer.maybeOffer('s1');
  await flush();
  assert.equal(refused.steer.canOffer('s1'), false, 'a turn that refused steering is not asked again');
});

test('an offer is made one at a time and in queue order', async () => {
  const h = createHarness();
  const first = h.add({ prompt: 'one' });
  const second = h.add({ prompt: 'two' });
  await h.steer.maybeOffer('s1');
  await flush();
  await flush();
  assert.deepEqual(h.calls.offer.map((call) => call.itemId), [first.id, second.id]);
});

test('an item that leaves the queue while its offer is in flight does not stall the items behind it', async () => {
  const offered = [];
  let resolveFirst;
  const bridge = {
    offerSteer: (payload) => {
      offered.push(payload.itemId);
      if (offered.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve({ ok: true });
    },
    withdrawSteer: async () => ({ ok: true }),
  };
  const h = createHarness({ bridge });
  const first = h.add({ prompt: 'one' });
  const second = h.add({ prompt: 'two' });
  const pending = h.steer.maybeOffer('s1');
  await flush();
  assert.deepEqual(offered, [first.id]);
  h.steer.handleUserSteer({ sessionId: 's1', message: { id: `steer_${first.id}`, outbox_item_id: first.id } });
  resolveFirst({ ok: true });
  await pending;
  await flush();
  assert.deepEqual(offered, [first.id, second.id]);
  assert.equal(h.current(second.id).status, 'offered');
});

test('a refusal leaves the item waiting and it is not offered again in that turn', async () => {
  const h = createHarness({ offerResult: { ok: false, reason: 'disabled' } });
  const item = h.add();
  await h.steer.maybeOffer('s1');
  await flush();
  assert.equal(h.current(item.id).status, 'waiting_for_turn');
  assert.equal(h.current(item.id).steerReason || null, null, 'a refusal shows no status line');
  await h.steer.maybeOffer('s1');
  await flush();
  assert.equal(h.calls.offer.length, 1);
  h.setStreamId('stream-2');
  await h.steer.maybeOffer('s1');
  await flush();
  assert.equal(h.calls.offer.length, 2, 'a later turn may be offered the same item');
});

test('a turn that cannot take steers (unsupported) is not asked again for later items', async () => {
  const h = createHarness({ offerResult: { ok: false, reason: 'unsupported' } });
  const first = h.add();
  await h.steer.maybeOffer('s1');
  await flush();
  h.add({ id: 'outbox_b' });
  await h.steer.maybeOffer('s1');
  await flush();
  assert.equal(h.calls.offer.length, 1, 'one round trip per turn, no row flash for the next item');
  assert.equal(h.current(first.id).status, 'waiting_for_turn');
  h.setStreamId('stream-2');
  await h.steer.maybeOffer('s1');
  await flush();
  assert.equal(h.calls.offer.length, 2, 'the next turn asks again (the capability may have changed)');
});

test('a missing bridge method offers nothing and leaves the row exactly as today', async () => {
  const h = createHarness({ bridge: {} });
  const item = h.add();
  await h.steer.maybeOffer('s1');
  await flush();
  assert.equal(h.current(item.id).status, 'ready');
  assert.equal(h.current(item.id).steerReason || null, null);
});

test('a chat that is not running a live turn offers nothing', async () => {
  const idle = createHarness({ busy: false });
  idle.add();
  await idle.steer.maybeOffer('s1');
  const noStream = createHarness({ streamId: '' });
  noStream.add();
  await noStream.steer.maybeOffer('s1');
  assert.equal(idle.calls.offer.length + noStream.calls.offer.length, 0);
});

test('a waiting item blocks later ones, which are offered once it is removed', async () => {
  const h = createHarness();
  const slash = h.add({ prompt: '/skill go', meta: { mentionContentsSnapshot: [], skillInvocation: { id: 'skill' } } });
  const plain = h.add({ prompt: 'plain' });
  await h.steer.maybeOffer('s1');
  await flush();
  assert.equal(h.calls.offer.length, 0);
  assert.equal(h.current(slash.id).steerReason, 'slash_command');
  assert.equal(h.current(plain.id).steerReason, 'behind_waiting_item');
  h.outbox.remove(h.current(slash.id));
  await flush();
  await flush();
  assert.deepEqual(h.calls.offer.map((call) => call.itemId), [plain.id]);
  assert.equal(h.current(plain.id).status, 'offered');
});

test('withdraw ok removes the row and holds its files until the turn ends, then releases them', async () => {
  const h = createHarness();
  const item = h.add({ attachments: [{ assetPath: 'x/y.txt' }] });
  await h.steer.maybeOffer('s1');
  await flush();
  const result = await h.steer.withdraw(h.current(item.id));
  assert.equal(result, true);
  assert.deepEqual(h.calls.withdraw, [{ sessionId: 's1', itemId: item.id }]);
  assert.equal(h.current(item.id), undefined);
  assert.deepEqual(h.released, [], 'the drain may still have taken it: its files are held');
  assert.ok(h.calls.changes > 0, 'the row list is redrawn');
  h.steer.handleTerminal({ sessionId: 's1', streamId: 'stream-1' });
  assert.deepEqual(h.released, [['x/y.txt']], 'the turn ended without taking it: released');
});

test('a withdrawn item the drain still took keeps its files for the persisted row', async () => {
  const h = createHarness();
  const item = h.add({ attachments: [{ assetPath: 'x/y.png' }] });
  await h.steer.maybeOffer('s1');
  await flush();
  assert.equal(await h.steer.withdraw(h.current(item.id)), true);
  h.steer.handleUserSteer({ sessionId: 's1', message: { id: `steer_${item.id}`, outbox_item_id: item.id } });
  h.steer.handleTerminal({ sessionId: 's1', streamId: 'stream-1' });
  assert.deepEqual(h.released, [], 'the transcript row owns them now');
});

test('withdraw losing the race shows the taken row for 4 s and keeps the attachments', async () => {
  const h = createHarness({ withdrawResult: { ok: false, reason: 'consumed' } });
  const item = h.add({ attachments: [{ assetPath: 'x/y.txt' }] });
  await h.steer.maybeOffer('s1');
  await flush();
  await h.steer.withdraw(h.current(item.id));
  assert.equal(h.current(item.id).status, 'taken');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 4000);
  h.timers[0].fn();
  assert.equal(h.current(item.id), undefined);
  assert.deepEqual(h.released, [], 'the persisted steer row now references those files');
});

test('withdraw of an unknown item behaves as a release', async () => {
  const h = createHarness({ withdrawResult: { ok: false, reason: 'unknown' } });
  const item = h.add();
  await h.steer.maybeOffer('s1');
  await flush();
  await h.steer.withdraw(h.current(item.id));
  assert.equal(h.current(item.id).status, 'waiting_for_turn');
});

test('the user_steer payload removes the item without releasing attachments, even from a taken row', async () => {
  const h = createHarness({ withdrawResult: { ok: false, reason: 'consumed' } });
  const plain = h.add({ attachments: [{ assetPath: 'p/q.txt' }] });
  const second = h.add({ prompt: 'two', attachments: [{ assetPath: 'r/s.txt' }] });
  await h.steer.maybeOffer('s1');
  await flush();
  await flush();
  h.steer.handleUserSteer({ sessionId: 's1', message: { id: `steer_${plain.id}`, outbox_item_id: plain.id } });
  assert.equal(h.current(plain.id), undefined);
  await h.steer.withdraw(h.current(second.id));
  assert.equal(h.current(second.id).status, 'taken');
  h.steer.handleUserSteer({ sessionId: 's1', message: { id: `steer_${second.id}`, outbox_item_id: second.id } });
  assert.equal(h.current(second.id), undefined);
  assert.deepEqual(h.released, []);
});

test('a release sends the items back to the queue and the terminal drain dispatches them', async () => {
  const h = createHarness();
  const item = h.add({ prompt: 'carry on' });
  await h.steer.maybeOffer('s1');
  await flush();
  h.steer.handleReleased({ sessionId: 's1', streamId: 'stream-1', itemIds: [item.id], reason: 'terminal' });
  assert.equal(h.current(item.id).status, 'waiting_for_turn', 'still busy: it waits for the terminal');
  await h.steer.maybeOffer('s1');
  await flush();
  assert.equal(h.calls.offer.length, 1, 'not offered again for that stream');

  h.setBusy(false);
  const sent = [];
  const dispatch = createQueuedSendDispatcher({
    sendOutbox: h.outbox,
    getQueuedSend: (id) => h.outbox.peek(id),
    isSessionBusy: () => false,
    hasPendingToolApprovalForSession: () => false,
    isDockApprovalSteerActive: () => false,
    startPromptSend: async (prompt) => { sent.push(prompt); return { started: true }; },
    renderComposerState() {},
    renderSessions() {},
  });
  await dispatch('s1', {});
  assert.deepEqual(sent, ['carry on']);
  assert.equal(h.outbox.list('s1').length, 0);
  dispatch.dispose();
});

test('a release that lands after the turn ended returns the item to ready and drains it', async () => {
  const h = createHarness();
  const item = h.add();
  await h.steer.maybeOffer('s1');
  await flush();
  h.setBusy(false);
  h.steer.handleReleased({ sessionId: 's1', streamId: 'stream-1', itemIds: [item.id], reason: 'terminal' });
  assert.equal(h.current(item.id).status, 'ready');
  assert.deepEqual(h.calls.dispatched, ['s1']);
});

test('a terminal drain that finds an offered head sends it as the next turn, and a busy chat leaves it alone', async () => {
  const h = createHarness();
  const item = h.add({ prompt: 'late' });
  await h.steer.maybeOffer('s1');
  await flush();
  let busy = true;
  const sent = [];
  const dispatch = createQueuedSendDispatcher({
    sendOutbox: h.outbox,
    getQueuedSend: (id) => h.outbox.peek(id),
    isSessionBusy: () => busy,
    hasPendingToolApprovalForSession: () => false,
    isDockApprovalSteerActive: () => false,
    startPromptSend: async (prompt) => { sent.push(prompt); return { started: true }; },
    renderComposerState() {},
    renderSessions() {},
  });
  await dispatch('s1', {});
  assert.equal(h.current(item.id).status, 'offered', 'a live turn still owns the offer');
  busy = false;
  await dispatch('s1', {});
  assert.deepEqual(sent, ['late']);
  dispatch.dispose();
});

test('a taken row never reaches the composer through the legacy head slot', async () => {
  const h = createHarness({ withdrawResult: { ok: false, reason: 'consumed' } });
  const item = h.add({ prompt: 'gone' });
  await h.steer.maybeOffer('s1');
  await flush();
  await h.steer.withdraw(h.current(item.id));
  assert.equal(h.outbox.peek('s1'), null);
  assert.equal(h.state.queuedSendBySession.has('s1'), false);
  assert.equal(h.outbox.firstDispatchable('s1'), null);
});
