'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  HTML_ARTIFACT_SANITIZE,
  sanitizeHtmlArtifactMarkup,
  renderHtmlArtifactKind,
  renderSvgArtifactKind,
} = require('../renderer/features/renderer-artifacts-render-web.js');
const { renderArtifactViewModeButton } = require('../renderer/features/renderer-artifacts-render.js');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function makeCtx(t, { content, viewMode = 'preview', editable = false, artifactPanelV3 = false } = {}) {
  const dom = new JSDOM('<body></body>');
  // Stand-in for the preload bridge's artifactFrame.stage (the HTML frame
  // factory's default staging transport): records staged documents.
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
  const setDocumentCalls = [];
  const deps = {
    state: { artifacts: { loading: false, lastError: '' }, features: { featureFlags: { artifact_panel_v3: artifactPanelV3 } } },
    escapeHtml,
    setDetailNote: (s, text, isError) => {
      s.detailNote.textContent = text;
      s.detailNote.classList.toggle('detail-note-error', Boolean(isError));
    },
    ensureEditor: () => ({ setDocument: (docSpec) => { setDocumentCalls.push(docSpec); return Promise.resolve(); } }),
    getPreferredEditorValue: () => content,
    getArtifactViewMode: () => viewMode,
    renderArtifactViewModeButton,
  };
  // The flag-on HTML/SVG path mounts a sandbox iframe whose factory arms a
  // REFERENCED 8s settle timeout (DEFAULT_TIMEOUT_MS in
  // renderer-html-artifact-frame-utils.js) and a window 'message' listener, and
  // parks its disposer on the host element. Nothing here called it, so this file
  // held the event loop ~8.7s past its last assertion. The factory's own key is
  // the only handle a caller gets.
  t.after(() => {
    const hosts = doc.querySelectorAll('*');
    for (const host of hosts) {
      const dispose = host.__jennyHtmlArtifactFrameDispose;
      if (typeof dispose === 'function') dispose();
    }
    dom.window.close();
  });
  return {
    ctx: { surface, artifact: { id: 'a1' }, file: { language: '' }, editable, deps },
    surface,
    setDocumentCalls,
    stagedDocuments,
  };
}

/* ── html kind ── */

