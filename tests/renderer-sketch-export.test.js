'use strict';

// new-test-file: the export and copy-source actions under a drawing are a new surface (slice S6): an action module
// that attaches to the lazily loaded sketch frame host, which no existing test file covers.

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const HOST_PATH = require.resolve('../renderer/features/renderer-sketch-frame-host');
const MODULE_PATH = require.resolve('../renderer/features/renderer-sketch-export');
const markdownUtils = require('../renderer/shared/markdown-utils');
const contextMenu = require('../renderer/inventory/context-menu');

const SOURCE = 'title Sign in\nuser User @user\napp App\nuser -> app';
const MARKDOWN = '```sketch\n' + SOURCE + '\n```';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(t) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div class="chat-bubble-markdown" id="host"></div></body></html>', {
    pretendToBeVisual: true, url: 'http://localhost/',
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const timers = [];
  dom.window.setTimeout = (callback, milliseconds) => { const timer = { callback, milliseconds, live: true }; timers.push(timer); return timer; };
  dom.window.clearTimeout = (timer) => { if (timer) timer.live = false; };
  delete require.cache[HOST_PATH];
  const host = require(HOST_PATH);
  const container = dom.window.document.getElementById('host');
  container.innerHTML = markdownUtils.renderMarkdown(MARKDOWN);
  t.after(() => {
    contextMenu.hide({ restoreFocus: false });
    host.dispose();
    dom.window.close();
  });
  const fire = (milliseconds) => {
    const timer = timers.find((entry) => entry.live && entry.milliseconds === milliseconds);
    assert.ok(timer, `a live ${milliseconds} ms timer`);
    timer.live = false;
    timer.callback();
  };
  return { dom, host, container, timers, fire, document: dom.window.document };
}

function frameOf(block) {
  const iframe = block.querySelector('.markdown-sketch-paper > iframe');
  assert.ok(iframe, 'the block has a frame');
  if (!iframe.sketchTestWindow) {
    const posted = [];
    const stub = { posted, postMessage: (payload, target) => posted.push({ payload, target }) };
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: stub });
    iframe.sketchTestWindow = stub;
  }
  return { frameWindow: iframe.sketchTestWindow, posted: iframe.sketchTestWindow.posted };
}

function say(dom, source, data) {
  const event = new dom.window.Event('message');
  Object.defineProperty(event, 'source', { value: source });
  Object.defineProperty(event, 'data', { value: data });
  dom.window.dispatchEvent(event);
}

// Draws the block in the frame: ready, then the answer. Returns what a test needs to talk to that frame.
function draw(ctx, block) {
  const frame = frameOf(block);
  say(ctx.dom, frame.frameWindow, { type: 'sketch-frame-ready' });
  const request = frame.posted.find((entry) => entry.payload.type === 'render').payload;
  say(ctx.dom, frame.frameWindow, { type: 'rendered', requestId: request.requestId, ok: true, height: 200, width: 400, problems: [], counts: { nodes: 2 } });
  return { ...frame, request };
}

/** A drawn block with the module attached. `hostOverrides` lets one test make a host method misbehave. */
function stand(t, { hostOverrides, saveFile, writeText } = {}) {
  const ctx = setup(t);
  const toasts = [];
  const saves = [];
  const copies = [];
  ctx.dom.window.rendererSuggestedChangesHost = { showToastMessage: (message, options) => toasts.push({ message, options }) };
  const outcome = saveFile || (async (payload) => ({ canceled: false, path: '/tmp/' + payload.defaultName, bytesWritten: 1 }));
  ctx.dom.window.jennyShell = { dialog: { saveFile: async (payload) => { saves.push(payload); return outcome(payload); } } };
  Object.defineProperty(ctx.dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeText || (async (text) => { copies.push(text); }) },
  });
  delete require.cache[MODULE_PATH];
  const sketchExport = require(MODULE_PATH);
  const host = hostOverrides ? Object.assign(Object.create(ctx.host), hostOverrides) : ctx.host;
  const detach = sketchExport.attach(host);
  t.after(() => detach());
  ctx.host.renderInline(ctx.container);
  const block = ctx.container.querySelector('.markdown-sketch-block');
  const frame = draw(ctx, block);
  const answer = (extra) => say(ctx.dom, frame.frameWindow, { type: 'export', requestId: frame.request.requestId, ...extra });
  const row = () => block.querySelector('.markdown-sketch-row > .markdown-sketch-actions');
  const copyButton = () => row().querySelector('[data-sketch-order="20"]');
  const exportButton = () => row().querySelector('[data-sketch-order="30"]');
  const menu = () => ctx.document.querySelector('.inv-context-menu');
  const items = () => Array.from(ctx.document.querySelectorAll('.inv-context-menu > [role="menuitem"]'));
  return { ...ctx, ...frame, block, toasts, saves, copies, detach, sketchExport, answer, row, copyButton, exportButton, menu, items };
}

