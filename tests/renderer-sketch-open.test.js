'use strict';

// new-test-file: renderer-sketch-open.js is a new action module of the sketch frame host (slice S5): a drawing's
// file nodes opening through sketch.openFile, and "Open large", the full-window viewer (plan 5.6).

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const HOST_PATH = require.resolve('../renderer/features/renderer-sketch-frame-host');
const OPEN_PATH = require.resolve('../renderer/features/renderer-sketch-open');
const markdownUtils = require('../renderer/shared/markdown-utils');

const SOURCE = 'title Sign in\nuser User @user\napp App\nuser -> app';
const fence = (body) => '```sketch\n' + body + '\n```';

// The chat page's shape: two panes, the block's message in pane 1's timeline, pane 0 the focused (active) chat.
const PAGE = '<!DOCTYPE html><html><head></head><body>'
  + '<section id="chatView"><div class="chat-pane" data-pane-id="0"><div class="chat-timeline"></div></div>'
  + '<div class="chat-pane" data-pane-id="1"><div class="chat-timeline"><div class="chat-bubble-markdown" id="inPane"></div></div></div></section>'
  + '<div id="teamTab"><div class="chat-bubble-markdown" id="outside"></div></div>'
  + '<aside id="ideChatDock"><div id="ideChatDockBody"><div class="chat-timeline"><div class="chat-bubble-markdown" id="docked"></div></div></div></aside>'
  + '</body></html>';

function setup(t, { where = 'inPane', markdown = fence(SOURCE) } = {}) {
  const dom = new JSDOM(PAGE, { pretendToBeVisual: true, url: 'http://localhost/' });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.setTimeout = () => ({ live: true });
  dom.window.clearTimeout = () => {};
  delete require.cache[HOST_PATH];
  delete require.cache[OPEN_PATH];
  const host = require(HOST_PATH);
  const sketchOpen = require(OPEN_PATH);
  const container = dom.window.document.getElementById(where);
  container.innerHTML = markdownUtils.renderMarkdown(markdown);
  const calls = [];
  const toasts = [];
  const logs = [];
  const opened = [];
  let answer = async () => ({ ok: true, relativePath: 'src/app.js', line: 12, projectId: 'project_a' });
  const previous = {
    shell: globalThis.jennyShell, toastHost: globalThis.rendererSuggestedChangesHost,
    panes: globalThis.rendererAppPaneComposition, log: globalThis.appendClientLog,
  };
  globalThis.jennyShell = { sketch: { openFile: (request) => { calls.push(request); return answer(request); } } };
  globalThis.rendererSuggestedChangesHost = { showToastMessage: (message, options) => toasts.push({ message, options }) };
  globalThis.rendererAppPaneComposition = { getPaneComposition: () => ({ getPaneSessionId: (id) => ({ 0: 'sess_active', 1: 'sess_pane_one' })[id] || '' }) };
  globalThis.appendClientLog = (...args) => logs.push(args);
  const claim = (event) => { opened.push(event.detail); event.preventDefault(); };
  dom.window.addEventListener('ide:open-file-at-line', claim);
  let detach = null;
  t.after(() => {
    if (detach) detach();
    host.dispose();
    Object.assign(globalThis, { jennyShell: previous.shell, rendererSuggestedChangesHost: previous.toastHost,
      rendererAppPaneComposition: previous.panes, appendClientLog: previous.log });
    dom.window.close();
  });
  detach = sketchOpen.attach(host);
  return {
    dom, host, sketchOpen, container, calls, toasts, logs, opened, document: dom.window.document,
    answerWith: (fn) => { answer = fn; },
    unclaim: () => dom.window.removeEventListener('ide:open-file-at-line', claim),
    detach: () => { const stop = detach; detach = null; stop(); },
  };
}

function frameOf(block) {
  const iframe = block.querySelector('.markdown-sketch-paper > iframe');
  assert.ok(iframe, 'the block has a frame');
  if (!iframe.sketchTestWindow) {
    const posted = [];
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: { posted, postMessage: (payload) => posted.push(payload) } });
    iframe.sketchTestWindow = iframe.contentWindow;
  }
  return iframe.sketchTestWindow;
}

