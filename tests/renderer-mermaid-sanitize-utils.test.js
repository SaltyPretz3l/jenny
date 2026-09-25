const test = require('node:test');
const assert = require('node:assert/strict');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const {
  sanitizeMermaidPreviewSource,
  sanitizeMermaidSource,
  sanitizeMermaidSvgMarkup,
} = require('../renderer/features/renderer-mermaid-sanitize-utils');

function loadRendererMermaidUtils() {
  const loaderPath = require.resolve('../renderer/features/renderer-mermaid-runtime-loader');
  delete require.cache[loaderPath];
  const modulePath = require.resolve('../renderer/features/renderer-mermaid-utils');
  delete require.cache[modulePath];
  return require('../renderer/features/renderer-mermaid-utils');
}

async function assertDirectRenderFailsClosed(t, installDOMPurify) {
  const dom = new JSDOM('<div id="host"><svg id="stale"></svg></div>', { url: 'http://localhost/' });
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  });
  installDOMPurify(dom.window);
  dom.window.mermaid = {
    initialize() {},
    async render() {
      return { svg: '<svg><path d="M0 0"></path></svg>' };
    },
  };
  const host = dom.window.document.getElementById('host');
  const source = 'flowchart TD\nA-->B';
  const failures = [];

  await loadRendererMermaidUtils().renderMermaidDirect(host, source, {
    onFailure(payload) {
      failures.push(payload);
      host.textContent = `Preview unavailable. ${source}`;
    },
  });

  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /failed sanitization/i);
  assert.match(host.textContent, /Preview unavailable/);
  assert.match(host.textContent, /flowchart TD/);
  assert.equal(host.querySelector('svg'), null);
}

test('sanitizeMermaidSource repairs single-percent comments without changing directives', () => {
  assert.equal(
    sanitizeMermaidSource([
      'flowchart TD',
      '  % ordinary comment',
      '  %% already valid',
      '  %%{init: {"theme": "base"}}%%',
    ].join('\n')),
    [
      'flowchart TD',
      '  %% ordinary comment',
      '  %% already valid',
      '  %%{init: {"theme": "base"}}%%',
    ].join('\n')
  );
});

test('sanitizeMermaidSource preserves literal percentages in labels and sequence messages', () => {
  assert.equal(
    sanitizeMermaidSource('flowchart TD\nA[CPU 50% used]'),
    'flowchart TD\nA[CPU 50% used]'
  );
  assert.equal(
    sanitizeMermaidSource('sequenceDiagram\nA->>B: progress 50% complete'),
    'sequenceDiagram\nA->>B: progress 50% complete'
  );
});

test('sanitizeMermaidPreviewSource quotes flowchart labels with parentheses', () => {
  assert.equal(
    sanitizeMermaidPreviewSource([
      'flowchart TD',
      '  A[Outer Ring (Barrier)] --> B{Inner Ring (Check)}',
      '  B --> C(Pathway (Ready))',
      '  C --> D[(1) Officially Assembled]',
    ].join('\n')),
    [
      'flowchart TD',
      '  A["Outer Ring (Barrier)"] --> B{"Inner Ring (Check)"}',
      '  B --> C("Pathway (Ready)")',
      '  C --> D["(1) Officially Assembled"]',
    ].join('\n')
  );
});

test('sanitizeMermaidPreviewSource leaves non-flowchart diagrams unchanged except comments', () => {
  assert.equal(
    sanitizeMermaidPreviewSource('sequenceDiagram\n  A->>B: call (ok)\n  % note'),
    'sequenceDiagram\n  A->>B: call (ok)\n  %% note'
  );
});

test('sanitizeMermaidSvgMarkup strips scripts, event handlers, and javascript urls', (t) => {
  const dom = new JSDOM('');
  t.after(() => dom.window.close());
  dom.window.DOMPurify = createDOMPurify(dom.window);
  const sanitized = sanitizeMermaidSvgMarkup([
    '<svg onclick="alert(1)">',
    '<script>alert(1)</script>',
    '<a href="javascript:alert(1)" onfocus="bad()">bad</a>',
    '<image src="javascript:alert(2)" onload="bad()" />',
    '<path d="M0 0" />',
    '</svg>',
  ].join(''), dom.window);

  assert.doesNotMatch(sanitized, /<script/i);
  assert.doesNotMatch(sanitized, /\son[a-z]+=/i);
  assert.doesNotMatch(sanitized, /javascript:/i);
  assert.match(sanitized, /<path d="M0 0"/);
});

test('sanitizeMermaidSvgMarkup returns empty when DOMPurify is missing', () => {
  assert.equal(sanitizeMermaidSvgMarkup('<svg><path d="M0 0"></path></svg>', {}), '');
});

test('renderMermaidDirect shows fallback source without inline SVG when DOMPurify is missing', async (t) => {
  await assertDirectRenderFailsClosed(t, () => {});
});

test('sanitizeMermaidSvgMarkup returns empty when DOMPurify throws', () => {
  const windowRef = { DOMPurify: { sanitize() { throw new Error('purifier failed'); } } };
  assert.equal(sanitizeMermaidSvgMarkup('<svg><path d="M0 0"></path></svg>', windowRef), '');
});

test('renderMermaidDirect shows fallback source without inline SVG when DOMPurify throws', async (t) => {
  await assertDirectRenderFailsClosed(t, (windowRef) => {
    windowRef.DOMPurify = { sanitize() { throw new Error('purifier failed'); } };
  });
});
