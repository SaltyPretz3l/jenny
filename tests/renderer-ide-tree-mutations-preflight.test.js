'use strict';

/* IDE-001: a tree delete / rename / move whose close preflight reports
 * `document_changed` (the editor gained newer edits after the user confirmed)
 * must tell the file lifecycle which tabs to PRESERVE, end to end: tree
 * mutations -> tree wrapper -> explorer wiring -> file lifecycle. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTreeMutations } = require('../renderer/features/renderer-ide-tree-mutations');
const { createIdeController } = require('../renderer/features/renderer-ide-controller');
const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');

const CHANGED = {
  committed: false,
  code: 'document_changed',
  changedPath: 'a.js',
  changedPaths: ['a.js', 'dir/b.js'],
  closedPaths: [],
};

function createMutations(overrides = {}) {
  const calls = { deleted: [], renamed: [], logs: [] };
  const api = { delete: async () => ({}), rename: async () => ({}) };
  const mutations = createIdeTreeMutations({
    getApi: () => api,
    getMutationContext: async () => ({ rootId: 'root-test', generation: 1, phase: 'ready' }),
    preflightMutation: async () => ({ ready: true, paths: ['a.js'] }),
    commitMutationPreflight: () => CHANGED,
    cancelMutationPreflight: () => {},
    confirmDelete: async () => true,
    showError: () => {},
    appendClientLog: (level, event, meta) => calls.logs.push({ level, event, meta }),
    getRootEpoch: () => 1,
    getPendingEdit: () => null,
    setPendingEdit: () => {},
    getCommittingEdit: () => null,
    setCommittingEdit: () => {},
    cancelEdit: () => {},
    pruneStaleDirState: () => {},
    refreshDirectory: async () => {},
    onOpenFile: async () => {},
    onEntryDeleted: (...args) => calls.deleted.push(args),
    onEntryRenamed: async (...args) => { calls.renamed.push(args); },
    render: () => {},
    ...overrides,
  });
  return { mutations, calls };
}

const renameEdit = { mode: 'rename', targetPath: 'a.js', dirPath: '', kind: 'file' };

test('delete passes every document_changed path to onEntryDeleted as preservedPaths', async () => {
  const { mutations, calls } = createMutations();
  assert.equal(await mutations.deleteEntry('a.js', 'file', { skipConfirm: true }), true);
  assert.deepEqual(calls.deleted, [['a.js', 'file', { preservedPaths: ['a.js', 'dir/b.js'] }]]);
});

test('preservedPaths falls back to changedPath, and is empty when the commit succeeds', async () => {
  const single = createMutations({
    commitMutationPreflight: () => ({ committed: false, code: 'document_changed', changedPath: 'a.js', closedPaths: [] }),
  });
  await single.mutations.deleteEntry('a.js', 'file', { skipConfirm: true });
  assert.deepEqual(single.calls.deleted[0][2], { preservedPaths: ['a.js'] });

  const clean = createMutations({ commitMutationPreflight: () => ({ committed: true, closedPaths: ['a.js'] }) });
  await clean.mutations.deleteEntry('a.js', 'file', { skipConfirm: true });
  assert.deepEqual(clean.calls.deleted[0][2], { preservedPaths: [] });
});

test('another failed commit code is logged and preserves nothing', async () => {
  const failed = createMutations({
    commitMutationPreflight: () => ({ committed: false, code: 'close_failed', closedPaths: [] }),
  });
  await failed.mutations.deleteEntry('a.js', 'file', { skipConfirm: true });
  assert.deepEqual(failed.calls.deleted[0][2], { preservedPaths: [] });
  assert.deepEqual(failed.calls.logs.filter((entry) => entry.event === 'ide.tree_preflight_commit_failed'), [
    { level: 'WARN', event: 'ide.tree_preflight_commit_failed', meta: { code: 'close_failed' } },
  ]);
});

test('rename passes preservedPaths alongside wasOpen to onEntryRenamed', async () => {
  const { mutations, calls } = createMutations();
  await mutations.commitEdit('b.js', { edit: renameEdit });
  assert.deepEqual(calls.renamed, [['a.js', 'b.js', 'file', { wasOpen: true, preservedPaths: ['a.js', 'dir/b.js'] }]]);
});

test('move passes preservedPaths alongside wasOpen to onEntryRenamed', async () => {
  const { mutations, calls } = createMutations();
  assert.equal(await mutations.moveEntry('a.js', 'dst/a.js', 'file'), true);
  assert.deepEqual(calls.renamed, [['a.js', 'dst/a.js', 'file', { wasOpen: true, preservedPaths: ['a.js', 'dir/b.js'] }]]);
});

// ── End to end through the real controller ───────────────────────────────────

function createControllerHarness({ files }) {
  const { dom, getDom } = buildIdeDom();
  const bridge = createBridgeStub({ files });
  const previousWindow = globalThis.window;
  const previousMonacoUtils = globalThis.rendererMonacoEditorUtils;
  globalThis.window = dom.window;
  dom.window.jennyShell = bridge.jennyShell;
  globalThis.rendererMonacoEditorUtils = {
    ...require('../renderer/features/renderer-monaco-editor-utils'),
    async ensureMonacoEditorApi() { return null; },
    normalizeEditorLanguage: () => 'plaintext',
  };
  const cleanups = [];
  const toasts = [];
  const infoToasts = [];
  const state = { ui: { activeView: 'ide', ide: null } };
  const controller = createIdeController({
    state,
    getDom,
    registerCleanup: (fn) => cleanups.push(fn),
    workspaceRootService: {
      captureContext: async () => ({
        rootPath: 'G:/fake-root', rootId: 'root_fake', generation: 1, phase: 'ready',
      }),
    },
    callbacks: {
      appendClientLog: () => {},
      showShellErrorToast: (message, meta) => toasts.push({ message, meta }),
      showToastMessage: (message, meta) => infoToasts.push({ message, meta }),
      toErrorMessage: (error, fallback) => String(error?.message || fallback || ''),
    },
  });
  return {
    dom, getDom, bridge, controller, state, toasts, infoToasts,
    viewHost: (id) => dom.window.document.getElementById(`wbView-${id}`),
    dispose() {
      for (const cleanup of cleanups.splice(0)) {
        try { cleanup(); } catch (_error) { /* noop */ }
      }
      globalThis.window = previousWindow;
      globalThis.rendererMonacoEditorUtils = previousMonacoUtils;
    },
  };
}

