'use strict';

// new-test-file: a new surface (the outside-files IDE module, row 137); no existing test file covers it.
// Behaviour of createIdeOutsideFiles against a fake bridge and a fake editor host, plus the Monaco URI
// mapping for outside keys.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');
const outside = require('../renderer/features/renderer-ide-outside-files');
const monacoUtils = require('../renderer/features/renderer-monaco-editor-utils');
const closedTabsUtils = require('../renderer/features/renderer-ide-closed-tabs');
const { createIdeFileLifecycle } = require('../renderer/features/renderer-ide-file-lifecycle');
const { createIdeHotExit } = require('../renderer/features/renderer-ide-hot-exit');

const ID = 'o0123456789abcdef01234567';
const ID2 = 'o89abcdef0123456789abcdef';
const DIR = 'C:\\Users\\me\\Desktop';
const item = (id = ID, name = 'notes.md') => ({ kind: 'outside', id, name, dirLabel: DIR, ext: 'md' });
const KEY = `outside://${ID}/notes.md`;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness({ reads = {}, tabCapacity = null } = {}) {
  const ide = ideState.createIdeUiState();
  const docs = new Map();
  const calls = { readText: [], writeText: [], setOpenSet: [], activate: [], toasts: [], errors: [], marked: [], opened: [] };
  const files = new Map(); // id -> { content, fileVersion, editable, encoding, eol }
  files.set(ID, { content: 'hello', fileVersion: 'v1', editable: true, encoding: 'utf-8', eol: 'lf', ...reads[ID] });
  files.set(ID2, { content: 'other', fileVersion: 'w1', editable: true, encoding: 'utf-8', eol: 'lf', ...reads[ID2] });
  const failures = { readText: null, writeText: null };
  let changeListener = null;
  let version = 0;
  const bridge = {
    readText: async ({ id }) => {
      calls.readText.push(id);
      if (failures.readText) return failures.readText;
      const file = files.get(id);
      return file ? { ok: true, id, name: 'x', mtimeMs: 5, size: file.content.length, truncated: false, ...file } : { ok: false, code: 'CMP-WORKSPACEFS-0017' };
    },
    writeText: async (payload) => {
      calls.writeText.push(payload);
      if (failures.writeText) return failures.writeText;
      const file = files.get(payload.id);
      version += 1;
      file.content = payload.content;
      file.fileVersion = `saved${version}`;
      return { ok: true, id: payload.id, fileVersion: file.fileVersion, mtimeMs: 9 };
    },
    setOpenSet: async (payload) => { calls.setOpenSet.push(payload.ids); return { ok: true }; },
    reveal: async ({ id }) => ({ ok: true, id }),
    attach: async ({ id }) => ({ ok: true, accepted: [{ id }], rejected: [] }),
    readImage: async ({ id, relPath }) => ({ ok: true, id, relPath, mime: 'image/png', base64: 'AA==' }),
    onChange: (listener) => { changeListener = listener; return () => { changeListener = null; }; },
  };
  const editorHost = {
    hasDocument: (path) => docs.has(path),
    openDocument: async (payload) => {
      if (typeof payload.shouldApply === 'function' && payload.shouldApply() !== true) return null;
      const previous = docs.get(payload.path);
      docs.set(payload.path, { content: payload.content, dirty: false, readOnly: payload.readOnly === true, alt: 1, eol: payload.eol, loads: (previous?.loads || 0) + 1 });
      calls.opened.push(payload);
      payload.onApplied?.();
      return docs.get(payload.path);
    },
    activateDocument: (path) => { calls.activate.push(path); return true; },
    closeDocument: (path) => { docs.delete(path); },
    getValue: (path) => docs.get(path)?.content,
    getAltVersionId: (path) => docs.get(path)?.alt,
    isDirty: (path) => docs.get(path)?.dirty === true,
    markSaved: (path, options) => { calls.marked.push({ path, options }); if (docs.has(path)) docs.get(path).dirty = false; },
  };
  const stateUtils = tabCapacity === null ? ideState : {
    ...ideState,
    checkTabCapacity: (state, key) => (state.openTabs.length >= tabCapacity && !state.openTabs.some((tab) => tab.path === key)
      ? { ok: false, code: 'TAB_LIMIT', limit: tabCapacity } : { ok: true }),
  };
  const timers = [];
  const instance = outside.createIdeOutsideFiles({
    getBridge: () => bridge,
    getIde: () => ide,
    ideStateUtils: stateUtils,
    editorHost,
    renderTabs: () => {},
    showToastMessage: (message, options) => calls.toasts.push({ message, options }),
    showShellErrorToast: (message, options) => calls.errors.push({ message, options }),
    appendClientLog: () => {},
    mergePreparedAttachments: (payload, sessionId) => calls.toasts.push({ attached: payload, sessionId }),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    now: () => 10_000,
    windowRef: null,
  });
  const flushTimers = () => { while (timers.length) timers.shift()(); };
  return { ide, docs, calls, files, failures, bridge, instance, flushTimers, editorHost, change: (payload) => changeListener && changeListener(payload) };
}

