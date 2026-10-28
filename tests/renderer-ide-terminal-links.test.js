'use strict';

/* Row 82 T1: the Workspace PTY terminal's link provider (file:line -> IDE editor) and the
 * Ctrl+click URL handler. The terminal is a fake exposing the buffer surface the provider
 * reads: buffer.active.getLine(index).translateToString(trimRight) / isWrapped, and cols. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createTerminalLinkProvider,
  createUrlLinkHandler,
  MAX_WRAPPED_ROWS,
} = require('../renderer/features/renderer-ide-terminal-links');

const ROOT = 'C:/ws';

// rows: [{ text, wrapped? }]; cols pads a row the way a real terminal row is full width.
function fakeTerm(rows, cols = 80) {
  return {
    cols,
    buffer: {
      active: {
        getLine(index) {
          const row = rows[index];
          if (!row) return undefined;
          return {
            isWrapped: row.wrapped === true,
            translateToString: (trimRight) => (trimRight ? row.text.trimEnd() : row.text.padEnd(cols, ' ')),
          };
        },
      },
    },
  };
}

function setup(rows, cols) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const win = dom.window;
  const opened = [];
  const logs = [];
  win.addEventListener('ide:open-file-at-line', (event) => {
    opened.push(event.detail);
    if (win.__claim !== false) event.preventDefault();
  });
  const host = win.document.getElementById('host');
  const provider = createTerminalLinkProvider({
    term: fakeTerm(rows, cols),
    getRootPath: () => ROOT,
    windowRef: win,
    appendClientLog: (level, code, data) => logs.push({ level, code, data }),
    getHostEl: () => host,
  });
  return { win, host, provider, opened, logs, close: () => win.close() };
}

function linksAt(provider, y) {
  let result = 'unset';
  provider.provideLinks(y, (links) => { result = links; });
  return result;
}

test('a path:line:col maps to a 1-based inclusive cell range and carries its text', (t) => {
  const h = setup([{ text: 'error at src/app.js:12:3 here' }]);
  t.after(h.close);
  const links = linksAt(h.provider, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, 'src/app.js:12:3');
  assert.deepEqual(links[0].range, { start: { x: 10, y: 1 }, end: { x: 24, y: 1 } });
});

test('a row without a file link answers undefined, and so does a row past the buffer', (t) => {
  const h = setup([{ text: 'just some output' }]);
  t.after(h.close);
  assert.equal(linksAt(h.provider, 1), undefined);
  assert.equal(linksAt(h.provider, 9), undefined);
});

test('a path broken by the terminal width still links, and every row of it answers', (t) => {
  // "src/utils/helper.js:42:5" at 10 columns -> three rows.
  const h = setup([
    { text: 'src/utils/' },
    { text: 'helper.js:', wrapped: true },
    { text: '42:5', wrapped: true },
    { text: 'a/b.js:1' },
  ], 10);
  t.after(h.close);
  for (const y of [1, 2, 3]) {
    const links = linksAt(h.provider, y);
    assert.equal(links.length, 1, `row ${y} answers the wrapped link`);
    assert.deepEqual(links[0].range, { start: { x: 1, y: 1 }, end: { x: 4, y: 3 } });
    assert.equal(links[0].text, 'src/utils/helper.js:42:5');
  }
  // The next logical line is its own link, on its own row only.
  const next = linksAt(h.provider, 4);
  assert.equal(next.length, 1);
  assert.deepEqual(next[0].range, { start: { x: 1, y: 4 }, end: { x: 8, y: 4 } });
  assert.equal(MAX_WRAPPED_ROWS, 4);
});

test('a link that starts mid-row and wraps maps both ends from the terminal width', (t) => {
  // "at src/app.js:7:2" with the path split by the 12-column width.
  const h = setup([{ text: 'at src/app.j' }, { text: 's:7:2', wrapped: true }], 12);
  t.after(h.close);
  const links = linksAt(h.provider, 2);
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].range, { start: { x: 4, y: 1 }, end: { x: 5, y: 2 } });
});

test('only Ctrl or Meta activates a file link, and it opens the IDE editor at the line', (t) => {
  const h = setup([{ text: 'src/app.js:12:3' }]);
  t.after(h.close);
  const [link] = linksAt(h.provider, 1);
  link.activate({ ctrlKey: false, metaKey: false });
  link.activate(undefined);
  assert.deepEqual(h.opened, [], 'a plain click only selects text');
  link.activate({ ctrlKey: true });
  link.activate({ metaKey: true });
  assert.deepEqual(h.opened, [
    { path: 'src/app.js', line: 12, column: 3, preferIde: true },
    { path: 'src/app.js', line: 12, column: 3, preferIde: true },
  ]);
  assert.deepEqual(h.logs, [], 'a claimed open logs nothing');
});

test('a link without a column omits the column key', (t) => {
  const h = setup([{ text: 'tests/test_x.py:40: AssertionError' }]);
  t.after(h.close);
  const [link] = linksAt(h.provider, 1);
  link.activate({ ctrlKey: true });
  assert.deepEqual(h.opened, [{ path: 'tests/test_x.py', line: 40, preferIde: true }]);
  assert.equal('column' in h.opened[0], false);
});

test('an unclaimed open event logs a DEBUG line and does nothing else', (t) => {
  const h = setup([{ text: 'src/app.js:12' }]);
  t.after(h.close);
  h.win.__claim = false;
  const [link] = linksAt(h.provider, 1);
  link.activate({ ctrlKey: true });
  assert.equal(h.opened.length, 1);
  assert.deepEqual(h.logs, [{ level: 'DEBUG', code: 'ide.terminal_link_unclaimed', data: {} }]);
});

test('hover sets the follow-link hint on the host and leave clears only that hint', (t) => {
  const h = setup([{ text: 'src/app.js:12' }]);
  t.after(h.close);
  const [link] = linksAt(h.provider, 1);
  link.hover();
  assert.equal(h.host.title, 'Follow link (Ctrl+click)');
  link.leave();
  assert.equal(h.host.hasAttribute('title'), false);
  h.host.title = 'something else';
  link.leave();
  assert.equal(h.host.title, 'something else', 'a title the provider did not set is left alone');
});

test('a throwing buffer answers undefined instead of breaking rendering', () => {
  const win = new JSDOM('').window;
  const provider = createTerminalLinkProvider({
    term: { cols: 80, buffer: { active: { getLine() { throw new Error('boom'); } } } },
    getRootPath: () => ROOT,
    windowRef: win,
  });
  assert.equal(linksAt(provider, 1), undefined);
  win.close();
});

test('the URL handler needs Ctrl or Meta and opens only http(s) through window.open', () => {
  const calls = [];
  const handler = createUrlLinkHandler({ windowRef: { open: (...args) => calls.push(args) } });
  handler({ ctrlKey: false, metaKey: false }, 'https://example.com/a');
  handler(undefined, 'https://example.com/a');
  assert.deepEqual(calls, [], 'a plain click opens nothing');
  handler({ ctrlKey: true }, 'https://example.com/a');
  handler({ metaKey: true }, 'HTTP://example.com/b');
  assert.deepEqual(calls, [
    ['https://example.com/a', '_blank', 'noopener,noreferrer'],
    ['HTTP://example.com/b', '_blank', 'noopener,noreferrer'],
  ]);
  for (const uri of ['javascript:alert(1)', 'file:///C:/secret.txt', 'ftp://example.com', 'data:text/html,x', '', null]) {
    handler({ ctrlKey: true }, uri);
  }
  assert.equal(calls.length, 2, 'non-http(s) schemes never reach window.open');
});
