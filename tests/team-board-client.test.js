'use strict';

// new-test-file: row 151 slice T3 adds the member's board client (services/team/board-client.js), a new module.
//
// Each client here talks to the real team host parts (router, authorizer, board store, event stream) through the
// project fixture, so "the client's document equals the host's" is checked against the host's own snapshot:
// two members converging, a gap, a reorder, a resync from a snapshot, a refused batch rolled back with its
// notice, a call that got no answer, and a member who loses the board.

const assert = require('node:assert/strict');
const test = require('node:test');

const { GRACE_MS, MAX_PENDING, createBoardClient } = require('../services/team/board-client');
const { teamFailure } = require('../services/team/team-errors');
const { dataFrames } = require('./server/helpers/session-scope-fixture');
const { batch, must, note } = require('./server/helpers/team-board-kit');
const { createTeamProjectFixture } = require('./server/helpers/team-project-fixture');

function fakeTimers() {
  const waiting = new Set();
  return {
    setTimeout: (body, ms) => { const handle = { body, ms }; waiting.add(handle); return handle; },
    clearTimeout: (handle) => waiting.delete(handle),
    fire() { const due = [...waiting]; waiting.clear(); for (const handle of due) handle.body(); return due.length; },
    delays: () => [...waiting].map((handle) => handle.ms),
    size: () => waiting.size,
  };
}

