const test = require('node:test');
const assert = require('node:assert/strict');

const { appendReasoningRow, createHarness, setLiveThinkingState } = require('./helpers/thinking-pipeline-harness');

test('layout notifications remeasure the anchor and stop after disposal', async () => {
  const h = createHarness({ messages: [{ id: 'a1', role: 'assistant', content: 'Done', status: 'complete' }] });
  const target = h.dom.window.document.querySelector('[data-message-id="a1"]');
  h.pipeline.updateAssistantSpritePosition();
  h.scheduler.flushAll();
  target.getBoundingClientRect = () => ({ top: 280, bottom: 340, height: 60 });
  assert.equal(h.resizeObservers[0].targets.size, 2);
  h.resizeObservers[0].callback();
  h.scheduler.flushAll();
  assert.equal(h.spriteRuntime.targetY, 280);
  target.getBoundingClientRect = () => ({ top: 340, bottom: 400, height: 60 });
  target.setAttribute('open', '');
  await Promise.resolve();
  h.scheduler.flushAll();
  assert.equal(h.spriteRuntime.targetY, 340);
  target.getBoundingClientRect = () => ({ top: 420, bottom: 480, height: 60 });
  h.dom.window.dispatchEvent(new h.dom.window.Event('resize'));
  h.scheduler.flushAll();
  assert.equal(h.sprite.style.transform, 'translate3d(0, 420px, 0)');
  h.pipeline.dispose();
  assert.equal(h.resizeObservers[0].targets.size, 0);
  h.resizeObservers[0].callback();
  h.dom.window.dispatchEvent(new h.dom.window.Event('resize'));
  assert.equal(h.scheduler.size, 0);
  h.dom.window.close();
});

test('session changes clear visible identity immediately and fence queued old geometry', () => {
  const h = createHarness({ messages: [{ id: 'a1', role: 'assistant', content: 'Done', status: 'complete' }], cancelFrames: false });
  h.pipeline.updateAssistantSpritePosition();
  h.scheduler.flushAll();
  h.pipeline.updateAssistantSpritePosition();
  assert.notEqual(h.sprite.style.transform, '', 'precondition: the settled sprite sits at its row');
  h.state.currentSessionId = 'session-2';
  h.scheduler.flushAll();
  assert.equal(h.layer.classList.contains('visible'), false);
  // The layer is an overflow-visible child of the scroller: a hidden sprite
  // left thousands of pixels down kept the previous chat's scroll height, and
  // a new chat followed "latest" into blank space (dogfood B16).
  assert.equal(h.sprite.style.transform, '', 'a hidden sprite holds no position');
  h.pipeline.updateAssistantSpritePosition([]);
  assert.equal(h.spriteRuntime.targetMessageId, '');
  h.scheduler.flushAll();
  assert.equal(h.layer.dataset.suppressionReason, 'empty_thread');
  assert.equal(h.sprite.style.transform, '');
  h.pipeline.dispose();
  h.dom.window.close();
});

for (const status of ['error', 'cancelled', 'complete']) {
  test(`tool-only ending uses ${status} outcome without moving off prose`, () => {
    const h = createHarness({ messages: [
      { id: 'u1', role: 'user', content: 'Run' },
      { id: 'a1', role: 'assistant', content: 'Working', status: 'complete' },
      { id: 'tool1', role: 'assistant', kind: 'tool_use', status },
    ] });
    if (status !== 'complete') setLiveThinkingState(h);
    h.pipeline.updateAssistantSpritePosition();
    h.scheduler.flushAll();
    assert.equal(h.spriteRuntime.targetMessageId, 'a1');
    assert.equal(h.sprite.dataset.spriteState, status);
    assert.equal(h.sprite.classList.contains('is-streaming'), false);
    h.pipeline.dispose();
    h.dom.window.close();
  });
}


test('live reasoning status selects the later streaming row within the active message', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'streaming', content: 'Working' }],
  });
  const article = harness.dom.window.document.querySelector('.chat-entry[data-message-id="a1"]');
  const earlier = appendReasoningRow(article, { status: 'complete', label: 'Earlier complete' });
  const later = appendReasoningRow(article, { status: 'streaming', label: 'Later streaming' });
  setLiveThinkingState(harness);

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(earlier.main.textContent, 'Earlier complete');
  assert.equal(earlier.main.classList.contains('shimmer-active'), false);
  assert.equal(later.main.textContent, 'Updated live status');
  assert.equal(later.main.classList.contains('shimmer-active'), true);
  assert.equal(later.main.classList.contains('reasoning-row-main--live-status'), true);
  assert.equal(earlier.main.classList.contains('reasoning-row-main--live-status'), false);
  harness.pipeline.dispose();
});

