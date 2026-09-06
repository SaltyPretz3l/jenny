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

test('resolveLiveWindowStart never retracts: the previous start is a floor, clamped to the tail', () => {
  assert.equal(resolveLiveWindowStart(makeUnits(40), 12), 12, 'a larger previous start wins');
  assert.equal(resolveLiveWindowStart(makeUnits(10), 4), 4, 'shrinking below the window keeps the floor');
  assert.equal(resolveLiveWindowStart(makeUnits(5), 40), 0, 'a re-chunk below the start resets the floor');
  assert.equal(resolveLiveWindowStart(makeUnits(40), 40), 8, 'a start at the unit count resets, not pins');
  assert.equal(resolveLiveWindowStart(makeUnits(40), -3), 8);
  assert.equal(resolveLiveWindowStart(makeUnits(40), 0, { windowChars: 10 * 1024 }), 30);
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

test('the window start is threaded through the stream cache so it never retracts across frames', () => {
  const unitsRef = { units: makeUnits(40) };
  const renderer = makeRenderer(unitsRef);
  assert.equal(unitsOf(renderer.renderThinkingWidget(message('streaming', 'a'), 'live_window_message'))[7].fp, LIVE_WINDOW_NOTE_FINGERPRINT);
  // A retraction re-chunks the tail into fewer, smaller units: the floor holds.
  unitsRef.units = makeUnits(34, 512);
  const units = unitsOf(renderer.renderThinkingWidget(message('streaming', 'ab'), 'live_window_message'));
  assert.equal(units[7].fp, LIVE_WINDOW_NOTE_FINGERPRINT);
  assert.equal(units[8].fp, 'fp_8');
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
