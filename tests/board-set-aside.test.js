'use strict';

// new-test-file: a new surface (services/boards/board-set-aside.js, slice B11, owner decision D20): "Show file" and
// "Remove from list" for a board that loads read-only, over the real store and service in a temp profile.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ids = require('../services/boards/board-ids');
const { createBoardStore } = require('../services/boards/board-store');
const { createBoardService } = require('../services/boards/board-service');
const { createBoardSetAside } = require('../services/boards/board-set-aside');
const { pruneOrphanedProfileTemps } = require('../services/data-lifecycle/orphaned-profile-temps');

const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const ALPHA = 'project_alpha';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CORRUPT_BYTES = '{"schema_version":1,"id":';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-set-aside-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { root, userDataPath: path.join(root, 'profile'), clock: T0, seq: 1000, events: [], enabled: true, revealed: [] };
  fs.mkdirSync(env.userDataPath);
  env.dir = path.join(env.userDataPath, 'boards');
  env.file = (name) => path.join(env.dir, name);
  // A fresh store, service and set-aside over the same folder: what a restart of the app builds.
  env.make = () => {
    const store = createBoardStore({ userDataPath: env.userDataPath });
    const service = createBoardService({ store, now: () => new Date(env.clock), makeId: () => uid(++env.seq), isEnabled: () => env.enabled });
    service.on('changed', (event) => env.events.push(event));
    const aside = createBoardSetAside({ store, service, now: () => new Date(env.clock), revealPath: (filePath) => env.revealed.push(filePath) });
    return { store, service, aside };
  };
  env.restart = () => Object.assign(env, env.make());
  env.restart();
  return env;
}

async function created(env, name) {
  const answer = await env.service.create({ projectId: ALPHA, name });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return answer.board;
}

// A board with a journal (one applied batch) and a proposals file.
async function withFiles(env, name) {
  const board = await created(env, name);
  const op = { op: 'card.add', card: { id: uid(++env.seq), kind: 'note', data: { text: 'x' }, x: 0, y: 0 } };
  assert.equal((await env.service.apply({ boardId: board.id, batch: { batch_id: `b-${board.id}`, board_id: board.id, actor: 'owner', ops: [op] } })).ok, true);
  env.store.writeProposals(board.id, [{ id: 'p1' }]);
  assert.equal(fs.existsSync(env.file(`${board.id}.journal.json`)), true);
  return board;
}

function breakDocument(env, board, how) {
  fs.writeFileSync(env.file(`${board.id}.json`), how === 'newer' ? JSON.stringify({ ...board, schema_version: 2 }) : CORRUPT_BYTES);
}

// Every entry of the boards folder with its bytes (a folder or link by its kind).
function snapshot(env) {
  const out = {};
  for (const entry of fs.readdirSync(env.dir, { withFileTypes: true })) {
    out[entry.name] = entry.isFile() ? fs.readFileSync(path.join(env.dir, entry.name)).toString('base64') : (entry.isSymbolicLink() ? 'link' : 'other');
  }
  return out;
}

const ownFiles = (id) => [`${id}.json`, `${id}.journal.json`, `${id}.proposals.json`];
const names = async (service, projectId = ALPHA) => (await service.list({ projectId })).boards.map((board) => board.name).sort();
const GENERAL = ids.GENERAL_PROJECT_ID; // where a document the index did not list, and the model refuses, is listed
const indexed = (env) => JSON.parse(fs.readFileSync(env.file('index.json'), 'utf8')).boards;