// Project X: Alice admin, Carl writer, Rae (read-only team member) reader; one board. Bob is outside it.
async function world(t, options = {}) {
  const h = await createTeamProjectFixture(t, { boards: true, boardLimits: { commands: { apply: { limit: 10_000 }, sync: { limit: 10_000 } }, route: { limit: 10_000, windowMs: 60_000, maxKeys: 64 } }, ...options });
  const id = (who) => h.seats[who].member_id;
  const x = await h.sharedProject('Apollo');
  const live = (await must(h.state.boards.create({ projectId: x, actor: id('alice'), name: 'Roadmap' }))).board.id;
  const timers = fakeTimers();
  const busy = { calls: 0 };
  const members = [];
  // A member's client; `hooks.send(operation, params, real)` may stand in for the host call.
  const member = (who, boardId = live) => {
    const stream = h.attach(who);
    const pushes = [];
    const hooks = {};
    const sent = [];
    let delivered = 0;
    const real = (operation, params) => h.send(who, operation, params);
    const tracked = async (work) => { busy.calls += 1; try { return await work(); } finally { busy.calls -= 1; } };
    const client = createBoardClient({ projectId: x, boardId, self: () => id(who), timers, online: () => hooks.offline !== true,
      push: (payload) => pushes.push(payload), onGone: (reason) => { hooks.gone = reason; },
      send: (operation, params) => tracked(() => { sent.push(operation); return hooks.send ? hooks.send(operation, params, real) : real(operation, params); }),
      readSnapshot: () => tracked(async () => { sent.push('snapshot'); return hooks.snapshot ? hooks.snapshot() : (await h.boardRoute(who, x, boardId)).json; }) });
    const entry = { who, client, pushes, hooks, sent,
      fresh() { const all = dataFrames(stream.frames); const out = all.slice(delivered); delivered = all.length; return out; },
      deliver() { const frames = entry.fresh(); for (const frame of frames) client.onEvent(frame); return frames.length; },
      view: async () => (await client.open()).board,
      kinds: () => pushes.map((payload) => payload.kind) };
    members.push(entry);
    return entry;
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  // Until nothing moves: every stream's events delivered, every timer fired, no call out.
  const quiet = async (deliver = members) => {
    for (let still = 0, rounds = 0; still < 4; rounds += 1) {
      assert.ok(rounds < 2000, 'the clients never went quiet');
      // Events first, as on a live stream (the host publishes before it answers); a timer only once they are in.
      let moved = busy.calls;
      for (const entry of deliver) moved += entry.deliver();
      await tick();
      if (moved === 0 && busy.calls === 0) moved += timers.fire();
      still = moved === 0 && busy.calls === 0 ? still + 1 : 0;
    }
  };
  const host = async (boardId = live) => (await must(h.state.boards.get({ projectId: x, boardId }))).board;
  return { h, id, x, live, timers, member, quiet, host, tick };
}

const edit = (card, text) => ({ op: 'card.edit', id: card.id, content_rev: card.content_rev, data: { text } });
const send = (entry, ...ops) => { const sent = batch(...ops); return { sent, answer: entry.client.apply(sent) }; };

test('T3 client: two members\' batches converge on the host\'s document, each member\'s own shown at once', async (t) => {
  const w = await world(t);
  const alice = w.member('alice');
  const carl = w.member('carl');
  assert.deepEqual((await alice.client.open()).rev, (await carl.client.open()).rev);
  const first = note('from alice', 10);
  const made = send(alice, first);
  // Her own batch is on her view before the host has answered, and counted as pending.
  assert.deepEqual([made.answer.ok, made.answer.pending, made.answer.board.cards[first.card.id].data.text], [true, 1, 'from alice']);
  assert.equal((await carl.view()).cards[first.card.id], undefined);
  send(carl, note('from carl', 200));
  await w.quiet();
  const card = (await carl.view()).cards[first.card.id];
  assert.equal(card.created_by, w.id('alice'));
  // Every kind of change, from both sides, some at once.
  const second = note('second', 400);
  send(carl, edit(card, 'edited by carl'), { op: 'card.place', id: card.id, x: 50, y: 60 });
  send(alice, second, { op: 'connector.add', connector: { id: crypto.randomUUID(), from: first.card.id, to: second.card.id } });
  send(alice, { op: 'group.add', group: { id: crypto.randomUUID(), title: 'Group', x: 0, y: 0, w: 600, h: 300 } });
  send(carl, { op: 'board.rename', name: 'Roadmap 2' });
  await w.quiet();
  send(alice, { op: 'card.remove', id: second.card.id, content_rev: (await alice.view()).cards[second.card.id].content_rev });
  await w.quiet();
  const truth = await w.host();
  assert.deepEqual(await alice.view(), truth);
  assert.deepEqual(await carl.view(), truth);
  assert.equal(truth.name, 'Roadmap 2');
  assert.deepEqual([alice.client.resources().pending, carl.client.resources().pending], [0, 0]);
  // Each applied push says whose it was; a member's own batches are marked.
  const own = (entry) => entry.pushes.filter((payload) => payload.kind === 'applied' && payload.own).length;
  assert.deepEqual([own(alice), own(carl)], [4, 3]);
  assert.ok(carl.pushes.every((payload) => payload.kind === 'applied'));
  // Everything came by events: one snapshot each, and no sync was needed.
  assert.deepEqual([alice.sent.filter((name) => name !== 'team.board.apply'), carl.sent.filter((name) => name !== 'team.board.apply')],
    [['snapshot'], ['snapshot']]);
});

test('T3 client: a missed event, an event without its batch and events out of order all end at the host\'s document', async (t) => {
  const w = await world(t);
  const alice = w.member('alice');
  const carl = w.member('carl');
  await alice.client.open();
  await carl.client.open();
  // A gap: Carl never gets the first event; the second shows the gap and one sync fills it.
  send(alice, note('one'));
  await w.quiet([alice]);
  assert.equal(carl.fresh().length, 1);
  send(alice, note('two', 300));
  await w.quiet();
  assert.deepEqual(await carl.view(), await w.host());
  assert.deepEqual(carl.sent, ['snapshot', 'team.board.sync']);
  // Over 16 KiB: the event carries the rev alone, and the batch is read with sync.
  send(alice, ...Array.from({ length: 5 }, (_, index) => note('n'.repeat(4000), 600 + index)));
  await w.quiet();
  assert.deepEqual(await carl.view(), await w.host());
  assert.deepEqual(carl.sent.slice(2), ['team.board.sync']);
  // Out of order: the later event first, then the earlier one (which is then old news).
  send(alice, note('three', 900));
  await w.quiet([alice]);
  send(alice, note('four', 1200));
  await w.quiet([alice]);
  const [early, late] = carl.fresh();
  carl.client.onEvent(late);
  await w.quiet([alice]);
  carl.client.onEvent(early);
  await w.quiet();
  assert.deepEqual(await carl.view(), await w.host());
  const revs = carl.pushes.filter((payload) => payload.kind === 'applied').map((payload) => payload.rev);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b), 'batches were applied out of the host\'s order');
  assert.equal(new Set(revs).size, revs.length);
  // An event for another board, a malformed one and one that claims a far rev change nothing for long.
  carl.client.onEvent({ event_type: 'team_board_changed', project_id: w.x, board_id: 'board_other', rev: 99 });
  carl.client.onEvent({ event_type: 'team_board_changed', project_id: w.x, board_id: w.live, rev: 'x' });
  carl.client.onEvent({ event_type: 'team_board_changed', project_id: w.x, board_id: w.live, rev: 9_000_000 });
  await w.quiet();
  assert.deepEqual(await carl.view(), await w.host());
  assert.equal(w.timers.size(), 0);
});

