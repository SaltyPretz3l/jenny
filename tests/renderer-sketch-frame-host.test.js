'use strict';

// new-test-file: the chat side of sketch blocks is a new surface: the lazily loaded frame host, its
// hook in the markdown module and the loader that brings it in (plan sections 5.2, 5.4, 5.8; slice S3).

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const HOST_PATH = require.resolve('../renderer/features/renderer-sketch-frame-host');
const LOADER_PATH = require.resolve('../renderer/features/renderer-mermaid-runtime-loader');
const markdownUtils = require('../renderer/shared/markdown-utils');

const SOURCE = 'title Sign in\nuser User @user\napp App\nuser -> app';
const fence = (body, info = 'sketch') => '```' + info + '\n' + body + '\n```';

function setup(t, markdown) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div class="chat-bubble-markdown" id="host"></div><textarea id="composer"></textarea></body></html>', {
    pretendToBeVisual: true, url: 'http://localhost/',
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null; // jsdom has no canvas and says so loudly
  const timers = [];
  dom.window.setTimeout = (callback, milliseconds) => { const timer = { callback, milliseconds, live: true }; timers.push(timer); return timer; };
  dom.window.clearTimeout = (timer) => { if (timer) timer.live = false; };
  delete require.cache[HOST_PATH];
  const host = require(HOST_PATH);
  const container = dom.window.document.getElementById('host');
  container.innerHTML = markdownUtils.renderMarkdown(markdown);
  const inserted = [];
  const previousInsert = globalThis.rendererComposerInsert;
  globalThis.rendererComposerInsert = { insertIntoComposer: (payload) => { inserted.push(payload); return true; } };
  t.after(() => {
    host.dispose();
    globalThis.rendererComposerInsert = previousInsert;
    dom.window.close();
  });
  const fire = (reasonMs) => {
    const timer = timers.find((entry) => entry.live && entry.milliseconds === reasonMs);
    assert.ok(timer, `a live ${reasonMs} ms timer`);
    timer.live = false;
    timer.callback();
  };
  return { dom, host, container, timers, fire, inserted, document: dom.window.document };
}

// jsdom gives a frame with an unknown scheme no window of its own; the host only needs an identity to
// match messages against and a postMessage to call.
function frameOf(block) {
  const iframe = block.querySelector('.markdown-sketch-paper > iframe');
  assert.ok(iframe, 'the block has a frame');
  if (!iframe.sketchTestWindow) {
    const posted = [];
    const stub = { posted, postMessage: (payload, target) => posted.push({ payload, target }) };
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: stub });
    iframe.sketchTestWindow = stub;
  }
  return { iframe, frameWindow: iframe.sketchTestWindow, posted: iframe.sketchTestWindow.posted };
}

function say(dom, source, data) {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: null, data }));
  // jsdom's MessageEvent takes only a Window as `source`; the host reads event.source, so hand it over directly.
  const event = new dom.window.Event('message');
  Object.defineProperty(event, 'source', { value: source });
  Object.defineProperty(event, 'data', { value: data });
  dom.window.dispatchEvent(event);
}

function drawOne(t, markdown = fence(SOURCE)) {
  const ctx = setup(t, markdown);
  ctx.host.renderInline(ctx.container);
  const block = ctx.container.querySelector('.markdown-sketch-block');
  const frame = frameOf(block);
  say(ctx.dom, frame.frameWindow, { type: 'sketch-frame-ready' });
  const request = frame.posted.find((entry) => entry.payload.type === 'render').payload;
  return { ...ctx, block, ...frame, request };
}

test('a sketch fence is an ordinary code block until its host draws it, with or without an id', (t) => {
  for (const info of ['sketch', 'sketch d1', 'sketch   login-flow']) {
    const { container } = setup(t, fence(SOURCE, info));
    const code = container.querySelector('.markdown-code-block > pre > code.language-sketch');
    assert.ok(code, `fence tagged "${info}"`);
    assert.equal(code.textContent.trim(), SOURCE);
    assert.equal(container.querySelector('iframe'), null);
  }
  const other = setup(t, fence(SOURCE, 'sketchy'));
  assert.equal(other.container.querySelector('code.language-sketch'), null);
});

test('a Mermaid body under the sketch tag is handed to Mermaid by the markdown module', (t) => {
  const { container, host } = setup(t, fence('flowchart TD\n  A --> B'));
  assert.ok(container.querySelector('.markdown-mermaid-block[data-mermaid-source]'));
  host.renderInline(container);
  assert.equal(container.querySelector('.markdown-sketch-block'), null);
});

