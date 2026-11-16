'use strict';

// new-test-file: tests/server/team-board-store.test.js is 30 lines under the 600-line cap; these are the host board
// store's bounds and orderings found by the row 151 review (server/team/boards/board-host-store.js,
// board-host-load.js, board-host-index.js, board-host-files.js).
//
// A folder with more entries than a listing may hold makes the project unavailable and loses no board; a project
// holds a bounded number of boards, live and trash together, so its index cannot outgrow its file; the caller's
// check and the writes are one stretch; a path check that could not finish is not remembered; the audit comes after
// every check; an index write that fails after the document landed is repaired.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const durable = require('../../services/host/durable-json');
const { removeTreeSync } = require('../../services/fs-remove-no-follow');
const { assertSafeFile } = require('../../services/host/path-guard');
const { LIMITS } = require('../../services/boards/board-model');
const idx = require('../../server/team/boards/board-host-index');
const { TEAM_BOARD_LIMITS, createTeamBoards } = require('../../server/team/boards/team-boards');
const { batch, must, note } = require('./helpers/team-board-kit');

const DAY = 24 * 60 * 60 * 1000;
const P = 'project_alpha';
const ALICE = 'member_alice';
const START = Date.UTC(2026, 10, 15, 9, 0, 0);

function setup(t, options = {}) {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-board-bounds-')));
  t.after(() => removeTreeSync(profile));
  const clock = { now: START };
  const logs = [];
  const make = (extra = {}) => createTeamBoards({ userDataPath: profile, clock: () => clock.now,
    logger: (level, event, data) => logs.push({ level, event, data }), ...options, ...extra });
  const dir = path.join(profile, 'team-boards', P);
  return { dir, clock, logs, make, boards: make(),
    doc: (boardId) => path.join(dir, `${boardId}.json`),
    indexText: () => fs.readFileSync(path.join(dir, 'index.json'), 'utf8') };
}

const reasonOf = (answer) => answer?.error?.reason;
const create = async (store, name = 'Plan') => (await must(store.create({ projectId: P, actor: ALICE, name }), 'create')).board;

test('a project folder with more entries than a listing may hold is unavailable, and no board is dropped from its index', async (t) => {
  const h = setup(t);
  const board = await create(h.boards);
  const before = h.indexText();
  for (let n = 0; n < 4100; n += 1) fs.writeFileSync(path.join(h.dir, `stuffing-${n}.tmp`), '');
  const store = h.make();
  for (const answer of [await store.list({ projectId: P }), await store.get({ projectId: P, boardId: board.id }),
    await store.create({ projectId: P, actor: ALICE, name: 'More' })]) {
    assert.deepEqual([answer.ok, reasonOf(answer), answer.error.retryable], [false, 'team_board_unavailable', true]);
  }
  assert.equal(h.indexText(), before, 'the index was not rewritten from a cut listing');
  assert.ok(h.logs.some((entry) => entry.event === 'team_board.folder_too_large' && entry.data.project_id === P));
  for (const name of fs.readdirSync(h.dir)) if (name.startsWith('stuffing-')) fs.unlinkSync(path.join(h.dir, name));
  assert.deepEqual((await must(store.list({ projectId: P }))).boards.map((row) => row.id), [board.id], 'the board is still there');
});

