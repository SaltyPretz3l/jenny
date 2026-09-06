const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createReasoningV2Renderer } = require('../renderer/chat/renderer-transcript-reasoning-v2');
const {
  ThinkingPanelController,
  groupReasoningByPhase,
  shouldShowThinkingToggle,
} = require('../renderer/chat/chat-thinking-utils');
const { reconcileStreamUnits } = require('../renderer/chat/renderer-stream-dom-patch-utils');
const { settleVisibleStreamAffordances } = require('../renderer/chat/renderer-stream-affordance-utils');
const {
  createImmediateRevealController,
  disposeTrackedRevealDoms,
} = require('./helpers/renderer-stream-reveal-harness');

test.afterEach(() => {
  disposeTrackedRevealDoms();
});

// Mirrors markdown-utils.js's toHtmlFingerprint (djb2 over the html string,
// prefixed 'unit_') so test fixtures compute the same fingerprint values the
// production unit builder does, without importing an unexported helper.
function toHtmlFingerprint(value) {
  const source = String(value || '');
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash) + source.charCodeAt(index);
    hash >>>= 0;
  }
  return `unit_${hash.toString(16)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Renderer whose unit-splitter returns two units, so the streaming-tail branch
// exercises the .reasoning-stream-unit wrapping.
function makeUnitRenderer() {
  return createReasoningV2Renderer({
    escapeHtml,
    groupReasoningByPhase,
    getReasoningEntries: (message) => (message?.reasoning?.entries || []),
    renderMarkdown: (s) => `<p>${escapeHtml(s)}</p>`,
    renderStreamingMarkdownUnits: () => ({
      html: '<p>a</p><p>b</p>',
      units: [
        { html: '<p>a</p>', fingerprint: toHtmlFingerprint('<p>a</p>') },
        { html: '<p>b</p>', fingerprint: toHtmlFingerprint('<p>b</p>') },
      ],
    }),
    shouldShowThinkingToggle,
    thinkingController: new ThinkingPanelController(),
  });
}

function streamingMessage() {
  return {
    id: 'msg_1',
    role: 'assistant',
    status: 'streaming',
    streamId: 'stream_1',
    reasoning: { source: 'provider', status: 'streaming', entries: [{ text: 'thinking', thinkingId: 'tid_1' }] },
  };
}

function settledMessage() {
  return {
    id: 'msg_1',
    role: 'assistant',
    status: 'complete',
    streamId: 'stream_1',
    reasoning: { source: 'provider', status: 'complete', entries: [{ text: 'thinking', thinkingId: 'tid_1' }] },
  };
}

// ── B1: renderer emission ─────────────────────────────────────────────

test('renderPhase wraps the body in .reasoning-stream-unit on the streaming tail (fp stamped, no reveal markup)', () => {
  const html = makeUnitRenderer().renderThinkingWidget(streamingMessage(), 'msg_1');
  assert.ok(html.includes('reasoning-stream-unit'), 'streaming body is unit-wrapped');
  assert.ok(html.includes('data-stream-unit-index="0"'), 'unit 0 indexed');
  assert.ok(html.includes('data-stream-unit-index="1"'), 'unit 1 indexed');
  assert.ok(html.includes(`data-su-fp="${toHtmlFingerprint('<p>a</p>')}"`), 'unit 0 stamped with its content fingerprint');
  assert.ok(html.includes(`data-su-fp="${toHtmlFingerprint('<p>b</p>')}"`), 'unit 1 stamped with its content fingerprint');
  assert.ok(!html.includes('is-revealed'), 'markup carries no reveal class — the patch layer owns reveals');
});

test('renderPhase emits a flat body (no unit wrappers) when settled', () => {
  const html = makeUnitRenderer().renderThinkingWidget(settledMessage(), 'msg_1');
  assert.ok(html.includes('reasoning-row-panel-body'), 'settled body still renders');
  assert.ok(!html.includes('reasoning-stream-unit'), 'no unit wrappers when settled → never re-animates on re-open');
});

// ── B2: reconcileStreamUnits ──────────────────────────────────────────

function makeBody(doc, texts) {
  const div = doc.createElement('div');
  div.className = 'reasoning-row-panel-body';
  div.innerHTML = texts
    .map((t, i) => {
      const inner = `<p>${t}</p>`;
      return `<div class="reasoning-stream-unit" data-stream-unit-index="${i}" data-su-fp="${toHtmlFingerprint(inner)}">${inner}</div>`;
    })
    .join('');
  return div;
}

function unitsOf(container) {
  return Array.from(container.querySelectorAll('[data-stream-unit-index]'));
}

test('reconcileStreamUnits reveals only the trailing <=revealCap newly appended units, with stagger', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const container = makeBody(doc, ['A', 'B']); // two already-settled units
  const next = makeBody(doc, ['A', 'B', 'C', 'D']);

  reconcileStreamUnits(container, next, doc, { unitClassName: 'reasoning-stream-unit', revealCap: 2, staggerMs: 90 });

  const units = unitsOf(container);
  assert.equal(units.length, 4, 'all four units present');
  assert.ok(!units[0].classList.contains('is-revealed'), 'unchanged prefix not revealed');
  assert.ok(!units[1].classList.contains('is-revealed'), 'unchanged prefix not revealed');
  assert.ok(units[2].classList.contains('is-revealed'), 'first new unit revealed');
  assert.ok(units[3].classList.contains('is-revealed'), 'last new unit revealed');
  assert.equal(units[2].style.animationDelay, '0ms', 'first revealed unit has no stagger');
  assert.equal(units[3].style.animationDelay, '90ms', 'second revealed unit staggers by 90ms');
  dom.window.close();
});

test('reconcileStreamUnits caps the reveal under a burst / first attach (earlier units settle instantly)', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const container = makeBody(doc, []); // empty: first attach
  const next = makeBody(doc, ['A', 'B', 'C', 'D']);

  reconcileStreamUnits(container, next, doc, { unitClassName: 'reasoning-stream-unit', revealCap: 2, staggerMs: 90 });

  const units = unitsOf(container);
  assert.equal(units.length, 4);
  assert.ok(!units[0].classList.contains('is-revealed'), 'burst: earlier units paint settled (no wall of blur)');
  assert.ok(!units[1].classList.contains('is-revealed'));
  assert.ok(units[2].classList.contains('is-revealed'), 'only trailing <=cap animate');
  assert.ok(units[3].classList.contains('is-revealed'));
  dom.window.close();
});

test('reconcileStreamUnits never toggles is-revealed on an in-place grown unit (no throb)', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const container = makeBody(doc, ['A', 'B']);
  // Simulate B having just animated in last frame.
  const grownNode = unitsOf(container)[1];
  grownNode.classList.add('is-revealed');

  const next = makeBody(doc, ['A', 'B and more']); // B grew in place, same index
  reconcileStreamUnits(container, next, doc, { unitClassName: 'reasoning-stream-unit', revealCap: 2, staggerMs: 90 });

  const units = unitsOf(container);
  assert.strictEqual(units[1], grownNode, 'grown unit keeps node identity (updated in place)');
  assert.ok(units[1].classList.contains('is-revealed'), 'is-revealed preserved — not removed then re-added');
  assert.equal(units[1].textContent.trim(), 'B and more', 'text updated in place');
  dom.window.close();
});

test('reconcileStreamUnits fast-path: unchanged-fingerprint prefix units are never re-read/rewritten when only the tail grows', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const container = makeBody(doc, ['A', 'B', 'C']);

  const existingUnits = unitsOf(container);
  const identities = existingUnits.slice();
  let unit0Writes = 0;
  let unit1Writes = 0;
  function findInnerHtmlDescriptor(el) {
    let proto = Object.getPrototypeOf(el);
    while (proto) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
      if (descriptor) return descriptor;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }
  function instrument(el, onSet) {
    const descriptor = findInnerHtmlDescriptor(el);
    Object.defineProperty(el, 'innerHTML', {
      configurable: true,
      get() { return descriptor.get.call(el); },
      set(value) { onSet(); descriptor.set.call(el, value); },
    });
  }
  instrument(existingUnits[0], () => { unit0Writes += 1; });
  instrument(existingUnits[1], () => { unit1Writes += 1; });

  // Only the tail unit changes; units 0/1 keep identical fingerprints/content.
  const next = makeBody(doc, ['A', 'B', 'C and more']);

  reconcileStreamUnits(container, next, doc, { unitClassName: 'reasoning-stream-unit', revealCap: 2, staggerMs: 90 });

  assert.equal(unit0Writes, 0, 'unit 0 innerHTML setter never invoked (fingerprint fast-path)');
  assert.equal(unit1Writes, 0, 'unit 1 innerHTML setter never invoked (fingerprint fast-path)');

  const units = unitsOf(container);
  assert.equal(units.length, 3, 'still three units');
  assert.strictEqual(units[0], identities[0], 'unit 0 node identity preserved');
  assert.strictEqual(units[1], identities[1], 'unit 1 node identity preserved');
  assert.strictEqual(units[2], identities[2], 'unit 2 node identity preserved (updated in place, not replaced)');
  assert.equal(units[2].textContent.trim(), 'C and more', 'grown tail unit updated');
  assert.ok(!units[2].classList.contains('is-revealed'), 'in-place growth of an existing unit never toggles is-revealed');
  dom.window.close();
});

test('reconcileStreamUnits fast-path: append still reveals the new unit with stagger, prefix untouched', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const container = makeBody(doc, ['A', 'B']);

  const existingUnits = unitsOf(container);
  let unit0Writes = 0;
  let unit1Writes = 0;
  function findInnerHtmlDescriptor(el) {
    let proto = Object.getPrototypeOf(el);
    while (proto) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
      if (descriptor) return descriptor;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }
  function instrument(el, onSet) {
    const descriptor = findInnerHtmlDescriptor(el);
    Object.defineProperty(el, 'innerHTML', {
      configurable: true,
      get() { return descriptor.get.call(el); },
      set(value) { onSet(); descriptor.set.call(el, value); },
    });
  }
  instrument(existingUnits[0], () => { unit0Writes += 1; });
  instrument(existingUnits[1], () => { unit1Writes += 1; });

  const next = makeBody(doc, ['A', 'B', 'C']);
  reconcileStreamUnits(container, next, doc, { unitClassName: 'reasoning-stream-unit', revealCap: 2, staggerMs: 90 });

  assert.equal(unit0Writes, 0, 'prefix unit 0 setter not invoked on append');
  assert.equal(unit1Writes, 0, 'prefix unit 1 setter not invoked on append');

  const units = unitsOf(container);
  assert.equal(units.length, 3);
  assert.ok(units[2].classList.contains('is-revealed'), 'newly appended unit is revealed');
  assert.equal(units[2].style.animationDelay, '0ms', 'first (only) revealed unit has no stagger offset');
  assert.equal(units[2].getAttribute('data-su-fp'), toHtmlFingerprint('<p>C</p>'), 'appended unit stamped with its fingerprint for next frame');
  dom.window.close();
});

test('reconcileStreamUnits bulk-replaces a flat (settled) body and on count desync', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;

  // Flat body (no units): bulk replace, no reveal.
  const container1 = makeBody(doc, ['A', 'B']);
  const flat = doc.createElement('div');
  flat.innerHTML = '<p>settled flat body</p>';
  reconcileStreamUnits(container1, flat, doc, { unitClassName: 'reasoning-stream-unit', revealCap: 2 });
  assert.equal(unitsOf(container1).length, 0, 'units replaced by flat HTML');
  assert.equal(container1.textContent.trim(), 'settled flat body');

  // Count desync (units removed): bulk fallback.
  const container2 = makeBody(doc, ['A', 'B', 'C']);
  const fewer = makeBody(doc, ['A', 'B']);
  reconcileStreamUnits(container2, fewer, doc, { unitClassName: 'reasoning-stream-unit', revealCap: 2 });
  assert.equal(unitsOf(container2).length, 2, 'desync falls back to a bulk replace');
  dom.window.close();
});

// ── B7: settle cleanup ────────────────────────────────────────────────

test('settleVisibleStreamAffordances strips reveal markers from .reasoning-stream-unit', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="timeline">
    <article class="chat-entry assistant" data-message-id="m1">
      <div class="reasoning-stream-unit is-revealed" data-stream-unit-index="2" style="animation-delay: 90ms;"><p>x</p></div>
    </article>
  </div></body>`);
  const timeline = dom.window.document.getElementById('timeline');

  settleVisibleStreamAffordances({ chatTimeline: timeline, messageId: 'm1', escapeSelectorValue: (v) => String(v || '') });

  const unit = timeline.querySelector('.reasoning-stream-unit');
  assert.ok(!unit.classList.contains('is-revealed'), 'reveal class stripped');
  assert.equal(unit.hasAttribute('data-stream-unit-index'), false, 'index attribute stripped');
  assert.equal(unit.style.animationDelay, '', 'inline stagger cleared');
  dom.window.close();
});

