'use strict';

// HTML Artifact Preview chrome (HTML_PREVIEW_CHROME_SPEC.md F2-minimal +
// V2-ghost) + Step-4 routing predicate. Covers the spec's acceptance
// additions: strip only on the exec-html path, single version -> no stepper
// markup, end-clamped chevrons, error swaps the label text (not an added
// element) and the code fallback renders.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  shouldRenderHtmlPreview,
  renderHtmlPreviewKind,
} = require('../renderer/features/renderer-artifact-html-preview-render.js');
const { renderArtifactViewModeButton } = require('../renderer/features/renderer-artifacts-render.js');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function generatedMessage(artifactId, fileName, timestamp) {
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

function makeCtx(t, {
  content = '<p>live</p>',
  flagOn = true,
  viewMode = 'preview',
  editable = true,
  artifact = null,
  messages = null,
  artifactPanelV3 = false,
} = {}) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  // Stand-in for the preload bridge's artifactFrame.stage (the factory's
  // default staging transport): records staged documents, returns a
  // jenny-artifact URL like services/artifact-frame-protocol.js does.
  const stagedDocuments = [];
  dom.window.jennyShell = {
    artifactFrame: {
      stage: (html) => {
        stagedDocuments.push(html);
        return Promise.resolve({ ok: true, url: `jenny-artifact://frame/test-${stagedDocuments.length}` });
      },
    },
  };
  const doc = dom.window.document;
  const el = () => {
    const node = doc.createElement('div');
    doc.body.appendChild(node);
    return node;
  };
  const surface = { key: 'full', previewContent: el(), editorShell: el(), detailNote: el() };
  const state = {
    artifacts: { loading: false, lastError: '' },
    features: { featureFlags: { artifact_html_preview: flagOn, artifact_panel_v3: artifactPanelV3 } },
  };
  if (messages) state.messagesBySession = new Map([['s1', messages]]);
  const deps = {
    state,
    escapeHtml,
    setDetailNote: (s, text, isError) => {
      s.detailNote.textContent = text;
      s.detailNote.classList.toggle('detail-note-error', Boolean(isError));
    },
    ensureEditor: () => ({ setDocument: () => Promise.resolve() }),
    getPreferredEditorValue: () => content,
    getArtifactViewMode: () => viewMode,
    renderArtifactViewModeButton,
  };
  const resolvedArtifact = artifact || {
    id: 'a1',
    sessionId: 's1',
    artifactType: 'generated_file',
    generatedFile: { artifactId: 'a1', fileName: 'chart.html', language: 'html' },
  };
  return {
    dom,
    surface,
    stagedDocuments,
    ctx: { surface, artifact: resolvedArtifact, file: resolvedArtifact.generatedFile, editable, deps },
  };
}

/* The factory assigns iframe.src on a microtask after staging resolves. */
function settleStaging() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ── routing predicate ── */

test('shouldRenderHtmlPreview: flag ON + executable html + preview mode', (t) => {
  const { ctx } = makeCtx(t);
  assert.equal(shouldRenderHtmlPreview(ctx, 'html'), true);
});

test('shouldRenderHtmlPreview is false when the flag is off, in edit mode, when loading, or for blank source', (t) => {
  assert.equal(shouldRenderHtmlPreview(makeCtx(t, { flagOn: false }).ctx, 'html'), false);
  assert.equal(shouldRenderHtmlPreview(makeCtx(t, { viewMode: 'edit' }).ctx, 'html'), false);
  assert.equal(shouldRenderHtmlPreview(makeCtx(t, { content: '   ' }).ctx, 'html'), false);
  // Loading with NO live frame mounted yet (first selection) keeps the
  // inline "Loading artifact..." interstitial.
  const loading = makeCtx(t);
  loading.ctx.deps.state.artifacts.loading = true;
  assert.equal(shouldRenderHtmlPreview(loading.ctx, 'html'), false);
  const errored = makeCtx(t);
  errored.ctx.deps.state.artifacts.lastError = 'nope';
  assert.equal(shouldRenderHtmlPreview(errored.ctx, 'html'), false);
});

