'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeDiffController } = require('../renderer/features/renderer-ide-diff-controller');
const { createIdeUiState } = require('../renderer/features/renderer-ide-state');
const { createHarness, buildChangeTurn, settle } = require('./helpers/renderer-ide-harness');

function confirmButton(harness, action) {
  return harness.dom.window.document.body.querySelector(`[data-ide-confirm-action="${action}"]`);
}

function hunksFor(oldText, newText) {
  if (oldText === 'a\nb\nc\n' && newText === 'a\nB\nc\n') {
    return [{
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [' a', '-b', '+B', ' c'],
    }];
  }
  if (
    oldText === 'l01\nl02\nl03\nl04\nl05\nl06\nl07\nl08\nl09\nl10\nl11\nl12\n'
    && newText === 'l01\nL02\nl03\nl04\nl05\nl06\nl07\nl08\nl09\nl10\nL11\nl12\n'
  ) {
    return [
      {
        oldStart: 1,
        oldLines: 5,
        newStart: 1,
        newLines: 5,
        lines: [' l01', '-l02', '+L02', ' l03', ' l04', ' l05'],
      },
      {
        oldStart: 8,
        oldLines: 5,
        newStart: 8,
        newLines: 5,
        lines: [' l08', ' l09', ' l10', '-l11', '+L11', ' l12'],
      },
    ];
  }
  if (oldText === 'a\nb\nc\n' && newText === 'A\nb\nC\n') {
    return [{
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: ['-a', '+A', ' b', '-c', '+C'],
    }];
  }
  if (oldText === 'a\nb' && newText === 'a\nB') {
    return [{
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [' a', '-b', '\\ No newline at end of file', '+B', '\\ No newline at end of file'],
    }];
  }
  assert.fail('missing sidecar structured-diff wire fixture');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

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

function diffToolbar(harness) {
  return harness.getDom().ideDiffToolbar;
}

test('revert fails closed without versioned file operations and never calls legacy writeFile', async () => {
  const writes = [];
  const toasts = [];
  const logs = [];
  const controller = createIdeDiffController({
    getIde: () => ({ activeTabPath: '' }),
    getDom: () => ({}),
    getFileOperations: () => null,
    editorHost: { isDirty: () => false },
    getWorkspaceFsApi: () => ({
      readPreChange: async () => ({ found: true, content: 'before\n' }),
      readFile: async () => ({ content: 'after\n', mtimeMs: 1 }),
      writeFile: async (payload) => { writes.push(payload); return { mtimeMs: 2 }; },
    }),
    confirmDialog: { confirm: async () => true },
    callbacks: {
      appendClientLog: (level, event, meta) => logs.push({ level, event, meta }),
      showShellErrorToast: (message, meta) => toasts.push({ message, meta }),
    },
  });

  const result = await controller.revertChange({
    changeId: 'change-1',
    path: 'src/app.js',
    beforeHash: 'sha256:before',
    status: 'modified',
  });

  assert.equal(result, false);
  assert.deepEqual(writes, [], 'legacy writeFile is never used');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].meta?.dedupeKey, 'ide:revert:no-bridge');
  assert.equal(toasts[0].meta?.title, 'Save Failed');
  assert.equal(toasts[0].meta?.sticky, undefined);
  assert.ok(logs.some(({ level, event, meta }) => (
    level === 'WARN'
      && event === 'ide.safety_write_failed'
      && meta.path === 'src/app.js'
      && meta.reason === 'no_bridge'
  )));
});