test('T3 client: back online after the journal moved on, the snapshot is read again; resync_required asks the host', async (t) => {
  const w = await world(t);
  const carl = w.member('carl');
  await carl.client.open();
  carl.hooks.offline = true;
  for (let index = 0; index < 205; index += 1) {
    await must(w.h.state.boards.apply({ projectId: w.x, boardId: w.live, actor: w.id('alice'),
      batch: batch({ op: 'board.rename', name: `Roadmap ${index}` }) }));
  }
  carl.fresh();
  // A batch made while offline waits; nothing is sent.
  const kept = note('made offline');
  assert.equal(send(carl, kept).answer.pending, 1);
  await w.quiet([]);
  assert.deepEqual(carl.sent, ['snapshot']);
  carl.hooks.offline = false;
  carl.client.reconnected();
  await w.quiet();
  assert.deepEqual(carl.sent.filter((name) => name !== 'team.board.apply').slice(0, 3), ['snapshot', 'team.board.sync', 'snapshot']);
  assert.ok(carl.kinds().includes('reloaded'));
  const truth = await w.host();
  assert.deepEqual(await carl.view(), truth);
  assert.equal(truth.cards[kept.card.id].data.text, 'made offline');
  assert.equal(carl.client.resources().pending, 0);
  // The stream says its replay is gone: one sync.
  const before = carl.sent.length;
  carl.client.onEvent({ event_type: 'resync_required', reason: 'replay_unavailable' });
  await w.quiet();
  assert.deepEqual(carl.sent.slice(before), ['team.board.sync']);
});

test('T3 client: a refused batch is rolled back with a notice naming its card; a move by someone else refuses no edit', async (t) => {
  const w = await world(t);
  const alice = w.member('alice');
  const carl = w.member('carl');
  const rae = w.member('rae');
  await Promise.all([alice.client.open(), carl.client.open(), rae.client.open()]);
  const shared = note('shared');
  send(alice, shared);
  await w.quiet();
  const seen = (await carl.view()).cards[shared.card.id];
  // Alice edits; before Carl hears of it he edits the same card: the host refuses his as stale.
  send(alice, edit(seen, 'alice was first'));
  await w.quiet([alice]);
  const stale = send(carl, edit(seen, 'carl was second'));
  assert.equal(stale.answer.board.cards[shared.card.id].data.text, 'carl was second');
  await w.quiet([alice]);
  const notice = carl.pushes.find((payload) => payload.kind === 'refused');
  assert.deepEqual({ ...notice, rev: undefined }, { kind: 'refused', batch_id: stale.sent.batch_id, reason: 'team_board_refused',
    detail: { reason: 'stale', detail: null, limit: null }, card_id: shared.card.id, rev: undefined, pending: 0 });
  assert.equal((await carl.view()).cards[shared.card.id].data.text, 'shared');
  await w.quiet();
  assert.equal((await carl.view()).cards[shared.card.id].data.text, 'alice was first');
  // A move and an edit have separate revisions: Alice moves the card, Carl (who has not heard) edits it.
  const now = (await carl.view()).cards[shared.card.id];
  send(alice, { op: 'card.place', id: shared.card.id, x: 700, y: 700 });
  await w.quiet([alice]);
  send(carl, edit(now, 'carl edits after the move'));
  await w.quiet();
  const truth = await w.host();
  assert.deepEqual([truth.cards[shared.card.id].x, truth.cards[shared.card.id].data.text], [700, 'carl edits after the move']);
  assert.equal(carl.pushes.filter((payload) => payload.kind === 'refused').length, 1);
  for (const entry of [alice, carl, rae]) assert.deepEqual(await entry.view(), truth, entry.who);
  // A reader's batch: the host refuses it by role, and the reader's view goes back.
  const denied = send(rae, note('a reader writes'));
  assert.equal(denied.answer.ok, true);
  await w.quiet();
  assert.deepEqual(rae.pushes.at(-1), { kind: 'refused', batch_id: denied.sent.batch_id, reason: 'role_forbidden', detail: null,
    card_id: denied.sent.ops[0].card.id, rev: truth.rev, pending: 0 });
  assert.deepEqual(await rae.view(), truth);
  assert.deepEqual(await w.host(), truth);
});