test('shouldRenderHtmlPreview: inert svg stays inline, svg-with-script routes to the frame', (t) => {
  const svgArtifact = {
    id: 'svg1',
    sessionId: 's1',
    artifactType: 'generated_file',
    generatedFile: { artifactId: 'svg1', fileName: 'icon.svg', language: 'svg' },
  };
  const inert = makeCtx(t, { artifact: svgArtifact, content: '<svg><rect/></svg>' });
  assert.equal(shouldRenderHtmlPreview(inert.ctx, 'svg'), false);
  const scripted = makeCtx(t, { artifact: svgArtifact, content: '<svg><script>a()</script></svg>' });
  assert.equal(shouldRenderHtmlPreview(scripted.ctx, 'svg'), true);
});

/* ── chrome render ── */

test('renders the featherweight strip, sandboxed staged-src iframe, and Running label', async (t) => {
  const { surface, ctx, stagedDocuments } = makeCtx(t);
  renderHtmlPreviewKind(ctx, 'html');
  const html = surface.previewContent.innerHTML;
  assert.ok(html.includes('artifact-html-preview-strip'), html);
  const label = surface.previewContent.querySelector('[data-html-preview-label]');
  assert.ok(label, 'strip label missing');
  assert.equal(label.textContent, 'Running…');
  const iframe = surface.previewContent.querySelector('iframe');
  assert.ok(iframe, 'sandbox iframe missing');
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  // srcdoc is forbidden — it would inherit the parent CSP and kill the
  // frame handshake (2026-07-10 RCA); the document travels via staged src.
  assert.equal(iframe.getAttribute('srcdoc'), null);
  await settleStaging();
  assert.match(String(iframe.getAttribute('src')), /^jenny-artifact:\/\/frame\//);
  assert.equal(stagedDocuments.length, 1);
  assert.ok(stagedDocuments[0].includes('<p>live</p>'), 'artifact body must travel in the staged document');
  assert.equal(surface.editorShell.classList.contains('hidden'), true);
  // The view-mode toolbar survives so the user can still reach the source.
  assert.ok(html.includes('data-artifact-view-kind="html"'), html);
});

test('Artifact Panel V3 suppresses the executable-HTML in-content view toolbar', (t) => {
  const { surface, ctx } = makeCtx(t, { artifactPanelV3: true });
  renderHtmlPreviewKind(ctx, 'html');
  assert.equal(surface.previewContent.querySelector('[data-artifact-view-kind]'), null);
});

test('single version -> no stepper markup at all (no placeholder, no v1/1)', (t) => {
  const { surface, ctx } = makeCtx(t, {
    messages: [generatedMessage('a1', 'chart.html', '2026-07-02T10:00:00.000Z')],
  });
  renderHtmlPreviewKind(ctx, 'html');
  const html = surface.previewContent.innerHTML;
  assert.ok(!html.includes('artifact-html-preview-step'), html);
  assert.ok(!html.includes('v1/1'), html);
});

test('multi-version stepper: v1 disables back, latest disables forward, steps carry data-artifact-select', (t) => {
  const messages = [
    generatedMessage('a1', 'chart.html', '2026-07-02T10:00:00.000Z'),
    generatedMessage('a2', 'chart-2.html', '2026-07-02T10:05:00.000Z'),
    generatedMessage('a3', 'chart-3.html', '2026-07-02T10:10:00.000Z'),
  ];
  const oldest = makeCtx(t, { messages });
  renderHtmlPreviewKind(oldest.ctx, 'html');
  let steps = oldest.surface.previewContent.querySelectorAll('.artifact-html-preview-step');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].disabled, true, 'back chevron must be disabled at v1');
  assert.equal(steps[1].disabled, false);
  assert.equal(steps[1].dataset.artifactSelect, 'a2');
  assert.ok(oldest.surface.previewContent.textContent.includes('v1/3'));
  assert.equal(steps[0].getAttribute('aria-label'), 'Previous version');
  assert.equal(steps[1].getAttribute('aria-label'), 'Next version');

  const latestArtifact = {
    id: 'a3',
    sessionId: 's1',
    artifactType: 'generated_file',
    generatedFile: { artifactId: 'a3', fileName: 'chart-3.html', language: 'html' },
  };
  const latest = makeCtx(t, { messages, artifact: latestArtifact });
  renderHtmlPreviewKind(latest.ctx, 'html');
  steps = latest.surface.previewContent.querySelectorAll('.artifact-html-preview-step');
  assert.equal(steps[0].disabled, false);
  assert.equal(steps[0].dataset.artifactSelect, 'a2');
  assert.equal(steps[1].disabled, true, 'forward chevron must be disabled at the latest version');
  assert.ok(latest.surface.previewContent.textContent.includes('v3/3'));
});