test('the frame is sandboxed without same-origin, served from the sketch scheme, and sits above the code', (t) => {
  const { host, container } = setup(t, fence(SOURCE));
  host.renderInline(container);
  const block = container.querySelector('.markdown-code-block');
  const { iframe } = frameOf(block);
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(iframe.getAttribute('src'), 'jenny-sketch://frame/sketch-frame.html');
  assert.equal(block.firstElementChild.className, 'markdown-sketch-paper');
  assert.equal(block.getAttribute('data-sketch-rendered'), 'pending');
  assert.ok(block.querySelector('pre > code.language-sketch'), 'the source stays in the page');
  assert.ok(container.ownerDocument.querySelector('link[data-jenny-sketch-styles][href="styles/markdown-sketch.css"]'));
  host.renderInline(container);
  assert.equal(container.querySelectorAll('iframe').length, 1, 'a second scan does not draw twice');
});

test('ready sends the theme and then the source; the answer shows the drawing with a clamped height', (t) => {
  const ctx = drawOne(t);
  assert.deepEqual(ctx.posted.map((entry) => [entry.payload.type, entry.target]), [['theme', '*'], ['render', '*']]);
  assert.equal(ctx.request.source.trim(), SOURCE);
  assert.match(ctx.request.requestId, /^sketch-\d+-[a-z0-9]+$/);
  say(ctx.dom, ctx.frameWindow, { type: 'rendered', requestId: ctx.request.requestId, ok: true, height: 99999999, problems: [], positions: { direction: 'right', positions: { user: { x: 1, y: 2 } } } });
  assert.equal(ctx.block.getAttribute('data-sketch-rendered'), 'true');
  assert.equal(ctx.block.getAttribute('role'), 'figure');
  assert.equal(ctx.iframe.style.height, '10000px');
  assert.deepEqual(ctx.host.getPositions(ctx.block), { direction: 'right', positions: { user: { x: 1, y: 2 } } });
  assert.equal(ctx.block.querySelector('.markdown-sketch-row'), null, 'no problems, no note');
  for (const [height, expected] of [[-50, '60px'], ['abc', '60px'], [321.2, '322px']]) {
    say(ctx.dom, ctx.frameWindow, { type: 'height', requestId: ctx.request.requestId, height });
    assert.equal(ctx.iframe.style.height, expected);
  }
  assert.ok(ctx.timers.every((timer) => !timer.live), 'no timer is left running');
});

test('a forged request id and a message from another window change nothing', (t) => {
  const ctx = drawOne(t);
  const stranger = { postMessage() {} };
  say(ctx.dom, ctx.frameWindow, { type: 'rendered', requestId: 'sketch-999-forged', ok: true, height: 500, problems: [] });
  say(ctx.dom, ctx.frameWindow, { type: 'height', requestId: 'sketch-999-forged', height: 900 });
  say(ctx.dom, stranger, { type: 'rendered', requestId: ctx.request.requestId, ok: true, height: 500, problems: [] });
  say(ctx.dom, stranger, { type: 'sketch-frame-ready' });
  say(ctx.dom, ctx.dom.window, { type: 'rendered', requestId: ctx.request.requestId, ok: false, reason: 'error' });
  say(ctx.dom, ctx.frameWindow, 'rendered');
  assert.equal(ctx.block.getAttribute('data-sketch-rendered'), 'pending');
  assert.equal(ctx.iframe.style.height, '120px');
  assert.equal(ctx.posted.length, 2);
});

test('problems show as a chip whose tooltip lists them and whose click drafts the fix; hostile text stays text', (t) => {
  const ctx = drawOne(t);
  const problems = [
    { code: 'duplicate_id', line: 6, id: 'db' },
    { code: 'missing_id', line: 10, id: '<img src=x onerror=alert(1)>' },
    { code: 'repointed_id', line: 11, id: 'clouds', to: 'cloud' },
    { code: 'not_a_code', line: 1, id: 'x' },
    { code: 'prose_node', line: -4, text: 'y'.repeat(900) },
    'nonsense',
  ];
  say(ctx.dom, ctx.frameWindow, { type: 'rendered', requestId: ctx.request.requestId, ok: true, height: 200, problems });
  const chip = ctx.block.querySelector('.markdown-sketch-row .markdown-sketch-problems-chip');
  assert.equal(ctx.block.querySelector('.markdown-sketch-problems'), null, 'a drawn block lists nothing under the drawing');
  assert.equal(chip.textContent.trim(), '4');
  assert.equal(chip.getAttribute('aria-label'), '4 problems. Click to ask Jenny to redraw it');
  assert.equal(chip.getAttribute('data-tone'), 'warning');
  const [lines, hint] = [chip.getAttribute('title').split('\n\n')[0].split('\n'), chip.getAttribute('title').split('\n\n')[1]];
  assert.equal(hint, 'Click to ask Jenny to redraw it');
  assert.deepEqual(lines, [
    'Line 6: The name "db" is already used. The second one was left out.',
    'Line 10: "<img src=x onerror=alert(1)>" is not in the drawing. This was left out.',
    'Line 11: "clouds" is not in the drawing. It was read as "cloud".',
    'This reads as a sentence, not as a part of the drawing.',
  ]);
  assert.equal(ctx.block.querySelectorAll('img').length, 0);
  chip.click();
  assert.equal(ctx.inserted.length, 1, 'the chip fills the composer once and sends nothing');
  assert.equal(ctx.inserted[0].text, ['The drawing has 4 problems:'].concat(lines.map((entry) => '- ' + entry), 'Please write the whole sketch block again with these fixed.').join('\n'));
  assert.equal(chip.textContent.trim(), 'Added to the message box');
  ctx.fire(1600);
  assert.equal(chip.textContent.trim(), '4', 'the chip shows the count again');
});

