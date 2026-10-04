'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, settle } = require('./helpers/renderer-ide-harness');
const { createIdeWatchController } = require('../renderer/features/renderer-ide-watch-controller');

const fileControls = '[data-ide-tree-action="new-file"], [data-ide-tree-action="new-folder"], '
  + '[data-ide-tree-action="cycle-sort"], [data-ide-tree-action="toggle-generated"], '
  + '[data-ide-tree-action="refresh"], [data-ide-tree-action="collapse-all"]';

function setup(t, rootPath, extra = {}) {
  const logs = [];
  const harness = createHarness({
    bridgeOptions: { rootPath, files: { 'a.txt': 'hello' } },
    featureFlags: { workspace_explorer_qol: true },
    extraCallbacks: { appendClientLog: (...args) => logs.push(args) },
    ...extra,
  });
  t.after(() => harness.dispose());
  return { ...harness, logs };
}

function assertRootless(harness) {
  const panel = harness.getDom().ideRailPanel;
  assert.equal(panel.querySelector('.ide-tree-status')?.textContent, 'No folder open');
  const action = panel.querySelector('[data-ide-tree-choose-root]');
  assert.equal(action?.textContent, 'Choose a folder');
  assert.ok(action.classList.contains('ide-tree-choose-root-action'));
  assert.equal(panel.querySelectorAll(fileControls).length, 0);
  assert.equal(panel.querySelectorAll('[data-ide-tree-path]').length, 0);
}

test('rootless Explorer and watch activation do no filesystem work', async (t) => {
  const harness = setup(t, '');
  await harness.controller.activateIde();
  await settle();
  assert.equal(harness.bridge.calls.listDirectory.length, 0, 'rootless Explorer must not listDirectory');
  assert.equal(harness.bridge.calls.watchStart.length, 0, 'rootless activation must not watchStart');
  assertRootless(harness);
  assert.equal(harness.logs.some(([, event]) => /ide\.(tree_list_failed|watch_start_failed)/.test(event)), false);
});

test('configured root lists and watches; choosing then clearing returns to the empty state', async (t) => {
  const harness = setup(t, '');
  await harness.controller.activateIde();
  await settle();
  harness.getDom().ideRailPanel.querySelector('[data-ide-tree-choose-root]').click();
  await settle();
  let context = await harness.bridge.jennyShell.workspaceRoot.captureContext();
  harness.state.workspaceRoot = context;
  await harness.controller.handleWorkspaceRootCommitted({ context });
  await settle();
  assert.ok(harness.bridge.calls.listDirectory.length > 0);
  assert.equal(harness.bridge.calls.watchStart.length, 1);
  assert.ok(harness.getDom().ideRailPanel.querySelector('[data-ide-tree-path="a.txt"]'));
  assert.ok(harness.getDom().ideRailPanel.querySelector(fileControls));
  const listCalls = harness.bridge.calls.listDirectory.length;

  const prepared = await harness.bridge.jennyShell.workspaceRoot.prepareClear();
  ({ context } = await harness.bridge.jennyShell.workspaceRoot.commit(prepared));
  harness.state.workspaceRoot = context;
  await harness.controller.handleWorkspaceRootCommitted({ context });
  await settle();
  assertRootless(harness);
  assert.equal(harness.bridge.calls.listDirectory.length, listCalls);
  assert.equal(harness.bridge.calls.watchStart.length, 1);
});

for (const codeLost of [false, true]) {
  test(`root-missing listing rejection renders the empty state (code lost: ${codeLost})`, async (t) => {
    const harness = setup(t, '/workspace');
    harness.bridge.jennyShell.workspaceFs.listDirectory = async () => {
      const error = new Error('Error invoking remote method: CMP-WORKSPACEFS-0001: No root configured.');
      if (!codeLost) error.code = 'CMP-WORKSPACEFS-0001';
      throw error;
    };
    await harness.controller.activateIde();
    await settle();
    assertRootless(harness);
    assert.equal(harness.logs.some(([, event]) => event === 'ide.tree_list_failed'), false);
  });
}

test('real listing failure keeps its failure message and warning', async (t) => {
  const harness = setup(t, '/workspace');
  harness.bridge.jennyShell.workspaceFs.listDirectory = async () => { throw new Error('Permission denied'); };
  await harness.controller.activateIde();
  await settle();
  assert.equal(harness.getDom().ideRailPanel.querySelector('.ide-tree-status')?.textContent, 'Could not list this folder.');
  assert.equal(harness.logs.filter(([, event]) => event === 'ide.tree_list_failed').length, 1);
});

test('rootless watch start and degraded lifecycle schedule no retry', async (t) => {
  let root = '/workspace';
  let lifecycle;
  let starts = 0;
  const timers = [];
  const watch = createIdeWatchController({
    getWorkspaceFsApi: () => ({
      getRootState: async () => ({ workspaceRoot: root }),
      watchStart: async () => { starts += 1; },
      watchStop: async () => {},
      onWatchLifecycle: (callback) => { lifecycle = callback; return () => {}; },
    }),
    setTimeoutImpl: (callback) => { timers.push(callback); return timers.length; },
    clearTimeoutImpl: () => {},
  });
  t.after(() => watch.stop());
  watch.start();
  await settle();
  assert.equal(starts, 1);
  root = '';
  lifecycle({ phase: 'degraded', reason: 'root cleared' });
  await settle();
  assert.equal(timers.length, 0, 'no retry is scheduled without a root');
  watch.start();
  await settle();
  assert.equal(starts, 1, 'manual rootless activation does not start watching');
});
