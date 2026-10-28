'use strict';

/* Row 82 slice R1: clickable file:line references in run and test output
 * (renderer-ide-output-links.js) plus the painter's linkify path. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const outputLinks = require('../renderer/features/renderer-ide-output-links');
const actionButton = require('../renderer/inventory/action-button');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { createBoundedScrollbackPainter } = require('../renderer/shared/terminal-stream-utils');

const OPTS = { rootPath: 'C:/ws', actionButton, escapeHtml };

function makeDom() {
  return new JSDOM('<!doctype html><body><pre id="pre"></pre></body>');
}

test('fragment text equals the input and links are plain buttons carrying path/line/col', () => {
  const dom = makeDom();
  const text = 'FAIL <b>x</b> & y\n  at fn (src/app.js:12:3)\nplain line\nsrc/lib/util.ts:7 done\n';
  const fragment = outputLinks.createLinkedFragment(dom.window.document, text, OPTS);
  assert.equal(fragment.textContent, text);
  const buttons = fragment.querySelectorAll('button');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].className, 'ide-output-link');
  assert.equal(buttons[0].dataset.ideOutputLinkPath, 'src/app.js');
  assert.equal(buttons[0].dataset.ideOutputLinkLine, '12');
  assert.equal(buttons[0].dataset.ideOutputLinkCol, '3');
  assert.equal(buttons[1].dataset.ideOutputLinkCol, '');
  assert.match(buttons[1].title, /src\/lib\/util\.ts/);
  // Text between links is merged into one node per run; no markup leaked from the output.
  assert.equal(fragment.querySelector('b'), null);
  for (const node of fragment.childNodes) {
    if (node.nodeType === 3) assert.ok(node.data.length > 0);
  }
});

test('text without links is exactly one text node; lines over 4096 chars stay plain', () => {
  const dom = makeDom();
  const plain = outputLinks.createLinkedFragment(dom.window.document, 'nothing to see\nhere', OPTS);
  assert.equal(plain.childNodes.length, 1);
  const long = `${'x'.repeat(5000)} src/app.js:12\n`;
  const fragment = outputLinks.createLinkedFragment(dom.window.document, long, OPTS);
  assert.equal(fragment.querySelectorAll('button').length, 0);
  assert.equal(fragment.textContent, long);
  const mixed = `${'y'.repeat(4097)}\nsrc/app.js:1`;
  assert.equal(outputLinks.createLinkedFragment(dom.window.document, mixed, OPTS).querySelectorAll('button').length, 1);
});

test('carriage returns survive in the fragment text', () => {
  const dom = makeDom();
  const text = 'a\r\nsrc/app.js:2\r\nb';
  assert.equal(outputLinks.createLinkedFragment(dom.window.document, text, OPTS).textContent, text);
});

test('without an action button the text stays plain', () => {
  const dom = makeDom();
  const fragment = outputLinks.createLinkedFragment(dom.window.document, 'src/app.js:12', { rootPath: 'C:/ws' });
  assert.equal(fragment.querySelectorAll('button').length, 0);
  assert.equal(fragment.textContent, 'src/app.js:12');
  assert.equal(outputLinks.renderLinkedHtml('a<b', { rootPath: '' }), 'a<b');
});

test('renderLinkedHtml escapes text and is textContent-equivalent to the input', () => {
  const dom = makeDom();
  const text = '<i>boom</i> src/app.js:12:3 & more\nC:\\ws\\pkg\\mod.py:4';
  const html = outputLinks.renderLinkedHtml(text, OPTS);
  const host = dom.window.document.getElementById('pre');
  host.innerHTML = html;
  assert.equal(host.textContent, text);
  assert.equal(host.querySelector('i'), null);
  assert.equal(host.querySelectorAll('[data-ide-output-link-path]').length, 2);
});

test('click dispatches ide:open-file-at-line; an unclaimed event is logged; unbind detaches', () => {
  const dom = makeDom();
  const host = dom.window.document.getElementById('pre');
  host.innerHTML = outputLinks.renderLinkedHtml('see src/app.js:12:3 and src/b.js(4)', OPTS);
  const logs = [];
  const unbind = outputLinks.bindOutputLinkClicks(host, { windowRef: dom.window, appendClientLog: (...args) => logs.push(args) });
  const events = [];
  let claim = false;
  dom.window.addEventListener('ide:open-file-at-line', (event) => {
    events.push({ detail: event.detail, cancelable: event.cancelable });
    if (claim) event.preventDefault();
  });
  const [first, second] = host.querySelectorAll('[data-ide-output-link-path]');
  first.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.deepEqual(events[0], { detail: { path: 'src/app.js', line: 12, column: 3, preferIde: true }, cancelable: true });
  assert.deepEqual(logs, [['DEBUG', 'ide.output_link_unclaimed', {}]]);
  claim = true;
  second.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.deepEqual(events[1].detail, { path: 'src/b.js', line: 4, preferIde: true }, 'no column key when the link has none');
  assert.equal(logs.length, 1, 'a claimed event is not logged');
  host.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(events.length, 2, 'clicks outside a link do nothing');
  unbind();
  first.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(events.length, 2);
});

/* ---- the painter's linkify path ------------------------------------------ */

