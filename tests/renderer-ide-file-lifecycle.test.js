'use strict';

/* Direct unit tests for renderer-ide-file-lifecycle: the module is exercised in
 * isolation with injected fakes (real ideStateUtils + a real closed-tabs stack,
 * everything else faked). Each guard is asserted via a SIDE-EFFECT COUNTER on the
 * guarded branch (a toast call, a reopen-stack push, an applyViewState call) — not
 * the converged editor/DOM state — and each was mutation-checked during authoring
 * (flip the guard, confirm the matching assertion goes RED). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');
const closedTabsUtils = require('../renderer/features/renderer-ide-closed-tabs');
const { createIdeFileLifecycle } = require('../renderer/features/renderer-ide-file-lifecycle');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Builds a lifecycle wired to fakes. `files` is the (mutable, returned) set of
// paths that "exist" on disk; readText refuses anything else (a vanished
// file). `writeError`, when set, makes writeText reject with it.
function makeLifecycle({
  files = new Set(),
  readFailure = null,
  writeError = null,
  saveHygiene = null,
  platform = 'linux',
  canonicalPaths = {},
} = {}) {
  const ide = ideState.createIdeUiState();

  const docs = new Map(); // path -> { kind, value, mtime }
  const editorHost = {
    applyViewStateCount: 0,
    markSavedCalls: [],
    hasDocument: (path) => docs.has(path),
    openDocument: async (payload) => {
      if (typeof payload.shouldApply === 'function' && !payload.shouldApply()) return null;
      docs.set(payload.path, { kind: 'file', value: payload.content, mtime: payload.mtimeMs });
      payload.onApplied?.();
      return docs.get(payload.path);
    },
    openImageDocument: (payload) => {
      docs.set(payload.path, { kind: 'image', value: payload.base64, mtime: 0 });
      return docs.get(payload.path);
    },
    activateDocument: () => {},
    closeDocument: (path) => docs.delete(path),
    showEmpty: () => {},
    getDocumentKind: (path) => docs.get(path)?.kind || null,
    getValue: (path) => docs.get(path)?.value,
    getAltVersionId: (path) => docs.get(path)?.altVersion ?? 1,
    getMtime: (path) => docs.get(path)?.mtime,
    markSaved(path, opts) { this.markSavedCalls.push({ path, opts }); },
    getViewState: () => ({ cursor: 1 }),
    applyViewState() { this.applyViewStateCount += 1; },
  };

  const writeFileCalls = [];
  const readTextCalls = [];
  const readImageCalls = [];
  const versions = new Map([...files].map((path) => [path, `vf2_${path}`]));
  const canonicalPathFor = (requestedPath) => canonicalPaths[requestedPath.toLowerCase()] || requestedPath;
  const api = {
    readText: async ({ path }) => {
      readTextCalls.push(path);
      if (readFailure) return readFailure;
      const canonicalPath = canonicalPathFor(path);
      if (!files.has(canonicalPath)) {
        return { ok: false, code: 'CMP-WORKSPACEFS-0004', message: 'ENOENT: no such file', details: {} };
      }
      return {
        ok: true, path: canonicalPath, pathKey: canonicalPath.toLowerCase(),
        requestedPath: path, requestedPathKey: path.toLowerCase(),
        content: `content:${canonicalPath}`, mtimeMs: 111,
        rootId: 'root-a', generation: 1, fileVersion: versions.get(canonicalPath),
        encoding: 'utf-8', editable: true, truncated: false, eol: 'lf',
      };
    },
    readImage: async ({ path }) => {
      readImageCalls.push(path);
      if (readFailure) return readFailure;
      const canonicalPath = canonicalPathFor(path);
      return {
        ok: true, path: canonicalPath, pathKey: canonicalPath.toLowerCase(),
        requestedPath: path, requestedPathKey: path.toLowerCase(),
        base64: 'AAAA', mime: 'image/png', size: 3, mtimeMs: 111,
        rootId: 'root-a', generation: 1, fileVersion: versions.get(canonicalPath),
        kind: 'image', representation: 'base64', editable: false, truncated: false,
      };
    },
    writeText: async (payload) => {
      writeFileCalls.push(payload);
      if (writeError) {
        throw writeError;
      }
      const fileVersion = `${versions.get(payload.path)}_saved`;
      versions.set(payload.path, fileVersion);
      return {
        ok: true, path: payload.path, pathKey: payload.path, mtimeMs: 222,
        rootId: 'root-a', generation: 1, fileVersion,
      };
    },
  };

  const realStack = closedTabsUtils.createIdeClosedTabsStack({ limit: 10 });
  const closedTabs = {
    pushCount: 0,
    dropPathCalls: [],
    dropUnderCalls: [],
    push(entry) { this.pushCount += 1; return realStack.push(entry); },
    pop() { return realStack.pop(); },
    dropPath(path) { this.dropPathCalls.push(path); return realStack.dropPath(path); },
    dropUnder(path) { this.dropUnderCalls.push(path); return realStack.dropUnder(path); },
    clear() { return realStack.clear(); },
    // The stack's test-only size() accessor was retired (hyg-W4-S10); count by
    // draining pops and restoring bottom-first (push de-dupes by path, and every
    // drained path is unique, so order and view state survive the round trip).
    size: () => {
      const drained = [];
      for (let entry = realStack.pop(); entry; entry = realStack.pop()) drained.push(entry);
      for (let i = drained.length - 1; i >= 0; i -= 1) realStack.push(drained[i]);
      return drained.length;
    },
  };

  const toasts = [];
  const notices = [];
  const logs = [];
  const counters = { requestRender: 0, activateMapStage: 0, editorActivations: [] };
  const lifecycle = createIdeFileLifecycle({
    activateMapStage: () => { counters.activateMapStage += 1; },
    onEditorDocumentActivated: (path) => { counters.editorActivations.push(path); },
    getIde: () => ide,
    ideStateUtils: ideState,
    editorHost,
    getWorkspaceFsApi: () => api,
    closedTabs,
    welcome: { drop: () => {}, noteOpened: () => {}, render: () => {} },
    chipPicker: { applyDefaults: () => {} },
    gitFeature: { requestRefresh: () => {} },
    searchPanel: { isReplacing: () => false },
    saveHygiene,
    renderTabs: () => {},
    schedulePersist: () => {},
    requestRender: () => { counters.requestRender += 1; },
    showShellErrorToast: (message, opts) => toasts.push({ message, opts: opts || {} }),
    showToastMessage: (message, opts) => notices.push({ message, opts: opts || {} }),
    appendClientLog: (level, event, meta) => logs.push({ level, event, meta }),
    platform,
  });

  return {
    ide, lifecycle, editorHost, closedTabs, toasts, notices, logs, counters, writeFileCalls,
    readTextCalls, readImageCalls, docs, files,
  };
}

test('a legacy map:// open routes to the File Map stage — no tab, no file read, no open-failure toast', async () => {
  // Stage-surface contract (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md): the
  // File Map is a stage surface, never a tab. A stray legacy MAP_TAB_ID open
  // (older in-memory state, stale caller) routes to activateMapStage; without
  // the guard, openFile() would readFile('map:/workspace'), reject, and fire
  // the "Could Not Open" toast.
  const ctx = makeLifecycle({ files: new Set(['a.js']) });

  const opened = await ctx.lifecycle.openFile(ideState.MAP_TAB_ID);

  assert.equal(opened, true, 'openFile resolves truthy for the legacy map id');
  assert.equal(ctx.toasts.length, 0, 'guarded branch: no open-failure toast for the hostless map id');
  assert.equal(ctx.counters.activateMapStage, 1, 'routes to the File Map stage surface');
  assert.equal(ctx.ide.activeTabPath, '', 'no tab is activated for the legacy map id');
  assert.equal(ctx.ide.openTabs.length, 0, 'no synthetic map tab is created');
  assert.equal(ctx.editorHost.hasDocument(ideState.MAP_TAB_ID), false, 'no editor document is created for the map id');

  // Mutation pair: a real (vanished) file still takes the readFile path and DOES
  // surface the open-failure toast — proving the guard is map-id-specific.
  ctx.files.delete('a.js');
  assert.equal(await ctx.lifecycle.openFile('a.js'), false);
  assert.equal(ctx.toasts.length, 1, 'mutation pair: a vanished real file still toasts');
  assert.equal(ctx.toasts[0].opts.title, 'Could Not Open');
});

test('clean transient preview replacement is single-slot, failure-safe, and excluded from reopen history', async () => {
  const ctx = makeLifecycle({ files: new Set(['a.js', 'b.js']) });
  assert.equal(await ctx.lifecycle.openFile('a.js', { preview: true }), true);
  assert.equal(ctx.ide.openTabs[0].transientPreview, true);

  assert.equal(await ctx.lifecycle.openFile('missing.js', { preview: true }), false);
  assert.deepEqual(ctx.ide.openTabs.map((tab) => tab.path), ['a.js']);
  assert.equal(ctx.docs.has('a.js'), true);

  assert.equal(await ctx.lifecycle.openFile('b.js', { preview: true }), true);
  assert.deepEqual(ctx.ide.openTabs.map((tab) => tab.path), ['b.js']);
  assert.equal(ctx.ide.openTabs[0].transientPreview, true);
  assert.equal(ctx.docs.has('a.js'), false);
  assert.equal(ctx.closedTabs.pushCount, 0);
});

test('closing a transient preview does not add it to reopen history', async () => {
  const ctx = makeLifecycle({ files: new Set(['preview.js']) });
  await ctx.lifecycle.openFile('preview.js', { preview: true });
  ctx.lifecycle.closeTab('preview.js');
  assert.equal(ctx.closedTabs.pushCount, 0);
  assert.equal(ctx.closedTabs.size(), 0);
});

test('explicit, dirty, and pinned file tabs are never replaced by later previews', async () => {
  const ctx = makeLifecycle({ files: new Set(['explicit.js', 'dirty.js', 'pinned.js', 'next.js']) });

  await ctx.lifecycle.openFile('explicit.js', { preview: true });
  await ctx.lifecycle.openFile('explicit.js', null);
  assert.equal(ideState.getTab(ctx.ide, 'explicit.js').transientPreview, undefined);

  await ctx.lifecycle.openFile('dirty.js', { preview: true });
  ideState.setTabDirty(ctx.ide, 'dirty.js', true);
  await ctx.lifecycle.openFile('pinned.js', { preview: true });
  ideState.toggleTabPinned(ctx.ide, 'pinned.js');
  await ctx.lifecycle.openFile('next.js', { preview: true });

  assert.deepEqual(
    new Set(ctx.ide.openTabs.map((tab) => tab.path)),
    new Set(['explicit.js', 'dirty.js', 'pinned.js', 'next.js'])
  );
  assert.equal(ideState.getTab(ctx.ide, 'next.js').transientPreview, true);
});

test('a preview may replace the clean preview slot at the tab cap', async () => {
  const files = new Set(['preview-a.js', 'preview-b.js']);
  for (let index = 0; index < ideState.MAX_OPEN_TABS - 1; index += 1) {
    files.add(`explicit-${index}.js`);
  }
  const ctx = makeLifecycle({ files });
  for (let index = 0; index < ideState.MAX_OPEN_TABS - 1; index += 1) {
    ideState.openTab(ctx.ide, `explicit-${index}.js`);
  }
  await ctx.lifecycle.openFile('preview-a.js', { preview: true });
  assert.equal(ctx.ide.openTabs.length, ideState.MAX_OPEN_TABS);

  assert.equal(await ctx.lifecycle.openFile('preview-b.js', { preview: true }), true);
  assert.equal(ctx.ide.openTabs.length, ideState.MAX_OPEN_TABS);
  assert.equal(ideState.getTab(ctx.ide, 'preview-a.js'), null);
  assert.equal(ideState.getTab(ctx.ide, 'preview-b.js').transientPreview, true);
});

test('document activations report through onEditorDocumentActivated (handoff §C.2 hook)', async () => {
  const ctx = makeLifecycle({ files: new Set(['a.js', 'b.js']) });
  assert.equal(await ctx.lifecycle.openFile('a.js'), true);
  assert.deepEqual(ctx.counters.editorActivations, ['a.js'], 'openFile reports the activation');
  assert.equal(await ctx.lifecycle.openFile('b.js'), true);
  ctx.lifecycle.activateTab('a.js');
  assert.deepEqual(
    ctx.counters.editorActivations,
    ['a.js', 'b.js', 'a.js'],
    'activateTab on an already-open document reports too'
  );
});

test('unattended and user saves both surface transient failures', async () => {
  const transient = new Error('disk full');
  const ctx = makeLifecycle({ files: new Set(['a.js']), writeError: transient });
  assert.equal(await ctx.lifecycle.openFile('a.js'), true);

  // Unattended (auto-save) transient failure is visible and also logged.
  assert.equal(await ctx.lifecycle.saveFile('a.js', { unattended: true }), false);
  assert.equal(ctx.toasts.length, 1, 'background save failure is visible');
  const warn = ctx.logs.find((entry) => entry.event === 'ide.save_failed');
  assert.ok(warn, 'still logs a structured warning');
  assert.equal(warn.meta.unattended, true);
  assert.equal(warn.meta.conflicted, false);

  // Same error, user-initiated (unattended false): the toast fires.
  assert.equal(await ctx.lifecycle.saveFile('a.js', { unattended: false }), false);
  assert.equal(ctx.toasts.length, 2, 'a user save surfaces the failure too');
  assert.equal(ctx.toasts[1].opts.title, 'Save Failed');
});

test('an on-disk conflict is surfaced even for an unattended versioned save', async () => {
  const conflict = new Error('File changed on disk since it was loaded.');
  const ctx = makeLifecycle({ files: new Set(['a.js']), writeError: conflict });
  assert.equal(await ctx.lifecycle.openFile('a.js'), true);

  assert.equal(await ctx.lifecycle.saveFile('a.js', { unattended: true }), false);
  // Conflict always surfaces (the guard is `conflicted || !unattended`).
  assert.equal(ctx.toasts.length, 1, 'guarded branch: a conflict is never silenced');
  assert.equal(ctx.toasts[0].opts.title, 'Save Conflict');
  // The write carries the generation + opaque version so metadata-only touches
  // do not conflict and byte/identity changes do.
  assert.equal(ctx.writeFileCalls.length, 1);
  assert.equal(ctx.writeFileCalls[0].expectedGeneration, 1);
  assert.equal(ctx.writeFileCalls[0].expectedFileVersion, 'vf2_a.js');
});

test('save runs save-hygiene before the content snapshot, so the cleaned buffer is written', async () => {
  const ide = ideState.createIdeUiState();
  const docs = new Map();
  let gotValue = false;
  let hygieneRanFirst = null;
  const editorHost = {
    hasDocument: (p) => docs.has(p),
    openDocument: async (payload) => {
      if (typeof payload.shouldApply === 'function' && !payload.shouldApply()) return null;
      docs.set(payload.path, { kind: 'file', value: payload.content, mtime: payload.mtimeMs });
      payload.onApplied?.();
      return docs.get(payload.path);
    },
    activateDocument() {},
    getDocumentKind: (p) => docs.get(p)?.kind || null,
    getValue: (p) => { gotValue = true; return docs.get(p).value; },
    getAltVersionId: () => 1,
    getMtime: (p) => docs.get(p)?.mtime,
    markSaved() {},
  };
  const writeFileCalls = [];
  let fileVersion = 'vf2_open';
  const saveHygiene = {
    applySaveHygiene: async (p) => {
      hygieneRanFirst = gotValue === false; // must run BEFORE getValue snapshots
      docs.get(p).value = 'clean\n'; // simulate trim + final-newline on the model
    },
  };
  const lifecycle = createIdeFileLifecycle({
    getIde: () => ide,
    ideStateUtils: ideState,
    editorHost,
    getWorkspaceFsApi: () => ({
      readText: async ({ path }) => ({
        ok: true, path, pathKey: path, requestedPath: path, requestedPathKey: path,
        content: 'dirty  ', mtimeMs: 111,
        rootId: 'root-a', generation: 1, fileVersion,
        encoding: 'utf-8', editable: true, truncated: false, eol: 'lf',
      }),
      writeText: async (payload) => {
        writeFileCalls.push(payload); fileVersion = 'vf2_saved';
        return { ok: true, path: payload.path, pathKey: payload.path, mtimeMs: 222, rootId: 'root-a', generation: 1, fileVersion };
      },
    }),
    saveHygiene,
    gitFeature: { requestRefresh: () => {} },
    searchPanel: { isReplacing: () => false },
    renderTabs: () => {},
    schedulePersist: () => {},
  });
  assert.equal(await lifecycle.openFile('a.js'), true);
  assert.equal(await lifecycle.saveFile('a.js'), true);
  assert.equal(hygieneRanFirst, true, 'hygiene ran before the content snapshot');
  assert.equal(writeFileCalls[0].content, 'clean\n', 'the hygiene-cleaned buffer is what gets written');
});

test('formatter failure still saves safely and reports saved without formatting', async () => {
  const ctx = makeLifecycle({
    files: new Set(['a.js']),
    saveHygiene: { async applySaveHygiene() { return { formatStatus: 'failed', formatReason: 'formatter_failed' }; } },
  });
  assert.equal(await ctx.lifecycle.openFile('a.js'), true);
  assert.equal(await ctx.lifecycle.saveFile('a.js'), true);
  assert.equal(ctx.writeFileCalls.length, 1, 'formatter failure does not block the safe write');
  assert.equal(ctx.notices.at(-1).message, 'File saved without formatting.');
  assert.equal(ctx.logs.find((entry) => entry.event === 'ide.save_succeeded').meta.format_status, 'failed');
});

test('confirmed git discard reloads an open dirty document through the versioned lifecycle', async () => {
  const ctx = makeLifecycle({ files: new Set(['a.js']) });
  assert.equal(await ctx.lifecycle.openFile('a.js'), true);
  ctx.docs.get('a.js').value = 'unsaved editor text';
  ctx.lifecycle.noteEdit('a.js');
  ctx.lifecycle.noteDirty('a.js', true);

  const snapshot = ctx.lifecycle.captureGitDiscard('a.js');
  assert.ok(snapshot, 'explicit discard captures the dirty document revision');
  assert.equal(await ctx.lifecycle.saveFile('a.js'), false, 'save cannot race the confirmed discard transaction');
  assert.equal(ctx.writeFileCalls.length, 0);
  assert.equal(await ctx.lifecycle.reloadAfterGitDiscard(snapshot), true);
  ctx.lifecycle.releaseGitDiscard(snapshot);
  assert.equal(ctx.docs.get('a.js').value, 'content:a.js');
  assert.equal(ctx.lifecycle.getDocumentToken('a.js').dirty, false);
  assert.deepEqual(ctx.readTextCalls, ['a.js', 'a.js']);
  assert.equal(await ctx.lifecycle.saveFile('a.js'), true, 'save is available again after terminal release');
});

test('delete/rename close skips the reopen stack while a user close records it', async () => {
  const ctx = makeLifecycle({ files: new Set(['a.js', 'b.js']) });
  assert.equal(await ctx.lifecycle.openFile('a.js'), true);
  assert.equal(await ctx.lifecycle.openFile('b.js'), true);
  await tick();

  // Tree delete fans out through closeTabsUnder with bypassReopenPush set.
  ctx.lifecycle.handleTreeEntryDeleted('a.js', 'file');
  await tick();
  assert.equal(ctx.closedTabs.pushCount, 0, 'guarded branch: a vanished file is not recorded for reopen');
  assert.ok(ctx.closedTabs.dropUnderCalls.includes('a.js'), 'and the reopen stack is purged under the path');

  // Mutation pair: a normal user close DOES record for Ctrl+Shift+T.
  ctx.lifecycle.closeTab('b.js');
  await tick();
  assert.equal(ctx.closedTabs.pushCount, 1, 'mutation pair: a user close records a reopen entry');
});

test('reopen skips a vanished file (no view-state apply) but reopens a present one', async () => {
  const ctx = makeLifecycle({ files: new Set(['gone.js']) });
  assert.equal(await ctx.lifecycle.openFile('gone.js'), true);
  ctx.lifecycle.closeTab('gone.js'); // records a reopen entry with view state
  await tick();
  ctx.toasts.length = 0;
  ctx.files.delete('gone.js'); // the file vanishes on disk

  await ctx.lifecycle.reopenClosedTab();
  await tick();
  // openFile failed, so the `if (opened && entry.viewState)` guard is skipped.
  assert.equal(ctx.editorHost.applyViewStateCount, 0, 'guarded branch: no view-state restore for a vanished file');

  // Mutation pair: a present file reopens and its view state is restored.
  const ctx2 = makeLifecycle({ files: new Set(['here.js']) });
  assert.equal(await ctx2.lifecycle.openFile('here.js'), true);
  ctx2.lifecycle.closeTab('here.js');
  await tick();
  await ctx2.lifecycle.reopenClosedTab();
  await tick();
  assert.equal(ctx2.editorHost.applyViewStateCount, 1, 'mutation pair: a present file restores its view state');
});

test('root reset clears the closed-tab stack', async () => {
  const ctx = makeLifecycle({ files: new Set(['old.js']) });
  assert.equal(await ctx.lifecycle.openFile('old.js'), true);
  ctx.lifecycle.closeTab('old.js');
  assert.equal(ctx.closedTabs.size(), 1);

  ctx.lifecycle.resetForRoot({ rootId: 'root-b', generation: 2 });

  assert.equal(ctx.closedTabs.size(), 0);
  assert.equal(await ctx.lifecycle.reopenClosedTab(), undefined);
});

test('root reset during deferred save hygiene prevents an old-root write', async () => {
  let signalStarted;
  let releaseHygiene;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseHygiene = resolve; });
  const ctx = makeLifecycle({
    files: new Set(['same.js']),
    saveHygiene: {
      async applySaveHygiene() {
        signalStarted();
        await blocked;
      },
    },
  });
  assert.equal(await ctx.lifecycle.openFile('same.js'), true);

  const pendingSave = ctx.lifecycle.saveFile('same.js');
  await started;
  ctx.lifecycle.resetForRoot({ rootId: 'root-b', generation: 2 });
  releaseHygiene();

  assert.equal(await pendingSave, false);
  assert.deepEqual(ctx.writeFileCalls, []);
});

test('opening a vanished file toasts a path-deduped notice (stable key across repeats)', async () => {
  const ctx = makeLifecycle({ files: new Set() }); // nothing exists

  assert.equal(await ctx.lifecycle.openFile('missing.js'), false);
  assert.equal(ctx.toasts.length, 1, 'guarded branch: a vanished open surfaces a toast');
  assert.equal(ctx.toasts[0].opts.title, 'Could Not Open');
  assert.equal(ctx.toasts[0].opts.dedupeKey, 'ide:vanished:missing.js');
  assert.ok(ctx.closedTabs.dropPathCalls.includes('missing.js'), 'and it is purged from the reopen stack');

  // Re-opening the same vanished path passes the IDENTICAL dedupeKey, so the
  // toast layer collapses the repeat (mutation pair: a different path → a
  // different key).
  await ctx.lifecycle.openFile('missing.js');
  assert.equal(ctx.toasts[1].opts.dedupeKey, 'ide:vanished:missing.js');
  await ctx.lifecycle.openFile('other.js');
  assert.equal(ctx.toasts[2].opts.dedupeKey, 'ide:vanished:other.js');
});

test('CMP-WORKSPACEFS-0011 names the editor limit and closes the failed tab', async () => {
  const path = 'generated/oversized.json';
  const code = 'CMP-WORKSPACEFS-0011';
  const ctx = makeLifecycle({
    readFailure: { ok: false, code, message: 'too large', details: { max_bytes: 5 * 1024 * 1024 } },
  });
  ideState.openTab(ctx.ide, path);

  assert.equal(await ctx.lifecycle.openFile(path), false);
  assert.equal(ctx.ide.openTabs.some((tab) => tab.path === path), false, 'failed tab is closed');
  assert.equal(ctx.toasts.at(-1).message, "oversized.json is larger than the editor's 5 MB limit.");
  assert.equal(ctx.logs.at(-1).event, 'ide.open_file_failed');
  assert.equal(ctx.logs.at(-1).meta.code, code);
});

for (const [suffix, path, details, expected] of [
  ['0010', 'nested/payload.bin', {}, "payload.bin is a binary file and can't be shown in the editor."],
  ['0011', 'nested/payload.bin', {}, "payload.bin is larger than the editor's size limit."],
  ['0012', 'images/oversized.png', {}, 'oversized.png is too large to preview.'],
  ['0013', 'nested/payload.bin', {}, "payload.bin isn't valid UTF-8 text."],
  ['0014', 'images/unsupported.webp', {}, "unsupported.webp's image format isn't supported."],
]) {
  test(`CMP-WORKSPACEFS-${suffix} reports distinct open-failure copy and closes the tab`, async () => {
    const code = `CMP-WORKSPACEFS-${suffix}`;
    const ctx = makeLifecycle({ readFailure: { ok: false, code, message: 'refused', details } });
    ideState.openTab(ctx.ide, path);

    assert.equal(await ctx.lifecycle.openFile(path), false);
    assert.equal(ctx.ide.openTabs.some((tab) => tab.path === path), false, 'failed tab is closed');
    assert.equal(ctx.toasts.at(-1).message, expected);
    assert.equal(ctx.logs.at(-1).event, 'ide.open_file_failed');
    assert.equal(ctx.logs.at(-1).meta.code, code);
  });
}

test('an unmapped open failure keeps the generic fallback copy exactly', async () => {
  const path = 'nested/missing.txt';
  const ctx = makeLifecycle({
    readFailure: { ok: false, code: 'CMP-WORKSPACEFS-0004', message: 'missing', details: {} },
  });
  ideState.openTab(ctx.ide, path);

  assert.equal(await ctx.lifecycle.openFile(path), false);
  assert.equal(ctx.ide.openTabs.some((tab) => tab.path === path), false);
  assert.equal(ctx.toasts.at(-1).message, 'nested/missing.txt was closed — it could not be opened.');
  assert.equal(ctx.toasts.at(-1).opts.title, 'Could Not Open');
  assert.equal(ctx.logs.at(-1).meta.code, 'CMP-WORKSPACEFS-0004');
});

/* ── WIDE-051: the 64-tab cap must refuse BEFORE creating a document ── */