test('frame failure swaps the label text in place and falls back to the code listing', (t) => {
  const { surface, ctx } = makeCtx(t, { content: '<p>broken</p><script>zap()</script>' });
  const spyCalls = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      spyCalls.push({ host, source, options });
      return { dispose: () => {}, requestId: 'spy-1' };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });
  renderHtmlPreviewKind(ctx, 'html');
  assert.equal(spyCalls.length, 1);
  assert.equal(spyCalls[0].source, '<p>broken</p><script>zap()</script>');
  const labelBefore = surface.previewContent.querySelectorAll('[data-html-preview-label]');
  assert.equal(labelBefore.length, 1);

  spyCalls[0].options.onFailure({ ok: false, error: 'sandbox error' });
  const label = surface.previewContent.querySelector('[data-html-preview-label]');
  assert.equal(label.textContent, 'Preview failed — showing code: sandbox error',
    'the frame\'s error text is relayed into the failure label');
  assert.equal(surface.previewContent.querySelectorAll('[data-html-preview-label]').length, 1,
    'error must swap the label text, not add an element');
  const fallback = surface.previewContent.querySelector('pre.artifact-preview-pre');
  assert.ok(fallback, 'code fallback missing after frame failure');
  assert.ok(fallback.textContent.includes('<p>broken</p>'), 'fallback must show the raw source');
  assert.equal(surface.previewContent.querySelector('pre.artifact-preview-pre script'), null,
    'fallback source must be escaped, not live markup');

  spyCalls[0].options.onSuccess?.({ ok: true });
  assert.equal(label.textContent, 'Preview failed — showing code: sandbox error',
    'a settle after failure must not flip the label back');
});

test('failure label error text is length-capped, textContent-only, and omitted when blank', (t) => {
  const longError = `Identifier 'sayHi' has already been declared <script>alert(1)</script> ${'x'.repeat(300)}`;
  const first = makeCtx(t, { content: '<p>a</p>' });
  const spyCalls = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      spyCalls.push({ options });
      return { dispose: () => {}, requestId: `spy-${spyCalls.length}` };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });

  renderHtmlPreviewKind(first.ctx, 'html');
  spyCalls[0].options.onFailure({ ok: false, error: longError });
  const label = first.surface.previewContent.querySelector('[data-html-preview-label]');
  assert.ok(label.textContent.includes("Identifier 'sayHi' has already been declared"), 'error text surfaced');
  assert.equal(label.querySelector('script'), null, 'error text must never become live markup');
  assert.ok(!label.textContent.includes('x'.repeat(201)), 'error text capped at ~200 chars');

  const second = makeCtx(t, { content: '<p>b</p>' });
  renderHtmlPreviewKind(second.ctx, 'html');
  spyCalls[1].options.onFailure({ ok: false, error: '   ' });
  const blankLabel = second.surface.previewContent.querySelector('[data-html-preview-label]');
  assert.equal(blankLabel.textContent, 'Preview failed — showing code',
    'blank error text yields the plain label, no dangling colon');
});

test('frame success flips the label to Live preview', (t) => {
  const { surface, ctx } = makeCtx(t);
  const spyCalls = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      spyCalls.push({ options });
      return { dispose: () => {}, requestId: 'spy-2' };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });
  renderHtmlPreviewKind(ctx, 'html');
  spyCalls[0].options.onSuccess({ ok: true });
  assert.equal(surface.previewContent.querySelector('[data-html-preview-label]').textContent, 'Live preview');
});

