const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const CodeBlock = require('../renderer/inventory/codeblock');

test('copy buttons mirror their accessible label in the title', () => {
  const textHtml = CodeBlock.codeblock({ code: 'x', copyable: true });
  const iconHtml = CodeBlock.codeblock({ code: 'x', label: 'Output', copyable: true, copyIcon: true });

  assert.ok(textHtml.includes('title="Copy code" aria-label="Copy code"'));
  assert.ok(iconHtml.includes('title="Copy output" aria-label="Copy output"'));
});

test('repeated icon copies restore the immutable accessible label', async (t) => {
  const previousDocument = global.document;
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  const previousSetTimeout = global.setTimeout;
  t.after(() => {
    global.document = previousDocument;
    global.setTimeout = previousSetTimeout;
    if (previousNavigatorDescriptor) Object.defineProperty(global, 'navigator', previousNavigatorDescriptor);
    else delete global.navigator;
  });

  const dom = new JSDOM('<div id="root"></div>');
  global.document = dom.window.document;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(global.navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
  });
  const resetCallbacks = [];
  global.setTimeout = (callback) => {
    resetCallbacks.push(callback);
    return resetCallbacks.length;
  };

  const root = dom.window.document.getElementById('root');
  root.innerHTML = CodeBlock.codeblock({
    code: 'value', label: 'Output', copyable: true, copyIcon: true, copyId: 'cp-out',
  });
  CodeBlock.initCopyHandlers(dom.window.document);
  const button = root.querySelector('.inv-codeblock-copy');

  button.click();
  await Promise.resolve();
  await Promise.resolve();
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  resetCallbacks.forEach((callback) => callback());

  assert.equal(button.getAttribute('aria-label'), 'Copy output');
  assert.equal(button.hasAttribute('data-copy-status'), false);
  dom.window.close();
});

test('throwing execCommand fallback removes its temporary textarea', (t) => {
  const previousDocument = global.document;
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  const previousSetTimeout = global.setTimeout;
  t.after(() => {
    global.document = previousDocument;
    global.setTimeout = previousSetTimeout;
    if (previousNavigatorDescriptor) Object.defineProperty(global, 'navigator', previousNavigatorDescriptor);
    else delete global.navigator;
  });

  const dom = new JSDOM('<div id="root"></div>');
  global.document = dom.window.document;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(global.navigator, 'clipboard', { value: undefined, configurable: true });
  global.document.execCommand = () => { throw new Error('copy unavailable'); };
  global.setTimeout = () => 1;

  const root = dom.window.document.getElementById('root');
  root.innerHTML = CodeBlock.codeblock({ code: 'value', copyable: true, copyId: 'cp-fallback' });
  CodeBlock.initCopyHandlers(dom.window.document);
  const button = root.querySelector('.inv-codeblock-copy');

  button.click();

  assert.equal(button.getAttribute('data-copy-status'), 'failed');
  assert.equal(dom.window.document.querySelectorAll('textarea').length, 0);
  dom.window.close();
});

test('wrap toggle click and non-button keyboard activation update block state', () => {
  const dom = new JSDOM('<div id="root"><div class="markdown-code-block inv-codeblock-wrap"><div class="markdown-code-header"><button class="inv-codeblock-wrap-toggle" aria-pressed="false">Wrap</button><div class="inv-codeblock-wrap-toggle" role="button" tabindex="0" aria-pressed="false">Wrap</div></div><pre><code>long line</code></pre></div></div>');
  const root = dom.window.document.getElementById('root');
  const block = root.querySelector('.markdown-code-block');
  const button = root.querySelector('button.inv-codeblock-wrap-toggle');
  const keyboardToggle = root.querySelector('div.inv-codeblock-wrap-toggle');
  CodeBlock.initCopyHandlers(dom.window.document);

  button.click();
  assert.equal(block.classList.contains('is-wrapped'), true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  button.click();
  assert.equal(block.classList.contains('is-wrapped'), false);
  assert.equal(button.getAttribute('aria-pressed'), 'false');

  keyboardToggle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(block.classList.contains('is-wrapped'), true);
  assert.equal(keyboardToggle.getAttribute('aria-pressed'), 'true');
  dom.window.close();
});
