const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function readPanelsStore(window) {
  const raw = window.localStorage.getItem('jenny.panels.v2');
  return raw ? JSON.parse(raw) : null;
}

test('the rail shows unconditionally and drives view switching with per-view panels', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const workspace = doc.getElementById('workspace');
  await waitForUi(window, 60);

  assert.equal(doc.getElementById('topRail').classList.contains('hidden'), false, 'rail visible after boot');
  assert.equal(doc.documentElement.dataset.topNavShell, 'true', 'flip data attribute set');
  const tabs = [...doc.querySelectorAll('#topRailTabs .toprail-tab')];
  assert.deepEqual(tabs.map((tab) => tab.dataset.tabId), ['home', 'chat', 'ide', 'logs', 'settings']);
  const artifactToggle = doc.getElementById('artifactSplitViewToggle');
  const healthButton = doc.getElementById('workbenchHealthPillButton');
  assert.equal(window.__rendererState.ui.activeView, 'chat');
  assert.equal(artifactToggle.parentElement, doc.getElementById('chatTimelineUtilityCluster'), 'artifact action belongs to the chat utility cluster');
  assert.equal(artifactToggle.hidden, false, 'artifact action is available in the initial Chat view');
  assert.ok(healthButton, 'runtime health remains available in the titlebar');
  assert.ok(healthButton.closest('.titlebar-brand'), 'runtime health belongs beside the titlebar wordmark');
  assert.equal(doc.getElementById('topRailActions').contains(healthButton), false, 'global rail no longer owns runtime health');

  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.activeView, 'logs');
  assert.equal(workspace.classList.contains('panel-none'), true, 'logs renders full-bleed');
  assert.equal(doc.getElementById('logsTopRailTab').getAttribute('aria-selected'), 'true');
  assert.equal(artifactToggle.hidden, true, 'artifact action stays hidden in Diagnostics');
  assert.equal(healthButton.hidden, false, 'runtime health remains available in Diagnostics');

  doc.getElementById('chatTopRailTab').click();
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.activeView, 'chat');
  assert.equal(workspace.classList.contains('panel-none'), false, 'chat keeps its sessions panel');
  assert.equal(doc.getElementById('chatTopRailTab').getAttribute('aria-selected'), 'true');
  assert.equal(artifactToggle.hidden, false, 'artifact action appears in Chat');
  assert.equal(artifactToggle.getAttribute('aria-pressed'), 'false', 'view changes preserve artifact pressed state');
  assert.equal(healthButton.hidden, false, 'runtime health remains available in Chat');
});

test('the sidebar toggle collapses to the strip and the strip toggle restores; Workspace renders full-bleed', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const workspace = doc.getElementById('workspace');
  await waitForUi(window, 60);

  doc.getElementById('chatTopRailTab').click();
  await waitForUi(window, 40);
  const collapseToggle = doc.getElementById('chatsPanelCollapseToggle');
  assert.ok(collapseToggle, 'the sidebar header mounted the collapse toggle');
  assert.ok(collapseToggle.closest('.sidebar-header-actions'), 'the toggle belongs to the sidebar header actions');
  assert.equal(doc.getElementById('topRailPanelToggle'), null, 'the rail action slot no longer owns a panel toggle');
  assert.equal(doc.getElementById('topRailActions').children.length, 0, 'the rail action slot is empty');
  assert.equal(collapseToggle.hidden, false, 'visible on a collapsible panel view');
  assert.equal(collapseToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(collapseToggle.getAttribute('aria-controls'), 'viewPanel');
  assert.equal(collapseToggle.hasAttribute('aria-pressed'), false);
  assert.equal(collapseToggle.getAttribute('aria-label'), 'Collapse chats panel');

  collapseToggle.focus();
  collapseToggle.click();
  await waitForUi(window, 40);
  assert.equal(workspace.classList.contains('panel-collapsed'), true, 'click collapses the chat panel to the strip');
  const expandToggle = doc.getElementById('chatsStripPanelToggle');
  assert.ok(expandToggle, 'the strip mounts its own expand toggle');
  assert.equal(expandToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(expandToggle.getAttribute('aria-controls'), 'viewPanel');
  assert.equal(expandToggle.getAttribute('aria-label'), 'Expand chats panel');
  assert.equal(doc.activeElement, expandToggle, 'collapse hands focus to the strip toggle');

  expandToggle.click();
  await waitForUi(window, 40);
  assert.equal(workspace.classList.contains('panel-collapsed'), false, 'the strip toggle restores the panel');
  assert.equal(collapseToggle.isConnected, true, 'the header toggle survives the round trip');

  // Workspace owns its internal explorer rail; the shared panel host (recent
  // chats) must not render there. The header toggle lives inside #viewPanel,
  // so panel-none (display:none + inert) removes it with the panel.
  doc.getElementById('ideTopRailTab').click();
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.activeView, 'ide');
  assert.equal(workspace.classList.contains('panel-none'), true, 'Workspace renders full-bleed');
  assert.ok(collapseToggle.closest('#viewPanel'), 'the toggle disappears with the inert panel host');
});

test('phone-width chat auto-collapses but the strip toggle can explicitly expand it', async (t) => {
  const { window } = await loadRendererTestApp(t, { windowInnerWidth: 480 });
  const doc = window.document;
  const workspace = doc.getElementById('workspace');
  await waitForUi(window, 80);

  doc.getElementById('chatTopRailTab').click();
  await waitForUi(window, 40);
  assert.equal(workspace.classList.contains('panel-collapsed'), true);
  assert.equal(workspace.dataset.panelAutoCollapsed, 'true');
  const expandToggle = doc.getElementById('chatsStripPanelToggle');
  assert.ok(expandToggle, 'auto-collapse mounts the strip and its expand toggle');
  assert.equal(expandToggle.disabled, false);
  assert.equal(expandToggle.getAttribute('aria-label'), 'Expand chats panel');
  assert.equal(expandToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(expandToggle.getAttribute('aria-controls'), 'viewPanel');
  assert.equal(expandToggle.hasAttribute('aria-pressed'), false);
  assert.equal(readPanelsStore(window).byView.chat.collapsed, false, 'responsive state is not persisted');

  expandToggle.click();
  await waitForUi(window, 40);
  assert.equal(workspace.classList.contains('panel-collapsed'), false, 'explicit expansion overrides responsive collapse');
  assert.equal(workspace.dataset.panelAutoCollapsed, 'false');

  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 860 });
  window.dispatchEvent(new window.Event('resize'));
  await waitForUi(window, 40);
  assert.equal(workspace.classList.contains('panel-collapsed'), false);
  assert.equal(workspace.dataset.panelAutoCollapsed, 'false');
});

// UIUX-038 (Artifacts view aria-labelledby / focus landing) was deleted in
// W1-5: the Artifacts studio view no longer exists, so the dangling-reference
// concern it guarded is void. The review panel carries its own labels.
