'use strict';

// The project board store (plan PROJECT_BOARD_2026-11-13, section 6.4): flat files under
// <userData>/boards/, ids checked before any path is formed, persist-then-swap writes, reads that
// never follow a link, size caps before parsing, and removal that never follows a link.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require('../services/boards/board-model');
const ids = require('../services/boards/board-ids');
const { createBoardStore } = require('../services/boards/board-store');

const ID = 'board_00000000-0000-4000-8000-000000000001';
const ID2 = 'board_00000000-0000-4000-8000-000000000002';
const NOW = '2026-11-13T10:00:00.000Z';
const BAD_IDS = ['../x', 'C:\\Windows\\win.ini', 'board_123', '__proto__', 'board_../../x', '', null, 42,
  'BOARD_00000000-0000-4000-8000-000000000001', `${ID}/../x`, `${ID}.json`];

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'profile');
  fs.mkdirSync(userDataPath);
  return { root, userDataPath, store: createBoardStore({ userDataPath }) };
}
function board(id = ID, name = 'Plan') {
  return M.createBoard({ id, project_id: 'project_alpha', name, now: NOW }).board;
}
function junction(target, at, t) {
  try {
    fs.symlinkSync(target, at, 'junction');
    return true;
  } catch (error) {
    t.skip(`this platform cannot make a directory link here (${error.code})`);
    return false;
  }
}

test('the shared ids: schema version and board id pattern agree with the model', () => {
  assert.equal(ids.BOARD_SCHEMA_VERSION, M.SCHEMA_VERSION);
  assert.equal(ids.BOARDS_DIR, 'boards');
  for (const candidate of [ID, ...BAD_IDS]) {
    const modelSays = M.createBoard({ id: candidate, project_id: 'project_alpha', name: 'x', now: NOW }).ok;
    assert.equal(ids.isBoardId(candidate), modelSays, String(candidate));
  }
  assert.equal(ids.isBoardFileName(`${ID}.json`), true);
  assert.equal(ids.isBoardFileName(`${ID}.journal.json`), true);
  assert.equal(ids.isBoardFileName(`${ID}.proposals.json`), true);
  assert.equal(ids.isBoardFileName('index.json'), true);
  assert.equal(ids.isBoardFileName('board_123.json'), false);
  assert.equal(ids.isBoardFileName(`${ID}.json.1760000000000.0123456789ab.tmp`), false);
});

test('an id that fails the pattern is refused before any path is formed', (t) => {
  const { userDataPath } = sandbox(t);
  const made = [];
  const store = createBoardStore({ userDataPath, fileStoreFactory: (file) => { made.push(file); throw new Error('no store'); } });
  const join = t.mock.method(path, 'join');
  const calls = [
    (id) => store.readDocument(id), (id) => store.writeDocument(id, {}), (id) => store.readJournal(id),
    (id) => store.writeJournal(id, {}), (id) => store.readProposals(id), (id) => store.writeProposals(id, []),
    (id) => store.removeBoardFiles(id), (id) => store.documentPath(id), (id) => store.setAsideFiles(id, 1),
  ];
  for (const badId of BAD_IDS) {
    for (const call of calls) assert.throws(() => call(badId), /invalid board id/, String(badId));
  }
  assert.equal(join.mock.callCount(), 0);
  assert.deepEqual(made, []);
  assert.equal(fs.existsSync(path.join(userDataPath, 'boards')), false);
});

test('a document round-trips as compact JSON at <userData>/boards/<board_id>.json', (t) => {
  const { userDataPath, store } = sandbox(t);
  assert.equal(store.root, path.join(userDataPath, 'boards'));
  assert.deepEqual(store.readDocument(ID), { status: 'missing', value: null });
  store.writeDocument(ID, board());
  const raw = fs.readFileSync(path.join(userDataPath, 'boards', `${ID}.json`), 'utf8');
  assert.equal(raw, JSON.stringify(board()));
  assert.deepEqual(store.readDocument(ID), { status: 'ok', value: board() });
});

