'use strict';

// new-test-file: a new surface (the Board toolbar's More menu for tools that do not fit); renderer-board-canvas-editing.test.js is at its line cap.
// The real toolbar over the real action button and context menu in jsdom. jsdom has no layout, so the widths are injected through `measure`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const toolbarModule = require('../renderer/features/board/board-canvas-toolbar');
const actionButton = require('../renderer/inventory/action-button');
const contextMenu = require('../renderer/inventory/context-menu');

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const WIDTHS = { note: 70, link: 70, 'kind-tidy': 70, 'kind-ask': 70, 'kind-extra': 70, undo: 60, redo: 60, more: 60, sep: 1, slot: 100 };

function build(t, { available = 1000, canEdit = true, canRedo = true } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const calls = [];
  const state = { available, canEdit };
  const editor = {
    getBoard: () => ({ cards: {}, groups: {}, connectors: {} }),
    canEdit: () => state.canEdit,
    getSelection: () => [],
    getSelectedConnector: () => '',
    canUndo: () => true,
    canRedo: () => canRedo,
    addNote: async (input) => { calls.push(['addNote', input]); return { ok: false }; },
    undo: async () => { calls.push(['undo']); },
    redo: async () => { calls.push(['redo']); },
  };
  const tools = [
    { id: 'tidy', label: 'Tidy', title: 'Tidy the board', run: async () => { calls.push(['tidy']); } },
    { id: 'ask', label: 'Ask Jenny', title: 'Ask Jenny about the selection', run: async () => { calls.push(['ask']); } },
    { id: 'extra', label: 'Extra', title: 'One more tool', run: async () => { calls.push(['extra']); } },
  ];
  const widthOf = (el) => {
    if (el.hasAttribute('data-board-toolbar-slot')) return el.childNodes.length ? WIDTHS.slot : 0;
    if (el.hasAttribute('data-board-more')) return WIDTHS.more;
    if (el.classList.contains('board-sep')) return WIDTHS.sep;
    return WIDTHS[el.getAttribute('data-board-tool')] || 0;
  };
  const chrome = toolbarModule.createBoardCanvasToolbar({
    document: doc, actionButton, editor, host: { reveal() {}, startEdit() {} }, tools, context: {},
    measure: { available: () => state.available, width: widthOf, spacing: () => ({ gap: 0, pad: 0 }) },
  });
  doc.body.appendChild(chrome.element);
  t.after(() => { chrome.dispose(); window.close(); });
  const toolButtons = () => Array.from(chrome.toolbar.querySelectorAll('[data-board-tool]'));
  return {
    window, doc, chrome, calls, state, toolButtons,
    visible: () => toolButtons().filter((el) => !el.hidden).map((el) => el.getAttribute('data-board-tool')),
    more: () => chrome.toolbar.querySelector('[data-board-more]'),
    menuItems: () => Array.from(doc.querySelectorAll('.inv-context-menu-item')),
    fit(width) { state.available = width; chrome.layout(); },
  };
}

const ALL = ['note', 'link', 'kind-tidy', 'kind-ask', 'kind-extra', 'undo', 'redo'];
const labelOf = (el) => el.textContent.trim();

test('when every tool fits the bar is whole and the More button is hidden', (t) => {
  const h = build(t, { available: 1000 });
  h.chrome.layout();
  assert.deepEqual(h.visible(), ALL);
  assert.equal(h.more().hidden, true);
  assert.equal(h.chrome.toolbar.querySelector('.board-sep').hidden, false);
});

test('at 430px every tool is on the bar or in the More menu, once', (t) => {
  const h = build(t, { available: 430 });
  h.chrome.slot.appendChild(h.doc.createElement('div'));
  h.chrome.layout();
  const onBar = h.visible();
  assert.equal(h.more().hidden, false);
  assert.equal(h.more().getAttribute('aria-haspopup'), 'menu');
  h.more().click();
  const inMenu = h.menuItems().map(labelOf);
  const names = (list) => list.map((id) => labelOf(h.chrome.toolbar.querySelector(`[data-board-tool="${id}"]`)));
  const hiddenIds = ALL.filter((id) => !onBar.includes(id));
  assert.ok(hiddenIds.length > 0 && onBar.length > 0, 'a mix of both');
  assert.deepEqual(inMenu, names(hiddenIds), 'the menu lists the hidden tools in bar order');
  assert.equal(new Set([...onBar, ...hiddenIds]).size, ALL.length, 'no tool is in both places or in neither');
  assert.ok(onBar.includes('undo') && onBar.includes('redo'), 'Undo and Redo stay while an ordinary tool is hidden');
  assert.deepEqual(onBar.filter((id) => !['undo', 'redo'].includes(id)), ['note', 'link'], 'the last ordinary tools overflow first');
});

