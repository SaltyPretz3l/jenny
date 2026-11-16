'use strict';

// new-test-file: a new lane (row 150 hardening, P5-A): the cost of a full 500-card board in the model, the main-process
// service and the page. Each case prints `perf <name> <ms>` (best of 5 after one warm-up) and asserts a ceiling at least
// ten times what was measured on the development machine, never under 50 ms: the full suite runs many jsdom files at once
// on throttled cores, so the ceilings catch a quadratic regression and are not a benchmark. Frame rates and first paint
// need the real app and are not measured here (see the plan's section 6.7).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const placement = require('../services/boards/board-placement');
const tidy = require('../services/boards/board-tidy');
const boardPackage = require('../services/boards/board-package');
const { planAdditions } = require('../services/boards/board-proposal-apply');
const { buildBoardContextBlock, createBoardSelection } = require('../services/boards/board-turn-context');
const { createBoardStore } = require('../services/boards/board-store');
const { createBoardService } = require('../services/boards/board-service');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const boardPage = require('../renderer/features/board/board-page');
const boardEditor = require('../renderer/features/board/board-editor');
const cardKinds = require('../renderer/features/board/board-card-kinds');
const cardFile = require('../renderer/features/board/board-card-file');
const cardChat = require('../renderer/features/board/board-card-chat');
const cardMedia = require('../renderer/features/board/board-card-media');
const cardDiagram = require('../renderer/features/board/board-card-diagram');
const fixture = require('./helpers/board-fixture-500');

const { buildBoard, seedBatches, uid, cardId, groupId, connectorId, NOW, PROJECT_ID } = fixture;

// The kind modules register themselves only when the app loads them as scripts; here the page gets the same four parts.
cardKinds.register('file', cardFile.createFilePart);
cardKinds.register('chat', cardChat.createChatPart);
cardKinds.register('image', cardMedia.createMediaPart);
cardKinds.register('diagram', (ctx) => cardDiagram.createDiagramPart(ctx));

// Ceilings in milliseconds: ten times the best time measured on the development machine, rounded up, never under 50.
const CEILING = {
  'normalizeBoard 500 cards': 50,
  'boardBytes 500 cards': 50,
  'applyBatch one card.place': 50,
  'applyBatch 200 card.place': 50,
  'boardToText 500 cards, 6000 budget, 10 selected': 50,
  'turn context board section': 50,
  'placeNewCards 40 new cards': 50,
  'tidyOps whole board': 50,
  'tidyOps one group': 50,
  'planAdditions 40 additions': 120,
  'planAdditions 40 additions, board at the card limit': 190,
  'package pack': 80,
  'package unpack': 90,
  'service create and seed (6 applies)': 1000,
  'service apply one card.place': 130,
  'service get after the cache is dropped': 70,
  'page openBoard to 500 card elements': 2000,
  'page move one card, optimistic redraw': 70,
  'page move one card, until the source answered': 90,
  'page select one card on the canvas': 50,
  'page drag frame, a group with its members': 50,
  'page drag a group with its members, down to up': 340,
  'outline build': 2900,
  'outline selection change': 50,
};
const ceilingOf = (name) => {
  assert.ok(Object.prototype.hasOwnProperty.call(CEILING, name), `no ceiling for ${name}`);
  return CEILING[name];
};

const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6;
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** Best of five runs after one warm-up. `prepare` runs before each run and is not timed. */
function bestOf(run, prepare) {
  if (prepare) prepare();
  run();
  let best = Infinity;
  for (let i = 0; i < 5; i += 1) {
    if (prepare) prepare();
    const from = process.hrtime.bigint();
    run();
    best = Math.min(best, ms(from));
  }
  return best;
}
async function bestOfAsync(run, prepare) {
  if (prepare) await prepare();
  await run();
  let best = Infinity;
  for (let i = 0; i < 5; i += 1) {
    if (prepare) await prepare();
    const from = process.hrtime.bigint();
    await run();
    best = Math.min(best, ms(from));
  }
  return best;
}

function report(t, name, value) {
  t.diagnostic(`perf ${name} ${value.toFixed(2)}`);
  const ceiling = ceilingOf(name);
  assert.ok(value < ceiling, `${name} took ${value.toFixed(2)} ms, ceiling ${ceiling} ms`);
}

