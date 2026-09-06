'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createArtifactPanelV2 } = require('../renderer/features/renderer-artifact-panel-v2-render');
const segmentedControl = require('../renderer/inventory/segmented-control');
const anchoredListbox = require('../renderer/inventory/anchored-listbox');
const { createOverlayManager } = require('../renderer/shell/renderer-overlay-manager');
const { buildDownloadPayload, createArtifactPanelActions } = require('../renderer/features/renderer-artifact-panel-actions');
const { resolveArtifactViewCapabilities } = require('../renderer/features/renderer-artifact-view-capabilities');
const prefs = require('../renderer/features/renderer-artifact-review-prefs');
const artifactsUtils = require('../renderer/features/renderer-artifacts-utils');

const ARTIFACT_PANEL_CSS = fs.readFileSync(path.join(__dirname, '..', 'styles', 'artifact-panel.css'), 'utf8');
const ANCHORED_LISTBOX_CSS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'inventory', 'inventory-anchored-listbox.css'), 'utf8');
const INVENTORY_CSS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'inventory', 'inventory.css'), 'utf8');

function artifact(kind, id = kind, timestamp = '2026-08-17T12:00:00.000Z') {
  if (kind === 'image') return { id, sessionId: 's1', artifactType: 'image', timestamp, title: id };
  if (kind === 'text') return { id, sessionId: 's1', artifactType: 'tool_output', timestamp, title: id, outputText: 'hello' };
  const extensions = { markdown: 'md', mermaid: 'mmd', html: 'html', svg: 'svg', chart: 'chart.json', code: 'py' };
  return {
    id, sessionId: 's1', artifactType: 'generated_file', timestamp, title: id,
    generatedFile: { artifactId: id, fileName: `${id}.${extensions[kind]}`, language: kind === 'code' ? 'python' : kind, editable: true, status: 'available' },
  };
}

function makePanelHarness(t, initialArtifacts = []) {
  const dom = new JSDOM('<!doctype html><body><aside id="artifactReviewPanel"></aside></body>', { url: 'https://jenny.test/' });
  const panelEl = dom.window.document.getElementById('artifactReviewPanel');
  const state = {
    features: { featureFlags: { artifact_panel_v2: true, artifact_panel_v3: true } },
    artifacts: { loadedArtifactId: '', loadedArtifactContent: '', dirtyContent: '', viewModeByKind: {}, mermaidViewMode: 'preview', savePending: false },
    messagesBySession: new Map(),
  };
  const overlay = createOverlayManager({ documentRef: dom.window.document });
  dom.window.rendererOverlayManagerController = overlay;
  const controller = createArtifactPanelV2({ panelEl, state, windowRef: dom.window, appendClientLog: () => {}, showToastMessage: () => {} });
  assert.equal(controller.installed(), true);
  assert.ok(panelEl.querySelector('#artifactReviewDetailTitle'), 'surface bindings must exist in the initial V3 markup');
  controller.bind();
  segmentedControl.initSegmentedHandlers(dom.window.document);
  let artifacts = initialArtifacts;
  const modes = {};
  let documentMode = 'read';
  controller.connect({
    getArtifacts: () => artifacts,
    getSelectedArtifactSource: () => state.artifacts.dirtyContent || state.artifacts.loadedArtifactContent || 'source',
    getArtifactDocumentViewMode: () => documentMode,
    setArtifactDocumentViewMode: (_surface, value) => { documentMode = value; },
    getArtifactViewMode: (kind) => modes[kind] || 'preview',
    setArtifactViewMode: (kind, value) => { modes[kind] = value; },
  });
  t.after(() => { controller.dispose(); overlay.dispose(); });
  return { dom, panelEl, state, controller, modes, setArtifacts: (next) => { artifacts = next; }, getDocumentMode: () => documentMode };
}

