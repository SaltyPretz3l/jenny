'use strict';

// renderer/shared/markdown-inline-paths.js: inline code that is a path becomes a chip. Row 95
// adds absolute paths, which only decorate while absolute_path_links is published on.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  parseInlineCodePathTarget,
  decorateInlinePathChips,
} = require('../renderer/shared/markdown-inline-paths');
const pathResolve = require('../renderer/shared/workspace-path-resolve');

function decorate(html) {
  const dom = new JSDOM(`<body><div id="root">${html}</div></body>`);
  const rootEl = dom.window.document.getElementById('root');
  decorateInlinePathChips(rootEl);
  return rootEl;
}

function enable(t, enabled = true) {
  pathResolve.setContextProvider(() => ({ enabled, workspaceRoot: 'G:\\ws' }));
  t.after(() => pathResolve.setContextProvider(null));
}

test('relative paths keep decorating exactly as before, flag or no flag', () => {
  assert.deepEqual(parseInlineCodePathTarget('src/app.js:4:2'), { path: 'src/app.js', line: 4, column: 2 });
  const code = decorate('<p><code>src/app.js:4</code></p>').querySelector('code');
  assert.equal(code.getAttribute('data-chat-path-open'), 'src/app.js');
  assert.equal(code.getAttribute('data-chat-path-line'), '4');
  assert.equal(code.hasAttribute('data-chat-path-kind'), false);
});

test('absolute inline paths stay plain until absolute links are published on', (t) => {
  const html = '<p><code>G:\\ws\\src\\a.js</code></p>';
  assert.equal(decorate(html).querySelector('[data-chat-path-open]'), null, 'no provider');
  enable(t, false);
  assert.equal(decorate(html).querySelector('[data-chat-path-open]'), null, 'flag off');
});

test('with absolute links on, Windows, POSIX and file URL paths become chips; folders are marked', (t) => {
  enable(t);
  const rootEl = decorate(
    '<p><code>G:\\ws\\src\\a.js:42:7</code> <code>/home/me/ws/b.py</code> <code>G:\\ws\\lib\\</code>'
      + ' <code>file:///G:/ws/c%20d.md</code></p>'
  );
  const chips = Array.from(rootEl.querySelectorAll('code'));
  assert.deepEqual(chips.map((c) => c.getAttribute('data-chat-path-open')), [
    'G:/ws/src/a.js', '/home/me/ws/b.py', 'G:/ws/lib/', 'G:/ws/c d.md',
  ]);
  assert.equal(chips[0].getAttribute('data-chat-path-line'), '42');
  assert.equal(chips[0].getAttribute('data-chat-path-column'), '7');
  assert.equal(chips[2].getAttribute('data-chat-path-kind'), 'dir');
  assert.ok(chips.every((c) => c.getAttribute('role') === 'link' && c.getAttribute('tabindex') === '0'));
});

test('slash commands, URL routes, UNC and parent escapes never decorate', (t) => {
  enable(t);
  const rootEl = decorate(
    '<p><code>/clear</code> <code>/api/</code> <code>\\\\srv\\share\\a.js</code> <code>G:\\ws\\..\\x.js</code>'
      + ' <code>http://h.io/a/b</code></p><pre><code>G:\\ws\\fenced.js</code></pre>'
  );
  assert.equal(rootEl.querySelector('[data-chat-path-open]'), null);
});
