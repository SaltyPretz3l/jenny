// A3: markdown mermaid expansion controls — ARIA + keyboard operability.
// Split out of tests/markdown-utils.test.js (file-size ceiling): the mermaid
// Native buttons own keyboard activation; these tests pin their ARIA state.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

function loadMarkdownUtils() {
  const modulePath = require.resolve('../renderer/shared/markdown-utils');
  delete require.cache[modulePath];
  return require('../renderer/shared/markdown-utils');
}

test('buildMermaidTimelineBlockMarkup outer toggle carries ARIA button contract', () => {
  const { buildMermaidTimelineBlockMarkup } = loadMarkdownUtils();
  const html = buildMermaidTimelineBlockMarkup('graph TD\nA-->B', 'tool-mermaid-aria-1');
  const toggleMatch = html.match(/<button[^>]*class="markdown-mermaid-outer-toggle"[^>]*>/);
  assert.ok(toggleMatch, `outer toggle markup missing: ${html}`);
  assert.match(toggleMatch[0], /type="button"/);
  assert.match(toggleMatch[0], /aria-expanded="true"/);
  const controlsMatch = toggleMatch[0].match(/aria-controls="([^"]+)"/);
  assert.ok(controlsMatch, `outer toggle missing aria-controls: ${toggleMatch[0]}`);
  assert.ok(html.includes('id="' + controlsMatch[1] + '"'), `aria-controls target id not found in markup: ${html}`);
});

test('decorateCodeBlocks (DOM path) mermaid outer toggle + source header have ARIA + keyboard toggle', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.rendererMermaidUtils = {
    renderMermaidDirect(host, _source, options) {
      host.innerHTML = '<iframe src="mermaid-frame.html"></iframe>';
      options?.onSuccess?.({ ok: true, height: 120 });
      return Promise.resolve();
    },
    attachMermaidControls() {},
  };
  const { renderMarkdown: renderMermaidMarkdown, renderInlineMermaidBlocks } = loadMarkdownUtils();

  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    dom.window.close();
  });

  const root = dom.window.document.getElementById('root');
  root.innerHTML = renderMermaidMarkdown('```mermaid\nflowchart TD\nA-->B\n```');
  const outerToggle = root.querySelector('.markdown-mermaid-outer-toggle');
  assert.equal(outerToggle.tagName, 'BUTTON');
  assert.equal(outerToggle.type, 'button');
  assert.equal(outerToggle.getAttribute('aria-expanded'), 'true', 'mermaid block starts expanded');
  const outerControlsId = outerToggle.getAttribute('aria-controls');
  assert.ok(outerControlsId, 'outer toggle must declare aria-controls');
  assert.ok(root.querySelector('#' + outerControlsId), 'aria-controls must resolve to an element in the tree');

  renderInlineMermaidBlocks(root);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));

  const sourceHeader = root.querySelector('.markdown-mermaid-source .markdown-code-header');
  const sourceToggle = sourceHeader.querySelector('.markdown-mermaid-source-toggle');
  const sourceCopy = sourceHeader.querySelector('.inv-codeblock-copy');
  assert.equal(sourceHeader.getAttribute('role'), null, 'toolbar must not be a synthetic control containing another control');
  assert.equal(sourceToggle.tagName, 'BUTTON');
  assert.equal(sourceCopy.tagName, 'BUTTON');
  assert.equal(sourceToggle.getAttribute('aria-expanded'), 'false', 'mermaid source starts collapsed');
  assert.equal(sourceToggle.contains(sourceCopy), false, 'source toggle and copy action must be siblings');
  const sourceControlsId = sourceToggle.getAttribute('aria-controls');
  assert.ok(sourceControlsId, 'source header must declare aria-controls');
  assert.ok(root.querySelector('#' + sourceControlsId), 'source aria-controls must resolve to an element in the tree');

  outerToggle.click();
  assert.equal(outerToggle.getAttribute('aria-expanded'), 'false', 'click must flip aria-expanded on the outer toggle');
  outerToggle.click();
  assert.equal(outerToggle.getAttribute('aria-expanded'), 'true', 'native button activation must flip aria-expanded back');

  sourceToggle.click();
  assert.equal(sourceToggle.getAttribute('aria-expanded'), 'true', 'click must flip aria-expanded on the source toggle');
  sourceToggle.click();
  assert.equal(sourceToggle.getAttribute('aria-expanded'), 'false', 'native button activation must flip aria-expanded back');
});

// A3: render FAILURE reveals the mermaid source (collapsed class removed)
// but must also flip the source header's aria-expanded to 'true' so a
// screen reader doesn't keep announcing a now-visible <pre> as collapsed.
test('decorateCodeBlocks (DOM path) mermaid onFailure reveals source and syncs aria-expanded to true', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.rendererMermaidUtils = {
    renderMermaidDirect(host, _source, options) {
      options?.onFailure?.(new Error('mermaid render failed'));
      return Promise.resolve();
    },
    attachMermaidControls() {},
  };
  const { renderMarkdown: renderMermaidMarkdown, renderInlineMermaidBlocks } = loadMarkdownUtils();

  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    dom.window.close();
  });

  const root = dom.window.document.getElementById('root');
  root.innerHTML = renderMermaidMarkdown('```mermaid\nflowchart TD\nA-->B\n```');

  renderInlineMermaidBlocks(root);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));

  const sourceNode = root.querySelector('.markdown-mermaid-source');
  assert.equal(
    sourceNode.classList.contains('markdown-mermaid-source-collapsed'),
    false,
    'onFailure must reveal the source (collapsed class removed)'
  );
  const sourceHeader = sourceNode.querySelector('.markdown-mermaid-source-toggle');
  assert.equal(
    sourceHeader.getAttribute('aria-expanded'),
    'true',
    'source header aria-expanded must match the now-visible source on render failure'
  );
});

