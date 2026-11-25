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
    assert.deepEqual(loaded, { enabled: true, mode: 'artifact', textWrap: { output: true, code: true, diff: true } }, 'a stored width is ignored');
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
      textWrap: { output: false, code: true, diff: true },
      maximizedBySession: { 'session-a': true },
      dismissedForSession: { 'session-b': true },
    });
    const written = JSON.parse(store[KEY]);
    assert.deepEqual(written, {
      enabled: true, textWrap: { output: false, code: true, diff: true }, dismissedForSession: { 'session-b': true },
    });
  });

  test('the storage migration rewrites a v1 blob once, so no reader sees the old flag', () => {
    const store = { [KEY]: JSON.stringify({ enabled: false, collapsed: false, width: 420, userDismissed: true, maximizedBySession: { a: true }, widthBySession: { a: 500 } }) };
    assert.equal(prefsUtils.migrateArtifactReviewPreferencesStorage(shim(store), KEY), true);
    assert.deepEqual(JSON.parse(store[KEY]), { enabled: false, textWrap: { output: true, code: true, diff: true } });
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
    assert.deepEqual(prefs.textWrap, { output: true, code: true, diff: true });
    assert.equal(prefsUtils.setArtifactReviewTextWrap(prefs, 'output', false), false);
    assert.equal(prefsUtils.resolveArtifactReviewTextWrap(prefs, 'output'), false);
    assert.equal(prefsUtils.resolveArtifactReviewTextWrap(prefs, 'code'), true, 'kinds are independent');
    assert.equal(prefsUtils.setArtifactReviewTextWrap(prefs, 'diff', false), false);
    assert.equal(prefsUtils.resolveArtifactReviewTextWrap(prefs, 'code'), true, 'Changes diffs keep their own state');
    prefsUtils.setArtifactReviewTextWrap(prefs, 'diff', true);
    const store = {};
    prefsUtils.saveArtifactReviewPreferences(shim(store), KEY, prefs);
    const reloaded = prefsUtils.loadArtifactReviewPreferences(shim(store), KEY);
    assert.deepEqual(reloaded.textWrap, { output: false, code: true, diff: true });
    assert.deepEqual(prefsUtils.normalizeArtifactReviewPreferences({ textWrap: false }).textWrap, { output: false, code: false, diff: true }, 'the old renderer-local boolean maps to the kinds it covered');
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

describe('the background tasks panel mode is renderer-local', () => {
  const prefsUtils = require('../renderer/features/renderer-artifact-review-prefs');

  test('the normalizer accepts the mode; the loader and the saver never carry it', () => {
    assert.equal(prefsUtils.normalizeArtifactReviewMode('background_tasks'), 'background_tasks');
    assert.equal(prefsUtils.normalizeArtifactReviewMode(' Background_Tasks '), 'background_tasks');
    const windowRef = { localStorage: { getItem: () => JSON.stringify({ enabled: true, mode: 'background_tasks' }) } };
    assert.equal(prefsUtils.loadArtifactReviewPreferences(windowRef, 'k').mode, 'artifact');
    const written = [];
    prefsUtils.saveArtifactReviewPreferences({ localStorage: { setItem: (key, value) => written.push(value) } }, 'k', { enabled: true, mode: 'background_tasks' });
    assert.equal(written.length, 1);
    assert.doesNotMatch(written[0], /background_tasks|"mode"/);
  });
});

describe('the chat terminal panel mode is renderer-local', () => {
  const prefsUtils = require('../renderer/features/renderer-artifact-review-prefs');

  test('the normalizer accepts the mode; the loader and the saver never carry it', () => {
    assert.equal(prefsUtils.normalizeArtifactReviewMode('terminal'), 'terminal');
    assert.equal(prefsUtils.normalizeArtifactReviewMode(' Terminal '), 'terminal');
    const windowRef = { localStorage: { getItem: () => JSON.stringify({ enabled: true, mode: 'terminal' }) } };
    assert.equal(prefsUtils.loadArtifactReviewPreferences(windowRef, 'k').mode, 'artifact');
    const written = [];
    prefsUtils.saveArtifactReviewPreferences({ localStorage: { setItem: (key, value) => written.push(value) } }, 'k', { enabled: true, mode: 'terminal' });
    assert.equal(written.length, 1);
    assert.doesNotMatch(written[0], /terminal|"mode"/);
  });
});

describe('the notes rail mode is renderer-local', () => {
  const prefsUtils = require('../renderer/features/renderer-artifact-review-prefs');

  test('the normalizer accepts the mode; the loader never restores it', () => {
    assert.equal(prefsUtils.normalizeArtifactReviewMode('notes'), 'notes');
    assert.equal(prefsUtils.normalizeArtifactReviewMode(' Notes '), 'notes');
    const windowRef = { localStorage: { getItem: () => JSON.stringify({ enabled: true, mode: 'notes' }) } };
    assert.equal(prefsUtils.loadArtifactReviewPreferences(windowRef, 'k').mode, 'artifact');
  });

  test('a save never writes the mode', () => {
    const written = [];
    const windowRef = { localStorage: { setItem: (key, value) => written.push(value) } };
    prefsUtils.saveArtifactReviewPreferences(windowRef, 'k', { enabled: true, mode: 'notes' });
    assert.equal(written.length, 1);
    assert.doesNotMatch(written[0], /notes|"mode"/);
  });
});
