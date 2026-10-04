'use strict';

/* Split view W1-4c -- the pane layout controller: the ONE writer of
 * `state.panes`.
 *
 * The layout is a value (renderer/shell/renderer-pane-model.js); this
 * controller is the state machine over it. Two storage modes carry the
 * one-pane identity:
 *   - one pane: `state.panes` stays the BLANK one-pane layout and pane 0 means
 *     `state.currentSessionId`, exactly the app before split view (every legacy
 *     writer of `currentSessionId` keeps working untouched);
 *   - two panes: each pane holds its own session and `currentSessionId` is
 *     DERIVED from the focused pane.
 * Every change goes through applyLayout: normalize, store, derive
 * `currentSessionId`, persist once through the workspace-state controller's
 * single layout writer, then tell the composition (prev, next).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const paneModel = require('../renderer/shell/renderer-pane-model');
const { resolvePaneSessionId } = require('../renderer/chat/renderer-pane-visibility-utils');
const { createPaneLayoutController } = require('../renderer/shell/renderer-pane-layout-controller');

const A = 'session-a';
const B = 'session-b';
const C = 'session-c';

function plain(layout) {
  return {
    panes: layout.panes.map(({ paneId, sessionId }) => ({ paneId, sessionId })),
    focusedPaneId: layout.focusedPaneId,
    splitRatio: layout.splitRatio,
  };
}

function createRig(options = {}) {
  const state = {
    currentSessionId: options.currentSessionId ?? A,
    panes: paneModel.normalizePaneLayout(null),
  };
  const persisted = [];
  const changes = [];
  const reasons = [];
  const workspaceStateController = {
    persistPaneLayout(layout) {
      persisted.push(JSON.parse(JSON.stringify(layout)));
      return layout;
    },
  };
  const controller = createPaneLayoutController({
    state,
    paneModel,
    getWorkspaceStateController: () => (options.noWorkspace ? null : workspaceStateController),
    onLayoutChanged: (prev, next, meta) => { changes.push({ prev: plain(prev), next: plain(next) }); reasons.push(meta && meta.reason); },
  });
  return { state, controller, persisted, changes, reasons };
}

function twoPaneRig(focusedPaneId = 0) {
  const rig = createRig({ currentSessionId: A });
  rig.controller.applyLayout({ panes: [A, B], focusedPaneId });
  rig.persisted.length = 0;
  rig.changes.length = 0;
  return rig;
}

test('one pane: state.panes stays the blank layout and pane 0 means currentSessionId', () => {
  const { state, controller } = createRig({ currentSessionId: A });
  const blank = state.panes;

  assert.deepEqual(plain(controller.getLayout()), {
    panes: [{ paneId: 0, sessionId: A }],
    focusedPaneId: 0,
    splitRatio: 0.5,
  });
  assert.equal(controller.getPaneCount(), 1);
  // A legacy writer moves currentSessionId; the reconcile is a no-op with one pane.
  state.currentSessionId = C;
  assert.equal(controller.syncFocusedPaneFromState(), false);
  assert.equal(state.panes, blank, 'the blank layout object is untouched');
  assert.equal(resolvePaneSessionId(state, 0), C);
});

test('applyLayout normalizes, stores frozen, derives currentSessionId, persists once, then notifies', () => {
  const { state, controller, persisted, changes } = createRig({ currentSessionId: A });

  const next = controller.applyLayout({ panes: [A, B], focusedPaneId: 1, splitRatio: 0.9 });

  assert.equal(Object.isFrozen(state.panes), true);
  assert.deepEqual(plain(state.panes), {
    panes: [{ paneId: 0, sessionId: A }, { paneId: 1, sessionId: B }],
    focusedPaneId: 1,
    splitRatio: 0.8,
  });
  assert.equal(state.currentSessionId, B, 'the focused pane owns currentSessionId');
  assert.deepEqual(persisted, [plain(state.panes)], 'persisted exactly once, with the normalized layout');
  assert.deepEqual(changes, [{
    prev: { panes: [{ paneId: 0, sessionId: A }], focusedPaneId: 0, splitRatio: 0.5 },
    next: plain(state.panes),
  }]);
  assert.deepEqual(plain(next), plain(state.panes));
});

test('applyLayout of an unchanged layout neither persists nor notifies', () => {
  const { controller, persisted, changes } = twoPaneRig(0);

  controller.applyLayout({ panes: [A, B], focusedPaneId: 0 });

  assert.deepEqual(persisted, []);
  assert.deepEqual(changes, []);
});

test('a duplicate session: the later pane loses it (one session lives in one pane)', () => {
  const { state, controller } = createRig();

  controller.applyLayout({ panes: [A, A], focusedPaneId: 0 });

  assert.deepEqual(state.panes.panes.map((pane) => pane.sessionId), [A, '']);
});

test('setFocusedPane moves focus and currentSessionId, and ignores a pane that does not exist', () => {
  const { state, controller, persisted } = twoPaneRig(0);

  assert.equal(controller.setFocusedPane(1), true);
  assert.equal(state.panes.focusedPaneId, 1);
  assert.equal(state.currentSessionId, B);
  assert.equal(persisted.length, 1);

  assert.equal(controller.setFocusedPane(1), false, 'already focused');
  assert.equal(controller.setFocusedPane(2), false, 'no such pane');
  assert.equal(controller.setFocusedPane(-1), false);
  assert.equal(persisted.length, 1);
});

test('openBeside adds pane 1 holding the session and keeps focus where it was', () => {
  const { state, controller, persisted } = createRig({ currentSessionId: A });

  assert.equal(controller.openBeside(B), true);

  assert.deepEqual(plain(state.panes).panes, [{ paneId: 0, sessionId: A }, { paneId: 1, sessionId: B }]);
  assert.equal(state.panes.focusedPaneId, 0);
  assert.equal(state.currentSessionId, A);
  assert.equal(persisted.length, 1);
  assert.equal(controller.getPaneCount(), 2);
});

test('openBeside with a blank pane 0 focuses the new pane', () => {
  const { state, controller } = createRig({ currentSessionId: '' });

  assert.equal(controller.openBeside(B), true);

  assert.deepEqual(state.panes.panes.map((pane) => pane.sessionId), ['', B]);
  assert.equal(state.panes.focusedPaneId, 1);
  assert.equal(state.currentSessionId, B);
});

test('openBeside refuses a blank id and a session already in a pane', () => {
  const { controller, persisted } = createRig({ currentSessionId: A });

  assert.equal(controller.openBeside(''), false);
  assert.equal(controller.openBeside(A), false, 'the one pane already shows A');
  assert.equal(controller.getPaneCount(), 1);
  assert.equal(persisted.length, 0);

  controller.openBeside(B);
  assert.equal(controller.isSessionInPane(B), true);
  assert.equal(controller.isSessionInPane(C), false);
  assert.equal(controller.openBeside(B), false, 'B already sits in pane 1');
});

test('openBeside with two panes replaces the non-focused pane', () => {
  const { state, controller } = twoPaneRig(1);

  assert.equal(controller.openBeside(C), true);

  assert.deepEqual(state.panes.panes.map((pane) => pane.sessionId), [C, B]);
  assert.equal(state.panes.focusedPaneId, 1);
  assert.equal(state.currentSessionId, B);
});

test('closePane returns to one pane holding the OTHER pane\'s session, focus 0', () => {
  const { state, controller, persisted, changes } = twoPaneRig(0);

  assert.equal(controller.closePane(0), true);

  assert.equal(controller.getPaneCount(), 1);
  assert.equal(state.currentSessionId, B, 'pane 1\'s session is now the one pane');
  assert.deepEqual(plain(state.panes).panes, [{ paneId: 0, sessionId: '' }], 'stored as the blank one-pane layout');
  assert.equal(resolvePaneSessionId(state, 0), B);
  assert.deepEqual(persisted, [{ panes: [{ paneId: 0, sessionId: B }], focusedPaneId: 0, splitRatio: 0.5 }]);
  assert.deepEqual(changes[0].next.panes, [{ paneId: 0, sessionId: B }]);
  assert.equal(controller.closePane(0), false, 'one pane cannot close');
});

test('closePanesWithoutTab: a pane whose tab closed closes; open tabs, blanks and one pane are left alone', () => {
  const kept = twoPaneRig(0);
  assert.equal(kept.controller.closePanesWithoutTab([A, B, C]), false, 'both tabs open: nothing closes');
  assert.equal(kept.controller.closePanesWithoutTab(null), false, 'no tab list: nothing closes');
  assert.equal(kept.controller.getPaneCount(), 2);

  const other = twoPaneRig(0);
  assert.equal(other.controller.closePanesWithoutTab([A, C]), true, 'pane 1\'s tab closed');
  assert.equal(other.controller.getPaneCount(), 1);
  assert.equal(other.state.currentSessionId, A, 'the focused pane\'s session stays');

  const focused = twoPaneRig(1);
  assert.equal(focused.controller.closePanesWithoutTab([B]), true, 'pane 0\'s tab closed');
  assert.equal(focused.state.currentSessionId, B, 'the pane that still has a tab is the one pane');

  const one = createRig({ currentSessionId: A });
  assert.equal(one.controller.closePanesWithoutTab([]), false, 'one pane never closes');
});

test('the split ratio is kept across close and reopen, and setSplitRatio never persists', () => {
  const { state, controller, persisted } = twoPaneRig(0);

  assert.equal(controller.setSplitRatio(0.95), 0.8, 'returns the clamped ratio the model kept');
  assert.equal(controller.getSplitRatio(), 0.8);
  assert.equal(state.panes.splitRatio, 0.8);
  assert.deepEqual(persisted, [], 'a per-frame ratio write is never persisted');

  controller.closePane(1);
  controller.openBeside(B);
  assert.equal(state.panes.splitRatio, 0.8);
});

test('syncFocusedPaneFromState: a legacy write of a new session moves the FOCUSED pane', () => {
  const { state, controller, persisted } = twoPaneRig(1);
  const before = state.panes;

  assert.equal(controller.syncFocusedPaneFromState(), false, 'nothing changed: no write');
  assert.equal(state.panes, before, 'no allocation when nothing changed');

  state.currentSessionId = C;
  assert.equal(controller.syncFocusedPaneFromState(), true);
  assert.deepEqual(state.panes.panes.map((pane) => pane.sessionId), [A, C]);
  assert.equal(state.panes.focusedPaneId, 1);
  assert.equal(persisted.length, 1);
});

test('syncFocusedPaneFromState: a legacy write of the session the other pane holds focuses that pane (no duplicate)', () => {
  const { state, controller } = twoPaneRig(0);

  state.currentSessionId = B;
  assert.equal(controller.syncFocusedPaneFromState(), true);

  assert.deepEqual(state.panes.panes.map((pane) => pane.sessionId), [A, B], 'nothing is blanked');
  assert.equal(state.panes.focusedPaneId, 1);
  assert.equal(state.currentSessionId, B);
});

test('resetPanes (sign-out) returns to one blank pane', () => {
  const { state, controller } = twoPaneRig(1);
  state.currentSessionId = '';

  controller.resetPanes();

  assert.equal(controller.getPaneCount(), 1);
  assert.equal(state.currentSessionId, '');
  assert.deepEqual(plain(state.panes).panes, [{ paneId: 0, sessionId: '' }]);
});

// W3 open item (sign-out misfire): listeners learn WHY, so a blank pane left by a real close
// is not mistaken for the sign-out reset.
test('resetPanes reports reason "reset"; a close reports none', () => {
  const reset = twoPaneRig(1);
  reset.controller.resetPanes();
  assert.equal(reset.reasons.at(-1), 'reset');
  const closed = twoPaneRig(1);
  closed.controller.closePane(1);
  assert.equal(closed.reasons.at(-1), '');
});

test('rekey moves a pane entry to the promoted session id (a pane-1 optimistic session)', () => {
  const { state, controller, reasons } = twoPaneRig(0);
  controller.setPaneSession(1, 'local-draft-1');

  assert.equal(controller.rekey('local-draft-1', C), true);
  assert.deepEqual(state.panes.panes.map((pane) => pane.sessionId), [A, C]);
  assert.equal(reasons.at(-1), 'rekey', 'the listener learns it is the same chat (drafts and selection stay)');
  assert.equal(state.currentSessionId, A, 'the focused pane is untouched');
  assert.equal(controller.rekey('missing', 'x'), false);
});

test('createSessionContext(1).setSessionId places the id in pane 1 and leaves currentSessionId alone', () => {
  const { state, controller } = twoPaneRig(0);
  const context = controller.createSessionContext(1);

  assert.equal(context.paneId, 1);
  assert.equal(context.getSessionId(), B);
  context.setSessionId('  session-d ');

  assert.deepEqual(state.panes.panes.map((pane) => pane.sessionId), [A, 'session-d']);
  assert.equal(state.currentSessionId, A);
  assert.equal(context.getSessionId(), 'session-d');
  assert.equal(context.isCurrent('session-d'), true);
  assert.equal(context.isCurrent(A), false);
});

test('a pane that writes a session the other pane holds takes it (the writer wins)', () => {
  const { state, controller } = twoPaneRig(1);

  controller.createSessionContext(1).setSessionId(A);

  assert.deepEqual(state.panes.panes.map((pane) => pane.sessionId), ['', A]);
  assert.equal(state.currentSessionId, A);
});

test('createSessionContext(0) with one pane is today\'s default context', () => {
  const { state, controller, persisted, changes } = createRig({ currentSessionId: A });
  const blank = state.panes;
  const context = controller.createSessionContext(0);

  assert.equal(context.getSessionId(), A);
  context.setSessionId(' session-new ');
  assert.equal(state.currentSessionId, 'session-new');
  assert.equal(state.panes, blank, 'one pane: the write is the plain currentSessionId write');
  assert.deepEqual(persisted, []);
  assert.deepEqual(changes, []);
  assert.equal(context.isCurrent('session-new'), true);

  controller.createSessionContext(1).setSessionId(B);
  assert.equal(controller.getPaneCount(), 1, 'a pane that does not exist has no writer');
  assert.throws(() => controller.createSessionContext(-1), /paneId/);
});

test('without a workspace-state controller the layout still applies (nothing persists)', () => {
  const { state, controller } = createRig({ noWorkspace: true, currentSessionId: A });

  assert.equal(controller.openBeside(B), true);
  assert.equal(controller.getPaneCount(), 2);
  assert.equal(state.currentSessionId, A);
});

/* Split view W2-1 (drag-to-split): placeSession(sessionId, side) and
 * swapPanes(). Pane order IS the side: 'left' is pane 0, 'right' pane 1. */
