'use strict';

// The artifact-review rail state machine (renderer/features/renderer-artifact-review-rail.js),
// split out of the artifact manager on 2026-09-29 (review D-12): one storage
// key owned by the prefs module, the draft-to-real session rekey carrying the
// per-chat rail state, and the keyboard resizer.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const prefsUtils = require('../renderer/features/renderer-artifact-review-prefs');
const { ARTIFACT_REVIEW_MIN_STAGE_WIDTH, createArtifactReviewRail } = require('../renderer/features/renderer-artifact-review-rail');
const artifactsUtils = require('../renderer/features/renderer-artifacts-utils');

function withWindowShim(t, store, innerWidth = 2000) {
  const previous = globalThis.window;
  globalThis.window = {
    innerWidth,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
    },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}

function makeState(currentSessionId = 'draft-1') {
  return {
    currentSessionId,
    ui: { activeView: 'chat', artifactReview: {} },
    artifacts: { autoOpenedSessionIds: [], deletedArtifactIds: [] },
    messagesBySession: new Map(),
    features: { featureFlags: {} },
  };
}

function makeRail(state, extra = {}) {
  return createArtifactReviewRail({
    state,
    dom: extra.dom || {},
    callbacks: {
      getActiveSession: () => (state.currentSessionId ? { id: state.currentSessionId } : null),
      setActiveView: () => {}, updateComposerSafeOffset: () => {}, renderAll: () => {}, appendClientLog: () => {},
      ...(extra.callbacks || {}),
    },
  });
}

describe('one storage key', () => {
  test('the prefs module exports the key and the rail persists under it', (t) => {
    const store = {};
    withWindowShim(t, store);
    assert.equal(prefsUtils.ARTIFACT_REVIEW_STORAGE_KEY, 'jenny.artifactReview.v1');
    const rail = makeRail(makeState());
    rail.getArtifactReviewState().enabled = true;
    rail.saveArtifactReviewPreferences();
    assert.deepEqual(Object.keys(store), [prefsUtils.ARTIFACT_REVIEW_STORAGE_KEY]);
    assert.equal(JSON.parse(store[prefsUtils.ARTIFACT_REVIEW_STORAGE_KEY]).enabled, true);
  });
});

describe('draft-to-real session rekey', () => {
  test('the prefs helper moves width, maximize and Close to the new id', () => {
    const prefs = prefsUtils.normalizeArtifactReviewPreferences({ widthBySession: { other: 500, 'draft-1': 610 } });
    prefsUtils.recordArtifactReviewDismissed(prefs, 'draft-1', true);
    prefsUtils.recordArtifactReviewMaximized(prefs, 'draft-1', true);
    prefsUtils.rekeyArtifactReviewSessionPreferences(prefs, 'draft-1', 'real-1');
    assert.deepEqual(prefs.widthBySession, { other: 500, 'real-1': 610 });
    assert.deepEqual(prefs.dismissedForSession, { 'real-1': true });
    assert.deepEqual(prefs.maximizedBySession, { 'real-1': true });
    assert.equal(prefsUtils.rekeyArtifactReviewSessionPreferences(prefs, '', 'x'), prefs, 'no ids, no change');
  });

  test('the manager rekey carries the rail state and persists it', (t) => {
    const store = {};
    withWindowShim(t, store);
    const state = makeState('draft-1');
    const manager = artifactsUtils.createArtifactManager({ state, dom: {}, callbacks: {
      getActiveSession: () => ({ id: state.currentSessionId }), escapeHtml: (value) => String(value || ''),
      setActiveView: () => {}, appendClientLog: () => {}, updateComposerSafeOffset: () => {}, renderAll: () => {},
    } });
    t.after(() => manager.dispose());
    manager.toggleArtifactReviewMaximized(true);
    manager.openArtifactRail('artifact');
    manager.toggleArtifactReview(); // Close in the draft chat
    state.artifacts.autoOpenedSessionIds = ['elsewhere', 'draft-1'];
    manager.rekeySessionArtifacts('draft-1', 'real-1');
    state.currentSessionId = 'real-1';
    const review = state.ui.artifactReview;
    assert.deepEqual(review.dismissedForSession, { 'real-1': true }, 'the Close follows the chat');
    assert.deepEqual(review.maximizedBySession, { 'real-1': true }, 'so does maximize');
    assert.deepEqual(state.artifacts.autoOpenedSessionIds, ['elsewhere', 'real-1'], 'and its spent presentation');
    assert.deepEqual(JSON.parse(store[prefsUtils.ARTIFACT_REVIEW_STORAGE_KEY]).dismissedForSession, { 'real-1': true });
    assert.equal(manager.isArtifactReviewMaximized(), true);
  });

  test('a rekey is not a session switch: a file preview opened in the draft stays open', (t) => {
    withWindowShim(t, {});
    const state = makeState('draft-1');
    const rail = makeRail(state);
    rail.beginRender();
    rail.openArtifactRail('file_preview');
    rail.beginRender();
    rail.rekeySession('draft-1', 'real-1');
    state.currentSessionId = 'real-1';
    assert.equal(rail.beginRender(), true);
    assert.equal(state.ui.artifactReview.mode, 'file_preview');
  });
});

