'use strict';

// new-test-file: renderer-board-canvas-editing.test.js is at the line cap; this is the note's drawn text on the canvas (row 150 slice B12): marks, and what a press on a web link does.
// Real canvas view, interactions and card editor over the real primitives, the real editor and the in-memory source, in jsdom.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardEditor } = require('../renderer/features/board/board-editor');
const { createBoardCanvasView } = require('../renderer/features/board/board-canvas-view');
const interactions = require('../renderer/features/board/board-canvas-interactions');
const cardEditing = require('../renderer/features/board/board-card-editing');
const actionButton = require('../renderer/inventory/action-button');
const canvasSurface = require('../renderer/inventory/canvas-surface');
const boardCard = require('../renderer/inventory/board-card');
const connectorLayer = require('../renderer/inventory/connector-layer');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [NOTE, LINK, CHAT] = [uid(901), uid(902), uid(903)];
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const TEXT = '**Risks**\n- see [the spec](https://example.org/spec)\n- <img src=x onerror=alert(1)> and [bad](javascript:alert(1))';

async function env(t) {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const doc = window.document;
  const opened = [];
  window.open = (...args) => { opened.push(args); return null; };
  let tick = Date.parse('2026-11-14T10:00:00.000Z');
  let ids = 5000;
  const source = createMemoryBoardSource({ model, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(ids++) });
  const created = (await source.create({ projectId: 'project_alpha', name: 'Plan' })).board;
  const card = (id, kind, data, x) => ({ op: 'card.add', card: { id, kind, data, x, y: 100, w: 240, h: 160 } });
  const seeded = await source.apply({ boardId: created.id, batch: { batch_id: 'seed1', board_id: created.id, actor: 'owner', ops: [
    card(NOTE, 'note', { text: TEXT, tone: null }, 100),
    card(LINK, 'link', { url: 'https://example.com/', title: '**not bold**' }, 400),
    card(CHAT, 'chat', { session_id: 'sess_1', title: 'A chat', excerpt: '*not italics* https://example.org/x' }, 700),
  ] } });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  let mine = 0;
  const editor = createBoardEditor({ model, source, notify: () => {}, log: () => {}, makeId: () => uid(++mine), now: () => '2026-11-14T12:00:00.000Z' });
  const canvas = createBoardCanvasView({ document: doc, actionButton, canvasSurface, boardCard, connectorLayer });
  doc.body.appendChild(canvas.element);
  canvas.surface.element.getBoundingClientRect = () => ({ left: 0, top: 0, x: 0, y: 0, width: 1200, height: 600, right: 1200, bottom: 600 });
  canvas.setEditor(editor, { source, notify: () => {}, modules: { interactions, cardEditing } });
  canvas.show(seeded.board, { canUndo: true, canRedo: false });
  canvas.surface.setView({ x: 0, y: 0, zoom: 1 });
  t.after(() => { canvas.dispose(); window.close(); });
  const surfaceEl = canvas.surface.element;
  const ptr = (type, target, x, y, extra) => target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, ...extra }));
  return { window, doc, opened, editor, canvas, surfaceEl, ptr, el: (id) => doc.querySelector(`[data-card-id="${id}"]`), server: async () => (await source.get({ boardId: created.id })).board };
}

test('a note is drawn with its marks; other card kinds keep their text as written; nothing a note says becomes an element of its own', async (t) => {
  const h = await env(t);
  const text = h.el(NOTE).querySelector('[data-card-text]');
  assert.equal(text.querySelector('strong').textContent, 'Risks');
  assert.equal(text.querySelectorAll('ul > li').length, 2);
  const links = text.querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), 'https://example.org/spec');
  assert.equal(links[0].getAttribute('tabindex'), '-1', 'the canvas owns Tab');
  assert.equal(text.querySelectorAll('img, script').length, 0);
  assert.equal(text.textContent.includes('<img src=x onerror=alert(1)> and [bad](javascript:alert(1))'), true);
  assert.equal(h.el(NOTE).getAttribute('aria-label'), 'Risks', 'the name is the first line without its marks');
  assert.equal(h.el(LINK).querySelector('[data-card-title]').textContent, '**not bold**');
  assert.equal(h.el(CHAT).querySelector('[data-card-text]').children.length, 0);
  assert.equal(h.el(CHAT).querySelector('[data-card-text]').textContent, '*not italics* https://example.org/x');
});

test('a press on a note link released without a drag opens it, once, through window.open; a drag, Shift and the link own click open nothing', async (t) => {
  const h = await env(t);
  const anchor = h.el(NOTE).querySelector('a[data-note-link]');
  h.ptr('pointerdown', anchor, 150, 150);
  h.ptr('pointerup', h.surfaceEl, 150, 150);
  await flush();
  assert.deepEqual(h.opened, [['https://example.org/spec', '_blank', 'noopener,noreferrer']]);
  assert.deepEqual(h.editor.getSelection(), [NOTE], 'and the card is selected as by any click');

  const click = new h.window.MouseEvent('click', { bubbles: true, cancelable: true });
  anchor.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true, 'the link does not navigate by itself');
  const middle = new h.window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
  anchor.dispatchEvent(middle);
  assert.equal(middle.defaultPrevented, true);

  h.ptr('pointerdown', anchor, 150, 150);
  h.ptr('pointermove', h.surfaceEl, 220, 190);
  h.ptr('pointerup', h.surfaceEl, 220, 190);
  await flush();
  assert.equal((await h.server()).cards[NOTE].x, 170, 'the drag moved the card');
  h.ptr('pointerdown', h.el(NOTE).querySelector('a[data-note-link]'), 150, 150, { shiftKey: true });
  h.ptr('pointerup', h.surfaceEl, 150, 150, { shiftKey: true });
  await flush();
  h.ptr('pointerdown', h.el(NOTE).querySelector('strong'), 150, 150);
  h.ptr('pointerup', h.surfaceEl, 150, 150);
  await flush();
  assert.equal(h.opened.length, 1, 'nothing else opened');
});

test('an address that is not the web never leaves, even on a link node made by something else', async (t) => {
  const h = await env(t);
  const forged = h.doc.createElement('a');
  forged.setAttribute('data-note-link', '');
  forged.setAttribute('href', 'file:///C:/Windows/system32/calc.exe');
  forged.textContent = 'x';
  h.el(NOTE).querySelector('[data-card-text]').appendChild(forged);
  h.ptr('pointerdown', forged, 150, 150);
  h.ptr('pointerup', h.surfaceEl, 150, 150);
  await flush();
  assert.deepEqual(h.opened, []);
});