test('T3 client: a call with no answer and a rate limit are sent again with the same batch id, and land once', async (t) => {
  const w = await world(t);
  const carl = w.member('carl');
  await carl.client.open();
  // The shapes the connection really answers with (it never throws and never answers null): a lost answer is a
  // failure whose reason says so.
  const lost = (reason) => () => teamFailure('CONNECTION_FAILED', reason);
  const failures = [lost('team_connection_reset'), lost('team_request_timeout'), lost('team_response_invalid'), lost('team_response_too_large'),
    () => ({ ok: false, error: { code: 'CMP-HOST-0001', reason: 'team_board_rate_limit', retryable: false } }),
    // The host applied it but the answer was lost.
    async (operation, params, real) => { await real(operation, params); return lost('team_connection_reset')(); }];
  const tried = [];
  carl.hooks.send = (operation, params, real) => {
    if (operation !== 'team.board.apply') return real(operation, params);
    tried.push(params.batch.batch_id);
    return failures.length ? failures.shift()(operation, params, real) : real(operation, params);
  };
  const made = send(carl, note('once'));
  const second = send(carl, note('after it', 300));
  await w.tick();
  // The first wait is one second; the second batch is not sent before the first is settled.
  assert.ok(w.timers.delays().includes(1000));
  await w.quiet();
  // Six tries: the sixth reached the host, whose event confirmed the batch, so it was not sent a seventh time.
  assert.deepEqual(tried, [...Array.from({ length: 6 }, () => made.sent.batch_id), second.sent.batch_id]);
  // The same lost answer with the event lost too: the batch is sent again, the host calls it a repeat, a sync brings it.
  failures.push(async (operation, params, real) => { await real(operation, params); return lost('team_request_timeout')(); });
  const third = send(carl, note('answer and event lost', 600));
  while (tried.length < 8) await w.tick();
  await w.tick();
  carl.fresh();
  await w.quiet();
  assert.deepEqual(tried.slice(7), [third.sent.batch_id, third.sent.batch_id]);
  const truth = await w.host();
  assert.deepEqual(Object.values(truth.cards).map((card) => card.data.text).sort(), ['after it', 'answer and event lost', 'once']);
  assert.deepEqual(await carl.view(), truth);
  assert.deepEqual([carl.client.resources().pending, carl.kinds().includes('refused')], [0, false]);
  // A sync whose answer is lost is asked again: the board is not ended.
  const alice = w.member('alice');
  await alice.client.open();
  send(alice, note('while carl was away', 900));
  await w.quiet([alice]);
  carl.fresh();
  const syncs = [lost('team_request_timeout'), lost('team_connection_reset')];
  carl.hooks.send = (operation, params, real) => (operation === 'team.board.sync' && syncs.length ? syncs.shift()() : real(operation, params));
  carl.client.reconnected();
  await w.quiet();
  assert.deepEqual([syncs.length, carl.kinds().includes('gone'), carl.client.resources().closed], [0, false, false]);
  assert.deepEqual(await carl.view(), await w.host());
});

