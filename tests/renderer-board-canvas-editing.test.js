'use strict';

// new-test-file: a new surface (editing on the board canvas: pointer gestures, the inline editors, the toolbar and the selection bar); the editor's commands are in renderer-board-editor.test.js and the read-only drawing in renderer-board-page.test.js.
// Real canvas view, interactions, toolbar and card editor over the real primitives, the real editor and the in-memory source, in jsdom.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardEditor } = require('../renderer/features/board/board-editor');
const { createBoardCanvasView } = require('../renderer/features/board/board-canvas-view');
const interactions = require('../renderer/features/board/board-canvas-interactions');
const toolbar = require('../renderer/features/board/board-canvas-toolbar');
const cardEditing = require('../renderer/features/board/board-card-editing');
const { createBoardPage } = require('../renderer/features/board/board-page');
const actionButton = require('../renderer/inventory/action-button');
const canvasSurface = require('../renderer/inventory/canvas-surface');
const boardCard = require('../renderer/inventory/board-card');
const connectorLayer = require('../renderer/inventory/connector-layer');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, G, K1] = [uid(901), uid(902), uid(903), uid(950), uid(960)];
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const add = (id, kind, data, x, y, extra = {}) => ({ op: 'card.add', card: { id, kind, data, x, y, w: 200, h: 100, ...extra } });
const BASE = () => [add(A, 'note', { text: 'alpha', tone: null }, 100, 100), add(B, 'note', { text: 'beta', tone: null }, 400, 100), add(C, 'link', { url: 'https://example.com/', title: 'Example' }, 100, 300)];
const RECT = { left: 0, top: 0, x: 0, y: 0, width: 800, height: 600, right: 800, bottom: 600 };

async function env(t, { ops = BASE(), fetchLinkTitle, plainSource = false } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const docListeners = new Set();
  const realAdd = doc.addEventListener.bind(doc);
  const realRemove = doc.removeEventListener.bind(doc);
  doc.addEventListener = (type, fn, capture) => { docListeners.add(`${type}:${String(fn)}`); return realAdd(type, fn, capture); };
  doc.removeEventListener = (type, fn, capture) => { docListeners.delete(`${type}:${String(fn)}`); return realRemove(type, fn, capture); };
  let tick = Date.parse('2026-11-13T10:00:00.000Z');
  let ids = 5000;
  let mine = 0;
  const source = createMemoryBoardSource({ model, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(ids++) });
  const created = (await source.create({ projectId: 'project_alpha', name: 'Plan' })).board;
  const seeded = await source.apply({ boardId: created.id, batch: { batch_id: 'seed1', board_id: created.id, actor: 'owner', ops } });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  const sent = [];
  const realApply = source.apply;
  source.apply = (request) => { sent.push(request); return realApply(request); };
  const titleCalls = [];
  if (plainSource) delete source.fetchLinkTitle;
  else source.fetchLinkTitle = fetchLinkTitle ? async (request) => { titleCalls.push(request); return fetchLinkTitle(request); } : async () => ({ ok: false, reason: 'disabled' });
  const notices = [];
  const notify = (message, extra) => notices.push({ message, ...extra });
  const editor = createBoardEditor({ model, source, notify, log: () => {}, makeId: () => uid(++mine), now: () => '2026-11-13T12:00:00.000Z' });
  const canvas = createBoardCanvasView({ document: doc, actionButton, canvasSurface, boardCard, connectorLayer });
  doc.body.appendChild(canvas.element);
  canvas.surface.element.getBoundingClientRect = () => RECT;
  canvas.setEditor(editor, { source, notify, modules: { interactions, toolbar, cardEditing } });
  canvas.show(seeded.board, { canUndo: true, canRedo: false });
  canvas.surface.setView({ x: 0, y: 0, zoom: 1 });
  t.after(() => { canvas.dispose(); window.close(); });
  const surfaceEl = canvas.surface.element;
  const h = {
    window, doc, source, editor, canvas, sent, notices, titleCalls, docListeners, id: created.id,
    server: async () => (await source.get({ boardId: created.id })).board,
    el: (id) => doc.querySelector(`[data-card-id="${id}"]`),
    ptr(type, target, x, y, extra) { return target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, ...extra })); },
    key(target, key, extra) { target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })); },
    async click(id, x, y, extra) { h.ptr('pointerdown', h.el(id), x, y, extra); h.ptr('pointerup', surfaceEl, x, y, extra); await flush(); },
    async drag(from, to, { target, up = true, extra } = {}) {
      h.ptr('pointerdown', target, from[0], from[1], extra);
      h.ptr('pointermove', surfaceEl, to[0], to[1], extra);
      if (up) { h.ptr('pointerup', surfaceEl, to[0], to[1], extra); await flush(); }
    },
    async empty(x, y, extra) { h.ptr('pointerdown', surfaceEl, x, y, extra); h.ptr('pointerup', surfaceEl, x, y, extra); await flush(); },
    async dbl(target, x, y) { target.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y })); await flush(); },
    field: () => doc.querySelector('[data-board-editor] textarea'),
    sel: (name) => doc.querySelector(`[data-board-sel="${name}"]`),
    tool: (name) => doc.querySelector(`[data-board-tool="${name}"]`),
    bar: () => doc.querySelector('[data-board-selbar]'),
    ops: (i = 0) => sent[i].batch.ops,
  };
  return h;
}

