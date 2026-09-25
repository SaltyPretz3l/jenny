const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const MarkdownUtils = require('../renderer/shared/markdown-utils');
const CodeBlock = require('../renderer/inventory/codeblock');

const TABLE_MARKDOWN = [
  '| H1 | H2 |',
  '| --- | --- |',
  '| r1c1 | r1 c2 |',
  '| r2c1 | r2c2 |',
].join('\n');
const EXPECTED_TSV = 'H1\tH2\nr1c1\tr1 c2\nr2c1\tr2c2';

test('rendered Markdown tables receive one copy toolbar across re-decoration', () => {
  const rendered = MarkdownUtils.renderMarkdown(TABLE_MARKDOWN + '\n\n' + TABLE_MARKDOWN);
  const firstDocument = new JSDOM(rendered).window.document;
  const wrappers = firstDocument.querySelectorAll('.markdown-table-wrapper');

  assert.equal(wrappers.length, 2);
  wrappers.forEach((wrapper) => {
    assert.equal(wrapper.querySelectorAll(':scope > .markdown-table-header').length, 1);
    assert.equal(wrapper.querySelectorAll(':scope > .markdown-table-header > .inv-table-copy').length, 1);
  });

  const redecorated = MarkdownUtils.renderMarkdown(rendered, { rawHtml: 'sanitize' });
  const secondDocument = new JSDOM(redecorated).window.document;
  const redecoratedWrappers = secondDocument.querySelectorAll('.markdown-table-wrapper');
  assert.equal(redecoratedWrappers.length, 2);
  redecoratedWrappers.forEach((wrapper) => {
    assert.equal(wrapper.querySelectorAll(':scope > .markdown-table-header').length, 1);
  });
});

test('tableToTsv collapses cell whitespace and preserves row order', () => {
  const dom = new JSDOM(`
    <table>
      <thead><tr><th>H1</th><th>H2</th></tr></thead>
      <tbody>
        <tr><td>r1c1</td><td><code>r1</code>\n<br>\n c2</td></tr>
        <tr><td>r2c1</td><td>r2c2</td></tr>
      </tbody>
    </table>
  `);

  assert.equal(CodeBlock.tableToTsv(dom.window.document.querySelector('table')), EXPECTED_TSV);
  assert.equal(CodeBlock.tableToTsv(dom.window.document.createElement('table')), '');
  dom.window.close();
});

test('tableToTsv preserves visual boundaries and scopes nested table content', () => {
  const rendered = MarkdownUtils.renderMarkdown(`
    <table>
      <thead><tr><th>Kind</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>break</td><td>first<br>second</td></tr>
        <tr><td>blocks</td><td><p>alpha</p><p>beta</p></td></tr>
        <tr><td>nested</td><td>before<table><tbody><tr><td>inner one</td><td>inner two</td></tr></tbody></table>after</td></tr>
      </tbody>
    </table>
  `, { rawHtml: 'sanitize' });
  const dom = new JSDOM(rendered);
  const outerTable = dom.window.document.querySelector('.markdown-table-wrapper > table');

  assert.equal(
    CodeBlock.tableToTsv(outerTable),
    'Kind\tValue\nbreak\tfirst second\nblocks\talpha beta\nnested\tbefore inner one inner two after'
  );
  dom.window.close();
});

test('table copy uses shared clipboard feedback and timed reset', async (t) => {
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
  let copiedText = null;
  Object.defineProperty(global.navigator, 'clipboard', {
    value: { writeText: (text) => { copiedText = text; return Promise.resolve(); } },
    configurable: true,
  });
  const timers = [];
  global.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };

  const root = dom.window.document.getElementById('root');
  root.innerHTML = MarkdownUtils.renderMarkdown(TABLE_MARKDOWN);
  CodeBlock.initCopyHandlers(dom.window.document);
  const button = root.querySelector('.inv-table-copy');
  button.click();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(copiedText, EXPECTED_TSV);
  assert.equal(button.textContent, 'Copied');
  assert.equal(button.getAttribute('data-copy-status'), 'copied');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1500);

  timers[0].callback();
  assert.equal(button.textContent, 'Copy');
  assert.equal(button.hasAttribute('data-copy-status'), false);
  dom.window.close();
});
