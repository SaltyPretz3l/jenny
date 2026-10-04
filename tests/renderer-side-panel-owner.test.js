'use strict';

/* Split view W3-2 -- the side panel owner (owner decision 2026-09-26 "C"):
 * one panel that stays with the chat that opened it. Driven through the real
 * pane layout controller so every `prev`/`next` is the shape the composition
 * receives. */

const test = require('node:test');
const assert = require('node:assert/strict');

const paneModel = require('../renderer/shell/renderer-pane-model');
const { createPaneLayoutController } = require('../renderer/shell/renderer-pane-layout-controller');
const {
  resolvePanelSessionId,
  claimPanelOwner,
  reconcilePanelOwner,
  resolveAutoOpenSessionId,
} = require('../renderer/chat/renderer-side-panel-owner');

const A = 'session-a';
const B = 'session-b';
const C = 'session-c';

function createRig(currentSessionId = A) {
  const state = { currentSessionId, panes: paneModel.normalizePaneLayout(null), ui: {} };
  const actions = [];
  const controller = createPaneLayoutController({
    state,
    paneModel,
    getWorkspaceStateController: () => null,
    onLayoutChanged: (prev, next) => actions.push(reconcilePanelOwner(state, prev, next)),
  });
  return { state, controller, actions };
}

test('one pane: the panel shows the current session and no owner is stored', () => {
  const { state } = createRig(A);
  assert.equal(resolvePanelSessionId(state), A);
  assert.equal(claimPanelOwner(state, A), false);
  assert.equal(state.ui.sidePanelOwnerSessionId, undefined);
  state.currentSessionId = C;
  assert.equal(resolvePanelSessionId(state), C);
});

test('opening beside keeps the panel on the chat that was on screen, focus alone never moves it', () => {
  const { state, controller, actions } = createRig(A);
  controller.openBeside(B);
  assert.deepEqual(actions, ['none']);
  assert.equal(state.ui.sidePanelOwnerSessionId, A);
  assert.equal(resolvePanelSessionId(state), A);

  controller.setFocusedPane(1);
  assert.equal(state.currentSessionId, B);
  assert.equal(resolvePanelSessionId(state), A);
  controller.setFocusedPane(0);
  assert.equal(resolvePanelSessionId(state), A);
  assert.deepEqual(actions, ['none', 'none', 'none']);
});

test('an explicit open from the other pane claims the panel', () => {
  const { state, controller } = createRig(A);
  controller.openBeside(B);
  assert.equal(claimPanelOwner(state, B), true);
  assert.equal(resolvePanelSessionId(state), B);
  assert.equal(claimPanelOwner(state, B), false, 'claiming the owner again is a no-op');
  assert.equal(claimPanelOwner(state, C), false, 'a session no pane holds cannot own the panel');
  assert.equal(resolvePanelSessionId(state), B);
});

test('a swap keeps the owner on its session', () => {
  const { state, controller, actions } = createRig(A);
  controller.openBeside(B);
  claimPanelOwner(state, B);
  controller.swapPanes();
  assert.equal(actions.at(-1), 'none');
  assert.equal(state.ui.sidePanelOwnerSessionId, B);
  assert.equal(resolvePanelSessionId(state), B);
});

test('replacing the owning pane\'s session follows the pane', () => {
  const { state, controller, actions } = createRig(A);
  controller.openBeside(B);
  claimPanelOwner(state, B);
  controller.setPaneSession(1, C);
  assert.equal(actions.at(-1), 'none');
  assert.equal(state.ui.sidePanelOwnerSessionId, C);
  assert.equal(resolvePanelSessionId(state), C);
});

test('closing the owning pane collapses the panel; closing the other pane keeps it', () => {
  const owned = createRig(A);
  owned.controller.openBeside(B);
  claimPanelOwner(owned.state, B);
  owned.controller.closePane(1);
  assert.equal(owned.actions.at(-1), 'collapse');
  assert.equal(owned.state.ui.sidePanelOwnerSessionId, '');
  assert.equal(resolvePanelSessionId(owned.state), A);

  const other = createRig(A);
  other.controller.openBeside(B);
  other.controller.closePane(1);
  assert.equal(other.actions.at(-1), 'none', 'pane 0 owned the panel and stays');
  assert.equal(other.state.ui.sidePanelOwnerSessionId, '');
  assert.equal(resolvePanelSessionId(other.state), A);
});

test('a blanked owning pane collapses the panel', () => {
  const { state, actions } = createRig(A);
  const prev = { panes: [{ paneId: 0, sessionId: A }, { paneId: 1, sessionId: B }], focusedPaneId: 0 };
  const next = { panes: [{ paneId: 0, sessionId: A }, { paneId: 1, sessionId: '' }], focusedPaneId: 0 };
  state.panes = next;
  state.ui.sidePanelOwnerSessionId = B;
  assert.equal(reconcilePanelOwner(state, prev, next), 'collapse');
  assert.equal(state.ui.sidePanelOwnerSessionId, '');
  assert.deepEqual(actions, []);
});

test('two panes with no owner yet (boot hydrate) adopt the focused session', () => {
  const { state } = createRig(A);
  const prev = { panes: [{ paneId: 0, sessionId: A }, { paneId: 1, sessionId: B }], focusedPaneId: 1 };
  const next = { panes: [{ paneId: 0, sessionId: A }, { paneId: 1, sessionId: B }], focusedPaneId: 0 };
  state.panes = next;
  state.currentSessionId = A;
  assert.equal(reconcilePanelOwner(state, prev, next), 'none');
  assert.equal(state.ui.sidePanelOwnerSessionId, A);
});

test('a stale owner no pane holds falls back to the focused session', () => {
  const { state, controller } = createRig(A);
  controller.openBeside(B);
  state.ui.sidePanelOwnerSessionId = C;
  assert.equal(resolvePanelSessionId(state), state.currentSessionId);
});

test('auto-open evaluates the owner while the panel is visible and the focused chat while hidden', () => {
  const { state, controller } = createRig(A);
  controller.openBeside(B);
  controller.setFocusedPane(1);
  assert.equal(resolveAutoOpenSessionId(state, true), A);
  assert.equal(resolveAutoOpenSessionId(state, false), B);
  const single = createRig(C);
  assert.equal(resolveAutoOpenSessionId(single.state, true), C);
  assert.equal(resolveAutoOpenSessionId(single.state, false), C);
});

// W3 open item: a layout that replaces both sessions at once (a workspace or root switch) must
// not hand the panel to whichever chat now sits at the owner's old index.
test('both sessions replaced at once: the owner clears and the panel collapses', () => {
  const { state } = createRig(A);
  const prev = { panes: [{ paneId: 0, sessionId: A }, { paneId: 1, sessionId: B }], focusedPaneId: 0 };
  const next = { panes: [{ paneId: 0, sessionId: C }, { paneId: 1, sessionId: 'session-d' }], focusedPaneId: 0 };
  state.panes = next;
  state.currentSessionId = C;
  state.ui.sidePanelOwnerSessionId = B;
  assert.equal(reconcilePanelOwner(state, prev, next), 'collapse');
  assert.equal(state.ui.sidePanelOwnerSessionId, '');
  assert.equal(resolvePanelSessionId(state), C, 'the focused chat until an explicit open');
});