test('hunk-toggle refusal uses a distinct no-bridge dedupe key', async () => {
  const window = new JSDOM('<div id="toolbar"></div>').window;
  const toolbar = window.document.getElementById('toolbar');
  const ide = createIdeUiState();
  const toasts = [];
  const controller = createIdeDiffController({
    getIde: () => ide,
    getDom: () => ({ ideDiffToolbar: toolbar }),
    getFileOperations: () => null,
    editorHost: {
      openDiffDocument: async () => true,
      activateDocument: (id) => { ide.activeTabPath = id; },
      isDirty: () => false,
      hasDocument: () => false,
    },
    getWorkspaceFsApi: () => ({
      readPreChange: async () => ({ found: true, content: 'a\nb\nc\n' }),
      readFile: async () => ({ content: 'a\nB\nc\n', mtimeMs: 1 }),
    }),
    callbacks: {
      showShellErrorToast: (message, meta) => toasts.push({ message, meta }),
      appendClientLog: () => {},
      renderTabs: () => {},
    },
  });
  const change = {
    changeId: 'change-hunk',
    path: 'src/app.js',
    beforeHash: 'sha256:before',
    status: 'modified',
    reviewState: 'full',
    hunks: hunksFor('a\nb\nc\n', 'a\nB\nc\n'),
  };

  await controller.openChangeDiff(change);
  controller.bindEvents();
  controller.renderToolbar();
  toolbar.querySelector('[data-ide-diff-hunk-toggle]').click();
  await settle();

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].meta?.dedupeKey, 'ide:hunk:no-bridge');
  window.close();
});

/* ------------------------------------------------------------------ */
/* Whole-file revert from the changes-panel rows                        */
/* ------------------------------------------------------------------ */

test('row revert restores the pre-change snapshot after confirmation', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nB\nc\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', additions: 1, deletions: 1 }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);

  const revertEl = harness.getDom().ideRailPanel.querySelector('[data-ide-changes-revert]');
  assert.ok(revertEl, 'a diffable row carries a Revert affordance');
  revertEl.click();
  await settle();

  // Confirm-gated: the file is untouched until the user approves.
  assert.equal(harness.bridge.calls.writeFile.length, 0, 'no write before confirmation');
  const confirm = confirmButton(harness, 'confirm');
  assert.ok(confirm, 'the revert confirm dialog is shown');
  confirm.click();
  await settle();

  assert.equal(harness.bridge.calls.writeFile.length, 1);
  assert.equal(harness.bridge.calls.writeFile[0].path, 'src/app.js');
  assert.equal(harness.bridge.calls.writeFile[0].content, 'a\nb\nc\n', 'disk restored to the snapshot');
  assert.equal(harness.bridge.state.files['src/app.js'], 'a\nb\nc\n');
});

test('row revert cancel leaves the file untouched', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nB\nc\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', additions: 1, deletions: 1 }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);

  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-revert]').click();
  await settle();
  confirmButton(harness, 'cancel').click();
  await settle();

  assert.equal(harness.bridge.calls.writeFile.length, 0, 'cancel writes nothing');
  assert.equal(harness.bridge.state.files['src/app.js'], 'a\nB\nc\n');
});

test('row revert surfaces a toast (no prompt, no write) when the snapshot was evicted', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a\nB\nc\n' } }, // no matching snapshot
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:gone', additions: 1, deletions: 1 }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);

  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-revert]').click();
  await settle();

  assert.equal(confirmButton(harness, 'confirm'), null, 'no confirm dialog when there is nothing to restore');
  assert.equal(harness.bridge.calls.writeFile.length, 0);
  assert.ok(harness.toasts.some((toast) => /no longer available/i.test(toast.message)), 'an explanatory toast is shown');
});

/* ------------------------------------------------------------------ */
/* Diff-tab safety toolbar                                              */
/* ------------------------------------------------------------------ */

test('the toolbar is hidden for a regular file tab and shown for a Jenny-change diff', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nB\nc\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', hunks: hunksFor('a\nb\nc\n', 'a\nB\nc\n') }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  await harness.controller.openFile('src/app.js');
  await settle();
  assert.ok(diffToolbar(harness).classList.contains('hidden'), 'hidden on a normal file tab');

  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();
  assert.equal(diffToolbar(harness).classList.contains('hidden'), false, 'shown on the change diff tab');
  assert.ok(diffToolbar(harness).querySelector('[data-ide-diff-revert]'), 'revert action present');
  assert.ok(diffToolbar(harness).querySelector('[data-ide-diff-hunk-toggle]'), 'per-hunk controls present for a full diff');
});