const ids = (state) => state.panes.panes.map((pane) => pane.sessionId);

test('placeSession right with one pane: [current, id], focus stays on the current session, one persist', () => {
  const { state, controller, persisted, changes } = createRig({ currentSessionId: A });

  assert.equal(controller.placeSession(B, 'right'), true);

  assert.deepEqual(ids(state), [A, B]);
  assert.equal(state.panes.focusedPaneId, 0);
  assert.equal(state.currentSessionId, A);
  assert.deepEqual(persisted, [{ panes: [{ paneId: 0, sessionId: A }, { paneId: 1, sessionId: B }], focusedPaneId: 0, splitRatio: 0.5 }]);
  assert.equal(changes.length, 1);
});

test('placeSession left with one pane: [id, current], the current session moves right and keeps focus', () => {
  const { state, controller, persisted } = createRig({ currentSessionId: A });

  assert.equal(controller.placeSession(B, 'left'), true);

  assert.deepEqual(ids(state), [B, A]);
  assert.equal(state.panes.focusedPaneId, 1, 'focus follows the previously current session to the right');
  assert.equal(state.currentSessionId, A);
  assert.equal(persisted.length, 1);
});

test('placeSession with a blank one pane focuses the placed session on either side', () => {
  const right = createRig({ currentSessionId: '' });
  assert.equal(right.controller.placeSession(B, 'right'), true);
  assert.deepEqual(ids(right.state), ['', B]);
  assert.equal(right.state.panes.focusedPaneId, 1);
  assert.equal(right.state.currentSessionId, B);

  const left = createRig({ currentSessionId: '' });
  assert.equal(left.controller.placeSession(B, 'left'), true);
  assert.deepEqual(ids(left.state), [B, '']);
  assert.equal(left.state.panes.focusedPaneId, 0);
  assert.equal(left.state.currentSessionId, B);
});

