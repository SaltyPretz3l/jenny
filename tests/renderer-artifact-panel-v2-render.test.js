'use strict';

// Artifact Panel V2 chrome (ARTIFACT_PANEL_V2_SPEC.md, artifact_panel_v2).
// Covers the spec's acceptance list: flag-off byte-identical, no nested
// border/gradient chain reachable, version stepper, save/revert visibility,
// provenance popover, footer meta, empty state, and code-review-mode parity.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { SCRIPT_ORDER } = require('./helpers/renderer-shell-harness-support');

const repoRoot = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const actionButton = require('../renderer/inventory/action-button.js');
const popover = require('../renderer/inventory/popover.js');
const versionHistory = require('../renderer/features/renderer-artifact-version-history-utils.js');
const {
  createArtifactPanelV2,
} = require('../renderer/features/renderer-artifact-panel-v2-render.js');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Static shell fragment mirroring index.html's #artifactReviewPanel markup
// (legacy, pre-V2). Used to build the flag-off baseline and as the install
// target for flag-on tests.
function legacyPanelInnerHtml() {
  return `
    <div class="artifact-review-header">
      <div class="artifact-review-heading">
        <span class="artifact-review-kicker">Artifact Review</span>
        <span class="artifact-review-status" id="artifactReviewStatus">Split view keeps artifact details beside chat.</span>
      </div>
      <div class="artifact-review-actions">
        <button class="artifact-review-action" id="artifactReviewCollapseButton" type="button" aria-label="Collapse artifact review" title="Collapse panel">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 4l-4 4 4 4"/></svg>
        </button>
      </div>
    </div>
    <div class="artifact-review-scroll">
      <div class="artifacts-detail-empty" id="artifactReviewDetailEmpty">
        <h3>Select an artifact</h3>
        <p>Choose a session artifact from chat, the shelf, or the catalog to inspect it here.</p>
      </div>
      <div class="artifacts-detail-panel hidden artifact-review-detail-panel" id="artifactReviewDetailPanel">
        <div class="artifacts-detail-header">
          <div>
            <div class="artifact-detail-kicker" id="artifactReviewDetailKicker">Artifact</div>
            <h3 class="artifact-detail-title" id="artifactReviewDetailTitle">Artifact</h3>
            <p class="artifact-detail-path" id="artifactReviewDetailPath"></p>
          </div>
          <div class="artifact-detail-header-status">
            <span class="dirty-badge hidden" id="artifactReviewDirtyBadge">Modified</span>
            <div class="artifact-detail-status" id="artifactReviewDetailStatus">Available</div>
          </div>
        </div>
        <div class="artifact-preview-shell" id="artifactReviewPreviewShell">
          <div class="artifact-editor-shell hidden" id="artifactReviewEditorShell">
            <div class="artifact-editor-host" id="artifactReviewEditorHost" aria-label="Artifact editor"></div>
            <textarea class="artifact-editor-fallback hidden" id="artifactReviewEditorFallback" spellcheck="false" aria-label="Artifact editor fallback"></textarea>
          </div>
          <div class="artifact-preview-content hidden" id="artifactReviewPreviewContent"></div>
        </div>
        <div class="artifact-detail-note" id="artifactReviewDetailNote">Select an artifact to inspect its metadata and content.</div>
        <div class="artifact-detail-actions">
          <div class="artifact-detail-actions-primary">
            <button class="settings-primary" id="artifactReviewSaveButton" type="button" title="Save changes to disk" aria-label="Save artifact">Save</button>
            <button class="settings-secondary" id="artifactReviewRevertButton" type="button" title="Discard unsaved changes" aria-label="Revert artifact">Revert</button>
            <button class="settings-danger" id="artifactReviewDeleteButton" type="button" title="Delete this artifact" aria-label="Delete artifact">Delete</button>
          </div>
          <div class="artifact-detail-actions-secondary">
            <button class="settings-secondary" id="artifactReviewRevealButton" type="button" title="Show file in explorer" aria-label="Reveal artifact in explorer">Reveal</button>
            <button class="settings-secondary" id="artifactReviewOpenExternalButton" type="button" title="Open in default application" aria-label="Open artifact externally">Open External</button>
            <button class="settings-secondary" id="artifactReviewJumpButton" type="button" title="Scroll to source message" aria-label="Jump to source message">Jump to Chat</button>
          </div>
        </div>
        <section class="artifacts-meta-section artifact-review-meta-section">
          <div class="section-header"><span class="section-header-label">Artifact Detail</span></div>
          <div class="artifact-review-detail-meta" id="artifactReviewDetailMeta"></div>
        </section>
        <section class="artifacts-meta-section artifact-review-meta-section">
          <div class="section-header"><span class="section-header-label">Provenance</span></div>
          <div class="artifacts-provenance-timeline" id="artifactReviewProvenanceTimeline"></div>
        </section>
      </div>
    </div>
  `;
}

