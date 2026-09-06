'use strict';

// Artifact Panel V2 (Slice A) — per-session width persistence.
//
// The persisted localStorage blob `jenny.artifactReview.v1` gains an OPTIONAL
// `widthBySession` map { [sessionId]: clampedWidth }. Contracts pinned here:
//   - flag-gated APPLY: widthBySession[activeSessionId] ?? legacy global width
//     (the global width IS the migration seed — no marker);
//   - applied clamp = min 320, max = max(320, min(floor(windowWidth * 0.9),
//     windowWidth - 360)) in BOTH flag states (owner restyle 2026-08-20: the
//     rail resizes toward 90% of the window but always reserves 360px for the
//     chat column so the composer never spills; the old 560 constant is now a
//     persistence-sanity ceiling of 4000 only, so wide saved widths survive
//     normalization);
//   - BOTH normalizers (renderer-artifact-review-prefs.js and the bridge's in
//     renderer-shell-artifact-bridge.js) must PRESERVE widthBySession — a
//     normalizer stripping it makes the next save silently drop all
//     per-session widths (the named failure mode);
//   - the map is bounded at 40 entries, oldest-insertion eviction;
//   - flag-off save of a legacy-only blob round-trips byte-identically
//     (no widthBySession key materialized).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const prefsModule = require('../renderer/features/renderer-artifact-review-prefs');
const artifactsUtils = require('../renderer/features/renderer-artifacts-utils');
const { createShellArtifactBridge } = require('../renderer/shell/renderer-shell-artifact-bridge');

const STORAGE_KEY = 'jenny.artifactReview.v1';

const {
  clampArtifactReviewWidth,
  normalizeArtifactReviewPreferences,
  loadArtifactReviewPreferences,
  saveArtifactReviewPreferences,
  resolveEffectiveArtifactReviewWidth,
  recordArtifactReviewWidth,
} = prefsModule;

function makeWindowShim(store, { innerWidth = 1600 } = {}) {
  return {
    innerWidth,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
    },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  };
}

function withWindowShim(t, store, options) {
  const previous = globalThis.window;
  globalThis.window = makeWindowShim(store, options);
  t.after(() => {
    if (previous === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previous;
    }
  });
  return globalThis.window;
}

function makeState({ flagOn = true } = {}) {
  return {
    ui: { activeView: 'chat', artifactReview: {} },
    artifacts: {
      filter: 'all',
      selectedArtifactId: '',
      selectedSessionId: '',
      loadedArtifactId: '',
      loadedArtifactContent: '',
      dirtyContent: '',
      lastError: '',
      loading: false,
      savePending: false,
      mermaidViewMode: 'preview',
      viewModeByKind: {},
      autoOpenedSessionIds: [],
    },
    messagesBySession: new Map(),
    features: { featureFlags: { artifact_panel_v2: flagOn } },
  };
}

function makeWorkspaceFake() {
  const props = {};
  return {
    props,
    style: { setProperty: (name, value) => { props[name] = value; } },
    getBoundingClientRect: () => ({ width: 1400 }),
  };
}

function makeManager(state, activeSessionRef, workspace) {
  return artifactsUtils.createArtifactManager({
    state,
    dom: { workspace },
    callbacks: {
      escapeHtml: (value) => String(value == null ? '' : value),
      getActiveSession: () => (activeSessionRef.id ? { id: activeSessionRef.id } : null),
      setActiveView: () => {},
      scrollMessageIntoView: () => {},
      appendClientLog: () => {},
      showToastMessage: () => {},
      toErrorMessage: (error) => String(error?.message || error || ''),
      updateComposerSafeOffset: () => {},
      renderAll: () => {},
    },
  });
}

function appliedWidth(workspace) {
  return workspace.props['--artifact-review-width'];
}