function typeIntoEditor(harness, value) {
  const editor = harness.getDom().ideEditorFallback;
  editor.value = value;
  editor.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
}

function findMenuItem(doc, label) {
  return [...doc.body.querySelectorAll('.inv-context-menu-item')]
    .find((item) => item.textContent.includes(label)) || null;
}

test('end to end: an edit made after the delete confirmation keeps its editor open and stale', async (t) => {
  const harness = createControllerHarness({ files: { 'app.js': 'original' } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('app.js');
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.viewHost('explorer');
  typeIntoEditor(harness, 'edited before the prompt');

  // The user keeps typing while the backend delete is in flight.
  const workspaceFs = harness.bridge.jennyShell.workspaceFs;
  const realDelete = workspaceFs.delete.bind(workspaceFs);
  workspaceFs.delete = async (payload) => {
    typeIntoEditor(harness, 'typed after the confirmation');
    return realDelete(payload);
  };

  panel.querySelector('[data-ide-tree-path="app.js"]').dispatchEvent(new harness.dom.window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 12, clientY: 24,
  }));
  findMenuItem(doc, 'Delete').click();
  await settle();
  doc.querySelector('[data-ide-confirm-action="confirm"]').click();
  await settle();
  doc.querySelector('[data-ide-confirm-action="discard"]').click();
  await settle(40);

  assert.equal(harness.bridge.calls.delete.length, 1, 'the backend delete ran');
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="app.js"]'), 'the edited tab stays open');
  assert.equal(harness.getDom().ideEditorFallback.value, 'typed after the confirmation', 'the newer buffer is intact');
  assert.equal(harness.state.ui.ide.dirtyByPath['app.js'], true);
  assert.equal(harness.state.ui.ide.staleByPath['app.js'], true, 'the tab is marked stale');
  assert.ok(
    harness.infoToasts.some((entry) => entry.message.startsWith('app.js was deleted on disk. Its unsaved editor remains open')),
    'the user is told why the editor stayed open'
  );
});
