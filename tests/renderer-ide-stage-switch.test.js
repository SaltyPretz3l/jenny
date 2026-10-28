'use strict';

/* Editor toolbar at the trailing end of the editor tab row: Preview / File map
 * pressed-state toggles (row 40 W3), Split Editor Right and the open-tabs More button,
 * all icon-only inventory buttons routed through the stage-surface controller. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const {
  ENTRIES, editorActionsMarkup, surfaceTabFor, createIdeStageSwitch,
} = require('../renderer/features/renderer-ide-stage-switch');

function setup(t, opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="ideStageSwitch"></div><input id="outside"></body>');
  const doc = dom.window.document;
  const host = doc.getElementById('ideStageSwitch');
  const state = { surface: opts.surface || 'editor', toggles: [], splits: 0, mores: [] };
  const stageSwitch = createIdeStageSwitch({
    getMountEl: () => (opts.noHost ? null : host),
    actionButton: opts.noButton ? null : actionButton,
    onToggle: (surface) => state.toggles.push(surface),
    onSplit: () => { state.splits += 1; },
    onMore: (anchor) => state.mores.push(anchor),
    getActiveSurface: () => state.surface,
  });
  t.after(() => {
    stageSwitch.dispose();
    dom.window.close();
  });
  const buttons = () => [...host.querySelectorAll('[data-ide-stage-surface]')];
  const action = (name) => host.querySelector(`[data-ide-editor-action="${name}"]`);
  return { dom, doc, host, state, stageSwitch, buttons, action };
}

function parse(markup) {
  const dom = new JSDOM(`<!doctype html><body><div id="m">${markup}</div></body>`);
  return { dom, root: dom.window.document.getElementById('m') };
}

test('entries are Preview and File Map with translated labels', () => {
  assert.deepEqual(ENTRIES.map((entry) => entry.surface), ['preview', 'file_map']);
  assert.deepEqual(ENTRIES.map((entry) => entry.label()), ['Preview', 'File Map']);
});

test('renders icon-only toggles with aria-pressed, a name and a title', (t) => {
  const h = setup(t);
  h.stageSwitch.render();
  assert.deepEqual(h.buttons().map((b) => b.getAttribute('data-ide-stage-surface')), ['preview', 'file_map']);
  assert.deepEqual(h.buttons().map((b) => b.textContent.trim()), ['', ''], 'icon-only: no visible text');
  assert.deepEqual(h.buttons().map((b) => b.getAttribute('aria-label')), ['Preview', 'File Map']);
  assert.deepEqual(h.buttons().map((b) => b.getAttribute('aria-pressed')), ['false', 'false']);
  assert.equal(h.buttons()[0].getAttribute('title'), 'Show Preview');
  for (const button of h.buttons()) {
    assert.ok(button.classList.contains('ide-editor-action'));
    const svg = button.querySelector('svg');
    assert.ok(svg, 'carries an svg icon');
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.equal(svg.getAttribute('focusable'), 'false');
    assert.equal(svg.getAttribute('width'), '15');
  }

  h.state.surface = 'preview';
  h.stageSwitch.render();
  assert.deepEqual(h.buttons().map((b) => b.getAttribute('aria-pressed')), ['true', 'false']);
  assert.ok(h.buttons()[0].classList.contains('ide-editor-action--active'));
  assert.equal(h.buttons()[1].classList.contains('ide-editor-action--active'), false);
  assert.match(h.buttons()[0].getAttribute('title'), /return to the editor/);
  assert.equal(h.buttons()[0].getAttribute('aria-label'), 'Preview', 'the name stays the label when pressed');

  h.state.surface = 'file_map';
  h.stageSwitch.render();
  assert.deepEqual(h.buttons().map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
});

test('split and more buttons are always present with names, titles and a menu popup', (t) => {
  const h = setup(t);
  h.stageSwitch.render();
  const split = h.action('split-right');
  assert.equal(split.getAttribute('aria-label'), 'Split Editor Right');
  assert.equal(split.getAttribute('title'), 'Split Editor Right');
  assert.equal(split.getAttribute('aria-haspopup'), null);
  const more = h.action('more');
  assert.equal(more.getAttribute('aria-label'), 'Show all open tabs');
  assert.equal(more.getAttribute('title'), 'Show all open tabs');
  assert.equal(more.getAttribute('aria-haspopup'), 'menu');
  assert.deepEqual([...h.host.children].map((el) => el.getAttribute('data-ide-stage-surface') || el.getAttribute('data-ide-editor-action')),
    ['preview', 'file_map', 'split-right', 'more']);
});

test('editorActionsMarkup is pure; surfaces:false omits the surface toggles', () => {
  assert.equal(editorActionsMarkup({ actionButton: null }), '');
  assert.equal(editorActionsMarkup(), '');

  const full = parse(editorActionsMarkup({ actionButton, surfaces: true, activeSurface: 'file_map' }));
  assert.equal(full.root.querySelectorAll('[data-ide-stage-surface]').length, 2);
  assert.equal(full.root.querySelector('[data-ide-stage-surface="file_map"]').getAttribute('aria-pressed'), 'true');
  assert.equal(full.root.querySelectorAll('button').length, 4);

  const groups = parse(editorActionsMarkup({ actionButton, surfaces: false }));
  assert.equal(groups.root.querySelectorAll('[data-ide-stage-surface]').length, 0);
  assert.deepEqual([...groups.root.querySelectorAll('button')].map((b) => b.getAttribute('data-ide-editor-action')), ['split-right', 'more']);

  const defaults = parse(editorActionsMarkup({ actionButton }));
  assert.deepEqual([...defaults.root.querySelectorAll('[data-ide-stage-surface]')].map((b) => b.getAttribute('aria-pressed')), ['false', 'false']);
});

test('surfaceTabFor describes a stage surface and rejects everything else', () => {
  assert.deepEqual(surfaceTabFor('preview'), { surface: 'preview', label: 'Preview' });
  assert.deepEqual(surfaceTabFor('file_map'), { surface: 'file_map', label: 'File Map' });
  assert.equal(surfaceTabFor('editor'), null);
  assert.equal(surfaceTabFor(''), null);
  assert.equal(surfaceTabFor(undefined), null);
});

test('the toolbar no longer renders a surface tab or close control', (t) => {
  const h = setup(t, { surface: 'file_map' });
  h.stageSwitch.render();
  assert.equal(h.host.querySelector('[data-ide-surface-tab]'), null);
  assert.equal(h.host.querySelector('[data-ide-surface-close]'), null);
  assert.equal(h.host.querySelectorAll('button').length, 4);
});

test('bindEvents makes a labelled toolbar; clicks route toggle, split and more', (t) => {
  const h = setup(t);
  h.stageSwitch.render();
  h.stageSwitch.bindEvents();
  assert.equal(h.host.getAttribute('role'), 'toolbar');
  assert.equal(h.host.getAttribute('aria-label'), 'Workspace views');

  h.buttons()[0].click();
  h.buttons()[1].click();
  h.buttons()[1].click();
  assert.deepEqual(h.state.toggles, ['preview', 'file_map', 'file_map'], 'the toggle (not the switch) decides what pressing the active one does');

  h.action('split-right').click();
  assert.equal(h.state.splits, 1);
  assert.equal(h.state.mores.length, 0);
  h.action('more').click();
  assert.deepEqual(h.state.mores, [h.action('more')], 'More receives its button as the menu anchor');
  assert.equal(h.state.splits, 1);
  assert.equal(h.state.toggles.length, 3, 'split / more never toggle a surface');

  // A click on an inner icon resolves to its button.
  h.action('split-right').querySelector('svg').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.state.splits, 2);

  // Clicks on the host outside a button, or from other elements, do nothing.
  h.host.click();
  h.doc.getElementById('outside').click();
  assert.equal(h.state.toggles.length, 3);
  assert.equal(h.state.splits, 2);
  assert.equal(h.state.mores.length, 1);
});

test('missing onSplit / onMore callbacks are tolerated', (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="ideStageSwitch"></div></body>');
  t.after(() => dom.window.close());
  const host = dom.window.document.getElementById('ideStageSwitch');
  const stageSwitch = createIdeStageSwitch({ getMountEl: () => host, actionButton });
  t.after(() => stageSwitch.dispose());
  stageSwitch.render();
  stageSwitch.bindEvents();
  assert.equal(host.getAttribute('role'), 'toolbar', 'binding still labels the toolbar');
  assert.equal(host.querySelectorAll('[data-ide-stage-surface]').length, 2);
  assert.equal(host.querySelectorAll('[data-ide-editor-action]').length, 2, 'split and more render without callbacks');
  assert.doesNotThrow(() => host.querySelector('[data-ide-editor-action="split-right"]').click());
  assert.doesNotThrow(() => host.querySelector('[data-ide-editor-action="more"]').click());
  assert.doesNotThrow(() => host.querySelector('[data-ide-stage-surface="preview"]').click());
});

test('bindEvents is idempotent and dispose stops listening', (t) => {
  const h = setup(t);
  h.stageSwitch.render();
  h.stageSwitch.bindEvents();
  h.stageSwitch.bindEvents();
  h.buttons()[0].click();
  h.action('split-right').click();
  assert.deepEqual(h.state.toggles, ['preview'], 'a double bind does not double-fire');
  assert.equal(h.state.splits, 1);

  h.stageSwitch.dispose();
  h.buttons()[0].click();
  h.action('split-right').click();
  assert.equal(h.state.toggles.length, 1, 'a disposed switch ignores clicks');
  assert.equal(h.state.splits, 1);
  h.stageSwitch.dispose(); // idempotent
});

test('a re-render keeps keyboard focus on the same button and skips identical markup', (t) => {
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

  // An editor-action button keeps focus across a repaint too.
  const more = h.action('more');
  more.focus();
  h.state.surface = 'preview';
  h.stageSwitch.render();
  assert.notEqual(h.action('more'), more, 'the repaint replaced the button');
  assert.equal(h.doc.activeElement, h.action('more'), 'focus follows to the same editor action');

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