describe('prefs module — resolveEffectiveArtifactReviewWidth', () => {
  test('flag-off ignores widthBySession but still honours the dynamic window bound', () => {
    const prefs = { width: 560, widthBySession: { 'session-a': 400 } };
    assert.equal(
      resolveEffectiveArtifactReviewWidth(prefs, 'session-a', { flagOn: false, windowWidth: 900 }),
      540,
      'flag-off ignores the per-session entry; the 360px chat-column reserve bounds 900 to 540'
    );
    assert.equal(
      resolveEffectiveArtifactReviewWidth({ width: 1400 }, 'session-a', { flagOn: false, windowWidth: 1000 }),
      640,
      'flag-off routes through the SAME dynamic max: min(floor(1000*0.9), 1000-360)'
    );
    assert.equal(
      resolveEffectiveArtifactReviewWidth({ width: 9999 }, '', { flagOn: false }),
      4000,
      'no window measurement -> the sanity ceiling, not a shrink'
    );
    assert.equal(resolveEffectiveArtifactReviewWidth({ width: 10 }, '', { flagOn: false }), 320);
    assert.equal(resolveEffectiveArtifactReviewWidth({}, '', { flagOn: false }), 420);
  });

  test('legacy persisted widths (320..560) load and resolve unchanged on a normal window', () => {
    for (const width of [320, 360, 420, 500, 560]) {
      assert.equal(
        resolveEffectiveArtifactReviewWidth({ width }, '', { flagOn: false, windowWidth: 1600 }),
        width
      );
      assert.equal(
        resolveEffectiveArtifactReviewWidth({ width: 420, widthBySession: { 'session-a': width } }, 'session-a', { flagOn: true, windowWidth: 1600 }),
        width
      );
    }
  });

  test('the dynamic max is min(90% of window, window - 360 chat reserve) in both flag states', () => {
    const wide = { width: 4000, widthBySession: { 'session-a': 4000 } };
    // Below 3600px the chat-column reserve governs (owner report 2026-08-20:
    // the composer spilled once the rail ate the whole column); above it the
    // 90% fraction does.
    for (const [windowWidth, expected] of [[1920, 1560], [2560, 2200], [1000, 640], [3440, 3080], [4000, 3600]]) {
      assert.equal(resolveEffectiveArtifactReviewWidth(wide, 'session-a', { flagOn: true, windowWidth }), expected);
      assert.equal(resolveEffectiveArtifactReviewWidth(wide, 'session-a', { flagOn: false, windowWidth }), expected);
    }
    assert.equal(prefsModule.resolveArtifactReviewMaxWidth(1920), 1560);
    assert.equal(prefsModule.resolveArtifactReviewMaxWidth(4000), 3600);
    assert.equal(prefsModule.resolveArtifactReviewMaxWidth(0), 4000, 'degenerate window -> sanity ceiling');
    assert.equal(prefsModule.resolveArtifactReviewMaxWidth(200), 320, 'the 320 floor still wins');
    assert.equal(prefsModule.ARTIFACT_REVIEW_MAX_WIDTH, 4000);
    assert.equal(prefsModule.ARTIFACT_REVIEW_MIN_WIDTH, 320);
  });

  test('flag-on: per-session width wins; missing entry falls back to the global seed', () => {
    const prefs = { width: 505, widthBySession: { 'session-a': 480 } };
    assert.equal(
      resolveEffectiveArtifactReviewWidth(prefs, 'session-a', { flagOn: true, windowWidth: 1600 }),
      480
    );
    assert.equal(
      resolveEffectiveArtifactReviewWidth(prefs, 'session-b', { flagOn: true, windowWidth: 1600 }),
      505,
      'a session with no stored width uses the legacy global width as the seed'
    );
    assert.equal(
      resolveEffectiveArtifactReviewWidth({}, 'session-b', { flagOn: true, windowWidth: 1600 }),
      420,
      'no stored widths at all -> default'
    );
  });

  test('flag-on applied clamp is min 320, max = min(90% of window, window - reserve)', () => {
    const prefs = { width: 420, widthBySession: { 'session-a': 1500 } };
    assert.equal(
      resolveEffectiveArtifactReviewWidth(prefs, 'session-a', { flagOn: true, windowWidth: 900 }),
      540,
      'window 900 -> the 360 chat reserve bounds the stored 1500 to 540'
    );
    assert.equal(
      resolveEffectiveArtifactReviewWidth(prefs, 'session-a', { flagOn: true, windowWidth: 4000 }),
      1500,
      'a wide window applies the stored width verbatim — no 560 cap any more'
    );
    assert.equal(
      resolveEffectiveArtifactReviewWidth(prefs, 'session-a', { flagOn: true, windowWidth: 300 }),
      320,
      'min 320 floor holds even when 90% of window is below it'
    );
  });
});

