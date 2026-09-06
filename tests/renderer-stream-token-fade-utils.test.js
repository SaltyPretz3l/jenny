'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  createStreamTokenFadeTracker,
} = require('../renderer/chat/renderer-stream-token-fade-utils');
const { createStreamRevealController } = require('./helpers/renderer-stream-reveal-harness');

function createFixture(html = '') {
  const dom = new JSDOM('<!doctype html><body><div id="unit"></div></body>');
  const unit = dom.window.document.getElementById('unit');
  unit.innerHTML = html;
  return { dom, unit };
}

function delayMs(span) {
  return Math.abs(Number.parseFloat(span.style.animationDelay));
}

test('first write wraps the whole text once with a zero delay', (t) => {
  const { dom, unit } = createFixture();
  t.after(() => dom.window.close());
  const tracker = createStreamTokenFadeTracker({ nowFn: () => 10 });

  assert.equal(tracker.applyTailUnit(unit, '<p>Hello</p>', 0), true);
  const spans = unit.querySelectorAll('.chat-stream-token');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].textContent, 'Hello');
  assert.equal(delayMs(spans[0]), 0);
});

test('prefix append wraps only the appended suffix', (t) => {
  const { dom, unit } = createFixture('<p>Hello wor</p>');
  t.after(() => dom.window.close());
  const tracker = createStreamTokenFadeTracker({ nowFn: () => 0 });

  tracker.applyTailUnit(unit, '<p>Hello world, again</p>', 0);
  const spans = unit.querySelectorAll('.chat-stream-token');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].textContent, 'ld, again');
  assert.equal(unit.textContent, 'Hello world, again');
  assert.equal(unit.querySelector('p').firstChild.nodeType, 3);
});

test('a second frame reconstructs the older and newest spans', (t) => {
  const { dom, unit } = createFixture('<p>a</p>');
  t.after(() => dom.window.close());
  let now = 0;
  const tracker = createStreamTokenFadeTracker({ nowFn: () => now });

  tracker.applyTailUnit(unit, '<p>ab</p>', 0);
  now = 50;
  tracker.applyTailUnit(unit, '<p>abc</p>', 0);
  const spans = unit.querySelectorAll('.chat-stream-token');
  assert.deepEqual(Array.from(spans, (span) => span.textContent), ['b', 'c']);
  assert.equal(delayMs(spans[0]), 50);
  assert.equal(delayMs(spans[1]), 0);
  assert.equal(unit.textContent, 'abc');
});

test('segments older than fadeMs are pruned on the next frame', (t) => {
  const { dom, unit } = createFixture('<p>a</p>');
  t.after(() => dom.window.close());
  let now = 0;
  const tracker = createStreamTokenFadeTracker({ nowFn: () => now, fadeMs: 100 });

  tracker.applyTailUnit(unit, '<p>ab</p>', 0);
  now = 101;
  tracker.applyTailUnit(unit, '<p>abc</p>', 0);
  const spans = unit.querySelectorAll('.chat-stream-token');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].textContent, 'c');
});

test('a markup reflow behind a live fade keeps the fade instead of snapping it', (t) => {
  const { dom, unit } = createFixture('<p>a </p>');
  t.after(() => dom.window.close());
  let now = 0;
  const tracker = createStreamTokenFadeTracker({ nowFn: () => now });
  tracker.applyTailUnit(unit, '<p>a **bo</p>', 0);
  assert.equal(unit.querySelectorAll('.chat-stream-token').length, 1);

  // The closing ** arrives: text is not a prefix of the previous text and did
  // not grow, but the settled prefix "a " still holds, so the fade continues.
  now = 20;
  tracker.applyTailUnit(unit, '<p>a <strong>bold</strong></p>', 0);
  let spans = unit.querySelectorAll('.chat-stream-token');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].textContent, 'bold');
  assert.equal(delayMs(spans[0]), 20);
  assert.equal(unit.textContent, 'a bold');

  // An unchanged frame (only an earlier unit changed) re-wraps, no snap.
  now = 30;
  tracker.applyTailUnit(unit, '<p>a <strong>bold</strong></p>', 0);
  spans = unit.querySelectorAll('.chat-stream-token');
  assert.equal(spans.length, 1);
  assert.equal(delayMs(spans[0]), 30);
});

