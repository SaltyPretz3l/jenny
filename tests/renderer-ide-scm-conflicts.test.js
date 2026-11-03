'use strict';

// Row 75: the conflict helpers (kind, marker count, resolver) plus their
// wiring through the status store and the git feature.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  conflictKindOf,
  countConflictBlocks,
  createConflictResolver,
} = require('../renderer/features/renderer-ide-scm-conflicts');
const { createIdeGitStatusStore } = require('../renderer/features/renderer-ide-git-status-store');
const { createIdeGitFeature } = require('../renderer/features/renderer-ide-git-feature');

test('conflictKindOf reads the porcelain XY pair', () => {
  const kind = (index, worktree) => conflictKindOf({ index, worktree, state: 'conflicted' });
  assert.equal(kind('U', 'U'), 'UU');
  assert.equal(kind('A', 'A'), 'AA');
  assert.equal(kind('D', 'D'), 'DD');
  assert.equal(kind('U', 'D'), 'UD');
  assert.equal(kind('D', 'U'), 'DU');
  assert.equal(kind('A', 'U'), 'AU');
  assert.equal(kind('U', 'A'), 'UA');
  assert.equal(kind('', ''), 'UU', 'an unknown pair falls back to both-edited');
});

test('countConflictBlocks counts start markers at line starts only (LF and CRLF)', () => {
  const block = '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n';
  assert.equal(countConflictBlocks(''), 0);
  assert.equal(countConflictBlocks('plain text\n'), 0);
  assert.equal(countConflictBlocks(block), 1);
  assert.equal(countConflictBlocks(`a\n${block}b\n${block}`), 2);
  assert.equal(countConflictBlocks(block.replace(/\n/g, '\r\n') + block.replace(/\n/g, '\r\n')), 2);
  assert.equal(countConflictBlocks('<<<<<<<\nbare start marker\n'), 1, 'a bare marker line counts');
  assert.equal(countConflictBlocks('<<<<<<<< eight\n'), 0, 'eight angle brackets is not a marker');
  assert.equal(countConflictBlocks('x <<<<<<< inline\n'), 0, 'mid-line text is not a marker');
  assert.equal(countConflictBlocks(null), 0);
  // A half-edited block (start line removed) still counts by its end marker.
  assert.equal(countConflictBlocks('mine\n=======\ntheirs\n>>>>>>> other\n'), 1);
  assert.equal(countConflictBlocks(`${block}x\n>>>>>>> stray\n`), 2, 'the larger of start and end counts');
});

function resolverHarness(over = {}) {
  const calls = { stage: [], resolveDelete: [], confirm: [], toast: [], closeTab: [] };
  const store = {
    resolveDelete: async (payload) => { calls.resolveDelete.push(payload); return over.deleteResult || { ok: true }; },
  };
  const resolver = createConflictResolver({
    store,
    getWorkspaceFsApi: () => (over.noFs ? null : {
      readFile: async ({ path }) => {
        if (over.readThrows) throw Object.assign(new Error('unreadable'), { code: over.readCode || '' });
        return { path, content: over.content != null ? over.content : 'clean\n' };
      },
    }),
    confirmDialog: { confirm: async (cfg) => { calls.confirm.push(cfg); return over.confirm !== false; } },
    editorHost: { hasDocument: () => over.open === true, isDirty: () => over.dirty === true },
    getFileLifecycle: () => ({ closeTab: (path) => calls.closeTab.push(path) }),
    stage: async (paths) => { calls.stage.push(paths); return { ok: true }; },
    toast: (message, key) => calls.toast.push({ message, key }),
  });
  return { resolver, calls };
}

test('resolve stages a file with no markers left', async () => {
  const { resolver, calls } = resolverHarness();
  const result = await resolver.resolve('src/a.js');
  assert.deepEqual(calls.stage, [['src/a.js']]);
  assert.equal(result.ok, true);
});

test('resolve asks instead of staging when markers remain', async () => {
  const { resolver, calls } = resolverHarness({ content: '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n<<<<<<< HEAD\nc\n=======\nd\n>>>>>>> x\n' });
  const result = await resolver.resolve('src/a.js');
  assert.deepEqual(result, { needsConfirm: true, count: 2 });
  assert.deepEqual(calls.stage, []);
});

test('resolve skips the guard and stages when the file cannot be read as text', async () => {
  for (const over of [{ readThrows: true }, { noFs: true }]) {
    const { resolver, calls } = resolverHarness(over);
    await resolver.resolve('img/logo.png');
    assert.deepEqual(calls.stage, [['img/logo.png']]);
  }
});