test('placeSession refuses a blank id, an unknown side, and the one pane\'s own session (no write)', () => {
  const { state, controller, persisted, changes } = createRig({ currentSessionId: A });

  assert.equal(controller.placeSession('', 'left'), false);
  assert.equal(controller.placeSession(B, 'top'), false);
  assert.equal(controller.placeSession(A, 'right'), false, 'the one pane already shows A');
  assert.equal(controller.getPaneCount(), 1);
  assert.equal(state.currentSessionId, A);
  assert.deepEqual(persisted, []);
  assert.deepEqual(changes, []);
});

test('placeSession with two panes replaces that side\'s session and keeps focus', () => {
  const rig = twoPaneRig(1);
  assert.equal(rig.controller.placeSession(C, 'left'), true);
  assert.deepEqual(ids(rig.state), [C, B]);
  assert.equal(rig.state.panes.focusedPaneId, 1);
  assert.equal(rig.state.currentSessionId, B);
  assert.equal(rig.persisted.length, 1);

  const other = twoPaneRig(1);
  assert.equal(other.controller.placeSession(C, 'right'), true);
  assert.deepEqual(ids(other.state), [A, C]);
  assert.equal(other.state.panes.focusedPaneId, 1);
  assert.equal(other.state.currentSessionId, C, 'the focused pane now shows the dropped session');
});

