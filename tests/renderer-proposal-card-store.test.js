'use strict';

// The proposal card store (row 59 checkpoint 3): one cached read of each projection,
// a revision guard, coalesced onChanged refetches, gesture ids and Run acknowledgements.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProposalCardStore } = require('../renderer/chat/renderer-proposal-card-store');

const PID = `proposal_${'a'.repeat(64)}`;
const SID = 'session-1';

function projection(overrides = {}) {
  return {
    schema_version: 1, proposal_id: PID, revision: 1, kind: 'git', decision_state: 'pending', action_state: 'none',
    display: { summary: 's', question: 'q', paths: ['a.js'], path_count: 1 }, decision: null,
    links: { continuation_turn_id: null, continuation_work_id: null, command_tool_call_id: null },
    actions: { commit: { available: true, reason: null }, test_first: { available: true, reason: null }, dismiss: { available: true, reason: null }, cancel: { available: false, reason: null }, retry: { available: false, reason: null } },
    execution: null, last_error: null, ...overrides,
  };
}

function makeBridge(responses) {
  const calls = [];
  let listener = null;
  const bridge = {
    calls,
    get: async (request) => { calls.push(request); const next = responses.shift(); if (next instanceof Error) throw next; return next; },
    onChanged: (fn) => { listener = fn; return () => { listener = null; }; },
    emit: (event) => listener && listener(event),
    hasListener: () => Boolean(listener),
  };
  return bridge;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function timers() {
  const queue = [];
  return {
    queue,
    setTimeout: (fn) => { queue.push(fn); return queue.length; },
    clearTimeout: () => {},
    run: () => { while (queue.length) queue.shift()(); },
  };
}

test('a first lookup is checking, reads the record once, then serves it from the cache', async () => {
  const bridge = makeBridge([{ schema_version: 1, ok: true, proposal: projection() }]);
  const store = createProposalCardStore({ getBridge: () => bridge });
  const seen = [];
  store.subscribe((event) => seen.push(event));
  assert.equal(store.revisionKey(SID), '');
  assert.equal(store.lookup(SID, PID).status, 'checking');
  assert.equal(store.lookup(SID, PID).status, 'checking');
  await flush();
  assert.equal(bridge.calls.length, 1);
  assert.deepEqual(bridge.calls[0], { schema_version: 1, session_id: SID, proposal_id: PID });
  const ready = store.lookup(SID, PID);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.proposal.revision, 1);
  assert.equal(bridge.calls.length, 1);
  assert.deepEqual(seen, [{ sessionId: SID, proposalId: PID }]);
  assert.match(store.revisionKey(SID), /^proposal-cards:\d+$/u);
  assert.equal(store.revisionKey('other'), '');
});

test('without the bridge a card is unavailable and nothing is fetched or cached', () => {
  const store = createProposalCardStore({ getBridge: () => null });
  const result = store.lookup(SID, PID, { command: 'x' });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.fallback, { command: 'x' });
  assert.equal(store.revisionKey(SID), '');
});

test('not_found settles the card and is not asked again; a failed read is unavailable and retried later', async () => {
  const bridge = makeBridge([{ schema_version: 1, ok: false, error_code: 'CMP-PROPOSAL-0001', reason: 'not_found', retryable: false }]);
  const store = createProposalCardStore({ getBridge: () => bridge });
  store.lookup(SID, PID);
  await flush();
  assert.equal(store.lookup(SID, PID).status, 'not_found');
  assert.equal(bridge.calls.length, 1);

  let clock = 1000;
  const failing = makeBridge([new Error('boom'), { schema_version: 1, ok: true, proposal: projection() }]);
  const second = createProposalCardStore({ getBridge: () => failing, now: () => clock });
  second.lookup(SID, PID);
  await flush();
  assert.equal(second.lookup(SID, PID).status, 'unavailable');
  assert.equal(failing.calls.length, 1);
  clock += 9000;
  second.lookup(SID, PID);
  await flush();
  assert.equal(second.lookup(SID, PID).status, 'ready');
});

test('an older revision never overwrites a newer one and an equal one is not a change', async () => {
  const bridge = makeBridge([{ schema_version: 1, ok: true, proposal: projection({ revision: 3, decision_state: 'dismissed' }) }]);
  const store = createProposalCardStore({ getBridge: () => bridge });
  store.lookup(SID, PID);
  await flush();
  let changes = 0;
  store.subscribe(() => { changes += 1; });
  assert.equal(store.apply(SID, projection({ revision: 2 })), false);
  assert.equal(store.apply(SID, projection({ revision: 3, decision_state: 'dismissed' })), false);
  assert.equal(changes, 0);
  assert.equal(store.lookup(SID, PID).proposal.decision_state, 'dismissed');
  assert.equal(store.apply(SID, projection({ revision: 4, decision_state: 'dismissed' })), true);
  assert.equal(changes, 1);
  assert.equal(store.apply(SID, { proposal_id: PID, revision: 9 }), false, 'a malformed projection is refused');
});

