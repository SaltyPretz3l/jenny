'use strict';

/* Bug-pass #4 (workspace panels): typing in the Search panel's Replace field
 * (or re-running a find from a toggle) must not recreate the query/replace
 * inputs or the option toggles - only the results region repaints - and an IME
 * composition defers the preview repaint to compositionend. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness,
  dispatchInput,
  pressKey,
  settle,
} = require('./helpers/renderer-ide-harness');

const SEARCH_PERSISTED = {
  openTabs: [],
  activeTabPath: '',
  expandedDirs: [],
  railPanel: 'search',
  railSide: 'right',
  railWidth: 300,
};

function makeHarness(t, files) {
  const harness = createHarness({ bridgeOptions: { files, persisted: SEARCH_PERSISTED } });
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

function toolbarBtn(harness, action) {
  return panelOf(harness).querySelector(`[data-ide-replace-action="${action}"]`);
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

test('typing in Replace keeps the same inputs and toggles, focus and caret; only previews repaint (bug-pass #4)', async (t) => {
  const harness = makeHarness(t, { 'e.txt': 'alpha one\nalpha two\n' });
  await harness.controller.activateIde();
  await settle();
  await runFind(harness, 'alpha');
  const doc = harness.dom.window.document;
  const query = queryInput(harness);
  const replace = replaceInput(harness);
  const caseChip = toolbarBtn(harness, 'toggle-case');
  const replaceAll = toolbarBtn(harness, 'replace-all');
  replace.focus();
  await setReplace(harness, 'be');
  replace.setSelectionRange(1, 1);
  await setReplace(harness, 'beta');
  replace.setSelectionRange(2, 2);
  assert.equal(replaceInput(harness), replace, 'the replace input is the same element');
  assert.equal(queryInput(harness), query, 'the query input is the same element');
  assert.equal(toolbarBtn(harness, 'toggle-case'), caseChip, 'the option toggle is the same element');
  assert.equal(toolbarBtn(harness, 'replace-all'), replaceAll, 'Replace All is the same element');
  assert.equal(doc.activeElement, replace, 'focus stays in the replace field');
  assert.equal(replace.value, 'beta');
  assert.equal(replace.selectionStart, 2, 'caret untouched by the preview repaint');
  const afters = [...panelOf(harness).querySelectorAll('.ide-search-replace-after')].map((el) => el.textContent);
  assert.deepEqual(afters, ['beta', 'beta'], 'the previews track the replace text');
});

test('an IME composition in Replace defers the preview repaint to compositionend (bug-pass #4)', async (t) => {
  const harness = makeHarness(t, { 'f.txt': 'alpha\n' });
  await harness.controller.activateIde();
  await settle();
  await runFind(harness, 'alpha');
  const win = harness.dom.window;
  const replace = replaceInput(harness);
  replace.focus();
  replace.dispatchEvent(new win.Event('compositionstart', { bubbles: true }));
  const resultsBefore = panelOf(harness).querySelector('.ide-search-results');
  replace.value = 'ベ';
  replace.dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle(5);
  assert.equal(panelOf(harness).querySelector('.ide-search-results'), resultsBefore, 'no repaint mid-composition');
  assert.equal(harness.state.ui.ide.search.replaceText, '', 'partial composition not committed');
  replace.value = 'ベータ';
  replace.dispatchEvent(new win.Event('compositionend', { bubbles: true }));
  await settle(5);
  assert.equal(harness.state.ui.ide.search.replaceText, 'ベータ');
  assert.equal(replaceInput(harness), replace);
  assert.equal(win.document.activeElement, replace);
  assert.equal(panelOf(harness).querySelector('.ide-search-replace-after').textContent, 'ベータ');
});

test('a toggle keeps its element (and focus) across the re-run find, with aria-pressed patched (bug-pass #4)', async (t) => {
  const harness = makeHarness(t, { 'g.txt': 'Alpha\nalpha\n' });
  await harness.controller.activateIde();
  await settle();
  await runFind(harness, 'alpha');
  const caseChip = toolbarBtn(harness, 'toggle-case');
  caseChip.focus();
  caseChip.click();
  await settle(40);
  assert.equal(toolbarBtn(harness, 'toggle-case'), caseChip);
  assert.equal(caseChip.getAttribute('aria-pressed'), 'true');
  assert.ok(caseChip.classList.contains('ide-search-toggle--active'));
  assert.equal(harness.dom.window.document.activeElement, caseChip);
});

test('Enter that confirms an IME composition in Replace (or the query) never runs Replace All / search (Astra review)', async (t) => {
  const harness = makeHarness(t, { 'h.txt': 'alpha alpha\n' });
  await harness.controller.activateIde();
  await settle();
  await runFind(harness, 'alpha');
  const win = harness.dom.window;
  const replace = replaceInput(harness);
  replace.focus();
  replace.dispatchEvent(new win.Event('compositionstart', { bubbles: true }));
  replace.value = 'ベ';
  replace.dispatchEvent(new win.Event('input', { bubbles: true }));
  const confirmEnter = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
  replace.dispatchEvent(confirmEnter);
  await settle(40);
  assert.equal(confirmEnter.defaultPrevented, false, 'the IME keeps its Enter');
  assert.equal(harness.bridge.state.files['h.txt'], 'alpha alpha\n', 'no Replace All with the stale replacement');
  replace.dispatchEvent(new win.Event('compositionend', { bubbles: true }));
  await settle(5);
  const query = queryInput(harness);
  query.focus();
  const ranBefore = harness.state.ui.ide.search.ranQuery;
  query.dispatchEvent(new win.Event('compositionstart', { bubbles: true }));
  const escape = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
  query.dispatchEvent(escape);
  await settle(20);
  assert.equal(escape.defaultPrevented, false, 'the IME keeps its Escape');
  assert.equal(harness.state.ui.ide.search.ranQuery, ranBefore, 'composition Escape does not clear the search');
});
test('a full repaint mid-composition drops the composing flag, so Enter works again in the new inputs (merge review)', async (t) => {
  const harness = makeHarness(t, { 'k.txt': 'alpha\n' });
  await harness.controller.activateIde();
  await settle();
  await runFind(harness, 'alpha');
  const win = harness.dom.window;
  const replace = replaceInput(harness);
  replace.focus();
  replace.dispatchEvent(new win.Event('compositionstart', { bubbles: true }));
  // Another panel paints the shared host; the composing input is gone and its compositionend never arrives.
  const panel = panelOf(harness);
  panel.innerHTML = '<div class="ide-tree"></div>';
  panel.__jennyIdeRailMarkup = 'another-panel';
  harness.controller.renderIde();
  await settle(5);
  const fresh = replaceInput(harness);
  assert.ok(fresh && fresh !== replace, 'a fresh replace input after the full repaint');
  fresh.focus();
  const enter = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  fresh.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true, 'Enter is handled again (the stale composing flag no longer blocks it)');
});
