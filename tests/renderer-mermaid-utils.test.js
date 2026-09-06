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

function ensureFrameWindow(iframe) {
  if (iframe.contentWindow) {
    return iframe.contentWindow;
  }
  const stubWindow = { postMessage() {} };
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: stubWindow,
  });
  return stubWindow;
}

function createInteractivePreview(dom) {
  const preview = dom.window.document.createElement('div');
  preview.id = 'preview';
  preview.innerHTML = '<svg viewBox="0 0 100 100"><rect width="100" height="100"></rect></svg>';
  dom.window.document.body.appendChild(preview);
  return preview;
}

function installPaletteTokens(dom, paletteId, tokenMap) {
  dom.window.document.documentElement.dataset.palette = paletteId;
  const style = dom.window.document.createElement('style');
  style.textContent = ':root {' + Object.entries(tokenMap).map(([token, value]) => `${token}: ${value};`).join(' ') + '}';
  dom.window.document.head.appendChild(style);
  return style;
}

test('buildThemeConfig returns a Mermaid base theme config', (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();

  const theme = mermaidUtils.buildThemeConfig();

  assert.equal(typeof theme.key, 'string');
  assert.equal(theme.config.startOnLoad, false);
  assert.equal(theme.config.securityLevel, 'strict');
  assert.equal(theme.config.theme, 'base');
  assert.equal(theme.config.darkMode, true);
  assert.equal(typeof theme.config.themeVariables, 'object');
});

