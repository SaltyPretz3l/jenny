const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

function loadRendererMermaidUtils() {
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

function ensureFrameWindow(iframe) {
  if (iframe.contentWindow) return iframe.contentWindow;
  const stubWindow = { postMessage() {} };
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: stubWindow,
  });
  return stubWindow;
}

test('createMermaidFrame sends exactly once when ready and load both fire', (t) => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');

  mermaidUtils.createMermaidFrame(host, 'flowchart TD\nA-->B');
  const iframe = host.querySelector('iframe');
  const frameWindow = ensureFrameWindow(iframe);
  const postedMessages = [];
  frameWindow.postMessage = (payload) => postedMessages.push(payload);

  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: frameWindow,
    origin: 'null',
    data: { type: 'mermaid-frame-ready' },
  }));
  iframe.dispatchEvent(new dom.window.Event('load'));
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: frameWindow,
    origin: 'null',
    data: { type: 'mermaid-frame-ready' },
  }));

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].type, 'render');
});

test('createMermaidFrame registers load before appending the iframe', (t) => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  const ownerDocument = dom.window.document;
  const originalCreateElement = ownerDocument.createElement.bind(ownerDocument);
  const originalAppendChild = host.appendChild.bind(host);
  const postedMessages = [];

  ownerDocument.createElement = function createElement(tagName, options) {
    const node = originalCreateElement(tagName, options);
    if (String(tagName).toLowerCase() === 'iframe') {
      ensureFrameWindow(node).postMessage = (payload) => postedMessages.push(payload);
    }
    return node;
  };
  host.appendChild = function appendChild(node) {
    node.dispatchEvent(new dom.window.Event('load'));
    return originalAppendChild(node);
  };
  t.after(() => {
    ownerDocument.createElement = originalCreateElement;
    host.appendChild = originalAppendChild;
  });

  mermaidUtils.createMermaidFrame(host, 'flowchart TD\nA-->B');

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].type, 'render');
});