test('a chip with only lines left out is the quiet tone; no composer says so on the chip', (t) => {
  const ctx = drawOne(t);
  say(ctx.dom, ctx.frameWindow, { type: 'rendered', requestId: ctx.request.requestId, ok: true, height: 200, problems: [{ code: 'removed_line', line: 1 }] });
  const chip = ctx.block.querySelector('.markdown-sketch-problems-chip');
  assert.equal(chip.getAttribute('data-tone'), 'minor');
  assert.equal(chip.getAttribute('aria-label'), '1 problem. Click to ask Jenny to redraw it');
  globalThis.rendererComposerInsert = { insertIntoComposer: () => false };
  chip.click();
  assert.equal(chip.textContent.trim(), 'Open a chat to send this');
});

test('a refused drawing removes the frame and shows the note, the problems and the source', (t) => {
  const ctx = drawOne(t);
  say(ctx.dom, ctx.frameWindow, { type: 'rendered', requestId: ctx.request.requestId, ok: false, reason: 'too_many_problems', problems: [{ code: 'prose_node', line: 1 }] });
  assert.equal(ctx.block.getAttribute('data-sketch-rendered'), 'failed');
  assert.equal(ctx.block.querySelector('iframe'), null);
  assert.equal(ctx.block.getAttribute('role'), null);
  const order = Array.from(ctx.block.children).map((node) => node.className.split(' ')[0]);
  assert.deepEqual(order.slice(0, 2), ['markdown-sketch-note', 'markdown-sketch-problems']);
  assert.equal(ctx.block.querySelector('.markdown-sketch-note').textContent, 'Could not draw this: too much of it could not be read.');
  assert.equal(ctx.block.querySelector('.markdown-sketch-problems').hidden, false);
  assert.ok(ctx.block.querySelector('.markdown-sketch-fix'));
  assert.equal(ctx.block.querySelector('.markdown-sketch-retry'), null);
  ctx.host.renderInline(ctx.container);
  assert.equal(ctx.block.querySelector('iframe'), null, 'a refused block is not tried again by a later scan');
  // A late answer from the dead frame is ignored.
  say(ctx.dom, ctx.frameWindow, { type: 'rendered', requestId: ctx.request.requestId, ok: true, height: 200, problems: [] });
  assert.equal(ctx.block.getAttribute('data-sketch-rendered'), 'failed');
});

test('five seconds without an answer destroys the frame; Try again starts over', (t) => {
  const ctx = drawOne(t);
  ctx.fire(5000);
  assert.equal(ctx.block.getAttribute('data-sketch-rendered'), 'failed');
  assert.equal(ctx.block.querySelector('iframe'), null);
  assert.equal(ctx.block.querySelector('.markdown-sketch-note').firstChild.textContent, 'Could not draw this: it took too long.');
  ctx.block.querySelector('.markdown-sketch-retry').click();
  assert.equal(ctx.block.getAttribute('data-sketch-rendered'), 'pending');
  assert.equal(ctx.block.querySelectorAll('iframe').length, 1);
  assert.equal(ctx.block.querySelectorAll('.markdown-sketch-note').length, 0);
});

test('a frame that never announces itself is given up after ten seconds', (t) => {
  const { host, container, fire } = setup(t, fence(SOURCE));
  host.renderInline(container);
  const block = container.querySelector('.markdown-sketch-block');
  fire(10000);
  assert.equal(block.getAttribute('data-sketch-rendered'), 'failed');
  assert.equal(block.querySelector('.markdown-sketch-note').firstChild.textContent, 'Could not draw this.');
  assert.ok(block.querySelector('.markdown-sketch-retry'));
});

test('an oversize source is refused before a frame is made, and Fix says what to do', (t) => {
  for (const body of ['a ' + 'x'.repeat(16384), Array.from({ length: 401 }, (_, index) => `n${index} N`).join('\n')]) {
    const ctx = setup(t, fence(body));
    ctx.host.renderInline(ctx.container);
    const block = ctx.container.querySelector('.markdown-sketch-block');
    assert.equal(block.getAttribute('data-sketch-rendered'), 'failed');
    assert.equal(ctx.container.ownerDocument.querySelector('iframe'), null);
    assert.equal(block.querySelector('.markdown-sketch-note').textContent, 'Could not draw this: the drawing is too large.');
    block.querySelector('.markdown-sketch-fix').click();
    assert.match(ctx.inserted[0].text, /at most 120 parts and 400 lines/);
  }
});