test('buildThemeConfig keeps midnight palettes in dark mode with hex-safe theme variables', (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
  installDomGlobals(dom, t);
  installPaletteTokens(dom, 'midnight', {
    '--bg-surface': '#171a27',
    '--surface-input-background': 'rgba(14, 16, 24, 0.92)',
    '--bg-panel': '#181b28',
    '--surface-input-background-strong': 'rgba(11, 13, 20, 0.78)',
    '--text-primary': '#f3f4fc',
    '--accent': '#6d82ff',
    '--accent-cyan': '#16e9ff',
    '--border-default': 'rgba(112, 118, 147, 0.14)',
    color: '#f3f4fc',
  });
  const mermaidUtils = loadRendererMermaidUtils();

  const theme = mermaidUtils.buildThemeConfig();

  assert.equal(theme.config.theme, 'base');
  assert.equal(theme.config.darkMode, true);
  assert.match(theme.config.themeVariables.background, /^#[0-9a-f]{6}$/i);
  assert.match(theme.config.themeVariables.primaryColor, /^#[0-9a-f]{6}$/i);
  assert.match(theme.config.themeVariables.primaryBorderColor, /^#[0-9a-f]{6}$/i);
});

test('buildThemeConfig uses light palette-safe Mermaid colors for paper and woolly palettes', (t) => {
  const cases = [
    {
      paletteId: 'paper',
      tokens: {
        '--bg-surface': '#f6f2eb',
        '--surface-input-background': 'rgba(255, 255, 255, 0.9)',
        '--bg-panel': '#f7f3ec',
        '--surface-input-background-strong': 'rgba(250, 247, 242, 0.92)',
        '--text-primary': '#1f2635',
        '--accent': '#3568f0',
        '--accent-cyan': '#157ec7',
        '--border-default': 'rgba(82, 91, 118, 0.14)',
        color: '#1f2635',
      },
    },
    {
      paletteId: 'woolly',
      tokens: {
        '--bg-surface': '#f5efe4',
        '--surface-input-background': 'rgba(255, 253, 248, 0.9)',
        '--bg-panel': '#f2ebe0',
        '--surface-input-background-strong': 'rgba(248, 242, 232, 0.92)',
        '--text-primary': '#2c2417',
        '--accent': '#3d8c2a',
        '--accent-cyan': '#3888cc',
        '--border-default': 'rgba(128, 112, 88, 0.14)',
        color: '#2c2417',
      },
    },
  ];

  for (const item of cases) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
    installDomGlobals(dom, t);
    installPaletteTokens(dom, item.paletteId, item.tokens);
    const mermaidUtils = loadRendererMermaidUtils();

    const theme = mermaidUtils.buildThemeConfig();

    assert.equal(theme.config.theme, 'base');
    assert.equal(theme.config.darkMode, false);
    assert.notEqual(theme.config.themeVariables.background.toLowerCase(), item.tokens['--bg-surface'].toLowerCase());
    assert.notEqual(theme.config.themeVariables.primaryColor.toLowerCase(), '#162a42');
    assert.notEqual(theme.config.themeVariables.secondaryColor.toLowerCase(), '#1a3352');
    assert.notEqual(theme.config.themeVariables.tertiaryColor.toLowerCase(), '#0f2035');
    assert.notEqual(theme.config.themeVariables.lineColor.toLowerCase(), item.tokens['--accent-cyan'].toLowerCase());
    for (const value of Object.values(theme.config.themeVariables)) {
      if (typeof value !== 'string' || value === 'inherit' || value === '13px') continue;
      assert.match(value, /^#[0-9a-f]{6}$/i, `${item.paletteId} Mermaid variable should be solid hex-safe: ${value}`);
    }
  }
});

test('buildThemeConfig treats signal as a dark Mermaid palette', (t) => {
  // signal declares color-scheme: dark (palette-signal.css:2); the light
  // override set is exactly {paper, woolly, jenny-day}. The deliberately
  // light-ish tokens prove classification is id/color-scheme-driven, not
  // token-derived.
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
  installDomGlobals(dom, t);
  installPaletteTokens(dom, 'signal', {
    '--bg-surface': '#f5f7fb',
    '--surface-input-background': 'rgba(255, 255, 255, 0.9)',
    '--bg-panel': '#eef2fa',
    '--surface-input-background-strong': 'rgba(246, 249, 255, 0.92)',
    '--text-primary': '#20283a',
    '--accent': '#245cff',
    '--accent-cyan': '#0c8be6',
    '--border-default': 'rgba(82, 91, 118, 0.14)',
    color: '#20283a',
  });
  const mermaidUtils = loadRendererMermaidUtils();

  const theme = mermaidUtils.buildThemeConfig();

  assert.equal(theme.config.darkMode, true);
  assert.match(theme.config.themeVariables.background, /^#[0-9a-f]{6}$/i);
});

test('buildThemeConfig uses palette Mermaid node label tokens for midnight surfaces', (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
  installDomGlobals(dom, t);
  installPaletteTokens(dom, 'midnight', {
    '--bg-surface': '#171a27',
    '--surface-input-background': 'rgba(14, 16, 24, 0.92)',
    '--bg-panel': '#181b28',
    '--surface-input-background-strong': 'rgba(11, 13, 20, 0.78)',
    '--text-primary': '#f3f4fc',
    '--accent': '#6d82ff',
    '--accent-cyan': '#16e9ff',
    '--border-default': 'rgba(112, 118, 147, 0.14)',
    '--mermaid-node-label-bg': '#10293a',
    '--mermaid-node-label-border': '#16e9ff',
    '--mermaid-node-label-text': '#dffcff',
    color: '#f3f4fc',
  });
  const mermaidUtils = loadRendererMermaidUtils();

  const theme = mermaidUtils.buildThemeConfig();

  assert.equal(theme.config.darkMode, true);
  assert.equal(theme.config.themeVariables.primaryColor, '#10293a');
  assert.equal(theme.config.themeVariables.primaryBorderColor, '#16e9ff');
  assert.equal(theme.config.themeVariables.primaryTextColor, '#dffcff');
  assert.deepEqual(theme.labelStyles, {
    containerFill: '#10293a',
    containerStroke: '#16e9ff',
    textColor: '#dffcff',
  });
});

test('createMermaidFrame creates a sandboxed iframe and dispose removes it', (t) => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');

  const dispose = mermaidUtils.createMermaidFrame(host, 'flowchart TD\nA-->B');
  const iframe = host.querySelector('iframe');

  assert.ok(iframe);
  assert.equal(iframe.getAttribute('src'), 'mermaid-frame.html');
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(iframe.style.width, '100%');
  assert.equal(iframe.style.border, '0px');
  assert.equal(iframe.style.height, '80px');

  dispose();
  assert.equal(host.querySelector('iframe'), null);
});

test('createMermaidFrame posts a render request on load and updates height on success', async (t) => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  let successPayload = null;

  mermaidUtils.createMermaidFrame(host, 'flowchart TD\nA-->B', {
    onSuccess(payload) {
      successPayload = payload;
    },
  });

  const iframe = host.querySelector('iframe');
  assert.ok(iframe);
  const frameWindow = ensureFrameWindow(iframe);
  const postedMessages = [];
  frameWindow.postMessage = (payload, targetOrigin) => {
    postedMessages.push({ payload, targetOrigin });
  };

  iframe.dispatchEvent(new dom.window.Event('load'));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].payload.type, 'render');
  assert.equal(postedMessages[0].payload.source, 'flowchart TD\nA-->B');
  assert.equal(postedMessages[0].payload.config.securityLevel, 'strict');
  assert.equal(typeof postedMessages[0].payload.labelStyles, 'object');
  assert.match(postedMessages[0].payload.labelStyles.containerFill, /^#[0-9a-f]{6}$/i);
  assert.match(postedMessages[0].payload.labelStyles.containerStroke, /^#[0-9a-f]{6}$/i);
  assert.match(postedMessages[0].payload.labelStyles.textColor, /^#[0-9a-f]{6}$/i);
  assert.equal(postedMessages[0].payload.requestId.startsWith('mermaid-frame-'), true);
  assert.equal(postedMessages[0].targetOrigin, '*');

  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: { postMessage() {} },
    origin: 'https://example.com',
    data: {
      type: 'rendered',
      requestId: postedMessages[0].payload.requestId,
      ok: true,
      height: 999,
    },
  }));

  assert.equal(iframe.style.height, '80px');
  assert.equal(successPayload, null);

  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: frameWindow,
    origin: 'null',
    data: {
      type: 'rendered',
      requestId: postedMessages[0].payload.requestId,
      ok: true,
      height: 180,
    },
  }));

  assert.equal(iframe.style.height, '180px');
  assert.equal(successPayload.ok, true);

  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: frameWindow,
    origin: 'null',
    data: {
      type: 'height',
      requestId: postedMessages[0].payload.requestId,
      height: 220,
    },
  }));

  assert.equal(iframe.style.height, '220px');
});

