const test = require('node:test');
const assert = require('node:assert/strict');

const { createPreReadyEventBuffer } = require('../renderer/shared/terminal-stream-utils');

test('pre-ready buffer drops an oversized first event and reports cumulative drop totals', () => {
  const drops = [];
  const buffer = createPreReadyEventBuffer({
    maxEvents: 64,
    maxBytes: 4,
    sizeOf: (_kind, payload) => payload.length,
    onDrop: (drop) => drops.push(drop),
  });

  buffer.push('data', '123456789');

  assert.deepEqual(buffer.drain(), [], 'oversized event is not retained');
  assert.deepEqual(drops, [{ droppedEvents: 1, droppedBytes: 9 }]);
});

const { JSDOM } = require('jsdom');
const {
  createBoundedScrollbackPainter,
  resolveFrameScheduler,
  killOutcomeConfirmed,
} = require('../renderer/shared/terminal-stream-utils');

function painterHarness(maxChars) {
  const dom = new JSDOM('<!doctype html><body><pre id="pre"></pre></body>');
  const pre = dom.window.document.getElementById('pre');
  let paints = 0;
  const frames = [];
  const painter = createBoundedScrollbackPainter({
    requestFrame: (cb) => { frames.push(cb); return frames.length; },
    cancelFrame: () => {},
    maxChars,
    getScrollbackEl: () => pre,
    applyDroppedMarkers: () => { paints += 1; },
  });
  return { pre, painter, paints: () => paints };
}

// Perf: once at the cap, every frame trimmed the head node and appended a new
// one (a full relayout of the whole log per frame). Eviction now drops to
// ~75% of the cap, line-aligned, in one step, so the next frames only append.
test('painter evicts with hysteresis to a line boundary, then appends without trimming', () => {
  const h = painterHarness(100);
  for (let i = 0; i < 12; i += 1) h.painter.append(`line-${String(i).padStart(2, '0')}\n`); // 8 chars each = 96
  h.painter.sync();
  h.painter.append('line-12\n'); // 104 > 100: evict
  h.painter.sync();
  const text = h.pre.textContent;
  assert.ok(text.length <= 75, `dropped to ~75% of the cap (now ${text.length})`);
  assert.ok(text.startsWith('line-'), 'the cut is line-aligned');
  assert.ok(text.endsWith('line-12\n'));
  const after = text.length;
  h.painter.append('line-13\n');
  h.painter.sync();
  assert.equal(h.pre.textContent.length, after + 8, 'under the cap again: a pure append, no head trim');
});

test('painter keeps the text node count bounded under a long stream', () => {
  const h = painterHarness(1 << 20);
  for (let i = 0; i < 2000; i += 1) {
    h.painter.append(`x${i}\n`);
    h.painter.sync();
  }
  assert.ok(h.pre.childNodes.length <= 256, `bounded node count (saw ${h.pre.childNodes.length})`);
  assert.match(h.pre.textContent, /x0\n[\s\S]*x1999\n$/);
});

test('syncIfPending paints only when there is something to paint', () => {
  const h = painterHarness(1000);
  h.painter.append('a\n');
  h.painter.syncIfPending();
  const paints = h.paints();
  h.painter.syncIfPending();
  h.painter.syncIfPending();
  assert.equal(h.paints(), paints, 'an idle render pass does not touch the DOM');
  h.painter.append('b\n');
  h.painter.syncIfPending();
  assert.equal(h.pre.textContent, 'a\nb\n');
});

test('resolveFrameScheduler prefers injected impls, then the window rAF, then a sync fallback', () => {
  const injected = () => 7;
  assert.equal(resolveFrameScheduler({ requestAnimationFrameImpl: injected }, {}).requestFrame, injected);
  let called = 0;
  const win = { requestAnimationFrame(cb) { called += 1; cb(0); return 1; }, cancelAnimationFrame() {} };
  resolveFrameScheduler({}, win).requestFrame(() => {});
  assert.equal(called, 1);
  let ran = false;
  resolveFrameScheduler(null, {}).requestFrame(() => { ran = true; });
  assert.equal(ran, true, 'no rAF: the callback runs synchronously');
});

