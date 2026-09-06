'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTreeImport } = require('../renderer/features/renderer-ide-tree-import');
const treeMarkup = require('../renderer/features/renderer-ide-tree-markup');
const { buildIdeDom, deferred, settle } = require('./helpers/ide-tree-harness');

const TREE_MIME = 'application/x-jenny-tree-path';

function createTransfer(files = [{}], types = ['Files']) {
  return { files, types, dropEffect: '' };
}

function dispatchDrag(harness, target, type, transfer, options = {}) {
  const event = new harness.dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  Object.defineProperty(event, 'relatedTarget', { value: options.relatedTarget || null });
  target.dispatchEvent(event);
  return event;
}

function buildHarness({
  enabled = true,
  attachments = {},
  preview = null,
  confirm = true,
  subscribeError = false,
  rootEpoch = 1,
} = {}) {
  const domHarness = buildIdeDom();
  const panel = domHarness.getDom().ideRailPanel;
  panel.innerHTML = `
    <div class="ide-tree-header"><span class="ide-tree-header-title">Explorer</span></div>
    <div class="ide-tree">
      <div data-ide-tree-path="docs" data-ide-tree-kind="directory"></div>
      <div data-ide-tree-path="docs/readme.md" data-ide-tree-kind="file"></div>
      <div data-ide-tree-path="root.txt" data-ide-tree-kind="file"></div>
    </div>`;
  const importDeferred = deferred();
  const calls = {
    paths: [], preview: [], imports: [], cancels: [], confirms: [], errors: [],
    toasts: [], refreshes: [], reveals: [], selections: [], renders: 0,
    cancelPendingEdit: 0, unsubscribes: 0,
  };
  let progressListener = null;
  let subscribeAttempts = 0;
  let currentRootEpoch = rootEpoch;
  const workspaceFs = {
    async previewImport(payload) {
      calls.preview.push(payload);
      return preview || {
        ok: true,
        totals: { files: 2, directories: 0, bytes: 2048, truncated: false },
        warnings: [],
      };
    },
    importExternal(payload) {
      calls.imports.push(payload);
      return importDeferred.promise;
    },
    async cancelImport(payload) {
      calls.cancels.push(payload);
      return { ok: true, cancelled: true };
    },
    onImportProgress(listener) {
      subscribeAttempts += 1;
      if (subscribeError && subscribeAttempts === 1) throw new Error('subscribe failed');
      progressListener = listener;
      return () => {
        calls.unsubscribes += 1;
        progressListener = null;
      };
    },
  };
  const attachmentsApi = attachments === null ? null : {
    getPathForFile(file) {
      calls.paths.push(file);
      return attachments.getPathForFile?.(file) ?? file.path ?? '';
    },
  };
  const module = createIdeTreeImport({
    getDom: domHarness.getDom,
    getMountEl: () => panel,
    isActivePanel: () => true,
    getIde: () => ({ rootEpoch: currentRootEpoch }),
    getRootEpoch: () => currentRootEpoch,
    isImportEnabled: () => enabled,
    getAttachmentsApi: () => attachmentsApi,
    getWorkspaceFsApi: () => workspaceFs,
    getMutationContext: async () => ({ rootId: 'root-test', generation: 7, phase: 'ready' }),
    confirmImport: async (options) => {
      calls.confirms.push(options);
      return typeof confirm === 'function' ? confirm() : confirm;
    },
    showError: (message, meta) => calls.errors.push({ message, meta }),
    showToast: (message, options) => calls.toasts.push({ message, options }),
    refreshDirectory: async (path) => { calls.refreshes.push(path); },
    revealPath: (path, options) => calls.reveals.push({ path, options }),
    selection: {
      replace(paths, lead) { calls.selections.push({ paths, lead }); },
    },
    render: () => { calls.renders += 1; },
    cancelPendingEdit: () => { calls.cancelPendingEdit += 1; },
    parentDirOf: treeMarkup.parentDirOf,
    nameOf: treeMarkup.nameOf,
  });
  module.bindEvents();
  return {
    ...domHarness,
    panel,
    module,
    calls,
    importDeferred,
    progress(payload) { progressListener?.(payload); },
    getProgressListener() { return progressListener; },
    bumpRootEpoch() { currentRootEpoch += 1; },
    row(path) {
      const result = panel.querySelector(`[data-ide-tree-path="${path}"]`);
      assert.ok(result, `missing row ${path}`);
      return result;
    },
    dispose() {
      module.dispose();
      domHarness.dom.window.close();
    },
  };
}