test('Mermaid synchronous throws show a retry action and emit redacted diagnostics', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;
  const previousAppendClientLog = global.appendClientLog;
  const previousIO = global.IntersectionObserver;
  const logs = [];
  let attempts = 0;
  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.appendClientLog = (level, event, data) => logs.push({ level, event, data });
  global.rendererMermaidUtils = {
    renderMermaidDirect(host, _source, options) {
      attempts += 1;
      if (attempts === 1) throw new Error('C:\\secret\\diagram.mmd');
      host.innerHTML = '<iframe></iframe>';
      options.onSuccess();
      return Promise.resolve();
    },
    attachMermaidControls() {},
  };
  delete global.IntersectionObserver;
  const utils = loadMarkdownUtils();
  t.after(() => {
    utils.disposeMermaidLazyObserver();
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    global.appendClientLog = previousAppendClientLog;
    if (previousIO === undefined) delete global.IntersectionObserver;
    else global.IntersectionObserver = previousIO;
    dom.window.close();
  });

  const root = dom.window.document.getElementById('root');
  root.innerHTML = utils.renderMarkdown('```mermaid\nflowchart TD\nA-->B\n```');
  utils.renderInlineMermaidBlocks(root);
  const block = root.querySelector('.markdown-mermaid-block');
  assert.equal(block.getAttribute('data-mermaid-rendered'), 'failed');
  const retry = block.querySelector('.markdown-mermaid-retry');
  assert.equal(retry.tagName, 'BUTTON');
  retry.click();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(block.getAttribute('data-mermaid-rendered'), 'true');
  assert.equal(logs[0].event, 'markdown.mermaid_render_failed');
  assert.deepEqual(logs[0].data, { failureKind: 'sync_throw' });
  assert.doesNotMatch(JSON.stringify(logs), /secret|diagram\.mmd/i);
});

test('Mermaid promise rejection converges on the same bounded failure UI', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;
  const previousAppendClientLog = global.appendClientLog;
  const previousIO = global.IntersectionObserver;
  const logs = [];
  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.appendClientLog = (level, event, data) => logs.push({ level, event, data });
  global.rendererMermaidUtils = {
    renderMermaidDirect() {
      return Promise.reject(new Error('raw provider payload'));
    },
    attachMermaidControls() {},
  };
  delete global.IntersectionObserver;
  const utils = loadMarkdownUtils();
  t.after(() => {
    utils.disposeMermaidLazyObserver();
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    global.appendClientLog = previousAppendClientLog;
    if (previousIO === undefined) delete global.IntersectionObserver;
    else global.IntersectionObserver = previousIO;
    dom.window.close();
  });

  const root = dom.window.document.getElementById('root');
  root.innerHTML = utils.renderMarkdown('```mermaid\nflowchart TD\nA-->B\n```');
  utils.renderInlineMermaidBlocks(root);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  const block = root.querySelector('.markdown-mermaid-block');
  assert.equal(block.getAttribute('data-mermaid-rendered'), 'failed');
  assert.ok(block.querySelector('[role="status"] .markdown-mermaid-retry'));
  assert.deepEqual(logs[0].data, { failureKind: 'promise_rejection' });
  assert.doesNotMatch(JSON.stringify(logs), /provider payload/i);
});

test('late Mermaid completion cannot mutate a detached block', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;
  const previousIO = global.IntersectionObserver;
  let finish;
  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.rendererMermaidUtils = {
    renderMermaidDirect(_host, _source, options) {
      finish = options.onSuccess;
      return Promise.resolve();
    },
    attachMermaidControls() {},
  };
  delete global.IntersectionObserver;
  const utils = loadMarkdownUtils();
  t.after(() => {
    utils.disposeMermaidLazyObserver();
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    if (previousIO === undefined) delete global.IntersectionObserver;
    else global.IntersectionObserver = previousIO;
    dom.window.close();
  });

  const root = dom.window.document.getElementById('root');
  root.innerHTML = utils.renderMarkdown('```mermaid\nflowchart TD\nA-->B\n```');
  const block = root.querySelector('.markdown-mermaid-block');
  utils.renderInlineMermaidBlocks(root);
  block.remove();
  finish();
  assert.equal(block.getAttribute('data-mermaid-rendered'), 'pending');
  assert.equal(block.hasAttribute('data-virtualizer-pin-live'), false);
});

test('decorateCodeBlocks (DOM path) Show More/Less overlay ARIA flips and resolves aria-controls', () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  const CodeBlock = require('../renderer/inventory/codeblock');

  try {
    const { renderMarkdown: renderFn, clearMarkdownRenderCache } = loadMarkdownUtils();
    clearMarkdownRenderCache();
    const longCode = Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\n');
    const root = dom.window.document.getElementById('root');
    root.innerHTML = renderFn('```js\n' + longCode + '\n```');

    const overlay = root.querySelector('.markdown-code-expand-overlay');
    assert.ok(overlay, 'expected a collapsible code block to render an expand overlay');
    assert.equal(overlay.getAttribute('aria-expanded'), 'false', 'overlay starts collapsed');
    const controlsId = overlay.getAttribute('aria-controls');
    assert.ok(controlsId, 'overlay must declare aria-controls');
    assert.ok(root.querySelector('#' + controlsId), 'overlay aria-controls must resolve to an element in the tree');

    CodeBlock.initCopyHandlers(dom.window.document);
    overlay.click();
    assert.equal(overlay.getAttribute('aria-expanded'), 'true', 'click must flip aria-expanded to true when expanding');
    overlay.click();
    assert.equal(overlay.getAttribute('aria-expanded'), 'false', 'click must flip aria-expanded back to false when collapsing');
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  }
});
