'use strict';

// `file_preview` as an artifact-review RAIL MODE: the prefs normalizer, the
// renderSplitDetail dispatch, the layout data-attribute stamp, the
// non-persistence of the mode, and the openArtifactTarget mode reset.
//
// Also pins the regression the bridge's DUPLICATE preference normalizer would
// otherwise cause: renderer-shell-artifact-bridge.js::normalizeArtifactReviewPreferences
// drops `mode` entirely, so if renderArtifactReviewPanelSafe() ever routed
// through it while the rail was in file_preview, the preview would silently
// revert to artifact mode mid-render. It must stay unreachable once the
// surface controller exists.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const artifactsUtils = require('../renderer/features/renderer-artifacts-utils');
const reviewPrefs = require('../renderer/features/renderer-artifact-review-prefs');
const { createShellArtifactBridge } = require('../renderer/shell/renderer-shell-artifact-bridge');

const STORAGE_KEY = 'jenny.artifactReview.v1';

const PANEL_HTML = '<div id="workspace"><div id="chatView">'
  + '<aside class="artifact-review-panel" id="artifactReviewPanel">'
  + '<div class="artifact-review-scroll">'
  + '<div id="artifactReviewDetailEmpty"></div>'
  + '<div class="artifact-review-detail-panel hidden" id="artifactReviewDetailPanel">'
  + '<span id="artifactReviewDetailKicker"></span><span id="artifactReviewDetailTitle"></span>'
  + '<span id="artifactReviewDetailPath"></span><span id="artifactReviewDetailStatus"></span>'
  + '<div id="artifactReviewDetailMeta"></div><div id="artifactReviewProvenanceTimeline"></div>'
  + '<div class="artifact-preview-content hidden" id="artifactReviewPreviewContent"></div>'
  + '<div id="artifactReviewEditorShell"></div><span id="artifactReviewDirtyBadge"></span>'
  + '</div></div></aside>'
  + '<div id="artifactReviewStatus"></div></div></div>';

function withDomShim(t, store) {
  // A real origin: jsdom refuses localStorage for opaque (about:blank) ones.
  const dom = new JSDOM('<!doctype html><html><body>' + PANEL_HTML + '</body></html>', {
    url: 'https://jenny.local/chat',
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  dom.window.localStorage.clear();
  for (const key of Object.keys(store || {})) dom.window.localStorage.setItem(key, store[key]);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  });
  return dom;
}

function makeState() {
  return {
    ui: { activeView: 'chat', artifactReview: {} },
    artifacts: {
      filter: 'all', selectedArtifactId: '', selectedSessionId: '', loadedArtifactId: '',
      loadedArtifactContent: '', dirtyContent: '', lastError: '', loading: false,
      savePending: false, mermaidViewMode: 'preview', viewModeByKind: {},
      autoOpenedSessionIds: [], deletedArtifactIds: [],
    },
    messagesBySession: new Map(),
    features: { featureFlags: { artifact_panel_v2: false } },
  };
}

function makeManager(t, state, dom, extraCallbacks) {
  const doc = dom.window.document;
  const byId = (id) => doc.getElementById(id);
  const manager = artifactsUtils.createArtifactManager({
    state,
    dom: {
      workspace: byId('workspace'),
      chatView: byId('chatView'),
      artifactReviewPanel: byId('artifactReviewPanel'),
      artifactReviewStatus: byId('artifactReviewStatus'),
      artifactReviewDetailEmpty: byId('artifactReviewDetailEmpty'),
      artifactReviewDetailPanel: byId('artifactReviewDetailPanel'),
      artifactReviewDetailKicker: byId('artifactReviewDetailKicker'),
      artifactReviewDetailTitle: byId('artifactReviewDetailTitle'),
      artifactReviewDetailPath: byId('artifactReviewDetailPath'),
      artifactReviewDetailStatus: byId('artifactReviewDetailStatus'),
      artifactReviewDetailMeta: byId('artifactReviewDetailMeta'),
      artifactReviewPreviewContent: byId('artifactReviewPreviewContent'),
      artifactReviewEditorShell: byId('artifactReviewEditorShell'),
      artifactReviewProvenanceTimeline: byId('artifactReviewProvenanceTimeline'),
    },
    callbacks: Object.assign({
      escapeHtml: (value) => String(value == null ? '' : value),
      getActiveSession: () => ({ id: 'session-1' }),
      setActiveView: (view) => { state.ui.activeView = view; },
      scrollMessageIntoView: () => {},
      appendClientLog: () => {},
      showToastMessage: () => {},
      toErrorMessage: (error) => String(error?.message || error || ''),
      updateComposerSafeOffset: () => {},
      renderAll: () => {},
    }, extraCallbacks || {}),
  });
  t.after(() => manager.dispose());
  return manager;
}

