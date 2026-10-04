'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createShellArtifactBridge } = require('../renderer/shell/renderer-shell-artifact-bridge');

const STORAGE_KEY = 'jenny.artifactReview.test';

function makeBridge(store) {
  const state = { ui: {}, artifacts: {} };
  const bridge = createShellArtifactBridge({
    state,
    windowRef: { localStorage: { getItem: (key) => (key in store ? store[key] : null) } },
    constants: { ARTIFACT_REVIEW_STORAGE_KEY: STORAGE_KEY },
  });
  return { state, bridge };
}

describe('renderer-shell-artifact-bridge review-preference cache', () => {
  test('parses the stored blob once across repeated reads, re-parses when it changes', () => {
    const store = { [STORAGE_KEY]: JSON.stringify({ enabled: true, width: 480 }) };
    const { bridge } = makeBridge(store);
    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = (...args) => { parseCount += 1; return originalParse(...args); };
    try {
      bridge.getArtifactReviewPreferenceState();
      bridge.getArtifactReviewPreferenceState();
      bridge.getArtifactReviewPreferenceState();
      assert.equal(parseCount, 1);
      store[STORAGE_KEY] = JSON.stringify({ enabled: false, width: 480 });
      bridge.getArtifactReviewPreferenceState();
      assert.equal(parseCount, 2);
    } finally {
      JSON.parse = originalParse;
    }
  });

  test('reflects the latest stored value', () => {
    const store = { [STORAGE_KEY]: JSON.stringify({ enabled: true }) };
    const { bridge } = makeBridge(store);
    assert.equal(bridge.getArtifactReviewPreferenceState().enabled, true);
    store[STORAGE_KEY] = JSON.stringify({ enabled: false });
    assert.equal(bridge.getArtifactReviewPreferenceState().enabled, false);
    delete store[STORAGE_KEY];
    assert.equal(bridge.getArtifactReviewPreferenceState().enabled, false);
  });

  test('falls back to defaults on malformed state', () => {
    const { bridge } = makeBridge({ [STORAGE_KEY]: '{not valid json' });
    assert.doesNotThrow(() => bridge.getArtifactReviewPreferenceState());
    assert.equal(bridge.getArtifactReviewPreferenceState().enabled, false);
  });
});

describe('renderer-shell-artifact-bridge subagent rail hook', () => {
  test('publishes a lazy rail builder for the pane monitors and removes it on cleanup', () => {
    const cleanups = [];
    const windowRef = { localStorage: { getItem: () => null } };
    createShellArtifactBridge({
      state: { ui: {}, artifacts: {} },
      windowRef,
      constants: { ARTIFACT_REVIEW_STORAGE_KEY: STORAGE_KEY },
      registerCleanup: (fn) => cleanups.push(fn),
    });
    assert.equal(typeof windowRef.rendererEnsureSubagentRail, 'function');
    const rail = windowRef.rendererEnsureSubagentRail();
    assert.equal(typeof rail?.open, 'function', 'the hook builds the rail');
    assert.equal(windowRef.rendererEnsureSubagentRail(), rail, 'a second call reuses it');
    for (const fn of cleanups) fn();
    assert.equal(Object.hasOwn(windowRef, 'rendererEnsureSubagentRail'), false);
  });
});

describe('renderer-shell-artifact-bridge preference normalization', () => {
  test('the retired global userDismissed is ignored; per-chat dismissal and per-kind wrap ride the lockstep', () => {
    const legacy = makeBridge({ [STORAGE_KEY]: JSON.stringify({ enabled: true, collapsed: true, userDismissed: true }) }).bridge.getArtifactReviewPreferenceState();
    assert.equal('userDismissed' in legacy, false);
    assert.equal(legacy.enabled, false, 'a retired collapsed:true reads as the one closed state');
    assert.deepEqual(legacy.textWrap, { output: true, code: true });
    const current = makeBridge({ [STORAGE_KEY]: JSON.stringify({ enabled: true, dismissedForSession: { 's1': true }, textWrap: { output: false } }) }).bridge.getArtifactReviewPreferenceState();
    assert.deepEqual(current.dismissedForSession, { s1: true });
    assert.deepEqual(current.textWrap, { output: false, code: true });
  });

  test('resetArtifactsState clears auto-open session state', () => {
    const { state, bridge } = makeBridge({});
    state.artifacts.autoOpenedSessionIds = ['s1', 's2'];
    bridge.resetArtifactsState();
    assert.deepEqual(state.artifacts.autoOpenedSessionIds, []);
  });
});

test('the dormant artifact auto-open pre-check stops before projection when the preference is off', () => {
  let projections = 0;
  let builds = 0;
  let renders = 0;
  const state = {
    currentSessionId: 's1', sessions: [{ id: 's1' }],
    messagesBySession: new Map([['s1', [{ role: 'tool' }]]]),
    ui: { activeView: 'chat', appearance: {} }, artifacts: {},
  };
  const bridge = createShellArtifactBridge({
    state, constants: { ARTIFACT_REVIEW_STORAGE_KEY: STORAGE_KEY },
    callbacks: { getActiveSession: () => state.sessions[0] },
    windowRef: { localStorage: { getItem: () => null } },
    buildArtifactsFromMessages: () => { projections += 1; return [{ id: 'a1' }]; },
    artifactsUtils: { createArtifactManager: () => {
      builds += 1;
      return { renderArtifactReviewPanel: () => { renders += 1; return 'rendered'; } };
    } },
  });
  for (const value of [undefined, false, 'true', 1]) {
    state.ui.appearance.artifactAutoOpen = value;
    assert.equal(bridge.renderArtifactReviewPanelSafe(), null);
  }
  assert.equal(projections, 0);
  assert.equal(builds, 0);
  assert.equal(renders, 0);
  state.ui.appearance.artifactAutoOpen = true;
  assert.equal(bridge.renderArtifactReviewPanelSafe(), 'rendered');
  assert.equal(projections, 1);
  assert.equal(builds, 1);
  assert.equal(renders, 1);
});
