'use strict';

/* Regression net for the W1-W6 live-app wiring gap: the service registry
 * resolves the IDE controller's dom through surfaceDom.ide.getIdeDom() with
 * NO slice key, while the underlying lazy resolver returns {} without one.
 * Every IDE unit suite hand-builds its own getDom, so only a test that boots
 * the REAL shell (bootstrap-dom + service registry + controller) catches the
 * page rendering as an ideView-only husk: empty activity bar, dead rail,
 * no editor host. */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

test('workspace IDE chrome renders through the real registry dom resolution', async () => {
  const app = await loadRendererApp();
  const { window } = app;
  const doc = window.document;

  try {
    doc.getElementById('ideTopRailTab').click();
    await waitForUi(window, 30);

    const ideView = doc.getElementById('ideView');
    assert.equal(ideView.classList.contains('active-view'), true, 'ide view activates');

    // The workbench only renders its stacks when the controller's getDom
    // actually resolved the ide dom slice (not just ideView): the left stack's
    // Files / Search / Git tabs prove it.
    const leftTabs = doc.querySelectorAll('#ideWorkbench [data-wb-tab="explorer"], #ideWorkbench [data-wb-tab="search"], #ideWorkbench [data-wb-tab="source-control"]');
    assert.equal(leftTabs.length, 3, 'explorer/search/source-control workbench tabs render');

    // The Explorer host holds the explorer tree markup (the harness has no
    // workspaceFs bridge, so the tree renders its unavailable notice - the
    // point is that the host element resolved and rendered at all).
    const explorerHost = doc.getElementById('wbView-explorer');
    assert.ok(explorerHost.innerHTML.includes('ide-tree'), 'explorer tree rendered into the Explorer host');
  } finally {
    await app.dispose();
  }
});
