const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('artifacts manager delegates selected-artifact surface work to a focused controller', () => {
  const managerSource = readRepoFile('renderer/features/renderer-artifacts-utils.js');
  const controllerSource = readRepoFile('renderer/features/renderer-artifacts-surface-controller.js');

  assert.match(
    managerSource,
    /require\('\.\/renderer-artifacts-surface-controller'\)/,
    'artifacts manager should load the focused surface controller'
  );
  assert.doesNotMatch(
    managerSource,
    /function renderSelectedArtifactDetail\(/,
    'selected artifact detail rendering should not remain in the manager'
  );
  assert.doesNotMatch(
    managerSource,
    /async function loadGeneratedArtifactContent\(/,
    'generated artifact content loading should not remain in the manager'
  );
  assert.match(
    controllerSource,
    /function createArtifactSurfaceController\(/,
    'surface controller should expose a focused factory'
  );
  assert.match(
    controllerSource,
    /renderSelectedArtifactDetail/,
    'surface controller should own selected artifact detail rendering'
  );
  assert.match(
    controllerSource,
    /loadGeneratedArtifactContent/,
    'surface controller should own generated artifact content loading'
  );
});

/* ── WS2: registry dispatch parity (flag-off byte-identical, flag-on same output) ── */

const { JSDOM } = require('jsdom');
const projection = require('../renderer/features/renderer-artifacts-projection.js');
const artifactRender = require('../renderer/features/renderer-artifacts-render.js');
const { createArtifactSurfaceController } = require('../renderer/features/renderer-artifacts-surface-controller.js');

function makeParityHarness(t, { registryEnabled }) {
  const dom = new JSDOM('<body></body>');
  const doc = dom.window.document;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  });

  const el = (tag = 'div') => {
    const node = doc.createElement(tag);
    doc.body.appendChild(node);
    return node;
  };
  const surface = {
    key: 'full',
    detailEmpty: el(), detailPanel: el(), detailKicker: el(), detailTitle: el(),
    detailPath: el(), detailStatus: el(), detailMeta: el(), detailNote: el(),
    previewContent: el(), editorShell: el(), editorHost: el(), editorFallback: el(),
    saveButton: el(), revertButton: el(), revealButton: el(), openExternalButton: el(),
    deleteButton: el(), jumpButton: el(), provenanceTimeline: el(), metaPane: el(),
    dirtyBadge: el(), stackedMeta: false,
  };
  const state = {
    artifacts: {
      mermaidViewMode: 'preview',
      loading: false,
      lastError: '',
      loadedArtifactId: 'artifact-1',
      loadedArtifactContent: '',
      dirtyContent: '',
      savePending: false,
    },
    features: { featureFlags: { artifact_renderer_registry: registryEnabled === true } },
  };
  const controller = createArtifactSurfaceController({
    state,
    surfaces: { full: surface, split: surface },
    artifactRender,
    renderMermaidPreviewIntoHost: () => true,
    escapeHtml: (value) => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    getSelectedArtifact: () => null,
    getArtifactReviewState: () => ({}),
    isGeneratedFile: projection.isGeneratedFile,
    isImageArtifact: projection.isImageArtifact,
    isMarkdownGeneratedArtifact: projection.isMarkdownGeneratedArtifact,
    isMermaidGeneratedArtifact: projection.isMermaidGeneratedArtifact,
    isHtmlGeneratedArtifact: projection.isHtmlGeneratedArtifact,
    isSvgGeneratedArtifact: projection.isSvgGeneratedArtifact,
    isChartGeneratedArtifact: projection.isChartGeneratedArtifact,
    extractMermaidSourceFromToolArtifact: projection.extractMermaidSourceFromToolArtifact,
    prettyPrintJson: projection.prettyPrintJson,
    formatArtifactTimestamp: projection.formatArtifactTimestamp,
    formatArtifactStatus: projection.formatArtifactStatus,
    formatLanguageLabel: projection.formatLanguageLabel,
  });
  return { controller, surface, state };
}

function snapshotSurface(surface) {
  return {
    previewHTML: surface.previewContent.innerHTML,
    previewHidden: surface.previewContent.classList.contains('hidden'),
    editorHidden: surface.editorShell.classList.contains('hidden'),
    note: surface.detailNote.textContent,
    noteError: surface.detailNote.classList.contains('detail-note-error'),
    kicker: surface.detailKicker.textContent,
    detailMode: surface.detailPanel.dataset.detailMode || '',
    provenance: surface.provenanceTimeline.innerHTML,
  };
}

test('surface controller rebinds the live V3 title and writes only its text child', (t) => {
  const harness = makeParityHarness(t, { registryEnabled: false });
  const doc = harness.surface.detailTitle.ownerDocument;
  const root = doc.createElement('aside');
  root.innerHTML = '<button id="artifactReviewDetailTitle"><span class="artifact-panel-title-text">Old</span><span data-chevron>v</span></button>';
  doc.body.appendChild(root);
  harness.surface.root = root;
  const artifact = { id: 'tool-1', sessionId: 's1', artifactType: 'tool_output', title: 'Live title', outputText: 'ok', status: 'available' };

  harness.controller.renderSelectedArtifactDetail(harness.surface, artifact);
  const firstLive = root.querySelector('#artifactReviewDetailTitle');
  assert.equal(harness.surface.detailTitle, firstLive);
  assert.equal(firstLive.querySelector('.artifact-panel-title-text').textContent, 'Live title');
  assert.ok(firstLive.querySelector('[data-chevron]'), 'chrome children survive the surface write');

  root.innerHTML = '<button id="artifactReviewDetailTitle"><span class="artifact-panel-title-text">Replacement</span><span data-chevron>v</span></button>';
  artifact.title = 'Rebound title';
  harness.controller.renderSelectedArtifactDetail(harness.surface, artifact);
  assert.equal(harness.surface.detailTitle, root.querySelector('#artifactReviewDetailTitle'));
  assert.equal(root.querySelector('.artifact-panel-title-text').textContent, 'Rebound title');
});

function generatedArtifactFixture(file, overrides = {}) {
  return {
    id: 'artifact-1',
    artifactType: 'generated_file',
    title: 'Fixture artifact',
    timestamp: '2026-07-01T12:00:00.000Z',
    status: 'available',
    sourceMessageId: 'msg-1',
    generatedFile: {
      artifactId: 'artifact-1',
      artifactKind: 'document',
      fileName: 'fixture',
      displayPath: '.jenny/artifacts/s1/fixture',
      editable: true,
      status: 'available',
      ...file,
    },
    ...overrides,
  };
}

const PARITY_FIXTURES = [
  ['mermaid generated', generatedArtifactFixture({ language: 'mermaid', fileName: 'd.mmd' }), 'flowchart TD\n  A-->B'],
  ['markdown generated', generatedArtifactFixture({ language: 'markdown', fileName: 'n.md', isMarkdownDocument: true }), '# Title\n\nBody text.'],
  ['code generated', generatedArtifactFixture({ language: 'python', fileName: 'main.py' }), 'print(1)'],
  ['image', {
    id: 'img-1', artifactType: 'image', title: 'Image', timestamp: '2026-07-01T12:00:00.000Z',
    status: 'available', sourceMessageId: 'msg-2',
    image: { id: 'img-1', displayName: 'Image', mimeType: 'image/png', assetPath: 'C:/ws/.jenny/artifacts/s1/pic.png', width: 10, height: 10, sourceKind: 'capture' },
  }, ''],
  ['tool output text', {
    id: 'tool-1', artifactType: 'tool_output', title: 'Tool', timestamp: '2026-07-01T12:00:00.000Z',
    status: 'completed', sourceMessageId: 'msg-3',
    tool: { callId: 'c1', toolName: 'run_command', summary: 'ran', isError: false },
    outputText: 'hello output',
  }, ''],
  ['tool output mermaid', {
    id: 'tool-2', artifactType: 'tool_output', title: 'Mermaid tool', timestamp: '2026-07-01T12:00:00.000Z',
    status: 'completed', sourceMessageId: 'msg-4',
    tool: { callId: 'c2', toolName: 'mermaid_generate', summary: 'drew', isError: false },
    outputText: 'flowchart TD\n  A-->B',
  }, ''],
];

for (const [label, artifact, content] of PARITY_FIXTURES) {
  test(`WS2 parity: ${label} renders identically with artifact_renderer_registry off and on`, (t) => {
    const off = makeParityHarness(t, { registryEnabled: false });
    off.state.artifacts.dirtyContent = content;
    off.state.artifacts.loadedArtifactContent = content;
    off.controller.renderSelectedArtifactDetail(off.surface, artifact);
    const offSnapshot = snapshotSurface(off.surface);

    const on = makeParityHarness(t, { registryEnabled: true });
    on.state.artifacts.dirtyContent = content;
    on.state.artifacts.loadedArtifactContent = content;
    on.controller.renderSelectedArtifactDetail(on.surface, artifact);
    const onSnapshot = snapshotSurface(on.surface);

    assert.deepEqual(onSnapshot, offSnapshot, `registry-on output diverged for ${label}`);
    assert.ok(offSnapshot.previewHTML.length + offSnapshot.note.length > 0, 'fixture rendered nothing at all');
  });
}

test('WS2: flag ON routes an html artifact through the sanitized web kind (additive)', (t) => {
  const artifact = generatedArtifactFixture({ language: 'html', fileName: 'page.html' });
  const content = '<div class="ok">safe</div><script>alert(1)</script><img src=x onerror="alert(1)">';

  const off = makeParityHarness(t, { registryEnabled: false });
  off.state.artifacts.dirtyContent = content;
  off.state.artifacts.loadedArtifactContent = content;
  off.controller.renderSelectedArtifactDetail(off.surface, artifact);
  // Legacy: html files hit the generic code/editor branch.
  assert.equal(off.surface.editorShell.classList.contains('hidden'), false);
  assert.equal(off.surface.previewContent.classList.contains('hidden'), true);

  const on = makeParityHarness(t, { registryEnabled: true });
  on.state.artifacts.dirtyContent = content;
  on.state.artifacts.loadedArtifactContent = content;
  on.controller.renderSelectedArtifactDetail(on.surface, artifact);
  const html = on.surface.previewContent.innerHTML;
  assert.ok(html.includes('artifact-preview-web-shell'), `web shell missing: ${html}`);
  assert.ok(html.includes('safe'), `sanitized content missing: ${html}`);
  assert.ok(!html.includes('<script'), `script survived sanitize: ${html}`);
  assert.ok(!html.includes('onerror'), `event handler survived sanitize: ${html}`);
});

test('Artifact Panel V3 removes in-content view toggles while V3 rollback preserves them', (t) => {
  const mermaid = generatedArtifactFixture({ language: 'mermaid', fileName: 'diagram.mmd' });
  const harness = makeParityHarness(t, { registryEnabled: true });
  harness.state.artifacts.dirtyContent = 'flowchart TD\n  A-->B';
  harness.state.artifacts.loadedArtifactContent = harness.state.artifacts.dirtyContent;
  harness.state.features.featureFlags.artifact_panel_v3 = true;
  harness.controller.renderSelectedArtifactDetail(harness.surface, mermaid);
  assert.equal(harness.surface.previewContent.querySelector('[data-artifact-mermaid-mode]'), null);

  harness.state.features.featureFlags.artifact_panel_v3 = false;
  harness.controller.renderSelectedArtifactDetail(harness.surface, mermaid);
  assert.ok(harness.surface.previewContent.querySelector('[data-artifact-mermaid-mode]'));
});

test('WS2: setArtifactViewMode round-trips viewModeByKind and keeps the mermaidViewMode alias synced', (t) => {
  const harness = makeParityHarness(t, { registryEnabled: true });
  const { controller, state } = harness;
  assert.equal(controller.getArtifactViewMode('html'), 'preview');
  controller.setArtifactViewMode('html', 'edit');
  assert.equal(controller.getArtifactViewMode('html'), 'edit');
  assert.equal(state.artifacts.viewModeByKind.html, 'edit');
  // junk normalizes to preview
  controller.setArtifactViewMode('html', 'bogus');
  assert.equal(controller.getArtifactViewMode('html'), 'preview');
  // mermaid alias stays synced both directions
  controller.setArtifactViewMode('mermaid', 'edit');
  assert.equal(state.artifacts.mermaidViewMode, 'edit');
  assert.equal(controller.getArtifactViewMode('mermaid'), 'edit');
  state.artifacts.mermaidViewMode = 'preview';
  assert.equal(controller.getArtifactViewMode('mermaid'), 'preview');
  // reset clears the per-kind map
  controller.setArtifactViewMode('svg', 'edit');
  controller.resetLoadedState();
  assert.deepEqual(state.artifacts.viewModeByKind, {});
  assert.equal(state.artifacts.mermaidViewMode, 'preview');
});

/* ── Finding 1: toolbar Copy resolves the artifact's full source text ── */

function makeCopyHarness(t, { selectedArtifact, registryEnabled = false } = {}) {
  const dom = new JSDOM('<body></body>');
  const doc = dom.window.document;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  // Node's built-in `navigator` global is a non-writable accessor, so
  // reassigning globalThis.navigator silently no-ops; stub the clipboard
  // property on the existing navigator object instead.
  const previousClipboard = globalThis.navigator?.clipboard;
  globalThis.document = doc;
  globalThis.window = dom.window;
  const writeTextCalls = [];
  const clipboard = {
    writeText: async (text) => { writeTextCalls.push(text); },
  };
  Object.defineProperty(globalThis.navigator, 'clipboard', { value: clipboard, configurable: true });
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    if (previousClipboard === undefined) {
      delete globalThis.navigator.clipboard;
    } else {
      Object.defineProperty(globalThis.navigator, 'clipboard', { value: previousClipboard, configurable: true });
    }
  });
  const el = (tag = 'div') => {
    const node = doc.createElement(tag);
    doc.body.appendChild(node);
    return node;
  };
  const surface = {
    key: 'full',
    detailEmpty: el(), detailPanel: el(), detailKicker: el(), detailTitle: el(),
    detailPath: el(), detailStatus: el(), detailMeta: el(), detailNote: el(),
    previewContent: el(), editorShell: el(), editorHost: el(), editorFallback: el(),
    saveButton: el(), revertButton: el(), revealButton: el(), openExternalButton: el(),
    deleteButton: el(), jumpButton: el(), provenanceTimeline: el(), metaPane: el(),
    dirtyBadge: el(), stackedMeta: false,
  };
  const toasts = [];
  const state = {
    artifacts: {
      mermaidViewMode: 'preview',
      loading: false,
      lastError: '',
      loadedArtifactId: '',
      loadedArtifactContent: '',
      dirtyContent: '',
      savePending: false,
    },
    features: { featureFlags: { artifact_renderer_registry: registryEnabled === true } },
  };
  const controller = createArtifactSurfaceController({
    state,
    surfaces: { full: surface, split: surface },
    artifactRender,
    renderMermaidPreviewIntoHost: () => true,
    escapeHtml: (value) => String(value ?? ''),
    showToastMessage: (message) => toasts.push(message),
    getSelectedArtifact: () => selectedArtifact,
    getArtifactReviewState: () => ({}),
    isGeneratedFile: projection.isGeneratedFile,
    isImageArtifact: projection.isImageArtifact,
    isMarkdownGeneratedArtifact: projection.isMarkdownGeneratedArtifact,
    isMermaidGeneratedArtifact: projection.isMermaidGeneratedArtifact,
    isHtmlGeneratedArtifact: projection.isHtmlGeneratedArtifact,
    isSvgGeneratedArtifact: projection.isSvgGeneratedArtifact,
    isChartGeneratedArtifact: projection.isChartGeneratedArtifact,
    extractMermaidSourceFromToolArtifact: projection.extractMermaidSourceFromToolArtifact,
    prettyPrintJson: projection.prettyPrintJson,
    formatArtifactTimestamp: projection.formatArtifactTimestamp,
    formatArtifactStatus: projection.formatArtifactStatus,
    formatLanguageLabel: projection.formatLanguageLabel,
  });
  return { controller, state, writeTextCalls, toasts };
}