function say(dom, source, data) {
  const event = new dom.window.Event('message');
  Object.defineProperty(event, 'source', { value: source });
  Object.defineProperty(event, 'data', { value: data });
  dom.window.dispatchEvent(event);
}

// Draws one block: the frame announces itself, the page sends the source, the frame answers drawn.
function draw(ctx, block) {
  const frame = frameOf(block);
  say(ctx.dom, frame, { type: 'sketch-frame-ready' });
  const request = frame.posted.find((payload) => payload.type === 'render');
  say(ctx.dom, frame, { type: 'rendered', requestId: request.requestId, ok: true, height: 200, width: 400, problems: [] });
  return { frame, requestId: request.requestId, request };
}

function drawnBlock(ctx) {
  ctx.host.renderInline(ctx.container);
  const block = ctx.container.querySelector('.markdown-sketch-block');
  return { block, ...draw(ctx, block) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const openLargeButton = (block) => block.querySelector('.markdown-sketch-row .markdown-sketch-actions > [data-sketch-order="10"]');
const viewerOf = (document) => document.getElementById('sketchViewerOverlay');
const key = (document, name, shiftKey = false) => {
  const event = new document.defaultView.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true });
  (document.activeElement || document.body).dispatchEvent(event);
  return event;
};

test('nothing happens at load or before attach', () => {
  delete require.cache[OPEN_PATH];
  const module = require(OPEN_PATH);
  assert.equal(typeof module.attach, 'function');
  assert.equal(typeof module.openLarge, 'function');
  assert.equal(module.openLarge({ source: SOURCE }), false, 'no host yet, no viewer');
});

test('an open-file message calls the bridge with the block\'s own session id and the checked path and line only', async (t) => {
  const ctx = setup(t);
  const { block, frame, requestId } = drawnBlock(ctx);
  say(ctx.dom, frame, { type: 'open-file', requestId, path: 'src/app.js', line: 12, root: 'C:\\elsewhere', sessionId: 'forged' });
  await flush();
  assert.deepEqual(ctx.calls, [{ sessionId: 'sess_pane_one', path: 'src/app.js', line: 12 }], 'pane 1\'s chat, not the active pane 0');
  assert.deepEqual(ctx.opened, [{ projectId: 'project_a', path: 'src/app.js', line: 12, column: null, preferIde: true }],
    'opened through the Workspace\'s own project-file open, which switches to that project and to the Workspace');
  assert.deepEqual(ctx.toasts, []);
  assert.equal(block.getAttribute('data-sketch-rendered'), 'true');
  const text = JSON.stringify(ctx.logs);
  assert.equal(text.includes('src/app.js'), false, 'no path in a log line');
});

test('each refusal shows one toast in plain words and opens nothing; only the reason code is logged', async (t) => {
  const ctx = setup(t);
  const { frame, requestId } = drawnBlock(ctx);
  const expected = {
    outside: 'This file is outside the chat\'s project folder.',
    no_root: 'This chat has no project folder on this computer.',
    no_session: 'This chat has no project folder on this computer.',
    not_found: 'That file is not there any more.',
    not_file: 'That is a folder, not a file.',
    link: 'That file is reached through a link, so it was not opened.',
    disabled: 'Opening files from drawings is turned off.',
    something_else: 'Could not open that file.',
  };
  for (const [reason, message] of Object.entries(expected)) {
    ctx.answerWith(async () => ({ ok: false, reason }));
    ctx.toasts.length = 0;
    say(ctx.dom, frame, { type: 'open-file', requestId, path: 'C:\\Users\\someone\\secret.txt', line: null });
    await flush();
    assert.deepEqual(ctx.toasts.map((toast) => toast.message), [message], reason);
  }
  ctx.answerWith(async () => { throw new Error('bridge gone'); });
  ctx.toasts.length = 0;
  say(ctx.dom, frame, { type: 'open-file', requestId, path: 'a.js', line: null });
  await flush();
  assert.deepEqual(ctx.toasts.map((toast) => toast.message), ['Could not open that file.'], 'a rejected bridge call');
  ctx.answerWith(async () => ({ ok: true, relativePath: '../outside.txt', line: null, projectId: 'p' }));
  ctx.toasts.length = 0;
  say(ctx.dom, frame, { type: 'open-file', requestId, path: 'a.js', line: null });
  await flush();
  assert.deepEqual(ctx.toasts.map((toast) => toast.message), ['Could not open that file.'], 'an answer that is not a relative path inside');
  assert.deepEqual(ctx.opened, []);
  const text = JSON.stringify(ctx.logs);
  assert.equal(text.includes('secret'), false);
  assert.ok(ctx.logs.every((entry) => entry[1] === 'markdown.sketch_open_file' && Object.keys(entry[2]).join() === 'reason'));
});