describe('keyboard resizer', () => {
  function makeResizer() {
    const attributes = {};
    const listeners = {};
    return {
      attributes, listeners, tabIndex: -1,
      classList: { toggle() {}, add() {}, remove() {} },
      setPointerCapture() {}, releasePointerCapture() {},
      setAttribute(name, value) { attributes[name] = String(value); },
      addEventListener(type, handler) { listeners[type] = handler; },
      removeEventListener(type) { delete listeners[type]; },
    };
  }

  test('End lands on the resolved 90% max, Home on the default, arrows step by 24', (t) => {
    withWindowShim(t, {}, 2000);
    const state = makeState('s1');
    const resizer = makeResizer();
    const workspace = { getBoundingClientRect: () => ({ width: ARTIFACT_REVIEW_MIN_STAGE_WIDTH + 400 }), style: { setProperty() {} } };
    const rail = makeRail(state, { dom: { artifactReviewResizer: resizer, workspace } });
    t.after(() => rail.dispose());
    rail.bind();
    rail.openArtifactRail('artifact');
    const key = (name) => resizer.listeners.keydown({ key: name, preventDefault() {} });
    key('End');
    assert.equal(resizer.attributes['aria-valuenow'], String(prefsUtils.resolveArtifactReviewMaxWidth(ARTIFACT_REVIEW_MIN_STAGE_WIDTH + 400)));
    key('Home');
    assert.equal(resizer.attributes['aria-valuenow'], String(prefsUtils.ARTIFACT_REVIEW_DEFAULT_WIDTH));
    key('ArrowLeft');
    assert.equal(resizer.attributes['aria-valuenow'], String(prefsUtils.ARTIFACT_REVIEW_DEFAULT_WIDTH + 24), 'left widens the right-hand rail');
    key('Tab');
    assert.equal(resizer.attributes['aria-valuenow'], String(prefsUtils.ARTIFACT_REVIEW_DEFAULT_WIDTH + 24), 'other keys pass through');
  });

  // The split folds by the viewport (chat-panes.css max-width: 1180px), so
  // two panes behind a sidebar keep the two-pane reserve while the window is
  // wider than 1180 even when the stage is not.
  for (const [name, workspaceWidth, initialSidebar, paneCount, expected, windowWidth = 2000] of [
    ['sidebar reserve', 1400, 265, '1', 775],
    ['overlay drawer', 800, 248, '1', 496],
    ['overlay floor', 300, 0, '1', 320],
    ['two visible panes', 1600, 0, '2', 910],
    ['two panes behind a sidebar', 1400, 265, '2', 445],
    ['folded split', 1180, 0, '2', 820, 1180],
    ['missing measurement', 0, 0, '1', 1640],
  ]) {
    test(`${name}: layout, aria and End share the stage ceiling`, (t) => {
      withWindowShim(t, {}, windowWidth);
      const state = makeState('s1');
      const resizer = makeResizer();
      const props = {};
      const classes = new Set();
      const chatView = { dataset: { paneCount }, classList: { toggle() {} } };
      const panel = {
        addEventListener() {}, removeEventListener() {},
        dataset: {}, style: { setProperty() {} },
        classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
      };
      let sidebarWidth = initialSidebar;
      let stageReads = 0;
      const workspace = {
        getBoundingClientRect: () => { stageReads += 1; return { width: workspaceWidth }; },
        style: { setProperty(name, value) { props[name] = value; } },
      };
      const sidebar = { getBoundingClientRect: () => ({ width: sidebarWidth }) };
      const rail = makeRail(state, { dom: { workspace, sidebar, chatView, artifactReviewPanel: panel, artifactReviewResizer: resizer } });
      t.after(() => rail.dispose());
      rail.bind();
      prefsUtils.recordArtifactReviewWidth(rail.getArtifactReviewState(), 's1', 4000);
      rail.openArtifactRail('artifact');
      stageReads = 0;
      rail.syncArtifactReviewLayout();
      assert.equal(props['--artifact-review-width'], `${expected}px`);
      assert.equal(resizer.attributes['aria-valuemax'], String(expected));
      assert.equal(resizer.attributes['aria-valuenow'], String(expected));
      assert.equal(stageReads, 1, 'one stage read per layout sync');
      assert.equal(classes.has('artifact-review-overlay'), name.startsWith('overlay'));
      resizer.listeners.keydown({ key: 'End', preventDefault() {} });
      assert.equal(props['--artifact-review-width'], `${expected}px`);
      assert.equal(state.ui.artifactReview.widthBySession.s1, expected);
      resizer.listeners.pointerdown({ pointerId: 1, clientX: 1000, preventDefault() {} });
      resizer.listeners.pointermove({ pointerId: 1, clientX: -4000 });
      resizer.listeners.pointerup({ pointerId: 1 });
      assert.equal(props['--artifact-review-width'], `${expected}px`, 'drag uses the same ceiling');
      if (name === 'sidebar reserve') {
        // A 780px stage is below the 800px single-pane threshold: docked it
        // would leave 420px, the overlay drawer takes 90% of the stage.
        sidebarWidth = 620;
        rail.syncArtifactReviewLayout();
        assert.equal(props['--artifact-review-width'], '702px', 'crossing the overlay threshold releases the chat reserve');
        sidebarWidth = 310;
        rail.syncArtifactReviewLayout();
        assert.equal(props['--artifact-review-width'], '730px', 'widening the sidebar shrinks a shared rail');
      }
    });
  }
});