function linkPainter(maxChars = 100000, rootPath = 'C:/ws') {
  const dom = makeDom();
  const pre = dom.window.document.getElementById('pre');
  const painter = createBoundedScrollbackPainter({
    requestFrame: (cb) => { cb(0); return 1; },
    cancelFrame: () => {},
    maxChars,
    getScrollbackEl: () => pre,
    linkify: (doc, text) => outputLinks.createLinkedFragment(doc, text, { rootPath, actionButton, escapeHtml }),
  });
  const push = (text) => { painter.append(text); painter.sync(); };
  return { dom, pre, painter, push };
}

test('painter: appended chunks paint link buttons and keep the text exact', () => {
  const h = linkPainter();
  h.push('start\nsrc/app.js:12:3 failed\n');
  h.push('more\n');
  assert.equal(h.pre.textContent, 'start\nsrc/app.js:12:3 failed\nmore\n');
  assert.equal(h.pre.querySelectorAll('button').length, 1);
});

test('painter: a path split across two appends becomes one link', () => {
  const h = linkPainter();
  h.push('ok\nerror in src/ap');
  assert.equal(h.pre.querySelectorAll('button').length, 0);
  h.push('p.js:12:3 here\n');
  const buttons = h.pre.querySelectorAll('button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, 'src/app.js:12:3');
  assert.equal(h.pre.textContent, 'ok\nerror in src/app.js:12:3 here\n');
});

test('painter: a link already painted is re-scanned when the same line continues', () => {
  const h = linkPainter();
  h.push('at src/app.js:12');
  assert.equal(h.pre.querySelector('button').textContent, 'src/app.js:12');
  h.push(':3 tail');
  const buttons = h.pre.querySelectorAll('button');
  assert.equal(buttons.length, 1, 'the old button was replaced, not duplicated');
  assert.equal(buttons[0].textContent, 'src/app.js:12:3');
  assert.equal(h.pre.textContent, 'at src/app.js:12:3 tail');
});

test('painter: a very long partial line is not re-scanned or duplicated', () => {
  const h = linkPainter();
  const big = 'z'.repeat(5000);
  h.push(big);
  h.push('src/app.js:1\n');
  assert.equal(h.pre.textContent, `${big}src/app.js:1\n`);
});

test('painter: trimming across a link element keeps the char accounting exact', () => {
  const h = linkPainter(40);
  h.push('src/app.js:12:3 xxxxxxxxxx'); // 26, no newline: the cut can land mid-line
  assert.equal(h.pre.querySelectorAll('button').length, 1);
  h.push('y'.repeat(15)); // 41 > 40: evicts 11 chars, straight through the link button
  assert.equal(h.pre.textContent, `${'src/app.js:12:3 xxxxxxxxxx'.slice(11)}${'y'.repeat(15)}`);
  assert.equal(h.pre.textContent.length, 30);
  assert.equal(h.pre.querySelectorAll('button').length, 0, 'the straddled link became plain text');
  // A fully trimmed leading link is removed whole.
  h.push('\nsrc/b.js:2 z\n');
  assert.ok(h.pre.textContent.endsWith('\nsrc/b.js:2 z\n'));
  assert.equal(h.pre.querySelectorAll('button').length, 1);
});

test('painter: eviction that lands inside a link button leaves its remaining text', () => {
  const dom = makeDom();
  const pre = dom.window.document.getElementById('pre');
  const painter = createBoundedScrollbackPainter({
    requestFrame: (cb) => { cb(0); return 1; },
    cancelFrame: () => {},
    maxChars: 20,
    getScrollbackEl: () => pre,
    linkify: (doc, text) => outputLinks.createLinkedFragment(doc, text, OPTS),
  });
  // One 16-char line that is entirely a link, then enough text to evict part of the store.
  painter.append('src/app.js:12:3\n');
  painter.sync();
  assert.equal(pre.querySelectorAll('button').length, 1);
  painter.append('abcdefgh\n');
  painter.sync();
  // Store eviction is line aligned, so the link line goes whole; the DOM mirrors the store.
  assert.equal(pre.textContent, 'abcdefgh\n');
  assert.equal(pre.querySelectorAll('button').length, 0);
});

test('painter: backgrounded then visible again repaints in full with links', () => {
  const dom = makeDom();
  const pre = dom.window.document.getElementById('pre');
  let visible = false;
  const painter = createBoundedScrollbackPainter({
    requestFrame: (cb) => { cb(0); return 1; },
    cancelFrame: () => {},
    maxChars: 10000,
    getScrollbackEl: () => (visible ? pre : null),
    linkify: (doc, text) => outputLinks.createLinkedFragment(doc, text, OPTS),
  });
  painter.append('a src/app.js:1\n');
  painter.sync();
  visible = true;
  painter.sync();
  assert.equal(pre.querySelectorAll('button').length, 1);
  assert.equal(pre.textContent, 'a src/app.js:1\n');
});

/* ---- run-scripts integration (own harness: tests/renderer-ide-run-scripts.test.js is at its size ceiling) ---- */

const { createIdeRunScripts } = require('../renderer/features/renderer-ide-run-scripts');

const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function runHarness(opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const dataListeners = [];
  const toasts = [];
  const started = [];
  const runTask = {
    onData: (fn) => { dataListeners.push(fn); return () => {}; },
    onExit: () => () => {},
    start: async (payload) => { started.push(payload.command); return { ok: true, taskId: 'run-1', cwd: 'C:/ws' }; },
    kill: async () => ({ killed: true, terminationConfirmed: true }),
  };
  const engine = createIdeRunScripts({
    getMountEl: () => host,
    isActivePanel: () => true,
    editorHost: { getActivePath: () => 'src/app.js', getActiveLanguageId: () => 'javascript', isDirty: () => false, focus() {} },
    getWorkspaceRunTaskApi: () => runTask,
    getWorkspaceFsApi: () => ({ readFile: async () => (opts.packageJson ? { content: JSON.stringify(opts.packageJson) } : Promise.reject(new Error('ENOENT'))) }),
    showToastMessage: (message) => toasts.push(message),
    appendClientLog: () => {},
    windowRef: dom.window,
  });
  return { dom, host, engine, toasts, started, emit: (chunk) => dataListeners.forEach((fn) => fn({ taskId: 'run-1', stream: 'stdout', chunk })) };
}

test('R1 run output: file:line references paint as link buttons that open the file', async () => {
  const h = runHarness();
  h.engine.bindEvents();
  await h.engine.runActiveFile();
  h.emit('boom at src/app.js:12:3\n');
  await flush();
  const pre = h.host.querySelector('[data-ide-run-scrollback]');
  const links = pre.querySelectorAll('[data-ide-output-link-path]');
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent, 'src/app.js:12:3');
  assert.match(pre.textContent, /boom at src\/app\.js:12:3\n/);
  const events = [];
  h.dom.window.addEventListener('ide:open-file-at-line', (event) => { events.push(event.detail); event.preventDefault(); });
  links[0].dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
  assert.deepEqual(events, [{ path: 'src/app.js', line: 12, column: 3, preferIde: true }]);
  h.engine.dispose();
  links[0].dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
  assert.equal(events.length, 1, 'dispose unbinds the delegated listener');
});