test('a project holds a bounded number of boards, live and trash together, so its index stays under its file cap', async (t) => {
  // The widest entry the index accepts: a 200-character name of lone surrogates (six bytes each in JSON), full-length
  // tokens, the largest integers.
  const widest = { name: '\ud800'.repeat(200), rev: Number.MAX_SAFE_INTEGER, created_at: '2026-11-15T09:00:00.000Z',
    updated_at: '2026-11-15T09:00:00.000Z', created_by: 'm'.repeat(200), bytes: Number.MAX_SAFE_INTEGER,
    deleted_at: '2026-11-15T09:00:00.000Z', deleted_by: 'm'.repeat(200) };
  const id = 'board_00000000-0000-4000-8000-000000000000';
  assert.equal(idx.readIndex(idx.toDocument(new Map([[id, widest]]))).status, 'ok', 'the index itself accepts that entry');
  const one = Buffer.byteLength(`${JSON.stringify(id)}:${JSON.stringify(widest)},`, 'utf8');
  assert.ok(one <= idx.ENTRY_MAX_BYTES, `an entry takes at most ${idx.ENTRY_MAX_BYTES} bytes, measured ${one}`);
  assert.ok(idx.ENTRIES_MAX * idx.ENTRY_MAX_BYTES + 64 <= idx.INDEX_FILE_BYTES);
  assert.equal(TEAM_BOARD_LIMITS.boards, idx.ENTRIES_MAX);
  assert.throws(() => createTeamBoards({ userDataPath: os.tmpdir(), limits: { boards: idx.ENTRIES_MAX + 1 } }), RangeError);

  const h = setup(t, { limits: { boards: 3 } });
  const kept = await create(h.boards, 'Kept');
  for (const name of ['Gone 1', 'Gone 2']) {
    const board = await create(h.boards, name);
    await must(h.boards.remove({ projectId: P, boardId: board.id, actor: ALICE }));
  }
  const full = await h.boards.create({ projectId: P, actor: ALICE, name: 'One too many' });
  assert.deepEqual([full.ok, reasonOf(full)], [false, 'team_board_storage_limit']);
  assert.equal(fs.readdirSync(h.dir).filter((name) => name.startsWith('board_')).length, 3, 'nothing was written for it');
  // What grows an entry still works at the cap: a long name, and the trash marks.
  await must(h.boards.rename({ projectId: P, boardId: kept.id, actor: ALICE, name: '漢'.repeat(200) }));
  await must(h.boards.remove({ projectId: P, boardId: kept.id, actor: ALICE }));
  h.clock.now += 7 * DAY + 1000;
  assert.equal((await must(h.boards.sweep())).removed, 3);
  await create(h.boards, 'Room again');
});

test('a full trash refuses the next delete and never a create (wave 10 review)', async (t) => {
  assert.equal(TEAM_BOARD_LIMITS.trash + LIMITS.boards_per_project, TEAM_BOARD_LIMITS.boards, 'every live board fits beside a full trash');
  assert.throws(() => createTeamBoards({ userDataPath: os.tmpdir(), limits: { trash: TEAM_BOARD_LIMITS.trash + 1 } }), RangeError);
  const h = setup(t, { limits: { trash: 2 } });
  for (const name of ['Gone 1', 'Gone 2']) {
    const board = await create(h.boards, name);
    await must(h.boards.remove({ projectId: P, boardId: board.id, actor: ALICE }));
  }
  const kept = await create(h.boards, 'Kept');
  const audits = [];
  const refused = await h.boards.remove({ projectId: P, boardId: kept.id, actor: ALICE, audit: (event) => { audits.push(event); return null; } });
  assert.deepEqual([refused.ok, reasonOf(refused), refused.error.code], [false, 'team_board_trash_limit', 'CMP-HOST-0007']);
  assert.deepEqual(audits, [], 'refused before the audit');
  assert.deepEqual((await must(h.boards.list({ projectId: P }))).boards.map((row) => row.id), [kept.id], 'the board is still live');
  assert.equal((await must(h.boards.listDeleted({ projectId: P }))).boards.length, 2);
  // Creates go on up to the live cap whatever the trash holds.
  for (let n = 1; n < LIMITS.boards_per_project; n += 1) await create(h.boards, `Live ${n}`);
  assert.equal(reasonOf(await h.boards.create({ projectId: P, actor: ALICE, name: 'One too many' })), 'team_board_limit');
  // A restore makes room in the trash; so does the 7-day sweep.
  h.clock.now += 7 * DAY + 1000;
  assert.equal((await must(h.boards.sweep())).removed, 2);
  await must(h.boards.remove({ projectId: P, boardId: kept.id, actor: ALICE }));
});