let shared = null;
const board500 = () => { if (!shared) shared = buildBoard(); return shared; };
let counter = 0;
const next = () => (counter += 1);
const batchId = () => `perf-${next()}`;
const cardAt = (i) => cardId(1 + (i % 500));

test('the fixture is a valid 500-card board', () => {
  const board = board500();
  assert.equal(Object.keys(board.cards).length, 500);
  assert.equal(Object.keys(board.groups).length, 20);
  assert.equal(Object.keys(board.connectors).length, 600);
  assert.equal(model.normalizeBoard(board).ok, true);
  assert.ok(model.boardBytes(board) < model.LIMITS.document_bytes);
  const kinds = {};
  Object.values(board.cards).forEach((card) => { kinds[card.kind] = (kinds[card.kind] || 0) + 1; });
  assert.equal(kinds.note, 300);
  assert.equal(kinds.diagram, 10);
  assert.equal(Object.values(board.cards).filter((card) => card.group_id).length, 400);
});

/* ---------------------------------------------------------------- the model */

test('model: normalizeBoard and boardBytes of the 500-card document', (t) => {
  const board = board500();
  report(t, 'normalizeBoard 500 cards', bestOf(() => { assert.equal(model.normalizeBoard(board).ok, true); }));
  report(t, 'boardBytes 500 cards', bestOf(() => { assert.ok(model.boardBytes(board) > 0); }));
});

test('model: applyBatch of one card.place (every drag end) and of a 200-operation batch', (t) => {
  const board = board500();
  const place = (i) => ({ batch_id: batchId(), board_id: board.id, actor: 'owner', ops: [{ op: 'card.place', id: cardAt(i), x: 100 + i, y: 200 }] });
  report(t, 'applyBatch one card.place', bestOf(() => {
    const out = model.applyBatch(board, place(next()), { now: NOW, authority: true });
    assert.equal(out.ok, true);
  }));
  const many = () => ({ batch_id: batchId(), board_id: board.id, actor: 'owner',
    ops: Array.from({ length: 200 }, (_, i) => ({ op: 'card.place', id: cardAt(i), x: 10 + i, y: 20 + next() % 7 })) });
  report(t, 'applyBatch 200 card.place', bestOf(() => {
    const out = model.applyBatch(board, many(), { now: NOW, authority: true });
    assert.equal(out.ok, true);
    assert.equal(out.applied.ops.length, 200);
  }));
});

test('model: the board as text, and the board section of a stamped turn', async (t) => {
  const board = board500();
  const selected = Array.from({ length: 10 }, (_, i) => cardAt(i * 37));
  report(t, 'boardToText 500 cards, 6000 budget, 10 selected', bestOf(() => {
    const out = model.boardToText(board, { selected, budget: 6000 });
    assert.ok(out.text.length > 0);
  }));
  const selection = createBoardSelection();
  assert.equal(selection.set({ boardId: board.id, ids: selected }).ok, true);
  const service = { boardSelection: selection, getBoardService: () => ({ get: async () => ({ ok: true, board }) }), _emitServiceLog() {} };
  report(t, 'turn context board section', await bestOfAsync(async () => {
    const block = await buildBoardContextBlock(service, { boardId: board.id, sessionId: 'session_perf', streamId: 'stream_1' });
    assert.ok(block && block.kind === 'board' && block.content.length > 0);
  }));
});

test('model: placing 40 new cards, and tidying the whole board and one group', (t) => {
  const board = board500();
  const kinds = ['note', 'link', 'file', 'chat'];
  const adds = [];
  for (let i = 0; i < 20; i += 1) adds.push({ id: uid('0000000a', i + 1), kind: kinds[i % 4], group_id: groupId(1 + (i % 20)) });
  for (let i = 20; i < 30; i += 1) adds.push({ id: uid('0000000a', i + 1), kind: 'note', near: cardAt(i * 7) });
  for (let i = 30; i < 40; i += 1) adds.push({ id: uid('0000000a', i + 1), kind: 'link' });
  report(t, 'placeNewCards 40 new cards', bestOf(() => {
    const out = placement.placeNewCards(board, adds);
    assert.equal(out.ok, true);
    assert.equal(Object.keys(out.positions).length, 40);
  }));
  // The whole board is more than one batch of moves, so the answer may be `too_many`; the work is done either way.
  report(t, 'tidyOps whole board', bestOf(() => {
    const out = tidy.tidyOps(board, {});
    assert.ok(out.ok || out.reason === 'too_many', JSON.stringify(out).slice(0, 200));
  }));
  report(t, 'tidyOps one group', bestOf(() => {
    const out = tidy.tidyOps(board, { groupId: groupId(3) });
    assert.equal(out.ok, true);
  }));
});

