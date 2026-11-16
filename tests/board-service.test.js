'use strict';

// The project board service (plan PROJECT_BOARD_2026-11-13, sections 6.3, 6.4 and D13): the boards API
// of boards-api.md over the real store in a temp profile, with an injected clock and id maker.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require('../services/boards/board-model');
const { createBoardStore } = require('../services/boards/board-store');
const { createBoardService, PURGE_AFTER_MS } = require('../services/boards/board-service');

const T0 = Date.parse('2026-11-13T10:00:00.000Z');
const ALPHA = 'project_alpha';
const GENERAL = 'project_general';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup(t, { enabled = true, projects = [ALPHA, GENERAL], wrapStore = (s) => s, journalCaps } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { root, userDataPath: path.join(root, 'profile'), clock: T0, seq: 1000, events: [], enabled };
  fs.mkdirSync(env.userDataPath);
  env.make = () => {
    const service = createBoardService({
      store: wrapStore(createBoardStore({ userDataPath: env.userDataPath })),
      now: () => new Date(env.clock),
      makeId: () => uid(++env.seq),
      isEnabled: () => env.enabled,
      projectExists: (id) => projects.includes(id),
      journalCaps,
    });
    service.on('changed', (event) => env.events.push(event));
    return service;
  };
  env.service = env.make();
  env.file = (name) => path.join(env.userDataPath, 'boards', name);
  return env;
}
async function created(service, projectId = ALPHA, name = 'Plan') {
  const r = await service.create({ projectId, name });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.board;
}
let batchSeq = 0;
const batch = (boardId, ops, extra = {}) => ({ batch_id: `b${++batchSeq}`, board_id: boardId, actor: 'mallory', ops, ...extra });
const note = (n, text = `note ${n}`) => ({ op: 'card.add', card: { id: uid(n), kind: 'note', data: { text }, x: n * 10, y: 0 } });
async function applied(service, boardId, ops) {
  const r = await service.apply({ boardId, batch: batch(boardId, ops) });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  return r;
}
function countingStore(counts) {
  return (store) => Object.fromEntries(Object.entries(store).map(([name, value]) => [name, typeof value !== 'function' ? value
    : (...args) => { counts[name] = (counts[name] || 0) + 1; return value(...args); }]));
}

test('with the flag off every call resolves disabled and nothing touches the store', async (t) => {
  const counts = {};
  const { service, userDataPath } = setup(t, { enabled: false, wrapStore: countingStore(counts) });
  const id = `board_${uid(1)}`;
  const calls = [
    service.list({ projectId: ALPHA }), service.create({ projectId: ALPHA, name: 'x' }), service.get({ boardId: id }),
    service.apply({ boardId: id, batch: batch(id, [note(1)]) }), service.undo({ boardId: id }), service.redo({ boardId: id }),
    service.rename({ boardId: id, name: 'y' }), service.duplicate({ boardId: id, name: 'z' }), service.delete({ boardId: id }),
    service.restore({ boardId: id }), service.moveProjectBoards(ALPHA),
  ];
  for (const r of await Promise.all(calls)) assert.deepEqual(r, { ok: false, reason: 'disabled' });
  assert.deepEqual(counts, {});
  assert.equal(fs.existsSync(path.join(userDataPath, 'boards')), false);
});

test('create, list and get: the happy path and the created event', async (t) => {
  const env = setup(t);
  const board = await created(env.service, ALPHA, 'Auth redesign');
  assert.match(board.id, /^board_[0-9a-f-]{36}$/);
  assert.equal(board.project_id, ALPHA);
  assert.equal(board.created_at, '2026-11-13T10:00:00.000Z');
  assert.deepEqual(await env.service.list({ projectId: ALPHA }), { ok: true, boards: [
    { id: board.id, project_id: ALPHA, name: 'Auth redesign', rev: 0, created_at: board.created_at, updated_at: board.updated_at },
  ] });
  assert.deepEqual(await env.service.list({ projectId: GENERAL }), { ok: true, boards: [] });
  assert.deepEqual(await env.service.get({ boardId: board.id }), { ok: true, board, readOnly: false, canUndo: false, canRedo: false });
  assert.deepEqual(env.events, [{ boardId: board.id, projectId: ALPHA, kind: 'created', rev: 0 }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(env.file(`${board.id}.json`), 'utf8')), board);
});

