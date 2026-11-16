'use strict';

// new-test-file: row 151 slice T4 adds the member's presence client (services/team/board-presence-client.js), a
// new module; the board client's test file talks to a real host and has no fake clock to drive timers by.
//
// A virtual clock drives fake timers: advancing time runs the due timers in order, and the fake `send` records
// each call and answers from a script. No sockets, no sleeping.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CURSOR_MS, CURSOR_STALE_MS, HEARTBEAT_MS, LOCK_RENEW_MS, PUSH_MS, createBoardPresenceClient,
} = require('../services/team/board-presence-client');

const PROJECT = 'project_alpha';
const BOARD = 'board_00000000-0000-4000-8000-0000000000a1';
const ME = 'member_me';
const AMY = 'member_amy';
const BEN = 'member_ben';
const NOTE1 = '00000000-0000-4000-8000-0000000000c1';
const NOTE2 = '00000000-0000-4000-8000-0000000000c2';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function virtualTime() {
  let now = 1_000_000;
  let seq = 0;
  const waiting = new Map();
  const time = {
    clock: () => now,
    timers: {
      setTimeout: (body, ms) => { seq += 1; const handle = { id: seq }; waiting.set(handle, { body, at: now + ms }); return handle; },
      clearTimeout: (handle) => { waiting.delete(handle); },
    },
    size: () => waiting.size,
    // Runs every timer due within `ms`, earliest first, letting promises settle between them.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await tick();
        const due = [...waiting].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0].id - b[0].id)[0];
        if (!due) break;
        waiting.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].body();
      }
      now = end;
      await tick();
    },
  };
  return time;
}

// `script(operation, params, calls)` may answer; the default answers a view with the room's state.
function setup(options = {}) {
  const time = virtualTime();
  const calls = [];
  const pushes = [];
  const flags = { online: true, reject: false, hang: null };
  const room = { viewers: [ME], locks: [] };
  const send = async (operation, params) => {
    calls.push({ operation, params });
    if (flags.hang) return flags.hang.promise;
    if (flags.reject) throw new Error('socket gone');
    if (options.script) { const answer = options.script(operation, params, calls); if (answer !== undefined) return answer; }
    if (operation === 'team.board.view') return { ok: true, viewers: room.viewers, locks: room.locks, lock_ms: 30_000 };
    // The host holds this member's lock between calls, as the real one does.
    if (operation === 'team.board.lock' || operation === 'team.board.unlock') {
      room.locks = room.locks.filter((lock) => lock.member_id !== ME);
      if (operation === 'team.board.lock') room.locks.push({ card_id: params.card_id, member_id: ME });
    }
    return { ok: true };
  };
  const client = createBoardPresenceClient({ projectId: PROJECT, boardId: BOARD, send, self: () => ME,
    push: (payload) => pushes.push(payload), online: () => flags.online, clock: time.clock, timers: time.timers });
  const sent = (operation) => calls.filter((call) => call.operation === operation);
  const event = (type, fields) => client.onEvent({ event_type: type, project_id: PROJECT, board_id: BOARD, ...fields });
  return { time, calls, pushes, flags, room, client, sent, event };
}

const cursorEvent = (s, memberId, x = 1, y = 2, selected = []) => s.event('team_board_cursor', { member_id: memberId, x, y, selected });

test('T4 client: constants and construction', () => {
  assert.deepEqual([HEARTBEAT_MS, CURSOR_MS, CURSOR_STALE_MS, LOCK_RENEW_MS, PUSH_MS], [15_000, 100, 5_000, 10_000, 50]);
  assert.throws(() => createBoardPresenceClient({ projectId: PROJECT, boardId: BOARD, self: () => ME }), TypeError);
  assert.throws(() => createBoardPresenceClient({ projectId: PROJECT, boardId: BOARD, send: () => {} }), TypeError);
  assert.throws(() => createBoardPresenceClient(), TypeError);
  const s = setup();
  assert.equal(Object.isFrozen(s.client), true);
  assert.deepEqual(s.client.state(), { viewers: [], cursors: [], locks: [], mine: null });
  assert.deepEqual(s.client.resources(), { timers: 0, cursors: 0, locks: 0 });
});

