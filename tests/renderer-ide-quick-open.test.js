'use strict';

/* W6 Quick Open: Ctrl+P overlay over the editor stage - fuzzy filter via the
 * command palette scorer, keyboard selection, Enter/click open, Escape close.
 * Runs on the shared jsdom harness (fallback editor path). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createHarness,
  settle,
} = require('./helpers/renderer-ide-harness');

const { createIdeQuickOpen } = require('../renderer/features/renderer-ide-quick-open');

const FILES = {
  'src/app.js': '1',
  'src/deep/util.js': '2',
  'README.md': '3',
  'styles/main.css': '4',
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function pressCtrlP(harness) {
  harness.getDom().ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'p',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  }));
}

function overlay(harness) {
  return harness.getDom().ideEditorStage.querySelector('.ide-quick-open');
}

function input(harness) {
  return overlay(harness)?.querySelector('[data-ide-quick-open-input]') || null;
}

function rowPaths(harness) {
  return [...overlay(harness).querySelectorAll('[data-ide-quick-open-path]')]
    .map((row) => row.dataset.ideQuickOpenPath);
}

function pressInputKey(harness, key) {
  input(harness).dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  }));
}

function typeQuery(harness, value) {
  const field = input(harness);
  field.value = value;
  field.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
}

test('Ctrl+P opens the picker listing workspace files; Escape closes', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  pressCtrlP(harness);
  await settle();
  assert.ok(overlay(harness), 'overlay created');
  assert.equal(overlay(harness).classList.contains('hidden'), false);
  assert.equal(harness.bridge.calls.listAllFiles.length, 1, 'file list fetched once');
  assert.deepEqual(rowPaths(harness), Object.keys(FILES).sort());

  pressInputKey(harness, 'Escape');
  assert.equal(overlay(harness).classList.contains('hidden'), true);

  // Re-opening reuses the cache.
  pressCtrlP(harness);
  await settle();
  assert.equal(harness.bridge.calls.listAllFiles.length, 1, 'cache reused');
});

test('invalidating Quick Open prevents an old-root listing from replacing the new-root cache', async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="stage"></div></body>');
  const stage = dom.window.document.getElementById('stage');
  const oldRoot = deferred();
  const newRoot = deferred();
  let calls = 0;
  const quickOpen = createIdeQuickOpen({
    getDom: () => ({ ideEditorStage: stage }),
    callbacks: {
      getWorkspaceFsApi: () => ({
        listAllFiles: () => (++calls === 1 ? oldRoot.promise : newRoot.promise),
      }),
    },
  });
  t.after(() => quickOpen.dispose());

  quickOpen.toggle();
  await Promise.resolve();
  assert.equal(calls, 1);
  quickOpen.invalidate();
  quickOpen.toggle();
  quickOpen.toggle();
  await Promise.resolve();
  assert.equal(calls, 2);

  newRoot.resolve({ files: ['new/root.js'], truncated: false });
  await settle();
  const paths = () => [...stage.querySelectorAll('[data-ide-quick-open-path]')]
    .map((row) => row.dataset.ideQuickOpenPath);
  assert.deepEqual(paths(), ['new/root.js']);

  oldRoot.resolve({ files: ['old/root.js'], truncated: false });
  await settle();
  assert.deepEqual(paths(), ['new/root.js']);
});

// ── WIDE-026: change-batch cache invalidation + failure/backoff handling ─────
//
// Direct construction (not the harness) so each test controls listAllFiles'
// success/failure and an injected `now` drives the bounded retry backoff
// deterministically (no real timers).

function buildQuickOpenWithFsControl(files) {
  const dom = new JSDOM('<!doctype html><body><div id="stage"></div></body>');
  const stage = dom.window.document.getElementById('stage');
  const calls = { listAllFiles: 0 };
  const control = { failNext: false, clock: 0 };
  const quickOpen = createIdeQuickOpen({
    getDom: () => ({ ideEditorStage: stage }),
    now: () => control.clock,
    callbacks: {
      getWorkspaceFsApi: () => ({
        async listAllFiles() {
          calls.listAllFiles += 1;
          if (control.failNext) {
            control.failNext = false;
            throw new Error('listAllFiles unavailable');
          }
          return { files: files.slice(), truncated: false };
        },
      }),
    },
  });
  return { dom, stage, quickOpen, calls, control };
}

function filePaths(ctx) {
  return [...ctx.stage.querySelectorAll('[data-ide-quick-open-path]')]
    .map((row) => row.dataset.ideQuickOpenPath);
}

test('WIDE-026: a complete watcher batch (create/rename/delete) updates the cached list, no re-fetch', async (t) => {
  const files = ['a.js', 'b.js'];
  const ctx = buildQuickOpenWithFsControl(files);
  t.after(() => ctx.quickOpen.dispose());
  ctx.quickOpen.toggle();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 1);
  assert.deepEqual(filePaths(ctx).sort(), ['a.js', 'b.js']);
  ctx.quickOpen.toggle();

  // c.js created; a.js deleted; b.js "renamed" to d.js (a delete + a changed in
  // the same batch, mirroring how the watcher reports a rename).
  ctx.quickOpen.handleExternalChanges([
    { relPath: 'c.js', kind: 'changed' },
    { relPath: 'a.js', kind: 'deleted' },
    { relPath: 'b.js', kind: 'deleted' },
    { relPath: 'd.js', kind: 'changed' },
  ], { truncated: false });

  ctx.quickOpen.toggle();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 1, 'the batch patched the live cache in place - no re-fetch needed');
  assert.deepEqual(filePaths(ctx).sort(), ['c.js', 'd.js']);
});

test('WIDE-026: a complete batch arriving while a fetch is in flight is applied once it resolves', async (t) => {
  const files = ['a.js'];
  const ctx = buildQuickOpenWithFsControl(files);
  t.after(() => ctx.quickOpen.dispose());
  ctx.quickOpen.toggle(); // kicks off the first fetch (unresolved microtask so far)
  // A batch lands before the in-flight fetch's promise has settled.
  ctx.quickOpen.handleExternalChanges([{ relPath: 'b.js', kind: 'changed' }], { truncated: false });
  await settle();
  assert.equal(ctx.calls.listAllFiles, 1);
  assert.deepEqual(filePaths(ctx).sort(), ['a.js', 'b.js'], 'the in-flight fetch merged the queued change on resolve');
});

test('WIDE-026: a truncated watcher batch fully invalidates the cache (next open re-fetches)', async (t) => {
  const files = ['a.js'];
  const ctx = buildQuickOpenWithFsControl(files);
  t.after(() => ctx.quickOpen.dispose());
  ctx.quickOpen.toggle();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 1);
  ctx.quickOpen.toggle();

  files.push('b.js'); // the workspace changed underneath the "too much to reconcile" batch
  ctx.quickOpen.handleExternalChanges([], { truncated: true });

  ctx.quickOpen.toggle();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 2, 'a truncated batch forces a fresh authoritative fetch');
  assert.deepEqual(filePaths(ctx).sort(), ['a.js', 'b.js']);
});

test('WIDE-026: a transient list failure is not cached; a later open (past backoff) retries and recovers', async (t) => {
  const files = ['a.js'];
  const ctx = buildQuickOpenWithFsControl(files);
  t.after(() => ctx.quickOpen.dispose());
  ctx.control.failNext = true;
  ctx.quickOpen.toggle();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 1);
  assert.deepEqual(filePaths(ctx), [], 'no files listed after a failed fetch');
  assert.match(ctx.stage.textContent, /Could not load workspace files/i);
  ctx.quickOpen.toggle();

  ctx.control.clock += 5000; // past the bounded backoff window
  ctx.quickOpen.toggle();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 2, 'the next open retried - the failure was never cached as an empty success');
  assert.deepEqual(filePaths(ctx), ['a.js'], 'the retry recovered the real list');
});

test('WIDE-026: a reopen immediately after a failure is backed off (no retry storm)', async (t) => {
  const files = ['a.js'];
  const ctx = buildQuickOpenWithFsControl(files);
  t.after(() => ctx.quickOpen.dispose());
  ctx.control.failNext = true;
  ctx.quickOpen.toggle();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 1);
  ctx.quickOpen.toggle();

  ctx.quickOpen.toggle(); // same simulated instant - well inside the backoff window
  await settle();
  assert.equal(ctx.calls.listAllFiles, 1, 'a rapid reopen inside the backoff window does not hammer the bridge');

  ctx.control.clock += 5000;
  ctx.quickOpen.toggle();
  ctx.quickOpen.toggle();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 2, 'once the backoff window passes, the next open retries normally');
});

test('WIDE-026: dispose invalidates so a batch delivered afterward cannot resurrect a stale cache', async (t) => {
  const files = ['a.js'];
  const ctx = buildQuickOpenWithFsControl(files);
  ctx.quickOpen.toggle();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 1);
  ctx.quickOpen.dispose();

  // Nothing should throw, and a stray post-dispose batch must not resurface a
  // deleted-then-reopened cache with a stale entry.
  assert.doesNotThrow(() => ctx.quickOpen.handleExternalChanges([{ relPath: 'b.js', kind: 'changed' }], { truncated: false }));
  ctx.quickOpen.toggle();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 2, 'dispose invalidated the cache - reopening after it always re-fetches');
});

test('WIDE-026 (controller wiring): a workspace-root switch invalidates the Quick Open cache', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  pressCtrlP(harness);
  await settle();
  assert.equal(harness.bridge.calls.listAllFiles.length, 1, 'cache warmed on first open');
  pressInputKey(harness, 'Escape');

  harness.bridge.state.files = { 'new-root-file.js': '1' };
  harness.bridge.state.rootPath = 'G:/new-root';
  harness.bridge.state.rootGeneration = 2;
  await harness.controller.handleWorkspaceRootCommitted({
    context: { rootPath: 'G:/new-root', rootId: 'root_fake', generation: 2, phase: 'ready' },
  });
  await settle();

  pressCtrlP(harness);
  await settle();
  assert.equal(harness.bridge.calls.listAllFiles.length, 2, 'root switch invalidated the cache - the reopen re-fetches');
  assert.deepEqual(rowPaths(harness), ['new-root-file.js'], 'the new root\'s file list is what re-fetched');
});

test('WIDE-026 (controller wiring): disposing the IDE stops forwarding watcher batches to Quick Open', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  await harness.controller.activateIde();
  await settle();
  pressCtrlP(harness);
  await settle();
  assert.equal(harness.bridge.calls.listAllFiles.length, 1);
  pressInputKey(harness, 'Escape');

  harness.dispose();
  assert.equal(harness.bridge.changeListenerCount, 0, 'dispose unsubscribed the watcher forward entirely');
});

test('typing filters fuzzily and Enter opens the selected file', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  pressCtrlP(harness);
  await settle();

  typeQuery(harness, 'util');
  assert.deepEqual(rowPaths(harness), ['src/deep/util.js']);
  assert.ok(
    overlay(harness).querySelector('.ide-quick-open-path mark'),
    'match ranges highlighted'
  );

  pressInputKey(harness, 'Enter');
  await settle();
  assert.equal(overlay(harness).classList.contains('hidden'), true);
  assert.equal(harness.state.ui.ide.activeTabPath, 'src/deep/util.js');
});

test('arrow keys move the selection; click opens a row', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  pressCtrlP(harness);
  await settle();

  const first = rowPaths(harness)[0];
  assert.equal(
    overlay(harness).querySelector('.ide-quick-open-row--selected').dataset.ideQuickOpenPath,
    first
  );
  pressInputKey(harness, 'ArrowDown');
  assert.equal(
    overlay(harness).querySelector('.ide-quick-open-row--selected').dataset.ideQuickOpenPath,
    rowPaths(harness)[1]
  );
  pressInputKey(harness, 'ArrowUp');
  pressInputKey(harness, 'ArrowUp');
  assert.equal(
    overlay(harness).querySelector('.ide-quick-open-row--selected').dataset.ideQuickOpenPath,
    rowPaths(harness).at(-1),
    'selection wraps upward'
  );

  overlay(harness).querySelector('[data-ide-quick-open-path="README.md"]').click();
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'README.md');
  assert.equal(overlay(harness).classList.contains('hidden'), true);
});

// ── ":line" navigation + Ctrl+E recent list (direct module, stub callbacks) ───

function buildQuickOpen(files) {
  const dom = new JSDOM('<!doctype html><body><div id="stage"></div></body>');
  const stage = dom.window.document.getElementById('stage');
  const recent = { files: [] };
  const calls = { open: [], openAt: [], log: [] };
  const quickOpen = createIdeQuickOpen({
    getDom: () => ({ ideEditorStage: stage }),
    callbacks: {
      getWorkspaceFsApi: () => ({
        async listAllFiles() { return { files: files.slice(), truncated: false }; },
      }),
      onOpenFile: (path) => calls.open.push(path),
      onOpenFileAtLine: (path, line, column) => calls.openAt.push({ path, line, column }),
      getRecentFiles: () => recent.files.slice(),
      appendClientLog: (level, code, meta) => calls.log.push({ level, code, meta }),
    },
  });
  return { dom, stage, quickOpen, calls, recent };
}

function fieldFor(stage, selector) {
  return stage.querySelector(selector);
}

function typeQueryInto(ctx, selector, value) {
  const field = fieldFor(ctx.stage, selector);
  field.value = value;
  field.dispatchEvent(new ctx.dom.window.Event('input', { bubbles: true }));
}

function submitQuery(ctx, selector, value) {
  typeQueryInto(ctx, selector, value);
  fieldFor(ctx.stage, selector).dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
}

test('Quick Open ":line" suffix reveals the line on accept', async () => {
  const ctx = buildQuickOpen(['foo.js', 'bar.js']);
  ctx.quickOpen.toggle();
  await settle();

  // "foo.js:42" opens foo.js then reveals line 42 (column defaults to 1).
  submitQuery(ctx, '[data-ide-quick-open-input]', 'foo.js:42');
  assert.deepEqual(ctx.calls.openAt, [{ path: 'foo.js', line: 42, column: 1 }]);
  assert.deepEqual(ctx.calls.open, [], 'no plain open when a line is present');

  // "foo.js:42:5" carries the column through too.
  ctx.quickOpen.toggle();
  await settle();
  submitQuery(ctx, '[data-ide-quick-open-input]', 'foo.js:42:5');
  assert.deepEqual(ctx.calls.openAt.at(-1), { path: 'foo.js', line: 42, column: 5 });

  // A bare ":42" jumps within the open file: path '' and no plain open.
  ctx.quickOpen.toggle();
  await settle();
  submitQuery(ctx, '[data-ide-quick-open-input]', ':42');
  assert.deepEqual(ctx.calls.openAt.at(-1), { path: '', line: 42, column: 1 });
  assert.deepEqual(ctx.calls.open, [], 'bare :line never opens a different file');
});

test('a bare ":42" lists no files and hints the current-file jump', async () => {
  const ctx = buildQuickOpen(['foo.js', 'bar.js']);
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', ':42');
  const overlayEl = ctx.stage.querySelector('.ide-quick-open');
  assert.equal(
    overlayEl.querySelectorAll('[data-ide-quick-open-path]').length,
    0,
    'no file rows for a bare line query (nothing to mislead the selection)'
  );
  assert.match(overlayEl.textContent, /go to line 42 in the current file/i);
});

test('Quick Open without a ":line" still opens by plain path', async () => {
  const ctx = buildQuickOpen(['foo.js', 'bar.js']);
  ctx.quickOpen.toggle();
  await settle();
  submitQuery(ctx, '[data-ide-quick-open-input]', 'bar.js');
  assert.deepEqual(ctx.calls.open, ['bar.js']);
  assert.deepEqual(ctx.calls.openAt, [], 'no reveal callback without a line');
});

test('Ctrl+E recent picker lists files in MRU order and opens on accept', async () => {
  const ctx = buildQuickOpen(['a.js', 'b.js', 'c.js']);
  // Activation order, most-recent first (what the controller's getRecentFiles
  // returns from its runtime MRU).
  ctx.recent.files = ['c.js', 'a.js', 'b.js'];

  ctx.quickOpen.toggleRecent();
  await settle();
  const overlayEl = ctx.stage.querySelector('.ide-recent-files');
  assert.ok(overlayEl && !overlayEl.classList.contains('hidden'), 'recent overlay opens');
  const rows = [...overlayEl.querySelectorAll('[data-ide-recent-files-path]')]
    .map((row) => row.dataset.ideRecentFilesPath);
  assert.deepEqual(rows, ['c.js', 'a.js', 'b.js'], 'MRU order preserved (no re-sort)');

  submitQuery(ctx, '[data-ide-recent-files-input]', '');
  assert.deepEqual(ctx.calls.open, ['c.js'], 'Enter opens the most-recent file');
  assert.deepEqual(ctx.calls.openAt, [], 'recent picker never reveals a line');
});

// ── "@symbol" suffix: active-file symbol mode (stubbed worker, jsdom-safe) ────
//
// jsdom has no TS worker, so the live worker call is covered by a CDP smoke
// (tests/gui-smoke/ide-symbol-nav.smoke.js). Here we stub the window globals the
// @-mode reaches - window.rendererIdeSymbolNav (its pure helpers), a fake
// active-editor reader, and a fake window.monaco - so the branch logic, ranking,
// degradation, and selection wiring are all exercised deterministically.

const realSymbolNav = require('../renderer/features/renderer-ide-symbol-nav');

// The flat symbol list the stubbed flattenNavigationTree returns (the @-mode
// fetch enriches each with the active path + model.getPositionAt(offset)).
const SYMBOL_FLAT = [
  { name: 'Greeter', kind: 'class', container: '', offset: 0 },
  { name: 'greet', kind: 'method', container: 'Greeter', offset: 25 },
  { name: 'helloMessage', kind: 'function', container: '', offset: 120 },
];
const POSITION_BY_OFFSET = {
  0: { lineNumber: 1, column: 1 },
  25: { lineNumber: 2, column: 3 },
  60: { lineNumber: 4, column: 5 },
  120: { lineNumber: 7, column: 1 },
};

// Drain a bounded number of microtask turns. Unlike settle(), this never blocks
// on a parked manualWorker call, so a test can step a gated fetch one stage at a
// time and observe the in-between state.
async function microtasks(turns = 16) {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

// Install the window globals the @-mode reads, returning a worker-call spy and a
// restore() that puts the prior globals back (so the symbol tests can't pollute
// the harness-based tests above). Must run BEFORE createIdeQuickOpen so the
// module resolves the stubbed rendererIdeSymbolNav at construct time.
function installSymbolGlobals(opts = {}) {
  // Mutable so a test can simulate the active file changing mid-fetch.
  const state = {
    path: opts.path || 'greeter.ts',
    language: opts.language || 'typescript',
  };
  const flat = opts.flat || SYMBOL_FLAT;
  const noMonaco = opts.noMonaco === true;
  // flattenCalls probes the post-worker enrich path: the stale guard returns
  // BEFORE flattenNavigationTree, so a discarded fetch never increments it.
  const spy = { workerCalls: 0, flattenCalls: 0 };
  // Parked resolvers for manualWorker mode (each getNavigationTree call awaits
  // one); releaseWorker() resolves the oldest so a test can step the fetch.
  const workerQueue = [];

  const hadMonaco = Object.prototype.hasOwnProperty.call(globalThis, 'monaco');
  const prior = {
    symbolNav: globalThis.rendererIdeSymbolNav,
    reader: globalThis.rendererIdeActiveEditorReader,
    monaco: globalThis.monaco,
  };

  globalThis.rendererIdeSymbolNav = {
    // Ignore the (fake) tree and return a controlled flat list; rank with the
    // REAL ranker so filtering/ordering (and the kindLabel mapping) is faithful.
    flattenNavigationTree: () => { spy.flattenCalls += 1; return flat.slice(); },
    rankSymbols: realSymbolNav.rankSymbols,
  };
  globalThis.rendererIdeActiveEditorReader = {
    getActivePath: () => state.path,
    getActiveLanguageId: () => state.language,
  };
  if (noMonaco) {
    delete globalThis.monaco;
  } else {
    const model = {
      uri: { toString: () => `jenny-workspace:/${state.path}` },
      getLanguageId: () => state.language,
      isDisposed: () => false,
      getPositionAt: (offset) => {
        // Simulate one symbol whose offset is past EOF: getPositionAt throws and
        // the enrich loop must keep the 1:1 fallback for it without aborting.
        if (opts.throwPositionAtOffset != null && offset === opts.throwPositionAtOffset) {
          throw new Error(`getPositionAt(${offset}) is past end-of-file`);
        }
        return POSITION_BY_OFFSET[offset] || { lineNumber: 1, column: 1 };
      },
    };
    globalThis.monaco = {
      Uri: { parse: (value) => ({ toString: () => value, path: `/${String(value).split(':/')[1] || ''}` }) },
      editor: { getModel: () => model },
      languages: {
        typescript: {
          async getTypeScriptWorker() {
            return async () => ({
              async getNavigationTree() {
                spy.workerCalls += 1;
                // Optional gate: park here so a test can observe / mutate state
                // (e.g. flip the active path) while this fetch is in flight.
                if (opts.manualWorker) {
                  await new Promise((resolve) => { workerQueue.push(resolve); });
                }
                if (opts.throwWorker) {
                  throw new Error('TS worker getNavigationTree failed');
                }
                return { kind: 'module', text: '', childItems: [] };
              },
            });
          },
        },
      },
    };
  }

  const restore = () => {
    globalThis.rendererIdeSymbolNav = prior.symbolNav;
    globalThis.rendererIdeActiveEditorReader = prior.reader;
    if (hadMonaco) {
      globalThis.monaco = prior.monaco;
    } else {
      delete globalThis.monaco;
    }
  };
  return {
    spy,
    restore,
    // Simulate the user switching the active editor file.
    setActivePath: (nextPath, nextLanguage) => {
      state.path = nextPath;
      if (nextLanguage) { state.language = nextLanguage; }
    },
    // Resolve the oldest parked worker call (manualWorker mode); returns whether
    // one was actually pending.
    releaseWorker: () => {
      const resolve = workerQueue.shift();
      if (resolve) { resolve(); return true; }
      return false;
    },
    pendingWorkers: () => workerQueue.length,
  };
}

function symbolRowsEl(ctx) {
  const overlayEl = ctx.stage.querySelector('.ide-quick-open');
  return [...overlayEl.querySelectorAll('.ide-quick-open-symbol-row')];
}

function symbolRows(ctx) {
  return symbolRowsEl(ctx).map((row) => ({
    name: row.querySelector('.ide-quick-open-name')?.textContent || '',
    kind: row.querySelector('.ide-symbol-open-kind')?.textContent || '',
    path: row.dataset.ideQuickOpenPath,
    line: Number(row.dataset.ideQuickOpenLine),
    col: Number(row.dataset.ideQuickOpenCol),
  }));
}

test('Quick Open "@" lists the active file symbols (runs before :line parsing)', async (t) => {
  const { restore } = installSymbolGlobals();
  const ctx = buildQuickOpen([]);
  t.after(() => { ctx.quickOpen.dispose(); restore(); });
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@');
  await settle();
  const rows = symbolRows(ctx);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Greeter', 'greet', 'helloMessage'],
    '"@" with no query lists ALL active-file symbols in stable order'
  );
  assert.ok(rows.every((r) => r.path === 'greeter.ts'), 'every row is an active-file symbol row');
});

test('Quick Open "@foo" ranks the symbol cache by the post-"@" query', async (t) => {
  const { restore } = installSymbolGlobals();
  const ctx = buildQuickOpen([]);
  t.after(() => { ctx.quickOpen.dispose(); restore(); });
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@hello');
  await settle();
  assert.deepEqual(
    symbolRows(ctx).map((r) => r.name),
    ['helloMessage'],
    'the symbol cache is filtered by the text after "@"'
  );
});

test('Quick Open "@" is symbol mode, never a file-path search for "@…"', async (t) => {
  const { restore } = installSymbolGlobals();
  // A file whose path would match a plain "app" search, to prove "@app" does
  // NOT fall through to the file matcher.
  const ctx = buildQuickOpen(['src/app.js', 'greeter.ts']);
  t.after(() => { ctx.quickOpen.dispose(); restore(); });
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@app');
  await settle();
  const overlayEl = ctx.stage.querySelector('.ide-quick-open');
  assert.equal(
    overlayEl.querySelector('[data-ide-quick-open-path="src/app.js"]'),
    null,
    'no file row leaks into @-mode'
  );
  assert.equal(symbolRows(ctx).length, 0, '"app" matches no symbol');
  assert.match(overlayEl.textContent, /No matching symbols in this file/i);
});

test('Quick Open "@" Enter jumps to the symbol line/col via onOpenFileAtLine', async (t) => {
  const { restore } = installSymbolGlobals();
  const ctx = buildQuickOpen([]);
  t.after(() => { ctx.quickOpen.dispose(); restore(); });
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@helloMessage');
  await settle();
  fieldFor(ctx.stage, '[data-ide-quick-open-input]').dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  await settle();
  assert.deepEqual(ctx.calls.openAt, [{ path: 'greeter.ts', line: 7, column: 1 }]);
  assert.deepEqual(ctx.calls.open, [], 'a symbol jump never plain-opens the file');
});

test('Quick Open "@" row click jumps via the row dataset line/col', async (t) => {
  const { restore } = installSymbolGlobals();
  const ctx = buildQuickOpen([]);
  t.after(() => { ctx.quickOpen.dispose(); restore(); });
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@greet');
  await settle();
  const greetRow = symbolRowsEl(ctx).find(
    (row) => (row.querySelector('.ide-quick-open-name')?.textContent || '') === 'greet'
  );
  greetRow.click();
  await settle();
  assert.deepEqual(ctx.calls.openAt, [{ path: 'greeter.ts', line: 2, column: 3 }]);
});

test('Quick Open "@" on a non-TS/JS file shows the symbol empty status, no worker call', async (t) => {
  const { spy, restore } = installSymbolGlobals({ path: 'notes.txt', language: 'plaintext' });
  const ctx = buildQuickOpen([]);
  t.after(() => { ctx.quickOpen.dispose(); restore(); });
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@foo');
  await settle();
  const overlayEl = ctx.stage.querySelector('.ide-quick-open');
  assert.equal(symbolRows(ctx).length, 0, 'no symbol rows for a non-TS/JS file');
  assert.match(overlayEl.textContent, /No symbols - open a TS\/JS file/i);
  assert.equal(spy.workerCalls, 0, 'a non-TS/JS file never hits the worker');
});

test('Quick Open "@" with Monaco not loaded degrades to the symbol empty status', async (t) => {
  const { restore } = installSymbolGlobals({ noMonaco: true });
  const ctx = buildQuickOpen([]);
  t.after(() => { ctx.quickOpen.dispose(); restore(); });
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@');
  await settle();
  const overlayEl = ctx.stage.querySelector('.ide-quick-open');
  assert.equal(symbolRows(ctx).length, 0, 'no rows until Monaco is live');
  assert.match(overlayEl.textContent, /No symbols - open a TS\/JS file/i);
});

test('Quick Open "@" fetches the active-file symbols once per path (no re-fetch per keystroke)', async (t) => {
  const { spy, restore } = installSymbolGlobals();
  const ctx = buildQuickOpen([]);
  t.after(() => { ctx.quickOpen.dispose(); restore(); });
  ctx.quickOpen.toggle();
  await settle();

  // Three @-keystrokes fired while the first fetch is still in flight: the
  // in-flight guard must collapse them into a SINGLE worker round-trip.
  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@h');
  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@he');
  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@hel');
  await settle();
  assert.equal(spy.workerCalls, 1, 'concurrent @-keystrokes share one fetch');

  // Further @-typing for the SAME active file re-ranks the cache in place; the
  // per-path gate means no second worker round-trip.
  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@helloMessage');
  await settle();
  assert.equal(spy.workerCalls, 1, 'the per-path symbol cache is reused, not re-fetched');
  assert.deepEqual(symbolRows(ctx).map((r) => r.name), ['helloMessage']);
});

test('Quick Open "@" degrades to an empty status (never a stuck spinner) when the worker fails', async (t) => {
  const { spy, restore } = installSymbolGlobals({ throwWorker: true });
  const ctx = buildQuickOpen([]);
  t.after(() => { ctx.quickOpen.dispose(); restore(); });
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@');
  await settle();
  const overlayEl = ctx.stage.querySelector('.ide-quick-open');
  assert.equal(spy.workerCalls, 1, 'the worker was attempted once on a TS file');
  assert.equal(symbolRows(ctx).length, 0, 'no symbol rows survive a worker failure');
  // The path gate is satisfied in the catch branch, so isLoading clears: the
  // overlay must NOT be stuck on the "Indexing symbols…" spinner.
  assert.doesNotMatch(overlayEl.textContent, /Indexing/i, 'isLoading cleared - not a permanent spinner');
  assert.match(overlayEl.textContent, /No symbols/i, 'shows the symbol empty status instead');
  assert.ok(
    ctx.calls.log.some((e) => e.code === 'ide.quick_open_symbols_failed' && e.level === 'WARN'),
    'a worker failure is logged once'
  );
});

test('Quick Open "@" symbol rows show the mapped kind-label chip (raw kind -> label)', async (t) => {
  // "local function" is a raw TS navigation kind whose label is "function": this
  // proves the @-row chip renders the kindLabel, not the raw kind, in the
  // quick-open path (the mapping itself is unit-tested in symbol-nav).
  const flat = [
    { name: 'Greeter', kind: 'class', container: '', offset: 0 },
    { name: 'helper', kind: 'local function', container: '', offset: 60 },
  ];
  const { restore } = installSymbolGlobals({ flat });
  const ctx = buildQuickOpen([]);
  t.after(() => { ctx.quickOpen.dispose(); restore(); });
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@');
  await settle();
  assert.deepEqual(
    symbolRows(ctx).map((r) => ({ name: r.name, kind: r.kind })),
    [{ name: 'Greeter', kind: 'class' }, { name: 'helper', kind: 'function' }],
    'the chip shows symbolKindLabel(kind), not the raw "local function"'
  );
});

test('Quick Open "@": a symbol whose getPositionAt throws falls back to 1:1 without zeroing the list', async (t) => {
  // offset 120 (helloMessage) is "past EOF": getPositionAt throws for it. The
  // enrich loop must keep that symbol at 1:1 and still enrich the others.
  const { restore } = installSymbolGlobals({ throwPositionAtOffset: 120 });
  const ctx = buildQuickOpen([]);
  t.after(() => { ctx.quickOpen.dispose(); restore(); });
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@');
  await settle();
  const rows = symbolRows(ctx);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(rows.length, 3, 'one bad offset does not abort the whole enrich');
  assert.deepEqual(
    { line: byName.helloMessage.line, col: byName.helloMessage.col },
    { line: 1, col: 1 },
    'the throwing offset keeps the 1:1 fallback'
  );
  assert.deepEqual(
    { line: byName.greet.line, col: byName.greet.col },
    { line: 2, col: 3 },
    'the other symbols still enrich from getPositionAt'
  );
});

test('Quick Open "@": an active-file switch mid-fetch is discarded (stale guard), then re-kicks', async (t) => {
  // Gate the worker so we can step the fetch: park it, flip the active file,
  // then release - the resolved (now-stale) fetch must NOT enrich greeter's
  // symbols under the new file, and a fresh fetch must re-kick for the new file.
  // We probe flattenCalls (not the DOM): the instant the stale fetch resolves,
  // the re-kick flips isLoading on, which would MASK any stale rows in the same
  // render - so a row-count assertion here is vacuous (it passes even with the
  // guard removed). The guard returns BEFORE flattenNavigationTree, so a
  // discarded fetch leaves flattenCalls untouched; that is the real signal.
  const sym = installSymbolGlobals({ manualWorker: true });
  const ctx = buildQuickOpen([]);
  t.after(() => { ctx.quickOpen.dispose(); sym.restore(); });
  ctx.quickOpen.toggle();
  await settle();

  typeQueryInto(ctx, '[data-ide-quick-open-input]', '@');
  await microtasks();
  assert.equal(sym.spy.workerCalls, 1, 'the first fetch reached the worker and parked');
  assert.equal(sym.pendingWorkers(), 1, 'fetch #1 is in flight (gated)');

  // The user switches to another file while fetch #1 is still in flight.
  sym.setActivePath('other.ts');
  sym.releaseWorker();
  await microtasks();

  // The stale guard bailed before the enrich, so fetch #1 never flattened; the
  // open path gate then re-kicked a fresh fetch for the new file.
  assert.equal(sym.spy.flattenCalls, 0, 'the stale fetch is discarded before enriching (guard held)');
  assert.equal(sym.spy.workerCalls, 2, 'the open path gate re-kicked a fetch for the new file');
  assert.equal(sym.pendingWorkers(), 1, 'fetch #2 (for other.ts) is now in flight');

  // Releasing fetch #2 (which matches the current file) enriches + populates.
  sym.releaseWorker();
  await microtasks();
  const rows = symbolRows(ctx);
  assert.equal(sym.spy.flattenCalls, 1, 'only the fresh, non-stale fetch enriched');
  assert.equal(rows.length, 3, 'the fresh fetch for other.ts populates the symbol rows');
  assert.ok(rows.every((r) => r.path === 'other.ts'), 'rows are attributed to the new active file');
  assert.equal(sym.spy.workerCalls, 2, 'no extra worker round-trip beyond the stale + fresh pair');
});

test('controller Ctrl+E lists open files in real activation order', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'a.js': '1', 'b.js': '2', 'c.js': '3' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  // Open a -> b -> c, then re-activate a: MRU becomes a, c, b.
  await harness.controller.openFile('a.js');
  await harness.controller.openFile('b.js');
  await harness.controller.openFile('c.js');
  await harness.controller.openFile('a.js');
  await settle();

  harness.getDom().ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'e', ctrlKey: true, bubbles: true, cancelable: true,
  }));
  await settle();

  const overlayEl = harness.getDom().ideEditorStage.querySelector('.ide-recent-files');
  assert.ok(overlayEl && !overlayEl.classList.contains('hidden'), 'Ctrl+E opens the recent overlay');
  const rows = [...overlayEl.querySelectorAll('[data-ide-recent-files-path]')]
    .map((row) => row.dataset.ideRecentFilesPath);
  assert.deepEqual(rows, ['a.js', 'c.js', 'b.js'], 'most-recently-active first');
});