test('bad arguments are invalid, unknown boards are not_found, unknown projects are refused', async (t) => {
  const { service } = setup(t);
  const id = `board_${uid(1)}`;
  for (const args of [undefined, null, [], {}, { projectId: ALPHA, extra: 1 }, { projectId: '../x' }, { projectId: { toString: () => ALPHA } }]) {
    assert.equal((await service.list(args)).reason, 'invalid', JSON.stringify(args));
  }
  assert.equal((await service.create({ projectId: ALPHA })).reason, 'invalid');
  assert.equal((await service.create({ projectId: ALPHA, name: '' })).reason, 'invalid');
  assert.equal((await service.create({ projectId: ALPHA, name: 'x'.repeat(201) })).reason, 'invalid');
  assert.equal((await service.create({ projectId: ALPHA, name: 'x', admin: true })).reason, 'invalid');
  assert.equal((await service.create({ projectId: 'project_gone', name: 'x' })).reason, 'not_found');
  for (const boardId of ['../x', 'C:\\x', 'board_1', '__proto__']) {
    assert.equal((await service.get({ boardId })).reason, 'invalid', boardId);
    assert.equal((await service.apply({ boardId, batch: batch(boardId, [note(1)]) })).reason, 'invalid', boardId);
  }
  assert.deepEqual(await service.get({ boardId: id }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await service.apply({ boardId: id, batch: batch(id, [note(1)]) }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await service.undo({ boardId: id }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await service.rename({ boardId: id, name: 'x' }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await service.duplicate({ boardId: id, name: 'x' }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await service.delete({ boardId: id }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await service.restore({ boardId: id }), { ok: false, reason: 'not_found' });
  assert.equal((await service.get({ boardId: id, extra: 1 })).reason, 'invalid');
  assert.equal((await service.apply({ boardId: id, batch: 'ops' })).reason, 'invalid');
  assert.equal((await service.apply({ boardId: id, batch: batch(id, [note(1)]), now: 1 })).reason, 'invalid');
});

test('apply persists the document then the journal, forces the owner as actor, and emits applied', async (t) => {
  const env = setup(t);
  const board = await created(env.service);
  const r = await applied(env.service, board.id, [note(1, 'hello')]);
  assert.equal(r.board.rev, 1);
  assert.equal(r.board.cards[uid(1)].created_by, 'owner');
  assert.equal(r.board.cards[uid(1)].alias, 'n1');
  assert.equal(r.applied.actor, 'owner');
  assert.equal(r.undoable, true);
  assert.equal(r.canUndo, true);
  assert.equal(r.canRedo, false);
  assert.equal(r.duplicate, undefined);
  assert.deepEqual(env.events.at(-1), { boardId: board.id, projectId: ALPHA, kind: 'applied', rev: 1, applied: r.applied });
  assert.deepEqual(JSON.parse(fs.readFileSync(env.file(`${board.id}.json`), 'utf8')), r.board);
  const journal = JSON.parse(fs.readFileSync(env.file(`${board.id}.journal.json`), 'utf8'));
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].batch_id, r.applied.batch_id);
  assert.equal((await env.service.list({ projectId: ALPHA })).boards[0].rev, 1);
});

test('the model refusal passes through, and a batch over the document cap is refused before the model', async (t) => {
  const env = setup(t);
  const board = await created(env.service);
  const missing = await env.service.apply({ boardId: board.id, batch: batch(board.id, [note(1), { op: 'card.remove', id: uid(9) }]) });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_target');
  assert.equal(missing.op_index, 1);
  const wrongBoard = await env.service.apply({ boardId: board.id, batch: batch(`board_${uid(7)}`, [note(1)]) });
  assert.equal(wrongBoard.reason, 'invalid');
  const huge = batch(board.id, [note(1, 'x'.repeat(M.LIMITS.document_bytes))]);
  assert.deepEqual(await env.service.apply({ boardId: board.id, batch: huge }), { ok: false, reason: 'limit', limit: 'document_bytes', op_index: -1 });
  assert.equal((await env.service.get({ boardId: board.id })).board.rev, 0);
  assert.equal(fs.existsSync(env.file(`${board.id}.journal.json`)), false);
});

test('a duplicate batch id returns the stored board with duplicate: true and writes nothing', async (t) => {
  const counts = {};
  const env = setup(t, { wrapStore: countingStore(counts) });
  const board = await created(env.service);
  const once = batch(board.id, [note(1)]);
  const first = await env.service.apply({ boardId: board.id, batch: once });
  const writes = { doc: counts.writeDocument, journal: counts.writeJournal, index: counts.writeIndex };
  const events = env.events.length;
  const again = await env.service.apply({ boardId: board.id, batch: once });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.board, first.board);
  assert.deepEqual({ doc: counts.writeDocument, journal: counts.writeJournal, index: counts.writeIndex }, writes);
  assert.equal(env.events.length, events);
});

test('document first, journal second: a failed journal write keeps the change and loses only the undo step', async (t) => {
  let failJournal = false;
  const env = setup(t, { wrapStore: (store) => ({ ...store,
    writeJournal: (...args) => { if (failJournal) throw new Error('journal disk full'); return store.writeJournal(...args); },
  }) });
  const board = await created(env.service);
  failJournal = true;
  const r = await env.service.apply({ boardId: board.id, batch: batch(board.id, [note(1)]) });
  assert.equal(r.ok, true);
  assert.equal(r.undoable, false);
  assert.equal(r.canUndo, false);
  const reopened = env.make();
  const after = await reopened.get({ boardId: board.id });
  assert.ok(after.board.cards[uid(1)], 'the change is on disk');
  assert.equal(after.canUndo, false, 'the undo step is gone');
});

test('a failed document write returns io and leaves the document, the journal and listeners untouched', async (t) => {
  let failDoc = false;
  const env = setup(t, { wrapStore: (store) => ({ ...store,
    writeDocument: (...args) => { if (failDoc) throw new Error('doc disk full'); return store.writeDocument(...args); },
  }) });
  const board = await created(env.service);
  await applied(env.service, board.id, [note(1)]);
  const before = fs.readFileSync(env.file(`${board.id}.json`), 'utf8');
  const events = env.events.length;
  failDoc = true;
  assert.deepEqual(await env.service.apply({ boardId: board.id, batch: batch(board.id, [note(2)]) }), { ok: false, reason: 'io' });
  assert.equal(fs.readFileSync(env.file(`${board.id}.json`), 'utf8'), before);
  assert.equal(env.events.length, events);
  failDoc = false;
  const got = await env.service.get({ boardId: board.id });
  assert.equal(got.board.cards[uid(2)], undefined, 'the cache did not keep the refused change');
  assert.equal(got.canUndo, true);
});

test('undo, redo, redo cleared by a new apply, and the empty cases', async (t) => {
  const env = setup(t);
  const board = await created(env.service);
  assert.deepEqual(await env.service.undo({ boardId: board.id }), { ok: false, reason: 'nothing_to_undo' });
  assert.deepEqual(await env.service.redo({ boardId: board.id }), { ok: false, reason: 'nothing_to_redo' });
  await applied(env.service, board.id, [note(1)]);
  const undone = await env.service.undo({ boardId: board.id });
  assert.equal(undone.ok, true);
  assert.equal(undone.board.cards[uid(1)], undefined);
  assert.deepEqual(undone.skipped, []);
  assert.equal(undone.applied.ops[0].op, 'card.remove');
  assert.equal(undone.canUndo, false);
  assert.equal(undone.canRedo, true);
  assert.equal(env.events.at(-1).kind, 'applied');
  const redone = await env.service.redo({ boardId: board.id });
  assert.equal(redone.ok, true);
  assert.equal(redone.board.cards[uid(1)].alias, 'n1');
  assert.equal(redone.canUndo, true);
  assert.equal(redone.canRedo, false);
  const again = await env.service.undo({ boardId: board.id });
  assert.equal(again.canRedo, true);
  // The picture sweep reads the redo steps held in memory: the card undo took away is still named there.
  assert.equal(env.service.redoInverses()[0].ops[0].card.id, uid(1));
  const fresh = await applied(env.service, board.id, [note(2)]);
  assert.equal(fresh.canRedo, false);
  assert.deepEqual(env.service.redoInverses(), []);
  assert.deepEqual(await env.service.redo({ boardId: board.id }), { ok: false, reason: 'nothing_to_redo' });
  const reopened = env.make();
  assert.equal((await reopened.get({ boardId: board.id })).canUndo, true, 'the journal survives a restart');
  assert.equal((await reopened.get({ boardId: board.id })).canRedo, false, 'redo is memory only');
});

test('a batch whose inverse is over the journal cap still applies with undoable: false', async (t) => {
  const env = setup(t, { journalCaps: { batches: 200, bytes: 4096 } });
  const board = await created(env.service);
  await applied(env.service, board.id, [note(1, 'y'.repeat(3900)), note(2, 'z'.repeat(3900))]);
  const r = await env.service.apply({ boardId: board.id, batch: batch(board.id, [{ op: 'card.remove', id: uid(1) }, { op: 'card.remove', id: uid(2) }]) });
  assert.equal(r.ok, true);
  assert.equal(r.undoable, false);
  assert.deepEqual(r.board.cards, {});
  const undone = await env.service.undo({ boardId: board.id });
  assert.equal(undone.ok, true, 'the earlier add is still the latest undo step');
  assert.equal(undone.applied.ops.length, 0, 'its cards are already gone, so every step is skipped');
  assert.equal(undone.skipped.length, 2);
});

test('the 20-board cap per project counts only boards that are not deleted', async (t) => {
  const { service } = setup(t);
  const boards = [];
  for (let i = 0; i < M.LIMITS.boards_per_project; i += 1) boards.push(await created(service, ALPHA, `B${i}`));
  assert.deepEqual(await service.create({ projectId: ALPHA, name: 'one too many' }), { ok: false, reason: 'limit', limit: 'boards_per_project' });
  assert.equal((await service.create({ projectId: GENERAL, name: 'other project' })).ok, true);
  assert.deepEqual(await service.duplicate({ boardId: boards[0].id, name: 'copy' }), { ok: false, reason: 'limit', limit: 'boards_per_project' });
  assert.equal((await service.delete({ boardId: boards[0].id })).ok, true);
  const replacement = await created(service, ALPHA, 'fits now');
  assert.deepEqual(await service.restore({ boardId: boards[0].id }), { ok: false, reason: 'limit' });
  assert.equal((await service.delete({ boardId: replacement.id })).ok, true);
  assert.equal((await service.restore({ boardId: boards[0].id })).ok, true);
});

test('delete tombstones, restore brings it back, and the files go 10 minutes after the delete', async (t) => {
  const env = setup(t);
  const kept = await created(env.service, ALPHA, 'kept');
  const board = await created(env.service, ALPHA, 'gone');
  await applied(env.service, board.id, [note(1)]);
  const deleted = await env.service.delete({ boardId: board.id });
  assert.deepEqual(deleted, { ok: true, restorableUntil: new Date(T0 + PURGE_AFTER_MS).toISOString() });
  assert.equal(PURGE_AFTER_MS, 10 * 60 * 1000);
  assert.deepEqual(env.events.at(-1), { boardId: board.id, projectId: ALPHA, kind: 'deleted', rev: 1 });
  assert.deepEqual((await env.service.list({ projectId: ALPHA })).boards.map((b) => b.id), [kept.id]);
  assert.deepEqual(await env.service.get({ boardId: board.id }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await env.service.apply({ boardId: board.id, batch: batch(board.id, [note(2)]) }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await env.service.delete({ boardId: board.id }), { ok: false, reason: 'not_found' });
  const restored = await env.service.restore({ boardId: board.id });
  assert.equal(restored.ok, true);
  assert.ok(restored.board.cards[uid(1)]);
  assert.equal(env.events.at(-1).kind, 'restored');
  assert.deepEqual(await env.service.restore({ boardId: board.id }), { ok: false, reason: 'not_found' });

  await env.service.delete({ boardId: board.id });
  env.clock += PURGE_AFTER_MS - 1;
  await env.service.list({ projectId: ALPHA });
  assert.equal(fs.existsSync(env.file(`${board.id}.json`)), true, 'not yet');
  env.clock += 2;
  await env.service.list({ projectId: ALPHA });
  assert.equal(fs.existsSync(env.file(`${board.id}.json`)), false);
  assert.equal(fs.existsSync(env.file(`${board.id}.journal.json`)), false);
  assert.deepEqual(await env.service.restore({ boardId: board.id }), { ok: false, reason: 'not_found' });
  assert.ok(fs.existsSync(env.file(`${kept.id}.json`)));
});

test('a stale tombstone is purged on create and on the first use after a restart', async (t) => {
  const env = setup(t);
  const a = await created(env.service, ALPHA, 'a');
  const b = await created(env.service, ALPHA, 'b');
  fs.writeFileSync(env.file(`${a.id}.proposals.json`), '[]');
  await env.service.delete({ boardId: a.id });
  await env.service.delete({ boardId: b.id });
  env.clock += PURGE_AFTER_MS + 1;
  await created(env.service, GENERAL, 'trigger');
  assert.equal(fs.existsSync(env.file(`${a.id}.json`)), false);
  assert.equal(fs.existsSync(env.file(`${a.id}.proposals.json`)), false);
  const c = await created(env.service, ALPHA, 'c');
  await env.service.delete({ boardId: c.id });
  env.clock += PURGE_AFTER_MS + 1;
  const reopened = env.make();
  await reopened.get({ boardId: c.id });
  assert.equal(fs.existsSync(env.file(`${c.id}.json`)), false);
});

test('a corrupt or newer-schema document is read-only, still listed, and survives every call untouched', async (t) => {
  const env = setup(t);
  const good = await created(env.service, ALPHA, 'good');
  const corrupt = await created(env.service, ALPHA, 'will break');
  const newer = await created(env.service, ALPHA, 'from the future');
  const corruptBytes = '{"schema_version":1,"id":';
  const newerBytes = JSON.stringify({ ...newer, schema_version: 2, extra_v2_field: true });
  fs.writeFileSync(env.file(`${corrupt.id}.json`), corruptBytes);
  fs.writeFileSync(env.file(`${newer.id}.json`), newerBytes);
  const service = env.make();
  assert.deepEqual(await service.get({ boardId: corrupt.id }), { ok: true, board: null, readOnly: true, reason: 'corrupt' });
  assert.deepEqual(await service.get({ boardId: newer.id }), { ok: true, board: null, readOnly: true, reason: 'newer_schema' });
  for (const id of [corrupt.id, newer.id]) {
    assert.deepEqual(await service.apply({ boardId: id, batch: batch(id, [note(1)]) }), { ok: false, reason: 'read_only' });
    assert.deepEqual(await service.undo({ boardId: id }), { ok: false, reason: 'read_only' });
    assert.deepEqual(await service.redo({ boardId: id }), { ok: false, reason: 'read_only' });
    assert.deepEqual(await service.rename({ boardId: id, name: 'x' }), { ok: false, reason: 'read_only' });
    assert.deepEqual(await service.duplicate({ boardId: id, name: 'x' }), { ok: false, reason: 'read_only' });
    assert.deepEqual(await service.delete({ boardId: id }), { ok: false, reason: 'read_only' });
  }
  assert.equal((await service.moveProjectBoards(ALPHA)).ok, true);
  const listed = (await service.list({ projectId: GENERAL })).boards.map((b) => b.name).sort();
  assert.deepEqual(listed, ['from the future', 'good', 'will break']);
  assert.equal(fs.readFileSync(env.file(`${corrupt.id}.json`), 'utf8'), corruptBytes);
  assert.equal(fs.readFileSync(env.file(`${newer.id}.json`), 'utf8'), newerBytes);
  assert.equal((await service.get({ boardId: good.id })).board.project_id, GENERAL);
});

test('the index is rebuilt from the documents when it is missing or unreadable', async (t) => {
  const env = setup(t);
  const a = await created(env.service, ALPHA, 'a');
  const b = await created(env.service, GENERAL, 'b');
  await applied(env.service, a.id, [note(1)]);
  const corrupt = await created(env.service, ALPHA, 'c');
  fs.writeFileSync(env.file(`${corrupt.id}.json`), 'not json');
  fs.rmSync(env.file('index.json'));
  let reopened = env.make();
  assert.deepEqual((await reopened.list({ projectId: ALPHA })).boards.map((x) => [x.id, x.name, x.rev]), [[a.id, 'a', 1]]);
  const general = (await reopened.list({ projectId: GENERAL })).boards.map((x) => [x.id, x.name]).sort();
  assert.deepEqual(general, [[b.id, 'b'], [corrupt.id, corrupt.id]].sort(), 'an unreadable document is listed by its file name');
  assert.ok(fs.existsSync(env.file('index.json')));
  fs.writeFileSync(env.file('index.json'), '{"schema_version":1,"boards":');
  reopened = env.make();
  assert.equal((await reopened.list({ projectId: ALPHA })).boards.length, 1);
  assert.equal(fs.readFileSync(env.file(`${corrupt.id}.json`), 'utf8'), 'not json');
});

test('D13: deleting a project moves its boards to General, even past the General cap', async (t) => {
  const env = setup(t);
  for (let i = 0; i < M.LIMITS.boards_per_project; i += 1) await created(env.service, GENERAL, `G${i}`);
  const a = await created(env.service, ALPHA, 'a');
  const b = await created(env.service, ALPHA, 'b');
  await applied(env.service, a.id, [note(1)]);
  await env.service.delete({ boardId: b.id });
  env.events.length = 0;
  const moved = await env.service.moveProjectBoards(ALPHA);
  assert.deepEqual(moved, { ok: true, moved: 2, failed: 0 });
  const doc = JSON.parse(fs.readFileSync(env.file(`${a.id}.json`), 'utf8'));
  assert.equal(doc.project_id, GENERAL);
  assert.equal(doc.rev, 2);
  assert.ok(doc.cards[uid(1)], 'the content moves with it');
  assert.deepEqual(env.events.find((e) => e.boardId === a.id), { boardId: a.id, projectId: GENERAL, kind: 'moved', rev: 2 });
  assert.equal((await env.service.list({ projectId: GENERAL })).boards.length, 21);
  assert.deepEqual(await env.service.list({ projectId: ALPHA }), { ok: true, boards: [] });
  assert.deepEqual(await env.service.create({ projectId: GENERAL, name: 'x' }), { ok: false, reason: 'limit', limit: 'boards_per_project' });
  assert.deepEqual(await env.service.restore({ boardId: b.id }), { ok: false, reason: 'limit' });
  assert.equal((await env.service.get({ boardId: a.id })).canUndo, true, 'the journal still applies');
  await env.service.delete({ boardId: a.id });
  assert.equal((await env.service.create({ projectId: GENERAL, name: 'x' })).ok, false, 'back at 20, still full');
  const first = (await env.service.list({ projectId: GENERAL })).boards[0];
  await env.service.delete({ boardId: first.id });
  assert.equal((await env.service.create({ projectId: GENERAL, name: 'x' })).ok, true);
  assert.deepEqual(await env.service.moveProjectBoards(GENERAL), { ok: true, moved: 0, failed: 0 });
  assert.deepEqual(await env.service.moveProjectBoards('../x'), { ok: false, reason: 'invalid' });
});

test('two applies on one board sent together both land, in order', async (t) => {
  const env = setup(t);
  const board = await created(env.service);
  const [first, second] = await Promise.all([
    env.service.apply({ boardId: board.id, batch: batch(board.id, [note(1, 'v0')]) }),
    env.service.apply({ boardId: board.id, batch: batch(board.id, [{ op: 'card.edit', id: uid(1), content_rev: 0, data: { text: 'v1' } }]) }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.board.rev, 2);
  assert.equal(second.board.cards[uid(1)].data.text, 'v1');
  const reopened = env.make();
  assert.equal((await reopened.get({ boardId: board.id })).board.cards[uid(1)].data.text, 'v1');
});

test('rename is a journaled board.rename batch and emits renamed', async (t) => {
  const env = setup(t);
  const board = await created(env.service, ALPHA, 'Old');
  const r = await env.service.rename({ boardId: board.id, name: 'New' });
  assert.equal(r.ok, true);
  assert.equal(r.board.name, 'New');
  assert.deepEqual(env.events.at(-1), { boardId: board.id, projectId: ALPHA, kind: 'renamed', rev: 1 });
  assert.equal((await env.service.list({ projectId: ALPHA })).boards[0].name, 'New');
  assert.equal((await env.service.rename({ boardId: board.id, name: '' })).reason, 'invalid');
  assert.equal((await env.service.undo({ boardId: board.id })).board.name, 'Old');
});

test('duplicate copies cards, connectors and groups under new ids with the same aliases and no journal', async (t) => {
  const env = setup(t);
  const board = await created(env.service, ALPHA, 'Source');
  await applied(env.service, board.id, [
    { op: 'group.add', group: { id: uid(10), title: 'G', x: 0, y: 0, w: 600, h: 400 } },
    { op: 'card.add', card: { id: uid(1), kind: 'note', data: { text: 'a' }, x: 20, y: 60, group_id: uid(10) } },
    note(2, 'b'),
    { op: 'connector.add', connector: { id: uid(3), from: uid(1), to: uid(2), label: 'to' } },
  ]);
  fs.writeFileSync(env.file(`${board.id}.proposals.json`), '[{"id":"p1"}]');
  const r = await env.service.duplicate({ boardId: board.id, name: 'Copy' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const copy = r.board;
  assert.notEqual(copy.id, board.id);
  assert.equal(copy.name, 'Copy');
  assert.equal(copy.rev, 0);
  assert.deepEqual(copy.recent_batches, []);
  const source = (await env.service.get({ boardId: board.id })).board;
  const sourceIds = new Set([...Object.keys(source.cards), ...Object.keys(source.connectors), ...Object.keys(source.groups)]);
  for (const id of [...Object.keys(copy.cards), ...Object.keys(copy.connectors), ...Object.keys(copy.groups)]) assert.equal(sourceIds.has(id), false);
  const byAlias = (b) => Object.fromEntries(Object.values(b.cards).map((c) => [c.alias, c]));
  const [groupId] = Object.keys(copy.groups);
  assert.equal(copy.groups[groupId].alias, 'g1');
  assert.equal(byAlias(copy).n2.group_id, groupId);
  const [con] = Object.values(copy.connectors);
  assert.deepEqual([con.from, con.to], [byAlias(copy).n2.id, byAlias(copy).n3.id]);
  assert.equal(copy.next_alias, source.next_alias);
  assert.deepEqual(M.normalizeBoard(copy).ok, true);
  const got = await env.service.get({ boardId: copy.id });
  assert.equal(got.canUndo, false);
  assert.equal(fs.existsSync(env.file(`${copy.id}.proposals.json`)), false);
  assert.deepEqual(env.events.at(-1), { boardId: copy.id, projectId: ALPHA, kind: 'created', rev: 0 });
  assert.equal((await env.service.duplicate({ boardId: board.id, name: '' })).reason, 'invalid');
});