test('copySelectedArtifactSource: dirty generated file copies the dirty (preferred editor) text', async (t) => {
  const artifact = generatedArtifactFixture({ language: 'html', fileName: 'page.html' }, { id: 'artifact-1' });
  const { controller, state, writeTextCalls } = makeCopyHarness(t, { selectedArtifact: artifact });
  state.artifacts.loadedArtifactId = 'artifact-1';
  state.artifacts.loadedArtifactContent = 'original source';
  state.artifacts.dirtyContent = 'edited source';
  await controller.copySelectedArtifactSource();
  assert.deepEqual(writeTextCalls, ['edited source'], 'Copy must write the dirty text, not the loaded text');
});

test('copySelectedArtifactSource: mermaid tool output copies the extracted mermaid source', async (t) => {
  const artifact = {
    id: 'tool-2', artifactType: 'tool_output', title: 'Mermaid tool', timestamp: '2026-07-01T12:00:00.000Z',
    status: 'completed', sourceMessageId: 'msg-4',
    tool: { callId: 'c2', toolName: 'mermaid_generate', summary: 'drew', isError: false },
    outputText: 'flowchart TD\n  A-->B',
  };
  const { controller, writeTextCalls } = makeCopyHarness(t, { selectedArtifact: artifact });
  await controller.copySelectedArtifactSource();
  assert.deepEqual(writeTextCalls, ['flowchart TD\n  A-->B'], 'Copy must write the mermaid source for a mermaid tool output');
});