test('resolveDelete confirms first, then calls the store; cancel does nothing', async () => {
  const cancelled = resolverHarness({ confirm: false });
  assert.equal(await cancelled.resolver.resolveDelete('docs/billing.md'), false);
  assert.equal(cancelled.calls.confirm.length, 1);
  assert.equal(cancelled.calls.confirm[0].title, 'Delete billing.md?');
  assert.equal(cancelled.calls.confirm[0].variant, 'danger');
  assert.equal(cancelled.calls.confirm[0].message, 'This moves billing.md to the recycle bin and marks the conflict resolved.');
  assert.deepEqual(cancelled.calls.resolveDelete, []);

  const approved = resolverHarness({ open: true });
  assert.equal(await approved.resolver.resolveDelete('docs/billing.md'), true);
  assert.deepEqual(approved.calls.resolveDelete, [{ paths: ['docs/billing.md'] }]);
  assert.deepEqual(approved.calls.closeTab, ['docs/billing.md'], 'a clean open tab closes with its file');
});

test('resolveDelete names unsaved edits in an open tab and closes that tab on confirm', async () => {
  const clean = resolverHarness({ open: true });
  await clean.resolver.resolveDelete('docs/billing.md');
  assert.equal(clean.calls.confirm[0].message, 'This moves billing.md to the recycle bin and marks the conflict resolved.',
    'a clean open tab adds no warning');

  const dirty = resolverHarness({ open: true, dirty: true });
  assert.equal(await dirty.resolver.resolveDelete('docs/billing.md'), true);
  assert.equal(dirty.calls.confirm[0].message,
    'This moves billing.md to the recycle bin and marks the conflict resolved. billing.md has unsaved changes in an open tab; they will be discarded.');
  assert.deepEqual(dirty.calls.closeTab, ['docs/billing.md'], 'the warned dirty tab closes without a save prompt');

  const cancelled = resolverHarness({ open: true, dirty: true, confirm: false });
  assert.equal(await cancelled.resolver.resolveDelete('docs/billing.md'), false);
  assert.deepEqual(cancelled.calls.closeTab, [], 'cancel keeps the unsaved tab');

  const refused = resolverHarness({ open: true, dirty: true, deleteResult: { ok: false, reason: 'not_conflicted' } });
  await refused.resolver.resolveDelete('docs/billing.md');
  assert.deepEqual(refused.calls.closeTab, [], 'a failed delete keeps the unsaved tab');
});

test('resolveDelete always confirms and toasts a failure', async () => {

  const ignored = resolverHarness();
  await ignored.resolver.resolveDelete('old/gone.txt', { confirm: false });
  assert.equal(ignored.calls.confirm.length, 1, 'there is no way to skip the confirm');

  const failed = resolverHarness({ deleteResult: { ok: false, reason: 'not_conflicted' } });
  assert.equal(await failed.resolver.resolveDelete('docs/billing.md'), false);
  assert.equal(failed.calls.toast.length, 1);
  assert.match(failed.calls.toast[0].message, /Could not delete billing\.md to resolve the conflict\./);

  const specific = resolverHarness({ deleteResult: { ok: false, reason: 'trash_unavailable', message: 'The recycle bin isn’t reachable.' } });
  await specific.resolver.resolveDelete('docs/billing.md');
  assert.equal(specific.calls.toast[0].message, 'The recycle bin isn’t reachable.', 'the helper’s own cause wins');

  const raw = resolverHarness({ deleteResult: { ok: false, reason: 'git_failed', message: 'fatal: Unable to create index.lock\nAnother git process' } });
  await raw.resolver.resolveDelete('docs/billing.md');
  assert.match(raw.calls.toast[0].message, /Could not delete billing\.md/, 'raw git text is never shown');
});