/** 40 additions in the order a proposal reads them: new notes and links, appends, connections, moves and two tidies. */
function proposalChanges(board) {
  const ids = Object.keys(board.cards);
  const notes = Object.values(board.cards).filter((card) => card.kind === 'note');
  const changes = [];
  const add = (card) => ({ n: changes.length + 1, ops: [{ op: 'card.add', card }] });
  for (let i = 0; i < 18; i += 1) changes.push(add({ id: uid('0000000b', i + 1), kind: 'note', group_id: groupId(1 + (i % 20)), data: { text: `New note ${i}` } }));
  for (let i = 18; i < 24; i += 1) changes.push(add({ id: uid('0000000b', i + 1), kind: 'link', data: { url: `https://example.com/new/${i}`, title: `New ${i}` } }));
  for (let i = 0; i < 6; i += 1) changes.push({ n: changes.length + 1, append: { id: notes[i].id, text: `appended ${i}` } });
  for (let i = 0; i < 4; i += 1) {
    changes.push({ n: changes.length + 1, ops: [{ op: 'connector.add', connector: { id: uid('0000000c', i + 1), from: uid('0000000b', i + 1), to: ids[i * 11] } }] });
  }
  for (let i = 0; i < 4; i += 1) changes.push({ n: changes.length + 1, move: { id: notes[10 + i].id, group_id: groupId(1 + ((i + 7) % 20)) } });
  changes.push({ n: changes.length + 1, tidy: { group_id: groupId(5) } });
  changes.push({ n: changes.length + 1, tidy: { group_id: groupId(6) } });
  assert.equal(changes.length, 40);
  return changes;
}

test('model: planAdditions for a 40-addition proposal (runs on every listProposals)', (t) => {
  // On a board with room: every addition lands. On the full 500-card board: the card additions are refused one at a time
  // and the plan is tried again after each, the slowest path.
  const room = buildBoard({ cards: 460, connectors: 540 });
  let made = 0;
  const context = { now: NOW, makeId: () => `plan-${(made += 1)}` };
  report(t, 'planAdditions 40 additions', bestOf(() => {
    const plan = planAdditions(room, proposalChanges(room), context);
    assert.ok(plan.applied.length >= 38, JSON.stringify(plan.skipped));
  }));
  const full = board500();
  report(t, 'planAdditions 40 additions, board at the card limit', bestOf(() => {
    const plan = planAdditions(full, proposalChanges(full), context);
    assert.ok(plan.skipped.length >= 24 && plan.applied.length >= 10, `${plan.applied.length} applied, ${plan.skipped.length} skipped`);
  }));
});

