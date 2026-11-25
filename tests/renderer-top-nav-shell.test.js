const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options = {}) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('the rail shows unconditionally and drives view switching with full-bleed views', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const workspace = doc.getElementById('workspace');
  await waitForUi(window, 60);

  assert.equal(doc.getElementById('topRail').classList.contains('hidden'), false, 'rail visible after boot');
  assert.equal(doc.documentElement.dataset.topNavShell, 'true', 'flip data attribute set');
  const tabs = [...doc.querySelectorAll('#topRailTabs .toprail-tab')];
  assert.deepEqual(tabs.map((tab) => tab.dataset.tabId), ['home', 'chat', 'ide']);
  const gear = doc.getElementById('settingsTopRailTab');
  assert.ok(gear?.closest('.titlebar-status'), 'Settings is the gear in the right cluster, not a tab');
  const artifactToggle = doc.getElementById('artifactSplitViewToggle');
  const healthButton = doc.getElementById('workbenchHealthPillButton');
  assert.equal(window.__rendererState.ui.activeView, 'chat');
  assert.equal(artifactToggle.parentElement, doc.getElementById('chatTimelineUtilityCluster'), 'artifact action belongs to the chat utility cluster');
  assert.equal(artifactToggle.hidden, false, 'artifact action is available in the initial Chat view');
  assert.ok(healthButton, 'runtime health remains available in the titlebar');
  assert.ok(healthButton.closest('.titlebar-status'), 'runtime health is the dot in the right cluster');
  assert.equal(doc.getElementById('topRailActions'), null, 'the dead rail action mount is gone');

  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.activeView, 'logs');
  assert.equal(workspace.classList.contains('panel-none'), true, 'logs renders full-bleed');
  assert.equal(doc.getElementById('logsTopRailTab').getAttribute('aria-current'), 'page');
  assert.ok(doc.getElementById('logsTopRailTab').closest('.titlebar-status'), 'Diagnostics is a glyph in the right cluster, not a tab');
  assert.equal(artifactToggle.hidden, true, 'artifact action stays hidden in Diagnostics');
  assert.equal(healthButton.hidden, false, 'runtime health remains available in Diagnostics');

  doc.getElementById('chatTopRailTab').click();
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.activeView, 'chat');
  assert.equal(workspace.classList.contains('panel-none'), true, 'chat renders full-bleed: its Chats list is a workbench stack');
  assert.equal(doc.getElementById('chatTopRailTab').getAttribute('aria-selected'), 'true');
  assert.equal(artifactToggle.hidden, false, 'artifact action appears in Chat');
  assert.equal(artifactToggle.getAttribute('aria-pressed'), 'false', 'view changes preserve artifact pressed state');
  assert.equal(healthButton.hidden, false, 'runtime health remains available in Chat');
});

// UIUX-038 (Artifacts view aria-labelledby / focus landing) was deleted in
// W1-5: the Artifacts studio view no longer exists, so the dangling-reference
// concern it guarded is void. The review panel carries its own labels.

// Row 175 F11: the Team project page's Boards line opens the Board tab through the shell.
test('openBoardView: false while the Board flag is off, a dry ask never switches, and the call shows the Board view', async (t) => {
  const { window } = await loadRendererTestApp(t);
  await waitForUi(window, 60);
  const controller = window.rendererTopNavShellController;
  const state = window.__rendererState;
  state.features.featureFlags.project_boards = false;
  assert.equal(controller.openBoardView(), false);
  assert.equal(state.ui.activeView, 'chat');
  state.features.featureFlags.project_boards = true;
  assert.equal(controller.openBoardView({ dry: true }), true);
  assert.equal(state.ui.activeView, 'chat', 'a dry ask changes nothing');
  assert.equal(controller.openBoardView(), true);
  assert.equal(state.ui.activeView, 'board');
});
