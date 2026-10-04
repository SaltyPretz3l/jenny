'use strict';

// Unit suite for the artifact-review automatic presentation module, then the
// same rules through the real manager (renderer-artifacts-utils.js + its rail).
// D1 (shell-chrome area 3): the first artifact in a chat opens the panel
// expanded, unless the user closed the panel in that chat. Owner decision
// 2026-09-29 (D-2): only an artifact produced while the app runs presents; a
// chat reopened after a restart keeps its older artifacts closed.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createArtifactReviewAutoOpen } = require('../renderer/features/renderer-artifact-review-autoopen');
const { createArtifactManager } = require('../renderer/features/renderer-artifacts-utils');
const { createArtifactPanelV2 } = require('../renderer/features/renderer-artifact-panel-v2-render');

const RUN_STARTED_AT = Date.parse('2026-09-29T12:00:00.000Z');
const BEFORE_RUN = '2026-09-28T09:00:00.000Z';
const DURING_RUN = '2026-09-29T12:05:00.000Z';

function makeHarness(overrides = {}) {
  const prefs = {
    enabled: false,
    width: 420,
    ...(overrides.prefs || {}),
  };
  const stateStore = { autoOpened: [...(overrides.autoOpened || [])] };
  let saveCount = 0;
  const deps = {
    isAutoOpenEnabled: () => true,
    getActiveSessionId: () => (overrides.sessionId === undefined ? 'session-1' : overrides.sessionId),
    getArtifactReviewState: () => prefs,
    saveArtifactReviewPreferences: () => { saveCount += 1; },
    isArtifactReviewEligible: () => overrides.eligible !== false,
    runStartedAt: RUN_STARTED_AT,
    getArtifacts: () => overrides.artifacts || Array.from(
      { length: overrides.artifactCount === undefined ? 1 : overrides.artifactCount },
      (_unused, index) => ({ id: `a-${index}`, timestamp: DURING_RUN }),
    ),
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
  test('off never presents, spends the FIFO or logs; enabling later preserves the opportunity', () => {
    let enabled = false;
    let logs = 0;
    const h = makeHarness({ deps: { isAutoOpenEnabled: () => enabled, appendClientLog: () => { logs += 1; } } });
    assert.equal(h.controller.maybeAutoOpen(), false);
    assert.equal(h.prefs.enabled, false);
    assert.deepEqual(h.stateStore.autoOpened, []);
    assert.equal(h.getSaveCount(), 0);
    assert.equal(logs, 0);
    enabled = true;
    assert.equal(h.controller.maybeAutoOpen(), true);
    assert.deepEqual(h.stateStore.autoOpened, ['session-1']);
    assert.equal(logs, 1);
  });

  test('an omitted opt-in callback defaults off before reading any artifact state', () => {
    const controller = createArtifactReviewAutoOpen({ getActiveSessionId: () => { throw new Error('must not read'); } });
    assert.equal(controller.maybeAutoOpen(), false);
  });

  test('a closed rail last left on Tasks reopens on the artifact when the first one arrives', () => {
    const h = makeHarness({ prefs: { enabled: false, mode: 'tasks' } });
    assert.equal(h.controller.maybeAutoOpen(), true);
    assert.equal(h.prefs.enabled, true);
    assert.equal(h.prefs.mode, 'artifact');
  });

  test('an open Tasks rail is left alone and the presentation is kept for later', () => {
    const h = makeHarness({ prefs: { enabled: true, mode: 'tasks' } });
    assert.equal(h.controller.maybeAutoOpen(), false, 'no swap under the user');
    assert.equal(h.prefs.mode, 'tasks');
    assert.deepEqual(h.stateStore.autoOpened, [], 'the chat keeps its presentation');
    h.prefs.enabled = false; // closed without the user's Close (a pane collapse); a Close spends it (D-1 below)
    assert.equal(h.controller.maybeAutoOpen(), true, 'once Tasks is gone the artifact presents');
    assert.equal(h.prefs.mode, 'artifact');
    assert.deepEqual(h.stateStore.autoOpened, ['session-1']);
  });

  test('presents once per session: the first presentation is expanded', () => {
    const h = makeHarness();
    assert.equal(h.controller.maybeAutoOpen(), true, 'first eligible render presents');
    assert.equal(h.prefs.enabled, true);
    assert.equal(h.prefs.mode, 'artifact', 'the presentation shows the artifact, whatever the rail showed last');
    assert.deepEqual(h.stateStore.autoOpened, ['session-1']);
    assert.ok(h.getSaveCount() >= 1, 'the presentation persists preferences');
    assert.equal(h.controller.maybeAutoOpen(), false, 'second render for the same session no-ops');
  });

  test('keeps an already open panel open', () => {
    const h = makeHarness({ prefs: { enabled: true } });
    assert.equal(h.controller.maybeAutoOpen(), true);
    assert.equal(h.prefs.enabled, true);
  });

  test('a chat the user closed the panel in never auto-presents', () => {
    const h = makeHarness({ prefs: { dismissedForSession: { 'session-1': true } } });
    assert.equal(h.controller.maybeAutoOpen(), false);
    assert.equal(h.prefs.enabled, false);
    assert.deepEqual(h.stateStore.autoOpened, [], 'a dismissed render does not consume the session slot');
  });

  test('a dismissal in another chat does not block this one', () => {
    const h = makeHarness({ prefs: { dismissedForSession: { 'session-other': true } } });
    assert.equal(h.controller.maybeAutoOpen(), true);
    assert.equal(h.prefs.enabled, true);
  });

  test('the removed global userDismissed flag is ignored', () => {
    const h = makeHarness({ prefs: { userDismissed: true } });
    assert.equal(h.controller.maybeAutoOpen(), true);
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

describe('D-2: only an artifact produced during this run presents', () => {
  test('a chat opened with two historical artifacts does not present; a third arriving afterwards presents once', () => {
    const artifacts = [{ id: 'old-1', timestamp: BEFORE_RUN }, { id: 'old-2', timestamp: BEFORE_RUN }];
    const h = makeHarness({ artifacts });
    assert.equal(h.controller.maybeAutoOpen(), false, 'history from before the restart stays closed');
    assert.equal(h.prefs.enabled, false);
    assert.deepEqual(h.stateStore.autoOpened, [], 'the chat keeps its presentation for a new artifact');
    artifacts.unshift({ id: 'new-3', timestamp: DURING_RUN });
    assert.equal(h.controller.maybeAutoOpen(), true, 'the artifact that arrived while the app runs presents');
    assert.equal(h.prefs.enabled, true);
    assert.equal(h.controller.maybeAutoOpen(), false, 'once');
  });

  test('an artifact whose time is unknown counts as new, so a live artifact is never held back', () => {
    const h = makeHarness({ artifacts: [{ id: 'x', timestamp: '' }] });
    assert.equal(h.controller.maybeAutoOpen(), true);
  });
});

// ── the same rules through the real manager, its rail and the V3 chrome ──
function artifactMessage(id, timestamp) {
  return {
    id: `m-${id}`, role: 'tool', kind: 'tool_result', ...(timestamp ? { timestamp } : {}),
    tool_result: {
      call_id: `c-${id}`, tool_name: 'create_artifact',
      generated_artifacts: [{ artifact_id: id, artifact_kind: 'document', file_name: `${id}.py`, language: 'python', editable: true, status: 'available' }],
    },
  };
}

function makeApp(t, { messages = {}, current = 'A', prefs = { enabled: false, width: 420 }, runStartedAt } = {}) {
  const dom = new JSDOM('<body><div id="workspace"><div id="chatView"><aside id="artifactReviewPanel"></aside></div></div>', { url: 'https://jenny.test' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const doc = dom.window.document;
  dom.window.localStorage.setItem('jenny.artifactReview.v1', JSON.stringify(prefs));
  dom.window.jennyShell = { artifacts: { read: async () => ({ artifact: { editable: true, status: 'available' }, content: 'print(1)' }) } };
  dom.window.rendererMonacoEditorUtils = { createArtifactEditor: () => ({ setDocument: async () => {}, onDidChange: () => () => {}, dispose: () => {} }) };
  const state = {
    currentSessionId: current,
    ui: { activeView: 'chat', artifactReview: {}, appearance: { artifactAutoOpen: true } },
    artifacts: { autoOpenedSessionIds: [], deletedArtifactIds: [] },
    messagesBySession: new Map(Object.entries(messages)),
    features: { featureFlags: {} },
  };
  const panelEl = doc.getElementById('artifactReviewPanel');
  const chrome = createArtifactPanelV2({ panelEl, state, windowRef: dom.window });
  chrome.installed();
  const nodes = Object.fromEntries([...doc.querySelectorAll('[id]')].map((node) => [node.id, node]));
  nodes.workspace.getBoundingClientRect = () => ({ width: 1600 });
  const manager = createArtifactManager({ state, dom: nodes, callbacks: {
    getActiveSession: () => (state.currentSessionId ? { id: state.currentSessionId } : null),
    escapeHtml: (value) => String(value || '').replaceAll('<', '&lt;'),
    appendClientLog: () => {}, setActiveView: () => {}, renderAll: () => {}, updateComposerSafeOffset: () => {},
    ...(runStartedAt === undefined ? {} : { getRunStartedAt: () => runStartedAt }),
    panelV2: chrome,
  } });
  chrome.connect({ getArtifacts: () => manager.getArtifactsForSession(state.currentSessionId), getSelectedArtifactSource: () => manager.getSelectedArtifactSource() });
  manager.bind();
  chrome.bind();
  t.after(() => { manager.dispose(); chrome.dispose(); dom.window.close(); globalThis.window = previousWindow; globalThis.document = previousDocument; });
  const render = () => manager.renderArtifactReviewPanel();
  return {
    state, manager, render,
    visible: () => manager.isArtifactReviewVisible(),
    clickClose: () => doc.getElementById('artifactReviewCollapseButton').click(),
    switchTo: (sessionId) => { state.currentSessionId = sessionId; render(); },
    addMessage: (sessionId, message) => { state.messagesBySession.set(sessionId, [...(state.messagesBySession.get(sessionId) || []), message]); },
  };
}

describe('the rail through the real manager', () => {
  test('D-1: closing the rail from Tasks with an artifact present keeps it closed on the next render', (t) => {
    const app = makeApp(t, { messages: { A: [artifactMessage('a1')] } });
    app.manager.openArtifactRail('tasks');
    app.render();
    assert.equal(app.visible(), true, 'Tasks shows; the artifact waits');
    assert.equal(app.state.ui.artifactReview.mode, 'tasks');
    app.clickClose();
    assert.equal(app.visible(), false);
    app.render();
    assert.equal(app.visible(), false, 'the next render does not reopen the rail on Artifacts');
    app.render();
    assert.equal(app.visible(), false);
  });

  test('D-1: the same holds for a file preview and a code review close', (t) => {
    for (const mode of ['file_preview', 'code_review']) {
      const app = makeApp(t, { messages: { A: [artifactMessage('a1')] } });
      app.manager.openArtifactRail(mode);
      app.clickClose();
      app.render();
      assert.equal(app.visible(), false, mode);
    }
  });

  test('X-1: a Close in chat A survives opening Artifacts in chat B and coming back', (t) => {
    const app = makeApp(t, { messages: { A: [artifactMessage('a1')], B: [artifactMessage('b1')] } });
    app.render();
    assert.equal(app.visible(), true, 'the new artifact in A presents');
    app.clickClose();
    assert.equal(app.visible(), false);
    assert.deepEqual(app.state.ui.artifactReview.dismissedForSession, { A: true });
    app.switchTo('B');
    assert.equal(app.visible(), true, 'B presents its own artifact');
    app.switchTo('A');
    assert.equal(app.visible(), false, 'A was closed there and nobody reopened it');
    app.manager.toggleArtifactReview({ artifactsOnly: true });
    assert.equal(app.visible(), true, 'an explicit reopen in A wins');
    app.switchTo('B');
    app.switchTo('A');
    assert.equal(app.visible(), true, 'and sticks: the reopen cleared the Close');
  });

  test('X-1: a rail on Tasks is not hidden by the artifact Close of the chat it returns to', (t) => {
    const app = makeApp(t, { messages: { A: [artifactMessage('a1')], B: [] } });
    app.render();
    app.clickClose();
    app.switchTo('B');
    app.manager.openArtifactRail('tasks');
    app.switchTo('A');
    assert.equal(app.visible(), true, 'the Close was about artifacts, not Tasks');
    assert.equal(app.state.ui.artifactReview.mode, 'tasks');
  });

  test('D-2: history from before the restart stays closed; an artifact arriving now presents once', (t) => {
    const app = makeApp(t, {
      runStartedAt: RUN_STARTED_AT,
      messages: { A: [artifactMessage('old1', BEFORE_RUN), artifactMessage('old2', BEFORE_RUN)] },
    });
    app.render();
    assert.equal(app.visible(), false, 'two historical artifacts: no presentation');
    app.addMessage('A', artifactMessage('new3', DURING_RUN));
    app.render();
    assert.equal(app.visible(), true, 'the artifact produced during this run presents');
    assert.match(app.state.artifacts.selectedArtifactId, /new3/, 'showing the newest');
    app.clickClose();
    app.render();
    assert.equal(app.visible(), false, 'once');
    app.manager.toggleArtifactReview({ artifactsOnly: true });
    assert.equal(app.visible(), true, 'the strip toggle still opens older artifacts on demand');
  });
});