test('toolbar revert restores the snapshot and collapses the diff', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nB\nc\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', hunks: hunksFor('a\nb\nc\n', 'a\nB\nc\n') }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  diffToolbar(harness).querySelector('[data-ide-diff-revert]').click();
  await settle();
  confirmButton(harness, 'confirm').click();
  await settle();

  assert.equal(harness.bridge.state.files['src/app.js'], 'a\nb\nc\n', 'file reverted to snapshot');
  assert.ok(diffToolbar(harness).textContent.includes('reverted'), 'toolbar reflects the reverted state');
});

/* ------------------------------------------------------------------ */
/* Per-hunk accept / reject                                             */
/* ------------------------------------------------------------------ */

test('per-hunk reject restores just that hunk; restore re-applies Jenny’s version', async (t) => {
  // Two well-separated changes => two hunks. Reject only the first.
  const original = 'l01\nl02\nl03\nl04\nl05\nl06\nl07\nl08\nl09\nl10\nl11\nl12\n';
  const jenny = 'l01\nL02\nl03\nl04\nl05\nl06\nl07\nl08\nl09\nl10\nL11\nl12\n';
  const hunks = hunksFor(original, jenny);
  assert.equal(hunks.length, 2, 'fixture must produce two hunks');

  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': jenny },
      snapshots: { 'sha256:o1': original },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', hunks }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  const toggles = diffToolbar(harness).querySelectorAll('[data-ide-diff-hunk-toggle]');
  assert.equal(toggles.length, 2, 'one toggle per hunk');

  // Reject the first hunk (l02 -> L02): only that region returns to the original.
  toggles[0].click();
  await settle();
  assert.equal(
    harness.bridge.state.files['src/app.js'],
    'l01\nl02\nl03\nl04\nl05\nl06\nl07\nl08\nl09\nl10\nL11\nl12\n',
    'first hunk reverted, second hunk kept'
  );

  // Restore it (toggle again) -> back to Jenny's full version.
  diffToolbar(harness).querySelector('[data-ide-diff-hunk-toggle]').click();
  await settle();
  assert.equal(harness.bridge.state.files['src/app.js'], jenny, 'restoring re-applies Jenny’s version');
});

test('rejecting every hunk reproduces the pre-change original', async (t) => {
  const original = 'a\nb\nc\n';
  const jenny = 'A\nb\nC\n';
  const hunks = hunksFor(original, jenny);
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': jenny },
      snapshots: { 'sha256:o1': original },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', hunks }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  for (const toggle of [...diffToolbar(harness).querySelectorAll('[data-ide-diff-hunk-toggle]')]) {
    toggle.click();
    await settle();
  }
  assert.equal(harness.bridge.state.files['src/app.js'], original, 'reject-all == pre-change original');
});

/* ------------------------------------------------------------------ */
/* Degrade path: per-hunk withheld when the diff is not 'full'          */
/* ------------------------------------------------------------------ */

test('a summary-only change shows revert but no per-hunk controls', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nB\nc\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({
        path: 'src/app.js',
        beforeHash: 'sha256:o1',
        reviewState: 'summary_only',
        additions: 1,
        deletions: 1,
      }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  const toolbar = diffToolbar(harness);
  assert.equal(toolbar.classList.contains('hidden'), false, 'toolbar still shown');
  assert.ok(toolbar.querySelector('[data-ide-diff-revert]'), 'whole-file revert remains the floor');
  assert.equal(toolbar.querySelector('[data-ide-diff-hunk-toggle]'), null, 'no dead per-hunk controls');
  assert.ok(/isn.t available/i.test(toolbar.textContent), 'explains the degrade');
});

/* ------------------------------------------------------------------ */
/* EOL preservation (CRLF / no trailing newline) end-to-end             */
/* ------------------------------------------------------------------ */

