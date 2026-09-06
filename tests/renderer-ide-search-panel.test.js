'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness, dispatchInput, pressKey, settle, openContextMenu, findMenuItem,
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

function queryInput(harness) {
  return harness.getDom().ideRailPanel.querySelector('[data-ide-search-input]');
}

test('ide search panel renders, debounces typing, and groups results by file', async (t) => {
  const harness = createSearchHarness(t, {
    'src/app.js': 'const alpha = 1;\nconst beta = alpha + 1;\n',
    'README.md': 'plain text\n',
  });
  await harness.controller.activateIde();
  await settle();

  const panel = harness.getDom().ideRailPanel;
  assert.ok(panel.querySelector('.ide-search'));
  assert.ok(queryInput(harness));

  dispatchInput(harness, queryInput(harness), 'alpha');
  // Debounced: nothing fires synchronously.
  assert.equal(harness.bridge.calls.searchInFiles.length, 0);
  await settle(400);
  assert.deepEqual(harness.bridge.calls.searchInFiles, [{ query: 'alpha' }]);

  const fileRow = panel.querySelector('[data-ide-search-file="src/app.js"]');
  assert.ok(fileRow);
  assert.equal(fileRow.querySelector('.ide-search-file-count').textContent, '2');
  const matches = [...panel.querySelectorAll('[data-ide-search-path]')];
  assert.equal(matches.length, 2);
  assert.equal(matches[0].dataset.ideSearchLine, '1');
  assert.equal(matches[0].querySelector('.ide-search-hit').textContent, 'alpha');
  assert.ok(panel.querySelector('.ide-search-status').textContent.includes('2 matches in 1 file'));

  // Collapsing a file group hides its match rows.
  fileRow.click();
  await settle();
  assert.equal(harness.getDom().ideRailPanel.querySelectorAll('[data-ide-search-path]').length, 0);
});

test('ide search panel skips short queries and Enter runs immediately', async (t) => {
  const harness = createSearchHarness(t, { 'a.txt': 'aaa\n' });
  await harness.controller.activateIde();
  await settle();

  dispatchInput(harness, queryInput(harness), 'a');
  await settle(400);
  assert.equal(harness.bridge.calls.searchInFiles.length, 0);

  dispatchInput(harness, queryInput(harness), 'aaa');
  pressKey(harness, queryInput(harness), 'Enter');
  await settle(30);
  // Enter bypassed the debounce window entirely.
  assert.deepEqual(harness.bridge.calls.searchInFiles, [{ query: 'aaa' }]);
});

test('ide search result click opens the file and reveals the match position', async (t) => {
  const harness = createSearchHarness(t, {
    'src/app.js': 'const alpha = 1;\nconst beta = alpha + 1;\n',
  });
  await harness.controller.activateIde();
  await settle();

  dispatchInput(harness, queryInput(harness), 'beta');
  pressKey(harness, queryInput(harness), 'Enter');
  await settle(30);

  const match = harness.getDom().ideRailPanel.querySelector('[data-ide-search-path="src/app.js"]');
  assert.equal(match.dataset.ideSearchLine, '2');
  assert.equal(match.dataset.ideSearchColumn, '7');
  match.click();
  await settle();

  assert.deepEqual(harness.bridge.calls.readFile.map((call) => call.path), ['src/app.js']);
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="src/app.js"]'));
  // Fallback editor: the caret landed on line 2, column 7 ("beta").
  const textarea = harness.getDom().ideEditorFallback;
  assert.equal(textarea.selectionStart, 'const alpha = 1;\n'.length + 6);
});

test('ide search Escape clears the query and results', async (t) => {
  const harness = createSearchHarness(t, { 'note.md': 'jenny says hi\n' });
  await harness.controller.activateIde();
  await settle();

  dispatchInput(harness, queryInput(harness), 'jenny');
  pressKey(harness, queryInput(harness), 'Enter');
  await settle(30);
  assert.equal(harness.getDom().ideRailPanel.querySelectorAll('[data-ide-search-path]').length, 1);

  pressKey(harness, queryInput(harness), 'Escape');
  await settle(30);
  const panel = harness.getDom().ideRailPanel;
  assert.equal(panel.querySelectorAll('[data-ide-search-path]').length, 0);
  assert.equal(queryInput(harness).value, '');
  assert.equal(harness.state.ui.ide.search.query, '');
});

test('ide search keeps focus in the query field across result re-renders', async (t) => {
  const harness = createSearchHarness(t, { 'doc.txt': 'findable text\n' });
  await harness.controller.activateIde();
  await settle();

  const input = queryInput(harness);
  input.focus();
  dispatchInput(harness, input, 'findable');
  await settle(400);

  // The panel re-rendered (results now present) with a fresh input element
  // that took the focus back.
  const freshInput = queryInput(harness);
  assert.notEqual(freshInput, input);
  assert.equal(harness.dom.window.document.activeElement, freshInput);
  assert.equal(freshInput.value, 'findable');
});