test('pre-ready buffer defaults its caps and replays by kind', () => {
  const buffer = createPreReadyEventBuffer({ sizeOf: (kind, p) => (kind === 'data' ? p.length : 0) });
  for (let i = 0; i < 70; i += 1) buffer.push('data', 'x');
  const seen = [];
  buffer.push('exit', 'done');
  buffer.replay({ data: (p) => seen.push(['data', p]), exit: (p) => seen.push(['exit', p]) });
  assert.equal(seen.length, 64, 'default 64-event cap');
  assert.deepEqual(seen[seen.length - 1], ['exit', 'done']);
  assert.deepEqual(buffer.drain(), [], 'replay drains');
});

test('killOutcomeConfirmed: only a confirmed or already-gone kill counts as stopped', () => {
  assert.equal(killOutcomeConfirmed({ killed: true, terminationConfirmed: true }), true);
  assert.equal(killOutcomeConfirmed({ killed: false }), true, 'nothing to kill: already gone');
  assert.equal(killOutcomeConfirmed({ ok: true, killed: false }), true);
  assert.equal(killOutcomeConfirmed({ killed: false, terminationConfirmed: false }), false);
  assert.equal(killOutcomeConfirmed({ ok: false, code: 'X' }), false);
  assert.equal(killOutcomeConfirmed(undefined), false);
});

// R1: the optional linkify hook builds the painted nodes (link elements) in place of a text node.
function wrapLinkify(doc, text) {
  const fragment = doc.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(/\[\[(\w+)\]\]/g)) {
    if (match.index > last) fragment.appendChild(doc.createTextNode(text.slice(last, match.index)));
    const span = doc.createElement('span');
    span.textContent = match[0];
    fragment.appendChild(span);
    last = match.index + match[0].length;
  }
  if (last < text.length) fragment.appendChild(doc.createTextNode(text.slice(last)));
  return fragment;
}

function linkifyHarness(maxChars) {
  const dom = new JSDOM('<!doctype html><body><pre id="pre"></pre></body>');
  const pre = dom.window.document.getElementById('pre');
  const painter = createBoundedScrollbackPainter({
    requestFrame: (cb) => { cb(0); return 1; },
    cancelFrame: () => {},
    maxChars,
    getScrollbackEl: () => pre,
    linkify: wrapLinkify,
  });
  return { pre, push: (text) => { painter.append(text); painter.sync(); } };
}

test('painter linkify: full repaint and incremental appends insert the linkified nodes', () => {
  const h = linkifyHarness(1000);
  h.push('a [[one]] b\n');
  h.push('c [[two]]\n');
  assert.equal(h.pre.textContent, 'a [[one]] b\nc [[two]]\n');
  assert.equal(h.pre.querySelectorAll('span').length, 2);
});

test('painter linkify: the partial last line is re-linkified with the next chunk', () => {
  const h = linkifyHarness(1000);
  h.push('head\nx [[tw');
  assert.equal(h.pre.querySelectorAll('span').length, 0);
  h.push('o]] y\n');
  assert.equal(h.pre.querySelectorAll('span').length, 1);
  assert.equal(h.pre.querySelector('span').textContent, '[[two]]');
  assert.equal(h.pre.textContent, 'head\nx [[two]] y\n');
});

test('painter linkify: eviction trims a head element to its remaining text and removes whole ones', () => {
  const h = linkifyHarness(20);
  h.push('[[abcdef]]xxxxx'); // 15 chars, one span then text
  h.push('yyyyyyy'); // 22 > 20: evicts 7 chars (cap 20 -> keep 15), through the span
  assert.equal(h.pre.textContent, '[[abcdef]]xxxxxyyyyyyy'.slice(7));
  assert.equal(h.pre.querySelectorAll('span').length, 0, 'the cut span became plain text');
  assert.equal(h.pre.firstChild.nodeType, 3);
});

test('painter without linkify is unchanged: plain text nodes only', () => {
  const dom = new JSDOM('<!doctype html><body><pre id="pre"></pre></body>');
  const pre = dom.window.document.getElementById('pre');
  const painter = createBoundedScrollbackPainter({
    requestFrame: (cb) => { cb(0); return 1; }, cancelFrame: () => {}, maxChars: 100, getScrollbackEl: () => pre,
  });
  painter.append('a [[one]]\n');
  painter.sync();
  painter.append('b\n');
  painter.sync();
  assert.equal(pre.querySelectorAll('*').length, 0);
  assert.equal(pre.textContent, 'a [[one]]\nb\n');
});
