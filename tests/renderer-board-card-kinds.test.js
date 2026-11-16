'use strict';

// new-test-file: a new surface (the card kinds seam of row 150 wave 4: how a file, picture, chat or diagram card's
// module adds its picture, its Enter action and its toolbar button); the canvas's own editing is in
// renderer-board-canvas-editing.test.js, which is near the line cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardEditor } = require('../renderer/features/board/board-editor');
const { createBoardCanvasView } = require('../renderer/features/board/board-canvas-view');
const { createBoardOutlineView } = require('../renderer/features/board/board-outline-view');
const interactions = require('../renderer/features/board/board-canvas-interactions');
const toolbar = require('../renderer/features/board/board-canvas-toolbar');
const cardEditing = require('../renderer/features/board/board-card-editing');
const cardKinds = require('../renderer/features/board/board-card-kinds');
const manifest = require('../renderer/shell/renderer-board-script-manifest');
const actionButton = require('../renderer/inventory/action-button');
const canvasSurface = require('../renderer/inventory/canvas-surface');
const boardCard = require('../renderer/inventory/board-card');
const connectorLayer = require('../renderer/inventory/connector-layer');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [NOTE, FILE, CHAT] = [uid(901), uid(902), uid(903)];
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const add = (id, kind, data, x) => ({ op: 'card.add', card: { id, kind, data, x, y: 100, w: 200, h: 100 } });
const BASE = () => [
  add(NOTE, 'note', { text: 'alpha', tone: null }, 100),
  add(FILE, 'file', { path: 'src/app.js', title: '' }, 400),
  add(CHAT, 'chat', { session_id: 'sess_1', message_id: null, title: 'Kickoff', excerpt: 'hello' }, 700),
];

/** A kinds module whose registry is this test's own map, so nothing leaks between tests. */
function isolated(factories) {
  return { createBoardCardKinds: (ctx) => cardKinds.createBoardCardKinds({ ...ctx, factories }) };
}

async function env(t, factories, { readOnly = false } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  let tick = Date.parse('2026-11-13T10:00:00.000Z');
  let ids = 5000;
  let mine = 0;
  const source = createMemoryBoardSource({ model, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(ids++) });
  const created = (await source.create({ projectId: 'project_alpha', name: 'Plan' })).board;
  const seeded = await source.apply({ boardId: created.id, batch: { batch_id: 'seed1', board_id: created.id, actor: 'owner', ops: BASE() } });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  const logs = [];
  const log = (level, event, data) => logs.push({ level, event, ...data });
  const editor = createBoardEditor({ model, source, notify: () => {}, log, makeId: () => uid(++mine), now: () => '2026-11-13T12:00:00.000Z' });
  const canvas = createBoardCanvasView({ document: doc, actionButton, canvasSurface, boardCard, connectorLayer });
  doc.body.appendChild(canvas.element);
  canvas.surface.element.getBoundingClientRect = () => ({ left: 0, top: 0, x: 0, y: 0, width: 800, height: 600, right: 800, bottom: 600 });
  canvas.setEditor(editor, {
    source, notify: () => {}, log, context: { state: { marker: 1 }, getProjectId: () => 'project_alpha' },
    modules: { interactions, toolbar, cardEditing, cardKinds: isolated(factories) },
  });
  canvas.show(seeded.board, { canUndo: true, canRedo: false, readOnly });
  t.after(() => { canvas.dispose(); window.close(); });
  return {
    window, doc, source, editor, canvas, logs, id: created.id,
    el: (id) => doc.querySelector(`[data-card-id="${id}"]`),
    tool: (name) => doc.querySelector(`[data-board-tool="${name}"]`),
    async dbl(target) { target.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); await flush(); },
    server: async () => (await source.get({ boardId: created.id })).board,
  };
}

test('register takes a name and a factory; the seam is in the Board page list before the editor uses it', () => {
  assert.equal(cardKinds.register('', () => ({})), false);
  assert.equal(cardKinds.register('x', null), false);
  const names = manifest.map((entry) => entry[0]);
  const seam = names.indexOf('renderer/features/board/board-card-kinds.js');
  assert.ok(seam > 0, 'the seam is in the lazy list');
  assert.ok(seam < names.indexOf('renderer/features/board/board-canvas-view.js'));
  assert.equal(manifest[seam][1], 'rendererBoardCardKinds');
});