test('model: pack and unpack of the 500-card board (no pictures)', (t) => {
  const board = board500();
  let text = '';
  report(t, 'package pack', bestOf(() => {
    const out = boardPackage.pack({ board, assets: [], now: NOW });
    assert.equal(out.ok, true);
    text = out.text;
  }));
  let made = 0;
  report(t, 'package unpack', bestOf(() => {
    const out = boardPackage.unpack(text, { makeId: () => uid('0000000d', (made += 1)), now: NOW, projectId: PROJECT_ID,
      newBoardId: 'board_00000000-0000-4000-8000-0000000000d1', name: 'Copy' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(Object.keys(out.board.cards).length, 500);
  }));
});

/* ---------------------------------------------------------------- the main-process service over a temp profile */

test('service: create and seed, one card.place apply, and get with the cache dropped', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-perf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'profile');
  fs.mkdirSync(userDataPath);
  let seq = 1000;
  const open = () => createBoardService({ store: createBoardStore({ userDataPath }), now: () => new Date(Date.parse(NOW)),
    makeId: () => uid('00000008', (seq += 1)), isEnabled: () => true, projectExists: () => true });
  const batches = seedBatches();
  assert.equal(batches.length, 6);
  const seed = async (service, projectId) => {
    const made = await service.create({ projectId, name: 'Five hundred' });
    assert.equal(made.ok, true, JSON.stringify(made));
    for (let i = 0; i < batches.length; i += 1) {
      const applied = await service.apply({ boardId: made.board.id, batch: { batch_id: `seed-${i}`, board_id: made.board.id, ops: batches[i] } });
      assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 300));
    }
    return made.board.id;
  };
  let projects = 0;
  const seeder = open();
  report(t, 'service create and seed (6 applies)', await bestOfAsync(async () => { await seed(seeder, `project_perf${(projects += 1)}`); }));

  const service = open();
  const boardId = await seed(service, 'project_perfmain');
  report(t, 'service apply one card.place', await bestOfAsync(async () => {
    const n = next();
    const applied = await service.apply({ boardId, batch: { batch_id: batchId(), board_id: boardId, ops: [{ op: 'card.place', id: cardAt(n), x: 50 + n, y: 60 }] } });
    assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 300));
  }));
  report(t, 'service get after the cache is dropped', await bestOfAsync(async () => {
    const fresh = open();
    const got = await fresh.get({ boardId });
    assert.equal(got.ok, true);
    assert.equal(Object.keys(got.board.cards).length, 500);
  }));
});

/* ---------------------------------------------------------------- the page in jsdom */

const SMALL_ID = 'board_00000000-0000-4000-8000-0000000000a1';

async function pageHarness(t) {
  const dom = new JSDOM('<!doctype html><body><section id="boardView"></section></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const small = model.createBoard({ id: SMALL_ID, project_id: PROJECT_ID, name: 'Small', now: NOW });
  assert.equal(small.ok, true);
  let seq = 100;
  const boards = createMemoryBoardSource({ model, makeId: () => uid('00000009', (seq += 1)), seed: [small.board, board500()] });
  window.jennyShell = { boards };
  const h = { window, doc: window.document, editor: null, logs: [] };
  window.rendererBoardEditor = { createBoardEditor: (deps) => { h.editor = boardEditor.createBoardEditor(deps); return h.editor; } };
  const store = new Map();
  const storage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => { store.set(key, String(value)); } };
  h.page = boardPage.showBoardPage({ container: h.doc.getElementById('boardView'), windowRef: window, storage,
    appendClientLog: (...args) => h.logs.push(args), getProjectSwitcher: async () => null });
  t.after(() => { boardPage.hideBoardPage(); window.close(); });
  await h.page.started;
  await flush();
  h.cards = () => h.doc.querySelectorAll('.inv-board-card:not([data-card-kind="group"])');
  h.choose = (view) => h.doc.querySelector(`[data-board-view-switch] [data-value="${view}"]`).click();
  return h;
}