const dispatchValue = (h, ta, value) => { ta.value = value; ta.dispatchEvent(new h.window.Event('input', { bubbles: true })); };

test('click selects a card, Shift+click adds and removes, a click on nothing clears, and the selected state is drawn', async (t) => {
  const h = await env(t);
  await h.click(A, 150, 120);
  assert.deepEqual(h.editor.getSelection(), [A]);
  assert.equal(h.el(A).hasAttribute('data-selected'), true);
  await h.click(B, 450, 120, { shiftKey: true });
  assert.deepEqual(h.editor.getSelection(), [A, B]);
  await h.click(A, 150, 120, { shiftKey: true });
  assert.deepEqual(h.editor.getSelection(), [B], 'a Shift+click on a selected card removes it');
  assert.equal(h.el(A).hasAttribute('data-selected'), false);
  await h.click(A, 150, 120);
  await h.click(B, 450, 120, { shiftKey: true });
  await h.click(B, 450, 120);
  assert.deepEqual(h.editor.getSelection(), [B], 'a plain click on one of several narrows to it');
  await h.empty(700, 500);
  assert.deepEqual(h.editor.getSelection(), []);
  assert.equal(h.sent.length, 0, 'selecting changes nothing on the board');
});

test('the marquee selects the cards it touches and a groups only when it holds them whole; Shift adds', async (t) => {
  const h = await env(t, { ops: [...BASE(), { op: 'group.add', group: { id: G, title: 'Team', x: 600, y: 300, w: 180, h: 160 } }] });
  await h.drag([50, 50], [350, 250], { target: h.canvas.surface.element });
  assert.deepEqual(h.editor.getSelection(), [A]);
  await h.drag([380, 90], [700, 130], { target: h.canvas.surface.element });
  assert.deepEqual(h.editor.getSelection(), [B], 'touching is enough for a card');
  await h.drag([590, 290], [790, 590], { target: h.canvas.surface.element, extra: { shiftKey: true } });
  assert.deepEqual(h.editor.getSelection(), [B, G], 'a group inside the box is added');
  await h.drag([590, 380], [790, 590], { target: h.canvas.surface.element });
  assert.deepEqual(h.editor.getSelection(), [], 'a box that only touches a group leaves it');
});

test('a click on a connector selects it, and the connector is drawn selected', async (t) => {
  const h = await env(t, { ops: [...BASE(), { op: 'connector.add', connector: { id: K1, from: A, to: B } }] });
  const board = h.editor.getBoard();
  const rect = (id) => ({ x: board.cards[id].x, y: board.cards[id].y, w: board.cards[id].w, h: board.cards[id].h });
  const mid = connectorLayer.connectorPath(rect(A), rect(B)).mid;
  await h.empty(mid.x, mid.y);
  assert.equal(h.editor.getSelectedConnector(), K1);
  assert.equal(h.doc.querySelector(`[data-connector-id="${K1}"]`).hasAttribute('data-selected'), true);
  await h.empty(700, 500);
  assert.equal(h.editor.getSelectedConnector(), '');
  assert.equal(h.doc.querySelector(`[data-connector-id="${K1}"]`).hasAttribute('data-selected'), false);
});