test('the status store exposes resolveDelete as a refreshing mutation', async () => {
  const calls = [];
  const client = {
    getStatus: async () => { calls.push('getStatus'); return { ok: true, available: true, isRepo: true, branch: 'main', files: [], summary: {} }; },
    resolveDelete: async (payload) => { calls.push(['resolveDelete', payload]); return { ok: true }; },
  };
  const store = createIdeGitStatusStore({ client, debounceMs: 0, minIntervalMs: 0 });
  const result = await store.resolveDelete({ paths: ['a.txt'] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ['resolveDelete', { paths: ['a.txt'] }]);
  assert.ok(calls.includes('getStatus'), 'a successful mutation refreshes status');
  store.dispose();
});

test('the git feature wires conflicted-row clicks to openFile and Mark resolved through the marker guard', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="wbView-source-control"></div></body>');
  const panelEl = dom.window.document.getElementById('wbView-source-control');
  const snapshot = {
    available: true, isRepo: true, branch: 'main',
    files: [{ path: 'src/a.js', index: 'U', worktree: 'U', state: 'conflicted', staged: true }],
  };
  const staged = [];
  const opened = [];
  const store = {
    getSnapshot: () => snapshot,
    getBranch: () => 'main', getDirtyCount: () => 1, getDecoration: () => 'conflicted', getFolderRollup: () => null,
    isRepo: () => true, isAvailable: () => true,
    stage: async (payload) => { staged.push(payload); return { ok: true }; },
    refresh: () => {}, refreshNow: () => Promise.resolve(), subscribe: () => () => {}, dispose: () => {},
  };
  const feature = createIdeGitFeature({
    store,
    getIde: () => ({ openTabs: [], railPanel: 'source-control' }),
    getMountEl: () => panelEl,
    getWorkspaceFsApi: () => ({ readFile: async () => ({ content: '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n' }) }),
    openFile: (path) => opened.push(path),
  });
  feature.bindEvents();
  feature.renderPanel();
  panelEl.querySelector('[data-ide-scm-action="open-conflict"]').click();
  assert.deepEqual(opened, ['src/a.js']);

  panelEl.querySelector('[data-ide-scm-action="resolve"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(staged, [], 'markers left -> not staged');
  assert.match(panelEl.querySelector('.ide-scm-row-confirm').textContent, /1 conflict block/);
  panelEl.querySelector('[data-ide-scm-action="confirm-resolve"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(staged, [{ paths: ['src/a.js'] }]);
  feature.dispose();
});

test('resolve still stages a file over the read cap and remembers it is too large to check', async () => {
  const { resolver, calls } = resolverHarness({ readThrows: true, readCode: 'CMP-WORKSPACEFS-0011' });
  assert.equal(resolver.isTooLargeToCheck('logs/huge.log'), false);
  await resolver.resolve('logs/huge.log');
  assert.deepEqual(calls.stage, [['logs/huge.log']]);
  assert.equal(resolver.isTooLargeToCheck('logs/huge.log'), true);
});

function featureWithConflict(fsApi) {
  const dom = new JSDOM('<!doctype html><body><div id="wbView-source-control"></div></body>');
  const panelEl = dom.window.document.getElementById('wbView-source-control');
  const snapshot = {
    available: true, isRepo: true, branch: 'main',
    files: [{ path: 'logs/huge.log', index: 'U', worktree: 'U', state: 'conflicted', staged: true }],
  };
  const staged = [];
  const store = {
    getSnapshot: () => snapshot,
    getBranch: () => 'main', getDirtyCount: () => 1, getDecoration: () => 'conflicted', getFolderRollup: () => null,
    isRepo: () => true, isAvailable: () => true,
    stage: async (payload) => { staged.push(payload); return { ok: true }; },
    refresh: () => {}, refreshNow: () => Promise.resolve(), subscribe: () => () => {}, dispose: () => {},
  };
  const feature = createIdeGitFeature({
    store,
    getIde: () => ({ openTabs: [], railPanel: 'source-control' }),
    getMountEl: () => panelEl,
    getWorkspaceFsApi: () => fsApi,
    openFile: () => {},
  });
  feature.bindEvents();
  feature.renderPanel();
  return { panelEl, feature, staged };
}

const ticks = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('a conflicted file over the read cap says so on its row; Mark resolved still stages it', async () => {
  const { panelEl, feature, staged } = featureWithConflict({
    stat: async ({ path }) => ({ path, exists: true, kind: 'file', size: 6 * 1024 * 1024 }),
    readFile: async () => { throw Object.assign(new Error('too large'), { code: 'CMP-WORKSPACEFS-0011' }); },
  });
  await ticks();
  const note = panelEl.querySelector('[data-ide-scm-conflict-note]');
  assert.ok(note, 'the row carries a note');
  assert.equal(note.textContent.trim(), 'Too large to check for conflict markers.');
  assert.equal(note.closest('[data-ide-scm-confirm-path]'), null, 'the note is not a confirm');
  panelEl.querySelector('[data-ide-scm-action="resolve"]').click();
  await ticks();
  assert.deepEqual(staged, [{ paths: ['logs/huge.log'] }]);
  feature.dispose();
});

test('a conflicted file under the read cap shows no size note', async () => {
  const { panelEl, feature } = featureWithConflict({
    stat: async ({ path }) => ({ path, exists: true, kind: 'file', size: 1024 }),
    readFile: async () => ({ content: 'clean\n' }),
  });
  await ticks();
  assert.equal(panelEl.querySelector('[data-ide-scm-conflict-note]'), null);
  feature.dispose();
});

test('panel re-renders do not re-stat a conflicted file inside the probe interval', async () => {
  let stats = 0;
  const { feature } = featureWithConflict({
    stat: async ({ path }) => { stats += 1; return { path, exists: true, kind: 'file', size: 6 * 1024 * 1024 }; },
    readFile: async () => ({ content: '' }),
  });
  await ticks();
  feature.renderPanel(); // a status refresh re-renders the panel
  feature.renderPanel();
  await ticks();
  assert.equal(stats, 1);
  feature.dispose();
});
