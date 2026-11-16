'use strict';

// new-test-file: row 151 slice T4 adds board presence on the team host (server/team/boards/board-presence.js and
// board-presence-ops.js), a new surface; no existing test file covers viewers, cursors or note locks.
//
// Everything runs on fakes: a fake clock, a recording publish, a fake board store and a fake member directory.
// The store is tested through its own functions, the operations through `run` as the board commands will call it.

const assert = require('node:assert/strict');
const test = require('node:test');

const { PRESENCE_LIMITS, createBoardPresence } = require('../../server/team/boards/board-presence');
const {
  CURSOR_EVENT, LOCK_EVENT, VIEWERS_EVENT, createPresenceOperations,
} = require('../../server/team/boards/board-presence-ops');
const { createViewers } = require('../../server/team/viewers');
const { hostFailure } = require('../../server/api-contract');
const { createClock } = require('./helpers/clock');

const P1 = 'project_alpha';
const P2 = 'project_beta';
const B1 = 'board_00000000-0000-4000-8000-0000000000a1';
const B2 = 'board_00000000-0000-4000-8000-0000000000a2';
const B3 = 'board_00000000-0000-4000-8000-0000000000a3';
const NOTE1 = '00000000-0000-4000-8000-0000000000c1';
const NOTE2 = '00000000-0000-4000-8000-0000000000c2';
const NOTE3 = '00000000-0000-4000-8000-0000000000c3';
const FILE1 = '00000000-0000-4000-8000-0000000000f1';
const ALICE = 'member_alice';
const BOB = 'member_bob';
const CARL = 'member_carl';
const OUTSIDER = 'member_outsider';
const D_A1 = 'device_alice1';
const D_A2 = 'device_alice2';
const D_B = 'device_bob1';
const D_C = 'device_carl1';
const TTL = 45_000;

const view = (presence, boardId, deviceId, memberId, projectId = P1) => presence.view({ projectId, boardId, deviceId, memberId });
const lockOf = (presence, boardId, cardId, deviceId, memberId) => presence.lock({ boardId, cardId, deviceId, memberId });
const sorted = (list) => [...list].sort();
// ---------------------------------------------------------------- the store

test('T4 store: a view starts, renews and expires by the viewer store\'s rule; changed is true only for a changed member list', () => {
  const clock = createClock();
  const presence = createBoardPresence({ clock });
  assert.deepEqual(view(presence, B1, D_A1, ALICE), { ok: true, changed: true });
  assert.equal(presence.isViewing(B1, D_A1), true);
  assert.deepEqual(presence.viewersOf(B1), [ALICE]);
  // A second device of the same member and a renewal change nobody.
  assert.deepEqual(view(presence, B1, D_A2, ALICE), { ok: true, changed: false });
  assert.deepEqual(view(presence, B1, D_A1, ALICE), { ok: true, changed: false });
  assert.deepEqual(view(presence, B1, D_B, BOB), { ok: true, changed: true });
  assert.deepEqual(presence.viewersOf(B1), [ALICE, BOB]);
  // Bob stops renewing: after the TTL his record is gone and the next call that looks reports the change.
  clock.advance(TTL - 1);
  assert.equal(presence.isViewing(B1, D_B), true);
  view(presence, B1, D_A1, ALICE);
  clock.advance(2);
  assert.equal(presence.isViewing(B1, D_B), false);
  assert.deepEqual(presence.viewersOf(B1), [ALICE]);
  assert.deepEqual(view(presence, B1, D_A1, ALICE), { ok: true, changed: true });
  // A board no one has viewed has no viewers; a board viewed under one project is not viewed under another.
  assert.deepEqual(presence.viewersOf(B2), []);
  assert.equal(presence.isViewing(B2, D_A1), false);
  assert.equal(presence.isViewing(B1, D_C), false);
});

test('T4 store: a board tracked under one project is refused under another; the BOARDS cap; a malformed id is never stored', () => {
  const clock = createClock();
  const presence = createBoardPresence({ clock, limits: { BOARDS: 2 } });
  assert.equal(view(presence, B1, D_A1, ALICE).ok, true);
  assert.deepEqual(view(presence, B1, D_B, BOB, P2), { ok: false });
  assert.equal(presence.isViewing(B1, D_B), false);
  assert.equal(presence.projectOf(B1), P1);
  assert.equal(view(presence, B2, D_A1, ALICE, P2).ok, true);
  // The third board is refused; a viewer of a tracked board still gets in.
  assert.deepEqual(view(presence, B3, D_A1, ALICE), { ok: false });
  assert.equal(presence.resources().boards, 2);
  assert.equal(view(presence, B1, D_B, BOB).ok, true);
  // Once a tracked board has no live viewer it makes room.
  clock.advance(TTL + 1);
  assert.equal(view(presence, B3, D_C, CARL).ok, true);
  assert.deepEqual(presence.resources(), { boards: 1, viewers: 1, locks: 0 });

  const bad = createBoardPresence({ clock });
  for (const args of [
    { projectId: 'proj', boardId: B1, deviceId: D_A1, memberId: ALICE },
    { projectId: P1, boardId: 'board_x', deviceId: D_A1, memberId: ALICE },
    { projectId: P1, boardId: B1, deviceId: 'dev', memberId: ALICE },
    { projectId: P1, boardId: B1, deviceId: D_A1, memberId: 'alice' },
    { projectId: P1, boardId: B1, deviceId: D_A1, memberId: 7 },
    null, undefined, {},
  ]) assert.deepEqual(bad.view(args), { ok: false });
  assert.deepEqual(bad.resources(), { boards: 0, viewers: 0, locks: 0 });
  assert.deepEqual(bad.leave({ boardId: 'nope', deviceId: D_A1 }), { changed: false, projectId: null, unlocked: [] });
  assert.deepEqual(bad.lock({ boardId: B1, cardId: 'x', deviceId: D_A1, memberId: ALICE }), { ok: false, reason: 'invalid', held_by: null });
  assert.equal(bad.lockHolder(B1, 'x'), null);
  assert.deepEqual(bad.locksOf('nope'), []);
  assert.deepEqual(bad.expire(), []);
  assert.deepEqual(bad.dropDevice('x'), []);
  assert.deepEqual(bad.dropWhere('not a function'), []);
});