test('T3 client: a board the host can no longer read drops what waited, says so once, and is read again when the team is back', async (t) => {
  const w = await world(t);
  const carl = w.member('carl');
  await carl.client.open();
  // Carl's batch is out when a sync finds the board unreadable.
  let answerApply;
  carl.hooks.send = (operation) => (operation === 'team.board.apply' ? new Promise((resolve) => { answerApply = resolve; })
    : { ok: true, rev: 0, snapshot: true });
  carl.hooks.snapshot = () => ({ ok: true, read_only: true, reason: 'corrupt', rev: 0 });
  const waiting = send(carl, note('never lands'));
  await w.tick();
  carl.client.onEvent({ event_type: 'resync_required', reason: 'replay_unavailable' });
  for (let turn = 0; turn < 20; turn += 1) await w.tick();
  assert.deepEqual(carl.pushes, [{ kind: 'refused', batch_id: waiting.sent.batch_id, reason: 'team_board_read_only', detail: null,
    card_id: null, rev: 0, pending: 0 }, { kind: 'reloaded', rev: 0, pending: 0 }]);
  // The answer of the call that was out changes nothing (it once threw on the missing document).
  answerApply({ ok: true, rev: 1 });
  await w.quiet();
  const shown = await carl.client.open();
  assert.deepEqual([shown.read_only, shown.reason, shown.board, shown.pending], [true, 'corrupt', null, 0]);
  assert.equal(carl.client.apply(batch(note('no'))).error.reason, 'team_board_read_only');
  // Still unreadable when the host says the board changed: nothing new is pushed. Readable when the team is back.
  carl.client.onEvent({ event_type: 'team_board_changed', project_id: w.x, board_id: w.live, rev: 4 });
  await w.quiet();
  assert.deepEqual([carl.pushes.length, carl.sent.filter((name) => name === 'snapshot').length], [2, 3]);
  carl.hooks.snapshot = null;
  carl.hooks.send = null;
  carl.client.reconnected();
  await w.quiet();
  assert.deepEqual([carl.kinds().slice(2), (await carl.client.open()).read_only], [['reloaded'], false]);
  send(carl, note('lands'));
  await w.quiet();
  const truth = await w.host();
  assert.deepEqual([Object.values(truth.cards).map((card) => card.data.text), await carl.view()], [['lands'], truth]);
});

test('T3 client: a snapshot the host asks for is taken even when older, and what the host had accepted is sent again', async (t) => {
  const w = await world(t);
  const [alice, carl] = [w.member('alice'), w.member('carl')];
  await alice.client.open();
  await carl.client.open();
  const old = (await w.h.boardRoute('carl', w.x, w.live)).json;
  send(alice, note('kept'));
  await w.quiet();
  const ahead = (await carl.client.open()).rev;
  // The host accepted Carl's batch, then its document went back to an earlier state (a restored backup).
  const once = { 'team.board.apply': () => ({ ok: true, rev: ahead + 1 }), 'team.board.sync': () => ({ ok: true, rev: old.board.rev, snapshot: true }) };
  carl.hooks.send = (operation, params, real) => { const fake = once[operation]; delete once[operation]; return fake ? fake() : real(operation, params); };
  carl.hooks.snapshot = () => { carl.hooks.snapshot = null; return old; };
  send(carl, note('accepted, then lost', 300));
  await w.quiet();
  assert.deepEqual([ahead > old.board.rev, carl.pushes.find((payload) => payload.kind === 'reloaded')],
    [true, { kind: 'reloaded', rev: old.board.rev, pending: 1 }]);
  const truth = await w.host();
  assert.deepEqual(Object.values(truth.cards).map((card) => card.data.text).sort(), ['accepted, then lost', 'kept']);
  assert.deepEqual([await carl.view(), carl.client.resources().pending], [truth, 0]);
});

test('T3 client: a refusal reaches the page as closed words; a board closed for a reason says gone once', async (t) => {
  const w = await world(t);
  const carl = w.member('carl');
  await carl.client.open();
  carl.hooks.send = () => ({ ok: false, error: { code: 'CMP-HOST-0001', reason: 'Not a word <b>' },
    board: { reason: '<i>limit</i>', detail: 'card.id', limit: 7, index: 0 } });
  const made = send(carl, note('x'));
  await w.quiet();
  assert.deepEqual(carl.pushes, [{ kind: 'refused', batch_id: made.sent.batch_id, reason: 'team_board_refused',
    detail: { reason: null, detail: null, limit: null }, card_id: made.sent.ops[0].card.id, rev: 0, pending: 0 }]);
  carl.client.close('team_board_closed');
  carl.client.close('team_board_closed');
  assert.deepEqual([carl.pushes.slice(1), carl.hooks.gone, w.member('alice').client.close()], [[{ kind: 'gone', reason: 'team_board_closed' }], undefined, undefined]);
});