test('createMermaidFrame tears down when the host disconnects from the document', async (t) => {
  const dom = new JSDOM('<div id="root"><div id="host"></div></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const root = dom.window.document.getElementById('root');
  const host = dom.window.document.getElementById('host');
  let successCalls = 0;

  mermaidUtils.createMermaidFrame(host, 'flowchart TD\nA-->B', {
    onSuccess() {
      successCalls += 1;
    },
  });

  const iframe = host.querySelector('iframe');
  assert.ok(iframe);
  const frameWindow = ensureFrameWindow(iframe);
  const postedMessages = [];
  frameWindow.postMessage = (payload) => {
    postedMessages.push(payload);
  };

  host.remove();
  root.appendChild(dom.window.document.createElement('div'));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  iframe.dispatchEvent(new dom.window.Event('load'));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(postedMessages.length, 0);

  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: frameWindow,
    origin: 'null',
    data: {
      type: 'rendered',
      requestId: 'ignored-after-disconnect',
      ok: true,
      height: 120,
    },
  }));

  assert.equal(successCalls, 0);
});

test('createMermaidFrame fails soft on render failure messages', async (t) => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  const failurePayloads = [];

  mermaidUtils.createMermaidFrame(host, 'flowchart TD\nA-->B', {
    onFailure(payload) {
      failurePayloads.push(payload);
    },
  });

  const iframe = host.querySelector('iframe');
  const frameWindow = ensureFrameWindow(iframe);
  const postedMessages = [];
  frameWindow.postMessage = (payload) => {
    postedMessages.push(payload);
  };

  iframe.dispatchEvent(new dom.window.Event('load'));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: frameWindow,
    origin: 'null',
    data: {
      type: 'rendered',
      requestId: postedMessages[0].requestId,
      ok: false,
      error: 'parse error',
    },
  }));

  assert.equal(failurePayloads.length, 1);
  assert.equal(failurePayloads[0].error, 'parse error');
  assert.equal(host.querySelector('iframe'), null);
});