describe('prefs module — recordArtifactReviewWidth', () => {
  test('flag-on writes widthBySession[sessionId] and leaves the global width untouched', () => {
    const prefs = { width: 505, widthBySession: {} };
    recordArtifactReviewWidth(prefs, 'session-a', 480, { flagOn: true });
    assert.equal(prefs.widthBySession['session-a'], 480);
    assert.equal(prefs.width, 505, 'the global width stays the fallback seed');
  });

  test('flag-off writes the global width and never materializes the map', () => {
    const prefs = { width: 420 };
    recordArtifactReviewWidth(prefs, 'session-a', 480, { flagOn: false });
    assert.equal(prefs.width, 480);
    assert.equal('widthBySession' in prefs, false);
  });

  test('recorded values are clamped to the 320..4000 sanity range', () => {
    const prefs = { width: 420 };
    recordArtifactReviewWidth(prefs, 'session-a', 9999, { flagOn: true });
    assert.equal(prefs.widthBySession['session-a'], 4000, 'only the sanity ceiling bounds the WRITE');
    recordArtifactReviewWidth(prefs, 'session-a', 1, { flagOn: true });
    assert.equal(prefs.widthBySession['session-a'], 320);
    recordArtifactReviewWidth(prefs, 'session-a', 1600, { flagOn: true });
    assert.equal(prefs.widthBySession['session-a'], 1600, 'a wide width is stored, not shrunk to 560');
  });

  test('the 41st distinct session evicts the oldest entry; size stays 40', () => {
    const prefs = { width: 420 };
    for (let i = 1; i <= 40; i += 1) {
      recordArtifactReviewWidth(prefs, `session-${i}`, 400 + (i % 100), { flagOn: true });
    }
    assert.equal(Object.keys(prefs.widthBySession).length, 40);
    recordArtifactReviewWidth(prefs, 'session-41', 444, { flagOn: true });
    const keys = Object.keys(prefs.widthBySession);
    assert.equal(keys.length, 40, 'cap holds at 40');
    assert.equal('session-1' in prefs.widthBySession, false, 'oldest insertion evicted');
    assert.equal(prefs.widthBySession['session-41'], 444);
    // Re-recording an existing session must not evict anything.
    recordArtifactReviewWidth(prefs, 'session-41', 460, { flagOn: true });
    assert.equal(Object.keys(prefs.widthBySession).length, 40);
    assert.equal(prefs.widthBySession['session-41'], 460);
  });
});

describe('prefs module — normalizer preserves widthBySession (the silent-loss failure mode)', () => {
  test('valid entries survive normalization; malformed entries are dropped without crashing', () => {
    const normalized = normalizeArtifactReviewPreferences({
      enabled: true,
      width: 505,
      widthBySession: {
        'session-a': 480,
        'session-b': '450',
        'session-neg': -50,
        'session-nan': Number.NaN,
        'session-empty': '',
        'session-nested': { width: 400 },
        '': 500,
        'session-huge': 9999,
      },
    });
    assert.deepEqual(normalized.widthBySession, {
      'session-a': 480,
      'session-b': 450,
      'session-huge': 4000,
    });
  });

  test('a persisted width above the sanity ceiling is clamped; a wide-but-sane one survives', () => {
    const normalized = normalizeArtifactReviewPreferences({
      width: 999999,
      widthBySession: { 'session-wide': 2400, 'session-absurd': 1e9 },
    });
    assert.equal(normalized.width, 4000);
    assert.deepEqual(normalized.widthBySession, { 'session-wide': 2400, 'session-absurd': 4000 });
  });

  test('legacy 320..560 persisted widths load byte-identically', () => {
    for (const width of [320, 400, 420, 505, 560]) {
      const normalized = normalizeArtifactReviewPreferences({ width, widthBySession: { 'session-a': width } });
      assert.equal(normalized.width, width);
      assert.deepEqual(normalized.widthBySession, { 'session-a': width });
    }
  });

  test('the key is dropped entirely when empty or absent (legacy blob stays legacy)', () => {
    assert.equal('widthBySession' in normalizeArtifactReviewPreferences({ enabled: true, width: 505 }), false);
    assert.equal(
      'widthBySession' in normalizeArtifactReviewPreferences({ width: 420, widthBySession: { '': 1, x: 'nope' } }),
      false
    );
    assert.equal('widthBySession' in normalizeArtifactReviewPreferences({ widthBySession: [480] }), false);
  });

  test('normalization bounds an oversized persisted map to the newest 40 entries', () => {
    const oversized = {};
    for (let i = 1; i <= 45; i += 1) oversized[`session-${i}`] = 400;
    const normalized = normalizeArtifactReviewPreferences({ widthBySession: oversized });
    const keys = Object.keys(normalized.widthBySession);
    assert.equal(keys.length, 40);
    assert.equal('session-1' in normalized.widthBySession, false, 'oldest entries trimmed first');
    assert.equal('session-45' in normalized.widthBySession, true);
  });
});