test('a drag follows the pointer live and sends one placeItems batch on pointer-up; Escape puts everything back and sends nothing', async (t) => {
  const h = await env(t);
  await h.drag([150, 120], [190, 150], { target: h.el(A), up: false });
  assert.equal(h.el(A).style.left, '140px');
  assert.equal(h.el(A).style.top, '130px');
  assert.equal(h.sent.length, 0, 'nothing is sent while the pointer is down');
  h.ptr('pointerup', h.canvas.surface.element, 190, 150);
  await flush();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.ops(), [{ op: 'card.place', id: A, x: 140, y: 130 }]);
  assert.equal((await h.server()).cards[A].x, 140);
  assert.deepEqual(h.editor.getSelection(), [A], 'dragging an unselected card selects it first');

  await h.drag([240, 180], [400, 400], { target: h.el(A), up: false });
  assert.notEqual(h.el(A).style.left, '140px');
  h.key(h.doc, 'Escape');
  assert.equal(h.el(A).style.left, '140px');
  assert.equal(h.el(A).style.top, '130px');
  h.ptr('pointerup', h.canvas.surface.element, 400, 400);
  await flush();
  assert.equal(h.sent.length, 1, 'Escape sent nothing');
  h.canvas.surface.element.setAttribute('data-space', '');
  await h.drag([150, 120], [250, 220], { target: h.el(A) });
  assert.equal(h.sent.length, 1, 'with Space held the surface pans and the card stays put');
});

test('dragging a selected card moves the whole selection in one batch, a group brings its members, and zoom is respected', async (t) => {
  const h = await env(t, { ops: [add(A, 'note', { text: 'a', tone: null }, 100, 100), add(B, 'note', { text: 'b', tone: null }, 400, 100),
    { op: 'group.add', group: { id: G, title: 'Team', x: 0, y: 400, w: 400, h: 190 } }, add(C, 'note', { text: 'c', tone: null }, 20, 440, { group_id: G })] });
  h.editor.select([A, B]);
  await h.drag([150, 120], [170, 160], { target: h.el(A) });
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.ops().map((op) => [op.id, op.x, op.y]), [[A, 120, 140], [B, 420, 140]]);
  assert.equal(h.el(B).style.left, '420px');
  h.editor.select([G]);
  await h.drag([300, 480], [330, 450], { target: h.el(G), up: false });
  assert.equal(h.el(C).style.left, '50px', 'the member follows the group live');
  h.ptr('pointerup', h.canvas.surface.element, 330, 450);
  await flush();
  assert.deepEqual(h.ops(1).map((op) => op.op).sort(), ['card.place', 'group.place']);
  assert.equal((await h.server()).cards[C].x, 50);
  h.canvas.surface.setView({ x: 0, y: 0, zoom: 2 });
  h.editor.select([B]);
  await h.drag([900, 300], [940, 300], { target: h.el(B) });
  assert.equal(h.ops(2)[0].x, 420 + 20, '40 screen pixels at zoom 2 are 20 board units');
});

test('the card grip resizes within limits in one batch', async (t) => {
  const h = await env(t);
  const grip = h.el(A).querySelector('[data-card-resize]');
  await h.drag([300, 200], [340, 230], { target: grip });
  assert.deepEqual(h.ops(), [{ op: 'card.place', id: A, w: 240, h: 130 }]);
  assert.equal((await h.server()).cards[A].w, 240);
  await h.drag([340, 230], [-900, -900], { target: grip });
  const card = (await h.server()).cards[A];
  assert.ok(card.w >= 8 && card.h >= 8 && card.w <= 100 && card.h <= 100, `a small card, not a negative one (${card.w} x ${card.h})`);
  const count = h.sent.length;
  await h.drag([300, 200], [340, 230], { target: grip, up: false });
  h.key(h.doc, 'Escape');
  h.ptr('pointerup', h.canvas.surface.element, 340, 230);
  await flush();
  assert.equal(h.sent.length, count);
});

