'use strict';

// new-test-file: the trash sweep of the team host's board store is its own module since the row 151 review
// (server/team/boards/board-host-sweep.js), and tests/server/team-board-store.test.js, which keeps the sweep's
// basic case, is 30 lines under the 600-line cap.
//
// The sweep on a real temp profile: one project's backlog does not hold another's trash; a board that cannot be read
// right now, and one whose document broke while it waited, are kept without stopping the rest, and the index is
// written for what was removed; a sweep that cannot look at all says so.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const durable = require('../../services/host/durable-json');
const { removeTreeSync } = require('../../services/fs-remove-no-follow');
const { SWEEP_MAX, TEMP_MS } = require('../../server/team/boards/board-host-sweep');
const { PICTURE_SWEEP_MS, PRESENCE_SWEEP_MS, createTeamBoardHost } = require('../../server/team/boards/team-board-host');
const { startSweeps } = require('../../server/team/sweep-timer');
const { createTeamBoards } = require('../../server/team/boards/team-boards');
const { must } = require('./helpers/team-board-kit');
const { png, sha } = require('./helpers/team-board-pictures');

const DAY = 24 * 60 * 60 * 1000;
const A = 'project_alpha';
const B = 'project_beta';
const ALICE = 'member_alice';
const START = Date.UTC(2026, 10, 15, 9, 0, 0);

function setup(t, options = {}) {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-board-sweep-')));
  t.after(() => removeTreeSync(profile));
  const clock = { now: START };
  const logs = [];
  const make = (extra = {}) => createTeamBoards({ userDataPath: profile, clock: () => clock.now,
    logger: (level, event, data) => logs.push({ level, event, data }), ...options, ...extra });
  const root = path.join(profile, 'team-boards');
  return { root, clock, logs, make, boards: make(),
    doc: (projectId, boardId) => path.join(root, projectId, `${boardId}.json`),
    index: (projectId) => JSON.parse(fs.readFileSync(path.join(root, projectId, 'index.json'), 'utf8')).boards };
}

async function trashed(h, projectId, name) {
  const board = (await must(h.boards.create({ projectId, actor: ALICE, name }), 'create')).board;
  await must(h.boards.remove({ projectId, boardId: board.id, actor: ALICE }), 'remove');
  return board.id;
}

const boardFiles = (h, projectId) => fs.readdirSync(path.join(h.root, projectId)).filter((name) => name.startsWith('board_'));

test('one project\'s backlog does not hold another\'s trash: more than one turn\'s worth in A and one board in B all go', async (t) => {
  const h = setup(t);
  const count = SWEEP_MAX + 1;
  for (let n = 0; n < count; n += 1) {
    h.clock.now += 1000;
    await trashed(h, A, `Old ${n}`);
  }
  const lone = await trashed(h, B, 'Lone');
  h.clock.now += 7 * DAY + 2000; // every board so far is past its 7 days
  const kept = await trashed(h, B, 'Deleted a moment ago');
  const swept = await must(h.boards.sweep(), 'sweep');
  assert.deepEqual([swept.removed, swept.failed], [count + 1, 0]);
  assert.deepEqual(boardFiles(h, A), []);
  assert.deepEqual(Object.keys(h.index(A)), []);
  assert.equal(fs.existsSync(h.doc(B, lone)), false, 'B\'s expired board went in the same sweep');
  assert.deepEqual(Object.keys(h.index(B)), [kept], 'a board deleted a moment ago stays');
  assert.deepEqual((await must(h.boards.sweep())).removed, 0, 'nothing is left for a second sweep');
});

test('a board that cannot be read right now is left for the next sweep; the others go and the index is written', async (t) => {
  let locked = null;
  const h = setup(t, { fileOps: { readJson: (filePath, options) => {
    if (locked && filePath === locked) throw Object.assign(new Error('injected'), { code: 'EACCES' });
    return durable.readJson(filePath, options);
  } } });
  const first = await trashed(h, A, 'First');
  h.clock.now += 1000;
  const second = await trashed(h, A, 'Second');
  h.clock.now += 1000;
  const third = await trashed(h, A, 'Third');
  h.clock.now += 7 * DAY + 5000;
  locked = h.doc(A, second);
  const store = h.make(); // nothing in memory: every board is read from disk
  const swept = await must(store.sweep(), 'sweep');
  assert.deepEqual([swept.removed, swept.failed], [2, 1]);
  assert.deepEqual([fs.existsSync(h.doc(A, first)), fs.existsSync(h.doc(A, second)), fs.existsSync(h.doc(A, third))], [false, true, false]);
  assert.deepEqual(Object.keys(h.index(A)), [second], 'the index on disk no longer lists the two that went');
  assert.deepEqual(h.logs.filter((entry) => entry.event === 'team_board.sweep_kept').map((entry) => entry.data),
    [{ project_id: A, board_id: second, reason: 'unreadable' }]);
  locked = null;
  assert.deepEqual((await must(store.sweep())).removed, 1, 'once it can be read it goes');
  assert.deepEqual(boardFiles(h, A), []);
});