test('an ok answer no listener claims toasts instead of failing silently', async (t) => {
  const ctx = setup(t);
  ctx.unclaim();
  const { frame, requestId } = drawnBlock(ctx);
  say(ctx.dom, frame, { type: 'open-file', requestId, path: 'src/app.js', line: 1 });
  await flush();
  assert.deepEqual(ctx.toasts.map((toast) => toast.message), ['Could not open that file.']);
});

test('a second click while one open is pending is dropped', async (t) => {
  const ctx = setup(t);
  let release;
  ctx.answerWith(() => new Promise((resolve) => { release = resolve; }));
  const { frame, requestId } = drawnBlock(ctx);
  say(ctx.dom, frame, { type: 'open-file', requestId, path: 'src/app.js', line: 1 });
  say(ctx.dom, frame, { type: 'open-file', requestId, path: 'src/other.js', line: 2 });
  await flush();
  assert.equal(ctx.calls.length, 1);
  release({ ok: true, relativePath: 'src/app.js', line: 1, projectId: 'project_a' });
  await flush();
  assert.equal(ctx.opened.length, 1);
  ctx.answerWith(async () => ({ ok: false, reason: 'not_found' }));
  say(ctx.dom, frame, { type: 'open-file', requestId, path: 'src/other.js', line: 2 });
  await flush();
  assert.equal(ctx.calls.length, 2, 'the next click after the answer goes through');
});

test('a block outside a local chat sends no session id', async (t) => {
  const ctx = setup(t, { where: 'outside' });
  const { frame, requestId } = drawnBlock(ctx);
  say(ctx.dom, frame, { type: 'open-file', requestId, path: 'src/app.js', line: 3 });
  await flush();
  assert.deepEqual(ctx.calls, [{ path: 'src/app.js', line: 3 }]);
});

test('a block in the chat docked beside the Workspace or a board sends the focused pane\'s session; with no focused pane, none', async (t) => {
  const ctx = setup(t, { where: 'docked' });
  ctx.document.querySelector('.chat-pane[data-pane-id="1"]').setAttribute('data-pane-focused', 'true');
  const { frame, requestId } = drawnBlock(ctx);
  say(ctx.dom, frame, { type: 'open-file', requestId, path: 'src/app.js', line: 3 });
  await flush();
  assert.deepEqual(ctx.calls, [{ sessionId: 'sess_pane_one', path: 'src/app.js', line: 3 }]);
  ctx.document.querySelector('.chat-pane[data-pane-id="1"]').removeAttribute('data-pane-focused');
  say(ctx.dom, frame, { type: 'open-file', requestId, path: 'src/app.js', line: 4 });
  await flush();
  assert.deepEqual(ctx.calls[1], { path: 'src/app.js', line: 4 });
});