test('copySelectedArtifactSource: image artifact writes nothing to the clipboard', async (t) => {
  const artifact = {
    id: 'img-1', artifactType: 'image', title: 'Image', timestamp: '2026-07-01T12:00:00.000Z',
    status: 'available', sourceMessageId: 'msg-2',
    image: { id: 'img-1', displayName: 'Image', mimeType: 'image/png', assetPath: 'C:/ws/.jenny/artifacts/s1/pic.png', width: 10, height: 10, sourceKind: 'capture' },
  };
  const { controller, writeTextCalls } = makeCopyHarness(t, { selectedArtifact: artifact });
  await controller.copySelectedArtifactSource();
  assert.deepEqual(writeTextCalls, [], 'Copy must be a no-op for image artifacts (no source text exists)');
});

/* ── Finding 2: Edit toggle only makes sense for markdown generated artifacts ── */

test('isSelectedArtifactMarkdownGenerated: true only for a markdown generated file', (t) => {
  const markdownArtifact = generatedArtifactFixture({ language: 'markdown', fileName: 'n.md', isMarkdownDocument: true }, { id: 'artifact-1' });
  const codeArtifact = generatedArtifactFixture({ language: 'python', fileName: 'main.py' }, { id: 'artifact-1' });
  const imageArtifact = {
    id: 'img-1', artifactType: 'image', title: 'Image', timestamp: '2026-07-01T12:00:00.000Z', status: 'available',
    image: { id: 'img-1', displayName: 'Image', mimeType: 'image/png', assetPath: 'C:/ws/.jenny/artifacts/s1/pic.png', width: 10, height: 10, sourceKind: 'capture' },
  };

  const md = makeCopyHarness(t, { selectedArtifact: markdownArtifact });
  assert.equal(md.controller.isSelectedArtifactMarkdownGenerated(), true, 'markdown generated file should report true');

  const code = makeCopyHarness(t, { selectedArtifact: codeArtifact });
  assert.equal(code.controller.isSelectedArtifactMarkdownGenerated(), false, 'code (html/py/etc) generated file should report false');

  const image = makeCopyHarness(t, { selectedArtifact: imageArtifact });
  assert.equal(image.controller.isSelectedArtifactMarkdownGenerated(), false, 'image artifact should report false');
});