function finish(h) {
  h.instance.dispose();
  outside.clearMeta();
}

test('createIdeOutsideFiles opens an outside item as a tab keyed outside://<id>/<name>', async () => {
  const h = harness();
  assert.equal(await h.instance.open(item()), true);
  assert.deepEqual(h.ide.openTabs.map((tab) => tab.path), [KEY]);
  assert.equal(h.ide.activeTabPath, KEY);
  assert.equal(h.docs.get(KEY).content, 'hello');
  assert.deepEqual(h.calls.activate, [KEY]);
  const meta = outside.describe(KEY);
  assert.equal(meta.dirLabel, DIR);
  assert.equal(meta.fullPath, `${DIR}\\notes.md`);
  assert.equal(meta.encoding, 'utf-8');
  assert.equal(meta.readOnly, false);
  finish(h);
});

test('opening an already-open item activates it without a second read', async () => {
  const h = harness();
  await h.instance.open(item());
  await h.instance.open(item(ID2, 'b.txt'));
  assert.equal(h.ide.activeTabPath, `outside://${ID2}/b.txt`);
  assert.equal(await h.instance.open(item()), true);
  assert.equal(h.ide.activeTabPath, KEY);
  assert.deepEqual(h.calls.readText, [ID, ID2]);
  finish(h);
});

test('a restore open (activate false) keeps the active tab the user already has', async () => {
  const h = harness();
  await h.instance.open(item());
  await h.instance.open(item(ID2, 'b.txt'), { activate: false });
  assert.equal(h.ide.activeTabPath, KEY);
  assert.equal(h.ide.openTabs.length, 2);
  finish(h);
});

test('a full tab strip refuses before any document is created', async () => {
  const h = harness({ tabCapacity: 1 });
  await h.instance.open(item());
  assert.equal(await h.instance.open(item(ID2, 'b.txt')), false);
  assert.equal(h.docs.size, 1);
  assert.equal(h.calls.readText.length, 1);
  assert.equal(h.calls.errors.length, 1);
  finish(h);
});

test('a failed read shows one error toast and returns false', async () => {
  const h = harness();
  h.failures.readText = { ok: false, code: 'CMP-WORKSPACEFS-0010', message: 'binary' };
  assert.equal(await h.instance.open(item()), false);
  assert.equal(h.docs.size, 0);
  assert.equal(h.ide.openTabs.length, 0);
  assert.equal(h.calls.errors.length, 1);
  assert.match(h.calls.errors[0].message, /notes\.md/);
  finish(h);
});

test('a read-only document opens read-only with one notice and refuses to save', async () => {
  const h = harness({ reads: { [ID]: { editable: false, encoding: 'windows-1252' } } });
  assert.equal(await h.instance.open(item()), true);
  assert.equal(h.docs.get(KEY).readOnly, true);
  assert.equal(h.instance.isReadOnly(KEY), true);
  assert.equal(outside.describe(KEY).readOnly, true);
  assert.equal(h.calls.toasts.length, 1);
  assert.match(h.calls.toasts[0].message, /Read-only: notes\.md uses windows-1252/);
  assert.equal(await h.instance.save(KEY, { content: 'x' }), false);
  assert.equal(h.calls.writeText.length, 0);
  assert.equal(h.calls.toasts.length, 2);
  finish(h);
});

test('save writes the snapshot with the loaded version, updates it and clears the dirty state', async () => {
  const h = harness();
  await h.instance.open(item());
  h.docs.get(KEY).content = 'edited';
  h.docs.get(KEY).dirty = true;
  h.ide.dirtyByPath[KEY] = true;
  assert.equal(await h.instance.save(KEY, { content: 'edited', savedVersionId: 7 }), true);
  assert.deepEqual(h.calls.writeText, [{ id: ID, content: 'edited', expectedFileVersion: 'v1' }]);
  assert.equal(h.docs.get(KEY).dirty, false);
  assert.equal(h.calls.marked[0].options.savedVersionId, 7);
  assert.notEqual(h.ide.staleByPath?.[KEY], true);
  assert.equal(await h.instance.save(KEY, { content: 'again' }), true);
  assert.equal(h.calls.writeText[1].expectedFileVersion, 'saved1');
  finish(h);
});

