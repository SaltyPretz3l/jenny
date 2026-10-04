'use strict';

// Body re-render discipline for the artifact panel's tool-output viewer
// (shell-chrome area 3, finding P1): the chat pipeline re-renders the panel on
// every pass, so the text body must be rebuilt only when its signature (the
// artifact identity and content version) changes. An unchanged artifact keeps
// the same DOM node, so wrap state and scroll position survive the pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const projection = require('../renderer/features/renderer-artifacts-projection.js');
const artifactRender = require('../renderer/features/renderer-artifacts-render.js');
const { createArtifactSurfaceController } = require('../renderer/features/renderer-artifacts-surface-controller.js');
const { buildOutputBodySignature, sameOutputBodySignature } = require('../renderer/features/renderer-artifacts-render-text.js');

function makeHarness(t) {
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
  const el = () => doc.body.appendChild(doc.createElement('div'));
  const surface = {
    key: 'split',
    detailEmpty: el(), detailPanel: el(), detailKicker: el(), detailTitle: el(),
    detailPath: el(), detailStatus: el(), detailMeta: el(), detailNote: el(),
    previewContent: el(), editorShell: el(), editorHost: el(), editorFallback: el(),
    saveButton: el(), revertButton: el(), revealButton: el(), openExternalButton: el(),
    deleteButton: el(), jumpButton: el(), provenanceTimeline: el(), metaPane: el(),
    dirtyBadge: el(), stackedMeta: true,
  };
  // Count every innerHTML write the body host receives.
  let writes = 0;
  const descriptor = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
  Object.defineProperty(surface.previewContent, 'innerHTML', {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) { writes += 1; descriptor.set.call(this, value); },
  });
  const state = {
    ui: { artifactReview: { mode: 'artifact' } },
    artifacts: { loading: false, lastError: '', loadedArtifactId: '', loadedArtifactContent: '', dirtyContent: '', savePending: false, viewModeByKind: {} },
    features: { featureFlags: {} },
  };
  const controller = createArtifactSurfaceController({
    state,
    surfaces: { full: null, split: surface },
    artifactRender,
    renderMermaidPreviewIntoHost: () => true,
    escapeHtml: (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    getSelectedArtifact: () => null,
    getArtifactReviewState: () => state.ui.artifactReview,
    normalizeArtifactReviewMode: (mode) => mode || 'artifact',
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
  return { controller, surface, state, writes: () => writes };
}

function toolArtifact(overrides = {}) {
  return {
    id: 'tool-1', sessionId: 's1', artifactType: 'tool_output', title: 'Run tests', timestamp: '2026-09-29T12:00:00.000Z',
    status: 'completed', sourceMessageId: 'msg-1',
    tool: { callId: 'c1', toolName: 'run_command', summary: 'ran', isError: false },
    outputText: 'line one\nline two',
    ...overrides,
  };
}

test('two consecutive renders of an unchanged tool output do not rebuild the body', (t) => {
  const h = makeHarness(t);
  const artifact = toolArtifact();
  h.controller.renderSelectedArtifactDetail(h.surface, artifact);
  const firstBody = h.surface.previewContent.firstElementChild;
  assert.ok(firstBody, 'the first render builds the viewer');
  assert.equal(h.writes(), 1);

  // The chat pipeline re-renders with a freshly projected but identical artifact.
  h.controller.renderSelectedArtifactDetail(h.surface, toolArtifact());
  assert.equal(h.writes(), 1, 'no innerHTML write on the second pass');
  assert.equal(h.surface.previewContent.firstElementChild, firstBody, 'the same node survives, so wrap and scroll survive');
});

test('a content change rebuilds the body', (t) => {
  const h = makeHarness(t);
  h.controller.renderSelectedArtifactDetail(h.surface, toolArtifact());
  h.controller.renderSelectedArtifactDetail(h.surface, toolArtifact({ outputText: 'line one\nline two\nline three' }));
  assert.equal(h.writes(), 2);
  assert.match(h.surface.previewContent.textContent, /line three/);
});

test('a different artifact, a status change or a foreign write rebuilds the body', (t) => {
  const h = makeHarness(t);
  h.controller.renderSelectedArtifactDetail(h.surface, toolArtifact());
  h.controller.renderSelectedArtifactDetail(h.surface, toolArtifact({ id: 'tool-2' }));
  assert.equal(h.writes(), 2, 'another artifact');
  h.controller.renderSelectedArtifactDetail(h.surface, toolArtifact({ id: 'tool-2', status: 'error' }));
  assert.equal(h.writes(), 3, 'a failed status');
  h.surface.previewContent.innerHTML = '<p>another rail mode painted here</p>';
  h.controller.renderSelectedArtifactDetail(h.surface, toolArtifact({ id: 'tool-2', status: 'error' }));
  assert.equal(h.writes(), 5, 'the body node is gone, so the render rebuilds it');
  assert.ok(h.surface.previewContent.querySelector('.artifact-output-viewer'));
});

test('the signature keys on identity and content version, not on the object reference', () => {
  const same = (left, right) => sameOutputBodySignature(buildOutputBodySignature(left), buildOutputBodySignature(right));
  assert.equal(same(toolArtifact(), toolArtifact()), true);
  assert.equal(same(toolArtifact(), toolArtifact({ outputText: 'changed' })), false);
  assert.equal(same(toolArtifact(), toolArtifact({ sessionId: 's2' })), false);
  const diff = { additions: 1, deletions: 0, hunks: [{ lines: ['+a'] }] };
  assert.equal(same(toolArtifact({ diff }), toolArtifact({ diff })), true, 'the projection hands the message diff through by reference');
  assert.equal(same(toolArtifact({ diff }), toolArtifact({ diff: { additions: 2, deletions: 0, hunks: [{ lines: ['+a', '+b'] }] } })), false);
});

test('an unchanged render compares the signature without serializing the body', (t) => {
  const h = makeHarness(t);
  const diff = { additions: 1, deletions: 0, truncated: false, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'.repeat(2000)] }] };
  h.controller.renderSelectedArtifactDetail(h.surface, toolArtifact({ outputText: 'y'.repeat(50000), diff }));
  const original = JSON.stringify;
  let calls = 0;
  JSON.stringify = function countingStringify(...args) { calls += 1; return original.apply(this, args); };
  try {
    h.controller.renderSelectedArtifactDetail(h.surface, toolArtifact({ outputText: 'y'.repeat(50000), diff }));
  } finally {
    JSON.stringify = original;
  }
  assert.equal(h.writes(), 1, 'the body was kept');
  assert.equal(calls, 0, 'no JSON.stringify of output, preview or diff hunks per render');
});
