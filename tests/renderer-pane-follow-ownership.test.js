'use strict';

/* CTR-001 -- follow-latest intent is owned per pane.
 *
 * Split view shows two chat panes on ONE `state`. Pane 0's follow intent is
 * `state.ui.followLatest` (the jump controls, the wayfinder and the IDE chat
 * dock read it); pane 1 injects its own follow state. Before the fix both
 * panes' viewport controllers and scroll coordinators wrote and read the single
 * field, so scrolling up in one pane stopped the other from following its live
 * reply and returning one pane to the bottom re-latched the other. The same
 * per-pane modules also keyed their state on `state.currentSessionId`, which
 * under split view is the FOCUSED pane's session.
 *
 * These tests build the real surface cluster (scroll coordinator + viewport
 * controller) through createChatPaneSurfaceControllers over two real jsdom
 * scroll containers sharing one state object. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatPaneSurfaceControllers } = require('../renderer/chat/renderer-chat-pane-surface-controllers.js');
const viewportUtils = require('../renderer/shell/renderer-viewport-utils.js');
const scrollCoordinatorUtils = require('../renderer/chat/renderer-chat-scroll-coordinator.js');
const { createViewportLiveFollowUtils } = require('../renderer/shell/renderer-viewport-live-follow-utils.js');
const { deriveFollowLatestFromScroll, shouldAutoScrollThread } = require('../renderer/chat/chat-scroll-utils.js');
const { ThinkingPanelController } = require('../renderer/chat/chat-thinking-utils.js');

const BOTTOM = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
const AWAY = { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 };

function readerSnapshot(metrics) {
  return { ...metrics, userInitiated: true, direction: metrics === AWAY ? 'up' : 'down' };
}

function createScrollNode(doc, id) {
  const node = doc.createElement('div');
  node.id = id;
  let scrollTop = 0;
  Object.defineProperty(node, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v) => { scrollTop = Number(v) || 0; } });
  Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => 1000 });
  Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => 400 });
  doc.body.appendChild(node);
  return node;
}

function createHarness(t) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const previous = { window: global.window, document: global.document, raf: global.requestAnimationFrame, caf: global.cancelAnimationFrame };
  global.window = window;
  global.document = window.document;
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  global.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  const state = { currentSessionId: 'session-a', ui: { activeView: 'chat', followLatest: true } };
  const surfaces = [];
  t.after(() => {
    surfaces.forEach((surface) => surface.dispose());
    window.close();
    global.window = previous.window;
    global.document = previous.document;
    global.requestAnimationFrame = previous.raf;
    global.cancelAnimationFrame = previous.caf;
  });

  function buildPane(paneId, extra = {}) {
    const doc = window.document;
    const dom = {
      chatThreadScroll: createScrollNode(doc, `scroll${paneId}`),
      chatTimeline: doc.createElement('div'),
    };
    dom.chatThreadScroll.appendChild(dom.chatTimeline);
    const thinkingController = new ThinkingPanelController();
    const surface = createChatPaneSurfaceControllers({
      state,
      paneId,
      windowRef: window,
      constants: { MESSAGE_STATUS: {} },
      dom,
      factories: {
        scrollCoordinatorUtils,
        viewportUtils,
        pinToTopUtils: {},
      },
      controllers: { thinkingController, reducedMotionQuery: { matches: true } },
      callbacks: {
        appendClientLog: () => {},
        renderJumpControls: () => {},
        isStreaming: () => false,
        mergeReasoningEntries: (existing, delta) => [...existing, ...delta],
        deriveFollowLatestFromScroll,
        shouldAutoScrollThread,
        escapeSelectorValue: (v) => String(v),
        getCurrentSessionMessages: () => [],
        buildInteractiveRecapViewModel: () => ({}),
        renderMessages: () => {},
        updateAssistantSpritePosition: () => {},
        getWayfinderController: () => null,
      },
      ...extra,
    });
    surfaces.push(surface);
    return { surface, thinkingController, viewport: surface.viewport, api: surface.viewportApi };
  }

  function createFollowState(initial = true) {
    let value = initial;
    return { get: () => value, set: (next) => { value = next; } };
  }

  return { state, buildPane, createFollowState };
}

test('a reader scrolling away in pane 1 leaves pane 0 following, and re-latching pane 0 does not re-latch pane 1', (t) => {
  const { state, buildPane, createFollowState } = createHarness(t);
  const pane0 = buildPane(0);
  const follow1 = createFollowState(true);
  const pane1 = buildPane(1, { followState: follow1, getSessionId: () => 'session-b' });

  pane1.viewport.syncThreadScrollState(readerSnapshot(AWAY));
  assert.equal(follow1.get(), false, 'pane 1 released follow');
  assert.equal(state.ui.followLatest, true, 'pane 0 (state.ui.followLatest) is untouched and still following');

  pane0.viewport.syncThreadScrollState(readerSnapshot(AWAY));
  assert.equal(state.ui.followLatest, false, 'the default-backed pane writes state.ui.followLatest');
  pane0.viewport.syncThreadScrollState(readerSnapshot(BOTTOM));
  assert.equal(state.ui.followLatest, true, 'pane 0 re-latched at the bottom');
  assert.equal(follow1.get(), false, 'pane 1 is still released');

  pane1.viewport.syncThreadScrollState(readerSnapshot(BOTTOM));
  assert.equal(follow1.get(), true, 'pane 1 re-latches on its own at the bottom');
});

test('the viewport api setFollowLatest and isFollowingLatest follow each pane own backing', (t) => {
  const { state, buildPane, createFollowState } = createHarness(t);
  const pane0 = buildPane(0);
  const follow1 = createFollowState(true);
  const pane1 = buildPane(1, { followState: follow1 });

  assert.equal(pane0.api.isFollowingLatest(), true);
  assert.equal(pane1.api.isFollowingLatest(), true);
  pane1.api.setFollowLatest(false);
  assert.equal(pane1.api.isFollowingLatest(), false);
  assert.equal(pane0.api.isFollowingLatest(), true, 'pane 0 unaffected');
  assert.equal(state.ui.followLatest, true);
  pane0.api.setFollowLatest(false);
  assert.equal(state.ui.followLatest, false, 'pane 0 default backing is state.ui.followLatest');
  assert.equal(pane0.api.isFollowingLatest(), false);
  assert.equal(follow1.get(), false, 'pane 1 was already released independently');
  pane1.api.setFollowLatest(true);
  assert.equal(follow1.get(), true);
  assert.equal(state.ui.followLatest, false, 're-latching pane 1 leaves pane 0 released');
});

test('the tri-state is preserved: an unset follow value counts as following', (t) => {
  const { state, buildPane } = createHarness(t);
  const unset = { value: undefined };
  const pane = buildPane(1, { followState: { get: () => unset.value, set: (v) => { unset.value = v; } } });
  state.ui.followLatest = false;
  assert.equal(pane.api.isFollowingLatest(), true, 'undefined is not === false');
  pane.api.setFollowLatest(false);
  assert.equal(pane.api.isFollowingLatest(), false);
});

test('each pane thinking controller keeps its own reader_away pause', (t) => {
  const { buildPane, createFollowState } = createHarness(t);
  const pane0 = buildPane(0);
  const pane1 = buildPane(1, { followState: createFollowState(true) });
  assert.notEqual(pane0.thinkingController, pane1.thinkingController);

  pane1.viewport.syncThreadScrollState(readerSnapshot(AWAY));
  assert.equal(pane1.thinkingController.isReaderAway(), true, 'pane 1 reader is away');
  assert.equal(pane0.thinkingController.isReaderAway(), false, 'pane 0 reader is not');
  assert.equal(pane0.thinkingController.shouldAutoScroll(), true);

  pane1.viewport.syncThreadScrollState(readerSnapshot(BOTTOM));
  assert.equal(pane1.thinkingController.isReaderAway(), false);
});

test('each scroll coordinator reads its own pane follow intent', (t) => {
  const { state, buildPane, createFollowState } = createHarness(t);
  const pane0 = buildPane(0);
  const follow1 = createFollowState(true);
  const pane1 = buildPane(1, { followState: follow1 });

  // restoreReaderAnchor is skipped while the pane follows and runs once it has released.
  assert.equal(pane0.surface.scrollCoordinator.restoreReaderAnchor(), 'skipped');
  assert.equal(pane1.surface.scrollCoordinator.restoreReaderAnchor(), 'skipped');
  follow1.set(false);
  assert.equal(state.ui.followLatest, true);
  assert.equal(pane0.surface.scrollCoordinator.restoreReaderAnchor(), 'skipped', 'pane 0 still follows');
  assert.notEqual(pane1.surface.scrollCoordinator.restoreReaderAnchor(), 'skipped', 'pane 1 released');
  follow1.set(true);
  state.ui.followLatest = false;
  assert.notEqual(pane0.surface.scrollCoordinator.restoreReaderAnchor(), 'skipped', 'pane 0 released');
  assert.equal(pane1.surface.scrollCoordinator.restoreReaderAnchor(), 'skipped', 'pane 1 follows');
});

test('the reader release is keyed on the pane own session, not the focused session', () => {
  const state = { currentSessionId: 'session-a', ui: { followLatest: true } };
  let value = true;
  const scrollNode = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400, querySelector: () => null };
  const pane1 = createViewportLiveFollowUtils({
    state,
    chatThreadScroll: scrollNode,
    followState: { get: () => value, set: (v) => { value = v; } },
    getSessionId: () => 'session-b',
  });
  const pane0 = createViewportLiveFollowUtils({ state, chatThreadScroll: scrollNode });

  pane1.releaseFollowForUserScrollAway();
  assert.equal(value, false);
  assert.equal(state.ui.followLatest, true, 'pane 0 backing untouched');
  assert.equal(pane1.isReaderReleaseHeld(), true);
  assert.equal(pane0.isReaderReleaseHeld(), false, 'pane 0 has not released');

  // Focus moving to pane 1 (currentSessionId becomes its session) must not unhold pane 1 or hold pane 0.
  state.currentSessionId = 'session-b';
  assert.equal(pane1.isReaderReleaseHeld(), true, 'pane 1 hold survives a focus change');
  state.currentSessionId = 'session-a';
  assert.equal(pane1.isReaderReleaseHeld(), true);

  pane0.releaseFollowForUserScrollAway();
  assert.equal(state.ui.followLatest, false, 'the default-backed utils write state.ui.followLatest');
  assert.equal(pane0.isReaderReleaseHeld(), true);
  state.currentSessionId = 'session-b';
  assert.equal(pane0.isReaderReleaseHeld(), false, 'default session key is state.currentSessionId, as before');
});
