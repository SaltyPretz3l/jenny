'use strict';

/* Markdown/Mermaid preview through the tree's Open Preview entry: the stage
 * surface (#idePreviewHost), sanitization through the chat markdown pipeline,
 * .mmd fence wrapping, and the stage's root-change read guard. Shared jsdom
 * harness (fallback editor path). Frontmatter cases live in
 * markdown-utils-sanitize.test.js. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness,
  findMenuItem,
  openContextMenu,
  settle,
} = require('./helpers/renderer-ide-harness');
const { createIdePreviewController } = require('../renderer/features/renderer-ide-preview-controller');
const { createIdePreviewStage } = require('../renderer/features/renderer-ide-preview-stage');
const ideState = require('../renderer/features/renderer-ide-state');
const { JSDOM } = require('jsdom');

const MD = '---\ntitle: Hidden preview metadata\ntags:\n  - workspace\n---\n# Title\n\nhello <script>alert(1)</script> <img src=x onerror=alert(2)>\n';
const FILES = {
  'docs/readme.md': MD,
  'flow.mmd': 'graph TD\nA-->B',
  'app.js': 'const x = 1;',
};

test('Open Preview renders sanitized markdown into the preview stage', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.viewHost('explorer');
  panel.querySelector('[data-ide-tree-path="docs"]').click();
  await settle();

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="docs/readme.md"]'));
  const item = findMenuItem(doc, 'Open Preview');
  assert.ok(item, 'tree offers Open Preview for markdown');
  item.click();
  await settle();

  assert.equal(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path^="preview://"]'), null, 'no preview tab is opened');
  const host = harness.getDom().idePreviewHost;
  assert.equal(host.classList.contains('hidden'), false);
  const content = host.querySelector('.ide-preview-content');
  assert.match(content.innerHTML, /<h1[^>]*>Title<\/h1>/);
  assert.doesNotMatch(content.textContent, /Hidden preview metadata/, 'valid YAML metadata is not rendered');
  assert.ok(!content.innerHTML.includes('<script'), 'script stripped by DOMPurify');
  assert.ok(!content.innerHTML.includes('onerror'), 'event handlers stripped');
});

test('js files get no Open Preview entry; .mmd wraps as a mermaid fence', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('app.js');
  await settle();
  const doc = harness.dom.window.document;
  const strip = harness.getDom().ideTabStrip;
  openContextMenu(harness, strip.querySelector('[data-ide-tab-path="app.js"]'));
  assert.equal(findMenuItem(doc, 'Open Preview'), null, 'no preview for js');

  await harness.controller.openFile('flow.mmd');
  await settle();
  openContextMenu(harness, strip.querySelector('[data-ide-tab-path="flow.mmd"]'));
  findMenuItem(doc, 'Open Preview').click();
  await settle();
  const content = harness.getDom().idePreviewHost.querySelector('.ide-preview-content');
  // The mermaid fence renders through the chat pipeline's mermaid block
  // markup (lazy runtime, no jsdom render) - the source must be present.
  assert.match(content.innerHTML, /mermaid/i);
  assert.match(content.textContent, /graph TD/);
});

test('workspace watcher invalidates and reloads an unopened unified preview through the versioned lane', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { ...FILES } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const doc = harness.dom.window.document;
  const panel = harness.viewHost('explorer');
  panel.querySelector('[data-ide-tree-path="docs"]').click();
  await settle();
  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="docs/readme.md"]'));
  findMenuItem(doc, 'Open Preview').click();
  await settle();

  const host = harness.getDom().idePreviewHost;
  assert.match(host.textContent, /Title/);
  assert.equal(harness.bridge.calls.readText.length, 1);

  harness.bridge.state.files['docs/readme.md'] = '# Externally Changed\n';
  harness.bridge.emitChange({ changes: [{ relPath: 'docs/readme.md', kind: 'modified' }] });
  await settle();

  assert.equal(harness.bridge.calls.readText.length, 2, 'watch invalidation re-reads via readText');
  assert.match(host.textContent, /Externally Changed/);
});

test('Open Preview always targets the Preview stage; HTML is previewable, synthetic tab ids are not', () => {
  const opened = [];
  const preview = createIdePreviewController({ callbacks: { openPreviewStage: (path) => opened.push(path) } });

  assert.equal(preview.isPreviewablePath('site/index.html'), true);
  assert.equal(preview.isPreviewablePath('site/page.htm'), true);
  assert.equal(preview.isPreviewablePath('app.js'), false);
  assert.equal(preview.isPreviewablePath('preview://docs/readme.md'), false);
  assert.equal(preview.openPreview('app.js'), false);
  assert.equal(preview.openPreview('./site/index.html'), true);
  assert.deepEqual(opened, ['site/index.html']);
});

test('a preview stage read in flight across a workspace root change cannot paint', async (t) => {
  let releaseOld;
  const reads = [];
  const renders = [];
  globalThis.markdownUtils = { renderMarkdown: (text) => { renders.push(text); return `<p>${text}</p>`; } };
  t.after(() => { delete globalThis.markdownUtils; });
  const dom = new JSDOM('<div id="idePreviewHost"></div>');
  const hostEl = dom.window.document.getElementById('idePreviewHost');
  const ide = ideState.createIdeUiState();
  const stage = createIdePreviewStage({
    getDom: () => ({ idePreviewHost: hostEl }),
    getIde: () => ide,
    ideStateUtils: ideState,
    getWorkspaceFsApi: () => ({
      readText(payload) {
        reads.push(payload);
        return new Promise((resolve) => { releaseOld = resolve; });
      },
    }),
    windowRef: dom.window,
  });
  t.after(() => stage.dispose());
  ideState.setStageSurface(ide, 'preview');
  ideState.setPreviewPath(ide, 'old.md');
  stage.sync(true);
  await settle();
  assert.deepEqual(reads, [{ path: 'old.md', intent: 'preview', maxBytes: 1_500_000 }]);

  stage.handleWorkspaceRootCommitted();
  releaseOld({
    ok: true, path: 'old.md', pathKey: 'old.md', requestedPath: 'old.md', requestedPathKey: 'old.md',
    content: 'OLD-ROOT', size: 8, mtimeMs: 10, rootId: 'root-old', generation: 1,
    fileVersion: 'vf2_old', encoding: 'utf-8', editable: true, truncated: false, eol: 'lf',
  });
  await settle();
  await settle();

  assert.doesNotMatch(hostEl.textContent, /OLD-ROOT/);
  assert.deepEqual(renders, []);
});
