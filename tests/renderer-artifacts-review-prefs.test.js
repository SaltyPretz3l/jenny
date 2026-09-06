'use strict';

// WS3 Step 10 — artifact-review preference lockstep on the manager
// (renderer-artifacts-utils.js) side: the persisted `userDismissed` field
// must survive the manager's normalizer, be set on explicit disable and on
// collapse, clear on explicit re-enable, persist through
// saveArtifactReviewPreferences, and the (non-persisted)
// `autoOpenedSessionIds` FIFO must clear on reset and drop pruned sessions.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const artifactsUtils = require('../renderer/features/renderer-artifacts-utils');

function makeState() {
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
    features: { featureFlags: {} },
  };
}

function withWindowShim(t, store) {
  const previous = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
    },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  };
  t.after(() => {
    if (previous === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previous;
    }
  });
}

function makeManager(state) {
  return artifactsUtils.createArtifactManager({
    state,
    dom: {},
    callbacks: {
      escapeHtml: (value) => String(value == null ? '' : value),
      getActiveSession: () => ({ id: state.artifacts.selectedSessionId || 'session-1' }),
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

describe('renderer-artifacts-utils userDismissed lockstep (WS3 Step 10)', () => {
  test('manager normalizer defaults userDismissed to false and preserves true', (t) => {
    withWindowShim(t, {});
    const state = makeState();
    const manager = makeManager(state);
    manager.isArtifactReviewVisible();
    assert.equal(state.ui.artifactReview.userDismissed, false, 'default is false');

    state.ui.artifactReview.userDismissed = true;
    manager.isArtifactReviewVisible();
    assert.equal(state.ui.artifactReview.userDismissed, true, 'true survives re-normalization');
  });

  test('explicit disable via toggle sets userDismissed; re-enable clears it', (t) => {
    const store = {};
    withWindowShim(t, store);
    const state = makeState();
    const manager = makeManager(state);
    assert.equal(typeof manager.toggleArtifactReview, 'function', 'manager exposes toggleArtifactReview');

    // enabled=false -> toggle turns it on (explicit re-enable): dismissed clears.
    state.ui.artifactReview = { enabled: false, collapsed: false, userDismissed: true };
    manager.toggleArtifactReview();
    assert.equal(state.ui.artifactReview.enabled, true);
    assert.equal(state.ui.artifactReview.userDismissed, false, 'explicit enable clears the dismissal');

    // enabled=true, collapsed=false -> toggle disables: dismissed sets.
    manager.toggleArtifactReview();
    assert.equal(state.ui.artifactReview.enabled, false);
    assert.equal(state.ui.artifactReview.userDismissed, true, 'explicit disable records the dismissal');
  });

  test('un-collapse via toggle clears userDismissed', (t) => {
    withWindowShim(t, {});
    const state = makeState();
    const manager = makeManager(state);
    state.ui.artifactReview = { enabled: true, collapsed: true, userDismissed: true };
    manager.toggleArtifactReview();
    assert.equal(state.ui.artifactReview.collapsed, false);
    assert.equal(state.ui.artifactReview.userDismissed, false, 'expanding the panel back is an explicit re-enable');
  });

  test('saveArtifactReviewPreferences persists userDismissed', (t) => {
    // Seed the STORE (authoritative on first load), not in-memory state.
    const store = { 'jenny.artifactReview.v1': JSON.stringify({ enabled: true, collapsed: false }) };
    withWindowShim(t, store);
    const state = makeState();
    const manager = makeManager(state);
    manager.toggleArtifactReview(); // enabled -> disable: dismiss + save
    const persisted = JSON.parse(store['jenny.artifactReview.v1']);
    assert.equal(persisted.userDismissed, true, 'the dismissal round-trips through localStorage');
  });
});

describe('renderer-artifacts-utils panel-verb re-entry (WS3 ⤢ = sole re-entry affordance)', () => {
  test('openArtifactTarget with source inline-open-panel re-enables a dismissed panel', async (t) => {
    withWindowShim(t, { 'jenny.artifactReview.v1': JSON.stringify({ enabled: false, userDismissed: true }) });
    const state = makeState();
    const manager = makeManager(state);
    await manager.openArtifactTarget('artifact-1', { source: 'inline-open-panel' });
    assert.equal(state.ui.artifactReview.enabled, true, 'explicit panel open re-enables');
    assert.equal(state.ui.artifactReview.userDismissed, false, 'explicit panel open clears the sticky dismissal');
  });

  test('legacy studio-alias opens route to the panel and re-enable it (W1-5, studio removed)', async (t) => {
    withWindowShim(t, { 'jenny.artifactReview.v1': JSON.stringify({ enabled: false, userDismissed: true }) });
    const state = makeState();
    const manager = makeManager(state);
    await manager.openArtifactTarget('artifact-1', { source: 'transcript-studio' });
    assert.equal(state.ui.artifactReview.enabled, true, 'the studio is gone — its alias opens the panel');
    assert.equal(state.ui.artifactReview.userDismissed, false);
  });

  test('panel verb re-enables without any feature flag (workspace_artifact_panel retired in W1-5)', async (t) => {
    withWindowShim(t, { 'jenny.artifactReview.v1': JSON.stringify({ enabled: false, userDismissed: true }) });
    const state = makeState();
    const manager = makeManager(state);
    await manager.openArtifactTarget('artifact-1', { source: 'inline-open-panel' });
    assert.equal(state.ui.artifactReview.enabled, true, 'the panel is core — no flag gates the re-enable');
    assert.equal(state.ui.artifactReview.userDismissed, false);
  });
});

// Owner restyle 2026-08-20: the rail resizes up to 90% of the window in BOTH
// flag states. The keyboard path is the agent-runnable proxy for the pointer
// drag (both funnel through applyArtifactReviewWidth).
describe('renderer-artifacts-utils rail width bound (90% of window)', () => {
  function makeResizerFake() {
    const attributes = {};
    const classes = new Set(['hidden']);
    const listeners = new Map();
    return {
      attributes,
      listeners,
      tabIndex: -1,
      classList: {
        toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      setAttribute: (name, value) => { attributes[name] = String(value); },
      addEventListener: (type, handler) => { listeners.set(type, handler); },
      removeEventListener: (type) => { listeners.delete(type); },
    };
  }

  function makeWidthHarness(t, { flagOn, innerWidth, stored }) {
    const store = { 'jenny.artifactReview.v1': JSON.stringify({ enabled: true, collapsed: false, ...stored }) };
    const previous = globalThis.window;
    const props = {};
    const workspace = {
      style: { setProperty: (name, value) => { props[name] = value; } },
      getBoundingClientRect: () => ({ width: innerWidth }),
    };
    const resizer = makeResizerFake();
    globalThis.window = {
      innerWidth,
      localStorage: {
        getItem: (key) => (key in store ? store[key] : null),
        setItem: (key, value) => { store[key] = String(value); },
      },
      setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (...args) => clearTimeout(...args),
    };
    t.after(() => {
      if (previous === undefined) delete globalThis.window;
      else globalThis.window = previous;
    });
    const state = makeState();
    state.features.featureFlags.artifact_panel_v2 = flagOn === true;
    const manager = artifactsUtils.createArtifactManager({
      state,
      dom: { workspace, artifactReviewResizer: resizer },
      callbacks: {
        escapeHtml: (value) => String(value == null ? '' : value),
        getActiveSession: () => ({ id: 'session-1' }),
        setActiveView: () => {},
        scrollMessageIntoView: () => {},
        appendClientLog: () => {},
        showToastMessage: () => {},
        toErrorMessage: (error) => String(error?.message || error || ''),
        updateComposerSafeOffset: () => {},
        renderAll: () => {},
      },
    });
    t.after(() => manager.dispose?.());
    const pressKey = (key) => {
      manager.bind();
      resizer.listeners.get('keydown')?.({ key, preventDefault: () => {} });
    };
    return { manager, props, store, resizer, state, pressKey };
  }

  for (const flagOn of [true, false]) {
    test(`flag-${flagOn ? 'on' : 'off'}: a stored ultrawide width applies up to the resolved max`, (t) => {
      const h = makeWidthHarness(t, {
        flagOn,
        innerWidth: 2000,
        stored: { width: 1900, widthBySession: flagOn ? { 'session-1': 1900 } : undefined },
      });
      h.manager.syncArtifactReviewLayout();
      // Owner report 2026-08-20: the chat-column reserve governs below 3600px —
      // min(floor(2000*0.9)=1800, 2000-360=1640).
      assert.equal(h.props['--artifact-review-width'], '1640px', 'the chat-column reserve bounds the rail');
    });
  }

  test('on a window wide enough for both, the 90% fraction governs', (t) => {
    const h = makeWidthHarness(t, {
      flagOn: true,
      innerWidth: 4000,
      stored: { width: 3900, widthBySession: { 'session-1': 3900 } },
    });
    h.manager.syncArtifactReviewLayout();
    assert.equal(h.props['--artifact-review-width'], '3600px', 'floor(4000 * 0.9) < 4000 - 360');
  });

  test('a legacy 420 width is untouched by the raised ceiling', (t) => {
    const h = makeWidthHarness(t, { flagOn: true, innerWidth: 1600, stored: { width: 420 } });
    h.manager.syncArtifactReviewLayout();
    assert.equal(h.props['--artifact-review-width'], '420px');
  });

  test('the resizer separator advertises the resolved max', (t) => {
    const h = makeWidthHarness(t, { flagOn: true, innerWidth: 1600, stored: { width: 500 } });
    h.manager.syncArtifactReviewLayout();
    assert.equal(h.resizer.attributes['aria-valuemin'], '320');
    assert.equal(h.resizer.attributes['aria-valuemax'], '1240', 'min(floor(1600*0.9), 1600-360)');
    assert.equal(h.resizer.attributes['aria-valuenow'], '500');
  });

  test('End targets the resolved max and persists it; Home returns to the default', (t) => {
    const h = makeWidthHarness(t, { flagOn: true, innerWidth: 1600, stored: { width: 420 } });
    h.pressKey('End');
    assert.equal(h.props['--artifact-review-width'], '1240px', 'End lands on min(90%, width - reserve)');
    assert.equal(JSON.parse(h.store['jenny.artifactReview.v1']).widthBySession['session-1'], 1240);
    h.pressKey('Home');
    assert.equal(h.props['--artifact-review-width'], '420px');
  });

  test('a keyboard step never persists past the resolved max', (t) => {
    const h = makeWidthHarness(t, { flagOn: true, innerWidth: 1000, stored: { width: 420 } });
    h.pressKey('End');
    h.pressKey('ArrowLeft'); // ArrowLeft grows the rail
    assert.equal(
      JSON.parse(h.store['jenny.artifactReview.v1']).widthBySession['session-1'],
      640,
      'the write is clamped at min(floor(1000*0.9), 1000-360), not the 4000 sanity ceiling'
    );
  });
});

describe('renderer-artifacts-utils autoOpenedSessionIds FIFO (WS3 Step 10)', () => {
  test('resetArtifactsState clears the FIFO', (t) => {
    withWindowShim(t, {});
    const state = makeState();
    const manager = makeManager(state);
    state.artifacts.autoOpenedSessionIds = ['a', 'b'];
    manager.resetArtifactsState();
    assert.deepEqual(state.artifacts.autoOpenedSessionIds, []);
  });

  test('pruneSessionArtifacts drops ids for removed sessions', (t) => {
    withWindowShim(t, {});
    const state = makeState();
    const manager = makeManager(state);
    state.artifacts.autoOpenedSessionIds = ['keep-1', 'drop-1', 'keep-2'];
    manager.pruneSessionArtifacts(['keep-1', 'keep-2']);
    assert.deepEqual(state.artifacts.autoOpenedSessionIds, ['keep-1', 'keep-2']);
  });
});