test('createMermaidFrame times out when the frame never responds', async (t) => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  const failurePayloads = [];

  mermaidUtils.createMermaidFrame(host, 'flowchart TD\nA-->B', {
    timeoutMs: 10,
    onFailure(payload) {
      failurePayloads.push(payload);
    },
  });

  await new Promise((resolve) => dom.window.setTimeout(resolve, 25));

  assert.equal(failurePayloads.length, 1);
  assert.match(failurePayloads[0].error, /timed out/i);
  assert.equal(host.querySelector('iframe'), null);
});

test('createMermaidFrame posts sanitized flowchart source for unquoted parentheses labels', async (t) => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  const source = [
    'flowchart TD',
    '  A[Outer Ring (Barrier)] --> B{Inner Ring (Check)}',
    '  B --> C(Pathway (Ready))',
    '  C --> D[(1) Officially Assembled]',
    '  % comment',
  ].join('\n');

  mermaidUtils.createMermaidFrame(host, source);

  const iframe = host.querySelector('iframe');
  assert.ok(iframe);
  const frameWindow = ensureFrameWindow(iframe);
  const postedMessages = [];
  frameWindow.postMessage = (payload, targetOrigin) => {
    postedMessages.push({ payload, targetOrigin });
  };

  iframe.dispatchEvent(new dom.window.Event('load'));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].targetOrigin, '*');
  assert.equal(postedMessages[0].payload.source, [
    'flowchart TD',
    '  A["Outer Ring (Barrier)"] --> B{"Inner Ring (Check)"}',
    '  B --> C("Pathway (Ready)")',
    '  C --> D["(1) Officially Assembled"]',
    '  %% comment',
  ].join('\n'));
});

test('renderMermaidDirect sanitizes unquoted square, round, and brace labels with parentheses', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  let capturedSource = '';

  dom.window.mermaid = {
    initialize() {},
    async render(_renderId, source) {
      capturedSource = source;
      return {
        svg: '<svg viewBox="0 0 100 100"><g class="node"><rect class="basic label-container"></rect><g class="label"><text>Preview</text></g></g></svg>',
      };
    },
  };

  await mermaidUtils.renderMermaidDirect(host, [
    'flowchart TD',
    '  A[Outer Ring (Barrier)] --> B{Inner Ring (Check)}',
    '  B --> C(Pathway (Ready))',
  ].join('\n'));

  assert.equal(capturedSource, [
    'flowchart TD',
    '  A["Outer Ring (Barrier)"] --> B{"Inner Ring (Check)"}',
    '  B --> C("Pathway (Ready)")',
  ].join('\n'));
  assert.ok(host.querySelector('svg'));
});

test('renderMermaidDirect preserves already quoted labels while normalizing single-percent comments', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  let capturedSource = '';

  dom.window.mermaid = {
    initialize() {},
    async render(_renderId, source) {
      capturedSource = source;
      return {
        svg: '<svg viewBox="0 0 100 100"><g class="node"><rect class="basic label-container"></rect><g class="label"><text>Preview</text></g></g></svg>',
      };
    },
  };

  await mermaidUtils.renderMermaidDirect(host, [
    'flowchart TD',
    '  A["Outer Ring (Barrier)"] --> B{"Inner Ring (Check)"}',
    '  B --> C("Pathway (Ready)")',
    '  % comment',
  ].join('\n'));

  assert.equal(capturedSource, [
    'flowchart TD',
    '  A["Outer Ring (Barrier)"] --> B{"Inner Ring (Check)"}',
    '  B --> C("Pathway (Ready)")',
    '  %% comment',
  ].join('\n'));
});