// ── B4: max-height smoothness fix (via queuePatch) ────────────────────

function reasoningBlockMarkup(text, status) {
  return `
    <div class="reasoning-row-stack" data-reasoning-row-version="2">
      <div class="reasoning-row-block expanded" data-reasoning-status="${status}" data-thinking-id="think_1" data-phase-key="think_1">
        <button class="reasoning-row-header" type="button" data-reasoning-toggle="true" data-message-id="assistant_stream" data-thinking-id="think_1" data-phase-key="think_1">
          <span class="reasoning-row-main shimmer-active">${text}</span>
        </button>
        <div class="reasoning-row-panel expanded" data-thinking-id="think_1" data-phase-key="think_1">
          <div class="reasoning-row-panel-body chat-bubble-markdown"><p>${text}</p></div>
        </div>
      </div>
    </div>`;
}

function runReasoningHeightPatch(status) {
  const { timeline, controller } = createImmediateRevealController(`
    <!doctype html><html><body><div id="timeline">
      <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
        <div class="chat-message-content">${reasoningBlockMarkup('first', status)}</div>
      </article>
    </div></body></html>
  `);
  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_stream',
  });
  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null,
      thinkingMarkup: reasoningBlockMarkup('first second', status),
      innerHtml: '',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });
  return timeline.querySelector('.reasoning-row-panel.expanded');
}

test('streaming reasoning panel grows freely (max-height:none); a settled one is clamped', () => {
  const streamingPanel = runReasoningHeightPatch('streaming');
  assert.equal(streamingPanel.style.maxHeight, 'none', 'streaming tail lets the body grow freely → no height jank');

  const settledPanel = runReasoningHeightPatch('complete');
  assert.notEqual(settledPanel.style.maxHeight, 'none', 'a non-streaming block re-clamps to a measured height');
});