test('a damaged and a newer-schema board are set aside: their three files renamed byte for byte, the entry gone, one deleted event', async (t) => {
  const env = setup(t);
  const good = await created(env, 'good');
  const corrupt = await withFiles(env, 'will break');
  const newer = await withFiles(env, 'from the future');
  breakDocument(env, corrupt, 'corrupt');
  breakDocument(env, newer, 'newer');
  env.restart();
  assert.deepEqual(await env.service.get({ boardId: newer.id }), { ok: true, board: null, readOnly: true, reason: 'newer_schema' });
  for (const [board, step] of [[corrupt, 0], [newer, 7]]) {
    env.clock = T0 + step;
    const before = Object.fromEntries(ownFiles(board.id).map((name) => [name, fs.readFileSync(env.file(name))]));
    env.events.length = 0;
    const suffix = `.aside-${T0 + step}`;
    assert.deepEqual(await env.aside.setAside({ boardId: board.id }), { ok: true, movedTo: `${board.id}.json${suffix}` });
    for (const [name, bytes] of Object.entries(before)) {
      assert.equal(fs.existsSync(env.file(name)), false, `${name} left its live name`);
      assert.deepEqual(fs.readFileSync(env.file(name + suffix)), bytes, `${name} kept its bytes`);
    }
    assert.deepEqual(env.events.map(({ boardId, projectId, kind }) => ({ boardId, projectId, kind })), [{ boardId: board.id, projectId: ALPHA, kind: 'deleted' }]);
    assert.equal(indexed(env)[board.id], undefined, 'the index on disk no longer has it');
    assert.deepEqual(await env.service.get({ boardId: board.id }), { ok: false, reason: 'not_found' });
  }
  assert.deepEqual(await names(env.service), ['good']);
  env.restart();
  assert.deepEqual(await names(env.service), ['good'], 'a new service over the same folder does not list it');
  assert.deepEqual(env.store.listDocumentIds().map((doc) => doc.id), [good.id], 'an aside file is never read as a document');
  assert.deepEqual(env.revealed, []);
});

test('a healthy board, a trashed board, an unknown id and a bad id are refused and nothing on disk changes', async (t) => {
  const env = setup(t);
  const healthy = await withFiles(env, 'healthy');
  const trashedHealthy = await created(env, 'trashed healthy');
  const trashedBroken = await withFiles(env, 'trashed broken');
  assert.equal((await env.service.delete({ boardId: trashedHealthy.id })).ok, true);
  assert.equal((await env.service.delete({ boardId: trashedBroken.id })).ok, true);
  breakDocument(env, trashedBroken, 'corrupt');
  env.restart();
  const before = snapshot(env);
  env.events.length = 0;
  for (const call of [(raw) => env.aside.setAside(raw), (raw) => env.aside.reveal(raw)]) {
    for (const board of [healthy, trashedHealthy, trashedBroken]) assert.deepEqual(await call({ boardId: board.id }), { ok: false, reason: 'not_read_only' }, board.name);
    assert.deepEqual(await call({ boardId: `board_${uid(1)}` }), { ok: false, reason: 'not_found' });
    for (const bad of [{ boardId: '../index' }, { boardId: `${healthy.id}.json` }, null, [], 'x', {}]) assert.deepEqual(await call(bad), { ok: false, reason: 'invalid' });
  }
  assert.deepEqual(snapshot(env), before);
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.revealed, []);
  assert.deepEqual(await names(env.service), ['healthy']);
});

test('with the flag off both calls answer disabled and touch nothing', async (t) => {
  const env = setup(t);
  const broken = await withFiles(env, 'broken');
  breakDocument(env, broken, 'corrupt');
  env.restart();
  const before = snapshot(env);
  env.events.length = 0;
  env.enabled = false;
  assert.deepEqual(await env.aside.setAside({ boardId: broken.id }), { ok: false, reason: 'disabled' });
  assert.deepEqual(await env.aside.reveal({ boardId: broken.id }), { ok: false, reason: 'disabled' });
  assert.deepEqual(snapshot(env), before);
  assert.deepEqual([env.events, env.revealed], [[], []]);
});

