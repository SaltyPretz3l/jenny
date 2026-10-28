'use strict';

// Regressions from the 2026-10-19 scratchpad review: a capture before Home ever
// loaded must not overwrite the persisted pad, a draft for a deleted note is
// dropped, the actions menu works from markdown preview, and Open in Home from a
// pin wins over the widget's last local tab pick.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScratchpadActions } = require('../renderer/features/renderer-dashboard-scratchpad-actions.js');
const { createScratchpadWidget } = require('../renderer/features/renderer-dashboard-widgets-scratchpad.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const scratchpadMarkdown = require('../renderer/features/renderer-dashboard-scratchpad-markdown.js');
const { twoNotesActive, flagOnCtx, createTimerStub, createShellStub } = require('./helpers/scratchpad-fixtures.js');

const FIXED_NOW = new Date(2026, 5, 11, 10, 0);

function persistedHome(scratchpad) {
  return { links: [], widgets: {}, calendar: {}, focusMode: false, showContextualTips: true, scratchpad: { pins: [], ...scratchpad } };
}

test('a capture before Home loaded reads the persisted pad instead of writing the default over it', async () => {
  let loaded = null;
  const { shell, calls } = createShellStub(() => loaded);
  shell.home.getConfig = async () => persistedHome(twoNotesActive('note-2'));
  const actions = createScratchpadActions({
    shell,
    getScratchpad: () => loaded,
    onHomeConfig: (config) => { loaded = config.scratchpad; },
    nowProvider: () => FIXED_NOW,
  });

  const result = await actions.captureToScratchpad('buy milk');

  assert.equal(result.ok, true);
  assert.equal(calls.updates.length, 1);
  const written = calls.updates[0].scratchpad;
  // The persisted overwrite mode targets the persisted active note; note-1 survives.
  assert.deepEqual(written.notes.map((note) => note.text), ['A', '[10:00] buy milk']);
  assert.equal(written.activeNoteId, 'note-2');
  assert.equal(written.settings.captureMode, 'overwrite');
});

test('a capture refuses when the persisted pad cannot be read', async () => {
  const { shell, calls } = createShellStub(() => null);
  const actions = createScratchpadActions({ shell, getScratchpad: () => null, nowProvider: () => FIXED_NOW });

  const result = await actions.captureToScratchpad('buy milk');

  assert.equal(result.code, 'scratchpad_unavailable');
  assert.equal(calls.updates.length, 0);
});

test('a queued draft for a note deleted elsewhere is dropped, not written into the active note', async () => {
  const current = twoNotesActive('note-1');
  const { shell, calls } = createShellStub(() => current);
  const actions = createScratchpadActions({ shell, getScratchpad: () => current, ...createTimerStub() });

  actions.queueSave('orphan draft', 'note-9');

  assert.equal(await actions.flushSave(), true);
  assert.equal(calls.updates.length, 0);
});

test('the actions menu gets the note text while in markdown preview', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const menus = [];
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    markdownModule: scratchpadMarkdown,
    actions: {},
    contextMenu: { show() {} },
    menuModule: { buildScratchpadMenu: (opts) => { menus.push(opts); return []; } },
  });
  const pad = { ...twoNotesActive('note-2'), settings: { rows: 6, font: 'prose', markdown: true } };
  const ctx = flagOnCtx(pad);

  widget.render(body, ctx);
  body.querySelector('[data-scratchpad-preview-toggle]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(body.querySelector('#homeScratchpadInput'), null);
  body.querySelector('[data-scratchpad-actions]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }));

  assert.equal(menus.length, 1);
  assert.equal(menus[0].text, 'B');
});

test('a config-side active-note change wins over the widget\'s last local tab pick', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: { setActiveNote: async () => ({ ok: true }) },
  });
  const selected = () => body.querySelector('.dashboard-scratchpad__tab[aria-selected="true"]').dataset.scratchpadTab;

  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  body.querySelector('[data-scratchpad-tab="note-2"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selected(), 'note-2');

  // The switch's echo, then a pin popover's Open in Home moving it back to note-1.
  widget.render(body, flagOnCtx(twoNotesActive('note-2')));
  assert.equal(selected(), 'note-2');
  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  assert.equal(selected(), 'note-1');
});

test('a failed debounced save reports false to its settle callback', async () => {
  const current = twoNotesActive('note-1');
  const timers = createTimerStub();
  const actions = createScratchpadActions({
    shell: { home: { updateConfig: async () => { throw new Error('disk full'); } } },
    getScratchpad: () => current,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const settled = [];

  actions.queueSave('draft', 'note-1', (saved) => settled.push(saved));
  await timers.fire();

  assert.deepEqual(settled, [false]);
});

test('the widget replaces "Saving…" with an error when the debounced save fails', async () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  let settle = null;
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    actions: { queueSave(_text, _noteId, onSettled) { settle = onSettled; }, flushSave() {} },
  });
  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  const textarea = body.querySelector('#homeScratchpadInput');
  textarea.value = 'draft';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(body.querySelector('[data-scratchpad-meta]').textContent, 'Saving…');

  settle(false);

  assert.equal(body.querySelector('[data-scratchpad-meta]').textContent, '');
  assert.equal(body.querySelector('[data-scratchpad-note]').textContent, 'Could not save the note.');
  assert.equal(body.querySelector('[data-scratchpad-note]').dataset.state, 'error');
  widget.dispose();
});
