'use strict';

/* W8 Markdown/Mermaid preview: preview:// tab flow, sanitization through the
 * chat markdown pipeline, .mmd fence wrapping, debounced live re-render from
 * the editor buffer, and persistence exclusion. Shared jsdom harness
 * (fallback editor path). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness,
  findMenuItem,
  openContextMenu,
  settle,
} = require('./helpers/renderer-ide-harness');
const ideState = require('../renderer/features/renderer-ide-state');
const { createIdePreviewController } = require('../renderer/features/renderer-ide-preview-controller');

const MD = '---\ntitle: Hidden preview metadata\ntags:\n  - workspace\n---\n# Title\n\nhello <script>alert(1)</script> <img src=x onerror=alert(2)>\n';
const FILES = {
  'docs/readme.md': MD,
  'flow.mmd': 'graph TD\nA-->B',
  'app.js': 'const x = 1;',
};

function previewPane(harness) {
  return harness.getDom().ideEditorHost.querySelector('.ide-preview-pane');
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('Open Preview renders sanitized markdown into a preview tab', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;
  panel.querySelector('[data-ide-tree-path="docs"]').click();
  await settle();

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="docs/readme.md"]'));
  const item = findMenuItem(doc, 'Open Preview');
  assert.ok(item, 'tree offers Open Preview for markdown');
  item.click();
  await settle();

  const tab = harness.getDom().ideTabStrip
    .querySelector('[data-ide-tab-path="preview://docs/readme.md"]');
  assert.ok(tab, 'preview tab opened');
  assert.match(tab.textContent, /readme\.md \(preview\)/);
  const pane = previewPane(harness);
  assert.equal(pane.classList.contains('hidden'), false);
  const content = pane.querySelector('.ide-preview-content');
  assert.match(content.innerHTML, /<h1[^>]*>Title<\/h1>/);
  assert.doesNotMatch(content.textContent, /Hidden preview metadata/, 'valid YAML metadata is not rendered');
  assert.ok(!content.innerHTML.includes('<script'), 'script stripped by DOMPurify');
  assert.ok(!content.innerHTML.includes('onerror'), 'event handlers stripped');
  // Status bar and breadcrumbs are suppressed for the review surface.
  assert.equal(harness.getDom().ideStatusBar.classList.contains('hidden'), true);
});

test('Workspace Markdown preview strips only closed YAML mapping or empty frontmatter', (t) => {
  const preview = createIdePreviewController({ callbacks: {} });
  t.after(() => preview.dispose());

  const valid = preview.buildPreviewHtml(
    'docs/valid.md',
    '\uFEFF---\r\ntitle: Hidden metadata\r\nnested:\r\n  enabled: true\r\n---\r\n# Visible body',
  );
  assert.match(valid, /Visible body/);
  assert.doesNotMatch(valid, /Hidden metadata/);

  const empty = preview.buildPreviewHtml('docs/empty.md', '---\n---\n# Empty metadata body');
  assert.match(empty, /Empty metadata body/);
  assert.equal((empty.match(/<hr>/g) || []).length, 0, 'empty metadata fences are removed');

  const malformed = preview.buildPreviewHtml('docs/malformed.md', '---\ntitle: [broken\n---\n# Body');
  assert.match(malformed, /title: \[broken/);
  assert.match(malformed, /Body/);

  const unclosed = preview.buildPreviewHtml('docs/unclosed.md', '---\ntitle: Still content\n# Body');
  assert.match(unclosed, /Still content/);
  assert.match(unclosed, /Body/);

  const scalar = preview.buildPreviewHtml('docs/scalar.md', '---\nordinary text\n---\n# Body');
  assert.match(scalar, /ordinary text/);
  assert.equal((scalar.match(/<hr>/g) || []).length, 1, 'scalar YAML keeps the opening horizontal rule');

  const horizontalRules = preview.buildPreviewHtml('docs/rules.md', 'Before\n\n---\n\nAfter');
  assert.match(horizontalRules, /Before/);
  assert.match(horizontalRules, /After/);
  assert.equal((horizontalRules.match(/<hr>/g) || []).length, 1, 'ordinary in-body horizontal rule survives');
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
  const content = previewPane(harness).querySelector('.ide-preview-content');
  // The mermaid fence renders through the chat pipeline's mermaid block
  // markup (lazy runtime, no jsdom render) - the source must be present.
  assert.match(content.innerHTML, /mermaid/i);
  assert.match(content.textContent, /graph TD/);
});

test('editing the source live-updates an open preview from the buffer', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('docs/readme.md');
  await settle();
  const doc = harness.dom.window.document;
  const strip = harness.getDom().ideTabStrip;
  openContextMenu(harness, strip.querySelector('[data-ide-tab-path="docs/readme.md"]'));
  findMenuItem(doc, 'Open Preview').click();
  await settle();

  // Switch back to the source tab and type; the preview doc re-renders
  // after the debounce even while not visible (stored html refreshes).
  strip.querySelector('[data-ide-tab-path="docs/readme.md"]').click();
  await settle();
  const textarea = harness.getDom().ideEditorFallback;
  textarea.value = '# Changed Heading\n';
  textarea.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  await settle(350); // > 200ms debounce

  strip.querySelector('[data-ide-tab-path="preview://docs/readme.md"]').click();
  await settle();
  const content = previewPane(harness).querySelector('.ide-preview-content');
  assert.match(content.innerHTML, /Changed Heading/);
});

test('preview tabs never persist and close cleanly', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('docs/readme.md');
  await settle();
  const doc = harness.dom.window.document;
  const strip = harness.getDom().ideTabStrip;
  openContextMenu(harness, strip.querySelector('[data-ide-tab-path="docs/readme.md"]'));
  findMenuItem(doc, 'Open Preview').click();
  await settle(600); // let the persist debounce flush

  const persisted = harness.bridge.calls.updateState.at(-1).rootState;
  assert.deepEqual(persisted.openTabs.map((tab) => tab.path), ['docs/readme.md']);
  assert.notEqual(persisted.activeTabPath, 'preview://docs/readme.md');

  strip.querySelector('[data-ide-tab-close="preview://docs/readme.md"]').click();
  await settle();
  assert.equal(
    strip.querySelector('[data-ide-tab-path="preview://docs/readme.md"]'),
    null
  );
  assert.equal(previewPane(harness).classList.contains('hidden'), true);
});

test('workspace watcher invalidates and reloads an unopened unified preview through the versioned lane', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { ...FILES } },
    featureFlags: { workspace_preview_surface: true },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;
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

test('unopened preview activation is latest-request/root-epoch guarded with versioned readText', async (t) => {
  const first = deferred();
  const second = deferred();
  const reads = [];
  const docs = new Set();
  const updates = [];
  const activations = [];
  const ide = ideState.createIdeUiState();
  globalThis.markdownUtils = { renderMarkdown: (text) => `<p>${text}</p>` };
  t.after(() => { delete globalThis.markdownUtils; });
  const controller = createIdePreviewController({
    getIde: () => ide,
    getWorkspaceFsApi: () => ({
      readText(payload) {
        reads.push(payload);
        return payload.path === 'a.md' ? first.promise : second.promise;
      },
    }),
    callbacks: {
      hasDocument: (path) => docs.has(path),
      openPreviewDocument: ({ id }) => docs.add(id),
      updatePreview: (id, html) => updates.push({ id, html }),
      activateDocument: (id) => activations.push(id),
      renderTabs: () => {},
    },
  });
  t.after(() => controller.dispose());

  const pendingA = controller.openPreview('a.md');
  const pendingB = controller.openPreview('b.md');
  second.resolve({
    ok: true, path: 'b.md', pathKey: 'b.md', requestedPath: 'b.md', requestedPathKey: 'b.md',
    content: 'NEW-B', rootId: 'root-a', generation: 1, fileVersion: 'vf2_b',
  });
  assert.equal(await pendingB, true);
  first.resolve({
    ok: true, path: 'a.md', pathKey: 'a.md', requestedPath: 'a.md', requestedPathKey: 'a.md',
    content: 'STALE-A', rootId: 'root-a', generation: 1, fileVersion: 'vf2_a',
  });
  assert.equal(await pendingA, false);
  assert.deepEqual(activations, ['preview://b.md']);
  assert.equal(updates.some((entry) => entry.html.includes('STALE-A')), false);
  assert.deepEqual(reads, [
    { path: 'a.md', intent: 'preview', maxBytes: 1_500_000 },
    { path: 'b.md', intent: 'preview', maxBytes: 1_500_000 },
  ]);

  const oldRoot = deferred();
  const rootController = createIdePreviewController({
    getIde: () => ide,
    getWorkspaceFsApi: () => ({ readText: () => oldRoot.promise }),
    callbacks: {
      hasDocument: () => false,
      openPreviewDocument: () => { throw new Error('old-root preview must not open'); },
    },
  });
  t.after(() => rootController.dispose());
  const pendingOldRoot = rootController.openPreview('old.md');
  rootController.handleWorkspaceRootCommitted();
  oldRoot.resolve({
    ok: true, path: 'old.md', pathKey: 'old.md', requestedPath: 'old.md', requestedPathKey: 'old.md',
    content: 'OLD', rootId: 'root-old', generation: 1, fileVersion: 'vf2_old',
  });
  assert.equal(await pendingOldRoot, false);
});