test('R1 run output: absolute paths link against the task cwd, and a split chunk still links', async () => {
  const h = runHarness();
  h.engine.bindEvents();
  await h.engine.runActiveFile();
  h.emit('  File "C:\\ws\\pkg\\mod.py", line 88\nsrc/ap');
  h.emit('p.js:5\n');
  await flush();
  const links = [...h.host.querySelectorAll('[data-ide-output-link-path]')].map((el) => el.dataset.ideOutputLinkPath);
  assert.deepEqual(links, ['pkg/mod.py', 'src/app.js']);
});

test('R1 runBuildTask: runs the build script directly when package.json has one', async () => {
  const h = runHarness({ packageJson: { scripts: { test: 'node t.js', build: 'tsc' } } });
  await h.engine.runBuildTask();
  assert.deepEqual(h.started, ["npm run 'build'"]);
  assert.deepEqual(h.toasts, []);
});

test('R1 runBuildTask: opens the script picker when there is no build script', async () => {
  const h = runHarness({ packageJson: { scripts: { test: 'node t.js', lint: 'eslint .' } } });
  await h.engine.runBuildTask();
  assert.deepEqual(h.started, [], 'nothing is started without a build script');
  assert.match(h.toasts.join(' | '), /script picker is unavailable/i, 'fell through to the picker (no overlay DOM in this harness)');
});

test('R1 runBuildTask: toasts like the picker when package.json is missing', async () => {
  const h = runHarness();
  await h.engine.runBuildTask();
  assert.deepEqual(h.started, []);
  assert.match(h.toasts.join(' | '), /No package\.json found/);
});