test('a part decorates only its kind, is skipped when nothing changed, and is told when a card leaves', () => {
  const calls = [];
  const factories = new Map([
    ['files', () => ({ kind: 'file', decorate: (el, card, state) => calls.push(['file', card.id, state.editable]), release: (id) => calls.push(['release', id]) })],
    ['all', () => ({ decorate: (el, card) => calls.push(['all', card.id]) })],
  ]);
  const kinds = cardKinds.createBoardCardKinds({ factories });
  assert.deepEqual(kinds.names(), ['files', 'all']);
  const el = {};
  const file = { id: 'f', kind: 'file', content_rev: 1, w: 10, h: 10 };
  kinds.decorate(el, file, { editable: true });
  kinds.decorate(el, { id: 'n', kind: 'note', content_rev: 1, w: 10, h: 10 }, { editable: true });
  assert.deepEqual(calls, [['file', 'f', true], ['all', 'f'], ['all', 'n']]);
  kinds.decorate(el, file, { editable: true });
  assert.equal(calls.length, 3, 'an unchanged card is not decorated again');
  kinds.decorate(el, { ...file, content_rev: 2 }, { editable: true });
  kinds.decorate(el, { ...file, content_rev: 2, w: 20 }, { editable: true });
  kinds.decorate(el, { ...file, content_rev: 2, w: 20 }, { editable: false });
  assert.equal(calls.filter((call) => call[0] === 'file').length, 4, 'content, size and editability each count as a change');
  kinds.decorate(null, file, {});
  kinds.release('f');
  kinds.release('f');
  kinds.release('never-drawn');
  assert.deepEqual(calls.filter((call) => call[0] === 'release'), [['release', 'f']]);
  kinds.dispose();
  kinds.decorate(el, { ...file, content_rev: 9 }, {});
  assert.equal(calls.filter((call) => call[0] === 'file').length, 4, 'nothing runs after dispose');
});

test('a part that throws costs only itself: the others run and the failure is logged', () => {
  const logs = [];
  const seen = [];
  const factories = new Map([
    ['broken-factory', () => { throw new Error('boom'); }],
    ['not-a-part', () => 'nope'],
    ['broken', () => ({ decorate() { throw new Error('boom'); }, activate() { throw new Error('boom'); }, props() { throw new Error('boom'); }, dispose() { throw new Error('boom'); } })],
    ['fine', () => ({ decorate: (el, card) => seen.push(card.id), activate: () => true, props: () => ({ missing: true }), dispose: () => seen.push('disposed') })],
  ]);
  const kinds = cardKinds.createBoardCardKinds({ factories, log: (level, event, data) => logs.push(`${event}:${data.name}:${data.step}`) });
  assert.deepEqual(kinds.names(), ['broken', 'fine']);
  const card = { id: 'c', kind: 'chat', content_rev: 1, w: 1, h: 1 };
  kinds.decorate({}, card, {});
  assert.deepEqual(seen, ['c']);
  assert.equal(kinds.activate(card), true);
  assert.deepEqual(kinds.props(card), { missing: true });
  kinds.dispose();
  assert.deepEqual(seen, ['c', 'disposed']);
  assert.deepEqual(logs, [
    'board.card_kind_failed:broken-factory:create', 'board.card_kind_failed:broken:decorate', 'board.card_kind_failed:broken:activate',
    'board.card_kind_failed:broken:props', 'board.card_kind_failed:broken:dispose',
  ]);
});

test('activate asks the parts of the card kind in order and stops at the first that takes it', () => {
  const asked = [];
  const factories = new Map([
    ['images', () => ({ kind: 'image', activate: () => { asked.push('image'); return true; } })],
    ['first', () => ({ kind: 'file', activate: (card, origin) => { asked.push(`first:${origin}`); return false; } })],
    ['second', () => ({ kind: 'file', activate: (card, origin) => { asked.push(`second:${origin}`); return true; } })],
    ['third', () => ({ kind: 'file', activate: () => { asked.push('third'); return true; } })],
  ]);
  const kinds = cardKinds.createBoardCardKinds({ factories });
  assert.equal(kinds.activate({ id: 'f', kind: 'file' }, 'outline'), true);
  assert.deepEqual(asked, ['first:outline', 'second:outline']);
  assert.equal(kinds.activate({ id: 'n', kind: 'note' }), false);
  assert.equal(kinds.activate(null), false);
});

