'use strict';

/* Row 40 W6b -- the Workspace hosts split view's second pane as its second chat.
 *
 * setPaneHost(paneId, host) moves the pane's whole root (kicker, thread, composer)
 * into a Workspace view host and back after the divider; the pane keeps its focus,
 * takes the dock body's adaptations while hosted, and rebuilds its virtualizer on
 * the next frame. A hosted root is not focus-tracked (pane 0 names the IDE's chat).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRig, paneRoot } = require('./helpers/pane-composition-rig');

function hostedRig(t, options) {
  const rig = createRig(t, options);
  rig.layoutController.openBeside('b');
  const root = paneRoot(rig.chatView, 1);
  const host = rig.doc.createElement('div');
  host.className = 'wb-view-host';
  rig.doc.body.appendChild(host);
  const rebuilds = [];
  const pane = rig.composition.getPane(1);
  pane.pipeline = { ...(pane.pipeline || {}), rebuildVirtualizer: () => rebuilds.push(1) };
  return { rig, root, host, rebuilds };
}

const frame = () => new Promise((resolve) => setTimeout(resolve, 40));

test('setPaneHost moves the whole root into the host and back right after the divider', async (t) => {
  const { rig, root, host, rebuilds } = hostedRig(t);
  assert.equal(rig.composition.setPaneHost(1, host), true);
  assert.equal(root.parentNode, host);
  assert.equal(root.dataset.paneHosted, 'workspace');
  assert.ok(root.classList.contains('ide-chat-dock-body'), 'the dock body adaptations apply while hosted');
  assert.equal(rig.composition.setPaneHost(1, host), false, 'already there: a no-op');
  await frame();
  assert.equal(rebuilds.length, 1, 'the virtualizer rebuilds after the move');

  assert.equal(rig.composition.setPaneHost(1, null), true);
  assert.equal(rig.doc.getElementById('chatPaneResizer').nextElementSibling, root, 'back right after the divider');
  assert.equal(root.dataset.paneHosted, undefined);
  assert.equal(root.classList.contains('ide-chat-dock-body'), false);
  assert.equal(rig.composition.setPaneHost(1, null), false);
});

test('setPaneHost refuses pane 0, an unmounted pane and a disposed composition', (t) => {
  const { rig, host } = hostedRig(t);
  assert.equal(rig.composition.setPaneHost(0, host), false, 'pane 0 is the dock\'s, never moved here');
  assert.equal(rig.composition.setPaneHost(2, host), false);
  rig.composition.dispose();
  assert.equal(rig.composition.setPaneHost(1, host), false);
  assert.equal(host.children.length, 0);
});

test('a hosted pane keeps DOM focus across the move', (t) => {
  const { rig, root, host } = hostedRig(t);
  const input = root.querySelector('textarea');
  input.focus();
  rig.composition.setPaneHost(1, host);
  assert.equal(rig.doc.activeElement, input);
  rig.composition.setPaneHost(1, null);
  assert.equal(rig.doc.activeElement, input);
});

test('a hosted root is not focus-tracked, and focus/syncFocus still reach it through the registry', (t) => {
  const { rig, root, host } = hostedRig(t);
  rig.composition.setPaneHost(1, host);
  assert.equal(rig.state.panes.focusedPaneId, 0);
  root.querySelector('textarea').dispatchEvent(new rig.doc.defaultView.FocusEvent('focusin', { bubbles: true }));
  assert.equal(rig.state.panes.focusedPaneId, 0, 'pane 0 stays the focused chat');
  rig.layoutController.setFocusedPane(1);
  rig.composition.syncFocus();
  assert.equal(root.dataset.paneFocused, 'true', 'syncFocus finds the hosted root');
  rig.doc.body.focus();
  assert.equal(rig.composition.focusComposer(), true, 'focusComposer reaches the hosted pane');
  assert.equal(rig.doc.activeElement, root.querySelector('textarea'));
});

test('the pane session ids are exposed per pane; closing a hosted pane removes its root', (t) => {
  const { rig, root, host } = hostedRig(t);
  assert.equal(rig.composition.getPaneSessionId(1), 'b');
  assert.equal(typeof rig.composition.getPaneSessionId(0), 'string');
  rig.composition.setPaneHost(1, host);
  rig.layoutController.closePane(1);
  assert.equal(root.isConnected, false);
  assert.equal(host.children.length, 0);
  assert.equal(rig.composition.getPaneSessionId(1), '');
});

test('pane 1 renders reach the render listener; null releases it', (t) => {
  const { rig } = hostedRig(t);
  const heard = [];
  rig.composition.setPaneRenderListener((paneId) => heard.push(paneId));
  const overrides = rig.built.pipeline.find((p) => p.paneId === 1)?.overrides;
  assert.equal(typeof overrides?.reconcileChatDockHost, 'function', 'the pane pipeline gets its own reconcile hook');
  assert.equal(overrides.reconcileChatDockHost(), false, 'it never claims a host move');
  assert.deepEqual(heard, [1]);
  rig.composition.setPaneRenderListener(null);
  overrides.reconcileChatDockHost();
  assert.deepEqual(heard, [1]);
});

test('a hosted move keeps the thread scroll position', async (t) => {
  const { rig, root, host } = hostedRig(t);
  const scroller = rig.composition.getPane(1).dom.chatThreadScroll;
  let top = 240;
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v; } });
  const realAppend = host.insertBefore.bind(host);
  host.insertBefore = (node, ref) => { const out = realAppend(node, ref); top = 0; return out; }; // a reparent resets scroll
  rig.composition.setPaneHost(1, host);
  assert.equal(root.parentNode, host);
  assert.equal(top, 240, 'restored right after the move');
  await frame();
  assert.equal(top, 240, 'and after the virtualizer rebuild');
});

test('closing a focused hosted pane hands focus to pane 0\'s composer even when the dock holds it', (t) => {
  let chatInput = null;
  const { rig, root, host } = hostedRig(t, { getPrimaryComposerInput: () => chatInput });
  chatInput = rig.doc.createElement('textarea');
  rig.doc.body.appendChild(chatInput); // pane 0's composer, moved out of its root into the dock
  rig.doc.getElementById('chatPane0').querySelectorAll('textarea').forEach((el) => el.remove());
  rig.composition.setPaneHost(1, host);
  root.querySelector('textarea').focus();
  rig.layoutController.closePane(1);
  assert.equal(rig.doc.activeElement, chatInput);
});