describe('file_preview rail mode — preferences', () => {
  test('normalizeArtifactReviewMode accepts file_preview alongside code_review', () => {
    assert.equal(reviewPrefs.normalizeArtifactReviewMode('file_preview'), 'file_preview');
    assert.equal(reviewPrefs.normalizeArtifactReviewMode('FILE_PREVIEW'), 'file_preview');
    assert.equal(reviewPrefs.normalizeArtifactReviewMode('code_review'), 'code_review');
    assert.equal(reviewPrefs.normalizeArtifactReviewMode('nonsense'), 'artifact');
    assert.equal(reviewPrefs.normalizeArtifactReviewMode(undefined), 'artifact');
  });

  test('the rail mode is renderer-local: file_preview never reaches localStorage', (t) => {
    const dom = withDomShim(t, {});
    const state = makeState();
    const manager = makeManager(t, state, dom);
    manager.openArtifactRail('file_preview');

    assert.equal(state.ui.artifactReview.mode, 'file_preview');
    const persisted = JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY) || '{}');
    assert.equal('mode' in persisted, false, 'mode is not part of the persisted shape');
    assert.equal(persisted.enabled, true);
  });
});

describe('openArtifactRail', () => {
  test('opens the rail without selecting an artifact and clears the sticky dismissal', (t) => {
    const dom = withDomShim(t, {
      [STORAGE_KEY]: JSON.stringify({ enabled: false, collapsed: true, userDismissed: true }),
    });
    const state = makeState();
    state.ui.activeView = 'settings';
    const manager = makeManager(t, state, dom);

    assert.equal(manager.openArtifactRail('file_preview'), 'file_preview');
    assert.equal(state.ui.artifactReview.enabled, true);
    assert.equal(state.ui.artifactReview.collapsed, false);
    assert.equal(state.ui.artifactReview.userDismissed, false);
    assert.equal(state.ui.activeView, 'chat', 'the rail lives on the chat page');
    assert.equal(state.artifacts.selectedArtifactId, '', 'no synthetic artifact selection');
  });

  test('an unknown mode normalizes to artifact instead of stamping garbage', (t) => {
    const dom = withDomShim(t, {});
    const state = makeState();
    const manager = makeManager(t, state, dom);
    assert.equal(manager.openArtifactRail('whatever'), 'artifact');
  });
});

describe('layout + dispatch', () => {
  test('syncArtifactReviewLayout stamps data-artifact-review-mode="file_preview"', (t) => {
    const dom = withDomShim(t, {});
    const state = makeState();
    const manager = makeManager(t, state, dom);
    manager.openArtifactRail('file_preview');
    manager.syncArtifactReviewLayout();

    const panel = dom.window.document.getElementById('artifactReviewPanel');
    assert.equal(panel.dataset.artifactReviewMode, 'file_preview');
    assert.equal(panel.classList.contains('code-review-mode'), false);
  });

  test('renderSplitDetail dispatches to the preview owner in file_preview mode only', (t) => {
    const dom = withDomShim(t, {});
    const state = makeState();
    const previewSurfaces = [];
    const codeReviewSurfaces = [];
    const manager = makeManager(t, state, dom, {
      renderFilePreviewSurface: (surface) => previewSurfaces.push(surface),
      renderCodeReviewSurface: (surface) => codeReviewSurfaces.push(surface),
    });

    manager.openArtifactRail('file_preview');
    manager.renderArtifactReviewPanel();
    assert.equal(previewSurfaces.length, 1, 'file_preview paints through the preview owner');
    assert.equal(codeReviewSurfaces.length, 0);
    assert.equal(previewSurfaces[0].key, 'split');

    manager.openArtifactRail('code_review');
    manager.renderArtifactReviewPanel();
    assert.equal(previewSurfaces.length, 1, 'code_review does not reach the preview owner');
    assert.equal(codeReviewSurfaces.length, 1);

    manager.openArtifactRail('artifact');
    manager.renderArtifactReviewPanel();
    assert.equal(previewSurfaces.length, 1);
    assert.equal(codeReviewSurfaces.length, 1);
  });

  test('an explicit artifact open resets ANY non-artifact rail mode', async (t) => {
    const dom = withDomShim(t, {});
    const state = makeState();
    const manager = makeManager(t, state, dom);

    manager.openArtifactRail('file_preview');
    await manager.openArtifactTarget('', { source: 'inline-open-panel' });
    assert.equal(state.ui.artifactReview.mode, 'artifact');

    manager.openArtifactRail('code_review');
    await manager.openArtifactTarget('', { source: 'inline-open-panel' });
    assert.equal(state.ui.artifactReview.mode, 'artifact');
  });
});