test('dragging from a port to another card connects them, with a preview line; a drop on nothing, on itself or on an existing link does nothing', async (t) => {
  const h = await env(t);
  const port = h.el(A).querySelector('[data-card-connect="e"]');
  h.ptr('pointerdown', port, 300, 150);
  h.ptr('pointermove', h.canvas.surface.element, 380, 140);
  const preview = h.doc.querySelector('[data-board-connect-preview]');
  assert.ok(preview, 'a preview line follows the pointer');
  assert.notEqual(preview.querySelector('path').getAttribute('d'), '');
  assert.equal(h.sent.length, 0);
  h.ptr('pointerup', h.canvas.surface.element, 450, 140);
  await flush();
  assert.equal(h.doc.querySelector('[data-board-connect-preview]'), null, 'the preview is gone');
  assert.equal(h.sent.length, 1);
  assert.equal(h.ops()[0].op, 'connector.add');
  assert.deepEqual([h.ops()[0].connector.from, h.ops()[0].connector.to], [A, B]);
  assert.equal(Object.keys((await h.server()).connectors).length, 1);

  for (const drop of [[650, 550], [150, 130], [450, 140]]) {
    await h.drag([300, 150], drop, { target: port });
    assert.equal(h.sent.length, 1, `a drop at ${drop} sent nothing`);
    assert.equal(h.doc.querySelector('[data-board-connect-preview]'), null);
  }
  assert.match(h.notices.at(-1).message, /already connected/i, 'a repeat is told');
  await h.drag([300, 150], [150, 350], { target: port, up: false });
  h.key(h.doc, 'Escape');
  h.ptr('pointerup', h.canvas.surface.element, 150, 350);
  await flush();
  assert.equal(h.sent.length, 1, 'Escape ended the connect');
});

test('double-click on empty canvas adds a note there and opens its editor; Ctrl+Enter commits, and the new card keeps the text', async (t) => {
  const h = await env(t);
  await h.dbl(h.canvas.surface.element, 600, 400);
  assert.equal(h.sent.length, 1);
  const op = h.ops()[0];
  assert.equal(op.op, 'card.add');
  assert.deepEqual([op.card.x, op.card.y], [480, 320], 'centred on the click');
  const field = h.field();
  assert.ok(field, 'its editor is open');
  assert.equal(h.doc.activeElement, field);
  assert.equal(field.maxLength, 4000);
  dispatchValue(h, field, 'first line\nsecond line');
  h.key(field, 'Enter', { ctrlKey: true });
  await flush();
  assert.equal(h.field(), null, 'closed');
  assert.equal((await h.server()).cards[op.card.id].data.text, 'first line\nsecond line');
  assert.equal(h.el(op.card.id).querySelector('[data-card-text]').textContent, 'first line\nsecond line');
});