test('the 65th open is refused with a typed cap result — no read, no model, active tab unchanged', async () => {
  const ctx = makeLifecycle({ files: new Set(['overflow.js']) });
  for (let i = 0; i < ideState.MAX_OPEN_TABS; i += 1) {
    ideState.openTab(ctx.ide, `filler-${i}.js`);
  }
  ideState.setActiveTab(ctx.ide, 'filler-0.js');

  assert.equal(await ctx.lifecycle.openFile('overflow.js'), false);
  assert.deepEqual(ctx.readTextCalls, [], 'guarded branch: refused BEFORE the disk read');
  assert.equal(ctx.editorHost.hasDocument('overflow.js'), false, 'no editor document is created');
  assert.equal(ctx.ide.openTabs.length, ideState.MAX_OPEN_TABS, 'the strip stays at the cap');
  assert.equal(ctx.ide.activeTabPath, 'filler-0.js', 'the active tab is unchanged');
  assert.deepEqual(ctx.counters.editorActivations, [], 'nothing is activated');
  assert.equal(ctx.toasts.length, 1, 'the refusal is surfaced');
  assert.equal(ctx.toasts[0].opts.title, 'Tab Limit');
  assert.equal(ctx.toasts[0].opts.dedupeKey, 'ide:tab-cap');
  const warn = ctx.logs.find((entry) => entry.event === 'ide.open_tab_cap');
  assert.ok(warn, 'the typed cap result is logged');
  assert.equal(warn.meta.code, 'TAB_LIMIT');
  assert.equal(warn.meta.limit, ideState.MAX_OPEN_TABS);
});

