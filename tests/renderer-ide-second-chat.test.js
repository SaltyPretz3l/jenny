'use strict';

/* The second Workspace chat at the controller (row 40 W6b, F3: two chats). With two
 * split-view panes the workbench gains Chat 2 (pane 1's whole root, hosted while the
 * Workspace shows) and Changes 2 (bound to pane 1's session); with one pane both are
 * gone and the root is back in the chat view. The composition here is a fake that
 * moves the root like the real setPaneHost (tests/renderer-pane-composition-host.test.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, settle } = require('./helpers/renderer-ide-harness');

function fakeComposition(doc) {
  const chatView = doc.createElement('section');
  const root = doc.createElement('div');
  root.className = 'chat-pane';
  root.dataset.paneId = '1';
  root.appendChild(doc.createElement('textarea'));
  chatView.appendChild(root);
  doc.body.appendChild(chatView);
  const calls = { hosts: [], docked: [] };
  const fake = {
    count: 2,
    chatView,
    root,
    calls,
    getPaneCount: () => fake.count,
    getPaneSessionId: (paneId) => (paneId === 0 ? 's0' : fake.count > 1 ? 's1' : ''),
    getPane: (paneId) => (paneId === 1 && fake.count > 1 ? { root } : null),
    getSessionPaneTarget: () => ({ getProjectionContext: () => ({ viewModelByTurnId: new Map() }) }),
    setPaneHost(paneId, host) {
      calls.hosts.push(host ? host.id : null);
      const target = host || chatView;
      if (root.parentNode === target) return false;
      target.appendChild(root);
      return true;
    },
    handleChatDocked: (docked) => { calls.docked.push(docked); return false; },
  };
  return fake;
}

async function openIde(t) {
  let fake = null;
  const harness = createHarness({
    featureFlags: { ide_chat_dock: true },
    beforeController: () => {
      globalThis.rendererChangesView = require('../renderer/features/renderer-changes-view');
      fake = fakeComposition(globalThis.window.document);
      globalThis.rendererAppPaneComposition = { getPaneComposition: () => fake };
    },
  });
  t.after(() => { harness.dispose(); delete globalThis.rendererChangesView; delete globalThis.rendererAppPaneComposition; });
  await harness.controller.activateIde();
  harness.controller.renderIde();
  await settle(50);
  const q = (sel) => harness.dom.window.document.querySelector(`#ideWorkbench ${sel}`);
  return { harness, fake, q };
}

const chat2 = (q) => q('[data-wb-tab="chat-2"], [data-wb-strip="chat-2"]');

test('with two panes the Workspace gains Chat 2, hosting pane 1\'s root, and Changes 2', async (t) => {
  const { harness, fake, q } = await openIde(t);
  assert.ok(chat2(q), 'Chat 2 has a tab or strip button');
  assert.equal(chat2(q).textContent.trim() || chat2(q).getAttribute('aria-label'), 'Chat 2');
  assert.ok(q('[data-wb-tab="changes-2"], [data-wb-strip="changes-2"]'), 'Changes 2 joins too');
  const host = harness.viewHost('chat-2');
  assert.equal(fake.root.parentNode, host, 'pane 1\'s whole root sits in Chat 2\'s host');
  assert.ok(host.isConnected);
});

test('leaving the Workspace puts the root back; one pane removes both views from the render', async (t) => {
  const { harness, fake, q } = await openIde(t);
  harness.state.ui.activeView = 'chat';
  harness.controller.chatDock.reconcile(); // a chat render reconciles the dock, which syncs the chats
  assert.equal(fake.root.parentNode, fake.chatView, 'back in the chat view');

  harness.state.ui.activeView = 'ide';
  fake.count = 1;
  harness.controller.renderIde();
  await settle(20);
  assert.equal(chat2(q), null, 'no second chat, no Chat 2');
  assert.equal(q('[data-wb-tab="changes-2"], [data-wb-strip="changes-2"]'), null);
});

test('the views stay where the user put them: a second pane later finds them in place', async (t) => {
  const { harness, fake, q } = await openIde(t);
  const layoutOps = require('../renderer/shared/workbench-layout-ops');
  const ideState = require('../renderer/features/renderer-ide-state');
  const ide = harness.state.ui.ide;
  const moved = layoutOps.moveView(ideState.getWorkbenchLayout(ide), 'chat-2', { edge: 'left' });
  ideState.commitWorkbenchLayout(ide, moved);
  fake.count = 1;
  harness.controller.renderIde();
  fake.count = 2;
  harness.controller.renderIde();
  await settle(20);
  const model = require('../renderer/shared/workbench-layout-model');
  const layout = ideState.getWorkbenchLayout(ide);
  assert.equal(model.listViews(layout).filter((id) => id === 'chat-2').length, 1, 'never added twice');
  assert.equal(model.findView(layout, 'chat-2').stackId, model.findView(moved, 'chat-2').stackId, 'still on the left edge');
  assert.ok(chat2(q));
});
