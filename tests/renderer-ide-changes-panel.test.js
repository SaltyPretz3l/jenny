'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildChangeTurn,
  createHarness,
  dispatchInput,
  findMenuItem,
  openContextMenu,
  settle,
} = require('./helpers/renderer-ide-harness');

async function activateChangesPanel(harness) {
  await harness.controller.activateIde();
  await settle();
  // The 'changes' panel homes to the secondary sidebar by default under the
  // CONFIG_VERSION 28 "Move View" model (DEFAULT_PANEL_LOCATIONS.changes =
  // 'secondary'). Pin it to the primary rail for these tests so it mounts into
  // #ideRailPanel -- the host every assertion below queries.
  harness.state.ui.ide.panelLocations = {
    ...harness.state.ui.ide.panelLocations,
    changes: 'primary',
  };
  harness.state.ui.ide.railPanel = 'changes';
  harness.controller.renderIde();
  await settle();
}

test('changes panel renders ledger rows grouped by file with disabled rows', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'now', 'notes.md': 'n', 'bad.txt': 'b' } },
    turnViewModels: [
      buildChangeTurn({ turnId: 'turn-1', path: 'src/app.js', beforeHash: 'sha256:aaa', additions: 5, deletions: 2 }),
      buildChangeTurn({ turnId: 'turn-2', path: 'notes.md', status: 'created', beforeHash: null, additions: 3 }),
      buildChangeTurn({ turnId: 'turn-3', toolCallId: 'tool-3', path: 'src/app.js', beforeHash: 'sha256:bbb', additions: 1, deletions: 1 }),
      buildChangeTurn({ turnId: 'turn-4', path: 'bad.txt', beforeHash: 'sha256:ccc', reviewState: 'failed' }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);

  const panel = harness.getDom().ideRailPanel;
  const fileHeaders = [...panel.querySelectorAll('.ide-changes-file')];
  // Grouped by path, most recently touched file first.
  assert.deepEqual(
    fileHeaders.map((el) => el.querySelector('.ide-changes-file-name').textContent),
    ['bad.txt', 'app.js', 'notes.md']
  );
  // Two app.js ops + the created notes.md are clickable; the failed one is not.
  assert.equal(panel.querySelectorAll('[data-ide-changes-open]').length, 3);
  const disabled = panel.querySelectorAll('.ide-changes-row--disabled');
  assert.equal(disabled.length, 1);
  assert.equal(panel.querySelector('.ide-changes-count').textContent, '4');
  assert.ok(panel.textContent.includes('+5'));
  assert.ok(panel.textContent.includes('-2'));
});

test('clicking a ledger row opens a read-only diff tab from the snapshot', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'new content\n' },
      snapshots: { 'sha256:abc': 'old content\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:abc', additions: 1, deletions: 1 }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  await harness.controller.openFile('src/app.js');
  await settle();

  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  assert.deepEqual(harness.bridge.calls.readPreChange, [
    { path: 'src/app.js', beforeHash: 'sha256:abc' },
  ]);
  const diffTab = harness.getDom().ideTabStrip.querySelector('.ide-tab--diff');
  assert.ok(diffTab, 'expected a diff tab in the strip');
  assert.ok(diffTab.textContent.includes("app.js (Jenny's change)"));

  const textarea = harness.getDom().ideEditorFallback;
  assert.equal(textarea.readOnly, true);
  assert.ok(textarea.value.includes('=== Original (before change) ==='));
  assert.ok(textarea.value.includes('old content'));
  assert.ok(textarea.value.includes('new content'));

  // Diff tabs are excluded from the save path entirely.
  assert.equal(await harness.controller.saveActiveFile(), false);
  assert.equal(harness.bridge.calls.writeFile.length, 0);

  // Switching back to the file restores the editable buffer.
  harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="src/app.js"]').click();
  await settle();
  assert.equal(textarea.readOnly, false);
  assert.equal(textarea.value, 'new content\n');
});

test('historical changes from another workspace stay visible but cannot read or open', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'current workspace content' } },
    turnViewModels: [buildChangeTurn({
      path: 'src/app.js',
      beforeHash: 'sha256:historic',
      workspaceId: 'root_other',
    })],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);

  const panel = harness.getDom().ideRailPanel;
  const row = panel.querySelector('.ide-changes-row');
  assert.ok(row, 'the historical change remains visible');
  assert.equal(row.classList.contains('ide-changes-row--disabled'), true);
  assert.equal(row.hasAttribute('data-ide-changes-open'), false);
  assert.match(row.title, /originating workspace/i);
  row.click();
  await settle();
  assert.equal(harness.bridge.calls.readFile.length, 0);
  assert.equal(harness.bridge.calls.readPreChange.length, 0);
  assert.equal(harness.state.ui.ide.openTabs.length, 0);
});

test('a missing snapshot falls back to the hunks-summary placeholder', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'new content\n' } },
    turnViewModels: [
      buildChangeTurn({
        path: 'src/app.js',
        beforeHash: 'sha256:evicted',
        additions: 1,
        deletions: 1,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new', '+more'] }],
      }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);

  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  assert.equal(harness.bridge.calls.readPreChange.length, 1);
  const textarea = harness.getDom().ideEditorFallback;
  assert.equal(textarea.readOnly, true);
  assert.ok(textarea.value.includes('no longer available'));
  assert.ok(textarea.value.includes('@@ -1,1 +1,2 @@'));
  assert.ok(textarea.value.includes('+more'));
  // Placeholder mode never shows the fake side-by-side composition.
  assert.equal(textarea.value.includes('=== Original'), false);
});