test('a check that answers at once and the writes after it are one stretch: nothing queued meanwhile runs in between', async (t) => {
  let flipped = false;
  const seen = [];
  const h = setup(t, { fileOps: { writeText: (filePath, text) => {
    seen.push([path.basename(filePath).replace(/board_[0-9a-f-]+/u, 'board'), flipped]);
    return durable.writeText(filePath, text);
  } } });
  // The check lets the call go on and queues something that would change the answer (a demotion landing).
  const recheck = () => { queueMicrotask(() => { flipped = true; }); return null; };
  const board = (await must(h.boards.create({ projectId: P, actor: ALICE, name: 'Plan', recheck }))).board;
  assert.deepEqual(seen, [['board.json', false], ['index.json', false]]);
  flipped = false;
  seen.length = 0;
  await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()), recheck }));
  assert.deepEqual(seen, [['board.json', false], ['board.journal.json', false], ['index.json', false]]);
  // A check that answers a promise is still waited for, and its refusal still stops the call.
  const denied = await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note('no', 400)),
    recheck: async () => ({ ok: false, error: { reason: 'role_forbidden' } }) });
  assert.equal(reasonOf(denied), 'role_forbidden');
  assert.equal((await must(h.boards.get({ projectId: P, boardId: board.id }))).rev, 1);
});

test('a path check that could not finish is not remembered: the board is read again on the next call', async (t) => {
  let failing = false;
  const h = setup(t);
  const board = await create(h.boards);
  const store = h.make({ assertSafePath: (filePath) => {
    if (failing && filePath === h.doc(board.id)) throw Object.assign(new Error('File could not be verified.'), { reason: 'unsafe_path' });
    return assertSafeFile(filePath);
  } });
  failing = true;
  const blocked = await must(store.get({ projectId: P, boardId: board.id }));
  assert.deepEqual([blocked.board, blocked.read_only, blocked.reason], [null, true, 'unsafe']);
  failing = false;
  const read = await must(store.get({ projectId: P, boardId: board.id }));
  assert.deepEqual([read.read_only, read.board.name], [false, 'Plan']);
  await must(store.rename({ projectId: P, boardId: board.id, actor: ALICE, name: 'Renamed' }));
});

test('the audit comes after every check: a removal the storage cap refuses is not recorded', async (t) => {
  const h = setup(t);
  const board = await create(h.boards);
  const notes = Array.from({ length: 20 }, (_, n) => note('n'.repeat(3000), n * 300));
  await must(h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(...notes) }));
  const used = (await must(h.boards.usage({ projectId: P }))).bytes;
  // A cap just under what the project already uses: anything that grows it is refused, and a removal grows it (the
  // journal gains the way back).
  const tight = h.make({ limits: { storageBytes: used - 1 } });
  const audits = [];
  const refused = await tight.apply({ projectId: P, boardId: board.id, actor: ALICE,
    batch: batch(...notes.map((item) => ({ op: 'card.remove', id: item.card.id }))),
    audit: (event) => { audits.push(event); return null; } });
  assert.deepEqual([refused.ok, reasonOf(refused)], [false, 'team_board_storage_limit']);
  assert.deepEqual(audits, [], 'the audit holds no removal that did not happen');
  assert.equal(Object.keys((await must(tight.get({ projectId: P, boardId: board.id }))).board.cards).length, 20);
});

test('an index write that fails after the document landed still answers success, and the index is repaired from the document', async (t) => {
  let failIndex = false;
  const h = setup(t, { fileOps: { writeText: (filePath, text) => {
    if (failIndex && filePath.endsWith('index.json')) {
      failIndex = false;
      throw Object.assign(new Error('injected'), { code: 'EIO' });
    }
    return durable.writeText(filePath, text);
  } } });
  const board = await create(h.boards);
  failIndex = true;
  const landed = await h.boards.apply({ projectId: P, boardId: board.id, actor: ALICE, batch: batch(note()) });
  assert.deepEqual([landed.ok, landed.rev], [true, 1], 'the document landed: the change is committed');
  assert.equal(JSON.parse(h.indexText()).boards[board.id].rev, 0, 'the index on disk is one batch behind');
  for (const store of [h.boards, h.make()]) {
    assert.equal((await must(store.get({ projectId: P, boardId: board.id }))).rev, 1);
    assert.deepEqual((await must(store.list({ projectId: P }))).boards.map((row) => row.rev), [1], 'opening the board repaired its row');
  }
  assert.equal(JSON.parse(h.indexText()).boards[board.id].rev, 1);
});
