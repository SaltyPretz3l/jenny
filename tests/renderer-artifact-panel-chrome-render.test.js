'use strict';

// Coverage for renderer/features/renderer-artifact-panel-chrome-render.js —
// the pure string builders for the Artifact Panel V3 Canvas chrome — plus the
// header "Open in IDE" affordance added on 2026-08-20.
//
// Contract pinned here:
//   - the button is rendered by the inventory action-button primitive (never a
//     raw <button>), starts hidden + disabled, and carries BOTH its identity
//     hook (data-artifact-panel-open-ide) and the routing hook the file
//     preview controller already delegates on (data-file-preview-open-ide);
//   - the manager (renderer-artifacts-utils.js) reveals it ONLY in
//     `file_preview` rail mode with a live target, and hides + disables it in
//     artifact mode — an artifact's displayPath points inside the internal
//     .jenny/artifacts sandbox, so artifact mode has no dependable IDE target.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const chromeRender = require('../renderer/features/renderer-artifact-panel-chrome-render');
const artifactsUtils = require('../renderer/features/renderer-artifacts-utils');

function makeManagerHarness(t, { mode = 'artifact', previewPath = '' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><aside id="artifactReviewPanel"></aside></body></html>', {
    url: 'https://jenny.local/chat',
  });
  const panel = dom.window.document.getElementById('artifactReviewPanel');
  panel.innerHTML = chromeRender.buildPanelHtml();

  dom.window.localStorage.setItem(
    'jenny.artifactReview.v1',
    JSON.stringify({ enabled: true, collapsed: false, width: 420 })
  );
  const previous = globalThis.window;
  globalThis.window = dom.window;
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });

  const state = {
    ui: {
      activeView: 'chat',
      artifactReview: {},
      filePreview: { path: previewPath, line: null, column: null, status: 'ready', payload: null },
    },
    artifacts: {
      filter: 'all', selectedArtifactId: '', selectedSessionId: '', loadedArtifactId: '',
      loadedArtifactContent: '', dirtyContent: '', lastError: '', loading: false,
      savePending: false, mermaidViewMode: 'preview', viewModeByKind: {}, autoOpenedSessionIds: [],
    },
    messagesBySession: new Map(),
    features: { featureFlags: { artifact_panel_v2: true, artifact_panel_v3: true } },
  };

  const manager = artifactsUtils.createArtifactManager({
    state,
    dom: {
      artifactReviewPanel: panel,
      workspace: { style: { setProperty: () => {} }, getBoundingClientRect: () => ({ width: 1600 }) },
    },
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
  manager.setArtifactRailMode(mode);
  return { dom, panel, manager, state, button: () => panel.querySelector('.artifact-panel-open-ide') };
}

describe('chrome-render — header Open in IDE markup', () => {
  test('the multi-artifact title switcher describes its selection action', () => {
    const html = chromeRender.buildTitleHtml({ artifact: { title: 'Chart' }, artifactCount: 2 });
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
    dom.window.document.getElementById('host').innerHTML = html;
    assert.equal(dom.window.document.querySelector('[data-artifact-switcher-trigger]').title, 'Select an artifact');
  });

  test('the header renders an inventory action button, hidden and disabled by default', () => {
    const html = chromeRender.buildPanelHtml();
    assert.ok(html.includes('artifact-panel-open-ide'), 'the header carries the affordance');

    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
    dom.window.document.getElementById('host').innerHTML = html;
    const button = dom.window.document.querySelector('.artifact-panel-open-ide');
    assert.ok(button, 'the button is in the header markup');
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.title, 'Open in IDE');
    assert.equal(button.getAttribute('aria-label'), 'Open in IDE');
    assert.equal(button.classList.contains('hidden'), true, 'hidden until file_preview mode');
    assert.equal(button.disabled, true);
    assert.equal(button.classList.contains('artifact-panel-icon-btn'), true, 'shares the sibling icon-button chrome');
    assert.ok(button.closest('.artifact-panel-header-actions'), 'it lives with maximize/overflow/collapse');
    assert.ok(button.querySelector('svg'), 'icon-only, like its siblings');
  });

  test('it carries both the identity hook and the file-preview routing hook', () => {
    const html = chromeRender.buildOpenIdeButtonHtml();
    assert.ok(html.includes('data-artifact-panel-open-ide'));
    assert.ok(html.includes('data-file-preview-open-ide="true"'), 'routes through the existing rail delegation');
  });
});

describe('manager wiring — the header Open in IDE button follows the rail mode', () => {
  test('file_preview mode with a target enables and shows it', (t) => {
    const h = makeManagerHarness(t, { mode: 'file_preview', previewPath: 'renderer/app.js' });
    h.manager.renderArtifactReviewPanel();
    const button = h.button();
    assert.equal(button.classList.contains('hidden'), false);
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-disabled'), 'false');
  });

  test('artifact mode hides and disables it', (t) => {
    const h = makeManagerHarness(t, { mode: 'artifact', previewPath: 'renderer/app.js' });
    h.manager.renderArtifactReviewPanel();
    const button = h.button();
    assert.equal(button.classList.contains('hidden'), true);
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
  });

  test('file_preview mode with no target stays disabled', (t) => {
    const h = makeManagerHarness(t, { mode: 'file_preview', previewPath: '' });
    h.manager.renderArtifactReviewPanel();
    assert.equal(h.button().classList.contains('hidden'), true);
    assert.equal(h.button().disabled, true);
  });

  test('switching back to artifact mode re-hides it', (t) => {
    const h = makeManagerHarness(t, { mode: 'file_preview', previewPath: 'a/b.js' });
    h.manager.renderArtifactReviewPanel();
    assert.equal(h.button().classList.contains('hidden'), false);
    h.manager.setArtifactRailMode('artifact');
    h.manager.renderArtifactReviewPanel();
    assert.equal(h.button().classList.contains('hidden'), true);
  });
});

describe('chrome-render — controls-row wrap toggle markup', () => {
  test('the controls row renders a hidden, pressed-on wrap toggle', () => {
    const html = chromeRender.buildPanelHtml();
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
    dom.window.document.getElementById('host').innerHTML = html;
    const button = dom.window.document.querySelector('.artifact-panel-wrap');
    assert.ok(button, 'the wrap toggle is in the controls markup');
    assert.equal(button.tagName, 'BUTTON', 'inventory action-button primitive');
    assert.equal(button.getAttribute('aria-pressed'), 'true', 'wrap defaults on, like the tool-output viewer');
    assert.equal(button.classList.contains('hidden'), true, 'hidden until a text body is active');
    assert.equal(button.title, 'Wrap long lines');
    assert.ok('artifactPanelWrap' in button.dataset, 'carries the click-routing hook');
    assert.ok(button.closest('.artifact-panel-controls-actions'), 'it lives beside copy/download');
    assert.ok(button.querySelector('svg'), 'icon-only, like its siblings');
  });
});