test('renderMermaidDirect sanitizes compound Mermaid node shapes with parentheses', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  let capturedSource = '';

  dom.window.mermaid = {
    initialize() {},
    async render(_renderId, source) {
      capturedSource = source;
      return {
        svg: '<svg viewBox="0 0 100 100"><g class="node"><rect class="basic label-container"></rect><g class="label"><text>Preview</text></g></g></svg>',
      };
    },
  };

  await mermaidUtils.renderMermaidDirect(host, [
    'flowchart TD',
    '  A((Circle Shape (Keep)))',
    '  B[[Subroutine Shape (Keep)]]',
    '  C([Stadium Shape (Keep)])',
    '  D[(Cylinder Shape (Keep))]',
  ].join('\n'));

  assert.equal(capturedSource, [
    'flowchart TD',
    '  A(("Circle Shape (Keep)"))',
    '  B[["Subroutine Shape (Keep)"]]',
    '  C(["Stadium Shape (Keep)"])',
    '  D[("Cylinder Shape (Keep)")]',
  ].join('\n'));
});

test('renderMermaidDirect repairs malformed bracket-compound labels that should render as square nodes', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  let capturedSource = '';

  dom.window.mermaid = {
    initialize() {},
    async render(_renderId, source) {
      capturedSource = source;
      return {
        svg: '<svg viewBox="0 0 100 100"><g class="node"><rect class="basic label-container"></rect><g class="label"><text>Preview</text></g></g></svg>',
      };
    },
  };

  await mermaidUtils.renderMermaidDirect(host, [
    'flowchart TD',
    '  A[(1) Officially Assembled]',
  ].join('\n'));

  assert.equal(capturedSource, [
    'flowchart TD',
    '  A["(1) Officially Assembled"]',
  ].join('\n'));
});

test('renderMermaidDirect leaves compound Mermaid node shapes without parentheses unchanged', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  let capturedSource = '';

  dom.window.mermaid = {
    initialize() {},
    async render(_renderId, source) {
      capturedSource = source;
      return {
        svg: '<svg viewBox="0 0 100 100"><g class="node"><rect class="basic label-container"></rect><g class="label"><text>Preview</text></g></g></svg>',
      };
    },
  };

  await mermaidUtils.renderMermaidDirect(host, [
    'flowchart TD',
    '  A((Circle Shape Keep))',
    '  B[[Subroutine Shape Keep]]',
    '  C([Stadium Shape Keep])',
    '  D[(Officially Assembled Ready)]',
  ].join('\n'));

  assert.equal(capturedSource, [
    'flowchart TD',
    '  A((Circle Shape Keep))',
    '  B[[Subroutine Shape Keep]]',
    '  C([Stadium Shape Keep])',
    '  D[(Officially Assembled Ready)]',
  ].join('\n'));
});

