'use strict';

// new-test-file: a new surface (the Board page's BoardSource objects, the in-memory one and the bridge adapter); the page itself is in renderer-board-page.test.js.
// The contract is docs/plans/PROJECT_BOARD_2026-11-13.md section 6 (and the API sheet it was built from): every call takes
// one object and resolves a result; none rejects for a refusal.

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBridgeBoardSource, chooseBoardSource } = require('../renderer/features/board/board-source-bridge');

const PROJECT = 'project_alpha';
const OTHER = 'project_beta';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A clock that moves one second per read and ids that count, so every run is the same run.
function make(options = {}) {
  let tick = Date.parse('2026-11-13T10:00:00.000Z');
  let seq = 0;
  const source = createMemoryBoardSource({
    model,
    now: () => new Date((tick += 1000)).toISOString(),
    makeId: () => uid(++seq),
    ...options,
  });
  return source;
}
let batchSeq = 0;
const batch = (boardId, ops, extra = {}) => ({ batch_id: `batch${++batchSeq}`, board_id: boardId, actor: 'someone-else', ops, ...extra });
const note = (n, text, extra = {}) => ({ op: 'card.add', card: { id: uid(100 + n), kind: 'note', data: { text }, x: n * 300, y: 0, ...extra } });

async function created(source, name = 'Plan', projectId = PROJECT) {
  const result = await source.create({ projectId, name });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.board;
}

test('create makes board_<uuid> documents at rev 0 and list shows them in the order they were made', async () => {
  const source = make();
  const first = await created(source, 'First');
  const second = await created(source, 'Second');
  const elsewhere = await created(source, 'Elsewhere', OTHER);
  assert.match(first.id, /^board_[0-9a-f-]{36}$/);
  assert.equal(first.rev, 0);
  assert.equal(first.project_id, PROJECT);
  const listed = await source.list({ projectId: PROJECT });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.boards.map((b) => b.name), ['First', 'Second']);
  assert.deepEqual(Object.keys(listed.boards[0]).sort(), ['created_at', 'id', 'name', 'project_id', 'rev', 'updated_at']);
  assert.deepEqual((await source.list({ projectId: OTHER })).boards.map((b) => b.id), [elsewhere.id]);
  assert.deepEqual((await source.list({ projectId: 'project_empty' })).boards, []);
  assert.notEqual(second.id, first.id);
});

test('bad arguments are refused as invalid, never thrown', async () => {
  const source = make();
  for (const call of ['list', 'create', 'get', 'apply', 'undo', 'redo', 'rename', 'duplicate', 'delete', 'restore']) {
    for (const request of [undefined, null, 5, 'x', {}]) {
      const result = await source[call](request);
      assert.equal(result.ok, false, `${call}(${JSON.stringify(request)})`);
      assert.ok(['invalid', 'not_found'].includes(result.reason), `${call}: ${result.reason}`);
    }
  }
  assert.equal((await source.create({ projectId: PROJECT, name: '' })).reason, 'invalid');
  assert.equal((await source.create({ projectId: PROJECT, name: 'two\nlines' })).reason, 'invalid');
  assert.equal((await source.create({ projectId: PROJECT, name: 'x'.repeat(201) })).reason, 'invalid');
  assert.equal((await source.create({ projectId: 'not a project', name: 'ok' })).reason, 'invalid');
  assert.equal((await source.create({ projectId: PROJECT, name: 'x'.repeat(200) })).ok, true, 'exactly 200 is allowed');
});

test('a project holds 20 boards: the 21st is refused with the limit named, and a delete makes room', async () => {
  const source = make();
  const made = [];
  for (let i = 0; i < 20; i += 1) made.push(await created(source, `Board ${i}`));
  assert.deepEqual(await source.create({ projectId: PROJECT, name: 'One too many' }), { ok: false, reason: 'limit', limit: 'boards_per_project' });
  assert.equal((await source.create({ projectId: OTHER, name: 'Other project is fine' })).ok, true);
  assert.deepEqual(await source.duplicate({ boardId: made[0].id, name: 'Copy' }), { ok: false, reason: 'limit', limit: 'boards_per_project' });
  await source.delete({ boardId: made[3].id });
  assert.equal((await source.create({ projectId: PROJECT, name: 'Fits now' })).ok, true);
  assert.deepEqual(await source.restore({ boardId: made[3].id }), { ok: false, reason: 'limit', limit: 'boards_per_project' });
});