test('at the cap, re-opening an already-open (dirty) path still activates normally', async () => {
  const ctx = makeLifecycle({ files: new Set(['keep.js']) });
  assert.equal(await ctx.lifecycle.openFile('keep.js'), true);
  ideState.setTabDirty(ctx.ide, 'keep.js', true);
  ctx.docs.get('keep.js').value = 'unsaved edits';
  for (let i = ctx.ide.openTabs.length; i < ideState.MAX_OPEN_TABS; i += 1) {
    ideState.openTab(ctx.ide, `filler-${i}.js`);
  }
  assert.equal(ctx.ide.openTabs.length, ideState.MAX_OPEN_TABS, 'precondition: strip is full');
  ideState.setActiveTab(ctx.ide, 'filler-1.js');
  ctx.toasts.length = 0;
  ctx.counters.editorActivations.length = 0;

  assert.equal(await ctx.lifecycle.openFile('keep.js'), true, 'an already-open path always fits');
  assert.equal(ctx.ide.activeTabPath, 'keep.js', 'the existing tab re-activates');
  assert.deepEqual(ctx.counters.editorActivations, ['keep.js']);
  assert.equal(ctx.toasts.length, 0, 'no cap toast for a re-activation');
  assert.equal(ctx.docs.get('keep.js').value, 'unsaved edits', 'the dirty buffer is untouched');
  assert.deepEqual(ctx.readTextCalls, ['keep.js'], 'only the original open read the disk');
});

