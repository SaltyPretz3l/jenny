const test = require('node:test');
const assert = require('node:assert/strict');

const { JSDOM, createStreamRevealController } = require('./helpers/renderer-stream-reveal-harness');

// Stream reveal controller, S4 (chat timeline remediation 2026-09-29): per-pane
// session identity, shrinking unit lists, no dead reveal markers, guarded
// flip-to-complete settle, dispose(). Split from renderer-stream-reveal.test.js
// so that suite stays under the test-file size ratchet.

test('S4: an unfocused pane reuses its own session units without copying renderer records', () => {
  const previousUnits = [];
  const units = Object.freeze([Object.freeze({ html: '<p>answer</p>', fingerprint: 'answer' })]);
  const controller = createStreamRevealController({
    state: { currentSessionId: 'A' },
    getSessionId: () => 'B',
    renderStreamingMarkdownUnits: (_content, options) => {
      previousUnits.push(options.previousUnits);
      return { html: '<p>answer</p>', units, changedStartIndex: 0 };
    },
  });
  const message = { id: 'assistant_pane', content: 'answer', status: 'streaming', role: 'assistant' };
  controller.commitFullRender({ currentSessionId: 'B', streamingMessage: message });
  controller.buildStreamingBubbleMarkup(message);
  const model = controller.buildStreamingBubbleMarkup(message);
  assert.ok(previousUnits[1].length > 0, 'the unfocused pane must reuse previous units');
  assert.equal(previousUnits[1], units, 'reuse the renderer unit array (never mutated after issue)');
  assert.equal(Object.hasOwn(model, 'entryReveal'), false);
  assert.equal(Object.hasOwn(model.streamUnits[0], 'revealed'), false);
  assert.equal(new JSDOM(model.bubbleInnerHtml).window.document.querySelector('.chat-stream-unit.is-revealed'), null);
});

function createS4PatchFixture(t, options = {}) {
  const dom = new JSDOM(`<!doctype html><div id="timeline">
    <article class="chat-entry assistant pending" data-message-id="assistant_s4">
      ${options.thinkingMarkup || ''}
      <div class="chat-bubble chat-bubble-streaming" data-streaming-bubble="true"></div>
    </article></div>`);
  t.after(() => dom.window.close());
  dom.window.document.documentElement.style.setProperty('--motion-duration-regular', '1ms');
  const timeline = dom.window.document.getElementById('timeline');
  const metrics = [];
  const controller = createStreamRevealController({
    windowRef: dom.window, chatTimeline: timeline,
    state: { currentSessionId: 'A' }, getSessionId: () => 'B',
    streamClientMetrics: { noteRenderForSession: (...args) => metrics.push(args) },
  });
  const message = { id: 'assistant_s4', role: 'assistant', status: 'streaming', content: 'answer' };
  const commit = () => controller.commitFullRender({ currentSessionId: 'B', streamingMessage: message });
  commit();
  const patch = (model) => controller.queuePatch({
    currentSessionId: 'B', streamingMessage: message,
    buildMessageNodeState: () => ({ bubbleInnerHtml: '', status: 'streaming', pending: true, ...model }),
  });
  t.after(() => controller.dispose?.());
  return { dom, timeline, controller, patch, commit, metrics };
}

test('S4: answer markup has no reveal flags and retains frozen renderer units', () => {
  const units = Object.freeze([Object.freeze({ html: '<p>answer</p>' })]);
  const previousUnits = [];
  const controller = createStreamRevealController({
    state: { currentSessionId: 'B' },
    renderStreamingMarkdownUnits: (_text, options) => {
      previousUnits.push(options.previousUnits);
      return { html: '<p>answer</p>', units, changedStartIndex: 0 };
    },
  });
  const message = { id: 'assistant_s4', content: 'answer' };
  controller.commitFullRender({ currentSessionId: 'B', streamingMessage: message });
  const model = controller.buildStreamingBubbleMarkup(message);
  const dom = new JSDOM(model.bubbleInnerHtml);
  assert.equal(dom.window.document.querySelectorAll('.chat-stream-unit.is-revealed').length, 0);
  assert.equal(Object.hasOwn(model, 'entryReveal'), false);
  assert.equal(Object.hasOwn(model.streamUnits[0], 'revealed'), false);
  controller.buildStreamingBubbleMarkup(message);
  assert.equal(previousUnits[1], units);
  dom.window.close();
  controller.dispose?.();
});

test('S4: previous answer units reuse the renderer unit array (never mutated after issue)', () => {
  const units = Object.freeze([Object.freeze({ html: '<p>answer</p>' })]);
  let previous;
  const controller = createStreamRevealController({
    state: { currentSessionId: 'B' },
    renderStreamingMarkdownUnits: (_text, options) => {
      previous = options.previousUnits;
      return { html: '<p>answer</p>', units, changedStartIndex: 0 };
    },
  });
  const message = { id: 'assistant_s4', content: 'answer' };
  controller.commitFullRender({ currentSessionId: 'B', streamingMessage: message });
  controller.buildStreamingBubbleMarkup(message);
  controller.buildStreamingBubbleMarkup(message);
  assert.equal(previous, units, 'do not copy renderer unit records');
  controller.dispose?.();
});