test('revert preserves CRLF line endings (snapshot is LF, disk is CRLF)', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\r\nB\r\nc\r\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' }, // snapshots are stored EOL-normalized (LF)
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', additions: 1, deletions: 1 }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-revert]').click();
  await settle();
  confirmButton(harness, 'confirm').click();
  await settle();

  assert.equal(harness.bridge.calls.writeFile.length, 1);
  assert.equal(harness.bridge.calls.writeFile[0].content, 'a\r\nb\r\nc\r\n', 'CRLF restored on the reverted content');
});

test('per-hunk reject preserves a file with no trailing newline', async (t) => {
  const original = 'a\nb'; // no trailing newline
  const jenny = 'a\nB';
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': jenny },
      snapshots: { 'sha256:o1': original },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', hunks: hunksFor(original, jenny) }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  diffToolbar(harness).querySelector('[data-ide-diff-hunk-toggle]').click();
  await settle();
  assert.equal(harness.bridge.state.files['src/app.js'], 'a\nb', 'no spurious trailing newline appended');
});

test('per-hunk reject preserves CRLF endings', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\r\nB\r\nc\r\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', hunks: hunksFor('a\nb\nc\n', 'a\nB\nc\n') }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  diffToolbar(harness).querySelector('[data-ide-diff-hunk-toggle]').click();
  await settle();
  assert.equal(harness.bridge.state.files['src/app.js'], 'a\r\nb\r\nc\r\n', 'reject keeps CRLF');
});

/* ------------------------------------------------------------------ */
/* Created-file revert + partial degrade                                */
/* ------------------------------------------------------------------ */

test('reverting a created-file change deletes it through the guarded path, never writes it empty', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'notes.md': 'created by jenny\n' } },
    turnViewModels: [
      buildChangeTurn({ path: 'notes.md', status: 'created', beforeHash: null, additions: 1 }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-revert]').click();
  await settle();
  confirmButton(harness, 'confirm').click();
  await settle();

  assert.equal('notes.md' in harness.bridge.state.files, false, 'created file is removed, not left as an empty file');
  assert.equal(harness.bridge.calls.delete.length, 1, 'the guarded workspace-fs delete path is used');
  assert.equal(harness.bridge.calls.delete[0].path, 'notes.md');
  assert.equal(harness.bridge.calls.writeFile.length, 0, 'a created file is never written empty');
});

test('a partial-review change withholds per-hunk with partial-specific copy', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nB\nc\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({
        path: 'src/app.js',
        beforeHash: 'sha256:o1',
        reviewState: 'partial',
        hunks: hunksFor('a\nb\nc\n', 'a\nB\nc\n'),
      }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  const toolbar = diffToolbar(harness);
  assert.equal(toolbar.querySelector('[data-ide-diff-hunk-toggle]'), null, 'no per-hunk for a partial diff');
  assert.ok(/only part of this change/i.test(toolbar.textContent), 'partial-specific degrade copy');
});

/* ------------------------------------------------------------------ */
/* Concurrency / data-loss guards (review must-fixes)                   */
/* ------------------------------------------------------------------ */

test('revert aborts (no clobber) when the file changes on disk during the confirm prompt', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nB\nc\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', additions: 1, deletions: 1 }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-revert]').click();
  await settle();

  // Simulate an external edit landing while the confirm dialog is open.
  harness.bridge.state.files['src/app.js'] = 'externally edited\n';
  confirmButton(harness, 'confirm').click();
  await settle();

  assert.equal(harness.bridge.calls.writeFile.length, 0, 'the snapshot must not overwrite the external edit');
  assert.equal(harness.bridge.state.files['src/app.js'], 'externally edited\n');
  assert.ok(harness.toasts.some((toast) => /changed on disk/i.test(toast.message)), 'a conflict toast is shown');
});

