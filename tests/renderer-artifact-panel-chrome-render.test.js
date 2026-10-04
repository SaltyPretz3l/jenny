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
    features: { featureFlags: {} },
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
    const trigger = dom.window.document.querySelector('[data-artifact-switcher-trigger]');
    assert.equal(trigger.getAttribute('aria-label'), 'Chart, switch artifact', 'the name leads with the title');
    assert.equal(trigger.title, 'Chart, switch artifact');
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
    assert.ok(button.closest('.artifact-panel-header-actions'), 'it lives with copy/wrap/more/close');
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

describe('chrome-render — one 36px header row (area 3, owner pick A + Copy visible)', () => {
  const ARTIFACT_PANEL_CSS = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles', 'artifact-panel.css'), 'utf8');

  function mount(html = chromeRender.buildPanelHtml()) {
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
    dom.window.document.getElementById('host').innerHTML = html;
    return dom.window.document;
  }

  function actionOrder(doc) {
    return [...doc.querySelectorAll('.artifact-panel-header-actions button')]
      .filter((b) => !b.classList.contains('hidden'))
      .map((b) => (
        'artifactPanelV2Copy' in b.dataset ? 'copy'
          : 'artifactPanelWrap' in b.dataset ? 'wrap'
            : 'artifactPanelOverflow' in b.dataset ? 'more'
              : b.id === 'artifactReviewCollapseButton' ? 'close' : b.className));
  }

  test('the header row holds Copy, Wrap, More and Close; Download and Maximize live in More', () => {
    const doc = mount();
    const cluster = doc.querySelector('.artifact-panel-header .artifact-panel-header-actions');
    assert.ok(cluster.querySelector('[data-artifact-panel-wrap]'), 'Wrap moves into the header');
    assert.equal(doc.querySelector('.artifact-panel-controls [data-artifact-panel-wrap]'), null, 'no second Wrap');
    assert.equal(doc.querySelector('[data-artifact-panel-download]'), null, 'Download is a More item, not a header icon');
    const restore = cluster.querySelector('[data-artifact-panel-maximize]');
    assert.ok(restore && restore.classList.contains('hidden'), 'the Restore slot exists but shows only while maximized');
    // Wrap starts hidden (text bodies only), so the resting order is Copy, More, Close.
    assert.deepEqual(actionOrder(doc), ['copy', 'more', 'close']);
    cluster.querySelector('[data-artifact-panel-wrap]').classList.remove('hidden');
    assert.deepEqual(actionOrder(doc), ['copy', 'wrap', 'more', 'close']);
  });

  test('Close is a real close: an x glyph named "Close panel", keeping the manager id', () => {
    const close = mount().querySelector('#artifactReviewCollapseButton');
    assert.equal(close.getAttribute('aria-label'), 'Close panel');
    assert.equal(close.title, 'Close panel');
    assert.ok(close.querySelector('svg path[d="M6 6l12 12M18 6 6 18"]'), 'an x, not a chevron');
  });

  test('the title carries the kind caption, no uppercase chip', () => {
    const doc = mount(chromeRender.buildTitleHtml({ artifact: { artifactType: 'tool_output', title: 'Read REQUIREMENTS.md', outputText: 'x' }, artifactCount: 1, kind: 'text' }));
    assert.equal(doc.querySelector('.artifact-panel-type-chip'), null, 'the chip is gone');
    assert.equal(doc.querySelector('.artifact-panel-kind-caption').textContent, 'tool output');
    assert.equal(doc.querySelector('.artifact-panel-title-status'), null, 'no failed status on success');
    const image = mount(chromeRender.buildTitleHtml({ artifact: { artifactType: 'image', title: 'chart.png' }, artifactCount: 1, kind: 'image' }));
    assert.equal(image.querySelector('.artifact-panel-kind-caption').textContent, 'image');
    const code = mount(chromeRender.buildTitleHtml({ artifact: { artifactType: 'generated_file', title: 'matcher.py', generatedFile: { language: 'python', fileName: 'matcher.py' } }, artifactCount: 1, kind: 'code', formatLanguageLabel: () => 'Python' }));
    assert.equal(code.querySelector('.artifact-panel-kind-caption').textContent, 'python', 'sentence-case caption');
    assert.doesNotMatch(ARTIFACT_PANEL_CSS, /\.artifact-panel-type-chip/, 'the chip style is removed with it');
  });

  test('a failed tool call says "failed" in the danger tone', () => {
    const doc = mount(chromeRender.buildTitleHtml({ artifact: { artifactType: 'tool_output', title: 'Run pytest', status: 'error' }, artifactCount: 1, kind: 'text' }));
    const status = doc.querySelector('.artifact-panel-title-status');
    assert.ok(status, 'the failed state reaches the chrome');
    assert.equal(status.textContent, 'failed');
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-title-status \{[^}]*color: var\(--state-danger\);/);
  });

  test('a file-like title middle-ellipsizes and keeps its last eight characters', () => {
    const doc = mount(chromeRender.buildTitleHtml({ artifact: { artifactType: 'tool_output', title: 'Read REQUIREMENTS.md' }, artifactCount: 1, kind: 'text' }));
    const text = doc.querySelector('.artifact-panel-title-text');
    assert.equal(text.textContent, 'Read REQUIREMENTS.md', 'the text node still reads as the full title');
    assert.equal(text.querySelector('.artifact-panel-title-head').textContent, 'Read REQUIRE');
    assert.equal(text.querySelector('.artifact-panel-title-tail').textContent, 'MENTS.md');
    assert.equal(doc.querySelector('.artifact-panel-title').title, 'Read REQUIREMENTS.md', 'the full title on hover');
    const plain = mount(chromeRender.buildTitleHtml({ artifact: { artifactType: 'tool_output', title: 'Run the tests' }, artifactCount: 1, kind: 'text' }));
    assert.equal(plain.querySelector('.artifact-panel-title-tail'), null, 'no split without an extension');
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-title-tail \{[^}]*flex: none;/, 'the tail never shrinks');
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-title-head \{[^}]*text-overflow: ellipsis;/, 'the head takes the ellipsis');
    // A flex item collapses a trailing space under nowrap ("Readhello.py"); pre keeps "Read ".
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-title-head \{[^}]*white-space: pre;/, 'the head keeps its trailing space');
  });

  test('the middle ellipsis counts characters, so an emoji at the cut is never split', () => {
    const title = 'Notes for the demo \u{1F600}abcd.md';
    const doc = mount(chromeRender.buildTitleHtml({ artifact: { artifactType: 'tool_output', title }, artifactCount: 1, kind: 'text' }));
    const head = doc.querySelector('.artifact-panel-title-head').textContent;
    const tail = doc.querySelector('.artifact-panel-title-tail').textContent;
    assert.equal(tail, '\u{1F600}abcd.md', 'the last eight characters, the emoji whole');
    assert.equal(head + tail, title);
    assert.doesNotMatch(head + '|' + tail, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no lone surrogate on either side');
  });

  test('the header is one 36px row, its icons are 28px hit areas, and the caption drops whole', () => {
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-header \{[^}]*height: 36px;/);
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-header \.artifact-panel-icon-btn \{[^}]*width: 28px;[^}]*height: 28px;/);
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-kind-caption \{[^}]*font-size: var\(--font-size-caption\);[^}]*color: var\(--text-muted\);/);
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-header-primary \{[^}]*flex-wrap: wrap;[^}]*overflow: hidden;/, 'the caption wraps out of view instead of ellipsizing');
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-wrap\[aria-pressed="true"\][^{]*\{[^}]*background: var\(--widget-action-bg\);/, 'pressed Wrap is visible');
  });

  test('Copy folds into More below 360px so the title wins', () => {
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-review-panel\[data-panel-narrow="true"\] \.artifact-panel-copy \{ display: none; \}/);
  });

  test('no side accent bars on diff or cited rows', () => {
    assert.doesNotMatch(ARTIFACT_PANEL_CSS, /box-shadow: inset 2px 0 0/, 'diff rows keep only the row tint');
    const cited = ARTIFACT_PANEL_CSS.match(/\.artifact-file-preview-row\.is-cited \{[^}]*\}/);
    assert.ok(cited);
    assert.doesNotMatch(cited[0], /border-left/);
    const row = ARTIFACT_PANEL_CSS.match(/\.artifact-file-preview-row \{[^}]*\}/);
    assert.doesNotMatch(row[0], /border-left/);
  });

  test('the controls row holds only view, stepper and save slots', () => {
    const controls = mount().querySelector('.artifact-panel-controls');
    for (const selector of ['[data-artifact-panel-view-slot]', '[data-artifact-panel-v2-stepper-slot]', '#artifactReviewSaveButton', '#artifactReviewRevertButton']) {
      assert.ok(controls.querySelector(selector), selector);
    }
    assert.equal(controls.querySelector('[data-artifact-panel-v2-copy]'), null);
  });

  test('the detail note element and id survive for the setDetailNote seam', () => {
    assert.ok(mount().querySelector('#artifactReviewDetailNote'));
  });

  test('footer meta drops the duplicate kind, keeps read-only, and localizes the turn', () => {
    const toolOutput = chromeRender.buildStatusMetaText({ artifactType: 'tool_output', timestamp: '2026-09-28T15:53:00Z', turnIndex: 6 }, 'x'.repeat(3482));
    assert.match(toolOutput, /^read-only · 3\.4 KB · turn 6/);
    assert.doesNotMatch(toolOutput, /tool output/);
    const fileChange = chromeRender.buildStatusMetaText({ artifactType: 'tool_output', diff: { additions: 1, deletions: 0 } }, 'x');
    assert.match(fileChange, /read-only/);
    const generated = chromeRender.buildStatusMetaText({ artifactType: 'generated_file', generatedFile: { language: 'markdown' } }, 'x', (l) => l);
    assert.doesNotMatch(generated, /read-only|markdown/);
    const image = chromeRender.buildStatusMetaText({ artifactType: 'image' }, null);
    assert.doesNotMatch(image, /read-only|image/);
  });
});

