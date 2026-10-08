'use strict';

/* Preview / File map toggles at the trailing end of the editor tab row (row 40 W3;
 * they used to live in the rail activity bar). Pressed-state toggle buttons routed
 * through the stage-surface controller. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const { ENTRIES, createIdeStageSwitch } = require('../renderer/features/renderer-ide-stage-switch');

function setup(t, opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="ideStageSwitch"></div><input id="outside"></body>');
  const doc = dom.window.document;
  const host = doc.getElementById('ideStageSwitch');
  const state = { surface: opts.surface || 'editor', toggles: [] };
  const stageSwitch = createIdeStageSwitch({
    getMountEl: () => (opts.noHost ? null : host),
    actionButton: opts.noButton ? null : actionButton,
    onToggle: (surface) => state.toggles.push(surface),
    getActiveSurface: () => state.surface,
  });
  t.after(() => {
    stageSwitch.dispose();
    dom.window.close();
  });
  const buttons = () => [...host.querySelectorAll('[data-ide-stage-surface]')];
  return { dom, doc, host, state, stageSwitch, buttons };
}

test('entries are Preview and File Map with translated labels', () => {
  assert.deepEqual(ENTRIES.map((entry) => entry.surface), ['preview', 'file_map']);
  assert.deepEqual(ENTRIES.map((entry) => entry.label()), ['Preview', 'File Map']);
});

test('renders two toggle buttons with aria-pressed reflecting the active surface', (t) => {
  const h = setup(t);
  h.stageSwitch.render();
  assert.deepEqual(h.buttons().map((b) => b.getAttribute('data-ide-stage-surface')), ['preview', 'file_map']);
  assert.deepEqual(h.buttons().map((b) => b.textContent.trim()), ['Preview', 'File Map']);
  assert.deepEqual(h.buttons().map((b) => b.getAttribute('aria-pressed')), ['false', 'false']);
  assert.equal(h.buttons()[0].getAttribute('title'), 'Show Preview');

  h.state.surface = 'preview';
  h.stageSwitch.render();
  assert.deepEqual(h.buttons().map((b) => b.getAttribute('aria-pressed')), ['true', 'false']);
  assert.ok(h.buttons()[0].classList.contains('ide-stage-switch-btn--active'));
  assert.equal(h.buttons()[1].classList.contains('ide-stage-switch-btn--active'), false);
  assert.match(h.buttons()[0].getAttribute('title'), /return to the editor/);

  h.state.surface = 'file_map';
  h.stageSwitch.render();
  assert.deepEqual(h.buttons().map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
});

test('bindEvents labels the group and a click calls onToggle with that surface', (t) => {
  const h = setup(t);
  h.stageSwitch.render();
  h.stageSwitch.bindEvents();
  assert.equal(h.host.getAttribute('aria-label'), 'Workspace views');

  h.buttons()[0].click();
  h.buttons()[1].click();
  h.buttons()[1].click();
  assert.deepEqual(h.state.toggles, ['preview', 'file_map', 'file_map'], 'the toggle (not the switch) decides what pressing the active one does');

  // Clicks on the host outside a button, or from other elements, do nothing.
  h.host.click();
  h.doc.getElementById('outside').click();
  assert.equal(h.state.toggles.length, 3);
});

test('bindEvents is idempotent and dispose stops listening', (t) => {
  const h = setup(t);
  h.stageSwitch.render();
  h.stageSwitch.bindEvents();
  h.stageSwitch.bindEvents();
  h.buttons()[0].click();
  assert.deepEqual(h.state.toggles, ['preview'], 'a double bind does not double-fire');

  h.stageSwitch.dispose();
  h.buttons()[0].click();
  assert.equal(h.state.toggles.length, 1, 'a disposed switch ignores clicks');
  h.stageSwitch.dispose(); // idempotent
});

test('a re-render keeps keyboard focus on the same toggle and skips identical markup', (t) => {
  const h = setup(t);
  h.stageSwitch.render();
  h.stageSwitch.bindEvents();

  const original = h.buttons()[1];
  original.focus();
  assert.equal(h.doc.activeElement, original);

  h.stageSwitch.render();
  assert.equal(h.buttons()[1], original, 'identical markup leaves the buttons in place');
  assert.equal(h.doc.activeElement, original);

  h.state.surface = 'file_map';
  h.stageSwitch.render();
  assert.notEqual(h.buttons()[1], original, 'changed state repaints the buttons');
  assert.equal(h.doc.activeElement, h.buttons()[1], 'focus follows to the same surface\'s new button');
  assert.equal(h.buttons()[1].getAttribute('aria-pressed'), 'true');

  h.doc.getElementById('outside').focus();
  h.state.surface = 'editor';
  h.stageSwitch.render();
  assert.equal(h.doc.activeElement, h.doc.getElementById('outside'), 'focus outside the switch is never stolen');
});

test('without a host or an action button render and bind are no-ops', (t) => {
  const noHost = setup(t, { noHost: true });
  assert.doesNotThrow(() => noHost.stageSwitch.render());
  assert.doesNotThrow(() => noHost.stageSwitch.bindEvents());
  assert.equal(noHost.buttons().length, 0);

  const noButton = setup(t, { noButton: true });
  assert.doesNotThrow(() => noButton.stageSwitch.render());
  assert.equal(noButton.buttons().length, 0);

  assert.doesNotThrow(() => createIdeStageSwitch().render());
  assert.doesNotThrow(() => createIdeStageSwitch().bindEvents());
});

test('an active surface reads as a closable tab before the toggles; its close returns to the editor (W5)', (t) => {
  const h = setup(t);
  h.stageSwitch.render();
  assert.equal(h.host.querySelector('[data-ide-surface-tab]'), null, 'no surface tab on the editor');
  h.state.surface = 'file_map';
  h.stageSwitch.render();
  const tab = h.host.querySelector('[data-ide-surface-tab]');
  assert.ok(tab, 'File map shows as a tab');
  assert.equal(tab.getAttribute('data-ide-surface-tab'), 'file_map');
  assert.equal(h.host.firstElementChild, tab, 'ahead of the toggles');
  assert.equal(tab.textContent.replace(/×/g, '').trim(), 'File Map');
  assert.ok(tab.classList.contains('ide-tab--active'));
  const close = tab.querySelector('[data-ide-surface-close]');
  assert.equal(close.getAttribute('aria-label'), 'Close File Map');
  assert.equal(h.buttons().length, 2, 'the two toggles stay');
  h.stageSwitch.bindEvents();
  close.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(h.state.toggles, ['file_map'], 'closing toggles the active surface off');
});

test('closing a surface by keyboard keeps focus on its toggle, never <body> (row 40 review)', (t) => {
  const h = setup(t, { surface: 'preview' });
  h.stageSwitch.render();
  h.host.querySelector('[data-ide-surface-close]').focus();
  h.state.surface = 'editor'; // Enter on Close: the surface closed, the switch repaints
  h.stageSwitch.render();
  assert.equal(h.host.querySelector('[data-ide-surface-close]'), null);
  assert.equal(h.doc.activeElement, h.host.querySelector('[data-ide-stage-surface="preview"]'));
});
