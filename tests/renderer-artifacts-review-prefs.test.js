'use strict';

// Artifact-review preferences on the manager (renderer-artifacts-utils.js)
// side: Close records a per-chat dismissal (the old global `userDismissed`
// is gone), an explicit open clears it, textWrap is one persisted state per
// kind, and the (non-persisted) `autoOpenedSessionIds` FIFO clears on reset
// and drops pruned sessions.

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

describe('prefs schema: per-session close, one wrap state per kind (shell-chrome area 3)', () => {
  const prefsUtils = require('../renderer/features/renderer-artifact-review-prefs');
  const KEY = 'jenny.artifactReview.v1';
  function shim(store) {
    return {
      localStorage: {
        getItem: (key) => (key in store ? store[key] : null),
        setItem: (key, value) => { store[key] = String(value); },
      },
    };
  }

  test('migration ignores the old global userDismissed and loads everything else losslessly', () => {
    const store = { [KEY]: JSON.stringify({ enabled: true, collapsed: false, width: 505, userDismissed: true, widthBySession: { 'session-a': 500 } }) };
    const loaded = prefsUtils.loadArtifactReviewPreferences(shim(store), KEY);
    assert.deepEqual(loaded, {
      enabled: true, width: 505, mode: 'artifact', textWrap: { output: true, code: true }, widthBySession: { 'session-a': 500 },
    });
    assert.equal('userDismissed' in loaded, false);
  });

  test('collapsed and enabled=false merge into one closed state', () => {
    const store = { [KEY]: JSON.stringify({ enabled: true, collapsed: true, width: 420 }) };
    const loaded = prefsUtils.loadArtifactReviewPreferences(shim(store), KEY);
    assert.equal(loaded.enabled, false, 'a collapsed panel loads closed');
    assert.equal('collapsed' in loaded, false);
    assert.equal(prefsUtils.normalizeArtifactReviewPreferences({ enabled: true, collapsed: true }).enabled, false);
  });

  test('a save writes the new shape and never the removed fields', () => {
    const store = {};
    prefsUtils.saveArtifactReviewPreferences(shim(store), KEY, {
      enabled: true, collapsed: false, width: 480, userDismissed: true, mode: 'tasks',
      textWrap: { output: false, code: true },
      maximizedBySession: { 'session-a': true },
      dismissedForSession: { 'session-b': true },
    });
    const written = JSON.parse(store[KEY]);
    assert.deepEqual(written, {
      enabled: true, width: 480, textWrap: { output: false, code: true }, dismissedForSession: { 'session-b': true },
    });
  });

  test('the storage migration rewrites a v1 blob once, so no reader sees the old flag', () => {
    const store = { [KEY]: JSON.stringify({ enabled: false, collapsed: false, width: 420, userDismissed: true, maximizedBySession: { a: true } }) };
    assert.equal(prefsUtils.migrateArtifactReviewPreferencesStorage(shim(store), KEY), true);
    assert.deepEqual(JSON.parse(store[KEY]), { enabled: false, width: 420, textWrap: { output: true, code: true } });
    assert.equal(prefsUtils.migrateArtifactReviewPreferencesStorage(shim(store), KEY), false, 'a migrated blob is left alone');
    assert.equal(prefsUtils.migrateArtifactReviewPreferencesStorage(shim({}), KEY), false, 'no blob, no write');
  });

  test('per-session dismissal records, resolves, clears, persists and stays bounded at 40', () => {
    const prefs = prefsUtils.normalizeArtifactReviewPreferences({});
    prefsUtils.recordArtifactReviewDismissed(prefs, 'session-a', true);
    assert.equal(prefsUtils.resolveArtifactReviewDismissed(prefs, 'session-a'), true);
    assert.equal(prefsUtils.resolveArtifactReviewDismissed(prefs, 'session-b'), false);
    prefsUtils.recordArtifactReviewDismissed(prefs, 'session-a', false);
    assert.equal(prefsUtils.resolveArtifactReviewDismissed(prefs, 'session-a'), false);
    assert.equal('dismissedForSession' in prefs, false, 'an empty map drops the key');
    for (let i = 1; i <= 41; i += 1) prefsUtils.recordArtifactReviewDismissed(prefs, `s-${i}`, true);
    assert.equal(Object.keys(prefs.dismissedForSession).length, 40);
    assert.equal(prefsUtils.resolveArtifactReviewDismissed(prefs, 's-1'), false, 'oldest evicted');
    const store = {};
    prefsUtils.saveArtifactReviewPreferences(shim(store), KEY, prefs);
    const reloaded = prefsUtils.loadArtifactReviewPreferences(shim(store), KEY);
    assert.equal(prefsUtils.resolveArtifactReviewDismissed(reloaded, 's-41'), true, 'the dismissal survives a restart');
    prefsUtils.pruneArtifactReviewSessionPreferences(reloaded, ['s-41']);
    assert.deepEqual(reloaded.dismissedForSession, { 's-41': true }, 'prune drops removed sessions');
  });

  test('textWrap is one persisted state per kind, wrapped by default', () => {
    const prefs = prefsUtils.normalizeArtifactReviewPreferences({});
    assert.deepEqual(prefs.textWrap, { output: true, code: true });
    assert.equal(prefsUtils.setArtifactReviewTextWrap(prefs, 'output', false), false);
    assert.equal(prefsUtils.resolveArtifactReviewTextWrap(prefs, 'output'), false);
    assert.equal(prefsUtils.resolveArtifactReviewTextWrap(prefs, 'code'), true, 'kinds are independent');
    const store = {};
    prefsUtils.saveArtifactReviewPreferences(shim(store), KEY, prefs);
    const reloaded = prefsUtils.loadArtifactReviewPreferences(shim(store), KEY);
    assert.deepEqual(reloaded.textWrap, { output: false, code: true });
    assert.deepEqual(prefsUtils.normalizeArtifactReviewPreferences({ textWrap: false }).textWrap, { output: false, code: false }, 'the old renderer-local boolean maps to both kinds');
  });

  test('a width drag also updates the global seed so new chats open at the last width', () => {
    const prefs = prefsUtils.normalizeArtifactReviewPreferences({ width: 420 });
    prefsUtils.recordArtifactReviewWidth(prefs, 'session-a', 610);
    assert.equal(prefs.widthBySession['session-a'], 610);
    assert.equal(prefs.width, 610, 'the seed follows the drag');
    assert.equal(prefsUtils.resolveEffectiveArtifactReviewWidth(prefs, 'session-new', { windowWidth: 2000 }), 610);
  });

  test('maximize is session-local: kept in memory, never persisted or restored', () => {
    const prefs = prefsUtils.normalizeArtifactReviewPreferences({});
    prefsUtils.recordArtifactReviewMaximized(prefs, 'session-a', true);
    assert.equal(prefsUtils.resolveArtifactReviewMaximized(prefsUtils.normalizeArtifactReviewPreferences(prefs), 'session-a'), true, 'in-memory state survives re-normalization');
    const store = {};
    prefsUtils.saveArtifactReviewPreferences(shim(store), KEY, prefs);
    assert.equal('maximizedBySession' in JSON.parse(store[KEY]), false);
    const legacy = { [KEY]: JSON.stringify({ enabled: true, maximizedBySession: { 'session-a': true } }) };
    assert.equal(prefsUtils.resolveArtifactReviewMaximized(prefsUtils.loadArtifactReviewPreferences(shim(legacy), KEY), 'session-a'), false, 'a persisted maximize from an old build is not restored');
  });
});

