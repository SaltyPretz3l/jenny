'use strict';

// Stored project boards across releases (row 150; schema registry id `electron.project_boards`, forward policy
// preserve_future_block_write). fixtures/boards-v1-current/boards is what schema 1 writes: one board document, its undo
// journal and the index, made by the real store and service with a fixed clock and fixed ids.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBoardStore } = require('../../services/boards/board-store');
const { createBoardService } = require('../../services/boards/board-service');
const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');

const FIXTURE = path.join(__dirname, 'fixtures', 'boards-v1-current', 'boards');
const PROJECT = 'project_fixture_boards';
const BOARD = 'board_00000000-0000-4000-8000-000000000101';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test.afterEach(cleanupTrackedResources);

function loadFixture(edit) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-compat-'));
  trackDirectory(profile);
  const boards = path.join(profile, 'boards');
  fs.mkdirSync(boards);
  for (const name of fs.readdirSync(FIXTURE)) fs.copyFileSync(path.join(FIXTURE, name), path.join(boards, name));
  if (edit) edit(boards);
  const bytes = () => Object.fromEntries(fs.readdirSync(boards).sort().map((name) => [name, fs.readFileSync(path.join(boards, name), 'utf8')]));
  let seq = 900;
  const service = createBoardService({
    store: createBoardStore({ userDataPath: profile }),
    now: () => new Date('2026-12-01T00:00:00.000Z'),
    makeId: () => uid(++seq),
    isEnabled: () => true,
    projectExists: (id) => id === PROJECT,
  });
  return { service, boards, bytes, before: bytes() };
}

test('a schema 1 board loads with its cards, group, connector and undo history, and reading rewrites nothing', async () => {
  const { service, bytes, before } = loadFixture();
  assert.deepEqual(Object.keys(before), [`${BOARD}.journal.json`, `${BOARD}.json`, 'index.json']);
  const listed = await service.list({ projectId: PROJECT });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.boards.map((b) => [b.id, b.name, b.rev]), [[BOARD, 'Release plan', 3]]);
  const got = await service.get({ boardId: BOARD });
  assert.equal(got.ok, true);
  assert.equal(got.readOnly, false);
  assert.equal(got.canUndo, true);
  const { board } = got;
  assert.equal(board.schema_version, 1);
  assert.deepEqual(Object.values(board.cards).map((card) => [card.alias, card.kind]).sort(), [['d5', 'diagram'], ['f4', 'file'], ['l3', 'link'], ['n2', 'note']]);
  assert.equal(board.cards[uid(11)].data.text, 'Decide the token lifetime: 30 days');
  assert.equal(board.cards[uid(11)].group_id, uid(1));
  assert.equal(board.cards[uid(13)].data.path, 'src/auth/session.ts');
  assert.match(board.cards[uid(14)].data.scene, /^title Sign in\n/);
  assert.equal(board.groups[uid(1)].title, 'Open questions');
  assert.deepEqual(Object.values(board.connectors).map((c) => [c.from, c.to, c.label]), [[uid(11), uid(13), 'blocks']]);
  assert.deepEqual(bytes(), before, 'list and get wrote nothing');
});

test('a schema 1 board can be changed and undone after it is loaded', async () => {
  const { service } = loadFixture();
  const undone = await service.undo({ boardId: BOARD });
  assert.equal(undone.ok, true);
  assert.equal(undone.board.cards[uid(11)].data.text, 'Decide the token lifetime\nsecond line', 'the journal of the release still undoes');
  const applied = await service.apply({ boardId: BOARD, batch: { batch_id: 'after-upgrade', board_id: BOARD, actor: 'owner', ops: [
    { op: 'card.add', card: { id: uid(31), kind: 'note', data: { text: 'Added after the upgrade', tone: null } } },
  ] } });
  assert.equal(applied.ok, true);
  assert.equal(applied.board.cards[uid(31)].alias, 'n6', 'short names go on from where the release left them');
  assert.equal(Object.keys(applied.board.cards).length, 5);
});

test('a board from a newer schema is kept as it is and every write is refused', async () => {
  let newer = '';
  const { service, bytes, before } = loadFixture((boards) => {
    const file = path.join(boards, `${BOARD}.json`);
    newer = JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), schema_version: 2, added_in_v2: { kept: true } });
    fs.writeFileSync(file, newer, 'utf8');
  });
  assert.deepEqual(await service.get({ boardId: BOARD }), { ok: true, board: null, readOnly: true, reason: 'newer_schema' });
  const batch = { batch_id: 'refused', board_id: BOARD, actor: 'owner', ops: [{ op: 'card.add', card: { id: uid(41), kind: 'note', data: { text: 'x', tone: null } } }] };
  assert.deepEqual(await service.apply({ boardId: BOARD, batch }), { ok: false, reason: 'read_only' });
  for (const call of ['undo', 'redo', 'delete']) assert.deepEqual(await service[call]({ boardId: BOARD }), { ok: false, reason: 'read_only' }, call);
  assert.deepEqual(await service.rename({ boardId: BOARD, name: 'x' }), { ok: false, reason: 'read_only' });
  assert.equal((await service.list({ projectId: PROJECT })).boards.length, 1, 'it stays in the list');
  assert.equal(bytes()[`${BOARD}.json`], newer, 'the newer document is byte for byte what it was');
  assert.equal(bytes()[`${BOARD}.journal.json`], before[`${BOARD}.journal.json`]);
});