test('html kind renders a sanitized preview: scripts, handlers, javascript: URLs stripped', (t) => {
  const { ctx, surface } = makeCtx(t, {
    content: '<div class="keep">ok</div><script>alert(1)</script>'
      + '<img src=x onerror="alert(1)"><a href="javascript:alert(1)">link</a>'
      + '<iframe src="https://x"></iframe><div style="color:red">styled</div>',
  });
  renderHtmlArtifactKind(ctx);
  const html = surface.previewContent.innerHTML;
  assert.ok(html.includes('artifact-preview-web-shell'), html);
  assert.ok(html.includes('ok'), html);
  assert.ok(!html.includes('<script'), `script survived: ${html}`);
  assert.ok(!html.includes('onerror'), `event handler survived: ${html}`);
  assert.ok(!/href="javascript:/i.test(html), `javascript: URL survived: ${html}`);
  assert.ok(!html.includes('<iframe'), `iframe survived: ${html}`);
  assert.ok(!html.includes('style='), `style attribute survived: ${html}`);
  assert.equal(surface.editorShell.classList.contains('hidden'), true);
});

test('html kind emits the generalized view-mode toolbar attributes', (t) => {
  const { ctx, surface } = makeCtx(t, { content: '<p>x</p>', editable: true });
  renderHtmlArtifactKind(ctx);
  const html = surface.previewContent.innerHTML;
  assert.ok(html.includes('data-artifact-view-kind="html"'), html);
  assert.ok(html.includes('data-artifact-view-mode="preview"'), html);
  assert.ok(html.includes('data-artifact-view-mode="edit"'), html);
  assert.ok(!html.includes('data-artifact-mermaid-mode'), 'html toolbar must not reuse the mermaid attr');
});

test('Artifact Panel V3 suppresses the in-content HTML/SVG view toolbar', (t) => {
  const html = makeCtx(t, { content: '<p>x</p>', editable: true, artifactPanelV3: true });
  renderHtmlArtifactKind(html.ctx);
  assert.equal(html.surface.previewContent.querySelector('[data-artifact-view-kind]'), null);
  const svg = makeCtx(t, { content: '<svg><rect width="1" height="1"></rect></svg>', artifactPanelV3: true });
  renderSvgArtifactKind(svg.ctx);
  assert.equal(svg.surface.previewContent.querySelector('[data-artifact-view-kind]'), null);
});

test('html kind edit mode routes to the editor shell', (t) => {
  const { ctx, surface, setDocumentCalls } = makeCtx(t, { content: '<p>x</p>', viewMode: 'edit', editable: true });
  renderHtmlArtifactKind(ctx);
  assert.equal(surface.editorShell.classList.contains('hidden'), false);
  assert.equal(setDocumentCalls.length, 1);
  assert.equal(setDocumentCalls[0].value, '<p>x</p>');
  assert.equal(setDocumentCalls[0].readOnly, false);
});

test('html kind degrades to the raw source when sanitize leaves nothing', (t) => {
  const { ctx, surface } = makeCtx(t, { content: '<script>only()</script>' });
  renderHtmlArtifactKind(ctx);
  const html = surface.previewContent.innerHTML;
  assert.ok(html.includes('artifact-preview-pre'), `source fallback missing: ${html}`);
  assert.ok(!html.includes('<script'), html);
});

test('html kind shows an empty note for blank source', (t) => {
  const { ctx, surface } = makeCtx(t, { content: '   ' });
  renderHtmlArtifactKind(ctx);
  assert.ok(surface.previewContent.innerHTML.includes('source is empty'), surface.previewContent.innerHTML);
});

test('HTML_ARTIFACT_SANITIZE profile stays strict (no scripts/styles/data attrs/target)', () => {
  assert.ok(!HTML_ARTIFACT_SANITIZE.ALLOWED_TAGS.includes('script'));
  assert.ok(!HTML_ARTIFACT_SANITIZE.ALLOWED_TAGS.includes('iframe'));
  assert.ok(!HTML_ARTIFACT_SANITIZE.ALLOWED_TAGS.includes('form'));
  assert.ok(HTML_ARTIFACT_SANITIZE.FORBID_ATTR.includes('style'));
  assert.equal(HTML_ARTIFACT_SANITIZE.ALLOW_DATA_ATTR, false);
  assert.ok(!HTML_ARTIFACT_SANITIZE.ALLOWED_ATTR.includes('target'),
    'target invites reverse-tabnabbing from the privileged renderer');
  assert.ok(!sanitizeHtmlArtifactMarkup('<script>x</script>').includes('script'));
  const link = sanitizeHtmlArtifactMarkup('<a href="https://x" target="_blank" rel="opener">go</a>');
  assert.ok(!link.includes('target='), `target survived sanitize: ${link}`);
});

/* ── svg kind ── */

test('svg kind renders sanitized svg markup into the web shell', (t) => {
  const { ctx, surface } = makeCtx(t, {
    content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"></rect><script>alert(1)</script></svg>',
  });
  renderSvgArtifactKind(ctx);
  const html = surface.previewContent.innerHTML;
  assert.ok(html.includes('<svg'), `svg missing: ${html}`);
  assert.ok(html.includes('rect'), html);
  assert.ok(!html.includes('<script'), `script survived svg sanitize: ${html}`);
  assert.ok(html.includes('data-artifact-view-kind="svg"'), html);
});

test('svg kind falls back to raw source when the sanitizer strips everything', (t) => {
  const { ctx, surface } = makeCtx(t, { content: '<script>only()</script>' });
  renderSvgArtifactKind(ctx);
  const html = surface.previewContent.innerHTML;
  assert.ok(html.includes('artifact-preview-pre'), `source fallback missing: ${html}`);
  assert.ok(!html.includes('<script'), html);
});

test('svg kind renders non-svg text inert (sanitizer passes plain text through)', (t) => {
  const { ctx, surface } = makeCtx(t, { content: 'not svg at all' });
  renderSvgArtifactKind(ctx);
  assert.ok(surface.previewContent.textContent.includes('not svg at all'));
  assert.equal(surface.previewContent.querySelector('svg'), null);
});

/* ── HTML Artifact Preview Step 4: flag-gated exec-html routing ── */

function makeExecCtx(t, { flag, content = '<div>x</div><script>go()</script>', language = 'html', fileName = 'chart.html' } = {}) {
  const built = makeCtx(t, { content });
  built.ctx.artifact = {
    id: 'exec1',
    sessionId: 's1',
    artifactType: 'generated_file',
    generatedFile: { artifactId: 'exec1', fileName, language },
  };
  if (flag !== undefined) {
    built.ctx.deps.state.features = { featureFlags: { artifact_html_preview: flag } };
  }
  return built;
}

test('flag ON + executable html routes to the sandbox preview (staged-src iframe), not the inline path', async (t) => {
  const { ctx, surface, stagedDocuments } = makeExecCtx(t, { flag: true });
  renderHtmlArtifactKind(ctx);
  const iframe = surface.previewContent.querySelector('iframe');
  assert.ok(iframe, 'sandbox iframe missing on the flag-on exec path');
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  // srcdoc is forbidden — it inherits the parent CSP and kills the frame
  // handshake (2026-07-10 RCA); the document travels via a staged src.
  assert.equal(iframe.getAttribute('srcdoc'), null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(String(iframe.getAttribute('src')), /^jenny-artifact:\/\/frame\//);
  assert.ok(stagedDocuments.some((docHtml) => docHtml.includes('<script>go()</script>')),
    'the executable body must reach the staged document untouched');
  assert.ok(surface.previewContent.innerHTML.includes('artifact-html-preview-strip'));
});

test('flag OFF is byte-identical to a flag-less render: inline DOMPurify path, factory never reached', (t) => {
  const factoryCalls = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (...args) => { factoryCalls.push(args); return { dispose: () => {} }; },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });

  const flagOff = makeExecCtx(t, { flag: false });
  renderHtmlArtifactKind(flagOff.ctx);
  const flagless = makeExecCtx(t, {});
  renderHtmlArtifactKind(flagless.ctx);

  assert.equal(flagOff.surface.previewContent.innerHTML, flagless.surface.previewContent.innerHTML,
    'flag-off must be byte-identical to the pre-feature render');
  assert.equal(factoryCalls.length, 0, 'the frame factory must never be reached flag-off');
  assert.equal(flagOff.surface.previewContent.querySelector('iframe'), null);
  assert.ok(!flagOff.surface.previewContent.innerHTML.includes('artifact-html-preview'),
    'no preview chrome (strip/stepper) may leak into the flag-off render');
  assert.ok(!flagOff.surface.previewContent.innerHTML.includes('<script'),
    'inline path must stay sanitized');
});

test('inert svg stays on the inline path even with the flag ON', (t) => {
  const { ctx, surface } = makeExecCtx(t, {
    flag: true,
    content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"></rect></svg>',
    language: 'svg',
    fileName: 'icon.svg',
  });
  renderSvgArtifactKind(ctx);
  assert.equal(surface.previewContent.querySelector('iframe'), null, 'inert svg must not enter the sandbox iframe');
  assert.ok(surface.previewContent.querySelector('svg'), 'inert svg renders inline (DOMPurify path)');
});

test('svg carrying a script routes to the sandbox iframe when the flag is ON', (t) => {
  const { ctx, surface } = makeExecCtx(t, {
    flag: true,
    content: '<svg xmlns="http://www.w3.org/2000/svg"><rect/><script>tick()</script></svg>',
    language: 'svg',
    fileName: 'anim.svg',
  });
  renderSvgArtifactKind(ctx);
  const iframe = surface.previewContent.querySelector('iframe');
  assert.ok(iframe, 'scripted svg must route to the sandbox iframe');
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
});

test('edit mode keeps the WS2 editor path even with the flag ON', (t) => {
  const built = makeCtx(t, { content: '<p>x</p>', viewMode: 'edit', editable: true });
  built.ctx.artifact = {
    id: 'exec2',
    sessionId: 's1',
    artifactType: 'generated_file',
    generatedFile: { artifactId: 'exec2', fileName: 'page.html', language: 'html' },
  };
  built.ctx.deps.state.features = { featureFlags: { artifact_html_preview: true } };
  renderHtmlArtifactKind(built.ctx);
  assert.equal(built.surface.editorShell.classList.contains('hidden'), false);
  assert.equal(built.surface.previewContent.querySelector('iframe'), null);
});