test('"Open large" sits at order 10 with its icon and opens the full-window viewer, a labelled modal dialog', (t) => {
  const ctx = setup(t);
  const { block } = drawnBlock(ctx);
  const button = openLargeButton(block);
  assert.ok(button, 'the action is in the row');
  assert.equal(button.textContent.trim(), 'Open large');
  assert.ok(button.querySelector('svg[aria-hidden="true"]'));
  assert.match(button.className, /\bbtn\b.*\bbtn--ghost\b.*\bbtn--sm\b/);
  button.focus();
  button.click();
  const viewer = viewerOf(ctx.document);
  const dialog = viewer.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  const title = ctx.document.getElementById(dialog.getAttribute('aria-labelledby'));
  assert.equal(title.textContent, 'Sign in', 'the title line of the source');
  assert.equal(viewer.hidden, false);
  assert.ok(viewer.querySelector('[data-help-overlay-close]').getAttribute('aria-label'));
});

test('the viewer draws the source again through the host, with the other modules\' actions and no "Open large"', (t) => {
  const ctx = setup(t);
  // A stand-in for another action module (Copy source, order 20).
  ctx.host.onDrawn(({ block }) => {
    const copy = ctx.document.createElement('button');
    copy.className = 'stand-in-copy';
    copy.textContent = 'Copy source';
    ctx.host.addAction(block, copy, 20);
  });
  const { block } = drawnBlock(ctx);
  openLargeButton(block).click();
  const viewerBlock = viewerOf(ctx.document).querySelector('.markdown-code-block');
  assert.ok(viewerBlock.querySelector('pre > code.language-sketch'));
  assert.equal(viewerBlock.querySelector('code').textContent, ctx.host.sourceOf(block), 'the source the chat block was drawn from');
  const { request } = draw(ctx, viewerBlock);
  assert.equal(request.source.trim(), SOURCE);
  assert.equal(viewerBlock.getAttribute('data-sketch-rendered'), 'true');
  assert.ok(viewerBlock.querySelector('.markdown-sketch-actions > .stand-in-copy'), 'another module adds its action in the viewer');
  assert.equal(openLargeButton(viewerBlock), null, 'no "Open large" inside the viewer');
  assert.ok(block.querySelector('.markdown-sketch-actions > .stand-in-copy'), 'the chat block keeps its own actions');
});

test('a file node clicked in a viewer opened from a chat carries that chat; from openLarge it carries none', async (t) => {
  const ctx = setup(t);
  const { block } = drawnBlock(ctx);
  openLargeButton(block).click();
  let viewerBlock = viewerOf(ctx.document).querySelector('.markdown-code-block');
  let drawn = draw(ctx, viewerBlock);
  say(ctx.dom, drawn.frame, { type: 'open-file', requestId: drawn.requestId, path: 'src/app.js', line: 5 });
  await flush();
  ctx.sketchOpen.openLarge({ source: SOURCE, title: 'Board card' });
  viewerBlock = viewerOf(ctx.document).querySelector('.markdown-code-block');
  drawn = draw(ctx, viewerBlock);
  say(ctx.dom, drawn.frame, { type: 'open-file', requestId: drawn.requestId, path: 'src/app.js', line: 6 });
  await flush();
  assert.deepEqual(ctx.calls, [{ sessionId: 'sess_pane_one', path: 'src/app.js', line: 5 }, { path: 'src/app.js', line: 6 }]);
});

test('Escape and the close button close the viewer; focus is trapped inside and goes back; the frame is released', (t) => {
  const ctx = setup(t);
  const { block } = drawnBlock(ctx);
  const button = openLargeButton(block);
  button.focus();
  button.click();
  const viewer = viewerOf(ctx.document);
  const close = viewer.querySelector('[data-help-overlay-close]');
  assert.equal(ctx.document.activeElement, close, 'focus moves into the viewer');
  const tab = key(ctx.document, 'Tab');
  assert.equal(tab.defaultPrevented, true);
  assert.ok(viewer.contains(ctx.document.activeElement), 'Tab stays inside');
  ctx.document.body.focus();
  key(ctx.document, 'Tab', true);
  assert.ok(viewer.contains(ctx.document.activeElement), 'Shift+Tab from outside comes back inside');
  let viewerBlock = viewer.querySelector('.markdown-code-block');
  draw(ctx, viewerBlock);
  key(ctx.document, 'Escape');
  assert.equal(viewer.hidden, true);
  assert.equal(viewer.querySelector('.markdown-code-block'), null);
  assert.equal(viewerBlock.querySelector('iframe'), null, 'closing releases the frame');
  assert.equal(viewerBlock.classList.contains('markdown-sketch-block'), false);
  assert.equal(ctx.host.post(viewerBlock, { type: 'export', kind: 'svg' }), false);
  assert.equal(ctx.document.activeElement, button, 'focus goes back to "Open large"');

  ctx.sketchOpen.openLarge({ source: SOURCE, returnFocus: button });
  viewerBlock = viewer.querySelector('.markdown-code-block');
  viewer.querySelector('[data-help-overlay-close]').click();
  assert.equal(viewer.hidden, true);
  assert.equal(viewerBlock.querySelector('iframe'), null);
  assert.equal(ctx.document.activeElement, button);
});