test('WRITE_CONFLICT marks the tab stale, keeps the buffer and shows the Save Conflict toast', async () => {
  const h = harness();
  await h.instance.open(item());
  h.docs.get(KEY).content = 'edited';
  h.failures.writeText = { ok: false, code: 'CMP-WORKSPACEFS-0020', message: 'File changed on disk since it was loaded.' };
  assert.equal(await h.instance.save(KEY, { content: 'edited' }), false);
  assert.equal(h.ide.staleByPath[KEY], true);
  assert.equal(h.docs.get(KEY).content, 'edited');
  assert.equal(h.calls.errors.length, 1);
  assert.equal(h.calls.errors[0].options.title, 'Save Conflict');
  finish(h);
});

test('a dead grant on save marks the tab stale and says the file is no longer open', async () => {
  const h = harness();
  await h.instance.open(item());
  h.failures.writeText = { ok: false, code: 'CMP-WORKSPACEFS-0017' };
  assert.equal(await h.instance.save(KEY, { content: 'x' }), false);
  assert.equal(h.ide.staleByPath[KEY], true);
  assert.match(h.calls.errors[0].message, /notes\.md is no longer open in Jenny/);
  finish(h);
});

test('reconcile ignores an unchanged version, reloads a clean document and stales a dirty one', async () => {
  const h = harness();
  await h.instance.open(item());
  await h.instance.reconcile({ id: ID, kind: 'changed' });
  assert.equal(h.docs.get(KEY).loads, 1); // same fileVersion: our own echo
  h.files.get(ID).content = 'from disk';
  h.files.get(ID).fileVersion = 'v2';
  await h.instance.reconcile({ id: ID, kind: 'changed' });
  assert.equal(h.docs.get(KEY).content, 'from disk');
  assert.equal(h.docs.get(KEY).loads, 2);
  assert.notEqual(h.ide.staleByPath?.[KEY], true);
  h.docs.get(KEY).dirty = true;
  h.files.get(ID).content = 'again';
  h.files.get(ID).fileVersion = 'v3';
  await h.instance.reconcile({ id: ID, kind: 'changed' });
  assert.equal(h.docs.get(KEY).content, 'from disk');
  assert.equal(h.ide.staleByPath[KEY], true);
  assert.equal(h.calls.toasts.length, 1);
  finish(h);
});

test('reconcile stales on deleted and on a vanished or revoked file, keeping the buffer', async () => {
  const h = harness();
  await h.instance.open(item());
  await h.instance.reconcile({ id: ID, kind: 'deleted' });
  assert.equal(h.ide.staleByPath[KEY], true);
  assert.equal(h.docs.has(KEY), true);
  delete h.ide.staleByPath[KEY];
  h.failures.readText = { ok: false, code: 'CMP-WORKSPACEFS-0004' };
  await h.instance.reconcile({ id: ID, kind: 'changed' });
  assert.equal(h.ide.staleByPath[KEY], true);
  delete h.ide.staleByPath[KEY];
  h.failures.readText = { ok: false, code: 'CMP-WORKSPACEFS-0017' };
  await h.instance.reconcile({ id: ID, kind: 'changed' });
  assert.equal(h.ide.staleByPath[KEY], true);
  assert.equal(h.docs.get(KEY).content, 'hello');
  finish(h);
});

test('the bridge change listener drives reconcile and dispose unsubscribes it', async () => {
  const h = harness();
  await h.instance.open(item());
  h.files.get(ID).content = 'pushed';
  h.files.get(ID).fileVersion = 'v9';
  h.change({ id: ID, kind: 'changed' });
  await settle();
  assert.equal(h.docs.get(KEY).content, 'pushed');
  h.instance.dispose();
  assert.equal(h.change({ id: ID, kind: 'changed' }), null);
  outside.clearMeta();
});

