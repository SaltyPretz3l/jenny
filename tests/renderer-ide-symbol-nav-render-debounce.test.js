'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createIdeSymbolNav } = require('../renderer/features/renderer-ide-symbol-nav');

function tree() {
  return {
    text: '"f.ts"', kind: 'module', spans: [{ start: 0, length: 200 }],
    childItems: [{ text: 'Greeter', kind: 'class', nameSpan: { start: 13, length: 7 }, spans: [{ start: 0, length: 90 }], childItems: [] }],
  };
}

function harness({ large = false } = {}) {
  const dom = new JSDOM('<nav id="ideBreadcrumbs"></nav>');
  const host = dom.window.document.getElementById('ideBreadcrumbs');
  let versionId = 1;
  const model = {
    uri: { scheme: 'jenny-workspace', path: '/src/f.ts', toString: () => 'jenny-workspace:/src/f.ts' },
    getLanguageId: () => 'typescript',
    getOffsetAt: () => 40,
    getVersionId: () => versionId,
    isDisposed: () => false,
  };
  const delays = [];
  const pending = [];
  let navCalls = 0;
  const largeCalls = [];
  const nav = createIdeSymbolNav({
    windowRef: dom.window,
    getDom: () => ({ ideBreadcrumbs: host }),
    editorHost: {
      isUsingMonaco: () => true,
      getActivePath: () => 'src/f.ts',
      getActiveLanguageId: () => 'typescript',
      getDocumentKind: () => 'file',
      getCursorInfo: () => ({ lineNumber: 1, column: 1 }),
      getModel: () => model,
      isLargeFile: (path) => { largeCalls.push(path); return large; },
    },
    setTimeoutFn: (cb, ms) => { delays.push(ms); pending.push(cb); return pending.length; },
    clearTimeoutFn: () => {},
  });
  const getWorker = async () => async () => ({ getNavigationTree: async () => { navCalls += 1; return tree(); } });
  nav.handleMonacoReady({
    Uri: { parse: () => model.uri },
    editor: { getModel: () => model, getModels: () => [model] },
    languages: { typescript: { getTypeScriptWorker: getWorker, getJavaScriptWorker: getWorker } },
  });
  return {
    dom, host, nav, delays, largeCalls,
    bump: () => { versionId += 1; },
    navCalls: () => navCalls,
    flush: async () => { const cbs = pending.splice(0); cbs.forEach((cb) => cb()); await new Promise((r) => setImmediate(r)); },
  };
}

test('typing (model version changing) uses the longer trailing debounce; cursor-only moves keep 90 ms', () => {
  const h = harness();
  h.nav.render();
  h.nav.render(); // cursor move, same version
  h.bump();
  h.nav.render(); // an edit landed
  h.bump();
  h.nav.render();
  h.nav.render(); // cursor-only after typing stops
  assert.deepEqual(h.delays, [90, 90, 400, 400, 90]);
  h.dom.window.close();
});

test('an unchanged breadcrumb skips the innerHTML write', async () => {
  const h = harness();
  h.nav.render();
  await h.flush();
  const crumb = h.host.querySelector('.ide-crumb-symbols');
  assert.ok(crumb && crumb.textContent.includes('Greeter'));
  let writes = 0;
  const desc = Object.getOwnPropertyDescriptor(h.dom.window.Element.prototype, 'innerHTML');
  Object.defineProperty(crumb, 'innerHTML', { configurable: true, get() { return desc.get.call(this); }, set(v) { writes += 1; desc.set.call(this, v); } });
  h.nav.render();
  await h.flush();
  assert.equal(writes, 0, 'same segments -> no DOM rewrite');
  h.dom.window.close();
});

test('the large-file guard reads editorHost.isLargeFile(path)', async () => {
  const h = harness({ large: true });
  h.nav.render();
  await h.flush();
  assert.deepEqual(h.largeCalls, ['src/f.ts']);
  assert.equal(h.navCalls(), 0, 'no worker call for a large file');
  assert.equal(h.host.querySelector('.ide-crumb-symbols'), null);
  h.dom.window.close();
});