test('while a message streams its last sketch block waits; a reasoning panel never draws', (t) => {
  const ctx = setup(t, fence(SOURCE) + '\n\ntext\n\n' + fence('a Alpha\nb Beta'));
  ctx.host.renderInline(ctx.container, { isStreaming: true });
  assert.equal(ctx.container.querySelectorAll('iframe').length, 1);
  assert.equal(ctx.container.querySelectorAll('.markdown-code-block')[1].classList.contains('markdown-sketch-block'), false);
  ctx.host.renderInline(ctx.container, { isStreaming: false });
  assert.equal(ctx.container.querySelectorAll('iframe').length, 2);

  const reasoning = setup(t, fence(SOURCE));
  reasoning.container.classList.add('reasoning-row-panel');
  reasoning.host.renderInline(reasoning.document.body);
  assert.equal(reasoning.document.querySelector('iframe'), null);
});

test('a block rebuilt from a string starts again with one frame', (t) => {
  const ctx = drawOne(t);
  say(ctx.dom, ctx.frameWindow, { type: 'rendered', requestId: ctx.request.requestId, ok: true, height: 200, problems: [{ code: 'prose_node', line: 1 }] });
  // What the timeline does to a row it put away and brought back.
  ctx.container.innerHTML = String(ctx.container.innerHTML);
  const rebuilt = ctx.container.querySelector('.markdown-code-block');
  assert.equal(rebuilt.getAttribute('data-sketch-rendered'), 'true', 'the stale markup says drawn');
  ctx.host.renderInline(ctx.container);
  assert.equal(rebuilt.getAttribute('data-sketch-rendered'), 'pending');
  assert.equal(rebuilt.querySelectorAll('iframe').length, 1);
  assert.equal(rebuilt.querySelectorAll('.markdown-sketch-row, .markdown-sketch-problems').length, 0);
  const fresh = frameOf(rebuilt);
  say(ctx.dom, fresh.frameWindow, { type: 'sketch-frame-ready' });
  assert.equal(fresh.posted.filter((entry) => entry.payload.type === 'render').length, 1);
});

test('past eight live frames the drawing furthest from view gives its frame back, keeps its height and is drawn again when near', (t) => {
  const observers = [];
  const previousObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.watched = new Set(); observers.push(this); }
    observe(element) { this.watched.add(element); }
    unobserve(element) { this.watched.delete(element); }
    disconnect() { this.watched.clear(); }
  };
  t.after(() => { globalThis.IntersectionObserver = previousObserver; });
  const ctx = setup(t, Array.from({ length: 10 }, (_value, index) => fence(`n${index} Node ${index}`)).join('\n\n'));
  ctx.host.renderInline(ctx.container);
  const watcher = observers[0];
  const blocks = Array.from(ctx.container.querySelectorAll('.markdown-code-block'));
  assert.equal(ctx.host.MAX_LIVE_FRAMES, 8);
  assert.equal(watcher.watched.size, 10, 'nothing is drawn before it comes near');
  // Each block is 1,000 px below the one before; the 768 px window shows the last one.
  blocks.forEach((block, index) => {
    block.getBoundingClientRect = () => ({ top: (index - 9) * 1000, bottom: (index - 9) * 1000 + 300, height: 300 });
  });
  const draw = (block) => {
    watcher.callback([{ isIntersecting: true, target: block }]);
    const frame = frameOf(block);
    say(ctx.dom, frame.frameWindow, { type: 'sketch-frame-ready' });
    const requestId = frame.posted.find((entry) => entry.payload.type === 'render').payload.requestId;
    say(ctx.dom, frame.frameWindow, { type: 'rendered', requestId, ok: true, height: 200, width: 300, problems: [], positions: null });
  };
  const framesUp = () => blocks.map((block, index) => (block.querySelector('iframe') ? index : -1)).filter((index) => index >= 0);
  blocks.slice(0, 8).forEach(draw);
  assert.deepEqual(framesUp(), [0, 1, 2, 3, 4, 5, 6, 7], 'eight frames may stay up');
  draw(blocks[8]);
  assert.deepEqual(framesUp(), [1, 2, 3, 4, 5, 6, 7, 8], 'the ninth parks the furthest');
  assert.equal(blocks[0].style.minHeight, '300px');
  assert.equal(blocks[0].classList.contains('markdown-sketch-block'), false);
  assert.ok(blocks[0].querySelector('pre > code.language-sketch'), 'its source is still in the page');
  assert.ok(watcher.watched.has(blocks[0]), 'it is watched again');
  // One being marked up is left alone: the next furthest goes.
  const marking = ctx.document.createElement('button');
  marking.setAttribute('data-sketch-action', 'markup');
  marking.setAttribute('aria-pressed', 'true');
  blocks[1].appendChild(marking);
  draw(blocks[9]);
  assert.deepEqual(framesUp(), [1, 3, 4, 5, 6, 7, 8, 9]);
  draw(blocks[0]);
  assert.deepEqual(framesUp(), [0, 1, 4, 5, 6, 7, 8, 9], 'a parked drawing comes back when it is near again');
  assert.equal(blocks[0].style.minHeight, '');
  assert.equal(blocks[0].getAttribute('data-sketch-rendered'), 'true');
});

