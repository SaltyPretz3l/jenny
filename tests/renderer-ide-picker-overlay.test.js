'use strict';

/* Shared Quick-pick overlay factory (renderer-ide-picker-overlay). Covers the
 * focus contract added for accessibility: the element focused before open() is
 * restored on close() as a FALLBACK - it runs before the onClosed callback, so a
 * picker that explicitly refocuses (the controller wires onClosed = editor.focus)
 * still wins, while a picker that does not leaves focus where it was instead of
 * stranding it (Monaco's textarea does not auto-reclaim). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdePickerOverlay } = require('../renderer/features/renderer-ide-picker-overlay');
const textField = require('../renderer/inventory/text-field');

function setup(extraCallbacks = {}) {
  const dom = new JSDOM('<!doctype html><body>'
    + '<div id="stage"></div><button id="sentinel">x</button></body>');
  const doc = dom.window.document;
  const stage = doc.getElementById('stage');
  const sentinel = doc.getElementById('sentinel');
  const overlay = createIdePickerOverlay({
    getDom: () => ({ ideEditorStage: stage }),
    textField,
    placeholder: 'Search',
    ariaLabel: 'Search',
    resultsAriaLabel: 'Results',
    callbacks: {
      computeMatches: () => [],
      isLoading: () => false,
      renderEmptyStatus: () => '<div class="empty"></div>',
      ...extraCallbacks,
    },
  });
  const inputEl = () => stage.querySelector('.inv-text-field-control');
  return { dom, doc, stage, sentinel, overlay, inputEl };
}

test('picker-overlay restores focus to the prior element when the picker had none of its own', (t) => {
  const { doc, sentinel, overlay, inputEl } = setup();
  t.after(() => overlay.dispose());

  sentinel.focus();
  assert.equal(doc.activeElement, sentinel, 'sentinel focused before open');

  assert.equal(overlay.open(), true, 'overlay opened');
  assert.equal(doc.activeElement, inputEl(), 'focus moves into the picker field on open');

  overlay.close();
  assert.equal(doc.activeElement, sentinel, 'focus restored to the prior element on close');
});

test('a re-entrant open() does not clobber the saved prior focus', (t) => {
  const { doc, sentinel, overlay, inputEl } = setup();
  t.after(() => overlay.dispose());

  sentinel.focus();
  overlay.open();
  assert.equal(doc.activeElement, inputEl(), 'first open focuses the field');
  // Re-open while already visible (focus is on the input now) must NOT capture
  // the input as the "prior" focus.
  overlay.open();
  overlay.close();
  assert.equal(doc.activeElement, sentinel, 'still restores the original prior focus');
});

test('picker-overlay focus-restore is a fallback: an onClosed that refocuses wins', (t) => {
  const { doc, stage, sentinel, overlay } = setup({
    // Mirrors the controller (onClosed: () => editorHost.focus()).
    onClosed: () => stage.focus(),
  });
  t.after(() => overlay.dispose());
  // stage must be focusable for this assertion.
  stage.setAttribute('tabindex', '-1');

  sentinel.focus();
  overlay.open();
  overlay.close();
  assert.equal(doc.activeElement, stage, 'onClosed runs after the restore and wins');
});

test('a rejected loader reports the failure and refreshes the visible picker state', async (t) => {
  let loadError = null;
  const { stage, overlay } = setup({
    loadItems: async () => { throw new Error('worker failed'); },
    onLoadError: (error) => { loadError = error; },
    renderEmptyStatus: () => `<div class="empty">${loadError ? 'Load failed' : 'No matches'}</div>`,
  });
  t.after(() => overlay.dispose());

  overlay.open();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(loadError?.message, 'worker failed');
  assert.equal(stage.querySelector('.empty').textContent, 'Load failed');
});

function rowMarkup(item, index, selected) {
  return `<div class="ide-picker-row${selected ? ' ide-picker-row--selected' : ''}"`
    + ` data-test-row="${index}">${item}</div>`;
}

function setupRows(computeMatches, buildRowMarkup = rowMarkup) {
  const dom = new JSDOM('<!doctype html><body><div id="stage"></div></body>');
  const stage = dom.window.document.getElementById('stage');
  const overlay = createIdePickerOverlay({
    getDom: () => ({ ideEditorStage: stage }),
    textField,
    ariaLabel: 'Search',
    resultsAriaLabel: 'Results',
    rowSelector: '[data-test-row]',
    callbacks: {
      computeMatches,
      isLoading: () => false,
      renderEmptyStatus: () => '<div class="empty"></div>',
      buildRowMarkup,
    },
  });
  return { dom, stage, overlay, input: () => stage.querySelector('.inv-text-field-control') };
}

test('picker-overlay exposes combobox semantics and the selected row through aria-activedescendant', (t) => {
  const { dom, stage, overlay, input } = setupRows(() => ['alpha', 'beta', 'gamma']);
  t.after(() => overlay.dispose());

  overlay.open();
  const listbox = stage.querySelector('[role="listbox"]');
  assert.ok(listbox.id, 'listbox has an id');
  assert.equal(input().getAttribute('role'), 'combobox');
  assert.equal(input().getAttribute('aria-autocomplete'), 'list');
  assert.equal(input().getAttribute('aria-haspopup'), 'listbox');
  assert.equal(input().getAttribute('aria-controls'), listbox.id);
  assert.equal(input().getAttribute('aria-expanded'), 'true');

  const selectedId = () => stage.querySelector('[aria-selected="true"]').id;
  assert.equal(stage.querySelectorAll('[role="option"]').length, 3, 'every row is an option');
  assert.equal(input().getAttribute('aria-activedescendant'), selectedId());

  input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(stage.querySelectorAll('[aria-selected="true"]').length, 1);
  assert.equal(stage.querySelector('[aria-selected="true"]').textContent, 'beta');
  assert.equal(input().getAttribute('aria-activedescendant'), selectedId(), 'follows ArrowDown');

  overlay.close();
  assert.equal(input().getAttribute('aria-expanded'), 'false');
  assert.equal(input().hasAttribute('aria-activedescendant'), false, 'cleared on close');
});

test('picker-overlay keeps caller row ids and drops aria-activedescendant when there are no rows', (t) => {
  let items = ['one'];
  const { overlay, input } = setupRows(() => items, (item, index, selected) => (
    `<div id="mine-${index}" class="ide-picker-row" data-test-row="${index}"`
    + ` role="option" aria-selected="${selected}">${item}</div>`));
  t.after(() => overlay.dispose());

  overlay.open();
  assert.equal(input().getAttribute('aria-activedescendant'), 'mine-0', 'caller id wins');
  items = [];
  overlay.refresh();
  assert.equal(input().hasAttribute('aria-activedescendant'), false);
});