test('dispose during an in-flight literal search cancels the render + result apply (F3)', async (t) => {
  const harness = createSearchHarness(t, { 'src/app.js': 'const alpha = 1;\n' });
  await harness.controller.activateIde();
  await settle();

  // Replace the bridge's searchInFiles with a controllable-delay stub so the
  // await inside runSearch is still pending when dispose() fires.
  let resolveSearch;
  const pending = new Promise((resolve) => { resolveSearch = resolve; });
  const realSearchInFiles = harness.bridge.jennyShell.workspaceFs.searchInFiles;
  harness.bridge.jennyShell.workspaceFs.searchInFiles = async (payload) => {
    await pending;
    return realSearchInFiles(payload);
  };

  const panel = harness.getDom().ideRailPanel;
  dispatchInput(harness, queryInput(harness), 'alpha');
  pressKey(harness, queryInput(harness), 'Enter'); // runSearch() starts, awaits the pending promise
  await settle(5);

  // Snapshot right before dispose: runSearch's synchronous "Searching..." render
  // already happened by this point, so this is the correct pre-dispose baseline.
  const markupBeforeDispose = panel.__jennyIdeRailMarkup;
  harness.dispose(); // runs disposeIdeBindings -> searchPanel.dispose()
  resolveSearch();
  await settle(30);

  // The disposed search panel must not have applied the stale results: markup
  // never changed from its pre-dispose snapshot and the search slice stayed empty.
  assert.equal(panel.__jennyIdeRailMarkup, markupBeforeDispose, 'renderSearchPanel did not run after dispose');
  assert.deepEqual(harness.state.ui.ide.search.results, [], 'stale results were never written back to state');
});

test('dispose during an in-flight regex find cancels the stale result apply (F3)', async (t) => {
  const harness = createSearchHarness(t, { 'a.txt': 'needle one\n' });
  await harness.controller.activateIde();
  await settle();

  // Switch to regex mode directly on the runtime slice (equivalent to clicking
  // the toggle chip, without depending on the replace-controller toolbar markup).
  harness.state.ui.ide.search.useRegex = true;

  // Stub the FIRST await inside replaceController.runRegexFind (the
  // listAllFiles listing call) so the regex find is still in flight — parked
  // on this pending promise — when dispose() fires.
  let resolveListing;
  const pending = new Promise((resolve) => { resolveListing = resolve; });
  const realListAllFiles = harness.bridge.jennyShell.workspaceFs.listAllFiles;
  harness.bridge.jennyShell.workspaceFs.listAllFiles = async (...args) => {
    await pending;
    return realListAllFiles(...args);
  };

  const panel = harness.getDom().ideRailPanel;

  // Drive a regex query while listeners are still live: runSearch ->
  // replaceController.runRegexFind starts and parks on the pending listing.
  dispatchInput(harness, queryInput(harness), 'needle');
  pressKey(harness, queryInput(harness), 'Enter');
  await settle(5);

  // Snapshot right before dispose: the pre-dispose baseline (busy render
  // already happened synchronously inside runRegexFind).
  const markupBeforeDispose = panel.__jennyIdeRailMarkup;
  const resultsBeforeDispose = harness.state.ui.ide.search.results;

  harness.dispose(); // searchPanel.dispose() -> invalidateFind + replaceController.dispose()
  resolveListing({ files: ['a.txt'], truncated: false }); // let the parked find resume with non-empty files
  await settle(30);

  // The disposed panel must not have applied the stale regex results: markup
  // and the search slice are unchanged from the pre-dispose snapshot (the
  // seq !== findSeq check inside runRegexFind bailed).
  assert.equal(panel.__jennyIdeRailMarkup, markupBeforeDispose, 'no re-render happened after dispose');
  assert.deepEqual(harness.state.ui.ide.search.results, resultsBeforeDispose, 'stale regex results were never written back to state');
});

test('Find in Folder scopes the search to a directory, then the chip clears it', async (t) => {
  // Default persisted railPanel is 'explorer', so the file tree is shown and a
  // folder can be right-clicked (no SEARCH_PERSISTED here).
  const harness = createHarness({
    bridgeOptions: {
      files: {
        'src/app.js': 'needle one\n',
        'src/inner/deep.js': 'needle two\n',
        'lib/util.js': 'needle three\n',
      },
    },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;

  // The directory context menu offers "Find in Folder".
  openContextMenu(harness, harness.getDom().ideRailPanel.querySelector('[data-ide-tree-path="src"]'));
  const item = findMenuItem(doc, 'Find in Folder');
  assert.ok(item, 'directory menu offers Find in Folder');
  item.click();
  await settle();

  // The rail switched to the search panel, which shows a clearable scope chip.
  const rail = harness.getDom().ideRailPanel;
  const chip = rail.querySelector('[data-ide-search-clear-scope]');
  assert.ok(chip, 'a scope chip renders');
  assert.ok(chip.textContent.includes('src'));

  // Typing a query threads the scope into the payload AND scopes the results.
  // The payload assertion is the load-bearing, non-circular check that the
  // renderer forwards scope; the DOM result filtering is the harness fake mirror
  // (the REAL backend scoping is proven against disk in workspace-ide-search.test.js).
  const input = rail.querySelector('[data-ide-search-input]');
  dispatchInput(harness, input, 'needle');
  pressKey(harness, input, 'Enter');
  await settle(40);
  assert.deepEqual(harness.bridge.calls.searchInFiles.at(-1), { query: 'needle', scope: 'src' });
  const scopedFiles = [...rail.querySelectorAll('[data-ide-search-file]')]
    .map((el) => el.dataset.ideSearchFile).sort();
  assert.deepEqual(scopedFiles, ['src/app.js', 'src/inner/deep.js']);

  // Clicking the chip clears the scope and re-runs against the whole workspace.
  rail.querySelector('[data-ide-search-clear-scope]').click();
  await settle(40);
  assert.deepEqual(harness.bridge.calls.searchInFiles.at(-1), { query: 'needle' });
  const allFiles = [...harness.getDom().ideRailPanel.querySelectorAll('[data-ide-search-file]')]
    .map((el) => el.dataset.ideSearchFile).sort();
  assert.deepEqual(allFiles, ['lib/util.js', 'src/app.js', 'src/inner/deep.js']);
});
