'use strict';

/* UIUX-037: IDE search-result rows are keyboard-correct. Each file/match row
 * exposes a role="button" activation control that is a SIBLING of its
 * per-row replace <button> (never nested -- two interactive controls inside
 * one another is invalid and ambiguous for both AT and click delegation),
 * and Enter/Space on the activation control does exactly what a click does. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness, dispatchInput, pressKey, settle,
} = require('./helpers/renderer-ide-harness');

const SEARCH_PERSISTED = {
  openTabs: [],
  activeTabPath: '',
  expandedDirs: [],
  railPanel: 'search',
  railSide: 'right',
  railWidth: 300,
};

function createSearchHarness(t, files) {
  const harness = createHarness({
    bridgeOptions: { files, persisted: SEARCH_PERSISTED },
  });
  t.after(() => harness.dispose());
  return harness;
}

function panelOf(harness) {
  return harness.getDom().ideRailPanel;
}

function queryInput(harness) {
  return panelOf(harness).querySelector('[data-ide-search-input]');
}

function replaceInput(harness) {
  return panelOf(harness).querySelector('[data-ide-replace-input]');
}

async function runFind(harness, query) {
  dispatchInput(harness, queryInput(harness), query);
  pressKey(harness, queryInput(harness), 'Enter');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await settle(5);
    const search = harness.state.ui.ide.search || {};
    if (search.busy !== true && (search.ranQuery === query || search.error)) return;
  }
  throw new Error(`search did not settle for ${query}`);
}

async function setReplace(harness, value) {
  dispatchInput(harness, replaceInput(harness), value);
  await settle(5);
}

test('search result rows have no interactive nesting (real button never inside role="button")', async (t) => {
  const harness = createSearchHarness(t, {
    'src/app.js': 'const alpha = 1;\nconst beta = alpha + 1;\n',
  });
  await harness.controller.activateIde();
  await settle();

  await runFind(harness, 'alpha');
  await setReplace(harness, 'ALPHA'); // non-empty replace text renders the per-row replace buttons

  const panel = panelOf(harness);
  assert.ok(panel.querySelector('[data-ide-replace-file]'), 'per-file replace button rendered');
  assert.ok(panel.querySelector('[data-ide-replace-match]'), 'per-match replace button rendered');

  const nested = panel.querySelectorAll('[role="button"] button');
  assert.equal(nested.length, 0, 'no real <button> is nested inside a role="button" row');

  // The activation control and the replace button must be SIBLINGS.
  const fileActivate = panel.querySelector('[data-ide-search-file="src/app.js"]');
  const fileReplace = panel.querySelector('[data-ide-replace-file="src/app.js"]');
  assert.equal(fileActivate.parentElement, fileReplace.parentElement,
    'file-row activation control and its replace button share the same parent');
  assert.equal(fileActivate.contains(fileReplace), false);

  const matchActivate = panel.querySelector('[data-ide-search-path]');
  const matchReplace = panel.querySelector('[data-ide-replace-match]');
  assert.equal(matchActivate.parentElement, matchReplace.parentElement,
    'match-row activation control and its replace button share the same parent');
  assert.equal(matchActivate.contains(matchReplace), false);
});

test('Enter on a match row opens the result, same as a click (UIUX-037)', async (t) => {
  const harness = createSearchHarness(t, {
    'src/app.js': 'const alpha = 1;\nconst beta = alpha + 1;\n',
  });
  await harness.controller.activateIde();
  await settle();

  await runFind(harness, 'beta');
  const match = panelOf(harness).querySelector('[data-ide-search-path="src/app.js"]');
  assert.equal(match.getAttribute('role'), 'button');
  assert.equal(match.tagName, 'SPAN', 'activation control is not itself a nested-interactive <button>');

  match.focus();
  match.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();

  assert.deepEqual(harness.bridge.calls.readFile.map((call) => call.path), ['src/app.js']);
  const textarea = harness.getDom().ideEditorFallback;
  assert.equal(textarea.selectionStart, 'const alpha = 1;\n'.length + 6);
});

test('Space on a match row opens the result too', async (t) => {
  const harness = createSearchHarness(t, {
    'note.md': 'jenny says hi\n',
  });
  await harness.controller.activateIde();
  await settle();

  await runFind(harness, 'jenny');
  const match = panelOf(harness).querySelector('[data-ide-search-path="note.md"]');
  match.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  await settle();

  assert.deepEqual(harness.bridge.calls.readFile.map((call) => call.path), ['note.md']);
});

test('Enter on a file-group row collapses it, same as a click', async (t) => {
  const harness = createSearchHarness(t, {
    'src/app.js': 'const alpha = 1;\nconst beta = alpha + 1;\n',
  });
  await harness.controller.activateIde();
  await settle();

  await runFind(harness, 'alpha');
  const panel = panelOf(harness);
  assert.equal(panel.querySelectorAll('[data-ide-search-path]').length, 2, 'two "alpha" matches in one file');

  const fileRow = panel.querySelector('[data-ide-search-file="src/app.js"]');
  assert.equal(fileRow.getAttribute('aria-expanded'), 'true');
  fileRow.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();

  assert.equal(panel.querySelectorAll('[data-ide-search-path]').length, 0, 'Enter collapsed the file group');
  const collapsedRow = panel.querySelector('[data-ide-search-file="src/app.js"]');
  assert.equal(collapsedRow.getAttribute('aria-expanded'), 'false');
});