function makeHarness(t, { flagOn = true } = {}) {
  const dom = new JSDOM('<body><aside class="artifact-review-panel hidden" id="artifactReviewPanel" aria-label="Artifact review"></aside></body>');
  t.after(() => { app.dispose?.(); });
  const doc = dom.window.document;
  const panelEl = doc.getElementById('artifactReviewPanel');
  panelEl.innerHTML = legacyPanelInnerHtml();
  const state = {
    features: { featureFlags: { artifact_panel_v2: flagOn } },
    artifacts: {
      loadedArtifactId: '',
      loadedArtifactContent: '',
      dirtyContent: '',
    },
  };
  const appendClientLog = () => {};
  const app = {
    dispose() { /* nothing persistent held outside the module instance */ },
  };
  return { dom, doc, panelEl, state, appendClientLog };
}

describe('artifact panel v2 install gating', () => {
  test('flag-off: module does not touch the panel, no artifact-panel-v2 class', () => {
    const { doc, panelEl, state, appendClientLog } = makeHarness({ after() {} }, { flagOn: false });
    const before = panelEl.innerHTML;
    const v2 = createArtifactPanelV2({
      panelEl,
      state,
      windowRef: doc.defaultView,
      escapeHtml,
      appendClientLog,
    });
    const installed = v2.installed();
    assert.equal(installed, false, 'flag-off must not install V2 markup');
    assert.equal(panelEl.innerHTML, before, 'flag-off panel markup must stay byte-identical');
    assert.equal(panelEl.classList.contains('artifact-panel-v2'), false);
  });

  test('flag-on: installs V2 markup and tags the panel with artifact-panel-v2', () => {
    const { panelEl, state, doc, appendClientLog } = makeHarness({ after() {} }, { flagOn: true });
    const v2 = createArtifactPanelV2({
      panelEl,
      state,
      windowRef: doc.defaultView,
      escapeHtml,
      appendClientLog,
    });
    assert.equal(v2.installed(), true);
    assert.equal(panelEl.classList.contains('artifact-panel-v2'), true);
  });
});