test('revert approval resolving after dispose does not write the file', async () => {
  let resolveConfirm;
  const writes = [];
  const change = {
    changeId: 'change-1',
    path: 'src/app.js',
    beforeHash: 'sha256:o1',
    status: 'modified',
  };
  const controller = createIdeDiffController({
    getIde: () => ({ activeTabPath: '' }),
    getDom: () => ({}),
    editorHost: { isDirty: () => false },
    getWorkspaceFsApi: () => ({
      readPreChange: async () => ({ found: true, content: 'a\nb\nc\n' }),
      readFile: async () => ({ content: 'a\nB\nc\n', mtimeMs: 111 }),
      writeFile: async (payload) => {
        writes.push(payload);
        return { mtimeMs: 222 };
      },
    }),
    confirmDialog: {
      confirm: () => new Promise((resolve) => {
        resolveConfirm = resolve;
      }),
    },
    callbacks: {
      renderTabs: () => {},
      showShellErrorToast: () => {},
      appendClientLog: () => {},
    },
  });

  const pending = controller.revertChange(change);
  await settle();
  assert.equal(typeof resolveConfirm, 'function', 'the revert is waiting on confirmation');

  controller.dispose();
  resolveConfirm(true);
  const result = await pending;

  assert.equal(result, false);
  assert.deepEqual(writes, [], 'no workspaceFs.writeFile after dispose');
});

test('openChangeDiff resolving after dispose does not open or activate a tab', async () => {
  // openDiffDocument awaits Monaco's first-use lazy script-load; a dispose during
  // that gap must not resurrect tab/context state (mirrors the revert-after-dispose guard).
  let resolveOpen;
  const activated = [];
  const controller = createIdeDiffController({
    getIde: () => ({ openTabs: [], activeTabPath: '' }),
    getDom: () => ({}),
    editorHost: {
      openDiffDocument: () => new Promise((resolve) => {
        resolveOpen = resolve;
      }),
      activateDocument: (id) => { activated.push(id); },
    },
    getWorkspaceFsApi: () => ({
      readFile: async () => ({ content: 'a\nB\nc\n', mtimeMs: 111 }),
      readPreChange: async () => ({ found: true, content: 'a\nb\nc\n' }),
    }),
    callbacks: {
      renderTabs: () => {},
      showShellErrorToast: () => {},
      appendClientLog: () => {},
    },
  });

  const pending = controller.openChangeDiff({
    changeId: 'c1', path: 'src/app.js', beforeHash: 'sha256:o1', status: 'modified',
  });
  await settle();
  assert.equal(typeof resolveOpen, 'function', 'openChangeDiff is waiting on the editor host lazy-load');

  controller.dispose();
  resolveOpen();
  const result = await pending;

  assert.equal(result, false);
  assert.deepEqual(activated, [], 'no activateDocument after dispose');
});

test('openUnsavedCompare resolving after dispose does not open or activate a tab', async () => {
  let resolveOpen;
  const activated = [];
  const controller = createIdeDiffController({
    getIde: () => ({ openTabs: [], activeTabPath: '' }),
    getDom: () => ({}),
    editorHost: {
      hasDocument: () => true,
      getValue: () => 'live buffer\n',
      openDiffDocument: () => new Promise((resolve) => {
        resolveOpen = resolve;
      }),
      activateDocument: (id) => { activated.push(id); },
    },
    getWorkspaceFsApi: () => ({
      readFile: async () => ({ content: 'disk content\n', mtimeMs: 111 }),
    }),
    callbacks: {
      renderTabs: () => {},
      showShellErrorToast: () => {},
      appendClientLog: () => {},
    },
  });

  const pending = controller.openUnsavedCompare('src/app.js');
  await settle();
  assert.equal(typeof resolveOpen, 'function', 'openUnsavedCompare is waiting on the editor host lazy-load');

  controller.dispose();
  resolveOpen();
  const result = await pending;

  assert.equal(result, false);
  assert.deepEqual(activated, [], 'no activateDocument after dispose');
});