test('reasoning status does not mutate labels after disposal', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'streaming', content: 'Working' }],
  });
  const article = harness.dom.window.document.querySelector('.chat-entry[data-message-id="a1"]');
  const active = appendReasoningRow(article);
  setLiveThinkingState(harness);
  harness.pipeline.dispose();

  harness.pipeline.renderLiveThinkingChip(null, 'a1');

  assert.equal(active.main.textContent, 'Original label');
  assert.equal(active.main.className, 'reasoning-row-main');
});

test('live reasoning status is scoped to the active message article', () => {
  const harness = createHarness({
    messages: [
      { id: 'a1', role: 'assistant', status: 'complete', content: 'Earlier response' },
      { id: 'a2', role: 'assistant', status: 'streaming', content: 'Current response' },
    ],
  });
  const articles = harness.dom.window.document.querySelectorAll('.chat-entry');
  const earlier = appendReasoningRow(articles[0], { label: 'Earlier article' });
  const active = appendReasoningRow(articles[1], { label: 'Active article' });
  setLiveThinkingState(harness);

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(earlier.main.textContent, 'Earlier article');
  assert.equal(earlier.main.classList.contains('shimmer-active'), false);
  assert.equal(active.main.textContent, 'Updated live status');
  assert.equal(active.main.classList.contains('shimmer-active'), true);
  assert.equal(active.main.classList.contains('reasoning-row-main--live-status'), true);
  assert.equal(earlier.main.classList.contains('reasoning-row-main--live-status'), false);
  harness.pipeline.dispose();
});

test('live reasoning status without an active message id selects the last streaming match', () => {
  const harness = createHarness({
    messages: [
      { id: 'a1', role: 'assistant', status: 'complete', content: 'Earlier response' },
      { id: 'a2', role: 'assistant', status: 'streaming', content: 'Current response' },
    ],
  });
  const articles = harness.dom.window.document.querySelectorAll('.chat-entry');
  const earlier = appendReasoningRow(articles[0], { label: 'Earlier article' });
  const latestStreaming = appendReasoningRow(articles[1], { label: 'Latest streaming' });
  setLiveThinkingState(harness);

  harness.pipeline.renderLiveThinkingChip();

  assert.equal(earlier.main.textContent, 'Earlier article');
  assert.equal(earlier.main.classList.contains('shimmer-active'), false);
  assert.equal(latestStreaming.main.textContent, 'Updated live status');
  assert.equal(latestStreaming.main.classList.contains('shimmer-active'), true);
  harness.pipeline.dispose();
});

test('settled sprite is a persistent static anchor and unchanged renders are idempotent', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.layer.classList.contains('visible'), true);
  assert.equal(harness.sprite.dataset.spriteState, 'complete');
  const observer = new harness.dom.window.MutationObserver(() => {});
  observer.observe(harness.sprite, { attributes: true, subtree: true, childList: true });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(observer.takeRecords().length, 0, 'an unchanged passive state does not touch the sprite DOM');
  harness.pipeline.dispose();
});

test('sprite maps live, error, and canonical terminal metadata to distinct view states', () => {
  const message = { id: 'a1', role: 'assistant', status: 'streaming', content: 'Working' };
  const harness = createHarness({ messages: [message] });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'live');
  assert.equal(harness.sprite.classList.contains('is-streaming'), true);

  harness.state.activeStreamSessionId = 'session-1';
  harness.state.activeStreamId = 'stream-1';
  message.status = 'complete';
  message.terminal_status = 'streaming';
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'complete', 'settled row status outranks stale live metadata');

  message.status = 'error';
  delete message.terminal_status;
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'error');

  message.terminal_status = 'interrupted';
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'cancelled');

  message.terminal_status = 'aborted';
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'cancelled');
  harness.pipeline.dispose();
});

test('preflight anchors a live sprite below the latest user bubble', () => {
  const harness = createHarness({
    messages: [{ id: 'u1', role: 'user', status: 'complete', content: 'Hello' }],
    preflight: true,
  });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.sprite.dataset.spriteState, 'live');
  assert.equal(harness.spriteRuntime.targetMessageId, 'u1');
  assert.equal(harness.spriteRuntime.targetY, 172);
  harness.pipeline.dispose();
});

test('preflight for a new turn does not remain anchored to the previous assistant response', () => {
  const harness = createHarness({
    messages: [
      { id: 'u0', role: 'user', status: 'complete', content: 'Earlier prompt' },
      { id: 'a0', role: 'assistant', status: 'complete', content: 'Earlier response' },
      { id: 'u1', role: 'user', status: 'complete', content: 'New prompt' },
    ],
    preflight: true,
  });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(harness.spriteRuntime.targetMessageId, 'u1');
  assert.equal(harness.spriteRuntime.targetY, 372);
  harness.pipeline.dispose();
});

