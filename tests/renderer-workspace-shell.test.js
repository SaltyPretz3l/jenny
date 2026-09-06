const test = require('node:test');
const assert = require('node:assert/strict');

const { SCRIPT_ORDER } = require('./helpers/renderer-shell-harness-support');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('renderer shell harness loads workspace scripts in order and boots the workspace rail cleanly', async (t) => {
  const workspaceFallbackIndex = SCRIPT_ORDER.indexOf('renderer/shell/renderer-fallback-workspace-registry.js');
  const workspaceStateIndex = SCRIPT_ORDER.indexOf('renderer/shell/renderer-workspace-state-utils.js');
  const workspaceChromeIndex = SCRIPT_ORDER.indexOf('renderer/shell/renderer-workspace-chrome-utils.js');

  assert.ok(workspaceFallbackIndex >= 0);
  assert.ok(workspaceStateIndex > workspaceFallbackIndex);
  assert.ok(workspaceChromeIndex > workspaceStateIndex);
  assert.equal(SCRIPT_ORDER.includes('renderer/app.js'), false);

  const { window } = await loadRendererTestApp(t);
  const doc = window.document;

  assert.ok(doc.getElementById('workspaceRailShell'));
  assert.equal(typeof window.rendererFallbackWorkspaceRegistry?.buildFallbacks, 'function');
  assert.equal(typeof window.rendererWorkspaceStateUtils?.createWorkspaceStateController, 'function');
  assert.equal(typeof window.rendererWorkspaceChromeUtils?.createWorkspaceChromeController, 'function');
});

test('workspace shortcuts cycle open sessions, suppress when typing, and close the active tab', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const newChatButton = doc.getElementById('newChatButton');
  const input = doc.getElementById('chatInput');

  newChatButton.click();
  await waitForUi(window, 40);
  newChatButton.click();
  await waitForUi(window, 40);

  assert.deepEqual(Array.from(window.__rendererState.workspace.openSessionIds), ['session-1', 'session-2']);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.currentSessionId, 'session-1');

  input.focus();
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.currentSessionId, 'session-1');

  doc.body.focus();
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.workspace.openSessionIds.includes('session-1'), false);
});

test('workspace rail shows on chat and hides on logs and settings', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const newChatButton = doc.getElementById('newChatButton');
  const rail = doc.getElementById('workspaceRailShell');

  newChatButton.click();
  await waitForUi(window, 40);

  // W1-5: the Artifacts studio view is gone — chat (with the split review
  // panel) is the rail-visible surface; logs/settings hide it.
  assert.equal(rail.hidden, false);

  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 20);
  assert.equal(rail.hidden, true);

  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  assert.equal(rail.hidden, true);
});

test('workspace rail stays visible while split artifact review is open in chat', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
  });
  const doc = window.document;
  const rail = doc.getElementById('workspaceRailShell');
  const workspace = doc.getElementById('workspace');
  const sidebar = doc.querySelector('.sidebar');
  const sidebarResizer = doc.getElementById('sidebarResizer');
  const splitToggle = doc.getElementById('artifactSplitViewToggle');

  workspace.getBoundingClientRect = () => ({ top: 0, left: 0, right: 1600, bottom: 900, width: 1600, height: 900 });
  sidebar.getBoundingClientRect = () => ({ top: 0, left: 0, right: 320, bottom: 900, width: 320, height: 900 });
  sidebarResizer.getBoundingClientRect = () => ({ top: 0, left: 320, right: 330, bottom: 900, width: 10, height: 900 });
  window.dispatchEvent(new window.Event('resize'));
  await waitForUi(window, 40);

  splitToggle.click();
  await waitForUi(window, 30);

  assert.equal(doc.getElementById('chatTopRailTab').getAttribute('aria-selected'), 'true');
  assert.equal(rail.hidden, false);
});