test('a rewrite of the settled prefix clears history before later appends', (t) => {
  const { dom, unit } = createFixture('<p>foo</p>');
  t.after(() => dom.window.close());
  let now = 0;
  const tracker = createStreamTokenFadeTracker({ nowFn: () => now });
  tracker.applyTailUnit(unit, '<p>foo bar</p>', 0);

  now = 20;
  tracker.applyTailUnit(unit, '<p><strong>fXo</strong> baz</p>', 0);
  assert.equal(unit.querySelectorAll('.chat-stream-token').length, 0);
  now = 30;
  tracker.applyTailUnit(unit, '<p><strong>fXo</strong> baz!</p>', 0);
  const spans = unit.querySelectorAll('.chat-stream-token');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].textContent, '!');
});

test('a bulk jump paints plainly and the keyed-node morph writer drops stale spans', (t) => {
  const { setInnerHtmlPreservingCodeScroll } = require('../renderer/chat/renderer-stream-dom-patch-utils');
  const { dom, unit } = createFixture('<p>a</p>');
  t.after(() => dom.window.close());
  let now = 0;
  const tracker = createStreamTokenFadeTracker({ nowFn: () => now, setInnerHtml: setInnerHtmlPreservingCodeScroll });

  tracker.applyTailUnit(unit, '<p>ab</p>', 0);
  assert.equal(unit.querySelectorAll('.chat-stream-token').length, 1);
  now = 10;
  tracker.applyTailUnit(unit, '<p>abc</p>', 0);
  const spans = unit.querySelectorAll('.chat-stream-token');
  assert.deepEqual(Array.from(spans, (span) => span.textContent), ['b', 'c'], 'last frame spans are rebuilt, not stacked');
  assert.equal(unit.textContent, 'abc');

  now = 20;
  const bulk = 'x'.repeat(2000);
  tracker.applyTailUnit(unit, '<p>abc' + bulk + '</p>', 0);
  assert.equal(unit.querySelectorAll('.chat-stream-token').length, 2, 'a >1500-char delta adds no segment');
  now = 400;
  tracker.applyTailUnit(unit, '<p>abc' + bulk + 'y</p>', 0);
  assert.deepEqual(Array.from(unit.querySelectorAll('.chat-stream-token'), (span) => span.textContent), ['y']);
});

test('inline markup wraps suffix pieces across text nodes', (t) => {
  const { dom, unit } = createFixture('<p>see <code>ab</code></p>');
  t.after(() => dom.window.close());
  const tracker = createStreamTokenFadeTracker({ nowFn: () => 0 });

  tracker.applyTailUnit(unit, '<p>see <code>abcd</code> ok</p>', 0);
  const spans = unit.querySelectorAll('.chat-stream-token');
  assert.deepEqual(Array.from(spans, (span) => span.textContent), ['cd', ' ok']);
  assert.equal(unit.querySelector('code .chat-stream-token').textContent, 'cd');
  assert.equal(unit.querySelector('code').textContent, 'abcd');
  assert.equal(unit.textContent, 'see abcd ok');
});

test('reset keeps state for the same message and clears it for a new one', (t) => {
  const { dom, unit } = createFixture('<p>a</p>');
  t.after(() => dom.window.close());
  let now = 0;
  const tracker = createStreamTokenFadeTracker({ nowFn: () => now });

  tracker.reset('message-1');
  tracker.applyTailUnit(unit, '<p>ab</p>', 0);
  tracker.reset('message-1');
  now = 50;
  tracker.applyTailUnit(unit, '<p>abc</p>', 0);
  assert.deepEqual(
    Array.from(unit.querySelectorAll('.chat-stream-token'), (span) => span.textContent),
    ['b', 'c']
  );

  tracker.reset('message-2');
  now = 60;
  tracker.applyTailUnit(unit, '<p>abcd</p>', 0);
  assert.deepEqual(
    Array.from(unit.querySelectorAll('.chat-stream-token'), (span) => span.textContent),
    ['d']
  );
});