test('root reset blocks a deferred diff document from mutating the new root', async () => {
  const gate = deferred();
  const openStarted = deferred();
  const opened = [];
  const activated = [];
  const controller = createIdeDiffController({
    getIde: () => ({ openTabs: [], activeTabPath: '' }),
    getDom: () => ({}),
    editorHost: {
      hasDocument: () => true,
      getValue: () => 'live buffer\n',
      async openDiffDocument(payload) {
        openStarted.resolve();
        await gate.promise;
        if (payload.shouldApply?.() === false) return null;
        opened.push(payload.id);
        return {};
      },
      activateDocument: (id) => activated.push(id),
    },
    getWorkspaceFsApi: () => ({ readFile: async () => ({ content: 'saved\n', mtimeMs: 1 }) }),
  });

  const pending = controller.openUnsavedCompare('same/path.js');
  await openStarted.promise;
  controller.resetForRoot();
  gate.resolve();

  assert.equal(await pending, false);
  assert.deepEqual(opened, []);
  assert.deepEqual(activated, []);
});

test('an old-root diff write finally cannot release the new-root write token', async () => {
  const firstConfirm = deferred();
  const secondConfirm = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  let confirms = 0;
  const api = {
    readFile: async () => ({ content: 'current\n', mtimeMs: 1 }),
    readPreChange: async () => ({ found: true, content: 'before\n' }),
    writeFile: async () => ({ mtimeMs: 2 }),
  };
  const controller = createIdeDiffController({
    getIde: () => ({ openTabs: [], activeTabPath: '' }),
    getDom: () => ({}),
    editorHost: { isDirty: () => false },
    confirmDialog: {
      confirm: () => {
        confirms += 1;
        (confirms === 1 ? firstStarted : secondStarted).resolve();
        return confirms === 1 ? firstConfirm.promise : secondConfirm.promise;
      },
    },
    getWorkspaceFsApi: () => api,
  });
  const change = { changeId: 'c1', path: 'same/path.js', beforeHash: 'sha256:old', status: 'modified' };

  const oldWrite = controller.revertChange(change);
  await firstStarted.promise;
  controller.resetForRoot();
  const newWrite = controller.revertChange({ ...change, changeId: 'c2' });
  await secondStarted.promise;

  firstConfirm.resolve(true);
  assert.equal(await oldWrite, false);
  assert.equal(await controller.revertChange({ ...change, changeId: 'c3' }), false);

  secondConfirm.resolve(false);
  assert.equal(await newWrite, false);
  assert.equal(confirms, 2);
});

test('rapid double-click on a hunk toggle applies exactly one decision (re-entrancy latch)', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nB\nc\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', hunks: hunksFor('a\nb\nc\n', 'a\nB\nc\n') }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  // Two synchronous clicks: the second fires while the first write is in flight
  // and is dropped, so the net effect is a single reject (not a reject+restore).
  const toggle = diffToolbar(harness).querySelector('[data-ide-diff-hunk-toggle]');
  toggle.click();
  toggle.click();
  await settle();

  assert.equal(harness.bridge.calls.writeFile.length, 1, 'only one write despite two clicks');
  assert.equal(harness.bridge.state.files['src/app.js'], 'a\nb\nc\n', 'left in the rejected state');
});

test('per-hunk toggle refuses to clobber an open buffer with unsaved edits', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nB\nc\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', hunks: hunksFor('a\nb\nc\n', 'a\nB\nc\n') }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  // Open the file and make it dirty, then open the change diff and try a toggle.
  await harness.controller.openFile('src/app.js');
  await settle();
  const textarea = harness.getDom().ideEditorFallback;
  textarea.value = 'my own unsaved edits';
  textarea.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  await settle();
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  diffToolbar(harness).querySelector('[data-ide-diff-hunk-toggle]').click();
  await settle();

  assert.equal(harness.bridge.calls.writeFile.length, 0, 'no write while the buffer is dirty');
  assert.ok(harness.toasts.some((toast) => /unsaved edits/i.test(toast.message)), 'prompts to save/discard first');
});