test('a write that fails mid-way leaves the previous document and no temp file', (t) => {
  const { userDataPath, store } = sandbox(t);
  store.writeDocument(ID, board(ID, 'Before'));
  const rename = t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('disk gone'), { code: 'EIO' }); });
  assert.throws(() => store.writeDocument(ID, board(ID, 'After')), /disk gone/);
  rename.mock.restore();
  assert.equal(store.readDocument(ID).value.name, 'Before');
  assert.deepEqual(fs.readdirSync(path.join(userDataPath, 'boards')), [`${ID}.json`]);
});

test('corrupt and oversized files are reported, never touched', (t) => {
  const { userDataPath, store } = sandbox(t);
  const dir = path.join(userDataPath, 'boards');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${ID}.json`), '{"schema_version":1, broken');
  assert.equal(store.readDocument(ID).status, 'corrupt');
  assert.equal(fs.readFileSync(path.join(dir, `${ID}.json`), 'utf8'), '{"schema_version":1, broken');
  fs.writeFileSync(path.join(dir, `${ID2}.json`), `"${'x'.repeat(store.limits.documentReadBytes)}"`);
  assert.equal(store.readDocument(ID2).status, 'too_large');
  fs.writeFileSync(path.join(dir, 'index.json'), 'nope');
  assert.equal(store.readIndex().status, 'corrupt');
});

test('journal, proposals and index round-trip; proposals stay within 20 entries and 512 KiB', (t) => {
  const { userDataPath, store } = sandbox(t);
  const journal = { schema_version: 1, board_id: ID, entries: [{ batch_id: 'b1', inverse: { ops: [] } }] };
  store.writeJournal(ID, journal);
  assert.deepEqual(store.readJournal(ID), { status: 'ok', value: journal });
  assert.equal(fs.existsSync(path.join(userDataPath, 'boards', `${ID}.journal.json`)), true);
  store.writeProposals(ID, [{ id: 'p1' }]);
  assert.deepEqual(store.readProposals(ID).value, [{ id: 'p1' }]);
  assert.throws(() => store.writeProposals(ID, Array.from({ length: M.LIMITS.proposals + 1 }, (_, i) => ({ id: `p${i}` }))), /proposals_limit/);
  assert.throws(() => store.writeProposals(ID, [{ text: 'x'.repeat(M.LIMITS.proposals_bytes) }]), /proposals_limit/);
  assert.throws(() => store.writeProposals(ID, { not: 'a list' }), /proposals_limit/);
  assert.deepEqual(store.readProposals(ID).value, [{ id: 'p1' }]);
  assert.equal(store.readIndex().status, 'missing');
  store.writeIndex({ schema_version: 1, boards: {} });
  assert.deepEqual(store.readIndex().value, { schema_version: 1, boards: {} });
});

test('listDocumentIds names only board documents, never temps, sidecar files, junk, folders or links', (t) => {
  const { root, userDataPath, store } = sandbox(t);
  assert.deepEqual(store.listDocumentIds(), []);
  store.writeDocument(ID, board());
  store.writeJournal(ID2, { entries: [] });
  const dir = path.join(userDataPath, 'boards');
  fs.writeFileSync(path.join(dir, `${ID2}.json.1760000000000.0123456789ab.tmp`), '{}');
  fs.writeFileSync(path.join(dir, 'board_123.json'), '{}');
  fs.mkdirSync(path.join(dir, 'board_00000000-0000-4000-8000-000000000003.json'));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(dir, 'board_00000000-0000-4000-8000-000000000004.json'), 'junction');
  assert.deepEqual(store.listDocumentIds().map((entry) => entry.id), [ID]);
  assert.equal(typeof store.listDocumentIds()[0].mtimeMs, 'number');
});

test('removal deletes the three files of a board and nothing else', (t) => {
  const { userDataPath, store } = sandbox(t);
  store.writeDocument(ID, board());
  store.writeJournal(ID, { entries: [] });
  store.writeProposals(ID, []);
  store.writeDocument(ID2, board(ID2));
  assert.deepEqual(store.removeBoardFiles(ID), { ok: true, failed: [] });
  assert.deepEqual(fs.readdirSync(path.join(userDataPath, 'boards')), [`${ID2}.json`]);
  assert.deepEqual(store.removeBoardFiles(ID), { ok: true, failed: [] }, 'removing what is gone is fine');
});

test('a link planted at a board file is unlinked on removal, never followed, and never read through', (t) => {
  const { root, userDataPath, store } = sandbox(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched');
  fs.mkdirSync(path.join(userDataPath, 'boards'));
  if (!junction(outside, path.join(userDataPath, 'boards', `${ID}.json`), t)) return;
  assert.equal(store.readDocument(ID).status, 'link');
  assert.deepEqual(store.removeBoardFiles(ID), { ok: true, failed: [] });
  assert.equal(fs.existsSync(path.join(userDataPath, 'boards', `${ID}.json`)), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'untouched');
});

test('a link planted at the boards directory is refused for reads, writes and removal', (t) => {
  const { root, userDataPath, store } = sandbox(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, `${ID}.json`), JSON.stringify(board()));
  if (!junction(outside, path.join(userDataPath, 'boards'), t)) return;
  assert.equal(store.readDocument(ID).status, 'link');
  assert.equal(store.readIndex().status, 'link');
  assert.deepEqual(store.listDocumentIds(), []);
  assert.throws(() => store.writeDocument(ID2, board(ID2)), /boards_root_unsafe/);
  assert.deepEqual(store.removeBoardFiles(ID), { ok: false, failed: ['root'] });
  assert.deepEqual(fs.readdirSync(outside), [`${ID}.json`]);
});

test('set aside (slice B11) renames the three files of a board to <name>.aside-<ms> by rename only, and reports what stayed', (t) => {
  const { userDataPath, store } = sandbox(t);
  const dir = path.join(userDataPath, 'boards');
  assert.equal(store.documentPath(ID), null, 'no folder yet');
  assert.equal(store.setAsideFiles(ID, 5), null);
  store.writeDocument(ID, board());
  store.writeJournal(ID, { entries: [] });
  store.writeDocument(ID2, board(ID2));
  assert.equal(store.documentPath(ID), path.join(dir, `${ID}.json`));
  const copies = t.mock.method(fs, 'copyFileSync');
  assert.deepEqual(store.setAsideFiles(ID, 5), { movedTo: `${ID}.json.aside-5`, failed: [] }, 'no proposals file: nothing to move, nothing failed');
  assert.equal(copies.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${ID}.journal.json.aside-5`, `${ID}.json.aside-5`, `${ID2}.json`].sort());
  assert.equal(store.documentPath(ID), null, 'gone from its live name');
  for (const stamp of [-1, 1.5, '5', NaN]) assert.equal(store.setAsideFiles(ID2, stamp), null, String(stamp));
  // The journal's aside name is taken: it stays, and is named.
  store.writeJournal(ID2, { entries: [] });
  fs.writeFileSync(path.join(dir, `${ID2}.journal.json.aside-9`), 'older');
  assert.deepEqual(store.setAsideFiles(ID2, 9), { movedTo: `${ID2}.json.aside-9`, failed: ['journal'] });
  assert.equal(fs.readFileSync(path.join(dir, `${ID2}.journal.json.aside-9`), 'utf8'), 'older');
  assert.equal(fs.existsSync(path.join(dir, `${ID2}.journal.json`)), true);
});

test('set aside and the document path refuse a link at the document or the boards folder', (t) => {
  const { root, userDataPath, store } = sandbox(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(userDataPath, 'boards'));
  if (!junction(outside, path.join(userDataPath, 'boards', `${ID}.json`), t)) return;
  assert.equal(store.documentPath(ID), null);
  assert.equal(store.setAsideFiles(ID, 5), null);
  assert.deepEqual(fs.readdirSync(path.join(userDataPath, 'boards')), [`${ID}.json`]);
  fs.writeFileSync(path.join(outside, `${ID2}.json`), JSON.stringify(board(ID2)));
  fs.renameSync(path.join(userDataPath, 'boards'), path.join(root, 'old-boards'));
  if (!junction(outside, path.join(userDataPath, 'boards'), t)) return;
  assert.equal(store.documentPath(ID2), null);
  assert.equal(store.setAsideFiles(ID2, 5), null);
  assert.deepEqual(fs.readdirSync(outside), [`${ID2}.json`]);
});