test('renderMermaidDirect reapplies Mermaid theme config when palette tokens change', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  const style = installPaletteTokens(dom, 'midnight', {
    '--bg-surface': '#171a27',
    '--surface-input-background': '#101724',
    '--bg-panel': '#181b28',
    '--surface-input-background-strong': '#141d2b',
    '--text-primary': '#f3f4fc',
    '--accent': '#6d82ff',
    '--accent-cyan': '#16e9ff',
    '--border-default': '#2a3a50',
    '--mermaid-node-label-bg': '#10293a',
    '--mermaid-node-label-border': '#16e9ff',
    '--mermaid-node-label-text': '#dffcff',
    color: '#f3f4fc',
  });
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  const initializeCalls = [];

  dom.window.mermaid = {
    initialize(config) {
      initializeCalls.push(config);
    },
    async render() {
      return {
        svg: '<svg viewBox="0 0 100 100"><g class="node"><rect class="basic label-container"></rect><g class="label"><text>Butterfly</text></g></g></svg>',
      };
    },
  };

  await mermaidUtils.renderMermaidDirect(host, 'flowchart TD\nA-->B');
  const firstRect = host.querySelector('rect.basic.label-container');
  assert.equal(initializeCalls.length, 1);
  assert.equal(firstRect.getAttribute('fill'), '#10293a');

  style.textContent = ':root {'
    + '--bg-surface: #171a27;'
    + '--surface-input-background: #101724;'
    + '--bg-panel: #181b28;'
    + '--surface-input-background-strong: #141d2b;'
    + '--text-primary: #f3f4fc;'
    + '--accent: #6d82ff;'
    + '--accent-cyan: #16e9ff;'
    + '--border-default: #2a3a50;'
    + '--mermaid-node-label-bg: #18374b;'
    + '--mermaid-node-label-border: #7aa8ff;'
    + '--mermaid-node-label-text: #ffffff;'
    + 'color: #f3f4fc;'
    + '}';

  await mermaidUtils.renderMermaidDirect(host, 'flowchart TD\nA-->B');
  const secondRect = host.querySelector('rect.basic.label-container');
  assert.equal(initializeCalls.length, 2);
  assert.equal(secondRect.getAttribute('fill'), '#18374b');
  assert.equal(secondRect.getAttribute('stroke'), '#7aa8ff');
});

test('renderMermaidDirect normalizes basic and polygon Mermaid label containers', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  installPaletteTokens(dom, 'signal', {
    '--bg-surface': '#0f1926',
    '--surface-input-background': '#0b1622',
    '--bg-panel': '#101b29',
    '--surface-input-background-strong': '#0c1724',
    '--text-primary': '#f4fbff',
    '--accent': '#29c0ff',
    '--accent-cyan': '#12d9ff',
    '--border-default': '#20415b',
    '--mermaid-node-label-bg': '#123046',
    '--mermaid-node-label-border': '#29c0ff',
    '--mermaid-node-label-text': '#e8fbff',
    color: '#f4fbff',
  });
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');

  dom.window.mermaid = {
    initialize() {},
    async render() {
      return {
        svg: [
          '<svg viewBox="0 0 100 100">',
          '<g class="node">',
          '<rect class="basic label-container"></rect>',
          '<g class="label"><text>Rect node</text></g>',
          '</g>',
          '<g class="node">',
          '<polygon class="label-container"></polygon>',
          '<g class="label"><text>Diamond node</text></g>',
          '</g>',
          '</svg>',
        ].join(''),
      };
    },
  };

  await mermaidUtils.renderMermaidDirect(host, 'flowchart TD\nA-->B');

  const rectNode = host.querySelector('rect.basic.label-container');
  const polygonNode = host.querySelector('polygon.label-container');
  const labelTexts = host.querySelectorAll('.node .label text');

  assert.equal(rectNode.getAttribute('fill'), '#123046');
  assert.equal(rectNode.getAttribute('stroke'), '#29c0ff');
  assert.equal(polygonNode.getAttribute('fill'), '#123046');
  assert.equal(polygonNode.getAttribute('stroke'), '#29c0ff');
  assert.equal(labelTexts[0].getAttribute('fill'), '#e8fbff');
  assert.equal(labelTexts[1].getAttribute('fill'), '#e8fbff');
});

test('attachMermaidControls adds toolbar controls including fullscreen', (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const preview = createInteractivePreview(dom);

  mermaidUtils.attachMermaidControls(preview);

  assert.ok(preview.querySelector('.mermaid-viewport'));
  assert.ok(preview.querySelector('.mermaid-controls'));
  assert.ok(preview.querySelector('[title="Zoom out"]'));
  assert.ok(preview.querySelector('[title="Zoom in"]'));
  assert.ok(preview.querySelector('[title="Reset view"]'));
  assert.ok(preview.querySelector('[title="Enter fullscreen"]'));
});