test('placeSession of the session the OTHER pane holds swaps the panes; its own side is a no-op', () => {
  const rig = twoPaneRig(0);
  assert.equal(rig.controller.placeSession(A, 'left'), false, 'A already sits on the left');
  assert.deepEqual(rig.persisted, []);

  assert.equal(rig.controller.placeSession(A, 'right'), true);
  assert.deepEqual(ids(rig.state), [B, A]);
  assert.equal(rig.state.panes.focusedPaneId, 1, 'focus follows A');
  assert.equal(rig.state.currentSessionId, A);
  assert.equal(rig.persisted.length, 1);
  assert.equal(rig.changes.length, 1);
});

test('swapPanes reverses the sessions, focus follows its session, the ratio stays, one persist', () => {
  const rig = twoPaneRig(1);
  rig.controller.setSplitRatio(0.3);

  assert.equal(rig.controller.swapPanes(), true);

  assert.deepEqual(ids(rig.state), [B, A]);
  assert.equal(rig.state.panes.focusedPaneId, 0);
  assert.equal(rig.state.currentSessionId, B);
  assert.equal(rig.state.panes.splitRatio, 0.3);
  assert.deepEqual(rig.persisted, [{ panes: [{ paneId: 0, sessionId: B }, { paneId: 1, sessionId: A }], focusedPaneId: 0, splitRatio: 0.3 }]);
});

test('swapPanes with one pane is a no-op', () => {
  const { state, controller, persisted } = createRig({ currentSessionId: A });
  assert.equal(controller.swapPanes(), false);
  assert.equal(controller.getPaneCount(), 1);
  assert.equal(state.currentSessionId, A);
  assert.deepEqual(persisted, []);
});