test('a diverged base (disk no longer matches Jenny’s version) withholds per-hunk but keeps revert', async (t) => {
  // The recorded hunks are for a\nb\nc\n -> a\nB\nc\n, but the file on disk has
  // since diverged (a prior partial reject / external edit), so the hunks no
  // longer line up. Per-hunk must be withheld; whole-file revert stays.
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nDIVERGED\nc\n' },
      snapshots: { 'sha256:o1': 'a\nb\nc\n' },
    },
    turnViewModels: [
      buildChangeTurn({ path: 'src/app.js', beforeHash: 'sha256:o1', hunks: hunksFor('a\nb\nc\n', 'a\nB\nc\n') }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  const toolbar = diffToolbar(harness);
  assert.equal(toolbar.querySelector('[data-ide-diff-hunk-toggle]'), null, 'no per-hunk on a diverged base');
  assert.ok(/changed since Jenny/i.test(toolbar.textContent), 'explains the divergence');
  const revert = toolbar.querySelector('[data-ide-diff-revert]');
  assert.ok(revert && !revert.disabled, 'whole-file revert remains available');
});

test('a placeholder (evicted snapshot) change disables revert and per-hunk', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a\nB\nc\n' }, // snapshot absent -> placeholder diff
    },
    turnViewModels: [
      buildChangeTurn({
        path: 'src/app.js',
        beforeHash: 'sha256:gone',
        hunks: hunksFor('a\nb\nc\n', 'a\nB\nc\n'),
      }),
    ],
  });
  t.after(() => harness.dispose());
  await activateChangesPanel(harness);
  harness.getDom().ideRailPanel.querySelector('[data-ide-changes-open]').click();
  await settle();

  const toolbar = diffToolbar(harness);
  assert.equal(toolbar.querySelector('[data-ide-diff-hunk-toggle]'), null, 'no per-hunk on a placeholder diff');
  const revert = toolbar.querySelector('[data-ide-diff-revert]');
  assert.ok(revert, 'a revert button is present');
  assert.ok(revert.disabled, 'but disabled — there is no recoverable original');
});

test('openChangeDiff read failure returns read_failed after its own toast (no caller double-toast)', async () => {
  const toasts = [];
  const controller = createIdeDiffController({
    getIde: () => ({ openTabs: [], activeTabPath: '' }),
    getDom: () => ({}),
    editorHost: {
      openDiffDocument: async () => {},
      activateDocument: () => {},
    },
    getWorkspaceFsApi: () => ({
      readFile: async () => { throw new Error('ENOENT'); },
    }),
    callbacks: {
      renderTabs: () => {},
      showShellErrorToast: (message, options) => { toasts.push({ message, options }); },
      appendClientLog: () => {},
    },
  });

  const result = await controller.openChangeDiff({
    changeId: 'c1', path: 'workspace/hellodemo.md', beforeHash: 'sha256:o1', status: 'modified',
  });

  assert.equal(result, 'read_failed');
  assert.equal(toasts.length, 1, 'exactly one toast for the failed read');
  assert.equal(toasts[0].options.title, "Jenny's Changes");
  assert.match(toasts[0].message, /could not safely read this file/i);
  assert.doesNotMatch(toasts[0].message, /workspace\/hellodemo\.md/);
});

test('openChangeDiff maps unsafe, missing, and ordinary read failures to distinct safe copy', async () => {
  const cases = [
    ['CMP-WORKSPACEFS-0003', /outside the originating workspace/i],
    ['CMP-WORKSPACEFS-0004', /no longer available/i],
    ['CMP-WORKSPACEFS-0022', /could not safely read/i],
  ];
  const messages = [];
  for (const [code, expected] of cases) {
    const controller = createIdeDiffController({
      getIde: () => ({ openTabs: [], activeTabPath: '' }),
      getDom: () => ({}),
      editorHost: { openDiffDocument: async () => {}, activateDocument: () => {} },
      getWorkspaceFsApi: () => ({
        readFile: async () => { const error = new Error('G:/secret/raw/backend detail'); error.code = code; throw error; },
      }),
      callbacks: {
        renderTabs: () => {},
        showShellErrorToast: (message) => messages.push(message),
        appendClientLog: () => {},
      },
    });
    assert.equal(await controller.openChangeDiff({
      changeId: `change:${code}`,
      path: 'src/app.js',
      beforeHash: 'sha256:before',
      status: 'modified',
    }), 'read_failed');
    assert.match(messages.at(-1), expected);
    assert.doesNotMatch(messages.at(-1), /G:\/secret|src\/app\.js/);
  }
  assert.equal(new Set(messages).size, 3);
});