describe('Artifact Panel V3 view capabilities and segmented control', () => {
  test('Canvas chrome owns the renamed icon and text button presentation', () => {
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-icon-btn \{[\s\S]*?width: 22px;[\s\S]*?height: 22px;/);
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-text-btn \{/);
  });

  test('the five dual-view kinds expose Preview and Code; code/image/text stay single-view', () => {
    for (const kind of ['markdown', 'mermaid', 'html', 'svg', 'chart']) {
      assert.deepEqual(resolveArtifactViewCapabilities(artifact(kind)), { hasPreview: true, hasCode: true, defaultView: 'preview', kind });
    }
    assert.equal(resolveArtifactViewCapabilities(artifact('code')).hasPreview, false);
    assert.equal(resolveArtifactViewCapabilities(artifact('image')).hasCode, false);
    assert.equal(resolveArtifactViewCapabilities(artifact('text')).hasPreview, false);
  });

  test('format words inside ordinary filenames remain generic code artifacts', () => {
    for (const fileName of ['html-parser.py', 'svg_tools.py', 'chart-notes.txt', 'mermaid-guide.txt']) {
      const result = resolveArtifactViewCapabilities({
        artifactType: 'generated_file',
        generatedFile: { fileName },
      });
      assert.deepEqual(result, { hasPreview: false, hasCode: true, defaultView: 'code', kind: 'code' }, fileName);
    }
  });

  test('Code maps to the existing edit/source tokens and no in-content toggle remains', (t) => {
    const selected = artifact('html');
    const h = makePanelHarness(t, [selected]);
    h.controller.afterRender(selected);
    const group = h.panelEl.querySelector('[data-inv-segmented="artifact-view"]');
    assert.ok(group);
    group.querySelector('[data-value="code"]').click();
    assert.equal(h.modes.html, 'edit');
    assert.equal(h.panelEl.querySelector('[data-artifact-view-kind]'), null);

    const markdown = artifact('markdown');
    h.setArtifacts([markdown]);
    h.controller.afterRender(markdown);
    h.panelEl.querySelector('[data-value="code"]').click();
    assert.equal(h.getDocumentMode(), 'source');

    for (const kind of ['code', 'image', 'text']) {
      const single = artifact(kind);
      h.setArtifacts([single]);
      h.controller.afterRender(single);
      assert.equal(h.panelEl.querySelector('[data-inv-segmented="artifact-view"]'), null, `${kind} must not render the segmented control`);
      if (kind === 'image') {
        assert.equal(h.panelEl.querySelector('[data-artifact-panel-download]').classList.contains('hidden'), true);
        assert.equal(h.panelEl.querySelector('[data-artifact-panel-v2-copy]').disabled, true);
      }
    }
  });

  test('unchanged chrome preserves focused control identity across incidental renders', (t) => {
    const selected = artifact('html');
    const h = makePanelHarness(t, [selected]);
    h.controller.afterRender(selected);
    const code = h.panelEl.querySelector('[data-value="code"]');
    code.focus();
    h.controller.afterRender(selected);
    assert.equal(h.panelEl.querySelector('[data-value="code"]'), code);
    assert.equal(h.dom.window.document.activeElement, code);
  });

  test('save feedback follows same-artifact save settlement only', (t) => {
    const first = artifact('code', 'first');
    const second = artifact('code', 'second');
    const h = makePanelHarness(t, [first, second]);
    const status = () => h.panelEl.querySelector('[data-artifact-save-state]').textContent;
    h.state.artifacts.loadedArtifactId = first.generatedFile.artifactId;
    h.state.artifacts.loadedArtifactContent = 'before';
    h.state.artifacts.dirtyContent = 'after';
    h.controller.afterRender(first);
    assert.equal(status(), 'Unsaved');
    h.state.artifacts.savePending = true;
    h.controller.afterRender(first);
    assert.equal(status(), 'Saving…');
    h.state.artifacts.savePending = false;
    h.state.artifacts.loadedArtifactContent = 'after';
    h.controller.afterRender(first);
    assert.equal(status(), 'Saved');

    h.state.artifacts.dirtyContent = 'reverted';
    h.controller.afterRender(first);
    assert.equal(status(), 'Unsaved');
    h.state.artifacts.loadedArtifactContent = 'reverted';
    h.controller.afterRender(first);
    assert.equal(status(), '', 'revert must not announce a save');

    h.state.artifacts.loadedArtifactId = second.generatedFile.artifactId;
    h.state.artifacts.loadedArtifactContent = 'clean';
    h.state.artifacts.dirtyContent = 'clean';
    h.controller.afterRender(second);
    assert.equal(status(), '', 'artifact navigation must reset save history');

    h.state.artifacts.dirtyContent = 'failed change';
    h.state.artifacts.savePending = true;
    h.controller.afterRender(second);
    h.state.artifacts.savePending = false;
    h.state.artifacts.lastError = 'save failed';
    h.controller.afterRender(second);
    assert.equal(status(), 'Unsaved', 'failed save remains unsaved');
  });

  test('empty state disables artifact-dependent controls and omits a kind glyph', (t) => {
    const h = makePanelHarness(t, []);
    h.controller.afterRender(null);
    for (const selector of ['[data-artifact-panel-v2-copy]', '[data-artifact-panel-download]', '[data-artifact-panel-overflow]', '#artifactPanelV2ProvenanceTrigger']) {
      assert.equal(h.panelEl.querySelector(selector).disabled, true, selector);
    }
    assert.equal(h.panelEl.querySelector('.artifact-panel-kind-glyph'), null);
  });
});