test('a doc created while the strip fills mid-read (lost race) is disposed, not hidden-activated', async () => {
  const ctx = makeLifecycle({ files: new Set(['racer.js']) });
  // 63 tabs: the up-front capacity check passes…
  for (let i = 0; i < ideState.MAX_OPEN_TABS - 1; i += 1) {
    ideState.openTab(ctx.ide, `filler-${i}.js`);
  }
  ideState.setActiveTab(ctx.ide, 'filler-0.js');
  // …then a parallel open takes the last slot during the awaited read.
  const originalOpen = ctx.editorHost.openDocument;
  ctx.editorHost.openDocument = async (payload) => {
    ideState.openTab(ctx.ide, 'sniped.js');
    return originalOpen(payload);
  };

  assert.equal(await ctx.lifecycle.openFile('racer.js'), false);
  assert.equal(ctx.editorHost.hasDocument('racer.js'), false, 'the created doc is disposed');
  assert.equal(ctx.lifecycle.getDocumentToken('racer.js'), null, 'the open token is released');
  assert.equal(ctx.ide.openTabs.some((tab) => tab.path === 'racer.js'), false, 'no tab appeared');
  assert.equal(ctx.ide.activeTabPath, 'sniped.js', 'the racing open keeps the active slot');
  assert.deepEqual(ctx.counters.editorActivations, [], 'the refused doc is never activated');
  assert.equal(ctx.toasts[0].opts.title, 'Tab Limit');
});