test('flag off binds no external drop listeners and creates no strip', async (t) => {
  const harness = buildHarness({ enabled: false });
  t.after(() => harness.dispose());
  const event = dispatchDrag(
    harness,
    harness.row('docs'),
    'drop',
    createTransfer([{ path: 'C:/outside/a.txt' }])
  );
  await settle();

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(harness.calls.paths, []);
  assert.equal(harness.panel.querySelector('.ide-tree-import-strip'), null);
});

test('external dragover paints a directory while internal tree drags remain owned by dnd', (t) => {
  const harness = buildHarness();
  t.after(() => harness.dispose());
  const directory = harness.row('docs');
  const transfer = createTransfer();
  const event = dispatchDrag(harness, directory, 'dragover', transfer);

  assert.equal(event.defaultPrevented, true);
  assert.equal(transfer.dropEffect, 'copy');
  assert.equal(directory.classList.contains('ide-tree-row--drop-target'), true);

  dispatchDrag(harness, directory, 'dragleave', transfer);
  const internal = dispatchDrag(
    harness,
    directory,
    'dragover',
    createTransfer([], ['Files', TREE_MIME])
  );
  assert.equal(internal.defaultPrevented, false);
  assert.equal(directory.classList.contains('ide-tree-row--drop-target'), false);
});

test('drop imports into a directory, paints progress, and settles all imported roots', async (t) => {
  const first = { path: 'C:/outside/a.txt' };
  const second = { path: 'C:/outside/b.txt' };
  const harness = buildHarness();
  t.after(() => harness.dispose());
  const event = dispatchDrag(
    harness,
    harness.row('docs'),
    'drop',
    createTransfer([first, second])
  );
  await settle();

  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.calls.cancelPendingEdit, 1);
  assert.deepEqual(harness.calls.paths, [first, second]);
  assert.deepEqual(harness.calls.preview, [{ sources: [first.path, second.path] }]);
  assert.equal(harness.calls.imports.length, 1);
  assert.deepEqual(harness.calls.imports[0], {
    importId: harness.calls.imports[0].importId,
    sources: [first.path, second.path],
    destination: 'docs',
    onCollision: 'auto-rename',
    expectedGeneration: 7,
  });
  assert.match(harness.calls.imports[0].importId, /^import-\d+-1$/);

  harness.progress({
    import_id: harness.calls.imports[0].importId,
    phase: 'copying',
    completed_files: 1,
    total_files: 2,
    current_name: 'a.txt',
    percent: 50,
    terminal: false,
  });
  const strip = harness.panel.querySelector('.ide-tree-import-strip');
  assert.ok(strip);
  assert.match(strip.textContent, /Importing… 1\/2 · a\.txtCancel/);
  assert.equal(strip.style.getPropertyValue('--ide-tree-import-progress'), '50%');

  harness.progress({
    import_id: harness.calls.imports[0].importId,
    phase: 'done', completed_files: 2, total_files: 2, percent: 100, terminal: true,
  });
  harness.importDeferred.resolve({
    ok: true,
    imported: [{ path: 'docs/a.txt', kind: 'file' }, { path: 'docs/b.txt', kind: 'file' }],
    skipped: [{ source: second.path, code: 'copy_failed' }],
    totals: { files: 2, directories: 0, bytes: 20 },
  });
  await settle(20);

  assert.equal(harness.panel.querySelector('.ide-tree-import-strip'), null);
  assert.deepEqual(harness.calls.refreshes, ['docs']);
  assert.equal(harness.calls.renders, 1);
  assert.deepEqual(harness.calls.selections, [{
    paths: ['docs/a.txt', 'docs/b.txt'], lead: 'docs/a.txt',
  }]);
  assert.deepEqual(harness.calls.reveals, [{ path: 'docs/a.txt', options: { focus: false } }]);
  assert.equal(harness.calls.toasts[0].message, 'Imported 2 items, 1 skipped');
  assert.equal(harness.calls.unsubscribes, 1);
});

