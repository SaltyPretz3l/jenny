'use strict';

// new-test-file: tests/renderer-board-canvas-editing.test.js is two lines under the 600-line cap. This file holds one rule of the
// same surface (owner, 2026-11-15): a note made a moment ago with the Note tool or a double-click is already on the board when
// its editor opens, so cancelling its creation takes it off again. Escape removes it whatever was typed; leaving it with nothing
// typed removes it too. Ctrl+Enter keeps it, the window losing focus keeps it, and a note that was there before is never removed.
// Real canvas view, interactions, toolbar, card editor and board editor over the in-memory source, in jsdom.

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
const actionButton = require('../renderer/inventory/action-button');
const canvasSurface = require('../renderer/inventory/canvas-surface');
const boardCard = require('../renderer/inventory/board-card');
const connectorLayer = require('../renderer/inventory/connector-layer');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = uid(901);
const RECT = { left: 0, top: 0, x: 0, y: 0, width: 800, height: 600, right: 800, bottom: 600 };
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

async function env(t) {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const doc = window.document;
  let tick = Date.parse('2026-11-15T10:00:00.000Z');
  let ids = 5000;
  let mine = 0;
  const source = createMemoryBoardSource({ model, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(ids++) });
  const created = (await source.create({ projectId: 'project_alpha', name: 'Plan' })).board;
  const seed = [{ op: 'card.add', card: { id: A, kind: 'note', data: { text: 'alpha', tone: null }, x: 100, y: 100, w: 200, h: 100 } }];
  const seeded = await source.apply({ boardId: created.id, batch: { batch_id: 'seed1', board_id: created.id, actor: 'owner', ops: seed } });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  const sent = [];
  const realApply = source.apply;
  source.apply = (request) => { sent.push(request.batch.ops.map((op) => op.op)); return realApply(request); };
  source.fetchLinkTitle = async () => ({ ok: false, reason: 'disabled' });
  const notices = [];
  const notify = (message) => notices.push(message);
  const editor = createBoardEditor({ model, source, notify, log: () => {}, makeId: () => uid(++mine), now: () => '2026-11-15T12:00:00.000Z' });
  const canvas = createBoardCanvasView({ document: doc, actionButton, canvasSurface, boardCard, connectorLayer });
  doc.body.appendChild(canvas.element);
  canvas.surface.element.getBoundingClientRect = () => RECT;
  canvas.setEditor(editor, { source, notify, modules: { interactions, toolbar, cardEditing } });
  canvas.show(seeded.board, { canUndo: true, canRedo: false });
  canvas.surface.setView({ x: 0, y: 0, zoom: 1 });
  t.after(() => { canvas.dispose(); window.close(); });
  const h = {
    window, doc, editor, sent, notices, surface: canvas.surface.element,
    server: async () => (await source.get({ boardId: created.id })).board,
    el: (id) => doc.querySelector(`[data-card-id="${id}"]`),
    field: () => doc.querySelector('[data-board-editor] textarea'),
    key(target, key, extra) { target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })); },
    type(value) { const field = h.field(); field.value = value; field.dispatchEvent(new window.Event('input', { bubbles: true })); },
    leave() { h.field().dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: null })); },
    async dbl(target, x, y) { target.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y })); await flush(); },
    /** A new note by the Note tool, its editor open; answers the note's id. */
    async tool() {
      const before = new Set(Object.keys(editor.getBoard().cards));
      doc.querySelector('[data-board-tool="note"]').click();
      await flush();
      assert.ok(h.field(), 'the new note is ready to type in');
      return Object.keys(editor.getBoard().cards).find((id) => !before.has(id));
    },
    cards: () => Object.keys(editor.getBoard().cards).sort(),
  };
  return h;
}

test('Escape on a note made a moment ago takes it off the board, typed in or not, and leaves the keyboard on the canvas', async (t) => {
  const h = await env(t);
  const first = await h.tool();
  h.key(h.field(), 'Escape');
  await flush();
  assert.equal(h.field(), null, 'the editor closed');
  assert.deepEqual([h.cards(), Object.keys((await h.server()).cards)], [[A], [A]], 'no blank note is left, here or in the store');
  assert.deepEqual(h.sent, [['card.add'], ['card.remove']]);
  assert.equal(h.doc.activeElement, h.surface, 'the canvas has the keyboard, so its keys still work');
  assert.equal(h.el(first), null);
  assert.deepEqual(h.notices, [], 'nothing is said: the person cancelled it themself');

  await h.dbl(h.surface, 600, 400);
  h.type('half a thought');
  h.key(h.field(), 'Escape');
  await flush();
  assert.deepEqual([h.cards(), h.sent.slice(2)], [[A], [['card.add'], ['card.remove']]], 'a double-click note: Escape cancels the creation, the text with it');
});

test('leaving a new note with nothing typed takes it off the board; with text it is saved', async (t) => {
  const h = await env(t);
  await h.tool();
  h.leave();
  await flush();
  assert.deepEqual([h.cards(), h.sent, h.field()], [[A], [['card.add'], ['card.remove']], null]);

  await h.tool();
  h.type('  \n ');
  h.leave();
  await flush();
  assert.deepEqual([h.cards(), h.sent.slice(2)], [[A], [['card.add'], ['card.remove']]], 'spaces and line breaks are nothing typed');

  const kept = await h.tool();
  h.type('a real note');
  h.leave();
  await flush();
  assert.deepEqual(h.sent.slice(4), [['card.add'], ['card.edit']]);
  assert.equal((await h.server()).cards[kept].data.text, 'a real note');
});

test('opening another note while a new one is still empty removes the empty one', async (t) => {
  const h = await env(t);
  const fresh = await h.tool();
  await h.dbl(h.el(A), 150, 120);
  await flush();
  assert.equal(h.field().value, 'alpha', 'the other note is the one being edited');
  assert.deepEqual([h.cards(), h.el(fresh)], [[A], null]);
});

test('a new note stays when it is saved empty with Ctrl+Enter, and when the window loses focus', async (t) => {
  const h = await env(t);
  const saved = await h.tool();
  h.key(h.field(), 'Enter', { ctrlKey: true });
  await flush();
  assert.deepEqual([h.field(), h.cards(), h.sent], [null, [A, saved].sort(), [['card.add']]], 'an empty note saved on purpose is a note');

  const away = await h.tool();
  h.doc.hasFocus = () => false; // the person went to another window, perhaps to copy what the note will say
  h.leave();
  await flush();
  assert.deepEqual([h.cards(), h.sent], [[A, saved, away].sort(), [['card.add'], ['card.add']]]);
});

test('a note that was already on the board is never removed by its editor: Escape drops the typing, an emptied note is saved empty', async (t) => {
  const h = await env(t);
  await h.dbl(h.el(A), 150, 120);
  h.type('');
  h.key(h.field(), 'Escape');
  await flush();
  assert.deepEqual([h.cards(), h.sent, (await h.server()).cards[A].data.text], [[A], [], 'alpha']);
  await h.dbl(h.el(A), 150, 120);
  h.type('');
  h.leave();
  await flush();
  assert.deepEqual([h.cards(), h.sent, (await h.server()).cards[A].data.text], [[A], [['card.edit']], '']);

  const made = await h.tool();
  h.type('kept');
  h.key(h.field(), 'Enter', { ctrlKey: true });
  await flush();
  await h.dbl(h.el(made), 0, 0);
  h.key(h.field(), 'Escape');
  await flush();
  assert.deepEqual(h.cards(), [A, made].sort(), 'once saved, a note is no longer new: Escape on a later edit keeps it');
});
