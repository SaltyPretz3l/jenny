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

// Two chats as two tabs. A draft makes the first chat touched: a bare New chat
// reuses an untouched empty chat (real-app X3) instead of opening a second one.
async function openTwoChats(window) {
  const doc = window.document;
  const newChatButton = doc.getElementById('newChatButton');
  const input = doc.getElementById('chatInput');
  newChatButton.click();
  await waitForUi(window, 40);
  input.value = 'draft in the first chat';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  newChatButton.click();
  await waitForUi(window, 40);
}

test('renderer shell harness loads workspace scripts in order and boots the workspace rail cleanly', async (t) => {
  const workspaceStateIndex = SCRIPT_ORDER.indexOf('renderer/shell/renderer-workspace-state-utils.js');
  const workspaceChromeIndex = SCRIPT_ORDER.indexOf('renderer/shell/renderer-workspace-chrome-utils.js');

  // The silent workspace fallback registry is gone: the real modules must load.
  assert.equal(SCRIPT_ORDER.some((src) => src.includes('renderer-fallback')), false);
  assert.ok(workspaceStateIndex >= 0);
  assert.ok(workspaceChromeIndex > workspaceStateIndex);
  assert.equal(SCRIPT_ORDER.includes('renderer/app.js'), false);

  const { window } = await loadRendererTestApp(t);
  const doc = window.document;

  assert.ok(doc.getElementById('workspaceRailShell'));
  assert.equal(window.rendererFallbackWorkspaceRegistry, undefined);
  assert.equal(typeof window.rendererWorkspaceStateUtils?.createWorkspaceStateController, 'function');
  assert.equal(typeof window.rendererWorkspaceChromeUtils?.createWorkspaceChromeController, 'function');
});

test('workspace shortcuts cycle open sessions from the composer, keep Ctrl+W for the text field, and close the active tab', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const input = doc.getElementById('chatInput');

  await openTwoChats(window);

  assert.deepEqual(Array.from(window.__rendererState.workspace.openSessionIds), ['session-1', 'session-2']);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.currentSessionId, 'session-1');

  window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
  await waitForUi(window, 20);

  // Focus usually lives in the composer: Ctrl+Tab must switch tabs from there.
  input.focus();
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.currentSessionId, 'session-2');
  input.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
  await waitForUi(window, 20);

  // Ctrl+W stays with the text field.
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
  await waitForUi(window, 40);
  assert.deepEqual(Array.from(window.__rendererState.workspace.openSessionIds), ['session-1', 'session-2']);

  doc.body.focus();
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.workspace.openSessionIds.includes('session-2'), false);
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
  const sidebar = doc.getElementById('viewPanel');
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

test('the booted rail renames a tab through the sidebar rename path and anchors Link sessions at its menu', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await openTwoChats(window);

  doc.querySelector('[data-workspace-activate="session-2"]').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  const input = doc.querySelector('#workspaceRailShell .inv-inline-title-editor');
  assert.ok(input, 'double-click opens the inline editor');
  input.value = 'Gate closeout';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitForUi(window, 40);
  assert.deepEqual(shell.__state.renameCalls, [{ sessionId: 'session-2', title: 'Gate closeout' }]);
  assert.equal(doc.querySelector('[data-session-id="session-2"] .workspace-rail-title').textContent, 'Gate closeout');

  doc.querySelector('#workspaceRailShell [data-session-id="session-2"]')
    .dispatchEvent(new window.MouseEvent('contextmenu', { clientX: 70, clientY: 30, bubbles: true }));
  [...doc.querySelectorAll('.workspace-tab-context-menu-item')].find((item) => item.textContent.startsWith('Link sessions')).click();
  await waitForUi(window, 20);
  const popover = doc.querySelector('.workspace-linked-popover');
  assert.ok(popover, 'the tab menu opens the link popover');
  assert.equal(popover.style.left, '70px', 'anchored at the menu origin the composition forwards');
});
