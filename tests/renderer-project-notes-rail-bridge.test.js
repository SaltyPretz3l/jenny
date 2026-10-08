'use strict';

// The Notes rail through the REAL shell bridge: the surface controller's
// renderSplitDetail pull, the published host and the entry seam.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { flush, makeNote, makeStore } = require('./helpers/project-notes-store-stub');
const notesRail = require('../renderer/features/renderer-project-notes-rail');

const artifactsUtils = require('../renderer/features/renderer-artifacts-utils');
const sidePanelOwner = require('../renderer/chat/renderer-side-panel-owner');
const { createShellArtifactBridge } = require('../renderer/shell/renderer-shell-artifact-bridge');

const BRIDGE_PAGE = '<div id="workspace"><div id="chatView"></div>'
  + '<div id="chatTimelineUtilityCluster"></div>'
  + '<aside class="artifact-review-panel" id="artifactReviewPanel" aria-label="Artifact review">'
  + '<button id="artifactReviewCollapseButton" type="button">Collapse</button>'
  + '<div class="artifact-review-scroll"><div id="artifactReviewDetailEmpty"></div>'
  + '<div class="artifact-review-detail-panel hidden" id="artifactReviewDetailPanel">'
  + '<span id="artifactReviewDetailKicker"></span><span id="artifactReviewDetailTitle"></span>'
  + '<span id="artifactReviewDetailPath"></span><span id="artifactReviewDetailStatus"></span>'
  + '<div id="artifactReviewDetailMeta"></div><div id="artifactReviewProvenanceTimeline"></div>'
  + '<div class="artifact-preview-content hidden" id="artifactReviewPreviewContent"></div>'
  + '<div id="artifactReviewEditorShell"></div><span id="artifactReviewDirtyBadge"></span>'
  + '</div></div></aside></div>';