test('a board whose document broke while it waited in the trash is never removed, and a project admin can still see it', async (t) => {
  const h = setup(t);
  const broken = await trashed(h, A, 'Broken');
  const fine = await trashed(h, A, 'Fine');
  fs.writeFileSync(h.doc(A, broken), '{ not a board');
  h.clock.now += 7 * DAY + 1000;
  const store = h.make();
  const swept = await must(store.sweep(), 'sweep');
  assert.deepEqual([swept.removed, swept.failed], [1, 1]);
  assert.equal(fs.readFileSync(h.doc(A, broken), 'utf8'), '{ not a board', 'the file is as it was');
  assert.equal(fs.existsSync(h.doc(A, fine)), false);
  assert.deepEqual((await must(store.listDeleted({ projectId: A }))).boards.map((row) => row.id), [broken]);
  assert.deepEqual(h.logs.filter((entry) => entry.event === 'team_board.sweep_kept').map((entry) => entry.data.reason), ['read_only']);
  const again = await must(store.sweep());
  assert.deepEqual([again.removed, again.failed], [0, 1], 'it is kept on every later sweep too');
});

test('a sweep that cannot look at team-boards answers unavailable and says so in the log', async (t) => {
  const h = setup(t);
  fs.writeFileSync(h.root, 'not a folder');
  const answer = await h.boards.sweep();
  assert.deepEqual([answer.ok, answer.error.reason], [false, 'team_board_unavailable']);
  assert.deepEqual(h.logs.filter((entry) => entry.event === 'team_board.sweep_unavailable').length, 1);
});

test('the timer of the host reports a board sweep that could not run, and stays quiet about one that did', async (t) => {
  const run = async (prepare) => {
    const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-board-sweep-host-')));
    t.after(() => removeTreeSync(profile));
    prepare(path.join(profile, 'team-boards'));
    const host = createTeamBoardHost({ userDataPath: profile, directory: { liveActor: () => null }, sessionProject: () => null, publish: () => {},
      audit: () => null });
    const warned = [];
    const boardSweep = host.sweeps.filter(([event]) => event === 'team.board_sweep_failed');
    assert.equal(boardSweep.length, 1);
    const timer = startSweeps({ tasks: boardSweep, intervalMs: 60_000, warn: (event) => warned.push(event) });
    t.after(() => clearInterval(timer));
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    return warned;
  };
  assert.deepEqual(await run((root) => fs.writeFileSync(root, 'not a folder')), ['team.board_sweep_failed']);
  assert.deepEqual(await run(() => {}), [], 'a sweep with nothing to do is not a failure');
});

test('the sweep removes the temp files a crash left once they are an hour old, and nothing else (P5)', async (t) => {
  const h = setup(t);
  const board = (await must(h.boards.create({ projectId: A, actor: ALICE, name: 'Kept' }), 'create')).board;
  const dir = path.join(h.root, A);
  const assets = path.join(dir, 'assets');
  fs.mkdirSync(assets);
  const temp = (n) => `.host-${String(n).padStart(32, '0')}.tmp`;
  const put = (file, ageMs) => {
    fs.writeFileSync(file, 'half a write');
    const at = new Date(h.clock.now - ageMs);
    fs.utimesSync(file, at, at);
  };
  put(path.join(dir, temp(1)), TEMP_MS + 60_000);
  put(path.join(assets, temp(2)), TEMP_MS + 60_000);
  put(path.join(dir, temp(3)), TEMP_MS - 60_000); // a write that may still be in progress
  put(path.join(dir, '.host-notes.tmp'), 7 * DAY); // not the writer's name
  put(path.join(dir, `${temp(4)}.keep`), 7 * DAY);
  fs.mkdirSync(path.join(dir, temp(5))); // a folder by that name is not a temp file
  const before = fs.readFileSync(h.doc(A, board.id), 'utf8');

  assert.deepEqual(await h.boards.sweep(), { ok: true, removed: 0, failed: 0 });
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.host-')).sort(),
    [temp(3), temp(4) + '.keep', temp(5), '.host-notes.tmp'].sort());
  assert.deepEqual(fs.readdirSync(assets), []);
  assert.equal(fs.readFileSync(h.doc(A, board.id), 'utf8'), before);
  assert.deepEqual(h.logs.filter((entry) => entry.event === 'team_board.temps_removed').map((entry) => entry.data),
    [{ project_id: A, count: 2 }]);
});

test('the host sweeps pictures every hour and stops with the host (P5)', async (t) => {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-board-sweep-hour-')));
  t.after(() => removeTreeSync(profile));
  const set = [];
  const cleared = [];
  const timers = { setInterval: (fn, ms) => { set.push({ fn, ms }); return set.length; }, clearInterval: (id) => cleared.push(id) };
  const host = createTeamBoardHost({ userDataPath: profile, directory: { liveActor: () => null }, sessionProject: () => null,
    publish: () => {}, audit: () => null, timers, clock: () => START });
  await must(host.store.create({ projectId: A, actor: ALICE, name: 'Plan' }), 'create');
  const picture = png(2, 2);
  const assets = path.join(profile, 'team-boards', A, 'assets');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, `${sha(picture)}.png`), picture);
  const undo = host.attach({ core: { composition: { backend: {} } }, store: { onMembershipChange: () => () => {} } });
  assert.deepEqual(set.map((timer) => timer.ms), [PRESENCE_SWEEP_MS, PICTURE_SWEEP_MS]);
  assert.equal(PICTURE_SWEEP_MS, 60 * 60 * 1000);
  const seen = path.join(assets, 'unreferenced.json');
  assert.equal(fs.existsSync(seen), false);
  set[1].fn();
  for (let n = 0; n < 200 && !fs.existsSync(seen); n += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(seen, 'utf8')).since), [sha(picture)], 'the unused picture was seen');
  for (const stop of undo) stop();
  assert.deepEqual(cleared, [1, 2]);
});