test('the palette maps the ten theme tokens, mixes the marker, and leaves out what it cannot read', (t) => {
  const { host, document, dom } = setup(t, fence(SOURCE));
  const tokens = {
    '--bg-base': '#101418', '--text-primary': 'rgb(240, 240, 240)', '--text-secondary': '#abc', '--text-decorative': '#666666',
    '--bg-surface-2': '#202428', '--bg-surface': '#181c20', '--text-link': '#58a6ff', '--accent-strong': 'not-a-colour',
    '--border-strong': 'rgba(255, 255, 255, 0.5)', '--accent-amber': '#ffbf00',
  };
  dom.window.getComputedStyle = () => ({ getPropertyValue: (name) => tokens[name] || '' });
  // No canvas in jsdom: plain colours are read, anything needing a pixel is left for the frame's own default.
  assert.deepEqual(host.readPalette(document), {
    paper: '#101418', ink: '#f0f0f0', inkSoft: '#aabbcc', muted: '#666666', card: '#202428', groupFill: '#181c20', annotation: '#58a6ff',
  });
  const calls = [];
  const palette = host.readPalette(document, { resolveColor: (value, under, share) => { calls.push([value, under, share]); return value.startsWith('#') ? value : ''; } });
  assert.equal(palette.marker, '#ffbf00');
  assert.deepEqual(calls.at(-1), ['#ffbf00', '#202428', 0.42]);
  assert.deepEqual(calls.find((call) => call[0].startsWith('rgba')), ['rgba(255, 255, 255, 0.5)', '#101418', 1], 'a see-through colour is painted over the paper');
  assert.deepEqual(Object.keys(host.PALETTE_TOKENS).concat('marker').sort(), ['annotation', 'card', 'groupFill', 'highlight', 'ink', 'inkSoft', 'line', 'marker', 'muted', 'paper']);
});

test('a theme change reaches every live frame once; an unchanged theme posts nothing', (t) => {
  const ctx = drawOne(t);
  let paper = '#101418';
  ctx.dom.window.getComputedStyle = () => ({ getPropertyValue: (name) => (name === '--bg-base' ? paper : '') });
  assert.equal(ctx.host.refreshTheme(ctx.document), true);
  assert.equal(ctx.host.refreshTheme(ctx.document), false);
  paper = '#fdfdf7';
  assert.equal(ctx.host.refreshTheme(ctx.document), true);
  const themes = ctx.posted.filter((entry) => entry.payload.type === 'theme').map((entry) => entry.payload.palette);
  assert.deepEqual(themes.slice(-2), [{ paper: '#101418' }, { paper: '#fdfdf7' }]);
});