describe('panel wiring — Wrap, More and non-artifact modes', () => {
  const { createArtifactPanelV2 } = require('../renderer/features/renderer-artifact-panel-v2-render');

  function makePanel(t, { narrow = false, maximized: startMaximized = false } = {}) {
    let maximized = startMaximized;
    const dom = new JSDOM('<!doctype html><body><aside id="artifactReviewPanel"></aside></body>', { url: 'https://jenny.test/' });
    const panelEl = dom.window.document.getElementById('artifactReviewPanel');
    if (narrow) panelEl.dataset.panelNarrow = 'true';
    const state = { ui: { artifactReview: { mode: 'artifact' } }, features: { featureFlags: {} }, artifacts: { loadedArtifactId: '', loadedArtifactContent: '', dirtyContent: '', viewModeByKind: {}, savePending: false } };
    const controller = createArtifactPanelV2({ panelEl, state, windowRef: dom.window, appendClientLog: () => {}, showToastMessage: () => {} });
    controller.installed();
    controller.bind();
    const wrapCalls = [];
    const wrapState = { output: true, code: true };
    controller.setTextWrapController({
      apply: (kind) => { wrapCalls.push(['apply', kind]); return wrapState[kind]; },
      toggle: (kind) => { wrapCalls.push(['toggle', kind]); wrapState[kind] = !wrapState[kind]; return wrapState[kind]; },
    });
    let artifacts = [];
    let lastArtifact = null;
    controller.connect({
      getArtifacts: () => artifacts, getSelectedArtifactSource: () => 'source', isMaximized: () => maximized,
      // The manager's toggle re-renders the chrome (toggleArtifactReviewMaximized -> afterRender).
      toggleMaximize: () => { maximized = !maximized; controller.afterRender(lastArtifact); return maximized; },
    });
    const afterRender = controller.afterRender;
    controller.afterRender = (artifact) => { lastArtifact = artifact; return afterRender(artifact); };
    t.after(() => controller.dispose());
    return { dom, panelEl, state, controller, wrapCalls, wrapState, setArtifacts: (next) => { artifacts = next; } };
  }

  function showToolOutput(h, artifact) {
    const content = h.panelEl.querySelector('#artifactReviewPreviewContent');
    content.classList.remove('hidden');
    content.innerHTML = '<div class="artifact-output-viewer"><div class="artifact-output-body"></div></div>';
    h.controller.afterRender(artifact);
  }

  function menuLabels(h) {
    return [...h.dom.window.document.querySelectorAll('.inv-context-menu-item')].map((node) => node.textContent);
  }

  const toolOutput = { id: 't1', sessionId: 's1', artifactType: 'tool_output', title: 'Read a.py', outputText: 'x', sourceMessageId: 'm1' };

  test('Wrap shows for a tool output, reads the output kind, and toggles only that kind', (t) => {
    const h = makePanel(t);
    showToolOutput(h, toolOutput);
    const wrap = h.panelEl.querySelector('[data-artifact-panel-wrap]');
    assert.equal(wrap.classList.contains('hidden'), false);
    assert.equal(wrap.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(h.wrapCalls.at(-1), ['apply', 'output']);
    wrap.click();
    assert.deepEqual(h.wrapCalls.slice(-2), [['toggle', 'output'], ['apply', 'output']], 'toggle the kind, then re-apply it');
    assert.equal(wrap.getAttribute('aria-pressed'), 'false');
    assert.equal(h.wrapState.code, true, 'the code kind keeps its own state');
  });

  test('Wrap reads the code kind for the editor and is absent for images', (t) => {
    const h = makePanel(t);
    h.panelEl.querySelector('#artifactReviewEditorShell').classList.remove('hidden');
    h.controller.afterRender({ id: 'g1', sessionId: 's1', artifactType: 'generated_file', title: 'a.py', generatedFile: { artifactId: 'g1', fileName: 'a.py', language: 'python' } });
    assert.deepEqual(h.wrapCalls.at(-1), ['apply', 'code']);
    h.panelEl.querySelector('#artifactReviewEditorShell').classList.add('hidden');
    const content = h.panelEl.querySelector('#artifactReviewPreviewContent');
    content.classList.remove('hidden');
    content.innerHTML = '<div class="artifact-preview-image-shell"><img alt=""></div>';
    h.controller.afterRender({ id: 'i1', sessionId: 's1', artifactType: 'image', title: 'pic.png' });
    assert.equal(h.panelEl.querySelector('[data-artifact-panel-wrap]').classList.contains('hidden'), true);
  });

  test('More omits what does not apply instead of disabling it', (t) => {
    const h = makePanel(t);
    showToolOutput(h, toolOutput);
    h.panelEl.querySelector('[data-artifact-panel-overflow]').click();
    const labels = menuLabels(h);
    assert.deepEqual(labels, ['Download', 'Maximize panel', 'Jump to chat']);
    assert.equal(h.dom.window.document.querySelector('.inv-context-menu-item:disabled'), null, 'no permanently disabled items');
  });

  test('a generated file lists Reveal, Open externally and Delete; Copy joins More only when narrow', (t) => {
    const h = makePanel(t, { narrow: true });
    const generated = { id: 'g1', sessionId: 's1', artifactType: 'generated_file', title: 'a.md', sourceMessageId: 'm1', generatedFile: { artifactId: 'g1', fileName: 'a.md', language: 'markdown' } };
    h.controller.afterRender(generated);
    h.panelEl.querySelector('[data-artifact-panel-overflow]').click();
    assert.deepEqual(menuLabels(h), ['Copy', 'Download', 'Maximize panel', 'Reveal in folder', 'Open externally', 'Jump to chat', 'Delete artifact']);
  });

  test('while maximized the header shows a pressed Restore and More drops Maximize', (t) => {
    const h = makePanel(t, { maximized: true });
    showToolOutput(h, toolOutput);
    const restore = h.panelEl.querySelector('[data-artifact-panel-maximize]');
    assert.equal(restore.classList.contains('hidden'), false);
    assert.equal(restore.getAttribute('aria-label'), 'Restore panel size');
    assert.equal(restore.getAttribute('aria-pressed'), 'true');
    h.panelEl.querySelector('[data-artifact-panel-overflow]').click();
    assert.equal(menuLabels(h).includes('Maximize panel'), false);
  });

  test('Restore keeps keyboard focus inside the panel when it hides itself', (t) => {
    const h = makePanel(t, { maximized: true });
    showToolOutput(h, toolOutput);
    const restore = h.panelEl.querySelector('[data-artifact-panel-maximize]');
    restore.focus();
    restore.click();
    assert.equal(restore.classList.contains('hidden'), true, 'Restore leaves once the panel is back to size');
    const active = h.dom.window.document.activeElement;
    assert.notEqual(active, restore, 'focus left the hidden Restore');
    assert.ok(h.panelEl.contains(active) && active !== h.panelEl, 'focus stays on a control inside the panel');
    assert.equal(active.classList.contains('hidden'), false);
  });

  test('a maximized rail in file preview or code review still shows Restore', (t) => {
    for (const mode of ['file_preview', 'code_review']) {
      const h = makePanel(t, { maximized: true });
      h.state.ui.artifactReview.mode = mode;
      h.controller.afterRender(null);
      const restore = h.panelEl.querySelector('[data-artifact-panel-maximize]');
      assert.equal(restore.classList.contains('hidden'), false, mode + ': Restore is the way back');
      restore.focus();
      restore.click();
      assert.equal(restore.classList.contains('hidden'), true, mode + ': restored');
      const active = h.dom.window.document.activeElement;
      assert.ok(h.panelEl.contains(active) && active !== restore, mode + ': focus stays in the panel');
    }
  });

  test('non-artifact modes keep the shared header with Close but hide Copy, Wrap and More', (t) => {
    const h = makePanel(t);
    for (const mode of ['tasks', 'code_review', 'file_preview', 'subagents']) {
      h.state.ui.artifactReview.mode = mode;
      h.controller.afterRender(toolOutput);
      for (const selector of ['[data-artifact-panel-v2-copy]', '[data-artifact-panel-wrap]', '[data-artifact-panel-overflow]', '[data-artifact-panel-maximize]']) {
        assert.equal(h.panelEl.querySelector(selector).classList.contains('hidden'), true, mode + ':' + selector);
      }
      assert.equal(h.panelEl.querySelector('#artifactReviewCollapseButton').classList.contains('hidden'), false, mode + ': Close stays');
    }
  });
});
