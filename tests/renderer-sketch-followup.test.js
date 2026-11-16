'use strict';

// new-test-file: the follow-up module (plan 5.5, slice S7) is a new lazily loaded surface; it is attached to
// the real frame host, whose own file (tests/renderer-sketch-frame-host.test.js) stays the host's contract.

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const HOST_PATH = require.resolve('../renderer/features/renderer-sketch-frame-host');
const MODULE_PATH = require.resolve('../renderer/features/renderer-sketch-followup');
const markdownUtils = require('../renderer/shared/markdown-utils');

const fence = (body, info = 'sketch') => '```' + info + '\n' + body + '\n```';
const sketch = (name) => `${name} ${name.toUpperCase()}\nnext Next\n${name} -> next`;
const positionsOf = (name) => ({ direction: 'right', positions: { [name]: { x: name.length, y: 2 }, next: { x: 9, y: 9 } } });

/** A page with one or more conversations (`.chat-timeline`), each a list of messages, each a markdown string. */
function setup(t, conversations) {
  const html = conversations.map((messages, index) => `<div class="chat-timeline" id="chat${index}" role="log">${
    messages.map((markdown) => `<article class="chat-bubble"><div class="chat-bubble-markdown">${markdownUtils.renderMarkdown(markdown)}</div></article>`).join('')
  }</div>`).join('');
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${html}<div id="viewer"></div></body></html>`, { pretendToBeVisual: true, url: 'http://localhost/' });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  delete require.cache[HOST_PATH];
  delete require.cache[MODULE_PATH];
  const host = require(HOST_PATH);
  const followUp = require(MODULE_PATH);
  t.after(() => {
    host.dispose();
    dom.window.close();
  });
  const blocksIn = (selector) => Array.from(dom.window.document.querySelectorAll(`${selector} .markdown-code-block`));
  return { dom, host, followUp, document: dom.window.document, blocksIn };
}

function frameOf(block) {
  const iframe = block.querySelector('.markdown-sketch-paper > iframe');
  assert.ok(iframe, 'the block has a frame');
  if (!iframe.sketchTestWindow) {
    const posted = [];
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: { posted, postMessage: (payload, target) => posted.push({ payload, target }) } });
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

/** Starts a block's frame, and returns the request the page sent it. `answer` (positions) draws it too. */
function drive(ctx, block, answer) {
  ctx.host.renderBlock(block);
  const frame = frameOf(block);
  say(ctx.dom, frame, { type: 'sketch-frame-ready' });
  const request = frame.posted.filter((entry) => entry.payload.type === 'render').at(-1).payload;
  if (answer) {
    say(ctx.dom, frame, { type: 'rendered', requestId: request.requestId, ok: true, height: 200, width: 300, problems: [], counts: { nodes: 2 }, positions: answer });
  }
  return request;
}

test('the module does nothing at load: before attach the host has no provider and nothing is remembered', (t) => {
  const ctx = setup(t, [[fence(sketch('a')), fence(sketch('b'))]]);
  const [first, second] = ctx.blocksIn('#chat0');
  assert.equal(typeof ctx.followUp.attach, 'function');
  assert.deepEqual(drive(ctx, first, positionsOf('a')).earlier, []);
  assert.deepEqual(drive(ctx, second).earlier, [], 'before attach the host has no provider');
});

test('the provider names the earlier blocks nearest first, at most four, and the first block gets none', (t) => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const ctx = setup(t, [names.map((name) => fence(sketch(name)))]);
  const detach = ctx.followUp.attach(ctx.host);
  t.after(detach);
  const blocks = ctx.blocksIn('#chat0');
  const requests = blocks.map((block, index) => drive(ctx, block, positionsOf(names[index])));
  assert.deepEqual(requests[0].earlier, [], 'the first sketch block of the conversation');
  assert.deepEqual(requests[1].earlier.map((item) => item.source.split(' ')[0]), ['a']);
  assert.deepEqual(requests[2].earlier.map((item) => item.source.split(' ')[0]), ['b', 'a'], 'nearest first');
  assert.deepEqual(requests[6].earlier.map((item) => item.source.split(' ')[0]), ['f', 'e', 'd', 'c'], 'at most four');
  assert.deepEqual(requests[6].earlier[0].positions, positionsOf('f'), 'a drawn block\'s positions ride along');
});

test('blocks of the same message count, and so do blocks of earlier messages; text between them does not matter', (t) => {
  const ctx = setup(t, [[
    `Here is one.\n\n${fence(sketch('a'))}\n\nAnd another in the same message.\n\n${fence(sketch('b'))}`,
    'A message with no drawing.',
    `${fence(sketch('c'))}\n\n${fence('print(1)', 'python')}`,
  ]]);
  ctx.followUp.attach(ctx.host);
  const blocks = ctx.blocksIn('#chat0').filter((block) => block.querySelector('code.language-sketch'));
  assert.equal(blocks.length, 3);
  const [a, b, c] = blocks;
  assert.deepEqual(drive(ctx, a, positionsOf('a')).earlier, []);
  assert.deepEqual(drive(ctx, b, positionsOf('b')).earlier.map((item) => item.source.split(' ')[0]), ['a'], 'same message');
  assert.deepEqual(drive(ctx, c).earlier.map((item) => item.source.split(' ')[0]), ['b', 'a'], 'an earlier message, and not the python block');
});

test('another conversation\'s blocks, and a block outside any conversation, are left out', (t) => {
  const ctx = setup(t, [[fence(sketch('a')), fence(sketch('b'))], [fence(sketch('x')), fence(sketch('y'))]]);
  ctx.followUp.attach(ctx.host);
  const [a, b] = ctx.blocksIn('#chat0');
  const [x, y] = ctx.blocksIn('#chat1');
  assert.deepEqual(drive(ctx, a, positionsOf('a')).earlier, []);
  assert.deepEqual(drive(ctx, x, positionsOf('x')).earlier, [], 'the second conversation starts empty although another drew first');
  assert.deepEqual(drive(ctx, y).earlier.map((item) => item.source.split(' ')[0]), ['x']);
  assert.deepEqual(drive(ctx, b).earlier.map((item) => item.source.split(' ')[0]), ['a']);
  // The full-window viewer holds a copy of a block outside the timeline: it has no earlier drawings.
  const viewer = ctx.document.getElementById('viewer');
  viewer.innerHTML = markdownUtils.renderMarkdown(fence(sketch('v')));
  const copy = viewer.querySelector('.markdown-code-block');
  assert.deepEqual(drive(ctx, copy).earlier, []);
});

test('a reasoning panel\'s block is no earlier drawing', (t) => {
  const ctx = setup(t, [[fence(sketch('a')), fence(sketch('b'))]]);
  ctx.followUp.attach(ctx.host);
  const [a, b] = ctx.blocksIn('#chat0');
  a.closest('.chat-bubble').classList.add('reasoning-row-panel');
  assert.deepEqual(drive(ctx, b).earlier, []);
});

test('positions are remembered on a drawing and sent for a seen source; an unseen one is sent as null', (t) => {
  const ctx = setup(t, [[fence(sketch('a')), fence(sketch('b')), fence(sketch('c'))]]);
  ctx.followUp.attach(ctx.host);
  const [a, b, c] = ctx.blocksIn('#chat0');
  // a is drawn and remembered; b was never drawn (it scrolled in late, or came back after a restart).
  drive(ctx, a, positionsOf('a'));
  const request = drive(ctx, c);
  assert.deepEqual(request.earlier.map((item) => item.source.split(' ')[0]), ['b', 'a']);
  assert.equal(request.earlier[0].positions, null, 'b was never drawn: the frame lays it out fresh');
  assert.deepEqual(request.earlier[1].positions, positionsOf('a'));
  // Once b is drawn too, it is remembered.
  drive(ctx, b, positionsOf('b'));
  ctx.host.resetBlock(c);
  assert.deepEqual(drive(ctx, c).earlier.map((item) => item.positions), [positionsOf('b'), positionsOf('a')]);
});

test('a block drawn without positions is not remembered', (t) => {
  const ctx = setup(t, [[fence(sketch('a')), fence(sketch('b'))]]);
  ctx.followUp.attach(ctx.host);
  const [a, b] = ctx.blocksIn('#chat0');
  drive(ctx, a, null);
  const frame = frameOf(a);
  say(ctx.dom, frame, { type: 'rendered', requestId: frame.posted.filter((entry) => entry.payload.type === 'render').at(-1).payload.requestId, ok: true, height: 100, width: 100, problems: [], counts: { nodes: 2 } });
  assert.deepEqual(drive(ctx, b).earlier.map((item) => item.positions), [null]);
});

// The cap and the order of forgetting do not need fifty frames: a host that only reports drawings is enough.
function fakeHost(document) {
  const host = {
    listeners: new Set(),
    provider: undefined,
    drawn: new Map(),
    onDrawn(listener) { host.listeners.add(listener); return () => host.listeners.delete(listener); },
    setEarlierProvider(provider) { host.provider = provider; },
    sourceOf(block) { return block.sourceForTest || ''; },
    getPositions(block) { return host.drawn.get(block) || null; },
  };
  host.draw = (source, positions) => {
    const block = document.createElement('div');
    host.drawn.set(block, positions);
    for (const listener of Array.from(host.listeners)) listener({ block, source, width: 1, counts: null });
  };
  return host;
}

function timelineOf(document, sources) {
  const timeline = document.createElement('div');
  timeline.className = 'chat-timeline';
  document.body.appendChild(timeline);
  const blocks = [...sources, 'now N'].map((source) => {
    const block = document.createElement('div');
    block.className = 'markdown-code-block';
    block.innerHTML = '<pre><code class="language-sketch"></code></pre>';
    block.querySelector('code').textContent = source;
    timeline.appendChild(block);
    return block;
  });
  return blocks.at(-1);
}

test('at most 50 sources are remembered, the least recently used dropped first', (t) => {
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  t.after(() => dom.window.close());
  const document = dom.window.document;
  delete require.cache[MODULE_PATH];
  const followUp = require(MODULE_PATH);
  const host = fakeHost(document);
  followUp.attach(host);
  const ask = (...sources) => host.provider(timelineOf(document, sources.slice().reverse()), 'now N');
  const seen = (...sources) => ask(...sources).map((item) => item.positions !== null);
  const at = (n) => ({ direction: 'right', positions: { [`k${n}`]: { x: n, y: n } } });
  const key = (n) => `k${n} K${n}`;
  for (let n = 0; n < 50; n += 1) host.draw(key(n), at(n));
  assert.deepEqual(seen(key(0), key(49)), [true, true], 'fifty are kept');
  // A source that is read counts as used: k0 and k49 are now the most recent, k1 is the oldest.
  host.draw(key(50), at(50));
  assert.deepEqual(seen(key(1)), [false], 'the oldest (k1) went when the fifty-first arrived');
  assert.deepEqual(seen(key(0)), [true], 'k0 was read and stays');
  // Forty-nine more: everything unused since goes, and k0 (read after k49 and k50) outlives both of them.
  for (let n = 51; n < 100; n += 1) host.draw(key(n), at(n));
  assert.deepEqual(seen(key(49), key(50)), [false, false]);
  assert.deepEqual(seen(key(0), key(99), key(60)), [true, true, true]);
  // Fifty fresh ones push even k0 out.
  for (let n = 100; n < 150; n += 1) host.draw(key(n), at(n));
  assert.deepEqual(seen(key(0)), [false]);
  // Drawing the same source again replaces its positions and keeps one entry.
  host.draw(key(149), at(1000));
  assert.deepEqual(ask(key(149))[0].positions, at(1000));
});

test('detach clears the provider, the listener and the memory', (t) => {
  const ctx = setup(t, [[fence(sketch('a')), fence(sketch('b')), fence(sketch('c'))]]);
  const detach = ctx.followUp.attach(ctx.host);
  const [a, b, c] = ctx.blocksIn('#chat0');
  drive(ctx, a, positionsOf('a'));
  assert.equal(typeof detach, 'function');
  detach();
  assert.deepEqual(drive(ctx, b, positionsOf('b')).earlier, [], 'no provider after detach');
  // Attached again, nothing from before is remembered, and the old listener is gone.
  const again = ctx.followUp.attach(ctx.host);
  t.after(again);
  const request = drive(ctx, c);
  assert.deepEqual(request.earlier.map((item) => item.positions), [null, null], 'a and b were drawn while detached or before it');
  detach();
  ctx.host.resetBlock(b);
  assert.deepEqual(drive(ctx, b).earlier.map((item) => item.source.split(' ')[0]), ['a'], 'a stale detach leaves the newer attach alone');
});
