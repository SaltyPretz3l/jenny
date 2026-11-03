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

// Security review item 15: an SVG <image>/<feImage> href is fetched on render and a
// <use> href can pull in an external document, so only inline raster images and
// in-document fragments survive the Mermaid/SVG sanitizer.
function sanitizeSvgWith(t, body, { policyHook = false } = {}) {
  const dom = new JSDOM('');
  t.after(() => dom.window.close());
  dom.window.DOMPurify = createDOMPurify(dom.window);
  if (policyHook) {
    dom.window.DOMPurify.addHook('afterSanitizeAttributes',
      require('../renderer/shared/markdown-sanitize-policy').hardenAttributes);
  }
  const sanitized = sanitizeMermaidSvgMarkup(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' + body + '</svg>',
    dom.window);
  return { sanitized, dom };
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const B = '\\';

test('Mermaid SVG image hrefs other than inline raster data URLs are removed', (t) => {
  for (const href of [
    'https://example.com/x.png', 'http://example.com/x.png', '//203.0.113.7/share/x.png',
    `${B}${B}host${B}share${B}x.png`, 'file://host/share/x.png', 'file:///C:/x.png',
    'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:text/html;base64,PGI+',
    'x.png',
  ]) {
    for (const attr of ['href', 'xlink:href']) {
      const { sanitized } = sanitizeSvgWith(t,
        `<image ${attr}="${href}" width="4" height="4"></image><filter id="f"><feImage ${attr}="${href}"></feImage></filter>`);
      assert.doesNotMatch(sanitized, /href=/i, `${attr}=${href} removed: ${sanitized}`);
      assert.match(sanitized, /<image\b/, 'the element itself stays');
    }
  }
});

test('Mermaid SVG image hrefs keep inline png, jpeg, gif and webp data URLs', (t) => {
  for (const href of [PNG, 'data:image/jpeg;base64,/9j/4AAQ', 'data:image/gif;base64,R0lGODlh',
    'data:image/webp;base64,UklGRg==']) {
    for (const attr of ['href', 'xlink:href']) {
      const { sanitized } = sanitizeSvgWith(t, `<image ${attr}="${href}" width="4" height="4"></image>`,
        { policyHook: true });
      assert.ok(sanitized.includes(`${attr}="${href}"`), `${attr}=${href} kept: ${sanitized}`);
    }
  }
});

// DOMPurify's svg profile does not allow <use> at all, so no href (external or a
// fragment) can pull a document in through it; pinned so a profile widening shows.
test('Mermaid SVG use elements are dropped whatever their href', (t) => {
  for (const href of ['https://example.com/s.svg#a', '//203.0.113.7/s.svg#a', 'file://host/s.svg#a',
    'sprites.svg#a', 'data:image/svg+xml;base64,PHN2Zy8+#a', '#a']) {
    for (const attr of ['href', 'xlink:href']) {
      const { sanitized } = sanitizeSvgWith(t, `<defs><path id="a" d="M0 0"></path></defs><use ${attr}="${href}"></use>`);
      assert.doesNotMatch(sanitized, /<use\b|href=/i, `${attr}=${href} dropped: ${sanitized}`);
      assert.match(sanitized, /<path id="a"/);
    }
  }
});

test('the image href rule does not outlive one Mermaid SVG sanitize call', (t) => {
  const { dom } = sanitizeSvgWith(t, '<image href="https://example.com/x.png"></image>');
  const html = dom.window.DOMPurify.sanitize('<svg><image href="https://example.com/x.png"></image></svg>');
  assert.match(html, /href="https:\/\/example\.com\/x\.png"/);
});