test('a document that became a junction, or a boards folder that became one, is neither moved nor revealed', async (t) => {
  const env = setup(t);
  const broken = await withFiles(env, 'broken');
  breakDocument(env, broken, 'corrupt');
  env.restart();
  assert.deepEqual(await names(env.service), ['broken'], 'the index is loaded while the file is still plain');
  const outside = path.join(env.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched');
  fs.renameSync(env.file(`${broken.id}.json`), path.join(env.root, 'moved-away.json'));
  try {
    fs.symlinkSync(outside, env.file(`${broken.id}.json`), 'junction');
  } catch (error) {
    t.skip(`this platform cannot make a directory link here (${error.code})`);
    return;
  }
  const before = snapshot(env);
  env.events.length = 0;
  assert.deepEqual(await env.aside.setAside({ boardId: broken.id }), { ok: false, reason: 'io' });
  assert.deepEqual(await env.aside.reveal({ boardId: broken.id }), { ok: false, reason: 'io' });
  assert.deepEqual(snapshot(env), before);
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
  assert.deepEqual([env.events, env.revealed], [[], []]);
  assert.deepEqual(await names(env.service), ['broken'], 'still listed: nothing was set aside');

  // The boards folder itself swapped for a junction to a folder outside it.
  const second = setup(t);
  const other = await withFiles(second, 'other');
  breakDocument(second, other, 'corrupt');
  second.restart();
  assert.deepEqual(await names(second.service), ['other']);
  const movedDir = path.join(second.root, 'moved-boards');
  fs.renameSync(second.dir, movedDir);
  fs.symlinkSync(movedDir, second.dir, 'junction');
  const inside = fs.readdirSync(movedDir).sort();
  assert.deepEqual(await second.aside.setAside({ boardId: other.id }), { ok: false, reason: 'io' });
  assert.deepEqual(await second.aside.reveal({ boardId: other.id }), { ok: false, reason: 'io' });
  assert.deepEqual(fs.readdirSync(movedDir).sort(), inside);
  assert.deepEqual(second.revealed, []);
});

test('a document that is a file symlink is neither moved nor revealed', async (t) => {
  const env = setup(t);
  const broken = await withFiles(env, 'broken');
  breakDocument(env, broken, 'corrupt');
  env.restart();
  assert.deepEqual(await names(env.service), ['broken']);
  const target = path.join(env.root, 'outside.json');
  fs.renameSync(env.file(`${broken.id}.json`), target);
  try {
    fs.symlinkSync(target, env.file(`${broken.id}.json`), 'file');
  } catch (error) {
    t.skip(`a file symlink needs Developer Mode or admin rights on Windows (${error.code}); the junction cases cover links here`);
    return;
  }
  const before = snapshot(env);
  assert.deepEqual(await env.aside.setAside({ boardId: broken.id }), { ok: false, reason: 'io' });
  assert.deepEqual(await env.aside.reveal({ boardId: broken.id }), { ok: false, reason: 'io' });
  assert.deepEqual(snapshot(env), before);
  assert.equal(fs.readFileSync(target, 'utf8'), CORRUPT_BYTES);
  assert.deepEqual(env.revealed, []);
});

test('a second aside in the same millisecond gets a distinct name; ten taken names answer io and move nothing', async (t) => {
  const env = setup(t);
  const broken = await withFiles(env, 'broken');
  breakDocument(env, broken, 'corrupt');
  env.restart();
  const first = await env.aside.setAside({ boardId: broken.id });
  assert.deepEqual(first, { ok: true, movedTo: `${broken.id}.json.aside-${T0}` });
  // The same document comes back (a restored backup) and is set aside again in the same millisecond.
  fs.writeFileSync(env.file(`${broken.id}.json`), 'again');
  env.restart();
  assert.deepEqual(await names(env.service, GENERAL), [broken.id], 'listed again by its file name');
  assert.deepEqual(await env.aside.setAside({ boardId: broken.id }), { ok: true, movedTo: `${broken.id}.json.aside-${T0}-1` });
  assert.equal(fs.readFileSync(env.file(`${broken.id}.json.aside-${T0}`), 'utf8'), CORRUPT_BYTES, 'the first aside file is not overwritten');
  assert.equal(fs.readFileSync(env.file(`${broken.id}.json.aside-${T0}-1`), 'utf8'), 'again');

  for (let n = 2; n <= 9; n += 1) fs.writeFileSync(env.file(`${broken.id}.json.aside-${T0}-${n}`), `taken ${n}`);
  fs.writeFileSync(env.file(`${broken.id}.json`), 'third');
  env.restart();
  assert.deepEqual(await names(env.service, GENERAL), [broken.id], 'the index is rebuilt before the snapshot');
  const before = snapshot(env);
  env.events.length = 0;
  assert.deepEqual(await env.aside.setAside({ boardId: broken.id }), { ok: false, reason: 'io' });
  assert.deepEqual(snapshot(env), before);
  assert.deepEqual(env.events, []);
  assert.deepEqual(await names(env.service, GENERAL), [broken.id]);
});

test('a document rename that fails changes nothing; a later step that fails answers partial with the entry gone', async (t) => {
  const env = setup(t);
  const broken = await withFiles(env, 'broken');
  breakDocument(env, broken, 'corrupt');
  env.restart();
  assert.deepEqual(await names(env.service), ['broken']);
  const before = snapshot(env);
  const realRename = fs.renameSync;
  const failWhen = (test) => t.mock.method(fs, 'renameSync', (from, to) => {
    if (test(String(from), String(to))) throw Object.assign(new Error('disk gone'), { code: 'EIO' });
    return realRename(from, to);
  });
  let mock = failWhen((from) => from.endsWith(`${broken.id}.json`));
  assert.deepEqual(await env.aside.setAside({ boardId: broken.id }), { ok: false, reason: 'io' });
  mock.mock.restore();
  assert.deepEqual(snapshot(env), before);
  assert.deepEqual(env.events.filter((event) => event.kind === 'deleted'), []);
  assert.deepEqual(await names(env.service), ['broken']);

  // The journal will not move: the document is aside, the proposals follow, the entry still leaves.
  mock = failWhen((from) => from.endsWith('.journal.json'));
  const answer = await env.aside.setAside({ boardId: broken.id });
  mock.mock.restore();
  assert.deepEqual(answer, { ok: true, movedTo: `${broken.id}.json.aside-${T0}`, partial: true });
  assert.equal(fs.existsSync(env.file(`${broken.id}.json`)), false);
  assert.equal(fs.existsSync(env.file(`${broken.id}.journal.json`)), true, 'the journal stays where it was');
  assert.equal(fs.existsSync(env.file(`${broken.id}.proposals.json.aside-${T0}`)), true);
  assert.equal(indexed(env)[broken.id], undefined);
  assert.deepEqual(await names(env.service), []);
  env.restart();
  assert.deepEqual(await names(env.service), [], 'it does not come back half-present');
});

test('an index write that fails after the move answers partial; a restart does not list the board', async (t) => {
  const env = setup(t);
  const broken = await withFiles(env, 'broken');
  breakDocument(env, broken, 'corrupt');
  env.restart();
  assert.deepEqual(await names(env.service), ['broken']);
  const realRename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('index.json')) throw Object.assign(new Error('disk gone'), { code: 'EIO' });
    return realRename(from, to);
  });
  const answer = await env.aside.setAside({ boardId: broken.id });
  mock.mock.restore();
  assert.deepEqual(answer, { ok: true, movedTo: `${broken.id}.json.aside-${T0}`, partial: true });
  assert.ok(indexed(env)[broken.id], 'the stale entry is still in the file');
  assert.deepEqual(await names(env.service), []);
  env.restart();
  assert.deepEqual(await names(env.service), [], 'the document is gone, so the restart drops the stale entry');
});

