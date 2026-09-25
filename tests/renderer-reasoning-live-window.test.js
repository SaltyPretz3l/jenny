const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  LIVE_WINDOW_CHARS,
  LIVE_WINDOW_ELIDED_FINGERPRINT,
  LIVE_WINDOW_NOTE_FINGERPRINT,
  resolveLiveWindowStart,
} = require('../renderer/chat/reasoning-row-v2-utils');
const {
  clearReasoningStreamStateCache,
  createReasoningV2Renderer,
} = require('../renderer/chat/renderer-transcript-reasoning-v2');
const {
  ThinkingPanelController,
  groupReasoningByPhase,
  shouldShowThinkingToggle,
} = require('../renderer/chat/chat-thinking-utils');
const { reconcileStreamUnits } = require('../renderer/chat/renderer-stream-dom-patch-utils');

test.beforeEach(() => {
  clearReasoningStreamStateCache();
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// One unit per KB of html so window arithmetic reads in whole units.
function makeUnits(count, htmlChars = 1024) {
  return Array.from({ length: count }, (_, index) => ({
    html: `<p>${String(index).padStart(4, '0')}${'x'.repeat(htmlChars - 11)}</p>`,
    fingerprint: `fp_${index}`,
  }));
}

function makeRenderer(unitsRef) {
  return createReasoningV2Renderer({
    escapeHtml,
    groupReasoningByPhase,
    getReasoningEntries: (message) => (message?.reasoning?.entries || []),
    renderMarkdown: (s) => `<p>${escapeHtml(s)}</p>`,
    renderStreamingMarkdownUnits: () => ({
      html: unitsRef.units.map((unit) => unit.html).join(''),
      units: unitsRef.units,
      streamState: { version: 1 },
    }),
    shouldShowThinkingToggle,
    thinkingController: new ThinkingPanelController(),
  });
}

function message(status, text) {
  return {
    id: 'live_window_message',
    role: 'assistant',
    status,
    reasoning: {
      source: 'provider',
      status,
      entries: [{ id: 'r1', thinkingId: 'phase_1', text }],
    },
  };
}

function unitsOf(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  try {
    return Array.from(dom.window.document.querySelectorAll('[data-stream-unit-index]')).map((el) => ({
      index: Number(el.getAttribute('data-stream-unit-index')),
      fp: el.getAttribute('data-su-fp'),
      html: el.innerHTML,
    }));
  } finally {
    dom.window.close();
  }
}

test('resolveLiveWindowStart keeps everything under the window and the trailing window above it', () => {
  assert.equal(resolveLiveWindowStart(makeUnits(10), 0), 0);
  assert.equal(resolveLiveWindowStart(makeUnits(32), 0), 0, 'exactly the window is not elided');
  // 40 KB of 1 KB units: keep the trailing 32, elide the first 8.
  assert.equal(resolveLiveWindowStart(makeUnits(40), 0), 8);
  // A single oversized tail unit stays live on its own.
  assert.equal(resolveLiveWindowStart([{ html: 'a'.repeat(LIVE_WINDOW_CHARS + 5) }], 0), 0);
  assert.equal(resolveLiveWindowStart(makeUnits(3).concat([{ html: 'a'.repeat(LIVE_WINDOW_CHARS + 5) }]), 0), 3);
  assert.equal(resolveLiveWindowStart([], 0), 0);
});

test('resolveLiveWindowStart preserves the elided character floor and clamps it before the tail', () => {
  assert.equal(resolveLiveWindowStart(makeUnits(40), 0, { previousElidedChars: 12 * 1024 }), 12);
  assert.equal(resolveLiveWindowStart(makeUnits(10), 0, { previousElidedChars: 4 * 1024 }), 4);
  assert.equal(resolveLiveWindowStart(makeUnits(5), 40, { previousElidedChars: 40 * 1024 }), 4,
    'a re-chunk below the old start elides as much as possible without hiding the tail');
  assert.equal(resolveLiveWindowStart(makeUnits(40), 40, { previousElidedChars: 40 * 1024 }), 39);
  assert.equal(resolveLiveWindowStart(makeUnits(40), -3), 8);
  assert.equal(resolveLiveWindowStart(makeUnits(40), 0, { windowChars: 10 * 1024 }), 30);
});

test('a re-chunk preserves the previously elided character budget', () => {
  const previousUnits = makeUnits(40);
  const previousStart = resolveLiveWindowStart(previousUnits, 0);
  const previousElidedChars = previousUnits
    .slice(0, previousStart)
    .reduce((total, unit) => total + unit.html.length, 0);
  const rechunkedUnits = makeUnits(5, 4 * 1024);
  const start = resolveLiveWindowStart(rechunkedUnits, previousStart, { previousElidedChars });

  assert.equal(previousStart, 8);
  assert.equal(start, 2);
  assert.ok(start < rechunkedUnits.length, 'the tail unit stays live');
});

test('a single oversized re-chunk keeps its only tail unit live', () => {
  const units = [{ html: 'a'.repeat(LIVE_WINDOW_CHARS + 5) }];
  assert.equal(resolveLiveWindowStart(units, 8, { previousElidedChars: 8 * 1024 }), 0);
});

test('growing and re-chunked frames never decrease the elided character count', () => {
  let previousStart = 0;
  let previousElidedChars = 0;
  for (let frame = 0; frame < 30; frame += 1) {
    const unitCount = [40, 17, 29][frame % 3];
    const units = makeUnits(unitCount, Math.floor((40 * 1024 + frame * 4 * 1024) / unitCount));
    const start = resolveLiveWindowStart(units, previousStart, { previousElidedChars });
    const elidedChars = units.slice(0, start).reduce((total, unit) => total + unit.html.length, 0);
    assert.ok(elidedChars >= previousElidedChars, `frame ${frame} retained the character floor`);
    assert.ok(start < units.length, `frame ${frame} kept the tail live`);
    previousStart = start;
    previousElidedChars = elidedChars;
  }
});

test('streaming markup elides leading units past the window and carries the note on the last elided unit', () => {
  const unitsRef = { units: makeUnits(40) };
  const renderer = makeRenderer(unitsRef);
  const html = renderer.renderThinkingWidget(message('streaming', 'body'), 'live_window_message');
  const units = unitsOf(html);
  assert.equal(units.length, 40, 'unit count and indices are unchanged');
  for (let index = 0; index < 7; index += 1) {
    assert.equal(units[index].fp, LIVE_WINDOW_ELIDED_FINGERPRINT, `unit ${index} elided`);
    assert.equal(units[index].html, '', `unit ${index} empty`);
  }
  assert.equal(units[7].fp, LIVE_WINDOW_NOTE_FINGERPRINT);
  assert.match(units[7].html, /Earlier thinking will show when this step completes/);
  assert.match(units[7].html, /class="reasoning-row-meta reasoning-live-window-note"/);
  for (let index = 8; index < 40; index += 1) {
    assert.equal(units[index].fp, `fp_${index}`, `unit ${index} live`);
    assert.equal(units[index].html, unitsRef.units[index].html);
  }
});

test('streaming markup under the window and the settled render both carry the full body', () => {
  const unitsRef = { units: makeUnits(20) };
  const renderer = makeRenderer(unitsRef);
  const live = unitsOf(renderer.renderThinkingWidget(message('streaming', 'body'), 'live_window_message'));
  assert.equal(live.length, 20);
  assert.ok(live.every((unit, index) => unit.fp === `fp_${index}` && unit.html === unitsRef.units[index].html));

  unitsRef.units = makeUnits(40);
  const settled = renderer.renderThinkingWidget(message('complete', 'settled body'), 'other_message');
  assert.equal(unitsOf(settled).length, 0, 'settled bodies are flat');
  assert.doesNotMatch(settled, /elided/);
  assert.match(settled, /settled body/);
});

test('the elided character count is threaded through the stream cache across frames', () => {
  const unitsRef = { units: makeUnits(40) };
  const renderer = makeRenderer(unitsRef);
  assert.equal(unitsOf(renderer.renderThinkingWidget(message('streaming', 'a'), 'live_window_message'))[7].fp, LIVE_WINDOW_NOTE_FINGERPRINT);
  // Fewer, larger units retain the same 8 KB character floor despite the new indices.
  unitsRef.units = makeUnits(5, 4 * 1024);
  const units = unitsOf(renderer.renderThinkingWidget(message('streaming', 'ab'), 'live_window_message'));
  assert.equal(units[1].fp, LIVE_WINDOW_NOTE_FINGERPRINT);
  assert.equal(units[2].fp, 'fp_2');
  // Growth past the window advances it.
  unitsRef.units = makeUnits(41);
  assert.equal(unitsOf(renderer.renderThinkingWidget(message('streaming', 'abc'), 'live_window_message'))[8].fp, LIVE_WINDOW_NOTE_FINGERPRINT);
  // Settling evicts the cache; a later streaming phase for the same key starts fresh.
  renderer.renderThinkingWidget(message('complete', 'abc'), 'live_window_message');
  unitsRef.units = makeUnits(10);
  assert.ok(unitsOf(renderer.renderThinkingWidget(message('streaming', 'abcd'), 'live_window_message')).every((unit) => unit.fp.startsWith('fp_')));
});

test('reconcileStreamUnits empties newly elided units in place and leaves the live window untouched', () => {
  const dom = new JSDOM('<!doctype html><body><div id="c"></div><div id="n"></div></body>');
  const doc = dom.window.document;
  const container = doc.getElementById('c');
  const next = doc.getElementById('n');
  const before = makeUnits(40);
  container.innerHTML = before
    .map((unit, index) => `<div class="reasoning-stream-unit" data-stream-unit-index="${index}" data-su-fp="${unit.fingerprint}">${unit.html}</div>`)
    .join('');
  const unitsRef = { units: before };
  next.innerHTML = unitsOf(makeRenderer(unitsRef).renderThinkingWidget(message('streaming', 'body'), 'live_window_message'))
    .map((unit) => `<div class="reasoning-stream-unit" data-stream-unit-index="${unit.index}" data-su-fp="${unit.fp}">${unit.html}</div>`)
    .join('');
  const liveUnits = Array.from(container.children).slice(8);
  for (const el of liveUnits) {
    Object.defineProperty(el, 'innerHTML', {
      get() { throw new Error('live unit was serialized'); },
      set() { throw new Error('live unit was rewritten'); },
    });
  }

  reconcileStreamUnits(container, next, doc, { unitClassName: 'reasoning-stream-unit', revealCap: 2 });

  assert.equal(container.children.length, 40);
  for (let index = 0; index < 7; index += 1) {
    assert.equal(container.children[index].getAttribute('data-su-fp'), LIVE_WINDOW_ELIDED_FINGERPRINT);
    assert.equal(container.children[index].textContent, '');
  }
  assert.equal(container.children[7].getAttribute('data-su-fp'), LIVE_WINDOW_NOTE_FINGERPRINT);
  assert.match(container.children[7].textContent, /Earlier thinking/);
  assert.equal(container.children[39].getAttribute('data-su-fp'), 'fp_39');
  dom.window.close();
});

// Astra batch review 2026-09-20: a frame whose single tail unit exceeds the
// window elides nothing by necessity; the next multi-unit frame must still
// honour the historical floor rather than the dip.
test('the cached elided budget keeps its historical maximum across a tail-clamped frame', () => {
  const unitsRef = { units: makeUnits(40) };
  const renderer = makeRenderer(unitsRef);
  const messageId = 'live_window_max_floor';
  const floorMessage = { ...message('streaming', 'body'), id: messageId };
  const elidedCount = (html) => unitsOf(html).filter((unit) => unit.fp === LIVE_WINDOW_ELIDED_FINGERPRINT || unit.fp === LIVE_WINDOW_NOTE_FINGERPRINT).length;

  assert.equal(elidedCount(renderer.renderThinkingWidget(floorMessage, messageId)), 8, 'frame 1 elides 8 KiB');
  unitsRef.units = [{ html: 'a'.repeat(20 * 1024), fingerprint: 'fp_single' }];
  assert.equal(elidedCount(renderer.renderThinkingWidget(floorMessage, messageId)), 0, 'frame 2 cannot elide its only unit');
  unitsRef.units = makeUnits(20);
  assert.equal(elidedCount(renderer.renderThinkingWidget(floorMessage, messageId)), 8, 'frame 3 restores the 8 KiB floor');
});