test('T4 store: limits may only be lowered', () => {
  assert.deepEqual({ ...PRESENCE_LIMITS }, { LOCK_MS: 30_000, LOCKS_PER_BOARD: 64, BOARDS: 256 });
  assert.equal(Object.isFrozen(PRESENCE_LIMITS), true);
  assert.equal(Object.isFrozen(createBoardPresence()), true);
  for (const limits of [{ LOCK_MS: 30_001 }, { BOARDS: 0 }, { BOARDS: 1.5 }, { LOCKS_PER_BOARD: '3' }, { OTHER: 1 }]) {
    assert.throws(() => createBoardPresence({ limits }), RangeError, JSON.stringify(limits));
  }
  assert.doesNotThrow(() => createBoardPresence({ limits: { LOCK_MS: 30_000, LOCKS_PER_BOARD: 1, BOARDS: 1 } }));
  // The default viewer store and clock work without arguments.
  const presence = createBoardPresence();
  assert.equal(view(presence, B1, D_A1, ALICE).ok, true);
});

test('T4 store: a lock needs a viewing device; a second member is refused with the holder; the same member takes it over', () => {
  const clock = createClock();
  const presence = createBoardPresence({ clock });
  assert.deepEqual(lockOf(presence, B1, NOTE1, D_A1, ALICE), { ok: false, reason: 'not_viewing', held_by: null });
  view(presence, B1, D_A1, ALICE);
  // A device that never viewed the (tracked) board cannot lock.
  assert.deepEqual(lockOf(presence, B1, NOTE1, D_C, CARL), { ok: false, reason: 'not_viewing', held_by: null });
  view(presence, B1, D_A2, ALICE);
  view(presence, B1, D_B, BOB);
  assert.deepEqual(lockOf(presence, B1, NOTE1, D_A1, ALICE), { ok: true, changed: true, released: null });
  assert.equal(presence.lockHolder(B1, NOTE1), ALICE);
  assert.deepEqual(lockOf(presence, B1, NOTE1, D_B, BOB), { ok: false, reason: 'held', held_by: ALICE });
  // A refused call changes nothing (the device keeps the lock it had).
  assert.deepEqual(lockOf(presence, B1, NOTE2, D_B, BOB), { ok: true, changed: true, released: null });
  assert.deepEqual(lockOf(presence, B1, NOTE1, D_B, BOB), { ok: false, reason: 'held', held_by: ALICE });
  assert.equal(presence.lockHolder(B1, NOTE2), BOB);
  // The same member on another device takes the lease over; the old device no longer holds it.
  assert.deepEqual(lockOf(presence, B1, NOTE1, D_A2, ALICE), { ok: true, changed: false, released: null });
  assert.deepEqual(presence.unlock({ boardId: B1, cardId: NOTE1, deviceId: D_A1 }), { changed: false });
  assert.equal(presence.lockHolder(B1, NOTE1), ALICE);
  assert.deepEqual(presence.unlock({ boardId: B1, cardId: NOTE1, deviceId: D_A2 }), { changed: true });
  assert.equal(presence.lockHolder(B1, NOTE1), null);
  assert.deepEqual(presence.locksOf(B1), [{ card_id: NOTE2, member_id: BOB }]);
  assert.deepEqual(lockOf(presence, B1, NOTE1, D_B, BOB), { ok: true, changed: true, released: NOTE2 });
  assert.deepEqual(presence.locksOf(B1), [{ card_id: NOTE1, member_id: BOB }]);
});