test('attachMermaidControls fullscreen control carries an inline SVG expand glyph, not the "[]" text', (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const preview = createInteractivePreview(dom);

  mermaidUtils.attachMermaidControls(preview);

  const fullscreenButton = preview.querySelector('[title="Enter fullscreen"]');
  assert.ok(fullscreenButton, 'fullscreen control should exist');
  const glyph = fullscreenButton.querySelector('svg');
  assert.ok(glyph, 'fullscreen control should carry an inline SVG glyph');
  assert.equal(glyph.getAttribute('stroke'), 'currentColor');
  assert.equal(glyph.getAttribute('aria-hidden'), 'true');
  assert.notEqual(fullscreenButton.textContent.trim(), '[]');
  assert.ok(fullscreenButton.getAttribute('aria-label'), 'fullscreen control keeps an aria-label');
});

test('attachMermaidControls fullscreen toggle moves the viewport into an overlay and restores it on close', (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const preview = createInteractivePreview(dom);

  mermaidUtils.attachMermaidControls(preview);

  const fullscreenButton = preview.querySelector('[title="Enter fullscreen"]');
  const viewport = preview.querySelector('.mermaid-viewport');
  const toolbar = preview.querySelector('.mermaid-controls');

  fullscreenButton.click();

  const overlay = dom.window.document.querySelector('.mermaid-fullscreen-overlay');
  assert.ok(overlay);
  assert.equal(overlay.getAttribute('role'), 'dialog');
  assert.equal(overlay.getAttribute('aria-modal'), 'true');
  assert.equal(overlay.querySelector('.mermaid-viewport'), viewport);
  assert.equal(overlay.querySelector('.mermaid-controls'), toolbar);
  assert.equal(preview.querySelector('.mermaid-viewport'), null);
  assert.equal(preview.querySelector('.mermaid-controls'), null);
  assert.equal(dom.window.document.body.classList.contains('mermaid-fullscreen-open'), true);
  assert.equal(fullscreenButton.getAttribute('title'), 'Exit fullscreen');

  fullscreenButton.click();

  assert.equal(dom.window.document.querySelector('.mermaid-fullscreen-overlay'), null);
  assert.equal(preview.querySelector('.mermaid-viewport'), viewport);
  assert.equal(preview.querySelector('.mermaid-controls'), toolbar);
  assert.equal(dom.window.document.body.classList.contains('mermaid-fullscreen-open'), false);
  assert.equal(fullscreenButton.getAttribute('title'), 'Enter fullscreen');
});

test('attachMermaidControls closes fullscreen on Escape and restores the preview host', (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const preview = createInteractivePreview(dom);

  mermaidUtils.attachMermaidControls(preview);

  const fullscreenButton = preview.querySelector('[title="Enter fullscreen"]');
  const viewport = preview.querySelector('.mermaid-viewport');
  const toolbar = preview.querySelector('.mermaid-controls');

  fullscreenButton.click();
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  assert.equal(dom.window.document.querySelector('.mermaid-fullscreen-overlay'), null);
  assert.equal(preview.querySelector('.mermaid-viewport'), viewport);
  assert.equal(preview.querySelector('.mermaid-controls'), toolbar);
  assert.equal(dom.window.document.body.classList.contains('mermaid-fullscreen-open'), false);
});

test('attachMermaidControls closes fullscreen on backdrop click and restores the preview host', (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const preview = createInteractivePreview(dom);

  mermaidUtils.attachMermaidControls(preview);

  const fullscreenButton = preview.querySelector('[title="Enter fullscreen"]');
  const viewport = preview.querySelector('.mermaid-viewport');
  const toolbar = preview.querySelector('.mermaid-controls');

  fullscreenButton.click();
  const overlay = dom.window.document.querySelector('.mermaid-fullscreen-overlay');
  assert.ok(overlay);

  overlay.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.equal(dom.window.document.querySelector('.mermaid-fullscreen-overlay'), null);
  assert.equal(preview.querySelector('.mermaid-viewport'), viewport);
  assert.equal(preview.querySelector('.mermaid-controls'), toolbar);
  assert.equal(dom.window.document.body.classList.contains('mermaid-fullscreen-open'), false);
});