test('double-click on a note opens its editor: Escape cancels without a send, leaving the field commits, nothing sent for an unchanged text', async (t) => {
  const h = await env(t);
  await h.dbl(h.el(A), 150, 120);
  assert.equal(h.field().value, 'alpha');
  dispatchValue(h, h.field(), 'changed');
  h.key(h.field(), 'Escape');
  assert.equal(h.field(), null);
  assert.equal(h.sent.length, 0);
  assert.equal(h.el(A).querySelector('[data-card-text]').textContent, 'alpha');
  await h.dbl(h.el(A), 150, 120);
  h.field().dispatchEvent(new h.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  await flush();
  assert.equal(h.sent.length, 0, 'unchanged');
  assert.equal(h.field(), null);
  await h.dbl(h.el(A), 150, 120);
  dispatchValue(h, h.field(), 'by leaving');
  h.field().dispatchEvent(new h.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  await flush();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.ops(), [{ op: 'card.edit', id: A, content_rev: 0, data: { text: 'by leaving' } }]);
  assert.equal(h.field(), null);
  await h.dbl(h.el(B), 450, 120);
  const inside = h.field().parentElement;
  inside.dispatchEvent(new h.window.FocusEvent('focusout', { bubbles: true, relatedTarget: h.field() }));
  await flush();
  assert.ok(h.field(), 'focus moving inside the editor does not commit');
});

test('a stale refusal keeps the editor open with the person\'s text and says so; the next save goes through once the card is current', async (t) => {
  const h = await env(t);
  await h.dbl(h.el(A), 150, 120);
  await h.source.apply({ boardId: h.id, batch: { batch_id: 'other1', board_id: h.id, actor: 'owner', ops: [{ op: 'card.edit', id: A, content_rev: 0, data: { text: 'theirs' } }] } });
  dispatchValue(h, h.field(), 'mine');
  h.key(h.field(), 'Enter', { ctrlKey: true });
  await flush();
  assert.ok(h.field(), 'still open');
  assert.equal(h.field().value, 'mine');
  assert.match(h.doc.querySelector('[data-board-editor-status]').textContent, /changed/i);
  assert.equal((await h.server()).cards[A].data.text, 'theirs');
  h.editor.setBoard(await h.server(), { boardId: h.id });
  h.key(h.field(), 'Enter', { ctrlKey: true });
  await flush();
  assert.equal(h.field(), null);
  assert.equal((await h.server()).cards[A].data.text, 'mine');
  // The page already holds the other change when the person saves: refused once all the same, then theirs to keep.
  await h.dbl(h.el(B), 450, 120);
  await h.source.apply({ boardId: h.id, batch: { batch_id: 'other2', board_id: h.id, actor: 'owner', ops: [{ op: 'card.edit', id: B, content_rev: 0, data: { text: 'beta\nadded by Jenny' } }] } });
  h.editor.setBoard(await h.server(), { boardId: h.id });
  const before = h.sent.length;
  dispatchValue(h, h.field(), 'beta, reworded');
  h.key(h.field(), 'Enter', { ctrlKey: true });
  await flush();
  assert.deepEqual([h.sent.length, h.field().value], [before, 'beta, reworded'], 'nothing sent, the text kept');
  assert.match(h.doc.querySelector('[data-board-editor-status]').textContent, /changed/i);
  assert.equal((await h.server()).cards[B].data.text, 'beta\nadded by Jenny');
  h.key(h.field(), 'Enter', { ctrlKey: true });
  await flush();
  assert.equal((await h.server()).cards[B].data.text, 'beta, reworded');
});

test('a link\'s editor changes its address and title, and fetches a title only when asked: shown first, saved only on "Use this title"', async (t) => {
  const h = await env(t, { fetchLinkTitle: async ({ url }) => ({ ok: true, title: `Title of ${url}` }) });
  await h.dbl(h.el(C), 150, 320);
  const fields = [...h.doc.querySelectorAll('[data-board-editor] textarea')];
  assert.deepEqual(fields.map((f) => f.value), ['Example', 'https://example.com/']);
  assert.equal(h.titleCalls.length, 0, 'opening fetches nothing');
  const fetchButton = h.doc.querySelector('[data-board-fetch-title]');
  assert.equal(fetchButton.disabled, false);
  fetchButton.click();
  await flush();
  assert.deepEqual(h.titleCalls, [{ url: 'https://example.com/' }]);
  assert.equal(h.doc.querySelector('[data-board-fetched]').textContent, 'Title of https://example.com/');
  assert.equal((await h.server()).cards[C].data.title, 'Example', 'not saved yet');
  assert.equal(h.sent.length, 0);
  h.doc.querySelector('[data-board-use-title]').click();
  await flush();
  assert.equal((await h.server()).cards[C].data.title, 'Title of https://example.com/');
  assert.deepEqual(h.ops(), [{ op: 'card.edit', id: C, content_rev: 0, data: { title: 'Title of https://example.com/' } }]);
  dispatchValue(h, fields[1], 'ftp://example.org/');
  h.doc.querySelector('[data-board-fetch-title]').click();
  await flush();
  assert.equal(h.titleCalls.length, 1, 'a non-http address is not sent for fetching');
  h.key(fields[1], 'Enter', { ctrlKey: true });
  await flush();
  assert.ok(h.field(), 'a refused address keeps the editor open');
  assert.equal(h.sent.length, 1);
  dispatchValue(h, h.doc.querySelectorAll('[data-board-editor] textarea')[1], 'https://example.org/page');
  h.key(h.field(), 'Enter', { ctrlKey: true });
  await flush();
  assert.equal((await h.server()).cards[C].data.url, 'https://example.org/page');
});

test('Fetch title says why it cannot: refused addresses, no title, a source with no fetch', async (t) => {
  const answers = [{ ok: false, reason: 'refused' }, { ok: false, reason: 'no_title' }, { ok: false, reason: 'timeout' }, { ok: false, reason: 'disabled' }, { ok: false, reason: 'whatever' }];
  const h = await env(t, { fetchLinkTitle: async () => answers.shift() });
  await h.dbl(h.el(C), 150, 320);
  const texts = [];
  for (let i = 0; i < 5; i += 1) {
    h.doc.querySelector('[data-board-fetch-title]').click();
    await flush();
    texts.push(h.doc.querySelector('[data-board-editor-status]').textContent);
    assert.equal(h.doc.querySelector('[data-board-use-title]').disabled, true);
  }
  assert.equal(new Set(texts).size, 5, 'each reason has its own words');
  assert.match(texts[0], /not allowed|private/i);
  const plain = await env(t, { plainSource: true });
  await plain.dbl(plain.el(C), 150, 320);
  const button = plain.doc.querySelector('[data-board-fetch-title]');
  assert.equal(button.disabled, true);
  assert.ok(button.title.length > 0, 'with the reason as its tooltip');
});

test('a group title edits in place: Enter commits, an empty title is left as it was', async (t) => {
  const h = await env(t, { ops: [...BASE(), { op: 'group.add', group: { id: G, title: 'Team', x: 600, y: 300, w: 180, h: 160 } }] });
  await h.dbl(h.el(G), 650, 330);
  assert.equal(h.field().value, 'Team');
  dispatchValue(h, h.field(), 'Crew');
  h.key(h.field(), 'Enter');
  await flush();
  assert.equal((await h.server()).groups[G].title, 'Crew');
  assert.equal(h.field(), null);
  await h.dbl(h.el(G), 650, 330);
  dispatchValue(h, h.field(), '   ');
  h.key(h.field(), 'Enter');
  await flush();
  assert.equal((await h.server()).groups[G].title, 'Crew');
  assert.equal(h.field(), null);
});

test('the toolbar: Undo and Redo are disabled with their reason, Note adds and opens an editor, Link asks for an address and refuses a non-web one before sending', async (t) => {
  const h = await env(t);
  assert.equal(h.tool('undo').disabled, false, 'the journal has the seeded batch');
  assert.equal(h.tool('redo').disabled, true);
  assert.match(h.tool('redo').title, /nothing to redo/i);
  h.tool('undo').click();
  await flush();
  assert.equal(Object.keys(h.editor.getBoard().cards).length, 0);
  assert.equal(h.tool('undo').disabled, true);
  assert.match(h.tool('undo').title, /nothing to undo/i);
  assert.equal(h.tool('redo').disabled, false);
  h.tool('redo').click();
  await flush();
  assert.equal(Object.keys(h.editor.getBoard().cards).length, 3);

  h.tool('note').click();
  await flush();
  assert.equal(h.ops(0)[0].card.kind, 'note', 'undo and redo are not batches; the first batch sent is the note');
  assert.ok(h.field(), 'the new note is ready to type in');
  h.key(h.field(), 'Escape');

  const form = h.doc.querySelector('[data-board-link-form]');
  assert.equal(form.hidden, true);
  h.tool('link').click();
  assert.equal(form.hidden, false);
  const input = form.querySelector('textarea');
  const count = h.sent.length;
  for (const bad of ['javascript:alert(1)', 'example.com', 'ftp://example.com/', '']) {
    dispatchValue(h, input, bad);
    h.key(input, 'Enter');
    await flush();
    assert.equal(h.sent.length, count, `${bad || 'empty'} was not sent`);
    assert.equal(form.hidden, false);
    assert.ok(form.querySelector('[data-board-link-error]').textContent.length > 0);
  }
  dispatchValue(h, input, 'https://example.org/docs');
  h.key(input, 'Enter');
  await flush();
  assert.equal(form.hidden, true);
  assert.equal(h.sent.length, count + 1);
  assert.equal(h.ops(count)[0].card.data.url, 'https://example.org/docs');
  h.tool('link').click();
  h.key(form.querySelector('textarea'), 'Escape');
  assert.equal(form.hidden, true, 'Escape closes the form');
});

test('the selection bar shows only while something is selected and runs Group, Ungroup, Colour, Duplicate, Bring forward, Send back and Delete', async (t) => {
  const h = await env(t);
  assert.equal(h.bar().hidden, true);
  h.editor.select([A, B]);
  assert.equal(h.bar().hidden, false);
  assert.match(h.bar().textContent, /2 selected/);
  h.sel('group').click();
  await flush();
  const groupId = h.editor.getSelection()[0];
  assert.ok((await h.server()).groups[groupId]);
  assert.match(h.sel('group').textContent, /Ungroup/);
  h.sel('group').click();
  await flush();
  assert.equal(Object.keys((await h.server()).groups).length, 0);
  assert.match(h.sel('group').textContent, /Group$/);
  assert.equal(h.sel('colour') || null, null);
  h.editor.select([A, B]);
  h.doc.querySelector('[data-board-tone="amber"]').click();
  await flush();
  assert.equal((await h.server()).cards[A].data.tone, 'amber');
  assert.equal(h.el(A).getAttribute('data-tone'), 'amber');
  h.doc.querySelector('[data-board-tone="none"]').click();
  await flush();
  assert.equal((await h.server()).cards[A].data.tone, null);
  h.sel('duplicate').click();
  await flush();
  assert.equal(Object.keys((await h.server()).cards).length, 5);
  assert.equal(h.editor.getSelection().length, 2);
  h.sel('forward').click();
  h.sel('back').click();
  await flush();
  h.editor.select([A]);
  h.sel('delete').click();
  await flush();
  assert.equal((await h.server()).cards[A], undefined);
  assert.equal(h.bar().hidden, true, 'nothing selected, no bar');
  h.editor.select([C]);
  assert.equal(h.doc.querySelector('[data-board-tone="red"]').disabled, true, 'a link takes no colour');
  assert.match(h.doc.querySelector('[data-board-tone="red"]').title, /notes and groups/i);
});

test('a selected connector gets a label, goes solid or dashed, and can be removed from the bar', async (t) => {
  const h = await env(t, { ops: [...BASE(), { op: 'connector.add', connector: { id: K1, from: A, to: B } }] });
  h.editor.selectConnector(K1);
  assert.equal(h.bar().hidden, false);
  h.sel('label').click();
  const field = h.doc.querySelector('[data-board-label-field]');
  assert.ok(field);
  dispatchValue(h, field, 'depends on');
  h.key(field, 'Enter');
  await flush();
  assert.equal((await h.server()).connectors[K1].label, 'depends on');
  assert.equal(h.doc.querySelector(`[data-connector-id="${K1}"] text`).textContent, 'depends on');
  h.sel('style').click();
  await flush();
  assert.equal((await h.server()).connectors[K1].style, 'dashed');
  h.sel('style').click();
  await flush();
  assert.equal((await h.server()).connectors[K1].style, 'solid');
  h.sel('label').click();
  h.key(h.doc.querySelector('[data-board-label-field]'), 'Escape');
  assert.equal(h.doc.querySelector('[data-board-label-field]'), null);
  h.sel('delete').click();
  await flush();
  assert.equal(Object.keys((await h.server()).connectors).length, 0);
  assert.equal(h.bar().hidden, true);
});

test('a read-only board: the toolbar and the bar are disabled with the reason, and no gesture changes anything', async (t) => {
  const h = await env(t);
  h.editor.setBoard(await h.server(), { boardId: h.id, readOnly: true });
  for (const button of h.doc.querySelectorAll('[data-board-toolbar] button')) {
    assert.equal(button.disabled, true, button.textContent);
    assert.match(button.title, /cannot be changed/i);
  }
  assert.equal(h.el(A).querySelector('[data-card-resize]'), null);
  assert.equal(h.el(A).querySelector('[data-card-connect]'), null);
  await h.drag([150, 120], [250, 220], { target: h.el(A) });
  assert.equal(h.el(A).style.left, '100px');
  await h.dbl(h.el(A), 150, 120);
  assert.equal(h.field(), null);
  await h.dbl(h.canvas.surface.element, 600, 400);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.editor.getSelection(), [A], 'selecting still works');
  for (const button of h.doc.querySelectorAll('[data-board-selbar] button')) assert.equal(button.disabled, true, button.textContent || button.title);
});