test('T4 store: a lease lasts LOCK_MS from its last renewal; one lock a device a board; the LOCKS_PER_BOARD cap', () => {
  const clock = createClock();
  const presence = createBoardPresence({ clock, limits: { LOCKS_PER_BOARD: 2 } });
  view(presence, B1, D_A1, ALICE);
  view(presence, B1, D_B, BOB);
  view(presence, B1, D_C, CARL);
  lockOf(presence, B1, NOTE1, D_A1, ALICE);
  clock.advance(PRESENCE_LIMITS.LOCK_MS - 1);
  // A renewal restarts the lease and reports nothing new.
  assert.deepEqual(lockOf(presence, B1, NOTE1, D_A1, ALICE), { ok: true, changed: false, released: null });
  for (let beat = 0; beat < 3; beat += 1) { clock.advance(14_000); view(presence, B1, D_A1, ALICE); view(presence, B1, D_B, BOB); view(presence, B1, D_C, CARL); }
  assert.equal(presence.lockHolder(B1, NOTE1), null, 'expired 30 s after the renewal');
  assert.deepEqual(lockOf(presence, B1, NOTE1, D_B, BOB), { ok: true, changed: true, released: null });
  // The cap: two live leases, a third device's lock is refused, then fits once one expires.
  assert.deepEqual(lockOf(presence, B1, NOTE2, D_A1, ALICE), { ok: true, changed: true, released: null });
  assert.deepEqual(lockOf(presence, B1, NOTE3, D_C, CARL), { ok: false, reason: 'limit', held_by: null });
  // A device that already holds one may move it at the cap.
  assert.deepEqual(lockOf(presence, B1, NOTE3, D_A1, ALICE), { ok: true, changed: true, released: NOTE2 });
  clock.advance(20_000);
  view(presence, B1, D_B, BOB); view(presence, B1, D_C, CARL); view(presence, B1, D_A1, ALICE);
  lockOf(presence, B1, NOTE3, D_A1, ALICE);
  clock.advance(11_000);
  view(presence, B1, D_B, BOB); view(presence, B1, D_C, CARL); view(presence, B1, D_A1, ALICE);
  assert.deepEqual(presence.locksOf(B1), [{ card_id: NOTE3, member_id: ALICE }]);
  assert.deepEqual(lockOf(presence, B1, NOTE1, D_C, CARL), { ok: true, changed: true, released: null });
  assert.deepEqual(presence.locksOf(B1), [{ card_id: NOTE1, member_id: CARL }, { card_id: NOTE3, member_id: ALICE }]);
  assert.deepEqual(presence.resources(), { boards: 1, viewers: 3, locks: 2 });
  // A malformed card id is never stored.
  assert.equal(lockOf(presence, B1, 'not-a-card', D_C, CARL).ok, false);
  assert.equal(presence.resources().locks, 2);
});