test('created-file changes diff against an empty original without a snapshot lookup', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'notes.md': 'brand new\n' } },
    turnViewModels: [
      buildChangeTurn({ path: 'notes.md', status: 'created', beforeHash: null, additions: 1 }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);

  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  assert.equal(harness.bridge.calls.readPreChange.length, 0);
  const textarea = harness.getDom().ideEditorFallback;
  assert.ok(textarea.value.includes('=== Original (before change) ==='));
  assert.ok(textarea.value.includes('brand new'));
});

test('legacy changes without a workspace stamp stay reviewable via the snapshot store', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'new legacy\n' },
      snapshots: { 'sha256:legacy': 'old legacy\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:legacy', additions: 1, deletions: 1, workspaceId: 'unknown' }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);

  const panel = harness.getDom().ideRailPanel;
  const row = panel.querySelector('.ide-changes-row');
  assert.equal(row.classList.contains('ide-changes-row--disabled'), false);
  assert.ok(row.hasAttribute('data-ide-changes-open'), 'legacy row is clickable');
  assert.match(row.title, /Recorded before this app tracked workspace identity/);
  assert.ok(row.querySelector('.ide-changes-row-hint--open'), 'clickable rows carry a visible affordance');
  assert.equal(row.querySelector('[data-ide-changes-revert]'), null, 'legacy rows never offer revert');

  row.click();
  await settle();
  assert.deepEqual(harness.bridge.calls.readPreChange, [
    { path: 'src/app.js', beforeHash: 'sha256:legacy' },
  ]);
  const textarea = harness.getDom().ideEditorFallback;
  assert.equal(textarea.readOnly, true);
  assert.ok(textarea.value.includes('=== Original (before change) ==='));
  assert.ok(textarea.value.includes('old legacy'));
  assert.ok(textarea.value.includes('new legacy'));
});

test('a legacy hunks-only change opens the summary; a stamped hash-less one stays disabled', async (t) => {
  const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }];
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'new content\n', 'other.js': 'x' } },
    turnViewModels: [
      buildChangeTurn({ turnId: 'turn-1', path: 'src/app.js', status: 'modified', beforeHash: null, additions: 1, deletions: 1, hunks, workspaceId: 'unknown' }),
      // Same shape but stamped with the current workspace: no snapshot key and
      // not created, so no diff can be reconstructed — stays disabled.
      buildChangeTurn({ turnId: 'turn-2', toolCallId: 'tool-2', path: 'other.js', status: 'modified', beforeHash: null, hunks: [] }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);

  const panel = harness.getDom().ideRailPanel;
  assert.equal(panel.querySelectorAll('[data-ide-changes-open]').length, 1);
  assert.equal(panel.querySelectorAll('.ide-changes-row--disabled').length, 1);

  panel.querySelector('[data-ide-changes-open]').click();
  await settle();
  // No snapshot hash: never a fake empty-original side-by-side, always the
  // recorded-hunks summary.
  assert.equal(harness.bridge.calls.readPreChange.length, 0);
  const textarea = harness.getDom().ideEditorFallback;
  assert.equal(textarea.readOnly, true);
  assert.ok(textarea.value.includes('no longer available'));
  assert.ok(textarea.value.includes('+new'));
  assert.equal(textarea.value.includes('=== Original'), false);
});

test('unsaved compare works from the panel section and the tab context menu', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'notes.md': 'v1-disk' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  await harness.controller.openFile('notes.md');
  await settle();
  dispatchInput(harness, harness.getDom().ideEditorFallback, 'v1-local');
  await settle();

  // Pin 'changes' to the primary rail (default-homed to the secondary sidebar
  // under the "Move View" model) so it mounts into #ideRailPanel below.
  harness.state.ui.ide.panelLocations = {
    ...harness.state.ui.ide.panelLocations,
    changes: 'primary',
  };
  harness.state.ui.ide.railPanel = 'changes';
  harness.controller.renderIde();
  await settle();

  const unsavedRow = harness.getDom().ideRailPanel.querySelector('[data-ide-changes-unsaved]');
  assert.ok(unsavedRow, 'expected the dirty buffer in the unsaved section');
  unsavedRow.click();
  await settle();

  const textarea = harness.getDom().ideEditorFallback;
  assert.equal(textarea.readOnly, true);
  assert.ok(textarea.value.includes('v1-disk'));
  assert.ok(textarea.value.includes('v1-local'));
  const diffTab = harness.getDom().ideTabStrip.querySelector('.ide-tab--diff');
  assert.ok(diffTab.textContent.includes('notes.md (unsaved vs saved)'));

  // Same compare via the file tab's context menu; the dirty buffer survives.
  harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="notes.md"]').click();
  await settle();
  assert.equal(textarea.readOnly, false);
  assert.equal(textarea.value, 'v1-local');
  // Re-query: activating the tab re-rendered the strip markup.
  openContextMenu(
    harness,
    harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="notes.md"]')
  );
  const compareItem = findMenuItem(harness.dom.window.document, 'Compare with Saved');
  assert.ok(compareItem, 'expected the Compare with Saved menu item');
  compareItem.click();
  await settle();
  assert.equal(textarea.readOnly, true);
  assert.ok(textarea.value.includes('v1-disk'));
});

test('changes panel renders the empty state and survives a broken ledger source', async (t) => {
  const empty = createHarness({ bridgeOptions: { files: {} } });
  t.after(() => empty.dispose());
  await activateChangesPanel(empty);
  assert.ok(empty.getDom().ideRailPanel.textContent.includes('her changes line up here'));
  empty.dispose();

  const broken = createHarness({
    bridgeOptions: { files: {} },
    turnViewModels: () => {
      throw new Error('projection context exploded');
    },
  });
  t.after(() => broken.dispose());
  await activateChangesPanel(broken);
  assert.ok(broken.getDom().ideRailPanel.textContent.includes('Could not read the change ledger'));
});
