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

describe('renderer-shell-artifact-bridge owner line (row 59 checkpoint 2)', () => {
  const { JSDOM } = require('jsdom');
  const sidePanelOwner = require('../renderer/chat/renderer-side-panel-owner');

  function ownerBridge(panes) {
    const state = {
      currentSessionId: 'sess_a',
      sessions: [{ id: 'sess_a', title: 'Alpha chat' }, { id: 'sess_b', title: 'Beta chat' }],
      panes: { panes: panes.map((sessionId, index) => ({ paneId: String(index), sessionId })) },
      ui: { activeView: 'chat' }, artifacts: {},
    };
    const bridge = createShellArtifactBridge({
      state,
      sidePanelOwner,
      callbacks: { getActiveSession: () => state.sessions[0] },
      windowRef: { localStorage: { getItem: () => null } },
      constants: { ARTIFACT_REVIEW_STORAGE_KEY: STORAGE_KEY },
    });
    const panel = new JSDOM('<aside id="panel"></aside>').window.document.getElementById('panel');
    return { state, bridge, panel };
  }
  const line = (panel) => panel.querySelector(':scope > .side-panel-owner-line');

  test('Changes and Activity name their owner with one pane; the artifact and context modes stay split-only', () => {
    const { bridge, panel } = ownerBridge(['sess_a']);
    bridge.sidePanel.syncOwnerLine(panel, 'artifact');
    assert.equal(line(panel), null, 'artifact: no line with one pane');
    bridge.sidePanel.syncOwnerLine(panel, 'context');
    assert.equal(line(panel), null, 'context: no line with one pane');
    bridge.sidePanel.syncOwnerLine(panel, 'code_review');
    assert.equal(line(panel).querySelector('.side-panel-owner-title').textContent, 'Alpha chat');
    bridge.sidePanel.syncOwnerLine(panel, 'artifact');
    assert.equal(line(panel), null, 'leaving Changes removes the line');
    bridge.sidePanel.syncOwnerLine(panel, 'activity');
    assert.equal(line(panel).querySelector('.side-panel-owner-title').textContent, 'Alpha chat');
  });

  test('with two panes every panel names the explicit owner, not the focused chat', () => {
    const { state, bridge, panel } = ownerBridge(['sess_a', 'sess_b']);
    state.ui.sidePanelOwnerSessionId = 'sess_b';
    for (const mode of ['artifact', 'context', 'code_review', 'activity']) {
      bridge.sidePanel.syncOwnerLine(panel, mode);
      assert.equal(line(panel).querySelector('.side-panel-owner-title').textContent, 'Beta chat', mode);
    }
    assert.equal(state.currentSessionId, 'sess_a', 'focus is on the other pane');
  });

  test('the session rail detail entry points are wired at construction, before any panel is built', (t) => {
    const original = globalThis.rendererChatWorkspaceDetail;
    let deps = null;
    globalThis.rendererChatWorkspaceDetail = { configure: (next) => { deps = { ...(deps || {}), ...next }; } };
    t.after(() => { globalThis.rendererChatWorkspaceDetail = original; });
    let builds = 0;
    const state = { currentSessionId: 's1', sessions: [{ id: 's1' }], ui: { activeView: 'chat' }, artifacts: {} };
    createShellArtifactBridge({
      state, constants: { ARTIFACT_REVIEW_STORAGE_KEY: STORAGE_KEY },
      callbacks: { getActiveSession: () => state.sessions[0] },
      windowRef: { localStorage: { getItem: () => null } },
      artifactsUtils: { createArtifactManager: () => { builds += 1; return { openArtifactTarget: (ref, options) => `opened ${ref} from ${options.source}` }; } },
    });
    assert.equal(builds, 0, 'the artifact surface is still dormant');
    for (const name of ['claimOwner', 'openArtifact', 'openChanges', 'closePanel']) assert.equal(typeof deps?.[name], 'function', name);
    assert.equal(deps.openArtifact('art_1'), 'opened art_1 from session-rail', 'a rail row builds the surface on first use');
    assert.equal(builds, 1);
  });

  test('explicit claims move the owner with two panes and are a no-op with one', () => {
    const split = ownerBridge(['sess_a', 'sess_b']);
    assert.equal(split.bridge.sidePanel.claim('sess_b'), true);
    assert.equal(split.state.ui.sidePanelOwnerSessionId, 'sess_b');
    assert.equal(ownerBridge(['sess_a']).bridge.sidePanel.claim('sess_a'), false);
  });
});
