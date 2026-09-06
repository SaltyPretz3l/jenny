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

describe('renderer-shell-artifact-bridge preference normalization', () => {
  test('userDismissed defaults to false and accepts only booleans', () => {
    assert.equal(makeBridge({ [STORAGE_KEY]: JSON.stringify({ enabled: true }) }).bridge.getArtifactReviewPreferenceState().userDismissed, false);
    assert.equal(makeBridge({ [STORAGE_KEY]: JSON.stringify({ userDismissed: true }) }).bridge.getArtifactReviewPreferenceState().userDismissed, true);
    assert.equal(makeBridge({ [STORAGE_KEY]: JSON.stringify({ userDismissed: 'yes' }) }).bridge.getArtifactReviewPreferenceState().userDismissed, false);
  });

  test('resetArtifactsState clears auto-open session state', () => {
    const { state, bridge } = makeBridge({});
    state.artifacts.autoOpenedSessionIds = ['s1', 's2'];
    bridge.resetArtifactsState();
    assert.deepEqual(state.artifacts.autoOpenedSessionIds, []);
  });
});
