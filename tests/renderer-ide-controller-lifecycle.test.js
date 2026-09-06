'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers/renderer-ide-harness');

// The git status store debounces its pull by 120 ms
// (renderer-ide-git-status-store.js, and this harness does not override it), so
// a fixed sleep shorter than that is a race the test can only win when the
// event loop is busy enough to slip its own timer past the debounce — which is
// why this file passed inside the parallel suite and failed when run alone on
// an idle machine. Poll the condition the assertion is actually about, with a
// deadline far above the debounce, so neither machine load nor future renderer
// work can re-break it.
async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), message);
}

test('wide-033: IDE activation resolving after dispose cannot restart root-bound services', async () => {
  const harness = createHarness();
  let resolveHydrate;
  harness.bridge.jennyShell.workspaceIde.getState = () => new Promise((resolve) => {
    resolveHydrate = resolve;
  });
  const activation = harness.controller.activateIde();
  await Promise.resolve();
  harness.dispose();
  resolveHydrate({
    ok: true,
    context: {
      rootPath: 'G:/fake-root', rootId: 'root_fake', generation: 0, phase: 'ready',
    },
    openTabs: [],
    activeTabPath: '',
    expandedDirs: [],
  });
  await activation;
  assert.equal(harness.bridge.calls.watchStart.length, 0,
    'a late activation cannot restart the watcher after teardown');
});

test('JCA-001/002/005: a committed root transition resets git state and broadcasts to the composer singletons', async () => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'body' },
      git: {
        branch: 'root-a',
        files: [{ path: 'src/app.js', index: ' ', worktree: 'M', state: 'modified' }],
      },
    },
  });
  try {
    await harness.controller.activateIde();
    // Initial debounced git pull.
    await waitFor(() => harness.bridge.calls.gitGetStatus.length >= 1,
      'the git slice pulled status for root A');
    const baseline = harness.bridge.calls.gitGetStatus.length;

    const rootEvents = [];
    harness.dom.window.addEventListener('ide:workspace-root-committed', (event) => {
      rootEvents.push(event.detail && event.detail.context);
    });

    // Advance the bridge stub to root B so persistence hydration sees a
    // matching (non-stale) context for the committed transition.
    harness.bridge.state.rootPath = 'G:/root-b';
    harness.bridge.state.rootGeneration = 2;
    await harness.controller.handleWorkspaceRootCommitted({
      context: { rootPath: 'G:/root-b', rootId: 'root_fake', generation: 2, phase: 'ready' },
    });
    await waitFor(() => harness.bridge.calls.gitGetStatus.length > baseline,
      'the root commit re-pulls git status for the new root instead of waiting for a watcher event');
    assert.equal(rootEvents.length, 1, 'the controller broadcasts the committed transition on the window');
    assert.equal(rootEvents[0].rootPath, 'G:/root-b');
  } finally {
    harness.dispose();
  }
});

test('wide-033: a committed-root notification after dispose is a complete no-op', async () => {
  const harness = createHarness();
  let hydrateCalls = 0;
  harness.state.ui.ide = {};
  harness.state.ui.ide.openTabs = ['keep.js'];
  harness.state.ui.ide.activeTabPath = 'keep.js';
  harness.bridge.jennyShell.workspaceIde.getState = () => {
    hydrateCalls += 1;
    throw new Error('disposed root commit must not hydrate');
  };
  harness.dispose();
  await harness.controller.handleWorkspaceRootCommitted({
    context: { rootPath: 'G:/new-root', rootId: 'root_new', generation: 2, phase: 'ready' },
  });
  assert.equal(harness.bridge.calls.watchStart.length, 0,
    'a disposed controller cannot restart root-bound children');
  assert.equal(hydrateCalls, 0, 'a disposed controller cannot begin persistence hydration');
  assert.deepEqual(harness.state.ui.ide.openTabs, ['keep.js'],
    'a disposed controller cannot clear the existing tab state');
  assert.equal(harness.state.ui.ide.activeTabPath, 'keep.js');
});

test('external watcher changes refresh Changes while it is active in the secondary sidebar', async () => {
  const harness = createHarness();
  try {
    await harness.controller.activateIde();
    const ide = harness.state.ui.ide;
    ide.panelLocations.changes = 'secondary';
    ide.railPanel = 'explorer';
    ide.secondaryPanel = 'changes';
    ide.secondaryPanelOpen = true;
    harness.controller.renderIde();

    const mount = harness.getDom().ideSecondarySidebarPanel;
    mount.innerHTML = 'STALE CHANGES';
    mount.__jennyIdeRailMarkup = 'stale-marker';
    harness.bridge.emitChange({ changes: [{ relPath: 'external.js', kind: 'changed' }] });

    assert.notEqual(mount.innerHTML, 'STALE CHANGES', 'the active secondary Changes panel repaints');
    assert.match(mount.innerHTML, /ide-changes/);
  } finally {
    harness.dispose();
  }
});