test('page: opening the 500-card board, moving one card, and the outline', async (t) => {
  const h = await pageHarness(t);
  assert.equal(h.page.getOpenBoardId(), SMALL_ID);
  assert.equal(h.cards().length, 0);
  const bigId = board500().id;

  report(t, 'page openBoard to 500 card elements', await bestOfAsync(async () => {
    await h.page.openBoard(bigId);
    assert.equal(h.cards().length, 500);
  }, async () => { await h.page.openBoard(SMALL_ID); await flush(); }));
  await h.page.openBoard(bigId);
  await flush();
  assert.equal(h.page.getOpenBoardId(), bigId);
  assert.equal(h.cards().length, 500);
  assert.equal(h.editor.getBoard().id, bigId);

  // One card moved: how long until the canvas shows it, and how many card elements the redraw replaced or touched.
  const target = cardAt(123);
  let step = 0;
  const move = () => h.editor.placeItems([{ id: target, x: 400 + (step += 1) * 8, y: 300 }]);
  let pending = null;
  report(t, 'page move one card, optimistic redraw', bestOf(() => { pending = move(); }, () => {}));
  await pending;
  await flush();
  const before = new Map(Array.from(h.doc.querySelectorAll('[data-card-id]'), (el) => [el.getAttribute('data-card-id'), el]));
  const canvas = h.doc.querySelector('.inv-board-canvas');
  const touched = new Set();
  const connectorsTouched = new Set();
  const observer = new h.window.MutationObserver((records) => {
    records.forEach((record) => {
      const card = record.target.closest ? record.target.closest('[data-card-id]') : record.target.parentElement && record.target.parentElement.closest('[data-card-id]');
      if (card) touched.add(card.getAttribute('data-card-id'));
      const conn = record.target.closest ? record.target.closest('[data-connector-id]') : record.target.parentElement && record.target.parentElement.closest('[data-connector-id]');
      if (conn) connectorsTouched.add(conn.getAttribute('data-connector-id'));
    });
  });
  observer.observe(canvas, { subtree: true, childList: true, attributes: true, characterData: true });
  let outlineTouched = 0;
  const outlineWatch = new h.window.MutationObserver((records) => { outlineTouched += records.length; });
  outlineWatch.observe(h.doc.querySelector('.board-outline'), { subtree: true, childList: true, attributes: true, characterData: true });
  await move();
  await flush();
  observer.disconnect();
  outlineWatch.disconnect();
  const after = new Map(Array.from(h.doc.querySelectorAll('[data-card-id]'), (el) => [el.getAttribute('data-card-id'), el]));
  const replaced = Array.from(before).filter(([id, el]) => after.get(id) !== el).length;
  assert.equal(after.size, before.size);
  t.diagnostic(`perf page move one card: card elements replaced ${replaced}, touched ${touched.size}, connector groups touched ${connectorsTouched.size}`);
  assert.equal(outlineTouched, 0, 'a move redrew the outline while it was hidden');
  assert.ok(replaced <= 2, `a move replaced ${replaced} card elements`);
  assert.ok(touched.size <= 4, `a move touched ${touched.size} card elements`);
  assert.ok(connectorsTouched.size <= 16, `a move touched ${connectorsTouched.size} connectors`);
  report(t, 'page move one card, until the source answered', await bestOfAsync(async () => { await move(); }));

  // Selecting on the canvas, and dragging: one frame of a drag, and the whole gesture of a group with its members.
  let flip = 0;
  report(t, 'page select one card on the canvas', bestOf(() => { h.editor.select([cardAt(10 + ((flip += 1) % 2) * 50)]); }));
  const surfaceEl = h.doc.querySelector('.inv-board-canvas');
  const ptr = (type, target, x, y) => target.dispatchEvent(new h.window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y }));
  const groupEl = () => h.doc.querySelector(`[data-card-id="${groupId(1)}"]`);
  h.editor.clearSelection();
  ptr('pointerdown', groupEl(), 100, 100);
  ptr('pointermove', surfaceEl, 110, 110);
  let at = 110;
  report(t, 'page drag frame, a group with its members', bestOf(() => { ptr('pointermove', surfaceEl, (at += 3), 120); }));
  ptr('pointerup', surfaceEl, at, 120);
  await flush();
  const members = Object.values(h.editor.getBoard().cards).filter((card) => card.group_id === groupId(1)).length;
  assert.ok(members >= 20, `group 1 holds ${members} cards`);
  let lane = 0;
  report(t, 'page drag a group with its members, down to up', bestOf(() => {
    lane += 40;
    ptr('pointerdown', groupEl(), 100, 100);
    ptr('pointermove', surfaceEl, 100 + lane, 140);
    ptr('pointerup', surfaceEl, 100 + lane, 140);
  }));
  await flush();

  // The outline of the same board: building it, then a selection change while it shows.
  report(t, 'outline build', bestOf(() => { h.choose('outline'); assert.equal(h.page.getView(), 'outline'); }, () => { h.choose('canvas'); }));
  const outline = h.doc.querySelector('.board-outline');
  assert.ok(outline.querySelectorAll('li[role="treeitem"]').length >= 520);
  let pick = 0;
  report(t, 'outline selection change', bestOf(() => { h.editor.select([cardAt(10 + ((pick += 1) % 2) * 50)]); }));
  // The sketch renderer is a script of the app, not loaded here: its cards say so and stay as titles.
  assert.deepEqual(h.logs.filter(([level, event]) => level === 'WARN' && event !== 'board.diagram_not_drawn'), []);
});