test('the live preview frame is mounted in fill sizing', (t) => {
  const { ctx } = makeCtx(t);
  const spyCalls = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      spyCalls.push({ host, source, options });
      return { dispose: () => {}, requestId: 'spy-fill' };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });

  renderHtmlPreviewKind(ctx, 'html');

  assert.equal(spyCalls[0].options.sizing, 'fill');
});

/* ── re-render churn (queue #15 live-preview teardown defect) ──
 * renderSelectedArtifactDetail re-runs on every renderAll() pass — every
 * streamed chat token while the review panel is open beside an active turn —
 * with the SAME selected artifact. createHtmlArtifactFrame's postMessage
 * handshake is asynchronous; a naive full rebuild on every repaint tears the
 * live iframe down and restarts it before it can ever settle, degrading a
 * healthy artifact to "Preview failed" purely from repaint churn.
 */

test('re-rendering the same artifact+source reuses the live frame instead of tearing it down', (t) => {
  const { surface, ctx } = makeCtx(t);
  const calls = [];
  const disposes = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      calls.push({ host, source, options });
      return { dispose: () => disposes.push(calls.length), requestId: `spy-${calls.length}` };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });

  renderHtmlPreviewKind(ctx, 'html');
  // Simulate several more renderAll() passes with nothing about the artifact
  // changed (the streaming-turn repaint cadence from the live drive).
  renderHtmlPreviewKind(ctx, 'html');
  renderHtmlPreviewKind(ctx, 'html');

  assert.equal(calls.length, 1, 'unchanged artifact+source must not recreate the live frame');
  assert.equal(disposes.length, 0, 'unchanged artifact+source must not tear down the pending/live frame');
});

test('reusing the live frame preserves a settled label (no reset to Running… mid-stream)', (t) => {
  const { surface, ctx } = makeCtx(t);
  const calls = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      calls.push(options);
      return { dispose: () => {}, requestId: `spy-${calls.length}` };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });

  renderHtmlPreviewKind(ctx, 'html');
  calls[0].onSuccess({ ok: true });
  const label = surface.previewContent.querySelector('[data-html-preview-label]');
  assert.equal(label.textContent, 'Live preview');

  // A later renderAll() pass for the same artifact must not touch the
  // already-settled frame at all.
  renderHtmlPreviewKind(ctx, 'html');
  assert.equal(calls.length, 1, 'a settled frame must not be torn down by a repeat render');
  assert.equal(surface.previewContent.querySelector('[data-html-preview-label]').textContent, 'Live preview',
    'label must not reset to Running… on a no-op repeat render');
});

test('changed source disposes the previous frame and mounts a fresh one', (t) => {
  const { surface, ctx } = makeCtx(t, { content: '<p>one</p>' });
  const sources = [];
  const disposedSources = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      sources.push(source);
      return { dispose: () => disposedSources.push(source), requestId: `spy-${sources.length}` };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });

  renderHtmlPreviewKind(ctx, 'html');
  ctx.deps.getPreferredEditorValue = () => '<p>two</p>';
  renderHtmlPreviewKind(ctx, 'html');

  assert.deepEqual(sources, ['<p>one</p>', '<p>two</p>'], 'a real content change must mount a fresh frame');
  assert.deepEqual(disposedSources, ['<p>one</p>'], 'the stale frame must be disposed before rebuilding');
});

/* ── turn-settle reload interstitial (per-turn preview blink) ──
 * Every turn settle replaces the session messages, which resets the loaded
 * artifact content and re-reads it behind state.artifacts.loading=true
 * (notifySessionMessagesReplaced -> invalidateSessionArtifacts ->
 * resetLoadedState -> preloadSelectedArtifact). During that interstitial the
 * preferred editor value is EMPTY — routing to the inline path (or comparing
 * the signature against the empty source) tore the live iframe down and
 * rebooted it every turn.
 */