test('multistep tool phases retain the latest prose anchor until new prose arrives', () => {
  const turnMessages = [
    { id: 'u1', role: 'user', status: 'complete', content: 'Inspect this' },
    { id: 'a1', role: 'assistant', status: 'complete', content: 'I will inspect it.' },
    { id: 'tool1', role: 'assistant', kind: 'tool_use', status: 'streaming', content: '' },
    { id: 'result1', role: 'tool', kind: 'tool_result', status: 'complete', content: 'result' },
    { id: 'a2', role: 'assistant', status: 'streaming', content: 'The result is ready.' },
  ];
  const messages = turnMessages.slice();
  const harness = createHarness({ messages });
  messages.splice(2);
  harness.state.activeStreamSessionId = 'session-1';
  harness.state.activeStreamId = 'stream-1';

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.spriteRuntime.targetMessageId, 'a1');

  messages.push(turnMessages[2]);
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.spriteRuntime.targetMessageId, 'a1', 'tool use keeps the prose anchor');

  messages.push(turnMessages[3]);
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.spriteRuntime.targetMessageId, 'a1', 'tool result keeps the prose anchor');

  messages.push(turnMessages[4]);
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(harness.spriteRuntime.targetMessageId, 'a2', 'new prose becomes the next stable anchor');
  assert.equal(harness.sprite.dataset.spriteState, 'live');
  assert.equal(harness.layer.classList.contains('visible'), true);
  harness.pipeline.dispose();
});

test('a tool-only first assistant phase anchors to its article instead of falling back to the prompt', () => {
  const harness = createHarness({
    messages: [
      { id: 'u1', role: 'user', status: 'complete', content: 'Inspect this' },
      { id: 'tool1', role: 'assistant', kind: 'tool_use', status: 'streaming', content: '' },
    ],
    preflight: true,
  });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(harness.spriteRuntime.targetMessageId, 'tool1');
  assert.equal(harness.spriteRuntime.targetY, 200);
  harness.pipeline.dispose();
});

test('sprite placement is clamped to the rail layer bounds', () => {
  const messages = Array.from({ length: 9 }, (_, index) => ({
    id: `a${index + 1}`,
    role: 'assistant',
    status: 'complete',
    content: `Message ${index + 1}`,
  }));
  const harness = createHarness({ messages });

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(harness.spriteRuntime.targetMessageId, 'a9');
  assert.equal(harness.spriteRuntime.targetY, 770);
  harness.pipeline.dispose();
});

test('responsive hiding and malformed message input fail closed', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });
  harness.setLayerDisplay('none');
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(harness.layer.dataset.suppressionReason, 'responsive_hidden');

  harness.setLayerDisplay('block');
  assert.doesNotThrow(() => harness.pipeline.updateAssistantSpritePosition({ malformed: true }));
  harness.scheduler.flushNext();
  assert.equal(harness.layer.dataset.suppressionReason, 'empty_thread');
  harness.pipeline.dispose();
});

test('malformed array entries are ignored while later valid messages still anchor', () => {
  const harness = createHarness({
    messages: [null, { id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });

  assert.doesNotThrow(() => harness.pipeline.updateAssistantSpritePosition());
  harness.scheduler.flushNext();
  assert.equal(harness.layer.classList.contains('visible'), true);
  assert.equal(harness.spriteRuntime.targetMessageId, 'a1');
  harness.pipeline.dispose();
});

test('stale positioning callbacks are fenced when frame cancellation is unavailable', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
    cancelFrames: false,
  });

  harness.pipeline.updateAssistantSpritePosition();
  harness.state.ui.activeView = 'settings';
  harness.pipeline.updateAssistantSpritePosition();
  assert.equal(harness.scheduler.size, 2);
  harness.scheduler.flushAll();
  assert.equal(harness.layer.dataset.suppressionReason, 'inactive_view');

  harness.state.ui.activeView = 'chat';
  harness.pipeline.updateAssistantSpritePosition();
  harness.pipeline.dispose();
  harness.scheduler.flushAll();
  assert.equal(harness.spriteRuntime.frameHandle, 0);
});

test('missing targets recover on a later mount without polling', async () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });
  const target = harness.dom.window.document.querySelector('[data-message-id="a1"]');
  const parent = target.parentNode;
  target.remove();

  harness.pipeline.updateAssistantSpritePosition();
  assert.equal(harness.scheduler.flushAll(), 1, 'no polling or retry deadline');
  assert.equal(harness.layer.dataset.suppressionReason, 'missing_target');
  assert.equal(harness.scheduler.size, 0);
  await Promise.resolve();
  harness.scheduler.flushAll();
  parent.appendChild(target);
  await Promise.resolve();
  harness.scheduler.flushAll();
  assert.equal(harness.layer.classList.contains('visible'), true);
  assert.equal(harness.spriteRuntime.targetMessageId, 'a1');
  harness.pipeline.dispose();
  assert.equal(harness.layer.classList.contains('visible'), false);
  parent.removeChild(target);
  await Promise.resolve();
  assert.equal(harness.scheduler.size, 0, 'disposed observer cannot schedule work');
  harness.dom.window.close();
});