describe('session-switch invalidation', () => {
  // Owner report 2026-08-20: a preview opened from session A survived into an
  // unrelated session B as a stuck panel. A session switch must close the
  // file_preview rail and reset the preview owner.
  test('switching sessions closes file_preview and resets the preview owner', (t) => {
    const dom = withDomShim(t, {});
    const state = makeState();
    let resets = 0;
    const manager = makeManager(t, state, dom, {
      renderFilePreviewSurface: () => {},
      resetFilePreview: () => { resets += 1; },
    });

    state.currentSessionId = 'session-1';
    manager.renderArtifactReviewPanel();
    manager.openArtifactRail('file_preview');
    manager.renderArtifactReviewPanel();
    assert.equal(state.ui.artifactReview.mode, 'file_preview', 're-render in the SAME session keeps the preview');
    assert.equal(resets, 0);

    state.currentSessionId = 'session-2';
    manager.renderArtifactReviewPanel();
    assert.equal(state.ui.artifactReview.mode, 'artifact');
    assert.equal(resets, 1, 'the preview owner slot is cleared, not just hidden');
    const panel = dom.window.document.getElementById('artifactReviewPanel');
    assert.equal(panel.dataset.artifactReviewMode, 'artifact', 'the layout stamp follows in the same pass');
  });

  test('a switch leaves artifact and code_review modes untouched', (t) => {
    const dom = withDomShim(t, {});
    const state = makeState();
    let resets = 0;
    const manager = makeManager(t, state, dom, {
      renderCodeReviewSurface: () => {},
      resetFilePreview: () => { resets += 1; },
    });

    state.currentSessionId = 'session-1';
    manager.renderArtifactReviewPanel();
    manager.openArtifactRail('code_review');
    state.currentSessionId = 'session-2';
    manager.renderArtifactReviewPanel();
    assert.equal(state.ui.artifactReview.mode, 'code_review', 'code_review keeps its own session semantics');
    assert.equal(resets, 0);
  });
});

describe('bridge duplicate-normalizer regression', () => {
  test('renderArtifactReviewPanelSafe never routes file_preview through the mode-dropping normalizer', (t) => {
    const dom = withDomShim(t, {
      [STORAGE_KEY]: JSON.stringify({ enabled: true, collapsed: false }),
    });
    const state = makeState();
    const previewSurfaces = [];
    const bridge = createShellArtifactBridge({
      state,
      windowRef: dom.window,
      dom: { artifactReviewPanel: dom.window.document.getElementById('artifactReviewPanel') },
      lazyDom: {
        getArtifactsDom: () => ({
          artifactReviewPanel: dom.window.document.getElementById('artifactReviewPanel'),
          artifactReviewDetailPanel: dom.window.document.getElementById('artifactReviewDetailPanel'),
          artifactReviewPreviewContent: dom.window.document.getElementById('artifactReviewPreviewContent'),
        }),
      },
      artifactsUtils,
      registerCleanup: () => {},
      callbacks: {
        getActiveSession: () => ({ id: 'session-1' }),
        setActiveView: (view) => { state.ui.activeView = view; },
      },
    });

    const surface = bridge.ensureArtifactSurface();
    assert.ok(surface, 'the surface controller builds');
    // Stand in for the real preview owner (the bridge builds the true one
    // lazily; this asserts the dispatch, not the module).
    surface.openArtifactRail('file_preview');
    assert.equal(state.ui.artifactReview.mode, 'file_preview');

    bridge.renderArtifactReviewPanelSafe();
    bridge.syncArtifactReviewLayout();
    bridge.isArtifactReviewVisible();

    assert.equal(
      state.ui.artifactReview.mode,
      'file_preview',
      'the bridge normalizer (which drops `mode`) is unreachable once the surface exists'
    );
    assert.equal(previewSurfaces.length, 0);
    assert.equal(typeof bridge.openFilePreviewTarget, 'function', 'the bridge exposes the open verb');
  });
});