test('T4 store: a lease whose device stopped viewing is not live, and the next expire reports it', () => {
  const clock = createClock();
  const viewers = createViewers({ clock });
  const presence = createBoardPresence({ clock, viewers });
  view(presence, B1, D_A1, ALICE);
  view(presence, B1, D_B, BOB);
  lockOf(presence, B1, NOTE1, D_A1, ALICE);
  // The viewer store drops the device's oldest record when a 33rd starts (here: B1 is the oldest of Alice's).
  for (let n = 0; n < 32; n += 1) {
    const id = `board_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    assert.equal(view(presence, id, D_A1, ALICE).ok, true);
    clock.advance(1);
  }
  assert.equal(presence.isViewing(B1, D_A1), false);
  assert.equal(presence.lockHolder(B1, NOTE1), null);
  assert.deepEqual(presence.locksOf(B1), []);
  assert.deepEqual(lockOf(presence, B1, NOTE1, D_B, BOB), { ok: true, changed: true, released: null });
  // Alice's silent drop is still reported: B1's last reported member list was [alice, bob].
  const changes = presence.expire();
  const b1 = changes.find((change) => change.boardId === B1);
  assert.deepEqual(b1, { projectId: P1, boardId: B1, viewers: true, unlocked: [] });
  assert.deepEqual(presence.expire().find((change) => change.boardId === B1), undefined);
});

test('T4 store: leave, dropDevice, dropBoard, dropProject, dropWhere and expire release the right locks and return the changes', () => {
  const clock = createClock();
  const presence = createBoardPresence({ clock });
  const seat = () => {
    view(presence, B1, D_A1, ALICE); view(presence, B1, D_B, BOB);
    view(presence, B2, D_A1, ALICE); view(presence, B3, D_C, CARL, P2); view(presence, B3, D_A2, ALICE, P2);
    lockOf(presence, B1, NOTE1, D_A1, ALICE); lockOf(presence, B1, NOTE2, D_B, BOB);
    lockOf(presence, B2, NOTE3, D_A1, ALICE); lockOf(presence, B3, NOTE1, D_C, CARL);
  };
  seat();
  // leave: Bob's record and his lock go; Alice's stay.
  assert.deepEqual(presence.leave({ boardId: B1, deviceId: D_B }), { changed: true, projectId: P1, unlocked: [NOTE2] });
  assert.deepEqual(presence.viewersOf(B1), [ALICE]);
  assert.deepEqual(presence.locksOf(B1), [{ card_id: NOTE1, member_id: ALICE }]);
  assert.deepEqual(presence.leave({ boardId: B1, deviceId: D_B }), { changed: false, projectId: P1, unlocked: [] });
  // A second device of a member leaving does not change the list.
  view(presence, B1, D_A2, ALICE);
  assert.deepEqual(presence.leave({ boardId: B1, deviceId: D_A2 }), { changed: false, projectId: P1, unlocked: [] });
  // The last viewer leaving untracks the board.
  assert.deepEqual(presence.leave({ boardId: B1, deviceId: D_A1 }), { changed: true, projectId: P1, unlocked: [NOTE1] });
  assert.equal(presence.projectOf(B1), null);
  assert.deepEqual(presence.leave({ boardId: B1, deviceId: D_A1 }), { changed: false, projectId: null, unlocked: [] });

  // dropDevice: Alice's first device is on B2 (and B1 again).
  view(presence, B1, D_A1, ALICE); lockOf(presence, B1, NOTE1, D_A1, ALICE);
  const gone = presence.dropDevice(D_A1);
  assert.deepEqual(sorted(gone.map((change) => change.boardId)), [B1, B2]);
  assert.deepEqual(gone.find((change) => change.boardId === B1), { projectId: P1, boardId: B1, viewers: true, unlocked: [NOTE1] });
  assert.deepEqual(gone.find((change) => change.boardId === B2), { projectId: P1, boardId: B2, viewers: true, unlocked: [NOTE3] });
  assert.deepEqual(presence.dropDevice(D_A1), []);

  presence.dropProject(P2);
  seat();
  // dropBoard.
  assert.deepEqual(presence.dropBoard(B1), [{ projectId: P1, boardId: B1, viewers: true, unlocked: [NOTE1, NOTE2] }]);
  assert.deepEqual(presence.dropBoard(B1), []);
  assert.deepEqual(presence.dropBoard('nope'), []);
  // dropProject: P2's board B3 has Carl and Alice's second device.
  assert.deepEqual(presence.dropProject(P2), [{ projectId: P2, boardId: B3, viewers: true, unlocked: [NOTE1] }]);
  assert.deepEqual(presence.resources(), { boards: 1, viewers: 1, locks: 1 });
  assert.deepEqual(presence.dropProject(P2), []);

  // dropWhere sees { projectId, boardId, deviceId, memberId } per record and drops the ones it picks.
  seat();
  const seen = [];
  const dropped = presence.dropWhere((record) => { seen.push(record); return record.memberId === BOB; });
  assert.ok(seen.length >= 5 && seen.every((record) => Object.keys(record).sort().join() === 'boardId,deviceId,memberId,projectId'));
  assert.deepEqual(seen.find((record) => record.deviceId === D_B), { projectId: P1, boardId: B1, deviceId: D_B, memberId: BOB });
  assert.deepEqual(dropped, [{ projectId: P1, boardId: B1, viewers: true, unlocked: [NOTE2] }]);
  assert.deepEqual(presence.dropWhere(() => false), []);

  // expire: a record that stops renewing is announced as gone; a lease that runs out is announced as released.
  clock.advance(PRESENCE_LIMITS.LOCK_MS + 1);
  view(presence, B2, D_A1, ALICE);
  clock.advance(TTL - PRESENCE_LIMITS.LOCK_MS);
  view(presence, B2, D_A1, ALICE); view(presence, B3, D_C, CARL, P2); view(presence, B3, D_A2, ALICE, P2);
  const expired = presence.expire();
  assert.deepEqual(sorted(expired.map((change) => change.boardId)), [B1, B2, B3]);
  assert.deepEqual(expired.find((change) => change.boardId === B1), { projectId: P1, boardId: B1, viewers: true, unlocked: [NOTE1] });
  assert.deepEqual(expired.find((change) => change.boardId === B2), { projectId: P1, boardId: B2, viewers: false, unlocked: [NOTE3] });
  assert.deepEqual(expired.find((change) => change.boardId === B3), { projectId: P2, boardId: B3, viewers: false, unlocked: [NOTE1] });
  assert.deepEqual(presence.expire(), []);
  // Everything leaves the store once nobody views.
  clock.advance(TTL + 1);
  presence.expire();
  assert.deepEqual(presence.resources(), { boards: 0, viewers: 0, locks: 0 });
});

test('T4 store: a lease that is met expired is still announced by the next expire', () => {
  const clock = createClock();
  const presence = createBoardPresence({ clock });
  view(presence, B1, D_A1, ALICE);
  lockOf(presence, B1, NOTE1, D_A1, ALICE);
  clock.advance(PRESENCE_LIMITS.LOCK_MS);
  assert.equal(presence.lockHolder(B1, NOTE1), null, 'met and pruned');
  assert.deepEqual(presence.expire(), [{ projectId: P1, boardId: B1, viewers: false, unlocked: [NOTE1] }]);
  // A lease taken again by someone else is not reported as released.
  view(presence, B1, D_B, BOB);
  lockOf(presence, B1, NOTE2, D_B, BOB);
  clock.advance(PRESENCE_LIMITS.LOCK_MS);
  assert.equal(presence.lockHolder(B1, NOTE2), null);
  view(presence, B1, D_A1, ALICE);
  view(presence, B1, D_B, BOB);
  lockOf(presence, B1, NOTE2, D_A1, ALICE);
  assert.deepEqual(presence.expire(), []);
});

// ---------------------------------------------------------------- the operations

function directoryOf(roles) {
  return {
    activeMemberIds: () => Object.keys(roles),
    memberActor: (memberId) => (roles[memberId] ? { member_id: memberId, state: 'active', role: 'member' } : null),
    projectRole: (memberId, projectId) => roles[memberId]?.[projectId] ?? null,
  };
}

function fakeBoardStore() {
  const live = new Map([[`${P1}|${B1}`, { [NOTE1]: 'note', [NOTE2]: 'note', [NOTE3]: 'note', [FILE1]: 'file' }],
    [`${P2}|${B3}`, { [NOTE1]: 'note' }]]);
  const readOnly = new Set([`${P1}|${B2}`]);
  const store = {
    calls: 0, throwing: false, live,
    async get({ projectId, boardId }) {
      store.calls += 1;
      if (store.throwing) throw new Error('disk gone');
      const key = `${projectId}|${boardId}`;
      if (readOnly.has(key)) return { ok: true, board: null, rev: 3, read_only: true, reason: 'board_unreadable' };
      if (!live.has(key)) return hostFailure('invalid', 'team_board_not_found');
      const cards = Object.entries(live.get(key)).map(([id, kind]) => ({ id, kind }));
      return { ok: true, board: { id: boardId, cards: Object.fromEntries(cards.map((card) => [card.id, card])) }, rev: 5, read_only: false };
    },
  };
  return store;
}

function world(options = {}) {
  const clock = createClock();
  const presence = createBoardPresence({ clock, ...options.presence });
  const boards = fakeBoardStore();
  const published = [];
  const logs = [];
  const state = { throwing: false };
  const publish = (type, payload, opts) => {
    if (state.throwing) throw new Error('transport down');
    published.push({ type, payload, opts });
  };
  const directory = options.directory ?? directoryOf({ [ALICE]: { [P1]: 'admin', [P2]: 'writer' }, [BOB]: { [P1]: 'writer' }, [CARL]: { [P1]: 'reader' }, [OUTSIDER]: {} });
  const ops = createPresenceOperations({ presence, publish, directory, logger: (...args) => logs.push(args) });
  const who = { alice: [ALICE, D_A1], alice2: [ALICE, D_A2], bob: [BOB, D_B], carl: [CARL, D_C] };
  const run = (name, member, params) => ops.operations[name].run({ boards, params, actor: who[member][0], deviceId: who[member][1] });
  const base = (extra = {}) => ({ project_id: P1, board_id: B1, ...extra });
  return { clock, presence, boards, published, logs, state, ops, run, base, who, directory };
}

const types = (w) => w.published.map((entry) => entry.type);
test('T4 ops: the operations table', () => {
  const w = world();
  assert.deepEqual(Object.keys(w.ops.operations).sort(), ['team.board.cursor', 'team.board.leave', 'team.board.lock', 'team.board.unlock', 'team.board.view']);
  assert.deepEqual(Object.fromEntries(Object.entries(w.ops.operations).map(([name, entry]) => [name, entry.limit])), {
    'team.board.view': 'presence', 'team.board.leave': 'presence', 'team.board.cursor': 'cursor',
    'team.board.lock': 'presence', 'team.board.unlock': 'presence',
  });
  assert.equal(Object.isFrozen(w.ops) && Object.isFrozen(w.ops.operations), true);
  assert.deepEqual([VIEWERS_EVENT, CURSOR_EVENT, LOCK_EVENT], ['team_board_viewers', 'team_board_cursor', 'team_board_lock']);
  for (const args of [{ publish: () => {}, directory: {} }, { presence: w.presence, directory: {} }, { presence: w.presence, publish: () => {} }, undefined]) {
    assert.throws(() => createPresenceOperations(args), TypeError);
  }
});

test('T4 ops: view answers the viewers, the locks and lock_ms, and announces only a changed list', async () => {
  const w = world();
  assert.deepEqual(await w.run('team.board.view', 'alice', w.base()), { ok: true, viewers: [ALICE], locks: [], lock_ms: PRESENCE_LIMITS.LOCK_MS });
  assert.deepEqual(w.published.map((entry) => [entry.type, entry.payload]), [[VIEWERS_EVENT, { project_id: P1, board_id: B1, viewers: [ALICE] }]]);
  // A renewal and a second device of Alice say nothing; Bob's arrival does.
  await w.run('team.board.view', 'alice', w.base());
  await w.run('team.board.view', 'alice2', w.base());
  assert.equal(w.published.length, 1);
  const answer = await w.run('team.board.view', 'bob', w.base());
  assert.deepEqual(answer.viewers, [ALICE, BOB]);
  assert.deepEqual(w.published[1].payload.viewers, [ALICE, BOB]);
  // The answer carries the current locks.
  await w.run('team.board.lock', 'bob', w.base({ card_id: NOTE1 }));
  assert.deepEqual((await w.run('team.board.view', 'alice', w.base())).locks, [{ card_id: NOTE1, member_id: BOB }]);
  // A read-only board can be viewed.
  assert.equal((await w.run('team.board.view', 'alice', { project_id: P1, board_id: B2 })).ok, true);
});

test('T4 ops: a board of another project, a missing board and a failing store are not viewable', async () => {
  const w = world();
  const missing = await w.run('team.board.view', 'alice', { project_id: P2, board_id: B1 });
  assert.deepEqual(missing, hostFailure('invalid', 'team_board_not_found'), 'the store\'s own refusal passes through');
  assert.equal(w.presence.isViewing(B1, D_A1), false);
  assert.deepEqual(w.published, []);
  w.boards.throwing = true;
  for (const name of ['team.board.view', 'team.board.lock']) {
    assert.deepEqual(await w.run(name, 'alice', w.base({ card_id: NOTE1 })), hostFailure('unavailable', 'team_board_unavailable', '', true), name);
  }
  assert.deepEqual(w.published, []);
  // A store answering nonsense reads as unavailable.
  w.boards.get = async () => null;
  assert.deepEqual((await w.run('team.board.view', 'alice', w.base())).error.reason, 'team_board_unavailable');
});

test('T4 ops: a view the store cannot take answers the presence limit', async () => {
  const w = world({ presence: { limits: { BOARDS: 1 } } });
  w.boards.live.set(`${P1}|${B3}`, {});
  assert.equal((await w.run('team.board.view', 'alice', w.base())).ok, true);
  assert.deepEqual(await w.run('team.board.view', 'alice', { project_id: P1, board_id: B3 }), hostFailure('limit', 'team_board_presence_limit'));
  // The same board id found under the other project is refused by the store as well.
  w.boards.live.set(`${P2}|${B1}`, {});
  assert.deepEqual(await w.run('team.board.view', 'bob', { project_id: P2, board_id: B1 }), hostFailure('limit', 'team_board_presence_limit'));
});

test('T4 ops: leave answers ok, releases the device\'s lock and announces both, and never reads the board', async () => {
  const w = world();
  await w.run('team.board.view', 'alice', w.base());
  await w.run('team.board.view', 'bob', w.base());
  await w.run('team.board.lock', 'bob', w.base({ card_id: NOTE2 }));
  w.published.length = 0;
  const reads = w.boards.calls;
  assert.deepEqual(await w.run('team.board.leave', 'bob', w.base()), { ok: true });
  assert.equal(w.boards.calls, reads);
  assert.deepEqual(w.published.map((entry) => [entry.type, entry.payload]), [
    [VIEWERS_EVENT, { project_id: P1, board_id: B1, viewers: [ALICE] }],
    [LOCK_EVENT, { project_id: P1, board_id: B1, card_id: NOTE2, member_id: null }],
  ]);
  // A leave that changes nothing, and one for a board never viewed, still answer ok and say nothing.
  w.published.length = 0;
  assert.deepEqual(await w.run('team.board.leave', 'bob', w.base()), { ok: true });
  assert.deepEqual(await w.run('team.board.leave', 'bob', { project_id: P2, board_id: B3 }), { ok: true });
  assert.deepEqual(w.published, []);
});

test('T4 ops: a cursor needs a viewing device on the project the board is tracked under, stores nothing and reads nothing', async () => {
  const w = world();
  const refusal = hostFailure('forbidden', 'team_board_not_viewing');
  const cursor = (member, extra = {}) => w.run('team.board.cursor', member, w.base({ x: 12.5, y: -3, selected: [NOTE1], ...extra }));
  assert.deepEqual(await cursor('alice'), refusal);
  await w.run('team.board.view', 'alice', w.base());
  w.published.length = 0;
  const reads = w.boards.calls;
  assert.deepEqual(await cursor('alice'), { ok: true });
  assert.equal(w.boards.calls, reads);
  assert.deepEqual(w.published.map((entry) => [entry.type, entry.payload]), [
    [CURSOR_EVENT, { project_id: P1, board_id: B1, member_id: ALICE, x: 12.5, y: -3, selected: [NOTE1] }]]);
  // A device that is not viewing, another device of the same member, and a project the board is not tracked under.
  w.published.length = 0;
  assert.deepEqual(await cursor('bob'), refusal);
  assert.deepEqual(await cursor('alice2'), refusal);
  assert.deepEqual(await w.run('team.board.cursor', 'alice', { project_id: P2, board_id: B1, x: 1, y: 1, selected: [] }), refusal);
  assert.deepEqual(await w.run('team.board.cursor', 'alice', { project_id: P1, board_id: B2, x: 1, y: 1, selected: [] }), refusal);
  assert.deepEqual(w.published, []);
  // The member in the event is the caller, whatever the params say.
  await w.run('team.board.cursor', 'alice', w.base({ x: 1, y: 2, selected: [], member_id: BOB }));
  assert.equal(w.published[0].payload.member_id, ALICE);
  // Malformed values are refused and published nowhere.
  w.published.length = 0;
  for (const extra of [{ x: Number.NaN }, { y: Infinity }, { x: '1' }, { selected: 'a' }, { selected: ['nope'] },
    { selected: Array.from({ length: 65 }, () => NOTE1) }, { selected: [7] }]) {
    assert.equal((await cursor('alice', extra)).ok, false, JSON.stringify(extra));
  }
  assert.deepEqual(w.published, []);
  assert.equal((await cursor('alice', { selected: Array.from({ length: 64 }, () => NOTE1) })).ok, true);
});

test('T4 ops: lock answers by the table and announces the lock and the release it caused', async () => {
  const w = world();
  const lock = (member, cardId, extra = {}) => w.run('team.board.lock', member, w.base({ card_id: cardId, ...extra }));
  // Not viewing yet.
  assert.deepEqual(await lock('alice', NOTE1), hostFailure('forbidden', 'team_board_not_viewing'));
  await w.run('team.board.view', 'alice', w.base());
  await w.run('team.board.view', 'bob', w.base());
  w.published.length = 0;
  assert.deepEqual(await lock('alice', NOTE1), { ok: true, lock_ms: PRESENCE_LIMITS.LOCK_MS });
  assert.deepEqual(w.published.map((entry) => [entry.type, entry.payload]), [
    [LOCK_EVENT, { project_id: P1, board_id: B1, card_id: NOTE1, member_id: ALICE }]]);
  // A renewal is silent.
  w.published.length = 0;
  assert.equal((await lock('alice', NOTE1)).ok, true);
  assert.deepEqual(w.published, []);
  // Held by someone else: forbidden, with the holder.
  assert.deepEqual(await lock('bob', NOTE1), { ...hostFailure('forbidden', 'team_board_note_locked'), held_by: ALICE });
  assert.deepEqual(w.published, []);
  // A second lock on the device releases the first, and both are announced.
  assert.equal((await lock('alice', NOTE2)).ok, true);
  assert.deepEqual(w.published.map((entry) => [entry.type, entry.payload.card_id, entry.payload.member_id]),
    [[LOCK_EVENT, NOTE1, null], [LOCK_EVENT, NOTE2, ALICE]]);
  // A card that is missing, not a note, malformed, or of a read-only board.
  w.published.length = 0;
  const notFound = hostFailure('invalid', 'team_board_card_not_found');
  assert.deepEqual(await lock('alice', '00000000-0000-4000-8000-0000000000e9'), notFound);
  assert.deepEqual(await lock('alice', FILE1), notFound);
  assert.deepEqual(await lock('alice', 'constructor'), notFound);
  assert.deepEqual(await lock('alice', 7), notFound);
  assert.deepEqual(await w.run('team.board.lock', 'alice', { project_id: P1, board_id: B2, card_id: NOTE1 }), notFound);
  // A board of another project is not lockable: the store refuses it and its answer passes through.
  assert.deepEqual(await w.run('team.board.lock', 'alice', { project_id: P2, board_id: B1, card_id: NOTE1 }), hostFailure('invalid', 'team_board_not_found'));
  assert.deepEqual(w.published, []);
  assert.equal(w.presence.lockHolder(B1, NOTE2), ALICE);
});

test('T4 ops: a lock at the cap answers the presence limit', async () => {
  const w = world({ presence: { limits: { LOCKS_PER_BOARD: 1 } } });
  await w.run('team.board.view', 'alice', w.base());
  await w.run('team.board.view', 'bob', w.base());
  assert.equal((await w.run('team.board.lock', 'alice', w.base({ card_id: NOTE1 }))).ok, true);
  assert.deepEqual(await w.run('team.board.lock', 'bob', w.base({ card_id: NOTE2 })), hostFailure('limit', 'team_board_presence_limit'));
});

test('T4 ops: unlock answers ok, and announces only a lock that was released by its holder', async () => {
  const w = world();
  await w.run('team.board.view', 'alice', w.base());
  await w.run('team.board.view', 'bob', w.base());
  await w.run('team.board.lock', 'alice', w.base({ card_id: NOTE1 }));
  w.published.length = 0;
  assert.deepEqual(await w.run('team.board.unlock', 'bob', w.base({ card_id: NOTE1 })), { ok: true });
  assert.deepEqual(w.published, []);
  assert.equal(w.presence.lockHolder(B1, NOTE1), ALICE);
  assert.deepEqual(await w.run('team.board.unlock', 'alice', w.base({ card_id: NOTE1 })), { ok: true });
  assert.deepEqual(w.published.map((entry) => [entry.type, entry.payload]), [
    [LOCK_EVENT, { project_id: P1, board_id: B1, card_id: NOTE1, member_id: null }]]);
  w.published.length = 0;
  assert.deepEqual(await w.run('team.board.unlock', 'alice', w.base({ card_id: NOTE1 })), { ok: true });
  assert.deepEqual(await w.run('team.board.unlock', 'alice', { project_id: P2, board_id: B3, card_id: NOTE1 }), { ok: true });
  assert.deepEqual(w.published, []);
});

test('T4 announce: publishes exactly the viewers and releases a drop or an expiry returned', async () => {
  const w = world();
  for (const member of ['alice', 'bob']) await w.run('team.board.view', member, w.base());
  await w.run('team.board.view', 'alice', { project_id: P1, board_id: B2 });
  await w.run('team.board.lock', 'bob', w.base({ card_id: NOTE1 }));
  await w.run('team.board.lock', 'alice', w.base({ card_id: NOTE2 }));
  w.published.length = 0;
  w.ops.announce(w.presence.dropDevice(D_B));
  assert.deepEqual(w.published.map((entry) => [entry.type, entry.payload]), [
    [VIEWERS_EVENT, { project_id: P1, board_id: B1, viewers: [ALICE] }],
    [LOCK_EVENT, { project_id: P1, board_id: B1, card_id: NOTE1, member_id: null }],
  ]);
  w.published.length = 0;
  w.clock.advance(PRESENCE_LIMITS.LOCK_MS + 1);
  await w.run('team.board.view', 'alice', w.base());
  w.published.length = 0;
  w.ops.announce(w.presence.expire());
  assert.deepEqual(w.published.map((entry) => [entry.type, entry.payload.board_id, entry.payload.card_id ?? null]),
    [[LOCK_EVENT, B1, NOTE2]]);
  // A change that names no viewers and no lock publishes nothing; bad input never throws.
  w.published.length = 0;
  w.ops.announce([{ projectId: P1, boardId: B1, viewers: false, unlocked: [] }]);
  for (const junk of [null, undefined, 'x', [null, 5, {}], [{ projectId: 3, boardId: B1, viewers: true, unlocked: [NOTE1] }]]) {
    assert.doesNotThrow(() => w.ops.announce(junk));
  }
  assert.deepEqual(w.published, []);
  // The viewers announced are the board's current ones.
  w.ops.announce([{ projectId: P1, boardId: B1, viewers: true, unlocked: [] }]);
  assert.deepEqual(w.published.map((entry) => entry.payload.viewers), [[ALICE]]);
});

test('T4 events: every event carries the project audience, the project bucket and ephemeral; an empty audience publishes nothing', async () => {
  const w = world();
  await w.run('team.board.view', 'alice', w.base());
  await w.run('team.board.lock', 'alice', w.base({ card_id: NOTE1 }));
  await w.run('team.board.cursor', 'alice', w.base({ x: 1, y: 1, selected: [] }));
  assert.deepEqual(types(w), [VIEWERS_EVENT, LOCK_EVENT, CURSOR_EVENT]);
  for (const entry of w.published) {
    assert.deepEqual([...entry.opts.audience].sort(), [ALICE, BOB, CARL]);
    assert.equal(entry.opts.bucket, `project:${P1}`);
    assert.equal(entry.opts.ephemeral, true);
    assert.deepEqual(Object.keys(entry.opts).sort(), ['audience', 'bucket', 'ephemeral']);
  }
  // Another project's events go to its own members under its own bucket.
  w.boards.live.set(`${P2}|${B3}`, { [NOTE1]: 'note' });
  w.published.length = 0;
  await w.run('team.board.view', 'alice', { project_id: P2, board_id: B3 });
  assert.deepEqual([...w.published[0].opts.audience], [ALICE]);
  assert.equal(w.published[0].opts.bucket, `project:${P2}`);

  // A project nobody has: the call still answers, nothing is published.
  const empty = world({ directory: directoryOf({ [OUTSIDER]: {} }) });
  assert.equal((await empty.run('team.board.view', 'alice', empty.base())).ok, true);
  await empty.run('team.board.lock', 'alice', empty.base({ card_id: NOTE1 }));
  await empty.run('team.board.cursor', 'alice', empty.base({ x: 1, y: 1, selected: [] }));
  empty.ops.announce(empty.presence.dropDevice(D_A1));
  assert.deepEqual(empty.published, []);
  // A directory that throws publishes nothing and fails nothing.
  const broken = world({ directory: { activeMemberIds: () => { throw new Error('directory gone'); }, memberActor: () => null } });
  assert.equal((await broken.run('team.board.view', 'alice', broken.base())).ok, true);
  assert.deepEqual(broken.published, []);
});

test('T4 events: a publish that throws fails no call and is logged without ids, names or card text', async () => {
  const w = world();
  w.state.throwing = true;
  assert.equal((await w.run('team.board.view', 'alice', w.base())).ok, true);
  assert.equal((await w.run('team.board.lock', 'alice', w.base({ card_id: NOTE1 }))).ok, true);
  assert.equal((await w.run('team.board.cursor', 'alice', w.base({ x: 1, y: 1, selected: [NOTE1] }))).ok, true);
  assert.equal((await w.run('team.board.unlock', 'alice', w.base({ card_id: NOTE1 }))).ok, true);
  assert.equal((await w.run('team.board.leave', 'alice', w.base())).ok, true);
  assert.doesNotThrow(() => w.ops.announce([{ projectId: P1, boardId: B1, viewers: true, unlocked: [NOTE1] }]));
  w.boards.throwing = true;
  await w.run('team.board.view', 'alice', w.base());
  assert.ok(w.logs.length >= 2, 'the failures were logged');
  const text = JSON.stringify(w.logs);
  for (const secret of [P1, B1, NOTE1, ALICE, D_A1, 'transport down', 'disk gone']) assert.equal(text.includes(secret), false, secret);
  // A logger that throws changes nothing.
  const loud = createPresenceOperations({ presence: w.presence, publish: () => { throw new Error('x'); }, directory: w.directory, logger: () => { throw new Error('log'); } });
  assert.doesNotThrow(() => loud.announce([{ projectId: P1, boardId: B1, viewers: true, unlocked: [] }]));
});

test('T4 store: nothing is kept for a board once nobody views it, and a lock needs the board viewed under the same project', async () => {
  const w = world();
  await w.run('team.board.view', 'alice', w.base());
  await w.run('team.board.lock', 'alice', w.base({ card_id: NOTE1 }));
  w.clock.advance(TTL + 1);
  w.ops.announce(w.presence.expire());
  assert.deepEqual(w.presence.resources(), { boards: 0, viewers: 0, locks: 0 });
  assert.deepEqual(await w.run('team.board.lock', 'alice', w.base({ card_id: NOTE1 })), hostFailure('forbidden', 'team_board_not_viewing'));
});