test('S4: shrinking answer units removes the stale trailing DOM unit', (t) => {
  const { timeline, patch } = createS4PatchFixture(t);
  const units = ['one', 'two', '&lt;details'].map((text) => ({ html: `<p>${text}</p>` }));
  patch({ streamUnits: units, streamChangedStart: 0 });
  const bubble = timeline.querySelector('.chat-bubble');
  const first = bubble.firstElementChild;
  assert.equal(bubble.children.length, 3);
  patch({ streamUnits: units.slice(0, 2), streamChangedStart: 2 });
  assert.equal(bubble.querySelectorAll('[data-stream-unit-index]').length, 2);
  assert.equal(bubble.firstElementChild, first);
  assert.equal(bubble.textContent.includes('<details'), false);
});

function s4ThinkingMarkup(status = 'complete', label = 'Thought') {
  return `<div class="reasoning-row-stack"><div class="reasoning-row-block" data-phase-key="phase_s4" data-reasoning-status="${status}">
    <button class="reasoning-row-header">${label}</button>
    <div class="reasoning-row-panel expanded" style="max-height: none"><div class="reasoning-row-panel-body">reasoning</div></div>
  </div></div>`;
}

test('S4: reasoning header metrics belong to the pane session', (t) => {
  const { patch, metrics } = createS4PatchFixture(t, { thinkingMarkup: s4ThinkingMarkup('streaming', 'Thinking') });
  patch({ thinkingMarkup: s4ThinkingMarkup() });
  assert.deepEqual(metrics, [['B', 'reasoning_header_rewrite']]);
});

test('S4: a flip-to-complete settle cannot settle a panel that starts collapsing', async (t) => {
  const { dom, timeline, patch } = createS4PatchFixture(t, { thinkingMarkup: s4ThinkingMarkup('streaming') });
  const panel = timeline.querySelector('.reasoning-row-panel');
  patch({ thinkingMarkup: s4ThinkingMarkup('streaming') });
  assert.equal(panel.style.maxHeight, 'none');
  patch({ thinkingMarkup: s4ThinkingMarkup() });
  assert.equal(panel.style.maxHeight.endsWith('px'), true);
  panel.dataset.collapsing = 'true';
  await new Promise((resolve) => dom.window.setTimeout(resolve, 120));
  assert.equal(panel.classList.contains('reasoning-row-panel--settled'), false);
});

test('S4: dispose cancels a pending flip-to-complete settle and resets the controller', async (t) => {
  const { dom, timeline, controller, patch } = createS4PatchFixture(t, { thinkingMarkup: s4ThinkingMarkup('streaming') });
  const panel = timeline.querySelector('.reasoning-row-panel');
  patch({ thinkingMarkup: s4ThinkingMarkup() });
  assert.equal(typeof controller.dispose, 'function');
  controller.dispose();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 120));
  const event = new dom.window.Event('transitionend');
  Object.defineProperty(event, 'propertyName', { value: 'max-height' });
  panel.dispatchEvent(event);
  assert.equal(panel.classList.contains('reasoning-row-panel--settled'), false);
  assert.equal(timeline.querySelector('[data-streaming-message-id]'), null);
});

test('S4: flip-to-complete settles on its max-height transition', (t) => {
  const { dom, timeline, patch } = createS4PatchFixture(t, { thinkingMarkup: s4ThinkingMarkup('streaming') });
  const panel = timeline.querySelector('.reasoning-row-panel');
  patch({ thinkingMarkup: s4ThinkingMarkup() });
  const event = new dom.window.Event('transitionend');
  Object.defineProperty(event, 'propertyName', { value: 'max-height' });
  panel.dispatchEvent(event);
  assert.equal(panel.classList.contains('reasoning-row-panel--settled'), true);
  assert.equal(panel.style.maxHeight, '');
});

test('dispose latches the controller: later patches and full renders are no-ops', (t) => {
  const { timeline, controller, patch, commit } = createS4PatchFixture(t, { thinkingMarkup: s4ThinkingMarkup('streaming') });
  controller.dispose();
  const before = timeline.innerHTML;
  patch({ thinkingMarkup: s4ThinkingMarkup() });
  commit();
  assert.equal(timeline.innerHTML, before);
  assert.equal(timeline.querySelector('[data-streaming-message-id]'), null);
});

test('S4: dispose releases the reasoning handoff tracker', (t) => {
  const autocollapse = require('../renderer/chat/renderer-reasoning-autocollapse-utils');
  const original = autocollapse.createReasoningHandoffTracker;
  let disposals = 0;
  autocollapse.createReasoningHandoffTracker = () => ({
    remember() {}, rememberById() {}, clear() {}, replay() {}, dispose() { disposals += 1; },
  });
  t.after(() => { autocollapse.createReasoningHandoffTracker = original; });
  const controller = createStreamRevealController();
  assert.equal(typeof controller.dispose, 'function');
  controller.dispose();
  assert.equal(disposals, 1);
});

test('source_citations: the live bubble renders markers stripped and a partial marker held back', () => {
  const rendered = [];
  const build = (enabled) => createStreamRevealController({
    state: { currentSessionId: 'A', features: { featureFlags: { source_citations: enabled } } },
    renderStreamingMarkdownUnits: (content) => {
      rendered.push(content);
      return { html: `<p>${content}</p>`, units: [], changedStartIndex: -1 };
    },
  });
  const message = { id: 'assistant_cite', content: 'Built in 1889 [web:1]. Tall【web:2', status: 'streaming', role: 'assistant' };
  build(true).buildStreamingBubbleMarkup(message);
  build(false).buildStreamingBubbleMarkup(message);
  assert.deepEqual(rendered, ['Built in 1889. Tall', message.content]);
});
