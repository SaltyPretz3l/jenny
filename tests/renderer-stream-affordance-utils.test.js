const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  settleVisibleStreamAffordances,
} = require('../renderer/chat/renderer-stream-affordance-utils');

test('S4: terminal cleanup strips the reasoning reveal state', () => {
  const dom = new JSDOM(`<main id="timeline"><article class="chat-entry stream-reveal-entry" data-message-id="assistant_s4">
    <div class="chat-stream-unit is-revealed"></div>
    <div class="reasoning-stream-unit is-revealed" style="animation-delay: 90ms" data-stream-unit-index="0"></div>
  </article></main>`);
  const timeline = dom.window.document.getElementById('timeline');
  settleVisibleStreamAffordances({ chatTimeline: timeline, messageId: 'assistant_s4' });
  const reasoning = timeline.querySelector('.reasoning-stream-unit');
  assert.equal(reasoning.classList.contains('is-revealed'), false);
  assert.equal(reasoning.style.animationDelay, '');
  assert.equal(reasoning.hasAttribute('data-stream-unit-index'), false);
  dom.window.close();
});

test('stream affordance utils clear targeted streaming classes and ARIA state', () => {
  const dom = new JSDOM(`
    <main id="timeline" aria-busy="true">
      <article class="chat-entry assistant pending stream-reveal-entry" data-message-id="assistant_1" data-streaming-message-id="assistant_1">
        <div class="chat-bubble chat-bubble-streaming" data-streaming-bubble="true" role="status" aria-live="polite" aria-atomic="false" aria-label="Assistant response streaming">
          <span class="chat-stream-unit is-streaming-tail is-revealed" data-stream-unit-index="0">Hello</span>
        </div>
      </article>
    </main>
  `);
  const timeline = dom.window.document.getElementById('timeline');

  const result = settleVisibleStreamAffordances({
    chatTimeline: timeline,
    messageId: 'assistant_1',
    escapeSelectorValue: (value) => String(value || ''),
  });

  assert.deepEqual(result, { cleared: true, roots: 1 });
  assert.equal(timeline.getAttribute('aria-busy'), 'false');
  assert.equal(timeline.querySelector('.pending'), null);
  assert.equal(timeline.querySelector('[data-streaming-bubble]'), null);
  assert.equal(timeline.querySelector('[aria-live]'), null);
  assert.equal(timeline.querySelector('[data-stream-unit-index]'), null);
});

test('stream affordance utils avoid broad cleanup when a requested id is absent', () => {
  const dom = new JSDOM(`
    <main id="timeline" aria-busy="true">
      <article class="chat-entry assistant pending" data-message-id="assistant_keep">
        <div class="chat-bubble chat-bubble-streaming" data-streaming-bubble="true"></div>
      </article>
    </main>
  `);
  const timeline = dom.window.document.getElementById('timeline');

  const result = settleVisibleStreamAffordances({
    chatTimeline: timeline,
    messageId: 'assistant_missing',
    escapeSelectorValue: (value) => String(value || ''),
  });

  assert.deepEqual(result, { cleared: false, roots: 0 });
  assert.ok(timeline.querySelector('.chat-bubble-streaming'));
  assert.equal(timeline.getAttribute('aria-busy'), 'true');
});