/* ── Wave-R #18: deleteSelectedArtifact marks the id so a message-derived
   rebuild (getArtifactsForSession) can exclude it — the root cause of the
   "stale post-delete UI still shows the deleted entry" defect. ── */

function makeDeleteHarness(t, { selectedArtifact, deleteImpl } = {}) {
  const dom = new JSDOM('<body></body>');
  const doc = dom.window.document;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = dom.window;
  dom.window.jennyShell = { artifacts: { delete: deleteImpl || (async () => {}) } };
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  });
  const calls = { invalidate: [], clearSelection: 0, renderFull: 0, renderSplit: 0 };
  const toasts = [];
  const state = { artifacts: { deletedArtifactIds: [] }, features: {} };
  const controller = createArtifactSurfaceController({
    state,
    surfaces: { full: {}, split: {} },
    artifactRender,
    escapeHtml: (value) => String(value ?? ''),
    showToastMessage: (message) => toasts.push(message),
    getSelectedArtifact: () => selectedArtifact,
    getArtifactReviewState: () => ({}),
    invalidateSessionArtifacts: (sessionId) => calls.invalidate.push(sessionId),
    clearSelection: () => { calls.clearSelection += 1; },
    renderArtifactsPanel: () => { calls.renderFull += 1; },
    renderArtifactReviewPanel: () => { calls.renderSplit += 1; },
    isGeneratedFile: projection.isGeneratedFile,
    isImageArtifact: projection.isImageArtifact,
  });
  if (selectedArtifact) {
    controller.applySelection(selectedArtifact.sessionId, selectedArtifact.id);
  }
  return { controller, state, calls, toasts };
}