test('text from a document stays text: a hostile note, link title, group title and connector label are shown, never parsed', async (t) => {
  const evil = '<img src=x onerror="globalThis.pwned=1">';
  const script = '</script><b id="x">bold</b>';
  const h = await env(t, { ops: [add(A, 'note', { text: evil, tone: null }, 100, 100), add(B, 'note', { text: script, tone: null }, 400, 100),
    add(C, 'link', { url: 'https://example.com/', title: evil }, 100, 300), { op: 'group.add', group: { id: G, title: script, x: 600, y: 300, w: 180, h: 160 } },
    { op: 'connector.add', connector: { id: K1, from: A, to: B, label: evil } }] });
  const canvasEl = h.canvas.element;
  assert.equal(canvasEl.querySelector('img, b, script'), null);
  assert.equal(h.el(A).querySelector('[data-card-text]').textContent, evil);
  assert.equal(h.el(B).querySelector('[data-card-text]').textContent, script);
  assert.equal(h.el(C).querySelector('[data-card-title]').textContent, evil);
  assert.equal(h.el(G).querySelector('[data-card-title]').textContent, script);
  assert.equal(h.doc.querySelector(`[data-connector-id="${K1}"] text`).textContent, evil);
  await h.dbl(h.el(A), 150, 120);
  assert.equal(h.field().value, evil);
  assert.equal(canvasEl.querySelector('img, b, script'), null, 'nor in the editor');
  dispatchValue(h, h.field(), script);
  h.key(h.field(), 'Enter', { ctrlKey: true });
  await flush();
  assert.equal(h.el(A).querySelector('[data-card-text]').textContent, script);
  assert.equal(canvasEl.querySelector('img, b, script'), null);
  assert.equal(h.window.pwned, undefined);
});