describe('renderer-artifacts-utils close semantics (D1: per-session dismissal)', () => {
  function makeHooks() {
    return {
      escapeHtml: (value) => String(value == null ? '' : value),
      getActiveSession: () => ({ id: 'session-1' }),
      setActiveView: () => {}, scrollMessageIntoView: () => {}, appendClientLog: () => {}, showToastMessage: () => {},
      toErrorMessage: (error) => String(error?.message || error || ''), updateComposerSafeOffset: () => {}, renderAll: () => {},
    };
  }
  function makeListenerNode(extra) {
    const node = {
      listeners: {}, attributes: {},
      classList: { toggle: () => {}, contains: () => false },
      setAttribute(name, value) { node.attributes[name] = String(value); },
      addEventListener(type, fn) { node.listeners[type] = fn; },
      removeEventListener() {},
      focus() {},
      ...extra,
    };
    return node;
  }
  const clickOn = (selector) => ({ target: { closest: (query) => (query === selector ? {} : null) } });

  test('Close hides the panel and remembers the dismissal for this chat only', (t) => {
    const store = { 'jenny.artifactReview.v1': JSON.stringify({ enabled: true, width: 420 }) };
    withWindowShim(t, store);
    const state = makeState();
    const closeButton = makeListenerNode({ id: 'artifactReviewCollapseButton' });
    const manager = artifactsUtils.createArtifactManager({ state, dom: { artifactReviewCollapseButton: closeButton }, callbacks: makeHooks() });
    t.after(() => manager.dispose());
    manager.bind();
    closeButton.listeners.click(clickOn('#artifactReviewCollapseButton'));
    assert.equal(state.ui.artifactReview.enabled, false);
    assert.deepEqual(state.ui.artifactReview.dismissedForSession, { 'session-1': true });
    const persisted = JSON.parse(store['jenny.artifactReview.v1']);
    assert.deepEqual(persisted.dismissedForSession, { 'session-1': true });
    assert.equal('userDismissed' in persisted, false, 'no global sticky flag');
  });

  test('toggle: a visible artifact panel closes with dismissal; reopening clears it for that chat', (t) => {
    withWindowShim(t, { 'jenny.artifactReview.v1': JSON.stringify({ enabled: true, width: 420 }) });
    const state = makeState();
    const manager = makeManager(state);
    manager.toggleArtifactReview();
    assert.equal(state.ui.artifactReview.enabled, false);
    assert.deepEqual(state.ui.artifactReview.dismissedForSession, { 'session-1': true });
    manager.toggleArtifactReview();
    assert.equal(state.ui.artifactReview.enabled, true);
    assert.equal(state.ui.artifactReview.mode, 'artifact');
    assert.equal('dismissedForSession' in state.ui.artifactReview, false, 'an explicit open clears the dismissal');
  });

  test('closing another rail mode (Tasks) never records an artifact dismissal', (t) => {
    const store = { 'jenny.artifactReview.v1': JSON.stringify({ enabled: true, width: 420 }) };
    withWindowShim(t, store);
    const state = makeState();
    const manager = makeManager(state);
    manager.openArtifactRail('tasks');
    manager.toggleArtifactReview();
    assert.equal(state.ui.artifactReview.enabled, false);
    assert.equal('dismissedForSession' in state.ui.artifactReview, false);
    assert.equal('dismissedForSession' in JSON.parse(store['jenny.artifactReview.v1']), false);
  });

  test('the Artifacts strip toggle switches from another mode to artifacts instead of closing', (t) => {
    withWindowShim(t, { 'jenny.artifactReview.v1': JSON.stringify({ enabled: true, width: 420 }) });
    const state = makeState();
    const toggle = makeListenerNode();
    const manager = artifactsUtils.createArtifactManager({ state, dom: { artifactSplitViewToggle: toggle }, callbacks: makeHooks() });
    t.after(() => manager.dispose());
    manager.bind();
    manager.openArtifactRail('tasks');
    assert.equal(toggle.attributes['aria-pressed'], 'false', 'pressed only in artifact mode');
    toggle.listeners.click({});
    assert.equal(state.ui.artifactReview.mode, 'artifact');
    assert.equal(state.ui.artifactReview.enabled, true);
    assert.equal(toggle.attributes['aria-pressed'], 'true');
    toggle.listeners.click({});
    assert.equal(state.ui.artifactReview.enabled, false, 'a second click in artifact mode closes');
    assert.deepEqual(state.ui.artifactReview.dismissedForSession, { 'session-1': true });
  });

  test('Escape in the overlay drawer is Close', (t) => {
    withWindowShim(t, { 'jenny.artifactReview.v1': JSON.stringify({ enabled: true, width: 420 }) });
    const state = makeState();
    const panel = makeListenerNode({ classList: { toggle: () => {}, contains: (name) => name === 'artifact-review-overlay' }, style: { setProperty() {} }, querySelector: () => null, dataset: {} });
    const closeButton = makeListenerNode({ click() { closeButton.listeners.click(clickOn('#artifactReviewCollapseButton')); } });
    const manager = artifactsUtils.createArtifactManager({ state, dom: { artifactReviewPanel: panel, artifactReviewCollapseButton: closeButton }, callbacks: makeHooks() });
    t.after(() => manager.dispose());
    manager.bind();
    panel.listeners.keydown({ key: 'Escape', defaultPrevented: false, preventDefault() {} });
    assert.equal(state.ui.artifactReview.enabled, false);
    assert.deepEqual(state.ui.artifactReview.dismissedForSession, { 'session-1': true });
  });
});