describe('prefs module — save / load round-trips', () => {
  test('save includes widthBySession only when non-empty; flag-off legacy save is byte-identical', () => {
    const store = {};
    const windowRef = makeWindowShim(store);
    const legacyBlob = JSON.stringify({ enabled: true, collapsed: false, width: 505, userDismissed: false });
    windowRef.localStorage.setItem(STORAGE_KEY, legacyBlob);

    const prefs = loadArtifactReviewPreferences(windowRef, STORAGE_KEY);
    saveArtifactReviewPreferences(windowRef, STORAGE_KEY, prefs);
    assert.equal(store[STORAGE_KEY], legacyBlob, 'legacy-only blob round-trips byte-identically');

    recordArtifactReviewWidth(prefs, 'session-a', 480, { flagOn: true });
    saveArtifactReviewPreferences(windowRef, STORAGE_KEY, prefs);
    const written = JSON.parse(store[STORAGE_KEY]);
    assert.deepEqual(written.widthBySession, { 'session-a': 480 });
    assert.equal(written.width, 505, 'global width stays the seed');
  });

  test('restart survival: a fresh load over the same store restores per-session widths', () => {
    const store = {};
    const windowRef = makeWindowShim(store);
    const prefs = loadArtifactReviewPreferences(windowRef, STORAGE_KEY);
    recordArtifactReviewWidth(prefs, 'session-a', 470, { flagOn: true });
    saveArtifactReviewPreferences(windowRef, STORAGE_KEY, prefs);

    const reloaded = loadArtifactReviewPreferences(makeWindowShim(store), STORAGE_KEY);
    assert.equal(
      resolveEffectiveArtifactReviewWidth(reloaded, 'session-a', { flagOn: true, windowWidth: 1600 }),
      470
    );
  });
});