test('sensitive preview requires confirmation and threads allowSensitive only on acceptance', async (t) => {
  const preview = {
    ok: true,
    totals: { files: 3, directories: 1, bytes: 5 * 1024 * 1024, truncated: false },
    warnings: [{ code: 'sensitive_source', name: '.env' }],
  };
  const declined = buildHarness({ preview, confirm: false });
  t.after(() => declined.dispose());
  dispatchDrag(
    declined,
    declined.row('docs'),
    'drop',
    createTransfer([{ path: 'C:/outside/.env' }])
  );
  await settle(20);
  assert.equal(declined.calls.confirms.length, 1);
  assert.equal(declined.calls.confirms[0].sensitive, true);
  assert.match(declined.calls.confirms[0].message, /3 files \/ 5\.0 MB/);
  assert.match(declined.calls.confirms[0].message, /includes sensitive-looking items/);
  assert.match(declined.calls.confirms[0].message, /\.env/);
  assert.deepEqual(declined.calls.imports, []);

  const accepted = buildHarness({ preview, confirm: true });
  t.after(() => accepted.dispose());
  dispatchDrag(
    accepted,
    accepted.row('docs'),
    'drop',
    createTransfer([{ path: 'C:/outside/.env' }])
  );
  await settle(20);
  assert.equal(accepted.calls.imports.length, 1);
  assert.equal(accepted.calls.imports[0].allowSensitive, true);
  assert.equal('allowLargeTree' in accepted.calls.imports[0], false);
  accepted.importDeferred.resolve({ ok: true, imported: [], skipped: [], totals: {} });
});

test('truncated preview states lower bounds and grants large-tree consent only after acceptance', async (t) => {
  const harness = buildHarness({
    preview: {
      ok: true,
      totals: { files: 12, directories: 2, bytes: 3 * 1024 * 1024, truncated: true },
      warnings: [],
    },
    confirm: true,
  });
  t.after(() => harness.dispose());
  dispatchDrag(
    harness,
    harness.row('docs'),
    'drop',
    createTransfer([{ path: 'C:/outside/large-tree' }])
  );
  await settle(20);

  assert.match(
    harness.calls.confirms[0].message,
    /more than 12 files \/ more than 3\.0 MB \(the preview was cut short\)/
  );
  assert.equal(harness.calls.imports[0].allowLargeTree, true);
  harness.importDeferred.resolve({ ok: true, imported: [], skipped: [], totals: {} });
});

test('progress keepalive restores a re-rendered strip with the latest scanning status', async (t) => {
  const harness = buildHarness();
  t.after(() => harness.dispose());
  dispatchDrag(
    harness,
    harness.row('docs'),
    'drop',
    createTransfer([{ path: 'C:/outside/tree' }])
  );
  await settle(20);
  const importId = harness.calls.imports[0].importId;
  harness.progress({
    import_id: importId,
    phase: 'scanning', completed_files: 4, total_files: 0, current_name: 'fourth.js', percent: 0,
  });
  const header = harness.panel.querySelector('.ide-tree-header');
  header.replaceChildren(header.ownerDocument.createElement('span'));

  await settle(340);
  const restored = harness.panel.querySelector('.ide-tree-import-strip');
  assert.ok(restored);
  assert.match(restored.textContent, /Scanning… 4 found · fourth\.jsCancel/);
  harness.importDeferred.resolve({ ok: true, imported: [], skipped: [], totals: {} });
});

test('a synchronous progress-subscription failure resets the active import latch', async (t) => {
  const harness = buildHarness({ subscribeError: true });
  t.after(() => harness.dispose());
  const transfer = createTransfer([{ path: 'C:/outside/a.txt' }]);
  dispatchDrag(harness, harness.row('docs'), 'drop', transfer);
  await settle(20);
  assert.equal(harness.calls.imports.length, 0);
  assert.match(harness.calls.errors[0].message, /subscribe failed/);

  dispatchDrag(harness, harness.row('docs'), 'drop', transfer);
  await settle(20);
  assert.equal(harness.calls.imports.length, 1);
  harness.importDeferred.resolve({ ok: true, imported: [], skipped: [], totals: {} });
});

test('two drops in the same tick claim one import preview latch', async (t) => {
  const harness = buildHarness();
  t.after(() => harness.dispose());
  const transfer = createTransfer([{ path: 'C:/outside/a.txt' }]);

  dispatchDrag(harness, harness.row('docs'), 'drop', transfer);
  dispatchDrag(harness, harness.row('docs'), 'drop', transfer);
  await settle(20);

  assert.equal(harness.calls.preview.length, 1);
  assert.equal(harness.calls.imports.length, 1);
  harness.importDeferred.resolve({ ok: true, imported: [], skipped: [], totals: {} });
});

