'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const { createArtifactFilePreview } = require('../renderer/features/renderer-artifact-file-preview');

async function harness(t) {
  const dom = new JSDOM('<div id="other"></div><aside id="panel"><div id="preview"></div></aside>');
  const globals = ['window', 'document', 'DOMPurify', 'rendererMermaidUtils', 'IntersectionObserver'];
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(global, name));
  const observers = [];
  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.rendererMermaidUtils = { renderMermaidDirect: () => Promise.resolve() };
  global.IntersectionObserver = class {
    constructor() { this.targets = new Set(); this.disconnects = 0; observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.disconnects += 1; this.targets.clear(); }
  };
  const modulePath = require.resolve('../renderer/shared/markdown-utils');
  delete require.cache[modulePath];
  const markdownUtils = require('../renderer/shared/markdown-utils');
  const doc = dom.window.document;
  const other = doc.getElementById('other');
  const panel = doc.getElementById('panel');
  const host = doc.getElementById('preview');
  const source = '```mermaid\nflowchart TD\nA-->B\n```';
  other.innerHTML = markdownUtils.renderMarkdown(source);
  markdownUtils.renderInlineMermaidBlocks(other);
  const baselineTarget = other.querySelector('.markdown-mermaid-block');
  const state = { ui: { artifactReview: { mode: 'file_preview' } } };
  const controller = createArtifactFilePreview({
    state, windowRef: dom.window, dom: { artifactReviewPanel: panel }, markdownUtils,
    getWorkspaceFsApi: () => ({ readText: async () => ({
      ok: true, content: source, rootId: 'root', generation: 1, fileVersion: 'v1',
    }) }),
    renderArtifactReviewPanel: () => controller.renderRailContent({ root: panel, previewContent: host }),
  });
  controller.bind();
  t.after(() => {
    controller.dispose();
    markdownUtils.disposeMermaidLazyObserver();
    delete require.cache[modulePath];
    globals.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(global, name, previous[index]);
      else delete global[name];
    });
    dom.window.close();
  });
  assert.equal(await controller.openFilePreviewTarget({ path: 'diagram.md' }), true);
  assert.equal(observers.length, 1);
  assert.equal(observers[0].targets.size, 2, 'baseline and preview diagram are observed');
  return { dom, controller, panel, host, observer: observers[0], baselineTarget };
}

test('Markdown -> Code -> dispose prunes retired targets and keeps the connected baseline', async (t) => {
  const h = await harness(t);
  const retired = h.host.querySelector('.markdown-mermaid-block');
  h.host.querySelector('[data-file-preview-view="code"]').click();
  assert.equal(retired.isConnected, false);
  assert.deepEqual([...h.observer.targets], [h.baselineTarget], 'Code replacement prunes detached Mermaid targets');
  h.panel.remove();
  h.controller.dispose();
  assert.deepEqual([...h.observer.targets], [h.baselineTarget]);
  assert.equal(h.observer.disconnects, 0, 'shared observer stays active for other surfaces');
});

test('disposing a removed Markdown preview prunes without a later scan', async (t) => {
  const h = await harness(t);
  h.panel.remove();
  h.controller.dispose();
  assert.deepEqual([...h.observer.targets], [h.baselineTarget], 'disposal prunes detached Mermaid targets');
  assert.equal(h.observer.disconnects, 0);
});