function bridgeRig(t, { withModule = true, entryStub = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${BRIDGE_PAGE}</body></html>`, { url: 'https://jenny.local/chat', pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const cleanups = [];
  t.after(() => {
    for (const fn of cleanups.splice(0)) fn();
    for (const key of ['window', 'document']) {
      if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key];
    }
  });
  const store = makeStore({ project_alpha: makeNote() });
  dom.window.jennyShell = { projectNotes: store.api };
  if (withModule) dom.window.rendererProjectNotesRail = notesRail;
  if (entryStub) dom.window.rendererProjectNotesEntry = entryStub;
  const state = {
    ui: { activeView: 'chat', artifactReview: {} },
    artifacts: {
      filter: 'all', selectedArtifactId: '', selectedSessionId: '', loadedArtifactId: '', loadedArtifactContent: '', dirtyContent: '',
      lastError: '', loading: false, savePending: false, mermaidViewMode: 'preview', viewModeByKind: {}, autoOpenedSessionIds: [], deletedArtifactIds: [],
    },
    messagesBySession: new Map(),
    sessions: [{ id: 'session-a', title: 'A', project_id: 'project_alpha' }],
    currentSessionId: 'session-a',
    panes: { panes: [{ paneId: 0, sessionId: 'session-a' }] },
    features: { featureFlags: {} },
  };
  const byId = (id) => dom.window.document.getElementById(id);
  const bridge = createShellArtifactBridge({
    state,
    windowRef: dom.window,
    dom: { artifactReviewPanel: byId('artifactReviewPanel'), chatView: byId('chatView'), workspace: byId('workspace') },
    lazyDom: {
      getArtifactsDom: () => ({
        artifactReviewPanel: byId('artifactReviewPanel'),
        artifactReviewCollapseButton: byId('artifactReviewCollapseButton'),
        artifactReviewDetailEmpty: byId('artifactReviewDetailEmpty'),
        artifactReviewDetailPanel: byId('artifactReviewDetailPanel'),
        artifactReviewPreviewContent: byId('artifactReviewPreviewContent'),
        artifactReviewEditorShell: byId('artifactReviewEditorShell'),
      }),
    },
    artifactsUtils,
    sidePanelOwner,
    registerCleanup: (fn) => cleanups.push(fn),
    constants: { ARTIFACT_REVIEW_STORAGE_KEY: 'jenny.artifactReview.v1' },
    callbacks: {
      getActiveSession: () => ({ id: state.currentSessionId }),
      setActiveView: (view) => { state.ui.activeView = view; },
      getProjectSwitcher: async () => ({ refresh: async () => {}, projectById: () => ({ name: 'Alpha App' }) }),
    },
  });
  return { dom, state, store, bridge, panel: byId('artifactReviewPanel'), cleanups };
}

test('the shell paints the Notes rail through renderSplitDetail and publishes the host', async (t) => {
  const r = bridgeRig(t);
  const surface = r.bridge.ensureArtifactSurface();
  assert.ok(surface, 'precondition: the artifact surface builds');
  surface.openArtifactRail('notes');
  r.bridge.renderArtifactReviewPanelSafe();
  await flush();
  assert.equal(r.panel.dataset.artifactReviewMode, 'notes');
  assert.match(r.panel.querySelector('.notes-rail__preview')?.textContent || '', /line one/);
  assert.equal(r.panel.querySelector('.notes-rail__header b').textContent, 'Alpha App');
  assert.equal(r.panel.querySelector('.artifact-panel-title-text')?.textContent, 'Notes', 'the shared panel title says Notes');
  const host = r.dom.window.rendererProjectNotesHost;
  assert.deepEqual(Object.keys(host).sort(), ['isOpen', 'markSeen', 'open', 'refresh', 'toggle']);
  assert.equal(host.isOpen(), true);
  assert.equal(host.toggle(), true);
  await flush();
  assert.equal(host.isOpen(), false, 'toggle closes an open rail');
  assert.equal(host.open(), true);
  assert.equal(host.isOpen(), true);
  await host.refresh();
});

test('a click on the preview edits through the real panel listeners', async (t) => {
  const r = bridgeRig(t);
  r.bridge.ensureArtifactSurface().openArtifactRail('notes');
  r.bridge.renderArtifactReviewPanelSafe();
  await flush();
  r.panel.querySelector('.notes-rail__preview').click();
  await flush();
  assert.ok(r.panel.querySelector('textarea[data-notes-editor]'));
  assert.deepEqual(r.store.calls.filter((call) => call[0] === 'lease'), [['lease', 'project_alpha', true]]);
});

test('with the rail module absent the mode falls back to artifact and no host is published', async (t) => {
  const r = bridgeRig(t, { withModule: false });
  r.bridge.ensureArtifactSurface().openArtifactRail('notes');
  r.bridge.renderArtifactReviewPanelSafe();
  await flush();
  assert.equal(r.state.ui.artifactReview.mode, 'artifact');
  assert.equal(r.dom.window.rendererProjectNotesHost, undefined);
  assert.equal(r.panel.querySelector('.notes-rail'), null);
});

test('the lazily loaded rail is picked up at call time and the host is removed on cleanup', async (t) => {
  const r = bridgeRig(t, { withModule: false });
  r.bridge.ensureArtifactSurface().openArtifactRail('notes');
  r.bridge.renderArtifactReviewPanelSafe();
  assert.equal(r.state.ui.artifactReview.mode, 'artifact');
  r.dom.window.rendererProjectNotesRail = notesRail; // the scripts finish loading later
  r.bridge.ensureArtifactSurface().openArtifactRail('notes');
  r.bridge.renderArtifactReviewPanelSafe();
  await flush();
  assert.equal(r.state.ui.artifactReview.mode, 'notes');
  assert.ok(r.dom.window.rendererProjectNotesHost);
  for (const fn of r.cleanups.splice(0)) fn();
  assert.equal(r.dom.window.rendererProjectNotesHost, undefined);
});

test('the bridge builds the Notes entry once with the pinned deps and wires its host lookup', async (t) => {
  const built = [];
  const entry = { bind: () => { entry.bound = (entry.bound || 0) + 1; }, dispose: () => { entry.disposed = true; }, markSeen: (...args) => { entry.seen = args; } };
  const stub = { createProjectNotesEntry: (deps) => { built.push(deps); return entry; } };
  const r = bridgeRig(t, { entryStub: stub });
  r.bridge.renderArtifactReviewPanelSafe();
  r.bridge.renderArtifactReviewPanelSafe();
  assert.equal(built.length, 1, 'built once');
  assert.equal(entry.bound, 1);
  const deps = built[0];
  assert.equal(deps.state, r.state);
  assert.equal(deps.dom.utilityCluster.id, 'chatTimelineUtilityCluster');
  assert.equal(deps.dom.artifactReviewPanel.id, 'artifactReviewPanel');
  assert.equal(typeof deps.appendClientLog, 'function');
  assert.equal(typeof deps.showToastMessage, 'function');
  // The lookup builds the lazily loaded rail, and the host forwards markSeen to the entry.
  const host = deps.getHost();
  assert.ok(host);
  host.markSeen('project_alpha', 3);
  assert.deepEqual(entry.seen, ['project_alpha', 3]);
  for (const fn of r.cleanups.splice(0)) fn();
  assert.equal(entry.disposed, true);
});

test('an absent entry module builds nothing: the dormant render stays a no-op', (t) => {
  const r = bridgeRig(t);
  assert.equal(r.bridge.renderArtifactReviewPanelSafe(), null);
  assert.equal(r.dom.window.rendererProjectNotesHost, undefined, 'no rail was built either');
});