test('get returns the document with undo flags, a copy of it, and not_found for an unknown or deleted board', async () => {
  const source = make();
  const board = await created(source);
  const got = await source.get({ boardId: board.id });
  assert.deepEqual(got, { ok: true, board, readOnly: false, canUndo: false, canRedo: false });
  got.board.name = 'changed outside';
  assert.equal((await source.get({ boardId: board.id })).board.name, 'Plan', 'the caller holds a copy');
  assert.deepEqual(await source.get({ boardId: 'board_nope' }), { ok: false, reason: 'not_found' });
  await source.delete({ boardId: board.id });
  assert.deepEqual(await source.get({ boardId: board.id }), { ok: false, reason: 'not_found' });
});

test('apply runs the model with authority, sets the actor to owner, journals the batch and clears redo', async () => {
  const source = make();
  const board = await created(source);
  const result = await source.apply({ boardId: board.id, batch: batch(board.id, [note(1, 'Hello')]) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.board.rev, 1);
  assert.equal(result.applied.actor, 'owner');
  assert.equal(result.undoable, true);
  assert.equal(result.canUndo, true);
  assert.equal(result.canRedo, false);
  assert.equal(Object.keys(result.board.cards).length, 1);
  assert.equal(Object.values(result.board.cards)[0].created_by, 'owner');
  const again = await source.apply({ boardId: board.id, batch: { ...batch(board.id, [note(2, 'x')]), batch_id: result.applied.batch_id } });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true, 'a resent batch is a harmless duplicate');
  assert.equal(again.board.rev, 1);
});

test('apply passes the model refusal through with its operation index', async () => {
  const source = make();
  const board = await created(source);
  const refused = await source.apply({ boardId: board.id, batch: batch(board.id, [note(1, 'fine'), { op: 'card.add', card: { id: uid(150), kind: 'note', data: { text: 'x'.repeat(4001) } } }]) });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'invalid');
  assert.equal(refused.op_index, 1);
  assert.equal(refused.limit, 'note_chars');
  assert.equal((await source.get({ boardId: board.id })).board.rev, 0, 'a refused batch changes nothing');
  assert.equal((await source.apply({ boardId: board.id, batch: batch('board_other', [note(1, 'x')]) })).reason, 'invalid');
  assert.deepEqual(await source.apply({ boardId: 'board_missing', batch: batch('board_missing', [note(1, 'x')]) }), { ok: false, reason: 'not_found' });
});

test('undo and redo walk the journal with applyInverse, and a new apply drops the redo', async () => {
  const source = make();
  const board = await created(source);
  assert.deepEqual(await source.undo({ boardId: board.id }), { ok: false, reason: 'nothing_to_undo' });
  assert.deepEqual(await source.redo({ boardId: board.id }), { ok: false, reason: 'nothing_to_redo' });
  await source.apply({ boardId: board.id, batch: batch(board.id, [note(1, 'one')]) });
  await source.apply({ boardId: board.id, batch: batch(board.id, [note(2, 'two')]) });
  const undone = await source.undo({ boardId: board.id });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(Object.keys(undone.board.cards).length, 1);
  assert.deepEqual(undone.skipped, []);
  assert.equal(undone.canUndo, true);
  assert.equal(undone.canRedo, true);
  const redone = await source.redo({ boardId: board.id });
  assert.equal(redone.ok, true);
  assert.equal(Object.keys(redone.board.cards).length, 2);
  assert.equal(redone.canRedo, false);
  await source.undo({ boardId: board.id });
  await source.undo({ boardId: board.id });
  assert.equal((await source.undo({ boardId: board.id })).reason, 'nothing_to_undo');
  const applied = await source.apply({ boardId: board.id, batch: batch(board.id, [note(3, 'three')]) });
  assert.equal(applied.canRedo, false, 'a new batch drops the redo stack');
  assert.equal((await source.redo({ boardId: board.id })).reason, 'nothing_to_redo');
});

