'use strict';

// Regressions from the 2026-10-25 scratchpad review: a failed-save draft stays
// on screen through a repaint, a failed sibling write no longer fails a flush
// with nothing queued, turning markdown on shows the Preview toggle, the
// checklist toggle refuses to overwrite an unsaved draft, deleting a background
// tab leaves the active view alone, delete-confirm reads the live field, and a
// new tab plays its grow-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScratchpadActions } = require('../renderer/features/renderer-dashboard-scratchpad-actions.js');
const { createScratchpadWidget } = require('../renderer/features/renderer-dashboard-widgets-scratchpad.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const scratchpadMarkdown = require('../renderer/features/renderer-dashboard-scratchpad-markdown.js');
const { scratch, twoNotesActive, flagOnCtx, createTimerStub } = require('./helpers/scratchpad-fixtures.js');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(widgetDeps) {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = createScratchpadWidget({
    textField: inventoryTextField,
    actionButton: inventoryActionButton,
    markdownModule: scratchpadMarkdown,
    ...widgetDeps,
  });
  const click = (selector) => body.querySelector(selector)
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return { dom, body, widget, click };
}

function withMarkdown(scratchpad, markdown = true) {
  return { ...scratchpad, settings: { ...scratchpad.settings, markdown } };
}

test('a failed save keeps the draft in the unfocused field through a repaint', async () => {
  const current = scratch('old');
  const timers = createTimerStub();
  const shell = { home: { updateConfig: async () => { throw new Error('disk full'); } } };
  const actions = createScratchpadActions({ shell, getScratchpad: () => current, ...timers });
  const { dom, body, widget } = setup({ actions });

  widget.render(body, flagOnCtx(current));
  const field = body.querySelector('#homeScratchpadInput');
  field.value = 'draft';
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await timers.fire();
  await tick();
  assert.match(body.querySelector('[data-scratchpad-note]').textContent, /Could not save/);

  // A scheduler / calendar repaint with the persisted (older) text.
  widget.render(body, flagOnCtx(current));
  assert.equal(body.querySelector('#homeScratchpadInput').value, 'draft');
  assert.doesNotMatch(body.querySelector('[data-scratchpad-meta]').textContent, /Saved/);
});

test('flushSave with nothing queued succeeds even when a sibling write failed', async () => {
  const current = scratch('text');
  let rejectWrite;
  const shell = { home: { updateConfig: () => new Promise((_resolve, reject) => { rejectWrite = reject; }) } };
  const actions = createScratchpadActions({ shell, getScratchpad: () => ({ ...current, pins: [] }), ...createTimerStub() });

  const pin = actions.pinNote('note-1');
  await tick();
  const flush = actions.flushSave();
  rejectWrite(new Error('pin write failed'));

  assert.equal(await flush, true);
  assert.ok((await pin).error);
});

test('turning markdown on (or off) updates the footer Preview toggle', () => {
  const { body, widget } = setup({ actions: { queueSave() {}, flushSave() {} } });

  widget.render(body, flagOnCtx(withMarkdown(scratch('- [ ] a'), false)));
  assert.equal(body.querySelector('[data-scratchpad-preview-toggle]'), null);

  widget.render(body, flagOnCtx(withMarkdown(scratch('- [ ] a'), true)));
  assert.ok(body.querySelector('[data-scratchpad-preview-toggle]'));

  widget.render(body, flagOnCtx(withMarkdown(scratch('- [ ] a'), false)));
  assert.equal(body.querySelector('[data-scratchpad-preview-toggle]'), null);
});

test('a checklist toggle refuses to overwrite a draft whose save failed', async () => {
  const saved = [];
  const { body, widget, click } = setup({
    actions: { queueSave: (text) => saved.push(text), flushSave: async () => false },
  });

  widget.render(body, flagOnCtx(withMarkdown(scratch('- [ ] a'))));
  click('[data-scratchpad-preview-toggle]');
  click('[data-scratchpad-check="0"]');
  await tick();

  assert.deepEqual(saved, []);
  assert.match(body.querySelector('[data-scratchpad-note]').textContent, /Could not save/);
});

test('deleting a background tab keeps the active note in preview', async () => {
  const pad = withMarkdown(twoNotesActive('note-1'));
  const { body, widget, click } = setup({
    contextMenu: { show: (opts) => opts.items[0].action() },
    actions: {
      queueSave() {},
      flushSave() {},
      deleteNote: async () => ({ ok: true, activeNoteId: 'note-1' }),
    },
  });

  widget.render(body, flagOnCtx(pad));
  click('[data-scratchpad-preview-toggle]');
  click('[data-scratchpad-close="note-2"]');
  await tick();

  assert.ok(body.querySelector('[data-scratchpad-preview]'), 'still in preview');
  assert.equal(body.querySelector('#homeScratchpadInput'), null);
});

test('delete-confirm counts unsaved text in the live field of the active note', () => {
  const menus = [];
  const deleted = [];
  const pad = twoNotesActive('note-1');
  pad.notes[0].text = '';
  const { body, widget, click } = setup({
    contextMenu: { show: (opts) => menus.push(opts) },
    actions: { queueSave() {}, flushSave() {}, deleteNote: async (id) => { deleted.push(id); return { ok: true }; } },
  });

  widget.render(body, flagOnCtx(pad));
  body.querySelector('#homeScratchpadInput').value = 'typed, not saved yet';
  click('[data-scratchpad-close="note-1"]');

  assert.equal(menus.length, 1, 'asks before deleting');
  assert.deepEqual(deleted, []);
});

test('a just-added note plays its grow-in once', async () => {
  const one = scratch('a');
  const two = {
    ...one,
    notes: [...one.notes, { id: 'note-2', title: 'Note 2', text: '', updatedAt: '', appendLog: false }],
    activeNoteId: 'note-2',
  };
  const { body, widget, click } = setup({
    actions: {
      queueSave() {},
      flushSave() {},
      // The write's echo repaints before addNote resolves, as in the app.
      addNote: async () => { widget.render(body, flagOnCtx(two)); return { ok: true, activeNoteId: 'note-2' }; },
    },
  });

  widget.render(body, flagOnCtx(one));
  click('[data-scratchpad-add]');
  await tick();

  const wrap = body.querySelector('[data-scratchpad-tab="note-2"]').closest('.dashboard-scratchpad__tab-wrap');
  assert.ok(wrap.classList.contains('dashboard-scratchpad__tab-wrap--new'));

  // The next strip build does not replay it.
  body.dataset.scratchpadTabsKey = '';
  widget.render(body, flagOnCtx(two));
  assert.equal(body.querySelector('.dashboard-scratchpad__tab-wrap--new'), null);
});
