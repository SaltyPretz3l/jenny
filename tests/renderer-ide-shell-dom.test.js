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

    // The rail activity bar only renders when the controller's getDom
    // actually resolved the ide dom slice (not just ideView).
    const activityButtons = doc.querySelectorAll('#ideActivityBar [data-ide-rail-panel]');
    assert.equal(activityButtons.length, 4, 'explorer/search/changes/source-control activity buttons render');

    // The rail panel hosts the explorer tree markup (the harness has no
    // workspaceFs bridge, so the tree renders its unavailable notice - the
    // point is that the panel element resolved and rendered at all).
    const railPanel = doc.getElementById('ideRailPanel');
    assert.ok(railPanel.innerHTML.includes('ide-tree'), 'explorer tree rendered into the rail panel');
  } finally {
    await app.dispose();
  }
});
