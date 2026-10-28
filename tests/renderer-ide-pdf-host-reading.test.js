'use strict';

// Row 65 W2/W3 through the pane API: the sidebar toggle (button and F4) and
// the reading context the chat reads (peek vs want, page tracking).

const test = require('node:test');
const assert = require('node:assert/strict');

const { FakePDFViewer, click, keydown, loadFixture, makePane, tick } = require('./helpers/ide-pdf-pane-harness');

async function openShown(env, filePath = 'docs/text.pdf') {
  await loadFixture(env, filePath);
  env.pane.show(filePath);
  const document = env.harness.documents.at(-1);
  document.textCalls = [];
  document.getPage = async (page) => ({
    getTextContent: async () => {
      document.textCalls.push(page);
      return { items: [{ str: `Text of page ${page}`, hasEOL: true }] };
    },
  });
  return { document, viewer: FakePDFViewer.instances.at(-1) };
}

test('the sidebar toggles from its button and F4, and the button reports it', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await openShown(env);
  const sidebar = env.host.querySelector('.ide-pdf-sidebar');
  const toggle = env.host.querySelector('[data-ide-pdf-action="sidebar"]');
  const wasOpen = !sidebar.hidden;
  assert.equal(toggle.getAttribute('aria-pressed'), String(wasOpen));

  click(env, '[data-ide-pdf-action="sidebar"]');
  assert.equal(sidebar.hidden, wasOpen);
  assert.equal(toggle.getAttribute('aria-pressed'), String(!wasOpen));

  const event = keydown(env, env.host.querySelector('.ide-pdf-viewer-scroll'), { key: 'F4' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(sidebar.hidden, !wasOpen);
  assert.equal(toggle.getAttribute('aria-pressed'), String(wasOpen));
});

test('the reading context peeks without extracting, then extracts once wanted', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  const { document } = await openShown(env);
  const changes = [];
  env.dom.window.addEventListener('ide:pdf-reading-context-changed', (event) => changes.push(event.detail.path));

  const peek = env.pane.getReadingContext('docs/text.pdf');
  assert.equal(peek.page, 1);
  assert.equal(peek.pageCount, 2);
  assert.equal(peek.textState, 'pending');
  await tick();
  assert.deepEqual(document.textCalls, []);

  assert.equal(env.pane.getReadingContext('docs/text.pdf', { want: true }).textState, 'pending');
  await tick();
  await tick();
  const ready = env.pane.getReadingContext('docs/text.pdf', { want: true });
  assert.equal(ready.textState, 'ready');
  assert.equal(ready.text, 'Text of page 1\n');
  assert.deepEqual(document.textCalls, [1]);
  assert.ok(changes.includes('docs/text.pdf'));
});

test('the reading context follows the page being read', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  const { document, viewer } = await openShown(env);
  env.pane.getReadingContext('docs/text.pdf', { want: true });
  viewer.options.eventBus.dispatch('pagechanging', { pageNumber: 2 });
  // The reading context lets a page settle (150 ms) before extracting it.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await tick();
  const context = env.pane.getReadingContext('docs/text.pdf', { want: true });
  assert.equal(context.page, 2);
  assert.equal(context.text, 'Text of page 2\n');
  assert.deepEqual(document.textCalls, [1, 2]);
});

test('no reading context for an unknown or closed document', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  assert.equal(env.pane.getReadingContext('docs/none.pdf'), null);
  await openShown(env);
  env.pane.close('docs/text.pdf');
  assert.equal(env.pane.getReadingContext('docs/text.pdf', { want: true }), null);
});
