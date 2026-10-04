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
        sidebarWidth = 420;
        rail.syncArtifactReviewLayout();
        assert.equal(props['--artifact-review-width'], '775px', 'stored width fits the new overlay ceiling of 882');
        prefsUtils.recordArtifactReviewWidth(rail.getArtifactReviewState(), 's1', 4000);
        rail.syncArtifactReviewLayout();
        assert.equal(props['--artifact-review-width'], '882px', 'crossing the overlay threshold releases the chat reserve');
        sidebarWidth = 310;
        rail.syncArtifactReviewLayout();
        assert.equal(props['--artifact-review-width'], '730px', 'widening the sidebar shrinks a shared rail');
      }
    });
  }
});