test('tools are checked, de-duplicated and sorted, and a tool that fails does not reject', async () => {
  const logs = [];
  let ran = 0;
  const factories = new Map([
    ['a', () => ({ tools: [
      { id: 'picture', label: 'Picture', title: 'Add a picture', order: 30, run: () => { ran += 1; } },
      { id: 'Bad Id', label: 'x', run: () => {} },
      { id: 'no-run', label: 'x' },
      null,
    ] })],
    ['b', () => ({ tools: [
      { id: 'file', label: 'File', order: 10, run: async () => { throw new Error('boom'); } },
      { id: 'picture', label: 'Again', order: 1, run: () => {} },
      { id: 'late', run: () => { throw new Error('sync'); } },
    ] })],
  ]);
  const kinds = cardKinds.createBoardCardKinds({ factories, log: (level, event, data) => logs.push(`${data.name}:${data.step}`) });
  const tools = kinds.tools();
  assert.deepEqual(tools.map((tool) => [tool.id, tool.label, tool.title, tool.order]), [
    ['file', 'File', 'File', 10], ['picture', 'Picture', 'Add a picture', 30], ['late', 'late', 'late', 100],
  ]);
  await tools[1].run();
  assert.equal(ran, 1);
  await tools[0].run();
  await tools[2].run();
  assert.deepEqual(logs, ['b:tool:file', 'b:tool:late']);
});

test('on the canvas a kind draws into the media slot, adds props, and the slot survives a redraw', async (t) => {
  let ctxSeen = null;
  let missing = false;
  const released = [];
  const factories = new Map([['files', (ctx) => {
    ctxSeen = ctx;
    return {
      kind: 'file',
      props: () => ({ missing }),
      decorate(element, card) {
        const slot = ctx.boardCard.media(element);
        slot.textContent = `picture of ${card.data.path} rev ${card.content_rev}`;
      },
      release: (id) => released.push(id),
    };
  }]]);
  const h = await env(t, factories);
  for (const key of ['document', 'windowRef', 'editor', 'source', 'notify', 'log', 'jt', 'actionButton', 'boardCard', 'surface', 'host', 'context']) {
    assert.ok(ctxSeen[key], `ctx.${key}`);
  }
  assert.equal(ctxSeen.context.getProjectId(), 'project_alpha');
  assert.equal(ctxSeen.context.state.marker, 1);
  const slot = h.el(FILE).querySelector('[data-card-media]');
  assert.ok(slot && slot.parentElement.hasAttribute('data-card-body'), 'the slot sits in the card body');
  assert.equal(slot.textContent, 'picture of src/app.js rev 0');
  assert.equal(h.el(NOTE).querySelector('[data-card-media]'), null, 'another kind has no slot');
  assert.equal(h.el(FILE).hasAttribute('data-missing'), false);

  missing = true;
  ctxSeen.host.redraw();
  assert.equal(h.el(FILE).hasAttribute('data-missing'), true, 'props from the kind reach the card');
  assert.equal(h.el(FILE).querySelector('[data-card-media]'), slot, 'the same slot after a redraw');

  await h.editor.editCard(FILE, { title: 'App entry' });
  await flush();
  assert.equal(h.el(FILE).querySelector('[data-card-media]').textContent, 'picture of src/app.js rev 1', 'a content change decorates again');

  h.editor.select([FILE]);
  await h.editor.removeSelected();
  await flush();
  assert.deepEqual(released, [FILE]);
  assert.equal(boardCard.media(h.el(NOTE)).getAttribute('data-card-media'), '', 'media() makes the slot on first use');
});

test('a double-click and Enter open a card through its kind; a note still gets its editor', async (t) => {
  const opened = [];
  const factories = new Map([['open', () => ({ activate(card, origin) { if (card.kind === 'note') return false; opened.push(`${card.kind}:${origin}`); return true; } })]]);
  const h = await env(t, factories);
  await h.dbl(h.el(FILE));
  assert.deepEqual(opened, ['file:canvas']);
  assert.equal(h.canvas.startEdit(CHAT), true);
  assert.deepEqual(opened, ['file:canvas', 'chat:canvas']);
  await h.dbl(h.el(NOTE));
  assert.ok(h.doc.querySelector('[data-board-editor] textarea'), 'the note opens its inline editor');
  assert.equal(opened.length, 2, 'a card with an editor is not handed to a kind');
  assert.equal(h.canvas.activate('missing', 'canvas'), false);
});

