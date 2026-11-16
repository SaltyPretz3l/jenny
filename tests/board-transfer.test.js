'use strict';

// new-test-file: a new surface (row 150 slice B10): export and import of .jennyboard files in the main process
// (services/boards/board-transfer.js) over a real board service, store and picture store in a temp profile, with an
// injected dialog so no window opens.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const model = require('../services/boards/board-model');
const { createBoardStore } = require('../services/boards/board-store');
const { createBoardService } = require('../services/boards/board-service');
const { createBoardAssetStore } = require('../services/boards/board-assets');
const { pack, unpack } = require('../services/boards/board-package');
const { createBoardTransfer } = require('../services/boards/board-transfer');

const T0 = Date.parse('2026-11-13T10:00:00.000Z');
const PROJECT = 'project_alpha';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function gif(width, height) {
  const out = Buffer.from('474946383961000000008000000000ffffff2c000000000100010000020244010003b', 'hex');
  out.writeUInt16LE(width, 6);
  out.writeUInt16LE(height, 8);
  return out;
}

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-board-transfer-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function env(t, { fsImpl = fs, maxBytes } = {}) {
  const userDataPath = tempDir(t, 'profile');
  const out = tempDir(t, 'out');
  const e = { userDataPath, out, seq: 100, logs: [], dialogs: [], save: null, open: null };
  e.store = createBoardStore({ userDataPath });
  e.service = createBoardService({ store: e.store, now: () => new Date(T0), makeId: () => uid(++e.seq), projectExists: (id) => id !== 'project_gone' });
  e.assets = createBoardAssetStore({ userDataPath });
  e.events = [];
  e.service.on('changed', (event) => e.events.push(event));
  const dialog = {
    showSaveDialog: async (options) => { e.dialogs.push(['save', options]); return e.save || { canceled: true }; },
    showOpenDialog: async (options) => { e.dialogs.push(['open', options]); return e.open || { canceled: true, filePaths: [] }; },
  };
  e.transfer = createBoardTransfer({
    getService: () => e.service, getAssets: () => e.assets, dialog, fs: fsImpl, now: () => new Date(T0),
    makeId: () => crypto.randomUUID(), logger: (...args) => e.logs.push(args), protectedRoots: () => [userDataPath],
    ...(maxBytes ? { maxBytes } : {}),
  });
  e.saveTo = (name) => { e.save = { canceled: false, filePath: path.join(out, name) }; };
  e.openFrom = (filePath) => { e.open = { canceled: false, filePaths: [filePath] }; };
  return e;
}

async function boardWith(e, name, ops = []) {
  const board = (await e.service.create({ projectId: PROJECT, name })).board;
  if (ops.length) {
    const applied = await e.service.apply({ boardId: board.id, batch: { batch_id: `seed-${board.id}`, board_id: board.id, ops } });
    assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 300));
  }
  return board;
}

const picCard = (n, asset) => ({ op: 'card.add', card: { id: uid(n), kind: 'image', data: { asset, width: 1, height: 1, alt: 'Picture' }, x: n * 100, y: 0 } });
const noteCard = (n, text) => ({ op: 'card.add', card: { id: uid(n), kind: 'note', data: { text }, x: n * 100, y: 300 } });

test('export writes one .jennyboard file whose text unpacks, and names it after the board', async (t) => {
  const e = env(t);
  const stored = e.assets.add(gif(2, 2));
  const board = await boardWith(e, 'Plan: Q4/next?', [picCard(1, stored.asset), noteCard(2, 'Hello')]);
  e.saveTo('plan.jennyboard');
  const result = await e.transfer.exportFile({ boardId: board.id });
  assert.deepEqual(result, { ok: true, name: 'plan.jennyboard' });
  assert.deepEqual(fs.readdirSync(e.out), ['plan.jennyboard'], 'one file, no temp left');
  const [kind, options] = e.dialogs[0];
  assert.equal(kind, 'save');
  assert.equal(path.basename(options.defaultPath), 'Plan Q4 next.jennyboard', 'the name made safe for a file name');
  assert.deepEqual(options.filters[0].extensions, ['jennyboard']);
  const text = fs.readFileSync(path.join(e.out, 'plan.jennyboard'), 'utf8');
  const back = unpack(text, { makeId: () => crypto.randomUUID(), now: '2026-11-13T11:00:00.000Z', projectId: PROJECT, newBoardId: `board_${uid(900)}` });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.pictures.length, 1);
  assert.equal(sha(Buffer.from(back.pictures[0].bytes)), stored.asset);
  assert.ok(e.logs.every((entry) => !JSON.stringify(entry).includes('Plan')), 'no board text reaches a log line');
});