describe('manager wiring — flag-gated per-session width apply (renderer-artifacts-utils.js)', () => {
  test('flag-on: session A width applies, session B falls back, returning to A restores it', (t) => {
    const store = {
      [STORAGE_KEY]: JSON.stringify({
        enabled: true, collapsed: false, width: 420, userDismissed: false,
        widthBySession: { 'session-a': 500 },
      }),
    };
    withWindowShim(t, store);
    const state = makeState({ flagOn: true });
    const active = { id: 'session-a' };
    const workspace = makeWorkspaceFake();
    const manager = makeManager(state, active, workspace);

    manager.syncArtifactReviewLayout();
    assert.equal(appliedWidth(workspace), '500px', 'session A gets its stored width');

    active.id = 'session-b';
    manager.syncArtifactReviewLayout();
    assert.equal(appliedWidth(workspace), '420px', 'session B has no entry -> global seed/default');

    active.id = 'session-a';
    manager.syncArtifactReviewLayout();
    assert.equal(appliedWidth(workspace), '500px', 'returning to A restores its width');
  });

  test('restart survival at the manager level: a new manager over the same store restores A', (t) => {
    const store = {
      [STORAGE_KEY]: JSON.stringify({
        enabled: true, collapsed: false, width: 420, userDismissed: false,
        widthBySession: { 'session-a': 505 },
      }),
    };
    withWindowShim(t, store);
    const active = { id: 'session-a' };

    const firstWorkspace = makeWorkspaceFake();
    makeManager(makeState({ flagOn: true }), active, firstWorkspace).syncArtifactReviewLayout();
    assert.equal(appliedWidth(firstWorkspace), '505px');

    const secondWorkspace = makeWorkspaceFake();
    makeManager(makeState({ flagOn: true }), active, secondWorkspace).syncArtifactReviewLayout();
    assert.equal(appliedWidth(secondWorkspace), '505px', 'a fresh manager instance restores the width');
  });

  test('migration seed: legacy blob {enabled:true,width:505} with no widthBySession applies 505', (t) => {
    const store = { [STORAGE_KEY]: JSON.stringify({ enabled: true, width: 505 }) };
    withWindowShim(t, store);
    const state = makeState({ flagOn: true });
    const workspace = makeWorkspaceFake();
    const manager = makeManager(state, { id: 'session-a' }, workspace);
    manager.syncArtifactReviewLayout();
    assert.equal(appliedWidth(workspace), '505px', 'the legacy global width seeds the fallback');
  });

  test('clamp: stored per-session 9999 is bounded by the resolved window max flag-on', (t) => {
    const store = {
      [STORAGE_KEY]: JSON.stringify({
        enabled: true, collapsed: false, width: 420, userDismissed: false,
        widthBySession: { 'session-a': 9999 },
      }),
    };
    withWindowShim(t, store, { innerWidth: 900 });
    const state = makeState({ flagOn: true });
    const workspace = makeWorkspaceFake();
    makeManager(state, { id: 'session-a' }, workspace).syncArtifactReviewLayout();
    assert.equal(appliedWidth(workspace), '540px', 'min(floor(900*0.9), 900-360) = 540 caps the applied width');
  });

  test('a wide persisted width applies verbatim on a wide window (the 560 cap is gone)', (t) => {
    const store = {
      [STORAGE_KEY]: JSON.stringify({
        enabled: true, collapsed: false, width: 420, userDismissed: false,
        widthBySession: { 'session-a': 1700 },
      }),
    };
    withWindowShim(t, store, { innerWidth: 2560 });
    const workspace = makeWorkspaceFake();
    makeManager(makeState({ flagOn: true }), { id: 'session-a' }, workspace).syncArtifactReviewLayout();
    assert.equal(appliedWidth(workspace), '1700px');
  });

  test('flag-off routes through the same dynamic window bound', (t) => {
    const store = {
      [STORAGE_KEY]: JSON.stringify({
        enabled: true, collapsed: false, width: 560, userDismissed: false,
        widthBySession: { 'session-a': 400 },
      }),
    };
    withWindowShim(t, store, { innerWidth: 900 });
    const state = makeState({ flagOn: false });
    const workspace = makeWorkspaceFake();
    makeManager(state, { id: 'session-a' }, workspace).syncArtifactReviewLayout();
    assert.equal(appliedWidth(workspace), '540px', 'flag-off still ignores widthBySession; the 360 reserve bounds 900 to 540');

    const narrowStore = { [STORAGE_KEY]: JSON.stringify({ enabled: true, collapsed: false, width: 1400, userDismissed: false }) };
    withWindowShim(t, narrowStore, { innerWidth: 1000 });
    const narrowWorkspace = makeWorkspaceFake();
    makeManager(makeState({ flagOn: false }), { id: 'session-a' }, narrowWorkspace).syncArtifactReviewLayout();
    assert.equal(appliedWidth(narrowWorkspace), '640px', 'flag-off applies min(floor(1000*0.9), 1000-360)');
  });

  test('flag-off save round-trip through the manager writes exactly the legacy shape', (t) => {
    const legacyBlob = JSON.stringify({ enabled: true, collapsed: false, width: 505, userDismissed: false });
    const store = { [STORAGE_KEY]: legacyBlob };
    withWindowShim(t, store);
    const state = makeState({ flagOn: false });
    const manager = makeManager(state, { id: 'session-a' }, makeWorkspaceFake());
    // toggle twice: disable (save) then re-enable (save) -> ends enabled again.
    manager.toggleArtifactReview();
    manager.toggleArtifactReview();
    const written = JSON.parse(store[STORAGE_KEY]);
    assert.equal('widthBySession' in written, false, 'no widthBySession key materialized flag-off');
    assert.deepEqual(Object.keys(written).sort(), ['collapsed', 'enabled', 'userDismissed', 'width']);
  });

  test('flag-on: a save round-trip preserves a stored widthBySession (normalizer does not strip it)', (t) => {
    const store = {
      [STORAGE_KEY]: JSON.stringify({
        enabled: true, collapsed: false, width: 420, userDismissed: false,
        widthBySession: { 'session-a': 500, 'session-b': 480 },
      }),
    };
    withWindowShim(t, store);
    const state = makeState({ flagOn: true });
    const manager = makeManager(state, { id: 'session-a' }, makeWorkspaceFake());
    manager.toggleArtifactReview(); // disable -> saves
    const written = JSON.parse(store[STORAGE_KEY]);
    assert.deepEqual(
      written.widthBySession,
      { 'session-a': 500, 'session-b': 480 },
      'per-session widths survive an unrelated pref save'
    );
  });
});