test('on a read-only board a kind still opens its card, and a note does nothing', async (t) => {
  const opened = [];
  const factories = new Map([['open', () => ({ kind: 'file', activate(card) { opened.push(card.id); return true; }, tools: [{ id: 'file', label: 'File', title: 'Add a file', run: () => { opened.push('tool'); } }] })]]);
  const h = await env(t, factories, { readOnly: true });
  await h.dbl(h.el(FILE));
  assert.deepEqual(opened, [FILE]);
  await h.dbl(h.el(NOTE));
  assert.equal(h.doc.querySelector('[data-board-editor]'), null);
  const button = h.tool('kind-file');
  assert.equal(button.disabled, true);
  assert.equal(button.title, 'This board cannot be changed.');
  button.click();
  await flush();
  assert.deepEqual(opened, [FILE], 'a disabled tool does not run');
});

test('a kind tool is a toolbar button after Link; it runs and can add a card through editor.addCard', async (t) => {
  let ctxSeen = null;
  const factories = new Map([['diagrams', (ctx) => {
    ctxSeen = ctx;
    return { tools: [{ id: 'diagram', label: 'Diagram', title: 'Add a diagram', order: 40, run: () => ctx.editor.addCard({ kind: 'diagram', data: { scene: 'a -> b', title: 'Flow' }, x: 40, y: 400 }) }] };
  }]]);
  const h = await env(t, factories);
  const button = h.tool('kind-diagram');
  assert.equal(button.textContent.trim(), 'Diagram');
  assert.equal(button.title, 'Add a diagram');
  assert.equal(button.disabled, false);
  assert.equal(h.tool('link').nextElementSibling, button, 'after Link');
  button.click();
  await flush();
  const board = await h.server();
  const diagram = Object.values(board.cards).find((card) => card.kind === 'diagram');
  assert.deepEqual([diagram.data, diagram.x, diagram.y], [{ scene: 'a -> b', title: 'Flow' }, 40, 400]);
  assert.deepEqual(h.editor.getSelection(), [diagram.id], 'the new card is selected');

  const refused = await ctxSeen.editor.addCard({ kind: 'image', data: { asset: 'nope', width: 1, height: 1, alt: '' } });
  assert.equal(refused.ok, false, 'the model still checks what a kind adds');
  const sized = await ctxSeen.editor.addCard({ kind: 'file', data: { path: 'docs/a.md', title: '' }, w: 300, h: 90 });
  assert.equal(sized.ok, true);
  const placed = (await h.server()).cards[sized.id];
  assert.deepEqual([placed.w, placed.h, placed.kind], [300, 90, 'file']);
});

test('in the outline Enter on a card with no field asks its kind; a note keeps its field', async (t) => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const doc = dom.window.document;
  t.after(() => dom.window.close());
  const source = createMemoryBoardSource({ model, now: () => '2026-11-13T10:00:00.000Z', makeId: () => uid(7000) });
  const created = (await source.create({ projectId: 'project_alpha', name: 'Plan' })).board;
  const seeded = await source.apply({ boardId: created.id, batch: { batch_id: 'seed1', board_id: created.id, actor: 'owner', ops: BASE() } });
  const editor = createBoardEditor({ model, source, notify: () => {}, log: () => {} });
  editor.setBoard(seeded.board, { boardId: created.id });
  const asked = [];
  const outline = createBoardOutlineView({ document: doc, editor, model, actionButton, boardCard, activate: (id) => { asked.push(id); return true; } });
  doc.body.appendChild(outline.element);
  outline.show(seeded.board);
  const row = (id) => doc.querySelector(`[data-outline-id="${id}"]`);
  assert.ok(row(FILE), 'the outline drew the file card');
  const enter = (id) => row(id).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  enter(FILE);
  assert.deepEqual(asked, [FILE]);
  enter(NOTE);
  assert.deepEqual(asked, [FILE], 'a note opens its own field');
  assert.ok(doc.querySelector('[data-outline-edit]'));
  outline.dispose();
});
