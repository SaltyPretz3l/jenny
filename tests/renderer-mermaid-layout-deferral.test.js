// Layout-deferred direct Mermaid rendering (renderMermaidDirectWhenLaidOut).
// Regression coverage for the artifact review panel race: the panel lifts
// .hidden (display:none) and renders the selected artifact in the same
// synchronous tick, so a direct window.mermaid.render() measured a
// not-yet-reflowed DOM, failed, and surfaced "Preview unavailable" even for
// diagrams the transcript tool-card iframe path rendered fine.
// Split out of tests/renderer-mermaid-utils.test.js (file-size ceiling).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

function loadRendererMermaidUtils() {
  // Bust the runtime-loader too so its module-level promise cache resets per
  // test (renderer-mermaid-utils captures it fresh on re-require).
  const loaderPath = require.resolve('../renderer/features/renderer-mermaid-runtime-loader');
  delete require.cache[loaderPath];
  const modulePath = require.resolve('../renderer/features/renderer-mermaid-utils');
  delete require.cache[modulePath];
  return require('../renderer/features/renderer-mermaid-utils');
}

function installDomGlobals(dom, t) {
  const previousWindow = global.window;
  const previousDocument = global.document;

  global.window = dom.window;
  global.document = dom.window.document;

  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  });
}

test('renderMermaidDirectWhenLaidOut defers the direct render until the host gains layout in a later frame', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="panel"><div id="host"></div></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  // Simulate the panel race: .hidden was just lifted, so the host reads 0 wide
  // in this tick and gains layout on a later frame.
  let hostWidth = 0;
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => hostWidth });
  const renderWidths = [];
  dom.window.mermaid = {
    initialize() {},
    async render() {
      renderWidths.push(hostWidth);
      return { svg: '<svg viewBox="0 0 100 100"><rect width="100" height="100"></rect></svg>' };
    },
  };

  const failures = [];
  const pending = mermaidUtils.renderMermaidDirectWhenLaidOut(host, 'flowchart TD\nA-->B', {
    onFailure(payload) { failures.push(payload); },
  });
  assert.equal(renderWidths.length, 0, 'render must not run in the same synchronous tick the panel was un-hidden');
  hostWidth = 320; // layout settles before the deferral's next frame
  await pending;

  assert.deepEqual(failures, []);
  assert.deepEqual(renderWidths, [320], 'render should run exactly once, after layout settled');
  assert.ok(host.querySelector('svg'), 'expected the diagram SVG in the host, not a fallback message');
});

test('renderMermaidDirectWhenLaidOut reports failure (iframe fallback hook) when the host stays display:none', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="panel" style="display: none;"><div id="host"></div></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  let renderCalls = 0;
  dom.window.mermaid = {
    initialize() {},
    async render() {
      renderCalls += 1;
      return { svg: '<svg viewBox="0 0 100 100"><rect width="100" height="100"></rect></svg>' };
    },
  };

  const failures = [];
  await mermaidUtils.renderMermaidDirectWhenLaidOut(host, 'flowchart TD\nA-->B', {
    onFailure(payload) { failures.push(payload); },
  });

  assert.equal(renderCalls, 0, 'direct render must be skipped for a host that is provably hidden');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].ok, false);
  assert.match(failures[0].error, /not laid out/i);
});

test('renderMermaidDirectWhenLaidOut renders synchronously through the module api when the host is already laid out', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 480 });
  // Shell tests replace renderMermaidDirect on the module object; the deferred
  // entry must dispatch through that same property so doubles are honored.
  const directCalls = [];
  mermaidUtils.renderMermaidDirect = async (targetHost, source, options = {}) => {
    directCalls.push({ targetHost, source });
    options.onSuccess?.({ ok: true });
  };

  let succeeded = false;
  await mermaidUtils.renderMermaidDirectWhenLaidOut(host, 'flowchart TD\nA-->B', {
    onSuccess() { succeeded = true; },
  });

  assert.equal(directCalls.length, 1);
  assert.equal(directCalls[0].targetHost, host);
  assert.ok(succeeded);
});