// Controller integration: the hook in patchBubbleUnits (flag OFF byte-identical; reduced motion inert).
test('flag OFF: streaming tail unit write is byte-identical to the plain path', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="timeline">
    <article data-message-id="assistant_fade"><div data-streaming-bubble="true">
      <div class="chat-stream-unit" data-stream-unit-index="0"><p>Hello</p></div>
    </div></article>
  </div></body>`);
  const timeline = dom.window.document.getElementById('timeline');
  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    state: { features: { featureFlags: {} } },
    reducedMotionQuery: { matches: false },
    escapeSelectorValue: (value) => String(value || ''),
  });
  const message = { id: 'assistant_fade', role: 'assistant', status: 'streaming', content: '' };
  controller.commitFullRender({ currentSessionId: 'session-1', streamingMessage: message });
  for (const html of ['<p>Hello world</p>', '<p>Hello world!</p>']) {
    controller.queuePatch({
      currentSessionId: 'session-1',
      streamingMessage: message,
      messages: [message],
      buildMessageNodeState: () => ({
        bubbleInnerHtml: html,
        streamUnits: [{ html, revealed: true }],
        streamChangedStart: 0,
        pending: true,
        entryReveal: false,
        status: 'streaming',
        finalizedAt: '',
      }),
    });
  }
  const unit = timeline.querySelector('[data-stream-unit-index="0"]');
  assert.equal(unit.querySelector('.chat-stream-token'), null);
  assert.equal(unit.innerHTML, '<p>Hello world!</p>');
  dom.window.close();
});

test('flag ON + reduced motion: no token spans; motion enabled fades the suffix', () => {
  const runPatches = (matches) => {
    const dom = new JSDOM(`<!doctype html><body><div id="timeline">
      <article data-message-id="assistant_fade"><div data-streaming-bubble="true">
        <div class="chat-stream-unit" data-stream-unit-index="0"><p>Hello</p></div>
      </div></article>
    </div></body>`);
    const timeline = dom.window.document.getElementById('timeline');
    const controller = createStreamRevealController({
      windowRef: dom.window,
      chatTimeline: timeline,
      state: { features: { featureFlags: { chat_stream_token_fade: true } } },
      reducedMotionQuery: { matches },
      escapeSelectorValue: (value) => String(value || ''),
    });
    const message = { id: 'assistant_fade', role: 'assistant', status: 'streaming', content: '' };
    controller.commitFullRender({ currentSessionId: 'session-1', streamingMessage: message });
    for (const html of ['<p>Hello world</p>', '<p>Hello world!</p>']) {
      controller.queuePatch({
        currentSessionId: 'session-1',
        streamingMessage: message,
        messages: [message],
        buildMessageNodeState: () => ({
          bubbleInnerHtml: html,
          streamUnits: [{ html, revealed: true }],
          streamChangedStart: 0,
          pending: true,
          entryReveal: false,
          status: 'streaming',
          finalizedAt: '',
        }),
      });
    }
    return { dom, timeline };
  };

  const reduced = runPatches(true);
  assert.equal(reduced.timeline.querySelector('.chat-stream-token'), null);
  reduced.dom.window.close();

  const animated = runPatches(false);
  const bubble = animated.timeline.querySelector('[data-streaming-bubble="true"]');
  assert.ok(Array.from(bubble.querySelectorAll('.chat-stream-token'))
    .some((span) => span.textContent === '!'));
  assert.equal(bubble.textContent.trim(), 'Hello world!');
  animated.dom.window.close();
});
