'use strict';

// new-test-file: tests/renderer-board-canvas-editing.test.js and tests/renderer-board-page.test.js are at the 600-line cap. This
// file holds one rule of the canvas view (row 165, third part): the card under the pointer, or the one selected card, keeps its
// connectors and the cards they reach lit; connected cards that appear together on a board already shown arrive in the arrows'
// order. Real canvas view over the real primitives, in jsdom; the motion itself is CSS and is not run here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createBoardCanvasView } = require('../renderer/features/board/board-canvas-view');
const actionButton = require('../renderer/inventory/action-button');
const canvasSurface = require('../renderer/inventory/canvas-surface');
const boardCard = require('../renderer/inventory/board-card');
const connectorLayer = require('../renderer/inventory/connector-layer');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, D, G, K1, K2, K3] = [901, 902, 903, 904, 950, 960, 961, 962].map(uid);
const NOW = '2026-11-16T12:00:00.000Z';
const note = (id, x, y, extra = {}) => ({ op: 'card.add', card: { id, kind: 'note', data: { text: id.slice(-3), tone: null }, x, y, w: 200, h: 100, ...extra } });
const line = (id, from, to) => ({ op: 'connector.add', connector: { id, from, to } });

function env(t) {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const doc = window.document;
  let batches = 0;
  let board = model.createBoard({ id: `board_${uid(1)}`, project_id: 'project_alpha', name: 'Plan', now: NOW }).board;
  const canvas = createBoardCanvasView({ document: doc, actionButton, canvasSurface, boardCard, connectorLayer });
  doc.body.appendChild(canvas.element);
  t.after(() => { canvas.dispose(); window.close(); });
  const h = {
    window, canvas,
    apply(ops) {
      const done = model.applyBatch(board, { batch_id: `b${batches += 1}`, board_id: board.id, actor: 'owner', ops }, { now: NOW, authority: true });
      assert.equal(done.ok, true, JSON.stringify(done));
      board = done.board;
      canvas.show(board);
    },
    el: (id) => doc.querySelector(`[data-card-id="${id}"]`),
    conn: (id) => doc.querySelector(`[data-connector-id="${id}"]`),
    lit: () => [A, B, C, D].filter((id) => h.el(id) && h.el(id).hasAttribute('data-board-lit')),
    async over(target, extra) {
      target.dispatchEvent(new window.PointerEvent(target === canvas.surface.layer ? 'pointerleave' : 'pointerover', { bubbles: target !== canvas.surface.layer, buttons: 0, ...extra }));
      await new Promise((resolve) => setTimeout(resolve, 130));
    },
  };
  return h;
}

test('the card under the pointer keeps its connectors and the cards they reach lit; the rest step back', async (t) => {
  const h = env(t);
  h.apply([{ op: 'group.add', group: { id: G, title: 'Loop', x: 0, y: 0, w: 900, h: 200 } },
    note(A, 20, 50), note(B, 320, 50), note(C, 620, 50), note(D, 20, 400), line(K1, A, B), line(K2, B, C)]);
  const centre = h.canvas.element;
  await h.over(h.el(B));
  assert.deepEqual([centre.hasAttribute('data-board-focus'), h.lit()], [true, [A, B, C]]);
  assert.deepEqual([K1, K2].map((id) => h.conn(id).hasAttribute('data-lit')), [true, true]);
  await h.over(h.el(A));
  assert.deepEqual([h.lit(), h.conn(K1).hasAttribute('data-lit'), h.conn(K2).hasAttribute('data-lit')], [[A, B], true, false]);
  assert.equal(h.conn(K1).querySelectorAll('[data-connector-trace="flow"]').length, 1, 'a lit connector carries the moving trace');
  await h.over(h.el(D));
  assert.deepEqual([centre.hasAttribute('data-board-focus'), h.lit()], [false, []], 'a card no connector touches lights nothing');
  await h.over(h.el(A));
  await h.over(h.el(G));
  assert.equal(centre.hasAttribute('data-board-focus'), false, 'a group lights nothing');
  await h.over(h.el(A), { buttons: 1 });
  assert.equal(centre.hasAttribute('data-board-focus'), false, 'nor does a card passed with a button held (a drag, a marquee)');
  await h.over(h.el(C));
  await h.over(h.canvas.surface.layer);
  assert.deepEqual([centre.hasAttribute('data-board-focus'), h.lit(), h.conn(K2).hasAttribute('data-lit')], [false, [], false], 'leaving the cards clears it');
});

test('connected cards that appear together on a shown board arrive in the order of their arrows; a first showing does not move', (t) => {
  const h = env(t);
  h.apply([note(A, 0, 0), note(B, 300, 0), line(K1, A, B)]);
  assert.deepEqual([h.el(A).hasAttribute('data-board-arriving'), h.conn(K1).hasAttribute('data-arriving')], [false, false], 'a board opened is drawn at once');
  h.apply([note(C, 0, 300)]);
  assert.equal(h.el(C).hasAttribute('data-board-arriving'), false, 'one new card is not a batch');
  const timers = [];
  h.window.setTimeout = (run) => timers.push(run);
  h.apply([note(D, 600, 300), note(uid(905), 300, 300), line(K2, C, uid(905)), line(K3, uid(905), D)]);
  assert.equal(h.el(C).hasAttribute('data-board-arriving'), false, 'a card that was there stays put');
  assert.deepEqual([uid(905), D].map((id) => h.el(id).style.getPropertyValue('--board-arrive-delay')), ['0ms', '260ms']);
  assert.deepEqual([h.conn(K2).hasAttribute('data-arriving'), h.conn(K3).style.getPropertyValue('--board-arrive-delay')], [false, '130ms'], 'only a line between two new cards is drawn in');
  h.apply([note(uid(906), 0, 600), note(uid(907), 300, 600), line(uid(963), uid(906), uid(907))]);
  timers.pop()(); // the first batch's clean-up was cancelled by the second: the one that runs clears both
  assert.deepEqual([D, uid(907)].map((id) => h.el(id).hasAttribute('data-board-arriving')), [false, false], 'a second batch does not strand the first');
  timers.forEach((run) => run());
  assert.deepEqual([h.el(D).hasAttribute('data-board-arriving'), h.conn(K3).hasAttribute('data-arriving'), h.conn(K3).querySelectorAll('[data-connector-trace]').length], [false, false, 0]);
});