const SVG_ANSWER = { kind: 'svg', ok: true, name: 'sign-in', text: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' };
const exportRequests = (ctx) => ctx.posted.filter((entry) => entry.payload.type === 'export').map((entry) => entry.payload);

test('both actions appear in the row at orders 20 and 30 on a drawn block, and again when it is drawn a second time', (t) => {
  const ctx = stand(t);
  const check = () => {
    const children = Array.from(ctx.block.querySelectorAll('.markdown-sketch-row > .markdown-sketch-actions > [data-sketch-order]'));
    assert.deepEqual(children.map((el) => el.getAttribute('data-sketch-order')), ['20', '30']);
    assert.equal(children[0].textContent.trim(), 'Copy source');
    assert.equal(children[1].textContent.trim(), 'Export');
    assert.equal(children[1].getAttribute('aria-haspopup'), 'menu');
    assert.equal(children[1].getAttribute('aria-expanded'), 'false');
    assert.ok(children.every((el) => el.tagName === 'BUTTON' && el.classList.contains('btn')));
  };
  check();
  ctx.host.resetBlock(ctx.block);
  assert.equal(ctx.block.querySelector('.markdown-sketch-row'), null);
  ctx.host.renderBlock(ctx.block);
  draw(ctx, ctx.block);
  check();
  assert.equal(ctx.block.querySelectorAll('.markdown-sketch-actions > button').length, 2, 'no doubled buttons');
});

test('Copy source copies the drawing\'s source, says Copied and goes back to its label', async (t) => {
  const ctx = stand(t);
  ctx.copyButton().click();
  await flush();
  assert.deepEqual(ctx.copies, [ctx.host.sourceOf(ctx.block)], 'what the host holds, as the code block would copy it');
  assert.equal(ctx.copies[0].trim(), SOURCE);
  assert.equal(ctx.copyButton().textContent.trim(), 'Copied');
  assert.equal(ctx.copyButton().getAttribute('data-copy-status'), 'copied');
  ctx.fire(1500);
  assert.equal(ctx.copyButton().textContent.trim(), 'Copy source');
  assert.equal(ctx.copyButton().getAttribute('data-copy-status'), null);
});

test('a copy that fails says so and does not claim to have copied', async (t) => {
  const ctx = stand(t, { writeText: async () => { throw new Error('denied'); } });
  ctx.copyButton().click();
  await flush();
  assert.equal(ctx.copyButton().textContent.trim(), 'Copy failed');
  assert.equal(ctx.copyButton().getAttribute('data-copy-status'), 'failed');
  ctx.fire(1500);
  assert.equal(ctx.copyButton().textContent.trim(), 'Copy source');
});

test('the Export menu is a menu of three items that opens on the button and follows the keys, Escape and a click outside', (t) => {
  const ctx = stand(t);
  const button = ctx.exportButton();
  assert.equal(ctx.menu(), null);
  button.focus();
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(ctx.menu().getAttribute('role'), 'menu');
  assert.equal(ctx.menu().getAttribute('aria-label'), 'Export as');
  assert.deepEqual(ctx.items().map((el) => el.textContent.trim()), ['SVG', 'PNG', 'Excalidraw']);
  assert.equal(ctx.document.activeElement, ctx.items()[0]);
  const press = (key) => ctx.document.activeElement.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press('ArrowDown');
  assert.equal(ctx.document.activeElement, ctx.items()[1]);
  press('ArrowDown');
  press('ArrowDown');
  assert.equal(ctx.document.activeElement, ctx.items()[0], 'the arrows wrap');
  press('ArrowUp');
  assert.equal(ctx.document.activeElement, ctx.items()[2]);
  press('Escape');
  assert.equal(ctx.menu(), null);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(ctx.document.activeElement, button, 'Escape returns the focus to the button');
  button.click();
  assert.ok(ctx.menu());
  ctx.document.body.dispatchEvent(new ctx.dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(ctx.menu(), null, 'a click outside closes it');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  button.click();
  button.click();
  assert.equal(ctx.menu(), null, 'the button closes its own open menu');
  button.click();
  ctx.items()[0].click();
  assert.equal(ctx.menu(), null, 'choosing an item closes the menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('each item posts its own export request to the drawing\'s frame', (t) => {
  const ctx = stand(t);
  for (const [index, kind] of ['svg', 'png', 'excalidraw'].entries()) {
    ctx.exportButton().click();
    ctx.items()[index].click();
    assert.deepEqual(exportRequests(ctx).at(-1), { type: 'export', kind, requestId: ctx.request.requestId });
    ctx.answer({ kind, ok: false });
  }
  assert.equal(exportRequests(ctx).length, 3);
});

test('a drawing that cannot take the request gets a toast saying it is not ready, and nothing is pending', (t) => {
  const ctx = stand(t, { hostOverrides: { post: () => false } });
  ctx.exportButton().click();
  ctx.items()[0].click();
  assert.equal(ctx.toasts.length, 1);
  assert.equal(ctx.toasts[0].message, 'This drawing is not ready to export yet.');
  assert.equal(ctx.exportButton().getAttribute('aria-busy'), null);
  assert.equal(ctx.timers.some((timer) => timer.live && timer.milliseconds === 15000), false);
  ctx.answer(SVG_ANSWER);
  assert.equal(ctx.saves.length, 0, 'an answer nobody asked for is dropped');
});

test('the answer opens the save dialog with the right name, filter and content for each kind', async (t) => {
  const ctx = stand(t);
  const cases = [
    [{ kind: 'svg', ok: true, name: 'sign-in', text: '<svg/>' }, 'sign-in.svg', { name: 'SVG image', extensions: ['svg'] }, { content: '<svg/>' }],
    [{ kind: 'png', ok: true, name: 'sign-in', base64: 'iVBORw0KGgo=' }, 'sign-in.png', { name: 'PNG image', extensions: ['png'] }, { content: 'iVBORw0KGgo=', encoding: 'base64' }],
    [{ kind: 'excalidraw', ok: true, name: 'sign-in', text: '{"type":"excalidraw"}' }, 'sign-in.excalidraw', { name: 'Excalidraw drawing', extensions: ['excalidraw'] }, { content: '{"type":"excalidraw"}' }],
  ];
  for (const [index, [message, name, filter, content]] of cases.entries()) {
    ctx.exportButton().click();
    ctx.items()[index].click();
    ctx.answer(message);
    await flush();
    const payload = ctx.saves[index];
    assert.equal(payload.defaultName, name);
    assert.deepEqual(payload.filters, [filter]);
    assert.equal(payload.format, 'plain');
    assert.equal(payload.content, content.content);
    assert.equal(payload.encoding, content.encoding);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'anonymizePaths'), false);
  }
  assert.equal(ctx.timers.some((timer) => timer.live && timer.milliseconds === 15000), false, 'an answer ends the wait');
  assert.deepEqual(ctx.toasts.map((toast) => toast.options.tone), ['success', 'success', 'success']);
});

test('a name that was hostile arrives cleaned and goes to the dialog exactly as the message gave it', async (t) => {
  const ctx = stand(t);
  ctx.exportButton().click();
  ctx.items()[0].click();
  ctx.answer({ ...SVG_ANSWER, name: '../../Evil name<script>alert(1)</script>' });
  await flush();
  assert.equal(ctx.saves.length, 1);
  assert.equal(ctx.saves[0].defaultName, 'Evil-name-script-alert-1-script.svg');
  assert.match(ctx.saves[0].defaultName, /^[A-Za-z0-9_-]+\.svg$/);
});

test('ok false says the drawing could not be exported, opens no dialog and frees the button', (t) => {
  const ctx = stand(t);
  ctx.exportButton().click();
  ctx.items()[0].click();
  assert.equal(ctx.exportButton().getAttribute('aria-busy'), 'true');
  ctx.answer({ kind: 'svg', ok: false });
  assert.deepEqual(ctx.toasts.map((toast) => [toast.message, toast.options.tone]), [['Could not export this drawing.', 'danger']]);
  assert.equal(ctx.saves.length, 0);
  assert.equal(ctx.exportButton().getAttribute('aria-busy'), null);
  assert.equal(ctx.exportButton().textContent.trim(), 'Export');
});

test('an answer nobody asked for is dropped, and so is one for another kind than the one asked', async (t) => {
  const ctx = stand(t);
  ctx.answer(SVG_ANSWER);
  ctx.answer({ kind: 'svg', ok: false });
  await flush();
  assert.equal(ctx.saves.length, 0);
  assert.equal(ctx.toasts.length, 0);
  ctx.exportButton().click();
  ctx.items()[1].click();
  ctx.answer(SVG_ANSWER);
  await flush();
  assert.equal(ctx.saves.length, 0, 'a PNG was asked for, an SVG came');
  assert.equal(ctx.exportButton().getAttribute('aria-busy'), 'true', 'the PNG is still awaited');
});

test('while an export is pending the button is busy and a second choice is ignored; the answer frees it', async (t) => {
  const ctx = stand(t);
  ctx.exportButton().click();
  const first = ctx.items();
  first[0].click();
  assert.equal(ctx.exportButton().getAttribute('aria-busy'), 'true');
  assert.equal(ctx.exportButton().textContent.trim(), 'Exporting…');
  ctx.exportButton().click();
  assert.equal(ctx.menu(), null, 'the busy button opens no menu');
  first[1].click(); // a choice that is still in someone's hand
  assert.equal(exportRequests(ctx).length, 1);
  ctx.answer(SVG_ANSWER);
  await flush();
  assert.equal(ctx.exportButton().getAttribute('aria-busy'), null);
  assert.equal(ctx.exportButton().textContent.trim(), 'Export');
  ctx.exportButton().click();
  assert.ok(ctx.menu(), 'the menu opens again once it is free');
});

test('fifteen seconds without an answer says so, forgets the export and drops a late answer', async (t) => {
  const ctx = stand(t);
  ctx.exportButton().click();
  ctx.items()[0].click();
  ctx.fire(15000);
  assert.deepEqual(ctx.toasts.map((toast) => toast.message), ['Could not export this drawing.']);
  assert.equal(ctx.exportButton().getAttribute('aria-busy'), null);
  ctx.answer(SVG_ANSWER);
  await flush();
  assert.equal(ctx.saves.length, 0);
  assert.equal(ctx.toasts.length, 1);
  ctx.exportButton().click();
  ctx.items()[0].click();
  assert.equal(exportRequests(ctx).length, 2, 'a new export can be asked for');
});

test('a cancelled dialog shows nothing; a failed write shows the handler\'s message', async (t) => {
  let outcome = { canceled: true, path: '', bytesWritten: 0 };
  const ctx = stand(t, { saveFile: async () => { if (outcome instanceof Error) throw outcome; return outcome; } });
  ctx.exportButton().click();
  ctx.items()[0].click();
  ctx.answer(SVG_ANSWER);
  await flush();
  assert.equal(ctx.saves.length, 1);
  assert.equal(ctx.toasts.length, 0);
  outcome = new Error('Refusing to write inside a protected Jenny directory.');
  ctx.exportButton().click();
  ctx.items()[0].click();
  ctx.answer(SVG_ANSWER);
  await flush();
  assert.equal(ctx.toasts.length, 1);
  assert.equal(ctx.toasts[0].options.tone, 'danger');
  assert.match(ctx.toasts[0].message, /Refusing to write inside a protected Jenny directory\./);
  assert.equal(ctx.exportButton().getAttribute('aria-busy'), null);
});

test('detach removes the handler, the buttons with their listeners, a pending timer and an open menu', async (t) => {
  const ctx = stand(t);
  const copy = ctx.copyButton();
  const exportButton = ctx.exportButton();
  exportButton.click();
  const choose = ctx.items()[0];
  ctx.exportButton().click();
  assert.equal(ctx.menu(), null);
  exportButton.click();
  assert.ok(ctx.menu());
  ctx.detach();
  assert.equal(ctx.menu(), null, 'the open menu is closed');
  assert.equal(copy.isConnected, false);
  assert.equal(exportButton.isConnected, false);
  copy.click();
  exportButton.click();
  choose.click();
  await flush();
  assert.equal(ctx.copies.length, 0);
  assert.equal(ctx.menu(), null);
  assert.equal(exportRequests(ctx).length, 0);
  ctx.answer(SVG_ANSWER);
  await flush();
  assert.equal(ctx.saves.length, 0, 'the handler is gone');
  // A drawing after detach gets no buttons, and a second detach is harmless.
  ctx.host.resetBlock(ctx.block);
  ctx.host.renderBlock(ctx.block);
  draw(ctx, ctx.block);
  assert.equal(ctx.block.querySelector('.markdown-sketch-actions'), null);
  assert.doesNotThrow(() => ctx.detach());
});

test('detach while an export is pending forgets it and stops its timer', (t) => {
  const ctx = stand(t);
  ctx.exportButton().click();
  ctx.items()[0].click();
  assert.ok(ctx.timers.some((timer) => timer.live && timer.milliseconds === 15000));
  ctx.detach();
  assert.equal(ctx.timers.some((timer) => timer.live && timer.milliseconds === 15000), false);
  assert.equal(ctx.toasts.length, 0);
});

test('the module does nothing at load and nothing before attach', (t) => {
  const ctx = setup(t);
  delete require.cache[MODULE_PATH];
  const sketchExport = require(MODULE_PATH);
  assert.deepEqual(Object.keys(sketchExport), ['attach']);
  ctx.host.renderInline(ctx.container);
  const block = ctx.container.querySelector('.markdown-sketch-block');
  draw(ctx, block);
  assert.equal(block.querySelector('.markdown-sketch-row'), null);
});
