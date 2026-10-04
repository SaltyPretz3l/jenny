'use strict';

/* SIM-003: a project-switcher load failure used to vanish and leave an inert
 * Explorer header forever. Failures are logged and a later header paint retries,
 * bounded to three attempts in total. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeExplorerWiring } = require('../renderer/features/renderer-ide-explorer-wiring');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');

async function createHarness({ refresh, openSwitcher }) {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files: { 'a.txt': 'x' } });
  const ide = ideStateUtils.createIdeUiState();
  const logs = [];
  const loader = { calls: 0, loaded: false };
  const switcher = {
    async refresh() {
      loader.calls += 1;
      await refresh(loader.calls);
      loader.loaded = true;
    },
    title: () => (loader.loaded ? 'Alpha' : ''),
    openSwitcher: (anchor) => openSwitcher?.(anchor),
  };
  const wiring = createIdeExplorerWiring({
    getDom: domHarness.getDom,
    getIde: () => ide,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
    openFile: () => {},
    buildFileContextMenuItems: () => [],
    buildPathUtilityMenuItems: () => [],
    schedulePersist: () => {},
    showShellErrorToast: () => {},
    appendClientLog: (level, event, payload) => logs.push({ level, event, payload }),
    getGitFeature: () => null,
    getFeatureFlags: () => ({}),
    panelDeps: () => ({
      getMountEl: () => domHarness.getDom().ideRailPanel,
      isActivePanel: () => true,
    }),
    getProjectSwitcher: () => switcher,
    peekProjectSwitcher: () => switcher,
  });
  wiring.bindAll();
  wiring.tree.refreshRoot();
  await settle(30);
  const panel = domHarness.getDom().ideRailPanel;
  return {
    loader,
    logs,
    wiring,
    panel,
    headerName: () => panel.querySelector('.ide-tree-header-project-name').textContent,
    async paint() {
      wiring.tree.repaintHeader();
      await settle(15);
    },
    dispose() {
      wiring.disposeAll();
      domHarness.dom.window.close();
    },
  };
}

const loadFailures = (harness) => harness.logs.filter((entry) => entry.event === 'ide.explorer.project_switcher_load_failed');

test('a loader that rejects twice is logged each time, then loads and repaints on the third paint', async (t) => {
  const harness = await createHarness({
    refresh: async (call) => { if (call <= 2) throw new Error(`load failed ${call}`); },
  });
  t.after(() => harness.dispose());

  assert.equal(harness.loader.calls, 1, 'the first header paint kicked the load');
  assert.equal(loadFailures(harness).length, 1);
  assert.equal(harness.headerName(), 'Workspace', 'the header is inert until a load succeeds');

  await harness.paint();
  assert.equal(harness.loader.calls, 2, 'a later paint retries');
  assert.equal(loadFailures(harness).length, 2);
  assert.deepEqual(loadFailures(harness)[1], {
    level: 'WARN',
    event: 'ide.explorer.project_switcher_load_failed',
    payload: { message: 'load failed 2' },
  });

  await harness.paint();
  assert.equal(harness.loader.calls, 3);
  assert.equal(loadFailures(harness).length, 2, 'the third attempt did not fail');
  assert.equal(harness.headerName(), 'Alpha', 'the header repaints after the successful load');

  await harness.paint();
  await harness.paint();
  assert.equal(harness.loader.calls, 3, 'a loaded switcher is not loaded again');
});

test('a loader that always rejects is attempted exactly three times', async (t) => {
  const harness = await createHarness({
    refresh: async () => { throw new Error('always down'); },
  });
  t.after(() => harness.dispose());

  for (let i = 0; i < 6; i += 1) await harness.paint();

  assert.equal(harness.loader.calls, 3);
  assert.equal(loadFailures(harness).length, 3);
  assert.equal(harness.headerName(), 'Workspace');
});

test('opening the project menu logs a WARN when the switcher rejects', async (t) => {
  const harness = await createHarness({
    refresh: async () => {},
    openSwitcher: () => { throw new Error('menu exploded'); },
  });
  t.after(() => harness.dispose());

  harness.panel.querySelector('[data-ide-tree-action="project-menu"]').click();
  await settle(15);

  assert.deepEqual(harness.logs.filter((entry) => entry.event === 'ide.explorer.project_menu_failed'), [
    { level: 'WARN', event: 'ide.explorer.project_menu_failed', payload: { message: 'menu exploded' } },
  ]);
});