describe('artifact panel v2 id/class reuse contract', () => {
  function installed(t) {
    const h = makeHarness(t, { flagOn: true });
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl,
      state: h.state,
      windowRef: h.doc.defaultView,
      escapeHtml,
      appendClientLog: h.appendClientLog,
    });
    v2.installed();
    return { ...h, v2 };
  }

  test('legacy ids remain queryable after install', (t) => {
    const { panelEl } = installed(t);
    // W1-5: artifactReviewOpenFullButton dropped — the studio ("full view")
    // is gone, so V2 no longer renders the control.
    const ids = [
      'artifactReviewStatus', 'artifactReviewCollapseButton',
      'artifactReviewDetailEmpty', 'artifactReviewDetailPanel', 'artifactReviewDetailKicker',
      'artifactReviewDetailPath', 'artifactReviewDetailStatus', 'artifactReviewDetailMeta',
      'artifactReviewDetailTitle', 'artifactReviewDirtyBadge', 'artifactReviewPreviewShell',
      'artifactReviewEditorShell', 'artifactReviewEditorHost', 'artifactReviewEditorFallback',
      'artifactReviewPreviewContent', 'artifactReviewDetailNote', 'artifactReviewSaveButton',
      'artifactReviewRevertButton', 'artifactReviewRevealButton', 'artifactReviewJumpButton',
      'artifactReviewDeleteButton', 'artifactReviewOpenExternalButton', 'artifactReviewProvenanceTimeline',
    ];
    for (const id of ids) {
      assert.ok(panelEl.querySelector(`#${id}`), `#${id} should remain queryable`);
    }
  });

  test('detail panel keeps artifact-review-detail-panel, drops artifacts-detail-panel', (t) => {
    const { panelEl } = installed(t);
    const detailPanel = panelEl.querySelector('#artifactReviewDetailPanel');
    assert.ok(detailPanel.classList.contains('artifact-review-detail-panel'));
    assert.equal(detailPanel.classList.contains('artifacts-detail-panel'), false);
  });

  test('hidden-but-present nodes: status/kicker/path/detailStatus/detailMeta/detailNote/dirtyBadge/openExternal', (t) => {
    const { panelEl } = installed(t);
    for (const id of [
      'artifactReviewStatus', 'artifactReviewDetailKicker', 'artifactReviewDetailPath',
      'artifactReviewDetailStatus', 'artifactReviewDetailMeta', 'artifactReviewDetailNote',
      'artifactReviewDirtyBadge', 'artifactReviewOpenExternalButton',
    ]) {
      const node = panelEl.querySelector(`#${id}`);
      assert.ok(node, `#${id} present`);
      assert.equal(node.classList.contains('hidden') || node.hasAttribute('hidden'), true, `#${id} should be hidden`);
    }
  });

  test('scroll container class artifact-review-scroll present, is the full-bleed content host', (t) => {
    const { panelEl } = installed(t);
    const scrollHost = panelEl.querySelector('.artifact-review-scroll');
    assert.ok(scrollHost);
    assert.ok(scrollHost.querySelector('#artifactReviewPreviewShell'), 'preview shell lives inside the scroll host');
  });

  test('preview shell carries no border/background/radius classes', (t) => {
    const { panelEl } = installed(t);
    const shell = panelEl.querySelector('#artifactReviewPreviewShell');
    assert.equal(shell.classList.contains('artifact-preview-shell'), false, 'must drop the legacy bordered shell class');
  });
});