test('a loading interstitial with a live frame holds the frame untouched (no teardown, no rebuild)', (t) => {
  const { surface, ctx } = makeCtx(t);
  const calls = [];
  const disposes = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      calls.push(source);
      return { dispose: () => disposes.push(calls.length), requestId: `spy-${calls.length}` };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });

  renderHtmlPreviewKind(ctx, 'html');
  assert.equal(calls.length, 1);

  // Turn settles: loaded content reset, re-read in flight.
  ctx.deps.state.artifacts.loading = true;
  ctx.deps.getPreferredEditorValue = () => '';
  assert.equal(shouldRenderHtmlPreview(ctx, 'html'), true,
    'the interstitial must keep claiming the render while a live frame exists');
  renderHtmlPreviewKind(ctx, 'html');

  assert.equal(calls.length, 1, 'the interstitial must not rebuild the frame');
  assert.equal(disposes.length, 0, 'the interstitial must not dispose the live frame');
  assert.ok(surface.previewContent.querySelector('[data-html-preview-host]'),
    'the live frame host must survive the interstitial');

  // Read resolves with IDENTICAL content: signature matches, frame survives.
  ctx.deps.state.artifacts.loading = false;
  ctx.deps.getPreferredEditorValue = () => '<p>live</p>';
  renderHtmlPreviewKind(ctx, 'html');
  assert.equal(calls.length, 1, 'identical post-load content must reuse the held frame');
  assert.equal(disposes.length, 0);
});

test('the held-frame path does not re-mount or change sizing', (t) => {
  const { ctx } = makeCtx(t);
  const spyCalls = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      spyCalls.push({ host, source, options });
      return { dispose: () => {}, requestId: 'spy-held-fill' };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });

  renderHtmlPreviewKind(ctx, 'html');
  ctx.deps.state.artifacts.loading = true;
  ctx.deps.getPreferredEditorValue = () => '';
  renderHtmlPreviewKind(ctx, 'html');

  assert.equal(spyCalls.length, 1);
  assert.equal(spyCalls[0].options.sizing, 'fill');
});

test('a post-load render with changed content rebuilds the held frame once', (t) => {
  const { ctx } = makeCtx(t, { content: '<p>one</p>' });
  const sources = [];
  const disposedSources = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      sources.push(source);
      return { dispose: () => disposedSources.push(source), requestId: `spy-${sources.length}` };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });

  renderHtmlPreviewKind(ctx, 'html');
  ctx.deps.state.artifacts.loading = true;
  ctx.deps.getPreferredEditorValue = () => '';
  renderHtmlPreviewKind(ctx, 'html');
  ctx.deps.state.artifacts.loading = false;
  ctx.deps.getPreferredEditorValue = () => '<p>two</p>';
  renderHtmlPreviewKind(ctx, 'html');

  assert.deepEqual(sources, ['<p>one</p>', '<p>two</p>'], 'changed post-load content must mount a fresh frame');
  assert.deepEqual(disposedSources, ['<p>one</p>'], 'the stale frame must be disposed exactly once');
});

test('a loading interstitial with an error still falls back to the inline path', (t) => {
  const { ctx } = makeCtx(t);
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: () => ({ dispose: () => {}, requestId: 'spy-1' }),
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });
  renderHtmlPreviewKind(ctx, 'html');
  ctx.deps.state.artifacts.loading = true;
  ctx.deps.state.artifacts.lastError = 'read failed';
  assert.equal(shouldRenderHtmlPreview(ctx, 'html'), false,
    'a load error must surface via the inline path, never hold a stale frame');
});

test('switching to a different artifact disposes the previous frame and mounts a fresh one', (t) => {
  const { surface, ctx } = makeCtx(t);
  const calls = [];
  const disposed = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      calls.push(options.requestKey);
      return { dispose: () => disposed.push(options.requestKey), requestId: `spy-${calls.length}` };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });

  renderHtmlPreviewKind(ctx, 'html');
  ctx.artifact = { ...ctx.artifact, id: 'a2' };
  renderHtmlPreviewKind(ctx, 'html');

  assert.deepEqual(calls, ['a1', 'a2']);
  assert.deepEqual(disposed, ['a1'], 'the previous artifact frame must be disposed before switching');
});