test('openChangeDiff opens a legacy unstamped-workspace change through the snapshot store', async () => {
  const opened = [];
  const toasts = [];
  const controller = createIdeDiffController({
    getIde: () => ({ openTabs: [], activeTabPath: '' }),
    getDom: () => ({}),
    getWorkspaceId: () => `root_${'a'.repeat(24)}`,
    editorHost: {
      openDiffDocument: async (payload) => { opened.push(payload); },
      activateDocument: () => {},
    },
    getWorkspaceFsApi: () => ({
      readFile: async () => ({ content: 'now\n' }),
      readPreChange: async () => ({ found: true, content: 'before\n' }),
    }),
    callbacks: {
      renderTabs: () => {},
      showShellErrorToast: (message) => toasts.push(message),
      appendClientLog: () => {},
    },
  });

  // 'unknown' is the ledger's fallback for changes persisted before the
  // workspace_id stamp existed; the content-addressed snapshot lookup proves
  // the original, so this must open instead of dead-ending.
  const result = await controller.openChangeDiff({
    changeId: 'change:legacy',
    workspaceId: 'unknown',
    path: 'src/app.js',
    beforeHash: 'sha256:before',
    status: 'modified',
  });
  assert.notEqual(result, 'workspace_unavailable');
  assert.deepEqual(toasts, []);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].original, 'before\n');
  assert.equal(opened[0].modified, 'now\n');
  assert.equal(opened[0].placeholderText, '');
});

test('revertChange refuses legacy and mismatched-workspace changes before any write', async () => {
  const toasts = [];
  const writes = [];
  const controller = createIdeDiffController({
    getIde: () => ({ openTabs: [], activeTabPath: '' }),
    getDom: () => ({}),
    getWorkspaceId: () => `root_${'a'.repeat(24)}`,
    editorHost: { isDirty: () => false },
    confirmDialog: { confirm: async () => true },
    getWorkspaceFsApi: () => ({
      readFile: async () => ({ content: 'now\n', mtimeMs: 1 }),
      readPreChange: async () => ({ found: true, content: 'before\n' }),
      writeFile: async (payload) => { writes.push(payload); return { mtimeMs: 2 }; },
    }),
    callbacks: {
      renderTabs: () => {},
      showShellErrorToast: (message) => toasts.push(message),
      appendClientLog: () => {},
    },
  });

  const base = { changeId: 'c1', path: 'src/app.js', beforeHash: 'sha256:before', status: 'modified' };
  assert.equal(await controller.revertChange({ ...base, workspaceId: 'unknown' }), 'workspace_unavailable');
  assert.equal(await controller.revertChange({ ...base, workspaceId: `root_${'b'.repeat(24)}` }), 'workspace_unavailable');
  assert.deepEqual(writes, []);
  assert.equal(toasts.length, 2);
});

test('openChangeDiff refuses a historical change from another workspace before reading', async () => {
  let reads = 0;
  const toasts = [];
  const controller = createIdeDiffController({
    getIde: () => ({ openTabs: [], activeTabPath: '' }),
    getDom: () => ({}),
    getWorkspaceId: () => `root_${'a'.repeat(24)}`,
    editorHost: { openDiffDocument: async () => {}, activateDocument: () => {} },
    getWorkspaceFsApi: () => ({ readFile: async () => { reads += 1; return { content: '' }; } }),
    callbacks: {
      showShellErrorToast: (message) => toasts.push(message),
      appendClientLog: () => {},
    },
  });

  const result = await controller.openChangeDiff({
    changeId: 'change:old',
    workspaceId: `root_${'b'.repeat(24)}`,
    path: 'src/app.js',
    beforeHash: 'sha256:before',
    status: 'modified',
  });
  assert.equal(result, 'workspace_unavailable');
  assert.equal(reads, 0);
  assert.match(toasts[0], /workspace.*not currently available/i);
});