test('a picture that cannot be read is left out and counted; a missing or unknown board is refused before any dialog', async (t) => {
  const e = env(t);
  const board = await boardWith(e, 'Pictures', [picCard(1, 'a'.repeat(64))]);
  e.saveTo('pictures.jennyboard');
  assert.deepEqual(await e.transfer.exportFile({ boardId: board.id }), { ok: true, name: 'pictures.jennyboard', missingPictures: 1 });
  e.dialogs.length = 0;
  assert.deepEqual(await e.transfer.exportFile({ boardId: `board_${uid(404)}` }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await e.transfer.exportFile({ boardId: 'board_nope' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(e.dialogs, []);
});

test('a cancelled dialog writes nothing; a failed write leaves no temp file; a folder inside the profile is refused', async (t) => {
  const e = env(t);
  const board = await boardWith(e, 'Plan', [noteCard(1, 'x')]);
  e.save = { canceled: true };
  assert.deepEqual(await e.transfer.exportFile({ boardId: board.id }), { ok: false, reason: 'cancelled' });
  assert.deepEqual(fs.readdirSync(e.out), []);

  const failing = env(t, { fsImpl: { ...fs, renameSync: () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } } });
  const other = await boardWith(failing, 'Plan', [noteCard(1, 'x')]);
  failing.saveTo('plan.jennyboard');
  assert.deepEqual(await failing.transfer.exportFile({ boardId: other.id }), { ok: false, reason: 'io' });
  assert.deepEqual(fs.readdirSync(failing.out), [], 'the temp file was removed');
  assert.ok(failing.logs.some(([, event, data]) => event === 'boards.export_failed' && data.code === 'EBUSY'));

  e.save = { canceled: false, filePath: path.join(e.userDataPath, 'boards', 'x.jennyboard') };
  assert.deepEqual(await e.transfer.exportFile({ boardId: board.id }), { ok: false, reason: 'protected' });
  assert.equal(fs.existsSync(path.join(e.userDataPath, 'boards', 'x.jennyboard')), false);
});

test('import of an exported file creates a second board with a fresh history, emits created once and stores its pictures', async (t) => {
  const e = env(t);
  const stored = e.assets.add(gif(3, 1));
  const board = await boardWith(e, 'Plan', [picCard(1, stored.asset), noteCard(2, 'Hello'),
    { op: 'connector.add', connector: { id: uid(3), from: uid(1), to: uid(2), label: 'see' } }]);
  e.saveTo('plan.jennyboard');
  assert.equal((await e.transfer.exportFile({ boardId: board.id })).ok, true);
  e.assets.remove(stored.asset);
  e.events.length = 0;
  e.openFrom(path.join(e.out, 'plan.jennyboard'));
  const result = await e.transfer.importFile({ projectId: PROJECT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.skippedPictures, 0);
  assert.equal(result.board.name, 'Plan (imported)', 'the name is taken: " (imported)" is appended');
  assert.notEqual(result.board.id, board.id);
  assert.deepEqual(e.events.map((event) => [event.kind, event.boardId]), [['created', result.board.id]]);
  assert.equal(e.assets.read(stored.asset).ok, true, 'the picture is back in the store');
  const listed = await e.service.list({ projectId: PROJECT });
  assert.deepEqual(listed.boards.map((b) => b.name), ['Plan', 'Plan (imported)']);
  const got = await e.service.get({ boardId: result.board.id });
  assert.deepEqual([got.canUndo, got.canRedo, got.board.rev], [false, false, 0]);
  assert.equal(e.store.readJournal(result.board.id).status, 'missing', 'no journal');
  assert.equal(e.store.readProposals(result.board.id).status, 'missing', 'no proposals');
  const [kind, options] = e.dialogs.at(-1);
  assert.equal(kind, 'open');
  assert.deepEqual(options.properties, ['openFile']);
  assert.deepEqual(options.filters[0].extensions, ['jennyboard']);
  const again = await e.transfer.importFile({ projectId: PROJECT });
  assert.equal(again.board.name, 'Plan (imported) 2');
  assert.ok(e.logs.every((entry) => !JSON.stringify(entry).includes('Hello') && !JSON.stringify(entry).includes('Plan')));
});

test('pictures: an SVG or HTML picture is skipped and counted, the board still imports, and a picture is stored under its real hash only', async (t) => {
  const e = env(t);
  const named = gif(4, 4);
  const actual = gif(5, 5);
  const source = model.createBoard({ id: `board_${uid(1)}`, project_id: PROJECT, name: 'Hostile', now: '2026-11-13T09:00:00.000Z' }).board;
  const applied = model.applyBatch(source, { batch_id: 's', board_id: source.id, actor: 'owner', ops: [picCard(1, sha(named))] }, { now: '2026-11-13T09:00:00.000Z', authority: true });
  const packed = pack({ board: applied.board, assets: [{ ext: 'gif', bytes: actual }], now: '2026-11-13T09:00:00.000Z' });
  const value = JSON.parse(packed.text);
  value.assets.push({ ext: 'png', base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64') });
  value.assets.push({ ext: 'gif', base64: Buffer.from('<html><body>hi</body></html>').toString('base64') });
  const file = path.join(e.out, 'hostile.jennyboard');
  fs.writeFileSync(file, JSON.stringify(value));
  e.openFrom(file);
  const result = await e.transfer.importFile({ projectId: PROJECT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.skippedPictures, 2);
  assert.deepEqual(e.assets.list().map((entry) => entry.asset), [sha(actual)], 'stored under the hash of its bytes');
  assert.equal(e.assets.read(sha(named)).ok, false, 'the name in the card is not a picture here');
  const got = await e.service.get({ boardId: result.board.id });
  assert.equal(Object.values(got.board.cards)[0].data.asset, sha(named), 'the card stays and says it cannot be shown');
});

test('over the board cap: limit, and no picture is stored; a project that is gone: not_found', async (t) => {
  const e = env(t);
  const stored = e.assets.add(gif(6, 6));
  const first = await boardWith(e, 'B0', [picCard(1, stored.asset)]);
  e.saveTo('b0.jennyboard');
  assert.equal((await e.transfer.exportFile({ boardId: first.id })).ok, true);
  e.assets.remove(stored.asset);
  for (let i = 1; i < model.LIMITS.boards_per_project; i += 1) await boardWith(e, `B${i}`);
  e.openFrom(path.join(e.out, 'b0.jennyboard'));
  assert.deepEqual(await e.transfer.importFile({ projectId: PROJECT }), { ok: false, reason: 'limit', limit: 'boards_per_project' });
  assert.deepEqual(e.assets.list(), [], 'no picture stored');
  assert.deepEqual(await e.transfer.importFile({ projectId: 'project_gone' }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await e.transfer.importFile({ projectId: 'not a project' }), { ok: false, reason: 'invalid' });
});

test('a cancelled open dialog, a directory, a link and a file that is not a board are refused', async (t) => {
  const e = env(t);
  assert.deepEqual(await e.transfer.importFile({ projectId: PROJECT }), { ok: false, reason: 'cancelled' });
  e.openFrom(e.out);
  assert.deepEqual(await e.transfer.importFile({ projectId: PROJECT }), { ok: false, reason: 'not_file' });
  const text = path.join(e.out, 'notes.jennyboard');
  fs.writeFileSync(text, 'just some notes');
  e.openFrom(text);
  assert.deepEqual(await e.transfer.importFile({ projectId: PROJECT }), { ok: false, reason: 'not_json' });
  const link = path.join(e.out, 'link.jennyboard');
  try {
    fs.symlinkSync(tempDir(t, 'target'), link, 'junction');
  } catch (error) {
    t.skip(`this machine cannot make a junction (${error.code})`);
    return;
  }
  e.openFrom(link);
  assert.deepEqual(await e.transfer.importFile({ projectId: PROJECT }), { ok: false, reason: 'not_file' });
  assert.equal((await e.service.list({ projectId: PROJECT })).boards.length, 0);
});

test('the size cap: refused from stat before reading, and a file that grew past it is refused on the bytes actually read', async (t) => {
  let reads = 0;
  const counting = { ...fs, readSync: (...args) => { reads += 1; return fs.readSync(...args); } };
  const big = env(t, { fsImpl: counting, maxBytes: 64 });
  const file = path.join(big.out, 'big.jennyboard');
  fs.writeFileSync(file, 'x'.repeat(200));
  big.openFrom(file);
  assert.deepEqual(await big.transfer.importFile({ projectId: PROJECT }), { ok: false, reason: 'too_large' });
  assert.equal(reads, 0, 'refused from its stat');

  const small = (stat) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 10 });
  const lying = { ...counting, lstatSync: (p) => small(fs.lstatSync(p)), fstatSync: (fd) => small(fs.fstatSync(fd)) };
  const grown = env(t, { fsImpl: lying, maxBytes: 64 });
  grown.openFrom(file);
  assert.deepEqual(await grown.transfer.importFile({ projectId: PROJECT }), { ok: false, reason: 'too_large' });
  assert.ok(reads > 0, 'read, and refused on what was read');
  assert.ok(grown.logs.some(([, event, data]) => event === 'boards.import_refused' && data.reason === 'too_large'));
});