test('revealFile hands revealPath the absolute path of <id>.json in the boards folder, whatever else the caller sends', async (t) => {
  const env = setup(t);
  const broken = await withFiles(env, 'broken');
  breakDocument(env, broken, 'newer');
  env.restart();
  const before = snapshot(env);
  const sneaky = { boardId: broken.id, path: 'C:\\Windows\\System32', root: env.root, file: '../index.json', __proto__: { path: '/etc' } };
  assert.deepEqual(await env.aside.reveal(sneaky), { ok: true });
  assert.deepEqual(env.revealed, [path.join(env.dir, `${broken.id}.json`)]);
  assert.equal(path.isAbsolute(env.revealed[0]), true);
  assert.equal(path.dirname(fs.realpathSync.native(env.revealed[0])), fs.realpathSync.native(env.dir));
  assert.deepEqual(snapshot(env), before, 'showing the file changes nothing');
  const broke = createBoardSetAside({ store: env.store, service: env.service, revealPath: () => { throw new Error('no shell'); } });
  assert.deepEqual(await broke.reveal({ boardId: broken.id }), { ok: false, reason: 'io' });
});

test('the orphaned-temp cleanup and the backup and restore name filters leave an aside file alone', async (t) => {
  const env = setup(t);
  const broken = await withFiles(env, 'broken');
  breakDocument(env, broken, 'corrupt');
  env.restart();
  assert.equal((await env.aside.setAside({ boardId: broken.id })).ok, true);
  const aside = ownFiles(broken.id).map((name) => `${name}.aside-${T0}`);
  for (const name of aside) {
    assert.equal(ids.isBoardFileName(name), false, `${name} is not a live board file (restore keeps only those)`);
    assert.equal(ids.parseBoardFileName(name), null);
  }
  const temp = `${broken.id}.json.1760000000000.0123456789ab.tmp`;
  fs.writeFileSync(env.file(temp), '{}');
  const pruned = await pruneOrphanedProfileTemps({ profileRoot: env.userDataPath, now: T0 + 30 * 24 * 60 * 60 * 1000, minAgeMs: 0 });
  assert.deepEqual(pruned.deleted.map((item) => item.file), [temp], 'the cleanup ran and took only the temp');
  for (const name of aside) assert.equal(fs.existsSync(env.file(name)), true, `${name} is left alone`);
});