describe('Artifact Panel V3 switcher', () => {
  test('shared anchored listbox filters long lists and supports keyboard selection', (t) => {
    const dom = new JSDOM('<!doctype html><body><button id="anchor">Open</button></body>');
    const selected = [];
    const instance = anchoredListbox.createAnchoredListbox({
      documentRef: dom.window.document,
      id: 'inventory-list',
      items: Array.from({ length: 9 }, (_, index) => ({ id: String(index), value: index, label: `Artifact ${index}` })),
      onSelect: (value) => selected.push(value),
    });
    t.after(() => instance.destroy());
    const filter = instance.root.querySelector('input');
    assert.ok(filter, 'filter appears above eight items');
    filter.value = 'Artifact 8';
    filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(instance.list.querySelectorAll('[role="option"]').length, 1);
    filter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual(selected, [8]);
  });

  test('one artifact has a plain title; multiple artifacts open newest-first and selection closes', (t) => {
    const older = artifact('html', 'older', '2026-08-17T10:00:00.000Z');
    const newer = artifact('markdown', 'newer', '2026-08-17T11:00:00.000Z');
    const h = makePanelHarness(t, [older]);
    let selected = '';
    h.controller.connect({ getArtifacts: () => [older, newer], getSelectedArtifactSource: () => 'source', getArtifactViewMode: () => 'preview', selectArtifact: (id) => { selected = id; } });
    h.controller.afterRender(older);
    const trigger = h.panelEl.querySelector('[data-artifact-switcher-trigger]');
    assert.ok(trigger);
    trigger.click();
    const listbox = h.dom.window.document.getElementById('artifactPanelSwitcher');
    assert.ok(listbox);
    const rows = listbox.querySelectorAll('[role="option"]');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /newer/);
    rows[0].click();
    assert.equal(selected, 'newer');
    assert.equal(h.dom.window.document.getElementById('artifactPanelSwitcher'), null);
  });

  test('Escape closes through the overlay manager and restores title focus', (t) => {
    const one = artifact('html', 'one');
    const two = artifact('markdown', 'two', '2026-08-17T13:00:00.000Z');
    const h = makePanelHarness(t, [one, two]);
    h.controller.afterRender(one);
    const trigger = h.panelEl.querySelector('[data-artifact-switcher-trigger]');
    trigger.focus();
    trigger.click();
    h.dom.window.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(h.dom.window.document.getElementById('artifactPanelSwitcher'), null);
    assert.equal(h.dom.window.document.activeElement.id, 'artifactReviewDetailTitle');
  });

  test('rerendering an open switcher resets aria-expanded on the live trigger', (t) => {
    const one = artifact('html', 'one');
    const two = artifact('markdown', 'two');
    const h = makePanelHarness(t, [one, two]);
    h.controller.afterRender(one);
    h.panelEl.querySelector('[data-artifact-switcher-trigger]').click();
    h.controller.afterRender(one);
    const liveTrigger = h.panelEl.querySelector('[data-artifact-switcher-trigger]');
    assert.equal(liveTrigger.getAttribute('aria-expanded'), 'true');
    h.dom.window.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(liveTrigger.getAttribute('aria-expanded'), 'false');
    assert.equal(h.dom.window.document.activeElement, liveTrigger);
  });

  test('anchored listbox skips disabled rows and clamps its trusted presentation surface', (t) => {
    const dom = new JSDOM('<!doctype html><body><button id="anchor">Open</button></body>');
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 200 });
    Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 180 });
    const selected = [];
    const instance = anchoredListbox.createAnchoredListbox({
      documentRef: dom.window.document,
      id: 'disabled-list',
      width: 500,
      filterThreshold: 0,
      items: [
        { id: 'disabled-first', label: '<img src=x>', disabled: true },
        { id: 'first', label: 'Alpha', trustedGlyphHtml: '<svg data-safe-glyph></svg>' },
        { id: 'last', label: 'Beta', selected: true },
        { id: 'disabled-last', label: 'Zulu', disabled: true },
      ],
      onSelect: (value) => selected.push(value),
    });
    t.after(() => instance.destroy());
    instance.root.getBoundingClientRect = () => ({ width: 192, height: 172 });
    const anchor = dom.window.document.getElementById('anchor');
    anchor.getBoundingClientRect = () => ({ left: 190, bottom: 170, width: 500 });
    instance.position(anchor);
    assert.equal(instance.root.style.width, '192px');
    assert.ok(instance.root.querySelector('[data-safe-glyph]'));
    assert.equal(instance.root.querySelector('img'), null, 'labels stay text-only');
    assert.ok(instance.root.querySelector('input'), 'an explicit zero filter threshold is honored');

    const filter = instance.root.querySelector('input');
    filter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.match(instance.list.getAttribute('aria-activedescendant'), /option-1$/);
    filter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.match(instance.list.getAttribute('aria-activedescendant'), /option-2$/);
    instance.list.querySelector('[data-inv-listbox-index="0"]').click();
    assert.deepEqual(selected, []);

    const typeahead = anchoredListbox.createAnchoredListbox({
      documentRef: dom.window.document,
      id: 'typeahead-list',
      filterThreshold: 99,
      items: [{ id: 'disabled-alpha', label: 'Alpha', disabled: true }, { id: 'alpine', label: 'Alpine' }],
    });
    t.after(() => typeahead.destroy());
    typeahead.list.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'A', bubbles: true }));
    assert.match(typeahead.list.getAttribute('aria-activedescendant'), /option-1$/);
  });

  test('managed listbox uses the overlay tier and viewport-bounded height', () => {
    assert.match(ANCHORED_LISTBOX_CSS, /z-index:\s*calc\(var\(--z-overlay\) \+ 6\)/);
    assert.match(ANCHORED_LISTBOX_CSS, /max-height:\s*min\(320px, calc\(100vh - 8px\)\)/);
  });
});