describe('artifact panel v2 gradient/border unreachability', () => {
  test('V2 header/toolbar/footer use V2-specific classes, not legacy gradient-bearing classes', (t) => {
    const { panelEl } = (function install() {
      const h = makeHarness(t, { flagOn: true });
      createArtifactPanelV2({
        panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
      }).installed();
      return h;
    })();
    const header = panelEl.querySelector('.artifact-panel-v2-header');
    assert.ok(header, 'V2 header should use a V2-specific class');
    assert.equal(header.classList.contains('artifact-review-header'), false, 'legacy gradient-bearing header class must be unreachable');
  });

  test('V2 CSS section contains no gradient token', () => {
    const css = readRepoFile('styles/artifact-panel.css');
    const marker = css.indexOf('Artifact Panel V2');
    assert.notEqual(marker, -1, 'expected a V2 CSS section marker in artifact-panel.css');
    const v2Section = css.slice(marker);
    assert.doesNotMatch(v2Section, /gradient/i, 'V2 CSS section must not introduce gradient rules');
  });

  test('V2 CSS section sets no border on the content chain (preview shell / scroll host)', () => {
    const css = readRepoFile('styles/artifact-panel.css');
    const marker = css.indexOf('Artifact Panel V2');
    assert.notEqual(marker, -1, 'expected a V2 CSS section marker in artifact-panel.css');
    const v2Section = css.slice(marker);
    // The real content chain the V2 markup renders: the scroll host
    // (.artifact-panel-v2-scroll, contentHtml()'s outer div), the full-bleed
    // content host (.artifact-panel-v2-content-host, wraps #artifactReviewPreviewShell),
    // and the id the module actually assigns to the preview shell node itself.
    const CONTENT_CHAIN_SELECTORS = [
      '.artifact-panel-v2-scroll',
      '.artifact-panel-v2-content-host',
      '#artifactReviewPreviewShell',
      '#artifactReviewEditorShell',
    ];
    // Rule-block matcher: split the V2 CSS section into `selector { body }`
    // blocks and keep the ones where the target selector appears as its own
    // compound-selector token (comma/whitespace-bounded) -- so
    // ".artifact-panel-v2-scroll" matches itself and its descendant rules,
    // but not ".artifact-panel-v2-scroll::-webkit-scrollbar-thumb" (a
    // different, unrelated compound selector that merely shares the prefix).
    // Every rule in this file already lives under the V2 section (the whole
    // haystack is sliced from the "Artifact Panel V2" marker).
    function findRuleBlocksForSelector(section, selector) {
      const blockRegex = /([^{}]+)\{([^{}]*)\}/g;
      const escaped = selector.replace(/[.#]/g, '\\$&');
      // Excludes pseudo-elements (::foo) -- those style a synthetic box that
      // is not the content-chain element's own border/background/box, e.g.
      // a scrollbar thumb -- while still allowing pseudo-classes (:hover)
      // and descendant/comma-separated compounds.
      const tokenRegex = new RegExp(`(?:^|[\\s,])${escaped}(?!::)(?=$|[\\s,.:\\[])`);
      const blocks = [];
      let match;
      while ((match = blockRegex.exec(section))) {
        const [, selectorText, body] = match;
        const normalizedSelectorText = selectorText.replace(/\s+/g, ' ').trim();
        if (tokenRegex.test(` ${normalizedSelectorText} `)) blocks.push(body);
      }
      return blocks;
    }
    let matchedAny = false;
    for (const selector of CONTENT_CHAIN_SELECTORS) {
      const blocks = findRuleBlocksForSelector(v2Section, selector);
      for (const body of blocks) {
        matchedAny = true;
        // border-radius (and its longhands) control corner rounding, not
        // whether a border line is drawn -- excluded from this check, which
        // is about a real visible border/rule, per the finding's intent.
        assert.doesNotMatch(
          body,
          /\bborder(-(?!radius\b|top-left-radius\b|top-right-radius\b|bottom-left-radius\b|bottom-right-radius\b)\w+)?\s*:\s*(?!none\b)\S/i,
          `content-chain selector "${selector}" must not set a real border; rule body: ${body}`
        );
      }
    }
    assert.ok(matchedAny, 'expected to find at least one rule targeting the content chain (oracle must not be vacuous)');

    // The one intentional exception: the embedded HTML preview host drops its
    // border inside V2 (border: none), which is exempt from the check above
    // because "none" is not a real border -- assert it is actually present.
    assert.match(
      v2Section,
      /\.artifact-panel-v2-content-host\s+\.artifact-html-preview-host\s*\{[^}]*border\s*:\s*none/i,
      'expected the .artifact-html-preview-host override with border: none'
    );
  });
});

describe('artifact panel v2 version stepper', () => {
  function buildState(messages) {
    return {
      features: { featureFlags: { artifact_panel_v2: true } },
      artifacts: { loadedArtifactId: '', loadedArtifactContent: '', dirtyContent: '' },
      messagesBySession: new Map([['s1', messages]]),
    };
  }
  function toolMessage(artifactId, fileName, timestamp) {
    return {
      id: `msg-${artifactId}`,
      role: 'tool',
      kind: 'tool_result',
      timestamp,
      finalizedAt: timestamp,
      tool_result: {
        call_id: `call-${artifactId}`,
        tool_name: 'create_artifact',
        output_text: 'ok',
        is_error: false,
        generated_artifacts: [{
          artifact_id: artifactId,
          artifact_kind: 'document',
          title: fileName,
          file_name: fileName,
          display_path: `.jenny/artifacts/s1/${fileName}`,
          language: 'html',
          editable: true,
          status: 'available',
        }],
      },
    };
  }
  function artifactFor(artifactId, sessionId) {
    return {
      id: artifactId,
      sessionId,
      artifactType: 'generated_file',
      timestamp: '2026-01-01T00:00:00.000Z',
      generatedFile: { artifactId, fileName: 'chart.html', language: 'html', editable: true, status: 'available' },
    };
  }

  test('1 version: no stepper markup at all', (t) => {
    const h = makeHarness(t, { flagOn: true });
    h.state.messagesBySession = new Map([['s1', [toolMessage('a1', 'chart.html', '2026-01-01T00:00:00.000Z')]]]);
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    v2.afterRender(artifactFor('a1', 's1'));
    assert.equal(h.panelEl.querySelector('.artifact-panel-v2-stepper'), null, 'stepper must be absent at 1 version');
  });

  test('3 versions: shows v2/3, ends disabled, prev/next re-select the neighbor', (t) => {
    const h = makeHarness(t, { flagOn: true });
    h.state.messagesBySession = new Map([['s1', [
      toolMessage('a1', 'chart.html', '2026-01-01T00:00:00.000Z'),
      toolMessage('a2', 'chart.html', '2026-01-02T00:00:00.000Z'),
      toolMessage('a3', 'chart.html', '2026-01-03T00:00:00.000Z'),
    ]]]);
    let selected = null;
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    v2.bind();
    v2.connect({ selectArtifact: (id) => { selected = id; } });
    v2.afterRender(artifactFor('a2', 's1'));
    const stepper = h.panelEl.querySelector('.artifact-panel-v2-stepper');
    assert.ok(stepper, 'stepper should render at 3 versions');
    assert.match(stepper.textContent, /v2\/3/);
    const prevBtn = stepper.querySelector('[data-artifact-select]:first-child, button:first-of-type');
    // Simulate click via the delegation contract: dispatch a click event.
    const buttons = Array.from(stepper.querySelectorAll('button'));
    assert.equal(buttons.length, 2, 'expected two chevron buttons');
    buttons[0].dispatchEvent(new h.doc.defaultView.Event('click', { bubbles: true }));
    assert.equal(selected, 'a1', 'prev button selects a1');
    buttons[1].dispatchEvent(new h.doc.defaultView.Event('click', { bubbles: true }));
    assert.equal(selected, 'a3', 'next button selects a3');
  });

  test('at k=1 back is disabled, at k=n forward is disabled', (t) => {
    const h = makeHarness(t, { flagOn: true });
    h.state.messagesBySession = new Map([['s1', [
      toolMessage('a1', 'chart.html', '2026-01-01T00:00:00.000Z'),
      toolMessage('a2', 'chart.html', '2026-01-02T00:00:00.000Z'),
    ]]]);
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    v2.afterRender(artifactFor('a1', 's1'));
    let stepper = h.panelEl.querySelector('.artifact-panel-v2-stepper');
    let buttons = Array.from(stepper.querySelectorAll('button'));
    assert.equal(buttons[0].disabled, true, 'k=1: back disabled');
    assert.equal(buttons[1].disabled, false);

    v2.afterRender(artifactFor('a2', 's1'));
    stepper = h.panelEl.querySelector('.artifact-panel-v2-stepper');
    buttons = Array.from(stepper.querySelectorAll('button'));
    assert.equal(buttons[0].disabled, false);
    assert.equal(buttons[1].disabled, true, 'k=n: forward disabled');
  });
});

describe('artifact panel v2 save/revert visibility', () => {
  test('absent (hidden) when clean, visible when dirty, hidden again after revert', (t) => {
    const h = makeHarness(t, { flagOn: true });
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    const artifact = {
      id: 'a1', sessionId: 's1', artifactType: 'generated_file',
      generatedFile: { artifactId: 'a1', fileName: 'x.html', editable: true, status: 'available' },
    };
    h.state.artifacts.loadedArtifactId = 'a1';
    h.state.artifacts.loadedArtifactContent = 'same';
    h.state.artifacts.dirtyContent = 'same';
    v2.afterRender(artifact);
    const saveBtn = h.panelEl.querySelector('#artifactReviewSaveButton');
    const revertBtn = h.panelEl.querySelector('#artifactReviewRevertButton');
    assert.equal(saveBtn.classList.contains('hidden'), true, 'clean: save hidden');
    assert.equal(revertBtn.classList.contains('hidden'), true, 'clean: revert hidden');

    h.state.artifacts.dirtyContent = 'changed';
    v2.afterRender(artifact);
    assert.equal(saveBtn.classList.contains('hidden'), false, 'dirty: save visible');
    assert.equal(revertBtn.classList.contains('hidden'), false, 'dirty: revert visible');

    h.state.artifacts.dirtyContent = 'same';
    v2.afterRender(artifact);
    assert.equal(saveBtn.classList.contains('hidden'), true, 'reverted: save hidden again');
    assert.equal(revertBtn.classList.contains('hidden'), true, 'reverted: revert hidden again');
  });
});

describe('artifact panel v2 Edit toggle gating (Finding 2)', () => {
  test('markdown generated artifact: Edit visible, toggles pressed state via the existing seam', (t) => {
    const h = makeHarness(t, { flagOn: true });
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    v2.bind();
    let mode = 'read';
    v2.connect({
      isSelectedArtifactMarkdownGenerated: () => true,
      getArtifactDocumentViewMode: () => mode,
      setArtifactDocumentViewMode: (_surfaceKey, nextMode) => { mode = nextMode; },
    });
    const artifact = {
      id: 'a1', sessionId: 's1', artifactType: 'generated_file',
      generatedFile: { artifactId: 'a1', fileName: 'n.md', editable: true, status: 'available' },
    };
    v2.afterRender(artifact);
    const editBtn = h.panelEl.querySelector('[data-artifact-panel-v2-edit]');
    assert.ok(editBtn, 'Edit button should exist in markup');
    assert.equal(editBtn.classList.contains('hidden'), false, 'markdown artifact: Edit must be visible');
    assert.equal(editBtn.disabled, false, 'markdown artifact: Edit must be enabled');
    assert.equal(editBtn.getAttribute('aria-pressed'), 'false', 'starts unpressed (read mode)');

    editBtn.dispatchEvent(new h.doc.defaultView.Event('click', { bubbles: true }));
    v2.afterRender(artifact);
    assert.equal(editBtn.getAttribute('aria-pressed'), 'true', 'toggles to pressed (source mode) after click');
  });

  test('html/code generated artifact: Edit button hidden (toggle is a no-op for code kinds)', (t) => {
    const h = makeHarness(t, { flagOn: true });
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    v2.connect({ isSelectedArtifactMarkdownGenerated: () => false });
    const artifact = {
      id: 'a1', sessionId: 's1', artifactType: 'generated_file',
      generatedFile: { artifactId: 'a1', fileName: 'page.html', editable: true, status: 'available' },
    };
    v2.afterRender(artifact);
    const editBtn = h.panelEl.querySelector('[data-artifact-panel-v2-edit]');
    assert.equal(editBtn.classList.contains('hidden'), true, 'html/code artifact: Edit must be hidden');
    assert.equal(editBtn.disabled, true, 'hidden Edit must also be disabled (defense in depth)');
  });

  test('image artifact: Edit button hidden', (t) => {
    const h = makeHarness(t, { flagOn: true });
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    v2.connect({ isSelectedArtifactMarkdownGenerated: () => false });
    const artifact = {
      id: 'img-1', sessionId: 's1', artifactType: 'image',
      image: { id: 'img-1', assetPath: 'C:/ws/pic.png' },
    };
    v2.afterRender(artifact);
    const editBtn = h.panelEl.querySelector('[data-artifact-panel-v2-edit]');
    assert.equal(editBtn.classList.contains('hidden'), true, 'image artifact: Edit must be hidden');
  });
});

describe('artifact panel v2 Copy button gating (Finding 1)', () => {
  test('image artifact: Copy is disabled (no source text exists)', (t) => {
    const h = makeHarness(t, { flagOn: true });
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    const artifact = {
      id: 'img-1', sessionId: 's1', artifactType: 'image',
      image: { id: 'img-1', assetPath: 'C:/ws/pic.png' },
    };
    v2.afterRender(artifact);
    const copyBtn = h.panelEl.querySelector('[data-artifact-panel-v2-copy]');
    assert.equal(copyBtn.disabled, true, 'image artifact: Copy must be disabled');
    assert.equal(copyBtn.getAttribute('aria-disabled'), 'true', 'image artifact: Copy must be aria-disabled');
  });

  test('generated file: Copy is enabled', (t) => {
    const h = makeHarness(t, { flagOn: true });
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    const artifact = {
      id: 'a1', sessionId: 's1', artifactType: 'generated_file',
      generatedFile: { artifactId: 'a1', fileName: 'x.html', editable: true, status: 'available' },
    };
    v2.afterRender(artifact);
    const copyBtn = h.panelEl.querySelector('[data-artifact-panel-v2-copy]');
    assert.equal(copyBtn.disabled, false, 'generated file: Copy must be enabled');
  });
});

describe('artifact panel v2 provenance popover', () => {
  test('opens from footer glyph, closes on Escape/outside click, entries only inside popover', (t) => {
    const h = makeHarness(t, { flagOn: true });
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    v2.bind();
    const artifact = {
      id: 'a1', sessionId: 's1', artifactType: 'generated_file', timestamp: '2026-01-01T00:00:00.000Z',
      generatedFile: { artifactId: 'a1', fileName: 'x.html', editable: true, status: 'available' },
    };
    v2.afterRender(artifact);
    const trigger = h.panelEl.querySelector('[aria-label="Provenance"]');
    assert.ok(trigger, 'provenance trigger should render');
    const popEl = h.panelEl.querySelector('.inv-popover');
    assert.ok(popEl, 'popover shell should render');
    assert.equal(popEl.hidden, true, 'closed by default');

    trigger.dispatchEvent(new h.doc.defaultView.Event('click', { bubbles: true }));
    assert.equal(popEl.hidden, false, 'opens on trigger click');

    // Provenance content must live inside the popover.
    const provenanceInPopover = popEl.querySelector('#artifactReviewProvenanceTimeline');
    assert.ok(provenanceInPopover, 'provenance timeline target lives inside the popover');
    assert.equal(h.panelEl.querySelector('#artifactReviewProvenanceTimeline'), provenanceInPopover, 'no duplicate provenance node outside the popover');

    // Escape closes.
    h.doc.dispatchEvent(new h.doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(popEl.hidden, true, 'Escape closes the popover');

    trigger.dispatchEvent(new h.doc.defaultView.Event('click', { bubbles: true }));
    assert.equal(popEl.hidden, false);
    // Outside click closes.
    h.doc.body.dispatchEvent(new h.doc.defaultView.Event('click', { bubbles: true }));
    assert.equal(popEl.hidden, true, 'outside click closes the popover');
  });
});

describe('artifact panel v2 footer meta', () => {
  test('shows kind + time for a generated file, omits unknown segments (no orphan dots)', (t) => {
    const h = makeHarness(t, { flagOn: true });
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    const artifact = {
      id: 'a1', sessionId: 's1', artifactType: 'generated_file', timestamp: '2026-01-01T00:00:00.000Z',
      generatedFile: { artifactId: 'a1', fileName: 'x.html', artifactKind: 'document', editable: true, status: 'available' },
    };
    v2.afterRender(artifact);
    const footerMeta = h.panelEl.querySelector('.artifact-panel-v2-footer-meta');
    assert.ok(footerMeta);
    const text = footerMeta.textContent.trim();
    assert.notEqual(text, '', 'footer meta should not be empty for a known artifact');
    assert.doesNotMatch(text, /·\s*·/, 'no orphan separators from omitted segments');
    assert.doesNotMatch(text, /^\s*·|·\s*$/, 'no leading/trailing separator');
  });
});

describe('artifact panel v2 empty state', () => {
  test('no selection: single "Select an artifact" line, no card markup', (t) => {
    const h = makeHarness(t, { flagOn: true });
    const v2 = createArtifactPanelV2({
      panelEl: h.panelEl, state: h.state, windowRef: h.doc.defaultView, escapeHtml, appendClientLog: h.appendClientLog,
    });
    v2.installed();
    const emptyEl = h.panelEl.querySelector('#artifactReviewDetailEmpty');
    assert.ok(emptyEl);
    assert.equal(emptyEl.querySelector('h3'), null, 'no h3 card heading in V2 empty state');
    assert.equal(emptyEl.querySelector('p'), null, 'no p card body in V2 empty state');
    assert.match(emptyEl.textContent.trim(), /^Select an artifact$/);
  });
});

describe('artifact panel v2 raw-html-primitives compliance', () => {
  test('module source has no raw button/input/select tags (even in comments)', () => {
    const source = readRepoFile('renderer/features/renderer-artifact-panel-v2-render.js');
    assert.doesNotMatch(source, /<button\b/i);
    assert.doesNotMatch(source, /<input\b/i);
    assert.doesNotMatch(source, /<select\b/i);
  });
});

describe('artifact panel v2 script registration', () => {
  test('index.html registers the module after its dependencies, before renderer-artifacts-utils.js', () => {
    const html = readRepoFile('index.html');
    const scriptTagIndex = (file) => html.indexOf(`<script defer src="${file}"></script>`);
    const v2Index = scriptTagIndex('renderer/features/renderer-artifact-panel-v2-render.js');
    const utilsIndex = scriptTagIndex('renderer/features/renderer-artifacts-utils.js');
    const versionHistoryIndex = scriptTagIndex('renderer/features/renderer-artifact-version-history-utils.js');
    const popoverIndex = scriptTagIndex('renderer/inventory/popover.js');
    assert.notEqual(v2Index, -1, 'index.html should register renderer-artifact-panel-v2-render.js');
    assert.ok(v2Index > versionHistoryIndex, 'must load after version-history-utils');
    assert.ok(v2Index > popoverIndex, 'must load after popover.js');
    assert.ok(v2Index < utilsIndex, 'must load before renderer-artifacts-utils.js');
  });

  test('test harness SCRIPT_ORDER includes the module in the same relative position', () => {
    const v2Index = SCRIPT_ORDER.indexOf('renderer/features/renderer-artifact-panel-v2-render.js');
    const utilsIndex = SCRIPT_ORDER.indexOf('renderer/features/renderer-artifacts-utils.js');
    assert.notEqual(v2Index, -1, 'SCRIPT_ORDER should include renderer-artifact-panel-v2-render.js');
    assert.notEqual(utilsIndex, -1, 'SCRIPT_ORDER should include renderer-artifacts-utils.js');
    assert.ok(v2Index < utilsIndex, 'V2 render must load before renderer-artifacts-utils.js');
  });
});