test('T4 client: start views, takes viewers and locks, and repeats every HEARTBEAT_MS', async () => {
  const s = setup();
  s.room.viewers = [ME, AMY];
  s.room.locks = [{ card_id: NOTE1, member_id: AMY }];
  await s.client.start();
  assert.deepEqual(s.sent('team.board.view'), [{ operation: 'team.board.view', params: { project_id: PROJECT, board_id: BOARD } }]);
  assert.deepEqual(s.client.state(), { viewers: [AMY, ME], cursors: [], locks: [{ card_id: NOTE1, member_id: AMY }], mine: null });
  await s.time.advance(PUSH_MS);
  assert.deepEqual(s.pushes, [{ kind: 'presence', viewers: [AMY, ME], cursors: [], locks: [{ card_id: NOTE1, member_id: AMY }], mine: null }]);
  await s.time.advance(HEARTBEAT_MS - PUSH_MS - 1);
  assert.equal(s.sent('team.board.view').length, 1);
  await s.time.advance(1);
  assert.equal(s.sent('team.board.view').length, 2);
  await s.time.advance(HEARTBEAT_MS * 3);
  assert.equal(s.sent('team.board.view').length, 5);
  // Nothing changed: no further push.
  assert.equal(s.pushes.length, 1);
  s.client.start();
  assert.equal(s.sent('team.board.view').length, 5, 'a second start is a no-op');
});

test('T4 client: a failed or unanswered heartbeat is tried again at the next beat and never stacks', async () => {
  const s = setup({ script: (operation, _params, calls) => (operation === 'team.board.view' && calls.length === 2
    ? { ok: false, error: { code: 'CMP-HOST-0001', reason: 'team_unavailable', retryable: true } } : undefined) });
  await s.client.start();
  await s.time.advance(HEARTBEAT_MS);
  assert.equal(s.sent('team.board.view').length, 2, 'the refused beat');
  await s.time.advance(HEARTBEAT_MS);
  assert.equal(s.sent('team.board.view').length, 3, 'tried again at the next beat');
  // A rejection is no answer.
  s.flags.reject = true;
  await s.time.advance(HEARTBEAT_MS);
  assert.equal(s.sent('team.board.view').length, 4);
  s.flags.reject = false;
  // A call that never answers is not stacked on.
  let release;
  s.flags.hang = { promise: new Promise((resolve) => { release = resolve; }) };
  await s.time.advance(HEARTBEAT_MS);
  await s.time.advance(HEARTBEAT_MS * 3);
  assert.equal(s.sent('team.board.view').length, 5);
  s.flags.hang = null;
  release({ ok: true, viewers: [ME], locks: [] });
  await s.time.advance(HEARTBEAT_MS);
  assert.equal(s.sent('team.board.view').length, 6);
  // Offline: no call goes out.
  s.flags.online = false;
  await s.time.advance(HEARTBEAT_MS * 2);
  assert.equal(s.sent('team.board.view').length, 6);
});

test('T4 client: a cursor burst sends the first and the last position, at most one call every CURSOR_MS', async () => {
  const s = setup();
  s.client.cursor({ x: 1, y: 1, selected: [] });
  await s.time.advance(0);
  assert.equal(s.sent('team.board.cursor').length, 0, 'nothing before the first successful view');
  await s.client.start();
  for (let n = 0; n < 10; n += 1) { s.client.cursor({ x: n, y: n * 2, selected: n === 9 ? [NOTE1] : [] }); await s.time.advance(5); }
  await s.time.advance(CURSOR_MS);
  assert.deepEqual(s.sent('team.board.cursor').map((call) => call.params), [
    { project_id: PROJECT, board_id: BOARD, x: 0, y: 0, selected: [] },
    { project_id: PROJECT, board_id: BOARD, x: 9, y: 18, selected: [NOTE1] },
  ]);
  // The trailing send went out only once CURSOR_MS had passed since the first.
  await s.time.advance(CURSOR_MS * 5);
  assert.equal(s.sent('team.board.cursor').length, 2);
  // After a quiet spell the next goes at once.
  s.client.cursor({ x: 50, y: 50, selected: [] });
  assert.equal(s.sent('team.board.cursor').length, 3);
  // A steady stream: one call per CURSOR_MS at most.
  for (let n = 0; n < 40; n += 1) { s.client.cursor({ x: n, y: 0, selected: [] }); await s.time.advance(10); }
  await s.time.advance(CURSOR_MS);
  assert.ok(s.sent('team.board.cursor').length <= 3 + 5, `sent ${s.sent('team.board.cursor').length}`);
  assert.ok(s.sent('team.board.cursor').length >= 3 + 4);
  assert.deepEqual(s.sent('team.board.cursor').at(-1).params.x, 39);
});

