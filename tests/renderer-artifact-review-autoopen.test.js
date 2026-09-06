'use strict';

// Pure unit suite for the artifact-review automatic presentation module.
// It presents once per session, defaults newly enabled panels to collapsed,
// and preserves an existing persisted open/collapsed choice.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createArtifactReviewAutoOpen } = require('../renderer/features/renderer-artifact-review-autoopen');

function makeHarness(overrides = {}) {
  const prefs = {
    enabled: false,
    collapsed: false,
    width: 420,
    userDismissed: false,
    ...(overrides.prefs || {}),
  };
  const stateStore = { autoOpened: [...(overrides.autoOpened || [])] };
  let saveCount = 0;
  const deps = {
    getActiveSessionId: () => (overrides.sessionId === undefined ? 'session-1' : overrides.sessionId),
    getArtifactReviewState: () => prefs,
    saveArtifactReviewPreferences: () => { saveCount += 1; },
    isArtifactReviewEligible: () => overrides.eligible !== false,
    getArtifactCount: () => (overrides.artifactCount === undefined ? 1 : overrides.artifactCount),
    getAutoOpenedSessionIds: () => stateStore.autoOpened,
    setAutoOpenedSessionIds: (ids) => { stateStore.autoOpened = ids; },
    selectNewestArtifact: () => (overrides.newestId === undefined ? 'artifact-9' : overrides.newestId),
    appendClientLog: () => {},
    ...(overrides.deps || {}),
  };
  const controller = createArtifactReviewAutoOpen(deps);
  return { controller, prefs, stateStore, getSaveCount: () => saveCount };
}

describe('artifact-review auto-presentation gating', () => {
  test('presents once per session: first render selects but stays collapsed', () => {
    const h = makeHarness();
    assert.equal(h.controller.maybeAutoOpen(), true, 'first eligible render presents');
    assert.equal(h.prefs.enabled, true);
    assert.equal(h.prefs.collapsed, true);
    assert.deepEqual(h.stateStore.autoOpened, ['session-1']);
    assert.ok(h.getSaveCount() >= 1, 'the presentation persists preferences');
    assert.equal(h.controller.maybeAutoOpen(), false, 'second render for the same session no-ops');
  });

  test('preserves a persisted enabled and expanded panel preference', () => {
    const h = makeHarness({ prefs: { enabled: true, collapsed: false } });
    assert.equal(h.controller.maybeAutoOpen(), true);
    assert.equal(h.prefs.enabled, true);
    assert.equal(h.prefs.collapsed, false);
  });

  test('sticky dismiss: userDismissed=true never presents, even for a new session', () => {
    const h = makeHarness({ prefs: { userDismissed: true } });
    assert.equal(h.controller.maybeAutoOpen(), false);
    assert.deepEqual(h.stateStore.autoOpened, [], 'a dismissed render does not consume the session slot');
  });

  test('ineligible (narrow stage / wrong view): never presents and does not consume the session', () => {
    const h = makeHarness({ eligible: false });
    assert.equal(h.controller.maybeAutoOpen(), false);
    assert.deepEqual(h.stateStore.autoOpened, []);
  });

  test('zero artifacts: never presents', () => {
    const h = makeHarness({ artifactCount: 0 });
    assert.equal(h.controller.maybeAutoOpen(), false);
  });

  test('no active session: never presents', () => {
    const h = makeHarness({ sessionId: '' });
    assert.equal(h.controller.maybeAutoOpen(), false);
  });

  test('session FIFO bounds at 50 (oldest evicted, never persisted here)', () => {
    const seeded = Array.from({ length: 50 }, (_unused, index) => `old-${index}`);
    const h = makeHarness({ autoOpened: seeded });
    assert.equal(h.controller.maybeAutoOpen(), true);
    assert.equal(h.stateStore.autoOpened.length, 50, 'FIFO stays bounded at 50');
    assert.equal(h.stateStore.autoOpened.includes('old-0'), false, 'oldest entry evicted');
    assert.equal(h.stateStore.autoOpened.at(-1), 'session-1', 'newest session appended');
  });
});