test('the loader draws nothing while the flag is off and hands the container to the host when it is on', async (t) => {
  delete require.cache[LOADER_PATH];
  const loader = require(LOADER_PATH);
  const { container } = setup(t, fence(SOURCE));
  const seen = [];
  const previousHost = globalThis.rendererSketchFrameHost;
  globalThis.rendererSketchFrameHost = { renderInline: (target, options) => seen.push([target, options]) };
  t.after(() => { globalThis.rendererSketchFrameHost = previousHost; loader._resetForTests(); });
  assert.equal(loader.renderSketchBlocks(container, {}), false, 'off until feature state says otherwise');
  loader.setSketchBlocksEnabled(true);
  const plain = container.ownerDocument.createElement('div');
  plain.innerHTML = markdownUtils.renderMarkdown(fence('const a = 1;', 'js'));
  assert.equal(loader.renderSketchBlocks(plain, {}), false, 'no sketch block, no load');
  assert.equal(loader.renderSketchBlocks(null, {}), false);
  // The markdown module's scan is the one caller.
  const previousLoader = globalThis.rendererMermaidRuntimeLoader;
  globalThis.rendererMermaidRuntimeLoader = loader;
  t.after(() => { globalThis.rendererMermaidRuntimeLoader = previousLoader; });
  markdownUtils.renderInlineMermaidBlocks(container, { isStreaming: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [[container, { isStreaming: true }]]);
  loader.setSketchBlocksEnabled(false);
  markdownUtils.renderInlineMermaidBlocks(container, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 1);
  assert.equal(path.basename(HOST_PATH), 'renderer-sketch-frame-host.js');
});

/* ── What an action module uses (the seam for open, export, mark up and follow-ups) ── */

const drawnAnswer = (ctx, extra = {}) => ({ type: 'rendered', requestId: ctx.request.requestId, ok: true, height: 200, width: 412.2, problems: [], counts: { nodes: 2 }, ...extra });

test('an action module hears of each drawing, adds its controls in order and posts to that drawing\'s frame', (t) => {
  const ctx = drawOne(t);
  const seen = [];
  const stop = ctx.host.onDrawn((drawn) => seen.push(drawn));
  ctx.host.onDrawn(() => { throw new Error('a broken module'); });
  const make = (label) => { const el = ctx.document.createElement('button'); el.textContent = label; return el; };
  assert.equal(ctx.host.addAction(ctx.block, make('early'), 10), false, 'no row before there is a drawing');
  assert.equal(ctx.host.post(ctx.block, { type: 'export', kind: 'svg' }), false, 'nothing to post to before the drawing');
  say(ctx.dom, ctx.frameWindow, drawnAnswer(ctx));
  assert.equal(seen.length, 1, 'a throwing listener does not stop the others or the drawing');
  assert.equal(seen[0].block, ctx.block);
  assert.equal(seen[0].source.trim(), SOURCE);
  assert.equal(seen[0].width, 413);
  assert.deepEqual(seen[0].counts, { nodes: 2 });
  assert.equal(ctx.host.sourceOf(ctx.block).trim(), SOURCE);
  assert.equal(ctx.block.querySelector('.markdown-sketch-row'), null, 'no row until something goes in it');
  assert.equal(ctx.host.addAction(ctx.block, make('export'), 30), true);
  assert.equal(ctx.host.addAction(ctx.block, make('open'), 10), true);
  assert.equal(ctx.host.addAction(ctx.block, make('mark up'), 50), true);
  assert.equal(ctx.host.addAction(ctx.block, null, 20), false);
  const labels = Array.from(ctx.block.querySelectorAll('.markdown-sketch-row > .markdown-sketch-actions > button')).map((el) => el.textContent);
  assert.deepEqual(labels, ['open', 'export', 'mark up']);
  assert.equal(ctx.host.post(ctx.block, { type: 'export', kind: 'svg', requestId: 'forged' }), true);
  assert.deepEqual(ctx.posted.at(-1), { payload: { type: 'export', kind: 'svg', requestId: ctx.request.requestId }, target: '*' });
  stop();
  say(ctx.dom, ctx.frameWindow, drawnAnswer(ctx));
  assert.equal(seen.length, 1, 'a second answer for the same drawing is not a new drawing');
  assert.equal(ctx.host.post(ctx.document.createElement('div'), { type: 'export', kind: 'svg' }), false);
});

test('a problems note and the action row share one row, the note first', (t) => {
  const ctx = drawOne(t);
  say(ctx.dom, ctx.frameWindow, drawnAnswer(ctx, { problems: [{ code: 'duplicate_id', line: 2, id: 'db' }] }));
  ctx.host.addAction(ctx.block, ctx.document.createElement('button'), 10);
  const rows = ctx.block.querySelectorAll('.markdown-sketch-row');
  assert.equal(rows.length, 1);
  assert.deepEqual(Array.from(rows[0].children).map((el) => el.className.split(' ').pop()), ['markdown-sketch-problems-chip', 'markdown-sketch-actions']);
});

test('a frame\'s other messages reach a module only checked, only from a drawn block\'s own frame', (t) => {
  const ctx = drawOne(t);
  const opened = [];
  const stop = ctx.host.onMessage('open-file', (block, message) => { opened.push([block, message]); });
  ctx.host.onMessage('markup', () => { throw new Error('a broken module'); });
  const open = { type: 'open-file', requestId: ctx.request.requestId, path: 'src/app.js', line: 12, extra: '<img onerror=x>' };
  say(ctx.dom, ctx.frameWindow, open);
  assert.equal(opened.length, 0, 'not before the drawing is up');
  say(ctx.dom, ctx.frameWindow, drawnAnswer(ctx));
  say(ctx.dom, ctx.frameWindow, open);
  assert.deepEqual(opened, [[ctx.block, { type: 'open-file', path: 'src/app.js', line: 12 }]]);
  say(ctx.dom, ctx.frameWindow, { ...open, requestId: 'sketch-999-forged' });
  say(ctx.dom, { postMessage() {} }, open);
  say(ctx.dom, ctx.dom.window, open);
  say(ctx.dom, ctx.frameWindow, { ...open, path: 'a\u0000b' });
  say(ctx.dom, ctx.frameWindow, { ...open, path: 'x'.repeat(1025) });
  say(ctx.dom, ctx.frameWindow, { ...open, path: 42 });
  say(ctx.dom, ctx.frameWindow, { type: 'not-a-type', requestId: ctx.request.requestId });
  say(ctx.dom, ctx.frameWindow, { type: 'export', requestId: ctx.request.requestId, kind: 'svg', ok: true, text: '<svg/>' });
  assert.doesNotThrow(() => say(ctx.dom, ctx.frameWindow, { type: 'markup', requestId: ctx.request.requestId, on: true }));
  assert.equal(opened.length, 1);
  stop();
  say(ctx.dom, ctx.frameWindow, open);
  assert.equal(opened.length, 1, 'a module that left hears nothing');
  assert.equal(ctx.block.getAttribute('data-sketch-rendered'), 'true');
});

test('readFrameMessage rebuilds each message from known fields within their caps', () => {
  const { readFrameMessage, LIMITS } = require('../renderer/features/renderer-sketch-frame-messages');
  assert.deepEqual(readFrameMessage({ type: 'open-file', path: 'a/b.js', line: 0 }), { type: 'open-file', path: 'a/b.js', line: null });
  assert.deepEqual(readFrameMessage({ type: 'open-file', path: 'a/b.js', line: 2.5 }), { type: 'open-file', path: 'a/b.js', line: null });
  assert.equal(readFrameMessage({ type: 'open-file', path: '' }), null);
  assert.equal(readFrameMessage({ type: 'open-file', path: 'a\nb' }), null);
  assert.deepEqual(readFrameMessage({ type: 'export', kind: 'svg', ok: true, name: '../../Evil name<script>', text: '<svg/>' }),
    { type: 'export', kind: 'svg', ok: true, name: 'Evil-name-script.svg', text: '<svg/>' });
  assert.deepEqual(readFrameMessage({ type: 'export', kind: 'png', ok: true, base64: 'iVBORw0KGgo=' }),
    { type: 'export', kind: 'png', ok: true, name: 'sketch.png', base64: 'iVBORw0KGgo=' });
  assert.deepEqual(readFrameMessage({ type: 'export', kind: 'excalidraw', ok: true, name: 'x'.repeat(200), text: '{}' }).name, 'x'.repeat(60) + '.excalidraw');
  for (const bad of [
    { type: 'export', kind: 'png', ok: true, base64: 'not base64!' },
    { type: 'export', kind: 'png', ok: true, text: '<svg/>' },
    { type: 'export', kind: 'svg', ok: true, text: '' },
    { type: 'export', kind: 'svg', ok: true, text: 'x'.repeat(LIMITS.exportText + 1) },
    { type: 'export', kind: 'svg', ok: 'true', text: '<svg/>' },
    { type: 'export', kind: 'svg' },
  ]) {
    assert.deepEqual(readFrameMessage(bad), { type: 'export', kind: bad.kind, ok: false });
  }
  assert.equal(readFrameMessage({ type: 'export', kind: 'pdf', ok: true, text: 'x' }), null);
  assert.equal(readFrameMessage({ type: 'export', kind: 'constructor', ok: true, text: 'x' }), null);
  assert.deepEqual(readFrameMessage({ type: 'ask', askId: 'ask-3', text: '  What is this?  ', pngBase64: 'AAAA', to: 'someone' }),
    { type: 'ask', askId: 'ask-3', text: 'What is this?', pngBase64: 'AAAA' });
  assert.equal(readFrameMessage({ type: 'ask', askId: 'ask-3', text: 'q'.repeat(9000) }).text.length, LIMITS.askText);
  assert.equal(readFrameMessage({ type: 'ask', askId: 'ask-3', text: 'q', pngBase64: '<svg onload=x>' }).pngBase64, '');
  assert.equal(readFrameMessage({ type: 'ask', askId: 'ask 3', text: 'q' }), null);
  assert.equal(readFrameMessage({ type: 'ask', askId: 'a'.repeat(65), text: 'q' }), null);
  assert.equal(readFrameMessage({ type: 'ask', askId: 'ask-3', text: '   ' }), null);
  assert.deepEqual(readFrameMessage({ type: 'markup', on: 'yes' }), { type: 'markup', on: false });
  assert.deepEqual(readFrameMessage({ type: 'markup', on: true }), { type: 'markup', on: true });
  for (const other of [null, 'ask', 7, {}, { type: 'rendered' }, { type: 'height' }, { type: '__proto__' }]) assert.equal(readFrameMessage(other), null);
});

test('a request carries the earlier drawings a provider names: at most four, each within bounds', (t) => {
  const ctx = setup(t, fence(SOURCE));
  const asked = [];
  ctx.host.setEarlierProvider((block, source) => {
    asked.push([block, source.trim()]);
    return [
      { source: 'a A', positions: { direction: 'right', positions: { a: { x: 1, y: 2 } } } },
      { source: 'x'.repeat(16385) },
      { source: 42 },
      null,
      { source: 'b B', positions: 'not positions' },
      { source: 'c C' },
      { source: 'd D' },
      { source: 'e E' },
    ];
  });
  ctx.host.renderInline(ctx.container);
  const block = ctx.container.querySelector('.markdown-sketch-block');
  const frame = frameOf(block);
  say(ctx.dom, frame.frameWindow, { type: 'sketch-frame-ready' });
  const request = frame.posted.find((entry) => entry.payload.type === 'render').payload;
  assert.deepEqual(asked, [[block, SOURCE]]);
  assert.deepEqual(request.earlier, [
    { source: 'a A', positions: { direction: 'right', positions: { a: { x: 1, y: 2 } } } },
    { source: 'b B', positions: null },
    { source: 'c C', positions: null },
    { source: 'd D', positions: null },
  ]);
  // A provider that throws, and a block drawn with its own positions, send none.
  ctx.host.resetBlock(block);
  ctx.host.setEarlierProvider(() => { throw new Error('a broken module'); });
  ctx.host.renderBlock(block);
  const second = frameOf(block);
  say(ctx.dom, second.frameWindow, { type: 'sketch-frame-ready' });
  assert.deepEqual(second.posted.find((entry) => entry.payload.type === 'render').payload.earlier, []);
});

// The action modules the loader brings in after the host: file name -> the global each sets.
const ACTION_MODULES = {
  'renderer-sketch-followup.js': 'rendererSketchFollowUp',
  'renderer-sketch-export.js': 'rendererSketchExport',
  'renderer-sketch-markup.js': 'rendererSketchMarkup',
  'renderer-sketch-open.js': 'rendererSketchOpen',
  'renderer-sketch-pin.js': 'rendererSketchPin',
}; // ACTION_MODULES end

test('the loader brings in what the host reads, the host, then the action modules, once; each is attached; a failed load is tried again', async (t) => {
  delete require.cache[LOADER_PATH];
  const loader = require(LOADER_PATH);
  const loaded = [];
  const attached = [];
  const previous = { loaderUtils: globalThis.scriptLoaderUtils, host: globalThis.rendererSketchFrameHost };
  delete globalThis.rendererSketchFrameHost;
  const host = { renderInline() {} };
  const actionFiles = Object.keys(ACTION_MODULES);
  const broken = actionFiles[0]; // one module whose attach throws: it costs its buttons, never the host
  globalThis.scriptLoaderUtils = {
    ensureScript: async ({ src, isReady }) => {
      loaded.push([src, isReady()]);
      const file = src.split('/').pop();
      if (file === 'renderer-sketch-frame-host.js') globalThis.rendererSketchFrameHost = host;
      if (ACTION_MODULES[file]) {
        globalThis[ACTION_MODULES[file]] = { attach(given) { attached.push([file, given]); if (file === broken) throw new Error('a broken module'); } };
      }
    },
  };
  t.after(() => {
    globalThis.scriptLoaderUtils = previous.loaderUtils;
    globalThis.rendererSketchFrameHost = previous.host;
    for (const name of Object.values(ACTION_MODULES)) delete globalThis[name];
    loader._resetForTests();
  });
  const [first, second] = await Promise.all([loader.ensureSketchHost(), loader.ensureSketchHost()]);
  assert.equal(first, host);
  assert.equal(second, host);
  const names = loaded.map(([src]) => src.split('/').pop());
  assert.deepEqual(names.slice(0, 3), ['renderer-sketch-frame-messages.js', 'renderer-sketch-frame-palette.js', 'renderer-sketch-frame-host.js'], 'one load each, in order');
  assert.equal(new Set(names).size, names.length, 'two callers, one load');
  assert.deepEqual(names.slice(3).sort(), [...actionFiles].sort(), 'every action module is loaded, after the host');
  assert.deepEqual(attached.map(([file]) => file).sort(), [...actionFiles].sort(), 'and attached once');
  assert.ok(attached.every(([, given]) => given === host), 'to the host');
  for (const name of Object.values(ACTION_MODULES)) delete globalThis[name];
  // A load that fails is tried again by the next sketch block.
  loader._resetForTests();
  delete globalThis.rendererSketchFrameHost;
  globalThis.scriptLoaderUtils = { ensureScript: async () => { throw new Error('offline'); } };
  assert.equal(await loader.ensureSketchHost(), null);
  globalThis.scriptLoaderUtils = { ensureScript: async ({ src }) => { if (src.endsWith('renderer-sketch-frame-host.js')) globalThis.rendererSketchFrameHost = host; } };
  assert.equal(await loader.ensureSketchHost(), host);
});