test('T4 client: a cursor is not sent offline or when malformed; a refused cursor makes the client view again', async () => {
  const s = setup();
  await s.client.start();
  s.flags.online = false;
  s.client.cursor({ x: 1, y: 1, selected: [] });
  await s.time.advance(CURSOR_MS * 3);
  assert.equal(s.sent('team.board.cursor').length, 0);
  s.flags.online = true;
  await s.time.advance(CURSOR_MS * 3);
  assert.equal(s.sent('team.board.cursor').length, 0, 'the position dropped while offline is not sent later');
  for (const bad of [null, undefined, 5, {}, { x: 1 }, { x: Number.NaN, y: 1 }, { x: 1, y: Infinity }, { x: '1', y: 1 },
    { x: 1, y: 1, selected: 'a' }, { x: 1, y: 1, selected: [3] }, { x: 1, y: 1, selected: Array.from({ length: 65 }, () => NOTE1) }]) {
    s.client.cursor(bad);
  }
  await s.time.advance(CURSOR_MS * 3);
  assert.equal(s.sent('team.board.cursor').length, 0);
  // A host that has forgotten the device: the client views again at once.
  const refused = setup({ script: (operation) => (operation === 'team.board.cursor'
    ? { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_board_not_viewing', retryable: false } } : undefined) });
  await refused.client.start();
  refused.client.cursor({ x: 1, y: 1, selected: [] });
  await refused.time.advance(1);
  assert.equal(refused.sent('team.board.view').length, 2);
});

test('T4 client: lock, renewal, a refused renewal, replacing a lock and unlock', async () => {
  const s = setup();
  await s.client.start();
  assert.deepEqual(await s.client.lock(NOTE1), { ok: true });
  assert.deepEqual(s.sent('team.board.lock').map((call) => call.params), [{ project_id: PROJECT, board_id: BOARD, card_id: NOTE1 }]);
  assert.equal(s.client.state().mine, NOTE1);
  assert.deepEqual(s.client.state().locks, [{ card_id: NOTE1, member_id: ME }]);
  // Renewed every LOCK_RENEW_MS.
  await s.time.advance(LOCK_RENEW_MS);
  assert.equal(s.sent('team.board.lock').length, 2);
  await s.time.advance(LOCK_RENEW_MS);
  assert.equal(s.sent('team.board.lock').length, 3);
  // Replacing: the second card is the held one, and renewals go to it.
  assert.deepEqual(await s.client.lock(NOTE2), { ok: true });
  assert.deepEqual([s.client.state().mine, s.client.state().locks], [NOTE2, [{ card_id: NOTE2, member_id: ME }]]);
  await s.time.advance(LOCK_RENEW_MS);
  assert.equal(s.sent('team.board.lock').at(-1).params.card_id, NOTE2);
  // Unlock releases and stops renewing.
  const before = s.sent('team.board.lock').length;
  assert.deepEqual(await s.client.unlock(), { ok: true });
  assert.deepEqual(s.sent('team.board.unlock').map((call) => call.params), [{ project_id: PROJECT, board_id: BOARD, card_id: NOTE2 }]);
  assert.deepEqual([s.client.state().mine, s.client.state().locks], [null, []]);
  await s.time.advance(LOCK_RENEW_MS * 3);
  assert.equal(s.sent('team.board.lock').length, before);
  assert.deepEqual(await s.client.unlock(), { ok: true });
  assert.equal(s.sent('team.board.unlock').length, 1, 'nothing to release');
});

test('T4 client: a release waits for a renewal that is on its way, and a waiting renewal does not take a released lock again (wave 10 review)', async () => {
  let held = null;
  const s = setup({ script: (operation) => (operation === 'team.board.lock' && held ? held.promise : undefined) });
  await s.client.start();
  assert.deepEqual(await s.client.lock(NOTE1), { ok: true });
  held = Promise.withResolvers();
  await s.time.advance(LOCK_RENEW_MS);
  assert.equal(s.sent('team.board.lock').length, 2, 'the renewal is on its way');
  const released = s.client.unlock();
  await s.time.advance(0);
  assert.equal(s.sent('team.board.unlock').length, 0, 'the release is not sent past the renewal');
  assert.equal(s.client.state().mine, null, 'the page sees the lock gone at once');
  held.resolve({ ok: true });
  held = null;
  assert.deepEqual(await released, { ok: true });
  const order = s.calls.map((call) => call.operation).filter((operation) => operation !== 'team.board.view');
  assert.deepEqual(order, ['team.board.lock', 'team.board.lock', 'team.board.unlock']);
  // A renewal whose turn comes after the release renews nothing.
  assert.deepEqual(await s.client.lock(NOTE2), { ok: true });
  held = Promise.withResolvers();
  const taking = s.client.lock(NOTE1); // on its way, holding the line
  await s.time.advance(LOCK_RENEW_MS); // NOTE2's renewal waits behind it
  const gone = s.client.unlock();
  held.resolve({ ok: false, error: { reason: 'team_board_note_locked' }, held_by: 'member_bob' });
  held = null;
  await Promise.all([taking, gone]);
  await s.time.advance(0);
  assert.deepEqual(s.calls.map((call) => [call.operation, call.params.card_id]).filter(([operation]) => operation !== 'team.board.view').slice(3),
    [['team.board.lock', NOTE2], ['team.board.lock', NOTE1], ['team.board.unlock', NOTE2]], 'no renewal of a released lock');
  assert.equal(s.client.state().mine, null);
});

test('T4 client: a refused lock passes the refusal through and keeps the old lock; a refused renewal drops the lock and pushes', async () => {
  const state = { refuse: null };
  const s = setup({ script: (operation, params) => {
    if (operation !== 'team.board.lock') return undefined;
    return state.refuse?.(params) ?? undefined;
  } });
  await s.client.start();
  await s.client.lock(NOTE1);
  state.refuse = (params) => (params.card_id === NOTE2
    ? { ok: false, error: { code: 'CMP-HOST-0004', reason: 'team_board_note_locked', retryable: false }, held_by: AMY } : undefined);
  assert.deepEqual(await s.client.lock(NOTE2), { ok: false, error: { code: 'CMP-HOST-0004', reason: 'team_board_note_locked', retryable: false }, held_by: AMY });
  assert.equal(s.client.state().mine, NOTE1);
  assert.deepEqual(await s.client.lock('not a card'), { ok: false, error: { code: 'invalid_request', reason: 'team_board_card_invalid' } });
  // A renewal with no answer keeps the lock.
  s.flags.reject = true;
  await s.time.advance(LOCK_RENEW_MS);
  s.flags.reject = false;
  assert.equal(s.client.state().mine, NOTE1);
  // A refused renewal drops it and pushes.
  await s.time.advance(PUSH_MS);
  s.pushes.length = 0;
  state.refuse = () => ({ ok: false, error: { code: 'CMP-HOST-0004', reason: 'team_board_note_locked', retryable: false }, held_by: AMY });
  await s.time.advance(LOCK_RENEW_MS);
  assert.equal(s.client.state().mine, null);
  assert.deepEqual(s.client.state().locks, []);
  await s.time.advance(PUSH_MS);
  assert.deepEqual(s.pushes.map((push) => push.mine), [null]);
  const locks = s.sent('team.board.lock').length;
  await s.time.advance(LOCK_RENEW_MS * 3);
  assert.equal(s.sent('team.board.lock').length, locks, 'no more renewals');
  // A lock that is refused for the first card leaves nothing held.
  assert.equal((await s.client.lock(NOTE1)).ok, false);
  assert.equal(s.client.state().mine, null);
});

test('T4 client: reconnected views again at once and takes the held lock again', async () => {
  const s = setup();
  await s.client.start();
  await s.client.lock(NOTE1);
  const views = s.sent('team.board.view').length;
  const locks = s.sent('team.board.lock').length;
  s.client.reconnected();
  await s.time.advance(1);
  assert.equal(s.sent('team.board.view').length, views + 1);
  assert.equal(s.sent('team.board.lock').length, locks + 1);
  assert.equal(s.sent('team.board.lock').at(-1).params.card_id, NOTE1);
  assert.equal(s.client.state().mine, NOTE1);
  // The lock another member took meanwhile is lost for good.
  s.room.locks = [{ card_id: NOTE1, member_id: AMY }];
  const refuse = { ok: false, error: { code: 'CMP-HOST-0004', reason: 'team_board_note_locked', retryable: false }, held_by: AMY };
  const t = setup({ script: (operation) => (operation === 'team.board.lock' && t.calls.filter((c) => c.operation === 'team.board.lock').length > 1 ? refuse : undefined) });
  await t.client.start();
  await t.client.lock(NOTE1);
  t.client.reconnected();
  await t.time.advance(1);
  assert.equal(t.client.state().mine, null);
  // Without a lock, reconnecting only views; nothing happens after close.
  const u = setup();
  await u.client.start();
  u.client.reconnected();
  await u.time.advance(1);
  assert.equal(u.sent('team.board.lock').length, 0);
  assert.equal(u.sent('team.board.view').length, 2);
});

test('T4 client: events for another board or project and one\'s own cursor are ignored; a stale cursor disappears', async () => {
  const s = setup();
  await s.client.start();
  await s.time.advance(PUSH_MS);
  s.pushes.length = 0;
  s.client.onEvent({ event_type: 'team_board_cursor', project_id: PROJECT, board_id: 'board_00000000-0000-4000-8000-0000000000a9', member_id: AMY, x: 1, y: 2, selected: [] });
  s.client.onEvent({ event_type: 'team_board_cursor', project_id: 'project_beta', board_id: BOARD, member_id: AMY, x: 1, y: 2, selected: [] });
  s.client.onEvent({ event_type: 'team_board_changed', project_id: PROJECT, board_id: BOARD, rev: 3 });
  s.client.onEvent({ event_type: 'team_board_lock', project_id: 'project_beta', board_id: BOARD, card_id: NOTE1, member_id: AMY });
  s.client.onEvent(null); s.client.onEvent('x'); s.client.onEvent({});
  cursorEvent(s, ME);
  await s.time.advance(PUSH_MS * 2);
  assert.deepEqual([s.pushes, s.client.resources().cursors], [[], 0]);
  // Another member's cursor shows, is renewed by each update, and drops CURSOR_STALE_MS after the last one.
  cursorEvent(s, AMY, 10, 20, [NOTE1]);
  await s.time.advance(CURSOR_STALE_MS - 1);
  assert.deepEqual(s.client.state().cursors, [{ member_id: AMY, x: 10, y: 20, selected: [NOTE1] }]);
  cursorEvent(s, AMY, 11, 21, []);
  await s.time.advance(CURSOR_STALE_MS - 1);
  assert.deepEqual(s.client.state().cursors, [{ member_id: AMY, x: 11, y: 21, selected: [] }]);
  s.pushes.length = 0;
  await s.time.advance(1);
  assert.deepEqual(s.client.state().cursors, []);
  await s.time.advance(PUSH_MS);
  assert.deepEqual(s.pushes.map((push) => push.cursors), [[]]);
  assert.equal(s.client.resources().cursors, 0);
  // A member who leaves the viewers loses the cursor at once.
  cursorEvent(s, BEN);
  s.event('team_board_viewers', { viewers: [ME, AMY] });
  assert.deepEqual(s.client.state().cursors, []);
  assert.deepEqual(s.client.state().viewers, [AMY, ME]);
});

test('T4 client: lock and viewer events change the state; another member taking my note drops it', async () => {
  const s = setup();
  await s.client.start();
  s.event('team_board_lock', { card_id: NOTE1, member_id: AMY });
  s.event('team_board_lock', { card_id: NOTE2, member_id: BEN });
  assert.deepEqual(s.client.state().locks, [{ card_id: NOTE1, member_id: AMY }, { card_id: NOTE2, member_id: BEN }]);
  s.event('team_board_lock', { card_id: NOTE1, member_id: null });
  assert.deepEqual(s.client.state().locks, [{ card_id: NOTE2, member_id: BEN }]);
  await s.client.lock(NOTE1);
  assert.equal(s.client.state().mine, NOTE1);
  s.event('team_board_lock', { card_id: NOTE1, member_id: AMY });
  assert.equal(s.client.state().mine, null);
  const renewals = s.sent('team.board.lock').length;
  await s.time.advance(LOCK_RENEW_MS + PUSH_MS);
  assert.equal(s.sent('team.board.lock').length, renewals);
  assert.deepEqual(s.client.resources(), { timers: 1, cursors: 0, locks: 2 });
});

test('T4 client: values from the host that are not the expected shape are dropped and never pushed', async () => {
  const s = setup();
  await s.client.start();
  await s.time.advance(PUSH_MS);
  s.pushes.length = 0;
  const before = JSON.stringify(s.client.state());
  const bad = [
    ['team_board_viewers', { viewers: 'x' }], ['team_board_viewers', { viewers: [7] }], ['team_board_viewers', { viewers: [ME, null] }],
    ['team_board_viewers', { viewers: ['alice'] }], ['team_board_viewers', {}],
    ['team_board_viewers', { viewers: Array.from({ length: 65 }, (_, n) => `member_${n}`) }],
    ['team_board_cursor', { member_id: AMY, x: Number.NaN, y: 1, selected: [] }], ['team_board_cursor', { member_id: AMY, x: 1, selected: [] }],
    ['team_board_cursor', { member_id: AMY, x: '1', y: 1, selected: [] }], ['team_board_cursor', { member_id: AMY, x: 1, y: Infinity, selected: [] }],
    ['team_board_cursor', { member_id: 5, x: 1, y: 1, selected: [] }], ['team_board_cursor', { member_id: 'amy', x: 1, y: 1, selected: [] }],
    ['team_board_cursor', { member_id: AMY, x: 1, y: 1, selected: 'a' }], ['team_board_cursor', { member_id: AMY, x: 1, y: 1, selected: [1] }],
    ['team_board_cursor', { member_id: AMY, x: 1, y: 1, selected: Array.from({ length: 65 }, () => NOTE1) }],
    ['team_board_lock', { card_id: 'x', member_id: AMY }], ['team_board_lock', { card_id: NOTE1, member_id: 'amy' }],
    ['team_board_lock', { card_id: NOTE1, member_id: 5 }], ['team_board_lock', { card_id: NOTE1 }], ['team_board_lock', { member_id: AMY }],
  ];
  for (const [type, fields] of bad) s.event(type, fields);
  await s.time.advance(PUSH_MS * 3);
  assert.equal(JSON.stringify(s.client.state()), before);
  assert.deepEqual(s.pushes, []);
  // The same goes for a malformed answer to a view: its good fields are used, its bad ones are not.
  s.room.viewers = ['nope', AMY];
  s.room.locks = [{ card_id: 'x', member_id: AMY }, { card_id: NOTE1, member_id: BEN }, 'junk', null];
  s.client.reconnected();
  await s.time.advance(PUSH_MS);
  assert.deepEqual(s.client.state().viewers, [ME], 'a viewers list with a bad member is dropped whole');
  assert.deepEqual(s.client.state().locks, [{ card_id: NOTE1, member_id: BEN }]);
  // Retained values are bounded.
  for (let n = 0; n < 100; n += 1) cursorEvent(s, `member_${n}`);
  for (let n = 0; n < 100; n += 1) s.event('team_board_lock', { card_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, member_id: AMY });
  assert.ok(s.client.resources().cursors <= 32 && s.client.resources().locks <= 64, JSON.stringify(s.client.resources()));
});

test('T4 client: pushes are coalesced to one every PUSH_MS and skipped when nothing changed', async () => {
  const s = setup();
  s.room.viewers = [ME, AMY];
  await s.client.start();
  await s.time.advance(PUSH_MS);
  s.pushes.length = 0;
  for (let n = 0; n < 20; n += 1) cursorEvent(s, AMY, n, n);
  s.event('team_board_lock', { card_id: NOTE1, member_id: AMY });
  await s.time.advance(PUSH_MS - 1);
  assert.equal(s.pushes.length, 0, 'held back inside the window');
  await s.time.advance(1);
  assert.equal(s.pushes.length, 1);
  assert.deepEqual(s.pushes[0], { kind: 'presence', viewers: [AMY, ME], cursors: [{ member_id: AMY, x: 19, y: 19, selected: [] }],
    locks: [{ card_id: NOTE1, member_id: AMY }], mine: null });
  // Changes in the next window give one more; the same values again give none.
  cursorEvent(s, AMY, 19, 19);
  s.event('team_board_lock', { card_id: NOTE1, member_id: AMY });
  s.event('team_board_viewers', { viewers: [ME, AMY] });
  await s.time.advance(PUSH_MS * 4);
  assert.equal(s.pushes.length, 1);
  cursorEvent(s, AMY, 20, 19);
  cursorEvent(s, AMY, 21, 19);
  await s.time.advance(PUSH_MS);
  assert.equal(s.pushes.length, 2);
  // A push that throws is lost, not fatal.
  const loud = setup();
  const quiet = createBoardPresenceClient({ projectId: PROJECT, boardId: BOARD, send: async () => ({ ok: true, viewers: [ME], locks: [] }),
    self: () => ME, push: () => { throw new Error('page gone'); }, clock: loud.time.clock, timers: loud.time.timers });
  await quiet.start();
  await loud.time.advance(PUSH_MS * 2);
  quiet.close();
});

test('T4 client: close sends one leave, clears every timer, pushes nothing more and makes later calls no-ops', async () => {
  const s = setup();
  await s.client.start();
  await s.client.lock(NOTE1);
  cursorEvent(s, AMY);
  s.client.cursor({ x: 1, y: 1, selected: [] });
  s.client.cursor({ x: 2, y: 2, selected: [] });
  assert.ok(s.client.resources().timers >= 4, 'heartbeat, renewal, trailing cursor, stale cursor and push are pending');
  s.client.close();
  s.client.close();
  assert.equal(s.client.resources().timers, 0);
  assert.equal(s.time.size(), 0);
  assert.deepEqual(s.sent('team.board.leave').map((call) => call.params), [{ project_id: PROJECT, board_id: BOARD }]);
  const calls = s.calls.length;
  const pushes = s.pushes.length;
  cursorEvent(s, BEN);
  s.event('team_board_lock', { card_id: NOTE2, member_id: BEN });
  s.client.cursor({ x: 3, y: 3, selected: [] });
  s.client.reconnected();
  s.client.start();
  assert.deepEqual(await s.client.lock(NOTE2), { ok: false, error: { code: 'invalid_request', reason: 'team_board_presence_closed' } });
  assert.deepEqual(await s.client.unlock(), { ok: true });
  await s.time.advance(HEARTBEAT_MS * 4);
  assert.equal(s.calls.length, calls);
  assert.equal(s.pushes.length, pushes);
  assert.equal(s.client.resources().timers, 0);
  // A close with a view still in flight does not leave a timer behind when it answers.
  const late = setup();
  let release;
  late.flags.hang = { promise: new Promise((resolve) => { release = resolve; }) };
  const starting = late.client.start();
  late.client.close();
  release({ ok: true, viewers: [ME, AMY], locks: [] });
  await starting;
  await late.time.advance(HEARTBEAT_MS * 2);
  assert.equal(late.time.size(), 0);
  assert.deepEqual(late.pushes, []);
  // A leave that is rejected is not an unhandled rejection.
  const rude = setup();
  await rude.client.start();
  rude.flags.reject = true;
  rude.client.close();
  await tick();
});