// Row 34 S5 (v2 §6): in split view the code review opens over the pane of the
// chat that owns it when the panes can't each keep about 40rem beside it.
describe('split view code review', () => {
  for (const [name, stageWidth, mode, expected] of [
    ['narrow panes: over the owning pane', 1600, 'code_review', '1'],
    ['wide panes: beside both chats', 2400, 'code_review', undefined],
    ['artifacts keep the shared column', 1600, 'artifact', undefined],
  ]) {
    test(name, (t) => {
      withWindowShim(t, {}, 2600);
      const state = makeState('s1');
      state.panes = { panes: [{ paneId: 'p0', sessionId: 's0' }, { paneId: 'p1', sessionId: 's1' }], focusedPaneId: 'p1', splitRatio: 0.5 };
      const classes = new Set();
      const chatView = { dataset: { paneCount: '2' }, classList: { toggle(cls, on) { if (on) classes.add(cls); else classes.delete(cls); } } };
      const removed = [];
      const panel = {
        addEventListener() {}, removeEventListener() {}, dataset: {},
        style: { setProperty() {}, removeProperty(prop) { removed.push(prop); } },
        classList: { toggle() {} },
      };
      const workspace = { getBoundingClientRect: () => ({ width: stageWidth }), style: { setProperty() {} } };
      const rail = makeRail(state, { dom: { workspace, chatView, artifactReviewPanel: panel } });
      t.after(() => rail.dispose());
      rail.bind();
      rail.openArtifactRail(mode);
      rail.syncArtifactReviewLayout();
      assert.equal(chatView.dataset.sidePanelPane, expected);
      assert.equal(classes.has('artifact-review-open'), expected === undefined, 'over a pane, the shared column closes');
      if (expected) assert.ok(removed.includes('width'), 'the pane sizes the panel');
    });
  }
});