test('attachMermaidControls moves focus into fullscreen and restores the prior focused element on close', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><button id="before">Before</button></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const beforeButton = dom.window.document.getElementById('before');
  const preview = createInteractivePreview(dom);

  mermaidUtils.attachMermaidControls(preview);

  beforeButton.focus();
  const fullscreenButton = preview.querySelector('[title="Enter fullscreen"]');
  fullscreenButton.click();

  assert.equal(dom.window.document.activeElement, fullscreenButton);

  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  assert.equal(dom.window.document.activeElement, beforeButton);
});

test('attachMermaidControls tears down fullscreen state when the preview disconnects from the document', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');
  const preview = createInteractivePreview(dom);
  host.appendChild(preview);

  mermaidUtils.attachMermaidControls(preview);

  const fullscreenButton = preview.querySelector('[title="Enter fullscreen"]');
  fullscreenButton.click();
  assert.ok(dom.window.document.querySelector('.mermaid-fullscreen-overlay'));

  preview.remove();
  host.appendChild(dom.window.document.createElement('div'));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.equal(dom.window.document.querySelector('.mermaid-fullscreen-overlay'), null);
  assert.equal(dom.window.document.body.classList.contains('mermaid-fullscreen-open'), false);
});

test('attachMermaidControls traps Tab navigation inside the fullscreen dialog', (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const preview = createInteractivePreview(dom);

  mermaidUtils.attachMermaidControls(preview);

  const fullscreenButton = preview.querySelector('[title="Enter fullscreen"]');
  fullscreenButton.click();

  const buttons = Array.from(dom.window.document.querySelectorAll('.mermaid-fullscreen-overlay .mermaid-control-btn'));
  assert.equal(dom.window.document.activeElement, fullscreenButton);

  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(dom.window.document.activeElement, buttons[0]);

  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  assert.equal(dom.window.document.activeElement, fullscreenButton);
});

test('renderMermaidDirect lazy-loads the Mermaid runtime via scriptLoaderUtils when absent', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');

  // No window.mermaid yet — the runtime must be injected on first render.
  const initializeConfigs = [];
  let ensureCalls = 0;
  const previousLoader = global.scriptLoaderUtils;
  global.scriptLoaderUtils = {
    ensureScript(opts) {
      ensureCalls += 1;
      dom.window.mermaid = {
        initialize(config) { initializeConfigs.push(config); },
        async render() {
          return { svg: '<svg viewBox="0 0 100 100"><rect width="100" height="100"></rect></svg>' };
        },
      };
      return Promise.resolve(Boolean(opts.isReady()));
    },
  };
  t.after(() => { global.scriptLoaderUtils = previousLoader; });

  let succeeded = false;
  await mermaidUtils.renderMermaidDirect(host, 'flowchart TD\nA-->B', {
    onSuccess() { succeeded = true; },
  });

  assert.equal(ensureCalls, 1, 'the Mermaid runtime should be injected exactly once');
  assert.ok(succeeded, 'expected the diagram to render after the runtime was injected');
  assert.ok(host.querySelector('svg'), 'expected SVG output in the host');
  // Protective init (startOnLoad:false) on load, plus the theme init in renderMermaidDirect.
  assert.ok(
    initializeConfigs.some((config) => config && config.startOnLoad === false),
    'expected a protective startOnLoad:false initialize after the runtime loaded'
  );
});

test('renderMermaidDirect surfaces failure gracefully when the Mermaid runtime cannot load', async (t) => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  installDomGlobals(dom, t);
  const mermaidUtils = loadRendererMermaidUtils();
  const host = dom.window.document.getElementById('host');

  const previousLoader = global.scriptLoaderUtils;
  global.scriptLoaderUtils = {
    ensureScript() { return Promise.resolve(false); },
  };
  t.after(() => { global.scriptLoaderUtils = previousLoader; });

  let failure = null;
  await mermaidUtils.renderMermaidDirect(host, 'flowchart TD\nA-->B', {
    onFailure(payload) { failure = payload; },
  });

  assert.ok(failure && failure.ok === false, 'expected a graceful failure payload when the runtime is unavailable');
});