test('deleteSelectedArtifact records `sessionId::artifactId` in state.artifacts.deletedArtifactIds on success', async (t) => {
  const artifact = generatedArtifactFixture({}, { id: 'artifact-7', sessionId: 'session-7' });
  const { controller, state, calls, toasts } = makeDeleteHarness(t, { selectedArtifact: artifact });
  const token = controller.captureSelectedTarget();
  await controller.deleteSelectedArtifact(token);
  assert.deepEqual(state.artifacts.deletedArtifactIds, ['session-7::artifact-7']);
  assert.deepEqual(calls.invalidate, ['session-7']);
  assert.equal(calls.clearSelection, 1);
  assert.equal(calls.renderFull, 1);
  assert.equal(calls.renderSplit, 1);
  assert.match(toasts[0], /deleted/i);
});

test('deleteSelectedArtifact does not double-record the same key on repeat calls', async (t) => {
  const artifact = generatedArtifactFixture({}, { id: 'artifact-7', sessionId: 'session-7' });
  const { controller, state } = makeDeleteHarness(t, { selectedArtifact: artifact });
  const token = controller.captureSelectedTarget();
  await controller.deleteSelectedArtifact(token);
  await controller.deleteSelectedArtifact(token);
  assert.deepEqual(state.artifacts.deletedArtifactIds, ['session-7::artifact-7']);
});