// Row 59 checkpoint 1: an explicit open or close glides the column while the
// reading text reflows once (renderer-side-panel-motion.js); every other sync
// (render passes, session restore, overlay, maximize) applies its state at once.
describe('side-by-side column motion', () => {
  const { JSDOM } = require('jsdom');

  function makeMotionRail(t, { stageWidth = 1600, duration = '220ms' } = {}) {
    withWindowShim(t, {}, 2000);
    const dom = new JSDOM('<!doctype html><div id="chatView" class="chat-view" data-pane-count="1">'
      + '<div class="chat-pane"><div data-chat-node="chatTimeline"></div><div class="composer"></div></div>'
      + '<div id="resizer" class="artifact-review-resizer hidden"></div>'
      + '<aside id="panel" class="artifact-review-panel hidden"></aside></div>');
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    const chatView = doc.getElementById('chatView');
    const panel = doc.getElementById('panel');
    chatView.style.setProperty('--motion-duration-regular', duration);
    Object.defineProperty(panel, 'clientWidth', { value: 419, configurable: true });
    doc.querySelector('[data-chat-node="chatTimeline"]').getBoundingClientRect = () => ({ width: chatView.classList.contains('artifact-review-open') ? 640 : 900 });
    const workspace = { getBoundingClientRect: () => ({ width: stageWidth }), style: { setProperty() {} } };
    const calls = [];
    const state = makeState('s1');
    const rail = makeRail(state, {
      dom: { workspace, chatView, artifactReviewPanel: panel, artifactReviewResizer: doc.getElementById('resizer') },
      callbacks: {
        getScrollCoordinators: () => [{
          captureReaderAnchor: () => calls.push(`capture:${doc.querySelector('.chat-pane').style.getPropertyValue('--chat-measure-lock') || '-'}`),
          restoreReaderAnchor: () => calls.push(`restore:${doc.querySelector('.chat-pane').style.getPropertyValue('--chat-measure-lock') || '-'}`),
        }],
      },
    });
    t.after(() => rail.dispose());
    rail.bind();
    const lock = () => doc.querySelector('.chat-pane').style.getPropertyValue('--chat-measure-lock');
    const phase = () => chatView.dataset.panelMotion;
    const settle = () => panel.dispatchEvent(new dom.window.Event('animationend'));
    return { rail, state, dom, chatView, panel, calls, lock, phase, settle };
  }

  test('an explicit open locks the end measure, brackets the anchor and releases when settled', (t) => {
    const f = makeMotionRail(t);
    f.rail.openArtifactRail('artifact');
    assert.equal(f.phase(), 'opening');
    assert.equal(f.chatView.classList.contains('artifact-review-open'), true);
    assert.equal(f.panel.classList.contains('hidden'), false);
    assert.equal(f.lock(), '640px', 'the measure the pane has with the panel open');
    assert.deepEqual(f.calls, ['capture:-', 'restore:640px']);
    f.calls.length = 0;
    f.settle();
    assert.equal(f.phase(), undefined);
    assert.equal(f.lock(), '');
    assert.deepEqual(f.calls, ['capture:640px', 'restore:-']);
  });

  test('a render pass in the same state leaves the running motion alone', (t) => {
    const f = makeMotionRail(t);
    f.rail.openArtifactRail('artifact');
    f.rail.syncArtifactReviewLayout({ refreshChatChrome: true });
    assert.equal(f.phase(), 'opening');
    assert.equal(f.lock(), '640px');
  });

  test('close keeps the column up until it has collapsed, then lands the closed state', (t) => {
    const f = makeMotionRail(t);
    f.rail.beginRender(); // the app has rendered this chat before the user opens the panel
    f.rail.openArtifactRail('artifact');
    f.settle();
    f.calls.length = 0;
    f.rail.closeArtifactReview({ dismiss: true });
    assert.equal(f.phase(), 'closing');
    assert.equal(f.lock(), '640px', 'locked at the current measure');
    assert.equal(f.chatView.classList.contains('artifact-review-open'), true, 'the column stays until it has collapsed');
    assert.equal(f.panel.classList.contains('hidden'), false);
    assert.deepEqual(f.calls, [], 'no reflow yet: the lock equals the current measure');
    f.rail.beginRender(); // a render pass mid-close does not end it early
    assert.equal(f.panel.classList.contains('hidden'), false);
    f.settle();
    assert.equal(f.panel.classList.contains('hidden'), true);
    assert.equal(f.chatView.classList.contains('artifact-review-open'), false);
    assert.equal(f.phase(), undefined);
    assert.equal(f.lock(), '');
    assert.deepEqual(f.calls, ['capture:640px', 'restore:-'], 'anchor brackets the release');
  });

  test('re-opening mid-close cancels it and snaps; closing mid-open snaps shut', (t) => {
    const f = makeMotionRail(t);
    f.rail.openArtifactRail('artifact');
    f.settle();
    f.rail.closeArtifactReview({ dismiss: false });
    f.rail.openArtifactRail('artifact');
    assert.equal(f.phase(), undefined, 'the close was cancelled, the open lands at once');
    assert.equal(f.lock(), '');
    assert.equal(f.chatView.classList.contains('artifact-review-open'), true);
    f.rail.closeArtifactReview({ dismiss: false });
    f.settle();
    f.rail.openArtifactRail('artifact');
    assert.equal(f.phase(), 'opening');
    f.rail.closeArtifactReview({ dismiss: false });
    assert.equal(f.phase(), undefined, 'closing a half-open column snaps');
    assert.equal(f.lock(), '');
    assert.equal(f.panel.classList.contains('hidden'), true);
  });

  test('restoring an open panel, rendering and resizing never animate', (t) => {
    const f = makeMotionRail(t);
    f.state.ui.artifactReview.enabled = true;
    assert.equal(f.rail.beginRender(), true);
    assert.equal(f.chatView.classList.contains('artifact-review-open'), true);
    assert.equal(f.phase(), undefined);
    assert.deepEqual(f.calls, [], 'no anchor traffic when nothing reflows by motion');
    f.rail.syncArtifactReviewLayout();
    assert.equal(f.phase(), undefined);
  });

  test('the owner-pane collapse (a layout reconcile) snaps instead of gliding', (t) => {
    const f = makeMotionRail(t);
    f.rail.beginRender();
    f.rail.openArtifactRail('artifact');
    f.settle();
    f.rail.collapseArtifactReview();
    assert.equal(f.phase(), undefined, 'no close motion');
    assert.equal(f.lock(), '');
    assert.equal(f.panel.classList.contains('hidden'), true);
    assert.equal(f.chatView.classList.contains('artifact-review-open'), false);
  });

  test('a session switch mid-open releases the lock', (t) => {
    const f = makeMotionRail(t);
    f.rail.beginRender();
    f.rail.openArtifactRail('artifact');
    assert.equal(f.phase(), 'opening');
    f.state.currentSessionId = 's2';
    f.rail.beginRender();
    assert.equal(f.phase(), undefined);
    assert.equal(f.lock(), '');
  });

  test('overlay drawers, maximize and reduced motion apply at once', (t) => {
    const overlay = makeMotionRail(t, { stageWidth: 760 });
    overlay.rail.openArtifactRail('artifact');
    assert.equal(overlay.phase(), undefined, 'the overlay drawer keeps its own slide-in');
    assert.equal(overlay.panel.classList.contains('artifact-review-overlay'), true);

    const maximize = makeMotionRail(t);
    maximize.rail.openArtifactRail('artifact');
    maximize.settle();
    maximize.rail.toggleArtifactReviewMaximized(true);
    assert.equal(maximize.phase(), undefined);

    const reduced = makeMotionRail(t, { duration: '0ms' });
    reduced.rail.openArtifactRail('artifact');
    assert.equal(reduced.phase(), undefined);
    assert.equal(reduced.lock(), '');
    assert.equal(reduced.chatView.classList.contains('artifact-review-open'), true, 'the end state is applied immediately');
    assert.deepEqual(reduced.calls, ['capture:-', 'restore:-'], 'still one reflow, bracketed by the anchor');
  });
});