describe('renderer-artifacts-utils panel-verb re-entry (WS3 ⤢ = sole re-entry affordance)', () => {
  test('openArtifactTarget with source inline-open-panel re-enables a dismissed panel', async (t) => {
    withWindowShim(t, { 'jenny.artifactReview.v1': JSON.stringify({ enabled: false, userDismissed: true }) });
    const state = makeState();
    const manager = makeManager(state);
    await manager.openArtifactTarget('artifact-1', { source: 'inline-open-panel' });
    assert.equal(state.ui.artifactReview.enabled, true, 'explicit panel open re-enables');
    assert.equal('userDismissed' in state.ui.artifactReview, false, 'the old sticky flag is gone');
  });

  test('legacy studio-alias opens route to the panel and re-enable it (W1-5, studio removed)', async (t) => {
    withWindowShim(t, { 'jenny.artifactReview.v1': JSON.stringify({ enabled: false, userDismissed: true }) });
    const state = makeState();
    const manager = makeManager(state);
    await manager.openArtifactTarget('artifact-1', { source: 'transcript-studio' });
    assert.equal(state.ui.artifactReview.enabled, true, 'the studio is gone — its alias opens the panel');
  });

  test('panel verb re-enables without any feature flag (workspace_artifact_panel retired in W1-5)', async (t) => {
    withWindowShim(t, { 'jenny.artifactReview.v1': JSON.stringify({ enabled: false, userDismissed: true }) });
    const state = makeState();
    const manager = makeManager(state);
    await manager.openArtifactTarget('artifact-1', { source: 'inline-open-panel' });
    assert.equal(state.ui.artifactReview.enabled, true, 'the panel is core — no flag gates the re-enable');
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

  function makeWidthHarness(t, { innerWidth, sidebarWidth = 0, stored }) {
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
    const manager = artifactsUtils.createArtifactManager({
      state,
      dom: { workspace, sidebar: { getBoundingClientRect: () => ({ width: sidebarWidth }) }, artifactReviewResizer: resizer },
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

  test('a stored ultrawide width applies up to the resolved max', (t) => {
    const h = makeWidthHarness(t, {
      innerWidth: 2000,
      stored: { width: 1900, widthBySession: { 'session-1': 1900 } },
    });
    h.manager.syncArtifactReviewLayout();
    // Owner report 2026-08-20: the chat-column reserve governs below 3600px —
    // min(floor(2000*0.9)=1800, 2000-360=1640).
    assert.equal(h.props['--artifact-review-width'], '1640px', 'the chat-column reserve bounds the rail');
  });

  test('on a window wide enough for both, the 90% fraction governs', (t) => {
    const h = makeWidthHarness(t, {
      innerWidth: 4000,
      stored: { width: 3900, widthBySession: { 'session-1': 3900 } },
    });
    h.manager.syncArtifactReviewLayout();
    assert.equal(h.props['--artifact-review-width'], '3600px', 'floor(4000 * 0.9) < 4000 - 360');
  });

  test('a legacy 420 width is untouched by the raised ceiling', (t) => {
    const h = makeWidthHarness(t, { innerWidth: 1600, stored: { width: 420 } });
    h.manager.syncArtifactReviewLayout();
    assert.equal(h.props['--artifact-review-width'], '420px');
  });

  test('the resizer separator advertises the resolved max', (t) => {
    const h = makeWidthHarness(t, { innerWidth: 1600, sidebarWidth: 320, stored: { width: 500 } });
    h.manager.syncArtifactReviewLayout();
    assert.equal(h.resizer.attributes['aria-valuemin'], '320');
    assert.equal(h.resizer.attributes['aria-valuemax'], '920', 'stage 1280 minus the 360 reserve');
    assert.equal(h.resizer.attributes['aria-valuenow'], '500');
  });

  test('End targets the resolved max and persists it; Home returns to the default', (t) => {
    const h = makeWidthHarness(t, { innerWidth: 1600, sidebarWidth: 320, stored: { width: 420 } });
    h.pressKey('End');
    assert.equal(h.props['--artifact-review-width'], '920px', 'End lands on the stage ceiling');
    assert.equal(JSON.parse(h.store['jenny.artifactReview.v1']).widthBySession['session-1'], 920);
    h.pressKey('Home');
    assert.equal(h.props['--artifact-review-width'], '420px');
  });

  test('a keyboard step never persists past the resolved max', (t) => {
    const h = makeWidthHarness(t, { innerWidth: 1000, stored: { width: 420 } });
    h.pressKey('End');
    h.pressKey('ArrowLeft'); // ArrowLeft grows the rail
    assert.equal(
      JSON.parse(h.store['jenny.artifactReview.v1']).widthBySession['session-1'],
      900,
      'the overlay write is clamped at floor(1000*0.9), not the 4000 sanity ceiling'
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

describe('the subagents rail mode is renderer-local', () => {
  const prefsUtils = require('../renderer/features/renderer-artifact-review-prefs');

  test('the normalizer accepts the mode; the loader never restores it', () => {
    assert.equal(prefsUtils.normalizeArtifactReviewMode('subagents'), 'subagents');
    assert.equal(prefsUtils.normalizeArtifactReviewMode('bogus'), 'artifact');
    const windowRef = { localStorage: { getItem: () => JSON.stringify({ enabled: true, mode: 'subagents' }) } };
    assert.equal(prefsUtils.loadArtifactReviewPreferences(windowRef, 'k').mode, 'artifact');
  });

  test('a save never writes the mode', () => {
    const written = [];
    const windowRef = { localStorage: { setItem: (key, value) => written.push(value) } };
    prefsUtils.saveArtifactReviewPreferences(windowRef, 'k', { enabled: true, mode: 'subagents' });
    assert.equal(written.length, 1);
    assert.doesNotMatch(written[0], /subagents|"mode"/);
  });
});