test('rename is a board.rename batch: it journals, and the model refuses a bad name', async () => {
  const source = make();
  const board = await created(source, 'Before');
  const renamed = await source.rename({ boardId: board.id, name: 'After' });
  assert.deepEqual(Object.keys(renamed).sort(), ['board', 'ok']);
  assert.equal(renamed.board.name, 'After');
  assert.equal(renamed.board.rev, 1);
  assert.equal((await source.get({ boardId: board.id })).canUndo, true);
  for (const name of ['', 'a\u0007b', 'x'.repeat(201), 'two\nlines', 5]) {
    const refused = await source.rename({ boardId: board.id, name });
    assert.equal(refused.ok, false, String(name));
    assert.equal(refused.reason, 'invalid');
  }
  assert.equal((await source.rename({ boardId: 'board_nope', name: 'x' })).reason, 'not_found');
  assert.equal((await source.list({ projectId: PROJECT })).boards[0].name, 'After');
});

test('duplicate copies the document under a new board id and new item ids, with no journal', async () => {
  const source = make();
  const board = await created(source, 'Original');
  const ops = [
    { op: 'group.add', group: { id: uid(10), title: 'Group', x: 0, y: 0, w: 400, h: 300 } },
    note(1, 'in a group', { group_id: uid(10) }),
    note(2, 'outside'),
    { op: 'connector.add', connector: { id: uid(20), from: uid(101), to: uid(102), label: 'leads to' } },
  ];
  await source.apply({ boardId: board.id, batch: batch(board.id, ops) });
  const copy = await source.duplicate({ boardId: board.id, name: 'Original copy' });
  assert.equal(copy.ok, true, JSON.stringify(copy));
  const doc = copy.board;
  assert.notEqual(doc.id, board.id);
  assert.equal(doc.name, 'Original copy');
  assert.equal(doc.project_id, PROJECT);
  assert.deepEqual(doc.recent_batches, []);
  assert.equal(model.normalizeBoard(doc).ok, true, 'the copy is a valid document');
  const original = (await source.get({ boardId: board.id })).board;
  const newIds = [...Object.keys(doc.cards), ...Object.keys(doc.groups), ...Object.keys(doc.connectors)];
  const oldIds = new Set([...Object.keys(original.cards), ...Object.keys(original.groups), ...Object.keys(original.connectors)]);
  assert.equal(newIds.length, 4);
  assert.ok(newIds.every((id) => !oldIds.has(id)), 'no item id is shared with the original');
  const [connector] = Object.values(doc.connectors);
  assert.ok(doc.cards[connector.from] && doc.cards[connector.to], 'the connector joins the copied cards');
  assert.ok(Object.values(doc.cards).some((card) => card.group_id && doc.groups[card.group_id]), 'the card is in the copied group');
  const fresh = await source.get({ boardId: doc.id });
  assert.equal(fresh.canUndo, false, 'no journal is carried over');
  assert.equal((await source.duplicate({ boardId: board.id, name: '' })).reason, 'invalid');
  assert.equal((await source.duplicate({ boardId: 'board_nope', name: 'x' })).reason, 'not_found');
});