describe('bridge lockstep — renderer-shell-artifact-bridge.js normalizer preserves widthBySession', () => {
  function makeBridge(store, state) {
    return createShellArtifactBridge({
      state,
      windowRef: makeWindowShim(store),
      dom: {},
      constants: { ARTIFACT_REVIEW_STORAGE_KEY: STORAGE_KEY, ARTIFACT_REVIEW_MIN_STAGE_WIDTH: 1080 },
    });
  }

  test('widthBySession round-trips through bridge state without being dropped', () => {
    const store = {
      [STORAGE_KEY]: JSON.stringify({
        enabled: true, collapsed: false, width: 420, userDismissed: false,
        widthBySession: { 'session-a': 500 },
      }),
    };
    const state = makeState({ flagOn: true });
    const bridge = makeBridge(store, state);
    const prefs = bridge.getArtifactReviewPreferenceState();
    assert.deepEqual(prefs.widthBySession, { 'session-a': 500 });
    // A second read (re-normalization of state) must not strip the map either.
    const again = bridge.getArtifactReviewPreferenceState();
    assert.deepEqual(again.widthBySession, { 'session-a': 500 });
  });

  test('maximizedBySession round-trips through the bridge normalizer', () => {
    const store = {
      [STORAGE_KEY]: JSON.stringify({ enabled: true, width: 420, maximizedBySession: { 'session-a': true, 'session-b': false } }),
    };
    const bridge = makeBridge(store, makeState({ flagOn: true }));
    assert.deepEqual(bridge.getArtifactReviewPreferenceState().maximizedBySession, { 'session-a': true });
    assert.deepEqual(bridge.getArtifactReviewPreferenceState().maximizedBySession, { 'session-a': true });
  });

  test('malformed entries are dropped without crashing; empty map drops the key', () => {
    const store = {
      [STORAGE_KEY]: JSON.stringify({
        enabled: true, width: 420,
        widthBySession: {
          'session-a': 480,
          'session-neg': -10,
          'session-nan': 'not-a-number',
          'session-empty': '',
          'session-nested': { nested: true },
          '': 400,
        },
      }),
    };
    const state = makeState({ flagOn: true });
    const prefs = makeBridge(store, state).getArtifactReviewPreferenceState();
    assert.deepEqual(prefs.widthBySession, { 'session-a': 480 });

    const emptyStore = { [STORAGE_KEY]: JSON.stringify({ enabled: true, widthBySession: { '': 1 } }) };
    const emptyPrefs = makeBridge(emptyStore, makeState({ flagOn: true })).getArtifactReviewPreferenceState();
    assert.equal('widthBySession' in emptyPrefs, false);
  });

  test('legacy blob through the bridge stays legacy-shaped (no widthBySession materialized)', () => {
    const store = { [STORAGE_KEY]: JSON.stringify({ enabled: true, width: 505 }) };
    const prefs = makeBridge(store, makeState({ flagOn: false })).getArtifactReviewPreferenceState();
    assert.equal('widthBySession' in prefs, false);
    assert.equal(prefs.width, 505);
  });
});

describe('prefs module — extracted legacy helpers keep their behavior', () => {
  test('clampArtifactReviewWidth keeps the legacy defaults/floor and the new sanity ceiling', () => {
    assert.equal(clampArtifactReviewWidth(undefined), 420);
    assert.equal(clampArtifactReviewWidth('abc'), 420);
    assert.equal(clampArtifactReviewWidth(100), 320);
    assert.equal(clampArtifactReviewWidth(9999), 4000);
    assert.equal(clampArtifactReviewWidth(444.6), 445);
    assert.equal(clampArtifactReviewWidth(560), 560, 'every legacy persisted width is untouched');
  });

  test('normalizeArtifactReviewPreferences keeps the WS3 lockstep fields', () => {
    const normalized = normalizeArtifactReviewPreferences({
      enabled: true, collapsed: true, width: 500, mode: 'code_review', userDismissed: true,
    });
    assert.deepEqual(normalized, {
      enabled: true, collapsed: true, width: 500, mode: 'code_review', userDismissed: true,
    });
    assert.deepEqual(normalizeArtifactReviewPreferences(null), {
      enabled: false, collapsed: false, width: 420, mode: 'artifact', userDismissed: false,
    });
  });
});