test('revert re-reads the file over a dirty buffer; readDisk leaves the buffer alone', async () => {
  const h = harness();
  await h.instance.open(item());
  h.docs.get(KEY).content = 'edited';
  h.docs.get(KEY).dirty = true;
  h.files.get(ID).content = 'on disk';
  h.files.get(ID).fileVersion = 'v2';
  const disk = await h.instance.readDisk(KEY);
  assert.deepEqual({ ok: disk.ok, content: disk.content }, { ok: true, content: 'on disk' });
  assert.equal(h.docs.get(KEY).content, 'edited');
  const reverted = await h.instance.revert(KEY);
  assert.equal(reverted.ok, true);
  assert.equal(h.docs.get(KEY).content, 'on disk');
  assert.equal(h.docs.get(KEY).dirty, false);
  await h.instance.save(KEY, { content: 'on disk' });
  assert.equal(h.calls.writeText[0].expectedFileVersion, 'v2');
  finish(h);
});

test('the open set is reported with the ids of open outside tabs after open and close', async () => {
  const h = harness();
  await h.instance.open(item());
  await h.instance.open(item(ID2, 'b.txt'));
  h.flushTimers();
  assert.deepEqual(h.calls.setOpenSet.at(-1), [ID, ID2]);
  ideState.closeTab(h.ide, KEY);
  h.instance.closed(KEY);
  h.flushTimers();
  assert.deepEqual(h.calls.setOpenSet.at(-1), [ID2]);
  finish(h);
});

test('revision changes with edits and reset clears the registry', async () => {
  const h = harness();
  await h.instance.open(item());
  const first = h.instance.getRevision(KEY);
  h.docs.get(KEY).alt = 2;
  assert.notEqual(h.instance.getRevision(KEY), first);
  assert.equal(h.instance.getRevision(`outside://${ID2}/nope.md`), null);
  h.instance.reset();
  assert.equal(outside.describe(KEY), null);
  assert.equal(h.instance.getRevision(KEY), null);
  finish(h);
});

test('registry actions delegate to the bound instance and stop after dispose', async () => {
  const h = harness();
  await h.instance.open(item());
  assert.equal((await outside.reveal(KEY)).ok, true);
  assert.equal((await outside.readImage(KEY, 'a.png')).relPath, 'a.png');
  const attached = await h.instance.attachToChat(KEY, 'session-1');
  assert.equal(attached.ok, true);
  assert.equal(h.calls.toasts.at(-1).sessionId, 'session-1');
  h.instance.dispose();
  assert.deepEqual(await outside.reveal(KEY), { ok: false, code: 'outside_files_unavailable' });
  outside.clearMeta();
});

test('an outside key maps to a jenny-outside Monaco URI and both schemes round-trip', () => {
  const key = `outside://${ID}/we ird#na?me.md`;
  const uri = monacoUtils.workspacePathToMonacoUriString(key);
  assert.equal(uri, `jenny-outside:/${ID}/we%20ird%23na%3Fme.md`);
  // Monaco hands back the decoded path.
  assert.equal(monacoUtils.monacoUriToWorkspacePath({ scheme: 'jenny-outside', path: `/${ID}/we ird#na?me.md` }), key);
  assert.equal(monacoUtils.workspacePathToMonacoUriString('src/a b.js'), 'jenny-workspace:/src/a%20b.js');
  assert.equal(monacoUtils.monacoUriToWorkspacePath({ scheme: 'jenny-workspace', path: '/src/a b.js' }), 'src/a b.js');
  assert.equal(monacoUtils.monacoUriToWorkspacePath({ scheme: 'file', path: '/x' }), '');
  assert.equal(monacoUtils.monacoUriToWorkspacePath(null), '');
});

test('openTab and checkTabCapacity pass outside keys through unchanged', () => {
  const ide = ideState.createIdeUiState();
  assert.deepEqual(ideState.checkTabCapacity(ide, KEY), { ok: true });
  ideState.openTab(ide, KEY, {});
  assert.equal(ide.activeTabPath, KEY);
  assert.equal(ideState.toPersistedState(ide).activeTabPath, '');
  assert.deepEqual(ideState.toPersistedState(ide).openTabs, []);
});

// --- the file lifecycle's thin outside branches ---
function lifecycleFor(h) {
  const closedTabs = closedTabsUtils.createIdeClosedTabsStack({ limit: 10 });
  const hygiene = { calls: 0 };
  const lifecycle = createIdeFileLifecycle({
    getIde: () => h.ide,
    ideStateUtils: ideState,
    editorHost: { ...h.editorHost, showEmpty: () => {}, getDocumentKind: () => 'file', getViewState: () => null },
    editorconfig: { forget() {}, reset() {}, dispose() {}, hygieneFor: () => undefined, prepare() {}, apply() {} },
    closedTabs,
    saveHygiene: { applySaveHygiene: () => { hygiene.calls += 1; } },
    outsideFiles: h.instance,
  });
  return { lifecycle, closedTabs, hygiene };
}