test('a root swap during import confirmation releases the latch without importing', async (t) => {
  let harness;
  harness = buildHarness({
    preview: {
      ok: true,
      totals: { files: 1, directories: 0, bytes: 1, truncated: false },
      warnings: [{ code: 'sensitive_source', name: '.env' }],
    },
    confirm: () => {
      harness.bumpRootEpoch();
      return true;
    },
  });
  t.after(() => harness.dispose());
  const transfer = createTransfer([{ path: 'C:/outside/.env' }]);

  dispatchDrag(harness, harness.row('docs'), 'drop', transfer);
  await settle(20);
  assert.deepEqual(harness.calls.imports, []);

  dispatchDrag(harness, harness.row('docs'), 'drop', transfer);
  await settle(20);
  assert.equal(harness.calls.preview.length, 2);
});

test('cancel control invokes cancelImport and cancelled terminal reports kept files', async (t) => {
  const harness = buildHarness();
  t.after(() => harness.dispose());
  dispatchDrag(
    harness,
    harness.row('docs'),
    'drop',
    createTransfer([{ path: 'C:/outside/tree' }])
  );
  await settle(20);
  const importId = harness.calls.imports[0].importId;
  harness.progress({
    import_id: importId,
    phase: 'copying', completed_files: 3, total_files: 8, current_name: 'third.js', percent: 37,
  });
  harness.panel.querySelector('.ide-tree-import-strip-cancel').click();
  await settle();
  assert.deepEqual(harness.calls.cancels, [{ importId }]);

  harness.progress({
    import_id: importId,
    phase: 'cancelled', completed_files: 3, total_files: 8, percent: 37, terminal: true,
  });
  harness.importDeferred.resolve({
    ok: true, cancelled: true, imported: [{ path: 'docs/tree', kind: 'directory' }],
    skipped: [], totals: { files: 3, directories: 1, bytes: 30 },
  });
  await settle(20);

  assert.deepEqual(harness.calls.refreshes, ['docs']);
  assert.equal(harness.calls.toasts[0].message, 'Import cancelled — kept 3 of 8');
});

test('missing attachments bridge reports one bounded error and never calls import APIs', async (t) => {
  const harness = buildHarness({ attachments: null });
  t.after(() => harness.dispose());
  dispatchDrag(
    harness,
    harness.row('docs'),
    'drop',
    createTransfer([{ path: 'C:/outside/a.txt' }])
  );
  await settle(20);

  assert.deepEqual(harness.calls.errors, [{
    message: 'Imported files could not be resolved to disk paths.',
    meta: { dedupeKey: 'ide:tree:import' },
  }]);
  assert.deepEqual(harness.calls.preview, []);
  assert.deepEqual(harness.calls.imports, []);
});

test('dispose mid-import unsubscribes, removes the strip, and fences late progress', async (t) => {
  const harness = buildHarness();
  t.after(() => harness.dispose());
  dispatchDrag(
    harness,
    harness.row('docs'),
    'drop',
    createTransfer([{ path: 'C:/outside/a.txt' }])
  );
  await settle(20);
  const importId = harness.calls.imports[0].importId;
  harness.progress({
    import_id: importId,
    phase: 'copying', completed_files: 1, total_files: 2, current_name: 'a.txt', percent: 50,
  });
  const lateProgress = harness.getProgressListener();
  assert.ok(harness.panel.querySelector('.ide-tree-import-strip'));

  harness.module.dispose();
  assert.equal(harness.calls.unsubscribes, 1);
  assert.equal(harness.panel.querySelector('.ide-tree-import-strip'), null);
  lateProgress({
    import_id: importId,
    phase: 'done', completed_files: 2, total_files: 2, current_name: 'b.txt', percent: 100,
  });
  harness.importDeferred.resolve({
    ok: true, imported: [{ path: 'docs/a.txt', kind: 'file' }], skipped: [], totals: {},
  });
  await settle(20);

  assert.equal(harness.panel.querySelector('.ide-tree-import-strip'), null);
  assert.deepEqual(harness.calls.refreshes, []);
  assert.deepEqual(harness.calls.toasts, []);
});