test('the canvas gives the keyboard focusItem, startEdit, zoomBy and setMatches', async (t) => {
  const h = await env(t, { ops: [...BASE(), add(uid(904), 'file', { path: 'a.txt', title: '' }, 400, 300)] });
  assert.equal(h.canvas.focusItem(A), true);
  assert.equal(h.doc.activeElement, h.el(A));
  assert.equal(h.canvas.focusItem(uid(999)), false);
  assert.equal(h.canvas.startEdit(A), true);
  assert.ok(h.field());
  h.key(h.field(), 'Escape');
  assert.equal(h.canvas.startEdit(C), true);
  h.key(h.field(), 'Escape');
  assert.equal(h.canvas.startEdit(uid(904)), false, 'a file card has no inline editor');
  assert.equal(h.canvas.startEdit(uid(999)), false);
  const before = h.canvas.surface.getView();
  h.canvas.zoomBy(2);
  const after = h.canvas.surface.getView();
  assert.equal(after.zoom, before.zoom * 2);
  const centre = h.canvas.surface.toBoard(400, 300);
  assert.ok(Math.abs(centre.x - 400) < 1e-6 && Math.abs(centre.y - 300) < 1e-6, 'about the centre of the view');
  h.canvas.setMatches([A]);
  assert.equal(h.el(A).hasAttribute('data-board-dim'), false);
  assert.equal(h.el(B).hasAttribute('data-board-dim'), true);
  h.canvas.setMatches(null);
  assert.equal(h.el(B).hasAttribute('data-board-dim'), false);
  assert.equal(typeof h.canvas.fit, 'function');
  assert.equal(typeof h.canvas.actualSize, 'function');
});

