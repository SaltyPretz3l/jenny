'use strict';

/* Unified Preview stage (renderer/features/renderer-ide-preview-stage.js,
 * workspace_preview_surface). Covers: markdown/mermaid through the shared
 * pipeline, the INVARIANT that workspace HTML always renders in the strict
 * sandboxed iframe (staged jenny-artifact:// src + sandbox="allow-scripts",
 * never srcdoc — srcdoc inherits the parent CSP — and never DOMPurify inline),
 * the self-contained v1 messaging, bounded unsupported/missing/binary/too-
 * large states, display precedence (explicit target > active editor file >
 * empty), buffer-first reads, and open() pinning + stage activation. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ideState = require('../renderer/features/renderer-ide-state');
const {
  createIdePreviewStage,
  MAX_PREVIEW_BYTES,
  SELF_CONTAINED_NOTE,
  SUPPORTED_LABEL,
} = require('../renderer/features/renderer-ide-preview-stage');
const { createIdeFileOperations } = require('../renderer/features/renderer-ide-file-operations');

function makeStage({ files = {}, buffers = {}, failReads = false, readTextImpl = null } = {}) {
  const dom = new JSDOM('<div id="idePreviewHost" class="hidden"></div>');
  const hostEl = dom.window.document.getElementById('idePreviewHost');
  const ide = ideState.createIdeUiState();
  const calls = {
    activations: [], persist: 0, mermaidPasses: 0, logs: [],
    stagedDocuments: [], readText: [], markdownRenders: [],
  };
  // Stand-in for the preload bridge's artifactFrame.stage — the HTML frame
  // factory's default staging transport (services/artifact-frame-protocol.js).
  dom.window.jennyShell = {
    artifactFrame: {
      stage: (html) => {
        calls.stagedDocuments.push(html);
        return Promise.resolve({ ok: true, url: `jenny-artifact://frame/test-${calls.stagedDocuments.length}` });
      },
    },
  };
  // The stage resolves markdownUtils off the global (browser script order);
  // stub it here so no marked/DOMPurify boot is needed in a unit test.
  globalThis.markdownUtils = {
    renderMarkdown: (source, options) => {
      calls.markdownRenders.push({ source, options });
      return `<p data-md>${source.replace(/[<>&]/g, '')}</p>`;
    },
    renderInlineMermaidBlocks: () => { calls.mermaidPasses += 1; },
  };
  const versions = {};
  const api = {
    async readText(payload) {
      calls.readText.push(payload);
      if (typeof readTextImpl === 'function') return readTextImpl(payload);
      if (failReads || !(payload.path in files)) {
        return { ok: false, code: 'CMP-WORKSPACEFS-0004', message: 'File not found.', details: {} };
      }
      // A fixture is either a plain string (ordinary UTF-8 text, editable) or
      // an object shaped like the main-process decoder's binary-preview
      // result (services/versioned-workspace-file-encoding.js:65-78) — a hex
      // dump with editable:false. Deriving `editable` from the fixture shape
      // (instead of hardcoding true) is what lets the harness exercise the
      // real editable===false binary gate.
      const fixture = files[payload.path];
      const isBinaryFixture = fixture !== null && typeof fixture === 'object';
      const text = String(isBinaryFixture ? fixture.content : fixture);
      const editable = isBinaryFixture ? Boolean(fixture.editable) : true;
      return {
        ok: true, path: payload.path, pathKey: payload.path,
        requestedPath: payload.path, requestedPathKey: payload.path,
        content: text, size: Buffer.byteLength(text), mtimeMs: 10,
        rootId: 'root-a', generation: 1, fileVersion: `vf2_${Buffer.from(text).toString('base64url') || 'empty'}`,
        encoding: isBinaryFixture ? (fixture.encoding || 'non-utf-8') : 'utf-8',
        editable, truncated: false, eol: 'lf',
      };
    },
  };
  const fileOperations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'linux' });
  const stage = createIdePreviewStage({
    getDom: () => ({ idePreviewHost: hostEl }),
    getIde: () => ide,
    ideStateUtils: ideState,
    // Real escaping (production wiring passes the shared escapeHtml); the
    // identity fallback would let frame-relayed error text land as live HTML.
    escapeHtml: (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    editorHost: {
      hasDocument: (path) => path in buffers,
      getValue: (path) => buffers[path] || '',
      getAltVersionId: (path) => versions[path] || 1,
    },
    getWorkspaceFsApi: () => api,
    getFileOperations: () => fileOperations,
    appendClientLog: (level, event, meta) => calls.logs.push({ level, event, meta }),
    activateStage: (surface) => calls.activations.push(surface),
    schedulePersist: () => { calls.persist += 1; },
    windowRef: dom.window,
  });
  return { stage, ide, hostEl, calls, dom, buffers, versions, files, fileOperations };
}

function cleanupGlobals(t) {
  t.after(() => { delete globalThis.markdownUtils; });
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('markdown renders through the shared pipeline into .ide-preview-content (with the mermaid pass)', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({ files: { 'docs/readme.md': '# Title' } });
  t.after(() => h.stage.dispose());
  ideState.setPreviewPath(h.ide, 'docs/readme.md');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  const content = h.hostEl.querySelector('.ide-preview-content');
  assert.ok(content, 'markdown lands in the shared content wrapper');
  assert.match(content.innerHTML, /data-md/);
  assert.equal(h.calls.mermaidPasses, 1, 'lazy mermaid pass ran');
  assert.match(h.hostEl.querySelector('.ide-preview-stage-kind').textContent, /Markdown/);
  assert.deepEqual(h.calls.markdownRenders[0].options, { frontmatter: 'metadata' });
});

test('mermaid sources wrap as a fence before rendering', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({ files: { 'flow.mmd': 'graph TD\nA-->B' } });
  t.after(() => h.stage.dispose());
  ideState.setPreviewPath(h.ide, 'flow.mmd');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  assert.match(h.hostEl.querySelector('.ide-preview-content').textContent, /```mermaid/);
  assert.equal(h.calls.markdownRenders[0].options, undefined, 'Mermaid preview does not opt into Markdown frontmatter');
});

test('html previews mount the frame in fill sizing', async (t) => {
  cleanupGlobals(t);
  let captured = null;
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      captured = options;
      return { dispose: () => {}, requestId: 'fill-spy' };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });
  const h = makeStage({ files: { 'site/index.html': '<h1>App</h1>' } });
  t.after(() => h.stage.dispose());
  ideState.setPreviewPath(h.ide, 'site/index.html');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();

  assert.equal(captured?.sizing, 'fill');
});

test('markdown previews never request fill sizing', async (t) => {
  cleanupGlobals(t);
  let frameFactoryCalled = false;
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: () => {
      frameFactoryCalled = true;
      return { dispose: () => {}, requestId: 'markdown-spy' };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });
  const h = makeStage({ files: { 'docs/readme.md': '# Title' } });
  t.after(() => h.stage.dispose());
  ideState.setPreviewPath(h.ide, 'docs/readme.md');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();

  assert.equal(frameFactoryCalled, false);
});

test('INVARIANT: workspace HTML always takes the sandboxed iframe path (staged src, allow-scripts, note copy)', async (t) => {
  cleanupGlobals(t);
  const html = '<h1>App</h1><script>document.title="x"</script>';
  const h = makeStage({ files: { 'site/index.html': html } });
  t.after(() => h.stage.dispose());
  ideState.setPreviewPath(h.ide, 'site/index.html');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  const iframe = h.hostEl.querySelector('iframe');
  assert.ok(iframe, 'an iframe is created');
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts', 'opaque-origin sandbox, no allow-same-origin');
  // srcdoc is forbidden: srcdoc documents inherit the parent CSP, which
  // blocks the frame handshake (2026-07-10 RCA) — the document is staged and
  // loaded via a single-use jenny-artifact:// src instead.
  assert.equal(iframe.getAttribute('srcdoc'), null, 'srcdoc must never be set');
  assert.match(String(iframe.getAttribute('src')), /^jenny-artifact:\/\/frame\//, 'staged artifact src expected');
  assert.equal(h.calls.stagedDocuments.length, 1, 'document staged exactly once');
  assert.ok(h.calls.stagedDocuments[0].includes('Content-Security-Policy'), 'strict CSP meta present in the staged document');
  assert.ok(h.calls.stagedDocuments[0].includes(html), 'document body embedded in the staged document, never file://');
  // The raw HTML must never be injected inline into the stage body.
  assert.equal(h.hostEl.querySelector('.ide-preview-stage-body h1'), null, 'no DOMPurify-style inline injection');
  const note = h.hostEl.querySelector('[data-preview-note]');
  assert.ok(note, 'self-contained note visible');
  assert.equal(note.textContent, SELF_CONTAINED_NOTE);
  assert.match(note.textContent, /not loaded/);
});

test('frame failure card relays the artifact\'s own error text — escaped and length-capped', async (t) => {
  cleanupGlobals(t);
  // Stub the frame factory (global wins in resolveModule) to drive onFailure
  // with the settleError payload shape the real frame relays.
  let captured = null;
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      captured = options;
      return { dispose: () => {}, requestId: 'spy-1' };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });
  const h = makeStage({ files: { 'site/index.html': '<h1>App</h1>' } });
  t.after(() => h.stage.dispose());
  ideState.setPreviewPath(h.ide, 'site/index.html');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  assert.ok(captured, 'frame factory invoked');

  captured.onFailure({ type: 'error', ok: false, error: `Identifier 'sayHi' has already been declared <script>alert(1)</script> ${'x'.repeat(300)}` });
  const card = h.hostEl.querySelector('[data-preview-state]');
  assert.equal(card.dataset.previewState, 'frame-failed');
  assert.match(card.textContent, /Identifier 'sayHi' has already been declared/, 'artifact error text surfaced');
  assert.equal(card.querySelector('script'), null, 'error text must be escaped, never live markup');
  assert.ok(!card.textContent.includes('x'.repeat(201)), 'error text capped at ~200 chars');
  assert.match(card.textContent, /stopped responding or failed to render/, 'generic framing copy retained');
});

test('frame failure card omits the detail parenthetical when the payload carries no error text', async (t) => {
  cleanupGlobals(t);
  let captured = null;
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      captured = options;
      return { dispose: () => {}, requestId: 'spy-2' };
    },
  };
  t.after(() => { delete globalThis.rendererHtmlArtifactFrameUtils; });
  const h = makeStage({ files: { 'site/index.html': '<h1>App</h1>' } });
  t.after(() => h.stage.dispose());
  ideState.setPreviewPath(h.ide, 'site/index.html');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();

  captured.onFailure({ type: 'error', ok: false, error: '   ' });
  const card = h.hostEl.querySelector('[data-preview-state]');
  assert.equal(card.dataset.previewState, 'frame-failed');
  assert.equal(card.textContent.includes('('), false, 'blank error yields no empty parenthetical');
});

test('bounded states: unsupported, missing, binary, too-large — nothing injected into a renderer', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({
    files: {
      // Realistic shape of the intent:'preview' binary result: a printable
      // hex-dump string with editable:false. Its bytes contain no literal
      // NUL — the '\0' sniff alone can never catch this; the real IPC
      // boundary produces exactly this shape, never a literal '\0' in text.
      'a.bin.png.md': {
        content: '00000000  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|',
        editable: false,
        encoding: 'non-utf-8',
      },
      // Belt-and-braces case: a literal embedded NUL byte still trips the
      // gate even though nothing on the real IPC boundary produces one.
      'legacy.bin.md': 'x\0y',
      'big.md': 'a'.repeat(MAX_PREVIEW_BYTES + 1),
    },
  });
  t.after(() => h.stage.dispose());
  ideState.setStageSurface(h.ide, 'preview');

  ideState.setPreviewPath(h.ide, 'script.js');
  h.stage.sync(true);
  await settle();
  // script.js is not previewable → precedence falls to the (absent) active
  // file → the empty state.
  assert.equal(h.hostEl.querySelector('[data-preview-state]').dataset.previewState, 'empty');

  ideState.openTab(h.ide, 'notes.txt');
  ideState.setPreviewPath(h.ide, '');
  h.stage.sync(true);
  await settle();
  assert.equal(h.hostEl.querySelector('[data-preview-state]').dataset.previewState, 'empty', 'txt active tab is not previewable');

  ideState.setPreviewPath(h.ide, 'gone.md');
  h.stage.sync(true);
  await settle();
  assert.equal(h.hostEl.querySelector('[data-preview-state]').dataset.previewState, 'missing');

  ideState.setPreviewPath(h.ide, 'a.bin.png.md');
  h.stage.sync(true);
  await settle();
  assert.equal(h.hostEl.querySelector('[data-preview-state]').dataset.previewState, 'binary', 'editable:false routes to the binary state even though the hex dump is printable ASCII');
  assert.equal(h.hostEl.querySelector('.ide-preview-content'), null, 'nothing renders as markdown content');
  assert.doesNotMatch(h.hostEl.innerHTML, /89 50 4e 47/, 'the hex dump itself is never painted into the DOM');

  ideState.setPreviewPath(h.ide, 'legacy.bin.md');
  h.stage.sync(true);
  await settle();
  assert.equal(h.hostEl.querySelector('[data-preview-state]').dataset.previewState, 'binary', 'a literal NUL byte still trips the belt-and-braces sniff');

  ideState.setPreviewPath(h.ide, 'big.md');
  h.stage.sync(true);
  await settle();
  assert.equal(h.hostEl.querySelector('[data-preview-state]').dataset.previewState, 'too-large');
});

test('a non-ASCII live buffer is bounded by UTF-8 bytes, not UTF-16 code units', async (t) => {
  cleanupGlobals(t);
  const wideText = '界'.repeat(600_000);
  assert.ok(wideText.length < MAX_PREVIEW_BYTES);
  assert.ok(Buffer.byteLength(wideText, 'utf8') > MAX_PREVIEW_BYTES);
  const h = makeStage({ buffers: { 'wide.md': wideText } });
  t.after(() => h.stage.dispose());
  ideState.setPreviewPath(h.ide, 'wide.md');
  ideState.setStageSurface(h.ide, 'preview');

  h.stage.sync(true);
  await settle();

  assert.equal(h.hostEl.querySelector('[data-preview-state]')?.dataset.previewState, 'too-large');
  assert.equal(h.calls.markdownRenders.length, 0, 'oversized UTF-8 content never reaches Markdown rendering');
});

test('SUPPORTED_LABEL is derived from the extension Sets, not a hand-copied string', () => {
  assert.match(SUPPORTED_LABEL, /\.markdown/, 'markdown Set additions stay reflected');
  assert.match(SUPPORTED_LABEL, /\.htm\b/, 'html Set additions stay reflected');
});

test('precedence: explicit target > active editor file; buffer wins over disk', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({
    files: { 'a.md': 'DISK-A', 'b.md': 'DISK-B' },
    buffers: { 'b.md': 'BUFFER-B' },
  });
  t.after(() => h.stage.dispose());
  ideState.openTab(h.ide, 'b.md');
  ideState.setStageSurface(h.ide, 'preview');

  // No explicit target → the active previewable editor file displays…
  h.stage.sync(true);
  await settle();
  assert.match(h.hostEl.querySelector('.ide-preview-content').textContent, /BUFFER-B/, 'buffer preferred over disk');

  // …an explicit target wins over the active file.
  ideState.setPreviewPath(h.ide, 'a.md');
  h.stage.sync(true);
  await settle();
  assert.match(h.hostEl.querySelector('.ide-preview-content').textContent, /DISK-A/);
});

test('open() pins the target, persists, and activates the preview surface', (t) => {
  cleanupGlobals(t);
  const h = makeStage({ files: {} });
  t.after(() => h.stage.dispose());
  assert.equal(h.stage.open('docs\\guide.md'), 'docs/guide.md', 'normalized target returned');
  assert.equal(h.ide.previewPath, 'docs/guide.md');
  assert.equal(h.calls.persist >= 1, true);
  assert.deepEqual(h.calls.activations, ['preview']);
});

test('sync(false) never renders (visibility is the stage controller\'s job); repeated sync is idempotent', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({ files: { 'a.md': 'A' } });
  t.after(() => h.stage.dispose());
  ideState.setPreviewPath(h.ide, 'a.md');
  h.stage.sync(false);
  await settle();
  assert.equal(h.hostEl.innerHTML, '', 'inactive sync leaves the host untouched');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  const first = h.hostEl.innerHTML;
  h.stage.sync(true);
  await settle();
  assert.equal(h.hostEl.innerHTML, first, 'unchanged target does not re-render');
});

test('buffer edits live-update markdown through the debounced model-change hook', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({ files: {}, buffers: { 'a.md': 'ONE' } });
  t.after(() => h.stage.dispose());
  ideState.openTab(h.ide, 'a.md');
  ideState.setPreviewPath(h.ide, 'a.md');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  assert.match(h.hostEl.querySelector('.ide-preview-content').textContent, /ONE/);

  h.buffers['a.md'] = 'TWO';
  h.versions['a.md'] = 2;
  h.stage.handleModelChange('a.md');
  await new Promise((resolve) => setTimeout(resolve, 260));
  await settle();
  assert.match(h.hostEl.querySelector('.ide-preview-content').textContent, /TWO/, 'debounced re-render from the buffer');
});

test('unopened preview uses the bounded versioned lane and refreshes on watcher invalidation', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({ files: { 'a.md': 'FIRST' } });
  t.after(() => h.stage.dispose());
  ideState.setPreviewPath(h.ide, 'a.md');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  assert.match(h.hostEl.querySelector('.ide-preview-content').textContent, /FIRST/);
  assert.deepEqual(h.calls.readText[0], { path: 'a.md', intent: 'preview', maxBytes: MAX_PREVIEW_BYTES });

  h.files['a.md'] = 'SECOND';
  h.fileOperations.noteExternalChange('a.md');
  h.stage.handleExternalChange({ relPath: 'a.md', kind: 'changed' });
  await settle();

  assert.match(h.hostEl.querySelector('.ide-preview-content').textContent, /SECOND/);
  assert.equal(h.calls.readText.length, 2);
});

test('watcher noise for non-displayed paths retains no per-path revision entries', () => {
  const retainedMaps = [];
  class TrackingMap extends Map {
    constructor(...args) {
      super(...args);
      retainedMaps.push(this);
    }
  }
  const source = fs.readFileSync(require.resolve('../renderer/features/renderer-ide-preview-stage'), 'utf8');
  const sandbox = {
    module: { exports: {} }, exports: {}, Map: TrackingMap, Set, TextEncoder,
    markdownUtils: {}, rendererHtmlArtifactFrameUtils: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  const stage = sandbox.module.exports.createIdePreviewStage({
    getIde: () => ({ previewPath: 'current.md', activeStageSurface: 'preview' }),
    ideStateUtils: {
      fileExtensionOf: (path) => path.split('.').pop(),
      normalizeIdeRelativePath: (path) => path,
      coerceStageSurface: (surface) => surface,
    },
  });

  for (let index = 0; index < 1_000; index += 1) {
    stage.handleExternalChange({ relPath: `other-${index}.md`, kind: 'changed' });
  }

  assert.equal(retainedMaps.reduce((total, map) => total + map.size, 0), 0);
  stage.dispose();
});

test('a superseded unopened preview read cannot paint after a newer target intent', async (t) => {
  cleanupGlobals(t);
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const h = makeStage({
    readTextImpl: async ({ path }) => {
      if (path === 'a.md') return first;
      return {
        ok: true, path, pathKey: path, requestedPath: path, requestedPathKey: path,
        content: 'NEW-B', size: 5, mtimeMs: 20, rootId: 'root-a', generation: 1,
        fileVersion: 'vf2_b', encoding: 'utf-8', editable: true, truncated: false, eol: 'lf',
      };
    },
  });
  t.after(() => h.stage.dispose());
  ideState.setStageSurface(h.ide, 'preview');
  ideState.setPreviewPath(h.ide, 'a.md');
  h.stage.sync(true);
  await settle();
  ideState.setPreviewPath(h.ide, 'b.md');
  h.stage.sync(true);
  releaseFirst({
    ok: true, path: 'a.md', pathKey: 'a.md', requestedPath: 'a.md', requestedPathKey: 'a.md',
    content: 'STALE-A', size: 7, mtimeMs: 10, rootId: 'root-a', generation: 1,
    fileVersion: 'vf2_a', encoding: 'utf-8', editable: true, truncated: false, eol: 'lf',
  });
  await settle();
  await settle();

  const content = h.hostEl.querySelector('.ide-preview-content');
  assert.ok(content);
  assert.match(content.textContent, /NEW-B/);
  assert.doesNotMatch(content.textContent, /STALE-A/);
});

/* The shell sets user-select:none on html,body (styles/foundation.css), so the
 * preview surfaces must opt back in explicitly. Guards the real failure mode:
 * the global rule silently reclaiming the surface if these are tidied away. */
test('preview state card and markdown body stay selectable and highlight on selection', () => {
  const css = fs.readFileSync(require.resolve('../styles/ide-preview.css'), 'utf8');

  const stateRule = css.match(/\.ide-preview-stage-state\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(stateRule, /^\s*user-select:\s*text;/m, 'state card opts out of the shell-wide user-select:none');
  assert.match(stateRule, /-webkit-user-select:\s*text;/);

  const contentRule = css.match(/\.ide-preview-content\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(contentRule, /^\s*user-select:\s*text;/m, 'markdown preview body opts out too');
  assert.match(contentRule, /-webkit-user-select:\s*text;/);

  const selectionRule = css.match(/\.ide-preview-stage-state::selection[^{]*\{([^}]*)\}/)?.[1] || '';
  assert.match(selectionRule, /background:\s*color-mix\(/, 'selection carries an explicit highlight');
});