test('delete takes the board out of list at once and gives an ISO time to restore it by; restore brings it back', async () => {
  const source = make();
  const board = await created(source);
  const deleted = await source.delete({ boardId: board.id });
  assert.equal(deleted.ok, true);
  assert.match(deleted.restorableUntil, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual((await source.list({ projectId: PROJECT })).boards, []);
  assert.equal((await source.delete({ boardId: board.id })).reason, 'not_found', 'already deleted');
  const restored = await source.restore({ boardId: board.id });
  assert.equal(restored.ok, true);
  assert.equal(restored.board.id, board.id);
  assert.equal((await source.list({ projectId: PROJECT })).boards.length, 1);
  assert.equal((await source.restore({ boardId: board.id })).reason, 'not_found', 'not deleted');
  assert.equal((await source.restore({ boardId: 'board_nope' })).reason, 'not_found');
});

test('a deleted board cannot be restored once its time has passed', async () => {
  let clock = Date.parse('2026-11-13T10:00:00.000Z');
  const source = make({ now: () => new Date(clock).toISOString(), restoreWindowMs: 60_000 });
  const board = await created(source);
  await source.delete({ boardId: board.id });
  clock += 61_000;
  assert.equal((await source.restore({ boardId: board.id })).reason, 'not_found');
});

test('onChanged tells every listener what happened, with the applied batch for applied, and stops after unsubscribe', async () => {
  const source = make();
  const heard = [];
  const off = source.onChanged((event) => heard.push(event));
  const second = [];
  source.onChanged((event) => second.push(event.kind));
  const board = await created(source);
  await source.apply({ boardId: board.id, batch: batch(board.id, [note(1, 'x')]) });
  await source.rename({ boardId: board.id, name: 'Renamed' });
  await source.undo({ boardId: board.id });
  await source.delete({ boardId: board.id });
  await source.restore({ boardId: board.id });
  assert.deepEqual(heard.map((e) => e.kind), ['created', 'applied', 'renamed', 'applied', 'deleted', 'restored']);
  assert.deepEqual(second, heard.map((e) => e.kind));
  assert.ok(heard.every((e) => e.boardId === board.id && e.projectId === PROJECT && Number.isInteger(e.rev)));
  assert.equal(heard[1].applied.ops[0].op, 'card.add');
  assert.equal(heard[0].applied, undefined);
  assert.equal(heard[2].applied.ops[0].op, 'board.rename', 'a rename is a batch too');
  off();
  await created(source, 'After off');
  assert.equal(heard.length, 6);
  assert.equal(second.length, 7);
  assert.equal(typeof source.onChanged('not a function'), 'function');
});

test('a board the service could not read lists, answers read-only, and refuses every change', async () => {
  const source = make({ seed: [{ unreadable: { id: 'board_bad', project_id: PROJECT, name: 'Damaged', reason: 'corrupt' } }, { unreadable: { id: 'board_new', project_id: PROJECT, name: 'Newer', reason: 'newer_schema' } }] });
  assert.deepEqual((await source.list({ projectId: PROJECT })).boards.map((b) => b.name), ['Damaged', 'Newer']);
  assert.deepEqual(await source.get({ boardId: 'board_bad' }), { ok: true, board: null, readOnly: true, reason: 'corrupt' });
  assert.equal((await source.get({ boardId: 'board_new' })).reason, 'newer_schema');
  for (const [call, request] of [['apply', { boardId: 'board_bad', batch: batch('board_bad', [note(1, 'x')]) }], ['undo', { boardId: 'board_bad' }], ['redo', { boardId: 'board_bad' }], ['rename', { boardId: 'board_bad', name: 'x' }], ['duplicate', { boardId: 'board_bad', name: 'x' }]]) {
    assert.deepEqual(await source[call](request), { ok: false, reason: 'read_only' }, call);
  }
  assert.equal((await source.delete({ boardId: 'board_bad' })).ok, true, 'a damaged board can still be deleted');
});

test('the bridge adapter hands each call to window.jennyShell.boards as one object and returns what it answers', async () => {
  const seen = [];
  const answers = { list: { ok: true, boards: [] }, create: { ok: true, board: {} }, get: { ok: false, reason: 'not_found' } };
  const listeners = [];
  const bridge = {
    onChanged: (listener) => { listeners.push(listener); return () => { listeners.length = 0; }; },
  };
  for (const name of ['list', 'create', 'get', 'apply', 'undo', 'redo', 'rename', 'duplicate', 'delete', 'restore']) {
    bridge[name] = async (request) => { seen.push([name, request]); return answers[name] || { ok: true, name }; };
  }
  const source = createBridgeBoardSource(bridge);
  assert.deepEqual(Object.keys(source).sort(), ['addAsset', 'apply', 'create', 'decideProposal', 'delete', 'duplicate', 'exportFile', 'fetchLinkTitle', 'fileStatus', 'get', 'importFile', 'list',
    'listProposals', 'onChanged', 'openFile', 'readAsset', 'redo', 'rename', 'resolveFile', 'restore', 'revealFile', 'setAside', 'setSelection', 'undo']);
  for (const name of ['fetchLinkTitle', 'setSelection', 'addAsset', 'readAsset', 'resolveFile', 'openFile', 'fileStatus', 'exportFile', 'importFile', 'listProposals', 'decideProposal', 'revealFile', 'setAside']) {
    assert.deepEqual(await source[name]({ boardId: 'b' }), { ok: false, reason: 'disabled' }, `${name}: a bridge from before it existed`);
  }
  bridge.addAsset = async (request) => { seen.push(['addAsset', request]); return { ok: true, asset: 'a' }; };
  assert.deepEqual(await createBridgeBoardSource(bridge).addAsset({ boardId: 'b', bytes: new Uint8Array(1) }), { ok: true, asset: 'a' });
  seen.length = 0;
  assert.deepEqual(await source.list({ projectId: PROJECT }), answers.list);
  assert.deepEqual(await source.get({ boardId: 'b' }), answers.get);
  assert.deepEqual(await source.delete({ boardId: 'b' }), { ok: true, name: 'delete' });
  assert.deepEqual(await source.list(), answers.list);
  assert.deepEqual(seen, [['list', { projectId: PROJECT }], ['get', { boardId: 'b' }], ['delete', { boardId: 'b' }], ['list', {}]], 'an argument default, nothing more');
  const off = source.onChanged(() => {});
  assert.equal(listeners.length, 1);
  off();
  assert.equal(listeners.length, 0);
});

test('the bridge adapter resolves a failure as io: no call rejects', async () => {
  const bridge = { list: async () => { throw new Error('ipc gone'); }, get: () => { throw new Error('sync'); }, create: async () => 'text', onChanged: () => { throw new Error('no'); } };
  const source = createBridgeBoardSource(bridge);
  assert.deepEqual(await source.list({ projectId: PROJECT }), { ok: false, reason: 'io' });
  assert.deepEqual(await source.get({ boardId: 'b' }), { ok: false, reason: 'io' });
  assert.deepEqual(await source.create({}), { ok: false, reason: 'io' });
  assert.deepEqual(await source.apply({}), { ok: false, reason: 'io' }, 'a method the bridge lacks');
  assert.equal(typeof source.onChanged(() => {}), 'function');
});

test('the page picks the bridge while it is enabled, and the in-memory source with no bridge or a disabled one', async () => {
  const memory = () => ({ kind: 'memory-source' });
  const live = { list: async () => ({ ok: true, boards: [] }) };
  const picked = await chooseBoardSource({ bridge: live, createMemory: memory, projectId: PROJECT });
  assert.equal(picked.kind, 'bridge');
  assert.deepEqual(picked.first, { ok: true, boards: [] });
  assert.equal(picked.projectId, PROJECT);
  const off = await chooseBoardSource({ bridge: { list: async () => ({ ok: false, reason: 'disabled' }) }, createMemory: memory, projectId: PROJECT });
  assert.equal(off.kind, 'memory');
  assert.deepEqual(off.source, { kind: 'memory-source' });
  assert.equal((await chooseBoardSource({ bridge: undefined, createMemory: memory, projectId: PROJECT })).kind, 'memory');
  const failing = await chooseBoardSource({ bridge: { list: async () => ({ ok: false, reason: 'io' }) }, createMemory: memory, projectId: PROJECT });
  assert.equal(failing.kind, 'bridge', 'only `disabled` falls back; a read error is shown, not hidden');
});

test('the in-memory pictures and files: addAsset types by first bytes and trusts a size hint, files work against settings.files', async () => {
  const source = make({ files: { root: 'C:/work/proj', paths: ['src/app.js'] } });
  const board = (await source.create({ projectId: PROJECT, name: 'Plan' })).board;
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 2, 0, 0, 0]);
  const added = await source.addAsset({ boardId: board.id, bytes: gif });
  assert.deepEqual([added.ok, added.ext, added.width, added.height, /^[0-9a-f]{64}$/.test(added.asset)], [true, 'gif', 3, 2, true]);
  assert.deepEqual([(await source.addAsset({ boardId: board.id, bytes: gif, width: 40, height: 30 })).width], [40]);
  const read = await source.readAsset({ boardId: board.id, asset: added.asset });
  assert.deepEqual([read.ok, read.mime, Array.from(read.bytes)], [true, 'image/gif', Array.from(gif)]);
  assert.deepEqual(await source.addAsset({ boardId: board.id, bytes: new TextEncoder().encode('<svg/>') }), { ok: false, reason: 'unsupported' });
  assert.deepEqual(await source.addAsset({ boardId: board.id, bytes: 'x' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await source.readAsset({ boardId: board.id, asset: 'f'.repeat(64) }), { ok: false, reason: 'not_found' });

  assert.deepEqual(await source.resolveFile({ boardId: board.id, path: 'C:\\work\\proj\\src\\app.js' }), { ok: true, path: 'src/app.js', title: 'app.js' });
  assert.deepEqual(await source.resolveFile({ boardId: board.id, path: '../x' }), { ok: false, reason: 'outside' });
  assert.deepEqual(await source.resolveFile({ boardId: board.id, path: 'D:/x' }), { ok: false, reason: 'outside' });
  assert.deepEqual(await source.resolveFile({ boardId: board.id, path: 'src/none.js' }), { ok: false, reason: 'not_found' });
  const ops = [{ op: 'card.add', card: { id: uid(91), kind: 'file', data: { path: 'src/app.js', title: '' } } },
    { op: 'card.add', card: { id: uid(92), kind: 'file', data: { path: 'gone.md', title: '' } } }];
  await source.apply({ boardId: board.id, batch: batch(board.id, ops) });
  assert.deepEqual(await source.openFile({ boardId: board.id, cardId: uid(91) }), { ok: true, relativePath: 'src/app.js', projectId: PROJECT });
  assert.deepEqual(await source.openFile({ boardId: board.id, cardId: uid(92) }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await source.fileStatus({ boardId: board.id }), { ok: true, missing: [uid(92)] });
  const bare = make();
  const other = (await bare.create({ projectId: PROJECT, name: 'No folder' })).board;
  assert.deepEqual(await bare.resolveFile({ boardId: other.id, path: 'src/app.js' }), { ok: false, reason: 'no_root' });
  assert.deepEqual(await bare.fileStatus({ boardId: other.id }), { ok: false, reason: 'no_root' });
});

test('the in-memory export packs the board as a .jennyboard text and import makes a new board from it (row 150 slice B10)', async () => {
  const source = make();
  const board = await created(source, 'Plan');
  await source.apply({ boardId: board.id, batch: batch(board.id, [note(1, 'Hello'), note(2, 'World'), { op: 'connector.add', connector: { id: uid(30), from: uid(101), to: uid(102), label: '' } }]) });
  const exported = await source.exportFile({ boardId: board.id });
  assert.deepEqual([exported.ok, exported.name, JSON.parse(exported.text).format], [true, 'Plan.jennyboard', 'jennyboard']);
  assert.deepEqual(await source.exportFile({ boardId: 'board_nope' }), { ok: false, reason: 'not_found' });
  const heard = [];
  source.onChanged((event) => heard.push(event.kind));
  const imported = await source.importFile({ projectId: OTHER, text: exported.text });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.deepEqual([imported.board.project_id, imported.board.name, Object.keys(imported.board.cards).length, imported.skippedPictures], [OTHER, 'Plan', 2, 0]);
  assert.notEqual(imported.board.id, board.id);
  assert.deepEqual(heard, ['created']);
  assert.equal((await source.get({ boardId: imported.board.id })).canUndo, false);
  assert.deepEqual(await source.importFile({ projectId: OTHER, text: '[]' }), { ok: false, reason: 'format' });
  assert.deepEqual(await source.importFile({ projectId: OTHER }), { ok: false, reason: 'disabled' }, 'no file picker here');
});

test('the bridge passes the two proposal calls through unchanged', async () => {
  const seen = [];
  const bridge = { onChanged: () => () => {}, listProposals: async (request) => { seen.push(['listProposals', request]); return { ok: true, proposals: [] }; },
    decideProposal: async (request) => { seen.push(['decideProposal', request]); return { ok: true, applied: 1, skipped: 0 }; } };
  const source = createBridgeBoardSource(bridge);
  assert.deepEqual(await source.listProposals({ boardId: 'b' }), { ok: true, proposals: [] });
  assert.deepEqual(await source.decideProposal({ boardId: 'b', proposalId: 'p', action: 'reject', n: 2 }), { ok: true, applied: 1, skipped: 0 });
  assert.deepEqual(seen, [['listProposals', { boardId: 'b' }], ['decideProposal', { boardId: 'b', proposalId: 'p', action: 'reject', n: 2 }]]);
});

test('the in-memory source keeps a list a test sets and decides it the simple way, changing no board', async () => {
  const source = make();
  const board = await created(source);
  const events = [];
  source.onChanged((event) => events.push(event));
  assert.deepEqual(await source.listProposals({ boardId: board.id }), { ok: true, proposals: [] });
  assert.deepEqual(await source.listProposals({ boardId: 'nope' }), { ok: false, reason: 'not_found' });
  const change = (n, cls, state = 'pending') => ({ n, line: `l${n}`, type: 'note', class: cls, state, reason: '', summary: {} });
  const changes = [change(1, 'addition'), change(2, 'addition'), change(3, 'edit'), change(4, 'removal')];
  source.setProposals(board.id, [{ id: 'p1', state: 'pending', open: true, changes, counts: {}, preview: null }]);
  assert.equal(events.at(-1).kind, 'proposals');
  assert.equal(events.at(-1).boardId, board.id);
  const rev = (await source.get({ boardId: board.id })).board.rev;
  let answer = await source.decideProposal({ boardId: board.id, proposalId: 'p1', action: 'accept_additions' });
  assert.equal(answer.ok, true);
  assert.deepEqual([answer.applied, answer.skipped], [2, 0]);
  assert.deepEqual(answer.proposal.changes.map((c) => c.state), ['applied', 'applied', 'pending', 'pending']);
  assert.equal(answer.proposal.open, true);
  assert.equal(answer.proposal.counts.pending, 2);
  answer = await source.decideProposal({ boardId: board.id, proposalId: 'p1', action: 'reject', n: 3 });
  assert.equal(answer.proposal.changes[2].state, 'rejected');
  answer = await source.decideProposal({ boardId: board.id, proposalId: 'p1', action: 'accept', n: 4 });
  assert.equal(answer.proposal.changes[3].state, 'applied');
  assert.equal(answer.proposal.open, false);
  assert.equal(answer.proposal.state, 'partly_accepted');
  assert.deepEqual(await source.decideProposal({ boardId: board.id, proposalId: 'p1', action: 'reject' }), { ok: false, reason: 'closed' });
  assert.deepEqual(await source.decideProposal({ boardId: board.id, proposalId: 'zzz', action: 'reject' }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await source.decideProposal({ boardId: board.id, proposalId: 'p1', action: 'dance' }), { ok: false, reason: 'invalid' });
  assert.equal((await source.get({ boardId: board.id })).board.rev, rev, 'no board was changed');
  assert.ok(events.filter((event) => event.kind === 'proposals').length >= 4);
});