test('dispose stops what the canvas started: no document listener is left, the editor is disposed, and the DOM is gone', async (t) => {
  const h = await env(t);
  await h.dbl(h.el(A), 150, 120);
  h.canvas.dispose();
  assert.deepEqual([...h.docListeners], [], 'every document listener was removed');
  assert.equal(h.doc.querySelector('[data-board-toolbar]'), null);
  assert.equal(h.doc.querySelector('.inv-board-canvas'), null);
  assert.equal((await h.editor.addNote({})).ok, false, 'the editor was disposed with it');
  h.canvas.dispose();
});

test('through the page: the editor is built once the source is chosen, double-click adds a note, the toolbar shows, and dispose takes it all away', async (t) => {
  const dom = new JSDOM('<!doctype html><body><section id="boardView"></section></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  let ids = 7000;
  const source = createMemoryBoardSource({ model, makeId: () => uid(ids++) });
  const board = (await source.create({ projectId: 'project_alpha', name: 'Plan' })).board;
  const gets = { n: 0, real: source.get };
  source.get = (request) => { gets.n += 1; return gets.real(request); };
  window.jennyShell = { boards: new Proxy({}, { get: (_t, name) => (name === 'onChanged' ? (fn) => source.onChanged(fn) : (request) => source[name](request)) }) };
  const switcher = { currentProject: () => ({ id: 'project_alpha', name: 'Alpha' }), refresh: async () => [], onProjectsChanged: () => () => {} };
  const page = createBoardPage({ container: window.document.getElementById('boardView'), windowRef: window, storage: window.localStorage, showToast: () => {}, getProjectSwitcher: async () => switcher });
  t.after(() => { page.dispose(); window.close(); });
  await page.started;
  await flush();
  const doc = window.document;
  const surfaceEl = doc.querySelector('.inv-board-canvas');
  surfaceEl.getBoundingClientRect = () => RECT;
  assert.ok(doc.querySelector('[data-board-toolbar]'));
  assert.equal(doc.querySelector('[data-board-selbar]').hidden, true);
  const readsBefore = gets.n;
  surfaceEl.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
  await flush();
  assert.equal(gets.n, readsBefore, 'the page does not read the board again for a batch its own editor sent');
  assert.equal(Object.keys((await gets.real({ boardId: board.id })).board.cards).length, 1, 'the note was stored');
  assert.equal(doc.querySelectorAll('.inv-board-card').length, 1);
  assert.ok(doc.querySelector('[data-board-editor] textarea'), 'and its editor is open');
  page.dispose();
  assert.equal(doc.querySelector('[data-board-toolbar]'), null);
  assert.equal(doc.querySelector('.inv-board-canvas'), null);
});