test('a second openLarge replaces the first: one viewer, the first block released', (t) => {
  const ctx = setup(t);
  drawnBlock(ctx);
  ctx.sketchOpen.openLarge({ source: SOURCE, title: 'First' });
  const first = viewerOf(ctx.document).querySelector('.markdown-code-block');
  ctx.sketchOpen.openLarge({ source: 'title Second\na A\nb B\na -> b' });
  assert.equal(ctx.document.querySelectorAll('#sketchViewerOverlay').length, 1);
  assert.equal(ctx.document.querySelectorAll('#sketchViewerOverlay [role="dialog"]').length, 1);
  assert.equal(first.querySelector('iframe'), null, 'the first viewer\'s frame is released');
  assert.equal(first.isConnected, false);
  const blocks = viewerOf(ctx.document).querySelectorAll('.markdown-code-block');
  assert.equal(blocks.length, 1);
  assert.equal(viewerOf(ctx.document).querySelector('[role="dialog"] h2').textContent, 'Second');
});

test('with no source, or one the host refuses, the viewer shows the host\'s note instead of staying empty', (t) => {
  const ctx = setup(t);
  drawnBlock(ctx);
  ctx.sketchOpen.openLarge({ source: '   ' });
  const viewer = viewerOf(ctx.document);
  assert.equal(viewer.querySelector('[role="dialog"] h2').textContent, 'Diagram');
  assert.equal(viewer.querySelector('.markdown-sketch-note').textContent, 'Could not draw this.');
  ctx.sketchOpen.openLarge({ source: 'a ' + 'x'.repeat(16384) });
  assert.equal(viewer.querySelector('.markdown-sketch-note').textContent, 'Could not draw this: the drawing is too large.');
  assert.equal(viewer.querySelector('iframe'), null);
});

test('a hostile title is shown as text', (t) => {
  const ctx = setup(t);
  drawnBlock(ctx);
  ctx.sketchOpen.openLarge({ source: 'title <img src=x onerror=alert(1)>\na A' });
  const heading = viewerOf(ctx.document).querySelector('[role="dialog"] h2');
  assert.equal(heading.textContent, '<img src=x onerror=alert(1)>');
  ctx.sketchOpen.openLarge({ source: SOURCE, title: '<img src=y onerror=alert(2)>' });
  assert.equal(viewerOf(ctx.document).querySelector('[role="dialog"] h2').textContent, '<img src=y onerror=alert(2)>');
  assert.equal(ctx.document.querySelectorAll('#sketchViewerOverlay img').length, 0);
});

test('detach removes the open-file handler and the actions, and closes an open viewer', async (t) => {
  const ctx = setup(t);
  const { block, frame, requestId } = drawnBlock(ctx);
  openLargeButton(block).click();
  assert.equal(viewerOf(ctx.document).hidden, false);
  ctx.detach();
  const viewer = viewerOf(ctx.document);
  assert.ok(!viewer || viewer.hidden, 'the viewer is closed');
  assert.equal(openLargeButton(block), null, 'the action is gone');
  say(ctx.dom, frame, { type: 'open-file', requestId, path: 'src/app.js', line: 1 });
  await flush();
  assert.deepEqual(ctx.calls, []);
  assert.equal(ctx.sketchOpen.openLarge({ source: SOURCE }), false);
});