test('deleteSelectedArtifact is a no-op for a non-generated-file artifact (no delete call, no state mutation)', async (t) => {
  const artifact = { id: 'tool-1', artifactType: 'tool_output', sessionId: 'session-7' };
  let deleteCalled = false;
  const { controller, state, calls } = makeDeleteHarness(t, {
    selectedArtifact: artifact,
    deleteImpl: async () => { deleteCalled = true; },
  });
  const token = controller.captureSelectedTarget();
  await controller.deleteSelectedArtifact(token);
  assert.equal(deleteCalled, false);
  assert.deepEqual(state.artifacts.deletedArtifactIds, []);
  assert.equal(calls.clearSelection, 0);
});

test('a failed delete does not mark the artifact deleted and surfaces an error toast (artifact stays visible)', async (t) => {
  const artifact = generatedArtifactFixture({}, { id: 'artifact-8', sessionId: 'session-8' });
  const { controller, state, calls, toasts } = makeDeleteHarness(t, {
    selectedArtifact: artifact,
    deleteImpl: async () => { throw new Error('disk error'); },
  });
  const token = controller.captureSelectedTarget();
  await controller.deleteSelectedArtifact(token);
  assert.deepEqual(state.artifacts.deletedArtifactIds, [], 'a failed delete must not hide the artifact');
  assert.equal(calls.clearSelection, 0);
  assert.match(toasts[0], /disk error|delete failed/i);
});