test('with no room for the ordinary tools Redo goes before Undo and the view switch stays', (t) => {
  const h = build(t, { available: 250 });
  h.chrome.slot.appendChild(h.doc.createElement('div'));
  h.chrome.layout();
  assert.deepEqual(h.visible(), ['undo']);
  assert.equal(h.chrome.toolbar.querySelector('.board-sep').hidden, true, 'the separator goes with the tools it divided');
  assert.equal(h.chrome.slot.hidden, false);
  assert.equal(h.more().hidden, false);
  h.more().click();
  assert.deepEqual(h.menuItems().map(labelOf), ['Note', 'Link', 'Tidy', 'Ask Jenny', 'Extra', 'Redo']);
});

test('the bar grows back when its room does, and measures nothing while it has no width', (t) => {
  const h = build(t, { available: 430 });
  h.chrome.layout();
  assert.equal(h.more().hidden, false);
  h.fit(1000);
  assert.deepEqual(h.visible(), ALL);
  assert.equal(h.more().hidden, true);
  h.fit(0);
  assert.deepEqual(h.visible(), ALL, 'an unknown width shows everything');
  assert.equal(h.more().hidden, true);
});

test('a disabled tool in the menu is disabled there with the same reason', (t) => {
  const h = build(t, { available: 250, canRedo: false });
  h.chrome.slot.appendChild(h.doc.createElement('div'));
  h.chrome.layout();
  const real = h.chrome.toolbar.querySelector('[data-board-tool="redo"]');
  assert.equal(real.hidden, true);
  assert.equal(real.disabled, true);
  h.more().click();
  const entry = h.menuItems().find((el) => labelOf(el).startsWith('Redo'));
  assert.ok(entry);
  assert.equal(entry.disabled, true);
  assert.match(real.title, /nothing to redo/i, 'the real button states why');
  assert.ok(entry.textContent.includes(real.title), 'the menu entry carries that reason');
  assert.equal(h.menuItems().find((el) => labelOf(el).startsWith('Tidy')).disabled, false, 'a tool that works stays enabled');
});

test('on a board that cannot be changed the More button says so once instead of opening a menu of disabled tools', (t) => {
  const h = build(t, { available: 430, canEdit: false });
  h.chrome.layout();
  assert.equal(h.more().disabled, true);
  assert.match(h.more().title, /cannot be changed/i);
});

test('choosing an entry runs what clicking the tool runs, and focus returns to the More button', async (t) => {
  const h = build(t, { available: 290 });
  h.chrome.slot.appendChild(h.doc.createElement('div'));
  h.chrome.layout();
  assert.ok(!h.visible().includes('note') && !h.visible().includes('kind-tidy'));
  h.chrome.toolbar.querySelector('[data-board-tool="note"]').click();
  await flush();
  h.more().click();
  h.menuItems().find((el) => labelOf(el) === 'Note').click();
  await flush();
  h.more().click();
  h.menuItems().find((el) => labelOf(el) === 'Tidy').click();
  await flush();
  assert.deepEqual(h.calls, [['addNote', {}], ['addNote', {}], ['tidy']]);
  assert.equal(h.doc.querySelector('.inv-context-menu'), null, 'the menu closed');
  assert.equal(h.doc.activeElement, h.more(), 'focus is back on the More button');
  h.more().click();
  assert.ok(h.doc.querySelector('.inv-context-menu'));
  h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(h.doc.querySelector('.inv-context-menu'), null, 'Escape closes it');
  assert.equal(h.doc.activeElement, h.more());
});

test('a second press on More closes its open menu', (t) => {
  const h = build(t, { available: 290 });
  h.chrome.slot.appendChild(h.doc.createElement('div'));
  h.chrome.layout();
  h.more().click();
  assert.ok(h.doc.querySelector('.inv-context-menu'));
  h.more().click();
  assert.equal(h.doc.querySelector('.inv-context-menu'), null);
});