describe('Artifact Panel V3 actions', () => {
  test('download payloads preserve source and choose markdown, JSON, or the real extension', () => {
    assert.deepEqual(buildDownloadPayload(artifact('markdown', 'notes'), '# hi', (v) => v), {
      format: 'markdown', filters: [{ name: 'Markdown', extensions: ['md'] }], defaultName: 'notes.md', content: '# hi',
    });
    const jsonTool = { id: 'tool', artifactType: 'tool_output', title: 'Result' };
    assert.equal(buildDownloadPayload(jsonTool, '{"ok":true}').format, 'json');
    const py = buildDownloadPayload(artifact('code', 'script'), 'print(1)', () => 'Python');
    assert.deepEqual(py.filters, [{ name: 'Python', extensions: ['py'] }]);
    assert.equal(py.content, 'print(1)');
    const unsafeName = artifact('code', 'unsafe');
    unsafeName.generatedFile.fileName = '../unsafe.py';
    assert.equal(buildDownloadPayload(unsafeName, 'pass').defaultName, '-unsafe.py');
    assert.equal(buildDownloadPayload(artifact('image'), 'binary'), null);
  });

  test('cancellation has no success toast; missing bridge is logged and generic', async (t) => {
    const dom = new JSDOM('<!doctype html><body><div id="panel"></div></body>');
    const panel = dom.window.document.getElementById('panel');
    const toasts = [];
    const logs = [];
    dom.window.jennyShell = { dialog: { saveFile: async () => ({ canceled: true }) } };
    const actions = createArtifactPanelActions({
      panelEl: panel, windowRef: dom.window, getArtifactSource: () => 'x',
      showToastMessage: (...args) => toasts.push(args), appendClientLog: (...args) => logs.push(args),
    });
    await actions.download(artifact('code'));
    assert.equal(toasts.length, 0);
    delete dom.window.jennyShell;
    await actions.download(artifact('code'));
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][0], 'Export failed. Try again.');
    assert.equal(logs.at(-1)[1], 'artifacts.download_bridge_unavailable');
    t.after(() => {});
  });

  test('download is single-flight and produces no late effects after disposal', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="panel"></div></body>');
    let settle;
    let calls = 0;
    const toasts = [];
    const logs = [];
    dom.window.jennyShell = { dialog: { saveFile: () => { calls += 1; return new Promise((resolve) => { settle = resolve; }); } } };
    const actions = createArtifactPanelActions({
      panelEl: dom.window.document.getElementById('panel'), windowRef: dom.window,
      getArtifactSource: () => 'x', showToastMessage: (...args) => toasts.push(args), appendClientLog: (...args) => logs.push(args),
    });
    const first = actions.download(artifact('code'));
    const second = actions.download(artifact('code'));
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    actions.dispose();
    settle({ canceled: false, path: 'C:\\tmp\\artifact.py', bytesWritten: 1 });
    await first;
    assert.deepEqual(toasts, []);
    assert.deepEqual(logs, []);
  });

  test('malformed and failed downloads degrade with bounded redacted diagnostics', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="panel"></div></body>');
    const toasts = [];
    const logs = [];
    let response = {};
    dom.window.jennyShell = { dialog: { saveFile: () => response instanceof Error ? Promise.reject(response) : Promise.resolve(response) } };
    const actions = createArtifactPanelActions({
      panelEl: dom.window.document.getElementById('panel'), windowRef: dom.window,
      getArtifactSource: () => 'x', showToastMessage: (...args) => toasts.push(args), appendClientLog: (...args) => logs.push(args),
    });
    await actions.download(artifact('code'));
    assert.equal(logs.at(-1)[1], 'artifacts.download_invalid_result');
    assert.equal(toasts.at(-1)[0], 'Export failed. Try again.');
    response = new Error('failed at C:\\private\\artifact.py token=sk-abcdefghijk');
    await actions.download(artifact('code'));
    assert.equal(toasts.at(-1)[0], 'Export failed. Try again.');
    const message = logs.at(-1)[2].message;
    assert.ok(message.length <= 160);
    assert.doesNotMatch(message, /C:\\private|sk-abcdefghijk/);
    actions.dispose();
  });

  test('disposing actions closes only its open overflow menu', () => {
    const dom = new JSDOM('<!doctype html><body><div id="panel"><button id="trigger"></button></div></body>');
    const panel = dom.window.document.getElementById('panel');
    const trigger = dom.window.document.getElementById('trigger');
    const actions = createArtifactPanelActions({ panelEl: panel, windowRef: dom.window });
    assert.equal(actions.showOverflow(artifact('code'), trigger), true);
    assert.ok(dom.window.document.querySelector('.inv-context-menu'));
    actions.dispose();
    assert.equal(dom.window.document.querySelector('.inv-context-menu'), null);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  });

  test('overflow actions dispatch to the hidden legacy buttons', (t) => {
    const current = { ...artifact('html'), sourceMessageId: 'message-1' };
    const h = makePanelHarness(t, [current]);
    const calls = [];
    h.controller.afterRender(current);
    for (const [id, name] of [['artifactReviewRevealButton', 'reveal'], ['artifactReviewOpenExternalButton', 'open'], ['artifactReviewJumpButton', 'jump'], ['artifactReviewDeleteButton', 'delete']]) {
      h.panelEl.querySelector('#' + id).addEventListener('click', () => calls.push(name));
    }
    h.panelEl.querySelector('[data-artifact-panel-overflow]').click();
    const menuItems = [...h.dom.window.document.querySelectorAll('.inv-context-menu-item')];
    menuItems.find((node) => node.textContent === 'Delete artifact').click();
    assert.deepEqual(calls, ['delete']);
  });

  test('overflow disables delete for image and tool-output artifacts', (t) => {
    for (const current of [artifact('image'), artifact('text')]) {
      const h = makePanelHarness(t, [current]);
      h.controller.afterRender(current);
      h.panelEl.querySelector('[data-artifact-panel-overflow]').click();
      const deleteItem = [...h.dom.window.document.querySelectorAll('.inv-context-menu-item')]
        .find((node) => node.textContent === 'Delete artifact');
      assert.equal(deleteItem.disabled, true, current.artifactType);
    }
  });

  test('maximize is a no-op in overlay mode', () => {
    const dom = new JSDOM('<!doctype html><body><aside id="panel" class="artifact-review-overlay"></aside></body>');
    let calls = 0;
    const actions = createArtifactPanelActions({
      panelEl: dom.window.document.getElementById('panel'),
      windowRef: dom.window,
      toggleMaximize: () => { calls += 1; return true; },
    });
    assert.equal(actions.toggleMaximize(), false);
    assert.equal(calls, 0);
  });
});