test('the 64th open (exactly at the boundary) still opens and activates', async () => {
  const ctx = makeLifecycle({ files: new Set(['last.js']) });
  for (let i = 0; i < ideState.MAX_OPEN_TABS - 1; i += 1) {
    ideState.openTab(ctx.ide, `filler-${i}.js`);
  }

  assert.equal(await ctx.lifecycle.openFile('last.js'), true);
  assert.equal(ctx.ide.openTabs.length, ideState.MAX_OPEN_TABS);
  assert.equal(ctx.ide.activeTabPath, 'last.js');
  assert.equal(ctx.editorHost.hasDocument('last.js'), true);
  assert.deepEqual(ctx.counters.editorActivations, ['last.js']);
  assert.equal(ctx.toasts.length, 0);
});

test('Windows casing aliases reopen, activate, and close one canonical document and tab', async () => {
  const ctx = makeLifecycle({
    files: new Set(['src/File.js']),
    platform: 'win32',
    canonicalPaths: {
      'src/file.js': 'src/File.js',
    },
  });

  assert.equal(await ctx.lifecycle.openFile('SRC/FILE.JS'), true);
  assert.equal(await ctx.lifecycle.openFile('src/file.js'), true);
  ctx.lifecycle.activateTab('SrC/fIlE.Js');

  assert.deepEqual(ctx.ide.openTabs.map((tab) => tab.path), ['src/File.js']);
  assert.equal(ctx.docs.size, 1);
  assert.deepEqual(ctx.readTextCalls, ['SRC/FILE.JS'], 'casing aliases reuse the canonical open document');

  ctx.lifecycle.closeTab('SRC/file.JS');
  assert.deepEqual(ctx.ide.openTabs, []);
  assert.equal(ctx.docs.size, 0);
  assert.equal(ctx.lifecycle.getDocumentToken('src/File.js'), null);
});
