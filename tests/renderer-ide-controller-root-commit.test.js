'use strict';

/* IDE controller review fixes: root-commit ordering (root-owned qol/welcome
 * state clears before the hydrate await), restore opens that keep a restored
 * stage surface, live tabs kept across a root hydrate, canonical reveal, and
 * tab switches that never drop a pending auto-save. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, settle } = require('./helpers/renderer-ide-harness');

const ROOT_B = Object.freeze({ rootPath: 'G:/root-b', rootId: 'root_fake', generation: 2, phase: 'ready' });

function withGlobalModule(name, value, t) {
  const previous = globalThis[name];
  globalThis[name] = value;
  t.after(() => {
    if (previous === undefined) delete globalThis[name];
    else globalThis[name] = previous;
  });
}

function advanceToRootB(harness) {
  harness.bridge.state.rootPath = ROOT_B.rootPath;
  harness.bridge.state.rootGeneration = ROOT_B.generation;
  // Reads report the committed root's id, so opens after the commit are current.
  const fs = harness.bridge.jennyShell.workspaceFs;
  const readText = fs.readText.bind(fs);
  fs.readText = async (payload) => ({ ...(await readText(payload)), rootId: ROOT_B.rootId });
}

// In the browser the editor host's global IS the window, so its
// ide:active-file-changed event reaches the stage-surface listener too.
function forwardGlobalEvents(harness, t) {
  globalThis.dispatchEvent = (event) => harness.dom.window.dispatchEvent(
    new harness.dom.window.CustomEvent(event.type, { detail: event.detail })
  );
  t.after(() => { delete globalThis.dispatchEvent; });
}

test('a root commit clears root-owned qol state synchronously, before (and without) the hydrate', async (t) => {
  const qolCalls = [];
  withGlobalModule('rendererIdeQolWiring', {
    createIdeQolWiring: () => ({ bindAll() {}, disposeAll() {}, handleWorkspaceRootCommitted: (payload) => qolCalls.push(payload) }),
  }, t);
  const harness = createHarness();
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  advanceToRootB(harness);

  harness.bridge.jennyShell.workspaceIde.getState = () => new Promise(() => {});
  void harness.controller.handleWorkspaceRootCommitted({ context: ROOT_B });
  assert.equal(qolCalls.length, 1, 'map/activity/preview/presentation/explode reset before the hydrate await');
  assert.equal(qolCalls[0].context, ROOT_B);

  harness.bridge.jennyShell.workspaceIde.getState = async () => { throw new Error('hydrate failed'); };
  await harness.controller.handleWorkspaceRootCommitted({ context: { ...ROOT_B, generation: 3 } }).catch(() => {});
  assert.equal(qolCalls.length, 2, 'a failed hydrate still reset the root-owned qol state');
});

test('a root commit drops the old root recent files from the welcome surface', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/old.js': 'old' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  assert.equal(await harness.controller.openFile('src/old.js'), true);
  const recentRow = () => harness.getDom().ideEmptyState.querySelector('[data-ide-welcome-file="src/old.js"]');

  advanceToRootB(harness);
  await harness.controller.handleWorkspaceRootCommitted({ context: ROOT_B });
  await settle();
  assert.equal(recentRow(), null, 'the new root never lists the old root files');
});

test('a tab opened while the root-commit hydrate is pending survives the hydrate', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/b.js': 'b' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  advanceToRootB(harness);
  let resolveState;
  harness.bridge.jennyShell.workspaceIde.getState = () => new Promise((resolve) => { resolveState = resolve; });

  const commit = harness.controller.handleWorkspaceRootCommitted({ context: ROOT_B });
  assert.equal(await harness.controller.openFileAtLine('src/b.js', 1, 1), true);
  resolveState({ ok: true, context: ROOT_B, openTabs: [], activeTabPath: '', expandedDirs: [] });
  await commit;
  assert.deepEqual(harness.state.ui.ide.openTabs.map((tab) => tab.path), ['src/b.js']);
});

test('restore opens keep a restored preview surface on activation and on a root commit', async (t) => {
  const files = { 'src/a.md': '# a', 'src/b.md': '# b' };
  const persisted = { openTabs: [{ path: 'src/a.md' }], activeTabPath: 'src/a.md', expandedDirs: [], activeStageSurface: 'preview', previewPath: 'src/a.md' };
  const harness = createHarness({ bridgeOptions: { files, persisted } });
  t.after(() => harness.dispose());
  forwardGlobalEvents(harness, t);
  await harness.controller.activateIde();
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'src/a.md');
  assert.equal(harness.state.ui.ide.activeStageSurface, 'preview', 'activation restore keeps the preview stage');

  advanceToRootB(harness);
  await harness.controller.handleWorkspaceRootCommitted({ context: ROOT_B });
  await settle();
  assert.equal(harness.state.ui.ide.activeStageSurface, 'preview', 'root-commit restore keeps the preview stage');

  assert.equal(await harness.controller.openFile('src/b.md'), true);
  assert.equal(harness.state.ui.ide.activeStageSurface, 'editor', 'a real activation afterwards still resets the stage');
});

test('a failed restore open does not swallow the next real activation reset', async (t) => {
  const persisted = { openTabs: [{ path: 'gone.md' }], activeTabPath: 'gone.md', expandedDirs: [], activeStageSurface: 'preview', previewPath: '' };
  const harness = createHarness({ bridgeOptions: { files: { 'src/b.md': '# b' }, persisted } });
  t.after(() => harness.dispose());
  forwardGlobalEvents(harness, t);
  await harness.controller.activateIde();
  await settle();
  assert.equal(harness.state.ui.ide.activeStageSurface, 'preview');
  assert.equal(await harness.controller.openFile('src/b.md'), true);
  assert.equal(harness.state.ui.ide.activeStageSurface, 'editor');
});

test('openFileAtLine with a case-different spelling reveals the line in the canonical document', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/App.js': 'one\ntwo\nthree' } } });
  t.after(() => harness.dispose());
  const fs = harness.bridge.jennyShell.workspaceFs;
  const readText = fs.readText.bind(fs);
  // The workspace resolves the requested spelling to its canonical path (a case-insensitive volume).
  fs.readText = async (payload) => {
    if (payload.path !== 'src/app.js') return readText(payload);
    const result = await readText({ ...payload, path: 'src/App.js' });
    return { ...result, requestedPath: payload.path, requestedPathKey: keyFor(payload.path, result) };
  };
  function keyFor(path, result) {
    return result.pathKey === 'src/App.js' ? path : path.toLowerCase();
  }
  await harness.controller.activateIde();
  assert.equal(await harness.controller.openFileAtLine('src/app.js', 3, 2), true);
  assert.equal(harness.state.ui.ide.activeTabPath, 'src/App.js');
  assert.equal(harness.getDom().ideEditorFallback.selectionStart, 'one\ntwo\n'.length + 1);
});

test('switching or closing a tab never cancels the pending auto-save of the file just edited', async (t) => {
  const calls = { cancel: 0 };
  const real = require('../renderer/features/renderer-ide-auto-save');
  withGlobalModule('rendererIdeAutoSave', {
    createIdeAutoSave: (deps) => ({ ...real.createIdeAutoSave(deps), cancel: () => { calls.cancel += 1; } }),
  }, t);
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'a', 'b.js': 'b' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await harness.controller.openFile('b.js');
  harness.getDom().ideTabStrip.querySelector('[data-ide-tab="a.js"] button')?.click();
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'a.js', 'the tab click activated A');
  harness.getDom().ideTabStrip.querySelector('[data-ide-tab="b.js"] [data-ide-tab-close]')?.click();
  await settle();
  assert.equal(calls.cancel, 0);
});
