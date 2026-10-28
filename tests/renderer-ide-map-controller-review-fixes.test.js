'use strict';

/* tests/renderer-ide-map-controller-review-fixes.test.js - regression coverage
 * for the 2026-10-22 File Map review fixes in renderer-ide-map-controller.js
 * (search Enter-cycling, committed-root prefs keys, stale blast after a
 * re-render, no auto-rescan loop on error, hidden-map rescans, hover no-op
 * re-selection, timing-insensitive render signature, drag-release clicks).
 * Reuses tests/helpers/ide-map-controller-harness.js; always dispose via
 * t.after(), never dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');

const ctrlUtils = require('../renderer/features/renderer-ide-map-controller-utils');
const realIdeState = require('../renderer/features/renderer-ide-state');
const {
  setupDom, makeSpies, stubSiblings, graphA, graphB, okResult,
  windowStubFor, makeController, mountAndScan, settle, fakeStorage,
} = require('./helpers/ide-map-controller-harness');

function controlsDepsOf(spies) {
  return spies.controlsDepsList[spies.controlsDepsList.length - 1];
}

function manualTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    timers: {
      setTimeout(fn) { const id = nextId; nextId += 1; pending.set(id, fn); return id; },
      clearTimeout(id) { pending.delete(id); },
    },
    flushAll() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
  };
}

test('search: repeated Enter with the same query cycles through the matches', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);

  const deps = controlsDepsOf(spies);
  deps.onSearchChange('.js');
  spies.selectionCalls.length = 0;
  deps.onSearchSubmit('.js');
  deps.onSearchSubmit('.js');
  deps.onSearchSubmit('.js');
  const picked = spies.selectionCalls.map(([id]) => id);
  assert.equal(new Set(picked).size, 3, `Enter must advance through the matches (got ${picked.join(', ')})`);
});

test('root commit: the remounted transform and prefs key on the COMMITTED rootId, not the lagging state root', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const transformOpts = [];
  const restore = stubSiblings(globalThis, spies, {
    transform: {
      createMapTransform: (opts) => {
        transformOpts.push(opts);
        return {
          setBounds: () => {}, fitToContent: () => true, reclampToBounds: () => {},
          getState: () => ({ scale: 1, tx: 0, ty: 0 }), panTo: () => {},
          subscribe: () => () => {}, clientToContent: (p) => p, dispose: () => {},
        };
      },
    },
  });
  t.after(() => restore());
  const storage = fakeStorage();
  // The state accessor lags: it still reports root_a after the commit.
  const ctrl = makeController(hostEl, { storage });
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);

  ctrl.handleWorkspaceRootCommitted({ context: { rootId: 'root_b', generation: 2 } });
  await settle();
  assert.equal(transformOpts.at(-1).workspaceId, 'root_b', 'transform persistence keyed by the committed root');
  controlsDepsOf(spies).onLayerToggle('health', true);
  assert.ok(storage.getItem('jenny.fileMap.prefs.root_b'), 'prefs persisted under the committed root');
  assert.equal(storage.getItem('jenny.fileMap.prefs.root_a'), null, 'nothing written under the stale root');
});

test('a non-skipped re-render resets a stale blast radius (Escape no longer swallowed by it)', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const stages = [];
  const ctrl = makeController(hostEl, {
    windowRef: windowStubFor(graphA(), { refresh: async () => okResult(graphB()) }),
    activateStage: (stage) => stages.push(stage),
  });
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);

  ctrl.showBlastRadius('a.js');
  controlsDepsOf(spies).onRefresh();
  await settle();
  assert.equal(spies.renderAtlasCalls.length, 2, 'the changed graph re-rendered (view spotlight wiped)');

  const viewportEl = hostEl.querySelector('.ide-map-viewport');
  const win = hostEl.ownerDocument.defaultView;
  viewportEl.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(stages, ['editor'], 'Escape exits instead of clearing an already-wiped blast');
});

test('an error result does not auto-rescan on every later visibility sync', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  let reads = 0;
  const ctrl = makeController(hostEl, {
    windowRef: { jennyShell: { workspaceFileMap: {
      getGraph: async () => { reads += 1; return { ok: false, reason: 'boom', message: 'boom' }; },
    } } },
  });
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);
  assert.equal(reads, 1);

  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  ctrl.openFileMap();
  await settle();
  assert.equal(reads, 1, 'renders after a failed scan must not start new full scans');

  // An explicit Retry still scans.
  controlsDepsOf(spies).onGenerate();
  await settle();
  assert.equal(reads, 2);
});

test('a hidden map defers watcher rescans and git repaints until it is visible again', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const fake = manualTimers();
  let onChange = null;
  let onGit = null;
  let refreshes = 0;
  let gitReads = 0;
  const ctrl = makeController(hostEl, {
    timers: fake.timers,
    windowRef: { jennyShell: {
      workspaceFileMap: {
        getGraph: async () => okResult(graphA()),
        refresh: async () => { refreshes += 1; return okResult(graphA()); },
      },
      workspaceFs: { onChange: (fn) => { onChange = fn; return () => {}; } },
    } },
    getGitDecoration: () => { gitReads += 1; return null; },
    subscribeGitChange: (fn) => { onGit = fn; return () => {}; },
  });
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);

  ctrl.syncVisibility('src/other.js');
  gitReads = 0;
  onChange({ context: { rootId: 'root_a', generation: 1 }, changes: [{ relPath: 'a.js' }] });
  onChange({ context: { rootId: 'root_a', generation: 1 }, changes: [{ relPath: 'b.js' }] });
  onGit();
  fake.flushAll();
  await settle();
  assert.equal(refreshes, 0, 'no rescan while the map is hidden');
  assert.equal(gitReads, 0, 'no git decoration pass while hidden');

  ctrl.syncVisibility(realIdeState.MAP_TAB_ID);
  await settle();
  fake.flushAll();
  await settle();
  assert.equal(refreshes, 1, 'exactly one catch-up rescan once visible');
  assert.ok(gitReads > 0, 'git decorations repainted once visible');
});

test('hovering the same node twice does not rebuild the selection', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const ctrl = makeController(hostEl);
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);

  const contentEl = hostEl.querySelector('.ide-map-content');
  const doc = hostEl.ownerDocument;
  const tile = doc.createElement('button');
  tile.dataset.mapNode = 'a.js';
  contentEl.appendChild(tile);
  spies.selectionCalls.length = 0;
  tile.dispatchEvent(new doc.defaultView.MouseEvent('mouseover', { bubbles: true }));
  tile.dispatchEvent(new doc.defaultView.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(spies.selectionCalls.length, 1, 'the second hover of the selected node is a no-op');
});

test('a pan released over a tile does not open the file', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const opened = [];
  const fake = manualTimers();
  const ctrl = makeController(hostEl, { onOpenFile: (id) => opened.push(id), timers: fake.timers });
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);

  const contentEl = hostEl.querySelector('.ide-map-content');
  const win = hostEl.ownerDocument.defaultView;
  const tile = hostEl.ownerDocument.createElement('button');
  tile.dataset.mapNode = 'a.js';
  contentEl.appendChild(tile);
  tile.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
  tile.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 60, clientY: 40 }));
  tile.dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: 60, clientY: 40 }));
  assert.deepEqual(opened, [], 'a drag release is a pan, not an open');

  // A pointerup with no click (released elsewhere) must not poison a later
  // keyboard-generated click once the release settles.
  tile.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
  tile.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 90, clientY: 90 }));
  fake.flushAll();
  tile.dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: 0, clientY: 0 }));
  assert.deepEqual(opened, ['a.js']);
});

test('render signature ignores volatile scan timing fields', () => {
  const a = graphA();
  const b = graphA();
  a.meta = { durationMs: 12, total: 4, enumeration: { elapsedMs: 3, filesScanned: 4 } };
  b.meta = { durationMs: 95, total: 4, enumeration: { elapsedMs: 41, filesScanned: 4 } };
  assert.equal(ctrlUtils.computeGraphRenderSignature(a), ctrlUtils.computeGraphRenderSignature(b));
  b.meta.enumeration.filesScanned = 5;
  assert.notEqual(ctrlUtils.computeGraphRenderSignature(a), ctrlUtils.computeGraphRenderSignature(b));
});

test('rankSearchMatches caps the ranked list while keeping best-first order', () => {
  const nodes = [];
  for (let i = 0; i < 1200; i += 1) nodes.push({ id: `dir/file${String(i).padStart(4, '0')}.js` });
  nodes.push({ id: 'zzz/match.js' });
  const ranked = ctrlUtils.rankSearchMatches(nodes, 'file');
  assert.equal(ranked.length, 500);
  assert.equal(ranked[0], 'dir/file0000.js');
  assert.equal(ranked[499], 'dir/file0499.js');
});

test('refreshActivity after an active-chat switch releases a layout freeze held by the old chat', async (t) => {
  const { createMapActivityBus } = require('../renderer/features/renderer-ide-map-activity-bus');
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const bus = createMapActivityBus({ getRootPath: () => 'C:\\dev\\jenny', now: () => 1000 });
  t.after(() => bus.dispose());
  let session = 'sess1';
  const ctrl = makeController(hostEl, {
    activityBus: bus,
    getActiveSessionId: () => session,
    windowRef: windowStubFor(graphA(), { refresh: async () => okResult(graphB()) }),
  });
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);

  bus.ingest({ type: 'tool_use', streamId: 's1', sessionId: 'sess1', callId: 'c1', toolName: 'read_file', input: { path: 'a.js' } });
  controlsDepsOf(spies).onRefresh();
  await settle();
  assert.equal(spies.renderAtlasCalls.length, 1, 'the rescan is held while sess1 works');

  session = 'sess2';
  ctrl.refreshActivity();
  assert.equal(spies.renderAtlasCalls.length, 2, 'the idle chat releases the freeze and the held scan applies');
});