describe('Artifact Panel V3 maximized preferences and layout', () => {
  // Owner restyle 2026-08-20 (Option A): the diff/text viewer is FULL BLEED —
  // the half-rounded floating frame (1px border + top-only radius + inset
  // fill) and the wrapping content padding are gone; only the toolbar's
  // bottom hairline survives.
  test('tool output renders full bleed with the semantic diff token contract', () => {
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-output-viewer \{[\s\S]*?grid-template-rows: 32px minmax\(0, 1fr\);[\s\S]*?border: 0;[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/);
    const viewerBlock = ARTIFACT_PANEL_CSS.match(/\.artifact-output-viewer \{[^}]*\}/);
    assert.ok(viewerBlock, 'the viewer rule must exist');
    assert.doesNotMatch(viewerBlock[0], /border-radius: var\(--radius-sm\)|border: 1px|background: color-mix/, 'no frame, no inset fill');
    assert.match(
      ARTIFACT_PANEL_CSS,
      /\.artifact-panel-v3 \.artifact-panel-v2-content-host \.artifact-preview-content:has\(\.artifact-output-viewer\) \{[\s\S]*?padding: 0;/,
      'the wrapping content padding is removed for the output viewer case'
    );
    assert.match(
      ARTIFACT_PANEL_CSS,
      /\.artifact-output-toolbar \{[\s\S]*?border-bottom: 1px solid color-mix\(in srgb, var\(--border-default\) 72%, transparent\);/,
      'the toolbar keeps its bottom hairline'
    );
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-output-body \{[\s\S]*?overflow: auto;/, 'scrolling stays on the body');
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-output-line--add,[\s\S]*?var\(--widget-tool-success-color\) 9%/);
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-output-line--remove,[\s\S]*?var\(--widget-tool-error-color\) 9%/);
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-output-line--hunk,[\s\S]*?var\(--accent-cyan\) 7%/);
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-output-body \.diff-line-add \.diff-content \{ color: color-mix\(in srgb, var\(--widget-tool-success-color\) 76%/);
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-output-body \.diff-line-remove \.diff-content \{ color: color-mix\(in srgb, var\(--widget-tool-error-color\) 76%/);
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-output-viewer\.is-wrapped \.diff-hunk \{ min-width: 0; \}/);
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-panel-v3 \.artifact-panel-v2-scroll:has\(\.artifact-output-viewer\) \{ overflow: hidden; \}/);
  });

  // Owner report 2026-08-20 follow-up: the OTHER artifact body shells (code
  // editor, plain-text pre, web/chart/image/mermaid) still carried the 24px
  // studio-card chrome from views-artifacts.css inside the rail. In the panel
  // they are the body, not a card. The legacy Artifacts view keeps its look —
  // the override is panel-scoped, never global.
  test('every artifact body shell renders full bleed inside the panel', () => {
    const flatBlock = ARTIFACT_PANEL_CSS.match(
      /\.artifact-review-panel \.artifact-editor-shell,[\s\S]*?\.artifact-review-panel \.artifact-preview-mermaid-shell \{[^}]*\}/
    );
    assert.ok(flatBlock, 'the panel-scoped shell flattening block exists');
    assert.match(flatBlock[0], /border-radius: 0;/);
    assert.match(flatBlock[0], /border: 0;/);
    assert.match(flatBlock[0], /background: transparent;/);
    assert.match(flatBlock[0], /box-shadow: none;/);
    for (const shell of [
      'artifact-preview-pre', 'artifact-preview-web-shell', 'artifact-preview-chart-host',
      'artifact-preview-image-shell', 'artifact-image-shell',
    ]) {
      assert.ok(flatBlock[0].includes(`.artifact-review-panel .${shell}`), `${shell} is covered`);
    }
    assert.match(
      ARTIFACT_PANEL_CSS,
      /\.artifact-review-panel \.artifact-preview-mermaid-host \.mermaid-viewport svg \{ border-radius: 0; \}/,
      'the mermaid diagram squares off but keeps its own fill'
    );
    assert.match(
      ARTIFACT_PANEL_CSS,
      /\.artifact-panel-v3 \.artifact-panel-v2-content-host \.artifact-preview-content:has\(\.artifact-preview-pre\) \{[\s\S]*?padding: 0;/,
      'text-like bodies drop the wrapping padding like the output viewer'
    );
  });

  // Owner request 2026-08-20: one wrap toggle for every text body (parity with
  // the tool-output viewer's inline control). Non-editor bodies flip through
  // the panel-level class; Monaco flips through setWordWrap.
  test('the panel-level nowrap class flips every non-editor text body', () => {
    assert.match(
      ARTIFACT_PANEL_CSS,
      /\.artifact-file-preview-row > code \{[\s\S]*?white-space: pre-wrap;[\s\S]*?overflow-wrap: anywhere;/,
      'the file-preview list wraps by default, matching the other text bodies'
    );
    assert.match(
      ARTIFACT_PANEL_CSS,
      /\.artifact-review-panel\.artifact-panel-nowrap \.artifact-file-preview-row > code \{[\s\S]*?white-space: pre;/,
      'nowrap flips the file-preview list'
    );
    assert.match(
      ARTIFACT_PANEL_CSS,
      /\.artifact-review-panel\.artifact-panel-nowrap \.artifact-preview-pre \{[\s\S]*?white-space: pre;[\s\S]*?overflow-x: auto;/,
      'nowrap flips the read-only source pre and scrolls horizontally'
    );
  });

  test('maximized map normalizes, persists, and prunes removed sessions', () => {
    const value = prefs.normalizeArtifactReviewPreferences({ maximizedBySession: { a: true, b: false, '': true } });
    assert.deepEqual(value.maximizedBySession, { a: true });
    prefs.recordArtifactReviewMaximized(value, 'b', true, { flagOn: true });
    assert.equal(prefs.resolveArtifactReviewMaximized(value, 'b', { flagOn: true }), true);
    prefs.pruneArtifactReviewSessionPreferences(value, ['b']);
    assert.deepEqual(value.maximizedBySession, { b: true });
    assert.equal(prefs.resolveArtifactReviewMaximized(value, 'b', { flagOn: false }), false);
  });

  test('maximize stamps the chat view per session, Escape restores, and narrow width stamps is-narrow', (t) => {
    const dom = new JSDOM('<!doctype html><body><div id="workspace"><section id="chat"><div id="resizer"></div><aside id="panel"></aside></section></div></body>', { url: 'https://jenny.test/' });
    const previousWindow = globalThis.window;
    globalThis.window = dom.window;
    t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
    dom.window.localStorage.setItem('jenny.artifactReview.v1', JSON.stringify({ enabled: true, width: 340 }));
    const active = { id: 's1' };
    const state = { ui: { activeView: 'chat', artifactReview: {} }, artifacts: { autoOpenedSessionIds: [], deletedArtifactIds: [], viewModeByKind: {} }, messagesBySession: new Map(), features: { featureFlags: { artifact_panel_v2: true, artifact_panel_v3: true } } };
    const workspace = dom.window.document.getElementById('workspace');
    workspace.getBoundingClientRect = () => ({ width: 1400 });
    const chatView = dom.window.document.getElementById('chat');
    const panel = dom.window.document.getElementById('panel');
    const resizer = dom.window.document.getElementById('resizer');
    const manager = artifactsUtils.createArtifactManager({ state, dom: { workspace, chatView, artifactReviewPanel: panel, artifactReviewResizer: resizer }, callbacks: { getActiveSession: () => ({ id: active.id }), updateComposerSafeOffset: () => {}, renderAll: () => {}, escapeHtml: String, appendClientLog: () => {}, showToastMessage: () => {} } });
    manager.bind();
    t.after(() => manager.dispose());
    assert.equal(panel.classList.contains('is-narrow'), true);
    assert.match(ARTIFACT_PANEL_CSS, /\.artifact-review-panel\.is-narrow \.artifact-panel-copy,[\s\S]*?\.artifact-panel-download \{ display: none; \}/);
    assert.doesNotMatch(ARTIFACT_PANEL_CSS, /\.inv-context-menu-item--danger/);
    assert.match(INVENTORY_CSS, /\.inv-context-menu-item--danger\s*\{/);
    manager.toggleArtifactReviewMaximized(true);
    assert.equal(chatView.classList.contains('artifact-review-maximized'), true);
    active.id = 's2';
    manager.syncArtifactReviewLayout();
    assert.equal(chatView.classList.contains('artifact-review-maximized'), false);
    active.id = 's1';
    manager.syncArtifactReviewLayout();
    assert.equal(chatView.classList.contains('artifact-review-maximized'), true);
    panel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(chatView.classList.contains('artifact-review-maximized'), false);
    state.features.featureFlags.artifact_panel_v3 = false;
    assert.equal(manager.toggleArtifactReviewMaximized(true), false, 'flag-off calls report the applied state');
    state.features.featureFlags.artifact_panel_v3 = true;
    active.id = '';
    assert.equal(manager.toggleArtifactReviewMaximized(true), false, 'missing-session calls cannot report success');
  });
});

test('artifact_panel_v3 false preserves V2 chrome byte-for-byte', () => {
  function render(flags) {
    const dom = new JSDOM('<!doctype html><body><aside id="p"></aside></body>');
    const panel = dom.window.document.getElementById('p');
    const controller = createArtifactPanelV2({ panelEl: panel, state: { features: { featureFlags: flags }, artifacts: {}, messagesBySession: new Map() }, windowRef: dom.window });
    controller.installed();
    return panel.innerHTML;
  }
  assert.equal(render({ artifact_panel_v2: true, artifact_panel_v3: false }), render({ artifact_panel_v2: true }));
});