test('the lifecycle routes saveFile for an outside key through save hygiene to the instance', async () => {
  const h = harness();
  const { lifecycle, hygiene } = lifecycleFor(h);
  await h.instance.open(item());
  h.docs.get(KEY).content = 'edited';
  assert.equal(await lifecycle.saveFile(KEY), true);
  assert.equal(hygiene.calls, 1);
  assert.deepEqual(h.calls.writeText, [{ id: ID, content: 'edited', expectedFileVersion: 'v1' }]);
  assert.equal(lifecycle.isSaving(), false);
  finish(h);
});

test('a read-only outside file never runs save hygiene: Ctrl+S refuses without editing the buffer', async () => {
  const h = harness({ reads: { [ID]: { editable: false, encoding: 'windows-1252' } } });
  const { lifecycle, hygiene } = lifecycleFor(h);
  await h.instance.open(item());
  assert.equal(await lifecycle.saveFile(KEY), false);
  assert.equal(hygiene.calls, 0);
  assert.equal(h.calls.writeText.length, 0);
  finish(h);
});

test('the lifecycle opens an outside key from its registered item and reopens a closed tab', async () => {
  const h = harness();
  const { lifecycle, closedTabs } = lifecycleFor(h);
  assert.equal(await lifecycle.openFile(`outside://${ID2}/unknown.md`), false); // never registered
  await h.instance.open(item());
  lifecycle.closeTab(KEY);
  assert.equal(h.docs.has(KEY), false);
  assert.equal(h.ide.openTabs.length, 0);
  await lifecycle.reopenClosedTab();
  assert.equal(h.ide.activeTabPath, KEY);
  assert.equal(closedTabs.peek(), null);
  finish(h);
});

test('reopening a closed outside tab whose grant is gone drops the entry without a retry', async () => {
  const h = harness();
  const { lifecycle, closedTabs } = lifecycleFor(h);
  await h.instance.open(item());
  lifecycle.closeTab(KEY);
  h.files.delete(ID);
  await lifecycle.reopenClosedTab();
  assert.equal(closedTabs.peek(), null);
  assert.equal(h.ide.openTabs.length, 0);
  assert.equal(outside.describe(KEY), null);
  finish(h);
});

test('a root change resets the outside registry', async () => {
  const h = harness();
  const { lifecycle } = lifecycleFor(h);
  await h.instance.open(item());
  lifecycle.resetForRoot({ rootId: 'root_b', generation: 2 });
  assert.equal(outside.describe(KEY), null);
  assert.equal(h.instance.getRevision(KEY), null);
  finish(h);
});

test('hot exit never backs up an outside document but still backs up a Workspace one', async () => {
  const writes = [];
  let tick = null;
  let nowMs = 0;
  const ide = { openTabs: [{ path: KEY, kind: 'file' }, { path: 'src/a.js', kind: 'file' }], staleByPath: {} };
  const hot = createIdeHotExit({
    getIde: () => ide,
    editorHost: {
      hasDocument: () => true, isDirty: () => true, getDocumentKind: () => 'file', getAltVersionId: () => 1, getValue: () => 'x',
      getMtime: () => 1, getModel: () => null, isLargeFile: () => false,
    },
    ideStateUtils: {},
    getFileOperations: () => null,
    getBackupApi: () => ({
      write: async (arg) => { writes.push(arg.path); return { ok: true }; },
      remove: async () => ({ ok: true }),
      list: async () => ({ ok: true, entries: [] }),
      read: async () => ({ ok: true, entry: null }),
    }),
    getRootApi: () => ({ captureContext: async () => ({ rootPath: 'C:/w', rootId: 'r', generation: 1, phase: 'ready' }) }),
    getFeatureFlags: () => ({ ide_hot_exit: true }),
    onOpenFile: async () => {}, activateTab: () => {}, showToastMessage: () => {}, appendClientLog: () => {},
    timers: { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {}, now: () => nowMs },
    windowRef: {},
  });
  hot.bind();
  for (let i = 0; i < 4; i += 1) {
    nowMs += 2000;
    tick();
    for (let j = 0; j < 12; j += 1) await Promise.resolve();
  }
  assert.deepEqual(writes, ['src/a.js']);
  hot.dispose();
});