test('T3 client: a host batch that grew past 200 operations (a group that grew) is replayed, not read again as a snapshot', async (t) => {
  const w = await world(t);
  const [alice, carl] = [w.member('alice'), w.member('carl')];
  await alice.client.open();
  await carl.client.open();
  const group = crypto.randomUUID();
  send(alice, { op: 'group.add', group: { id: group, title: 'Ideas', x: 0, y: 0, w: 240, h: 160 } });
  await w.quiet();
  const added = send(alice, ...Array.from({ length: 150 }, (_unused, index) => ({ op: 'card.add',
    card: { id: crypto.randomUUID(), kind: 'note', group_id: group, data: { text: `n${index}` } } })));
  assert.equal(added.answer.ok, true, JSON.stringify(added.answer).slice(0, 300));
  await w.quiet();
  const heard = carl.pushes.filter((payload) => payload.kind === 'applied').at(-1);
  assert.ok(heard.applied.ops.length > 200, String(heard.applied.ops.length));
  const truth = await w.host();
  for (const entry of [alice, carl]) {
    assert.deepEqual([entry.kinds().includes('reloaded'), entry.sent.filter((name) => name === 'snapshot').length, await entry.view()],
      [false, 1, truth], entry.who);
  }
});

test('T3 client: local refusals queue nothing; a member who loses the board is told once and the client ends', async (t) => {
  const w = await world(t);
  const carl = w.member('carl');
  assert.equal(carl.client.apply(batch(note('early'))).error.reason, 'team_board_not_open');
  // Someone outside the project cannot open it; the host's answer comes back as it is.
  const bob = w.member('bob');
  assert.equal((await bob.client.open()).error.reason, 'team_not_found');
  await carl.client.open();
  const refused = carl.client.apply(batch({ op: 'card.edit', id: crypto.randomUUID(), content_rev: 0, data: { text: 'x' } }));
  assert.deepEqual([refused.ok, refused.error.reason, refused.board.index], [false, 'team_board_refused', 0]);
  for (const bad of [null, [], { batch_id: 'b', ops: [], actor: w.id('alice') }, { batch_id: 'b' }]) {
    assert.equal(carl.client.apply(bad).error.reason, 'team_board_invalid');
  }
  assert.deepEqual([carl.client.resources().pending, carl.sent], [0, ['snapshot']]);
  // The queue is bounded.
  carl.hooks.offline = true;
  for (let index = 0; index < MAX_PENDING; index += 1) assert.equal(carl.client.apply(batch(note(`q${index}`, index))).ok, true);
  const full = carl.client.apply(batch(note('one too many')));
  assert.deepEqual([full.error.reason, full.error.retryable], ['team_board_queue_full', true]);
  // Carl is taken off the project while offline: back online, the first refusal ends the client.
  await w.h.ok(w.h.send('alice', 'team.project.members.remove', { project_id: w.x, member_id: w.id('carl') }));
  carl.hooks.offline = false;
  carl.client.reconnected();
  await w.quiet();
  assert.deepEqual(carl.pushes.filter((payload) => payload.kind === 'gone'), [{ kind: 'gone', reason: 'team_not_found' }]);
  assert.deepEqual([carl.hooks.gone, carl.client.resources().closed, w.timers.size()], ['team_not_found', true, 0]);
  assert.equal(carl.client.apply(batch(note('late'))).error.reason, 'team_board_closed');
  assert.equal((await carl.client.open()).error.reason, 'team_board_closed');
  assert.deepEqual(Object.keys((await w.host()).cards), []);
  assert.throws(() => createBoardClient({}), TypeError);
  assert.equal(GRACE_MS > 0, true);
});