test('onChanged refetches only that session, coalesced into one read per record', async () => {
  const bridge = makeBridge([
    { schema_version: 1, ok: true, proposal: projection() },
    { schema_version: 1, ok: true, proposal: projection({ revision: 2, decision_state: 'dismissed' }) },
  ]);
  const clock = timers();
  const store = createProposalCardStore({ getBridge: () => bridge, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  store.lookup(SID, PID);
  await flush();
  assert.ok(bridge.hasListener(), 'subscribed on first sight');
  bridge.emit({ schema_version: 1, session_id: 'other', revision: 5 });
  bridge.emit({ schema_version: 1, session_id: SID, revision: 6 });
  bridge.emit({ schema_version: 1, session_id: SID, revision: 7 });
  assert.equal(clock.queue.length, 2, 'one timer per session');
  clock.run();
  await flush();
  assert.equal(bridge.calls.length, 2, 'the unrelated session had no cards to read');
  assert.equal(store.lookup(SID, PID).proposal.decision_state, 'dismissed');
});

test('a gesture keeps one decision_id until settled, and a different intent gets a new one', () => {
  let n = 0;
  const store = createProposalCardStore({ getBridge: () => null, randomUUID: () => `id-${n += 1}` });
  const first = store.gestureId(SID, PID, 'decide:commit:1');
  assert.equal(store.gestureId(SID, PID, 'decide:commit:1'), first);
  assert.notEqual(store.gestureId(SID, PID, 'decide:dismiss:1'), first);
  store.settleGesture(SID, PID);
  assert.notEqual(store.gestureId(SID, PID, 'decide:dismiss:1'), 'id-2');
});

test('Run acknowledgements live in the store, bump the comparand and never persist', () => {
  const store = createProposalCardStore({ getBridge: () => null });
  const before = store.revisionKey(SID);
  store.setAck(SID, PID, 1, true);
  store.setAck(SID, PID, 0, true);
  assert.notEqual(store.revisionKey(SID), before);
  store.setAck(SID, PID, 1, false);
  store.setBusy(SID, PID, true);
  assert.equal(store.isBusy(SID, PID), true);
  store.setBusy(SID, PID, false);
  const seen = store.lookup(SID, PID);
  assert.deepEqual(seen.acks, [0]);
  assert.equal(seen.busy, false);
});

test('dispose stops the subscription and further reads', async () => {
  const bridge = makeBridge([{ schema_version: 1, ok: true, proposal: projection() }]);
  const store = createProposalCardStore({ getBridge: () => bridge });
  store.lookup(SID, PID);
  await flush();
  store.dispose();
  assert.equal(bridge.hasListener(), false);
});

// ---- session proposals (row 59 checkpoint 5a-2) ---------------------------------------

const GID = `group_${'a'.repeat(64)}`;
const pidOf = (c) => `proposal_${c.repeat(64)}`;
const YES = { available: true, reason: null };
const NO = { available: false, reason: null };
const SESSION_LINKS = { continuation_turn_id: null, continuation_work_id: null, command_tool_call_id: null, child_session_id: null, first_turn_turn_id: null, first_turn_work_id: null, preparation_turn_id: null };

function sessionProjection(c, overrides = {}) {
  return {
    schema_version: 1, proposal_id: pidOf(c), revision: 1, kind: 'session', decision_state: 'pending', action_state: 'none',
    created_at: `2026-10-15T10:00:0${c.charCodeAt(0) % 10}Z`, expires_at: '2026-10-22T10:00:00Z',
    display: { title: `Task ${c}`, description: null, initiation: 'own_initiative', authorization_required: false },
    group_id: GID, options: { destination_project_id: null, preferred_model: null, reasoning_effort: null, run_mode: 'agent' }, options_editable: true,
    decision: null, links: SESSION_LINKS, execution: null, last_error: null,
    actions: { do_it_here: YES, new_session: YES, dismiss: YES, cancel: NO, retry: NO }, ...overrides,
  };
}

function sessionBridge({ items = [], pages = null, capabilities = null } = {}) {
  const calls = { get: [], list: [], getCapabilities: [] };
  let listener = null;
  return {
    calls,
    get: async (request) => { calls.get.push(request); const found = items.find((item) => item.proposal_id === request.proposal_id); return found ? { schema_version: 1, ok: true, proposal: found } : { ok: false, reason: 'not_found' }; },
    list: async (request) => {
      calls.list.push(request);
      if (pages) return pages(request, calls.list.length);
      return { schema_version: 1, ok: true, items, next_cursor: null, revision: 1 };
    },
    getCapabilities: async (request) => { calls.getCapabilities.push(request); return typeof capabilities === 'function' ? capabilities(request) : capabilities; },
    onChanged: (fn) => { listener = fn; return () => { listener = null; }; },
    emit: (event) => listener && listener(event),
  };
}

test('a session projection is accepted; a session projection with a malformed group_id is not', async () => {
  const good = sessionProjection('a');
  const bridge = sessionBridge({ items: [good, { ...sessionProjection('b'), group_id: 7 }] });
  const store = createProposalCardStore({ getBridge: () => bridge });
  store.lookup(SID, pidOf('a'));
  store.lookup(SID, pidOf('b'));
  await flush();
  assert.equal(store.lookup(SID, pidOf('a')).status, 'ready');
  assert.equal(store.lookup(SID, pidOf('b')).status, 'unavailable', 'the closed shape rejects a bad group_id');
});

test('a grouped row reads its members once through list, oldest first, filtering other groups and kinds', async () => {
  const members = [sessionProjection('c'), sessionProjection('a'), sessionProjection('b')];
  const other = sessionProjection('d', { group_id: `group_${'b'.repeat(64)}` });
  const git = projection({ proposal_id: pidOf('e') });
  const bridge = sessionBridge({ items: [...members, other, git] });
  const store = createProposalCardStore({ getBridge: () => bridge });
  store.apply(SID, members[1]);
  const first = store.lookup(SID, pidOf('a'));
  assert.equal(first.group.status, 'checking');
  assert.deepEqual(first.group.members, []);
  await flush();
  assert.equal(bridge.calls.list.length, 1);
  assert.deepEqual(bridge.calls.list[0], { schema_version: 1, session_id: SID, limit: 100 });
  const after = store.lookup(SID, pidOf('a'));
  assert.equal(after.group.status, 'ready');
  const expected = [...members].sort((x, y) => (x.created_at === y.created_at
    ? (x.proposal_id < y.proposal_id ? -1 : 1) : (x.created_at < y.created_at ? -1 : 1))).map((m) => m.proposal_id);
  assert.deepEqual(after.group.members.map((m) => m.proposal_id), expected);
  assert.equal(bridge.calls.list.length, 1, 'cached per session and group');
  assert.equal(store.lookup(SID, pidOf('f')).group, null, 'a row without a record has no group');
});

test('group members page through next_cursor and a stale cursor restarts once', async () => {
  const a = sessionProjection('a'); const b = sessionProjection('b');
  let round = 0;
  const bridge = sessionBridge({
    pages: async (request) => {
      if (!request.cursor) { round += 1; return { ok: true, items: [a], next_cursor: `cursor-${round}`, revision: 1 }; }
      if (round === 1) return { ok: false, reason: 'stale_cursor', retryable: true };
      return { ok: true, items: [b], next_cursor: null, revision: 2 };
    },
  });
  const store = createProposalCardStore({ getBridge: () => bridge });
  store.apply(SID, a);
  store.lookup(SID, a.proposal_id);
  await flush();
  assert.deepEqual(bridge.calls.list.map((request) => request.cursor || null), [null, 'cursor-1', null, 'cursor-2']);
  assert.deepEqual(store.lookup(SID, a.proposal_id).group.members.map((m) => m.proposal_id).sort(), [a.proposal_id, b.proposal_id].sort());
});

test('a member that arrives by get joins the cached group; a newer revision replaces, an older one never does', async () => {
  const a = sessionProjection('a'); const b = sessionProjection('b');
  const bridge = sessionBridge({ items: [a] });
  const store = createProposalCardStore({ getBridge: () => bridge });
  store.apply(SID, a);
  store.lookup(SID, a.proposal_id);
  await flush();
  assert.equal(store.lookup(SID, a.proposal_id).group.members.length, 1);
  store.apply(SID, b);
  assert.equal(store.lookup(SID, a.proposal_id).group.members.length, 2);
  store.apply(SID, sessionProjection('a', { revision: 4, decision_state: 'dismissed' }));
  assert.equal(store.lookup(SID, a.proposal_id).group.members.find((m) => m.proposal_id === a.proposal_id).revision, 4);
  store.apply(SID, sessionProjection('a', { revision: 2 }));
  assert.equal(store.lookup(SID, a.proposal_id).group.members.find((m) => m.proposal_id === a.proposal_id).revision, 4, 'an older read never overwrites a newer one');
});

test('onChanged refetches the group and wakes the first row, so the header repaints', async () => {
  const a = sessionProjection('a'); const b = sessionProjection('b');
  const items = [a];
  const bridge = sessionBridge({ items });
  const clock = timers();
  const store = createProposalCardStore({ getBridge: () => bridge, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  store.apply(SID, a);
  store.lookup(SID, a.proposal_id);
  await flush();
  const seen = [];
  store.subscribe((event) => seen.push(event));
  items.push(b);
  bridge.emit({ session_id: SID, revision: 9 });
  clock.run();
  await flush();
  assert.equal(bridge.calls.list.length, 2);
  assert.equal(store.lookup(SID, a.proposal_id).group.members.length, 2);
  assert.ok(seen.some((event) => event.proposalId === a.proposal_id));
});

test('group gesture ids: one per snapshot until settled; busy and notice bump the comparand', () => {
  let n = 0;
  const store = createProposalCardStore({ getBridge: () => null, randomUUID: () => `group-decision-${n += 1}` });
  const first = store.groupGestureId(SID, GID, 'a@1,b@1');
  assert.equal(store.groupGestureId(SID, GID, 'a@1,b@1'), first);
  assert.notEqual(store.groupGestureId(SID, GID, 'a@2,b@1'), first, 'a changed snapshot is a new intent');
  store.settleGroupGesture(SID, GID);
  assert.notEqual(store.groupGestureId(SID, GID, 'a@2,b@1'), 'group-decision-2');
  const before = store.revisionKey(SID);
  store.setGroupBusy(SID, GID, true);
  assert.equal(store.isGroupBusy(SID, GID), true);
  assert.notEqual(store.revisionKey(SID), before);
  store.setGroupNotice(SID, GID, { text: 'x' });
  store.setGroupBusy(SID, GID, false);
  assert.equal(store.isGroupBusy(SID, GID), false);
});

test('Options: open state lives in the store; opening reads capabilities and wakes the card', async () => {
  const caps = { ok: true, destinations: [], models: [], reasoning_efforts: [], run_modes: ['agent', 'plan'], restrictions: {}, unavailable_reason: null };
  const a = sessionProjection('a', { group_id: null });
  const bridge = sessionBridge({ items: [a], capabilities: caps });
  const store = createProposalCardStore({ getBridge: () => bridge });
  store.apply(SID, a);
  const seen = [];
  store.subscribe((event) => seen.push(event.proposalId));
  assert.equal(store.lookup(SID, a.proposal_id).optionsOpen, false);
  await flush();
  assert.equal(bridge.calls.getCapabilities.length, 1, 'a single offer reads its capabilities once for the summary');
  store.setOptionsOpen(SID, a.proposal_id, true);
  await flush();
  assert.equal(store.isOptionsOpen(SID, a.proposal_id), true);
  assert.equal(store.lookup(SID, a.proposal_id).optionsOpen, true);
  assert.equal(bridge.calls.getCapabilities.length, 2, 'opening refreshes');
  assert.deepEqual(bridge.calls.getCapabilities[1], { schema_version: 1, session_id: SID, proposal_id: a.proposal_id });
  assert.equal(store.lookup(SID, a.proposal_id).capabilities.status, 'ready');
  assert.ok(seen.length >= 2);
  store.setOptionsOpen(SID, a.proposal_id, false);
  assert.equal(store.lookup(SID, a.proposal_id).optionsOpen, false);
});

test('Options: a group row reads capabilities only when opened; a malformed or failed read is an error, never a crash', async () => {
  const a = sessionProjection('a');
  const bridge = sessionBridge({ items: [a], capabilities: { ok: true, destinations: 'nope' } });
  const store = createProposalCardStore({ getBridge: () => bridge });
  store.apply(SID, a);
  store.lookup(SID, a.proposal_id);
  await flush();
  assert.equal(bridge.calls.getCapabilities.length, 0);
  store.setOptionsOpen(SID, a.proposal_id, true);
  await flush();
  assert.equal(store.lookup(SID, a.proposal_id).capabilities.status, 'error');
  const throwing = sessionBridge({ items: [a], capabilities: () => { throw new Error('ipc closed'); } });
  const second = createProposalCardStore({ getBridge: () => throwing });
  second.apply(SID, a);
  second.setOptionsOpen(SID, a.proposal_id, true);
  await flush();
  assert.equal(second.lookup(SID, a.proposal_id).capabilities.status, 'error');
});

test('a bridge without list or getCapabilities leaves rows plain: no group, no capabilities, no throw', async () => {
  const a = sessionProjection('a');
  const bridge = { get: async () => ({ ok: true, proposal: a }), onChanged: () => () => {} };
  const store = createProposalCardStore({ getBridge: () => bridge });
  store.lookup(SID, a.proposal_id);
  await flush();
  const ready = store.lookup(SID, a.proposal_id);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.group, null);
  store.setOptionsOpen(SID, a.proposal_id, true);
  await flush();
  assert.equal(store.lookup(SID, a.proposal_id).capabilities.status, 'idle');
  assert.equal(store.lookup(SID, a.proposal_id).optionsOpen, true);
});
