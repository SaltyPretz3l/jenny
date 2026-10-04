const test = require('node:test');
const assert = require('node:assert/strict');

const { appendReasoningRow, createHarness, setLiveThinkingState } = require('./helpers/thinking-pipeline-harness');

const LIVE_STATUS_CLASS = 'reasoning-row-main--live-status';

test('unchanged live reasoning status quiesces: promotion does not re-queue positioning', async () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'streaming', content: 'Working' }],
  });
  const article = harness.dom.window.document.querySelector('.chat-entry[data-message-id="a1"]');
  const active = appendReasoningRow(article, { thinkingId: 'thinking-1', label: 'Thinking' });
  setLiveThinkingState(harness, { thinkingId: 'thinking-1', text: 'Thinking' });

  harness.pipeline.updateAssistantSpritePosition();
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
    harness.scheduler.flushNext();
  }
  await Promise.resolve();

  assert.equal(harness.scheduler.size, 0, 'no self-sustaining positioning frame loop');
  assert.equal(active.main.classList.contains(LIVE_STATUS_CLASS), true);
  harness.pipeline.dispose();
  harness.dom.window.close();
});

test('live status promotion moves to the new active reasoning row', async () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'streaming', content: 'Working' }],
  });
  const article = harness.dom.window.document.querySelector('.chat-entry[data-message-id="a1"]');
  const first = appendReasoningRow(article, { thinkingId: 'thinking-1', label: 'First' });
  const second = appendReasoningRow(article, { thinkingId: 'thinking-2', label: 'Second' });
  setLiveThinkingState(harness, { thinkingId: 'thinking-1', text: 'First live' });
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
  assert.equal(first.main.classList.contains(LIVE_STATUS_CLASS), true);
  assert.equal(second.main.classList.contains(LIVE_STATUS_CLASS), false);

  setLiveThinkingState(harness, { thinkingId: 'thinking-2', text: 'Second live' });
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(first.main.classList.contains(LIVE_STATUS_CLASS), false);
  assert.equal(second.main.classList.contains(LIVE_STATUS_CLASS), true);
  assert.equal(second.main.textContent, 'Second live');
  harness.pipeline.dispose();
  harness.dom.window.close();
});

test('responsive sprite hiding keeps the shimmer of a still-live reasoning row', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'streaming', content: 'Working' }],
  });
  const article = harness.dom.window.document.querySelector('.chat-entry[data-message-id="a1"]');
  const active = appendReasoningRow(article, { thinkingId: 'thinking-1', label: 'Thinking' });
  setLiveThinkingState(harness, { thinkingId: 'thinking-1', text: 'Thinking' });
  active.main.classList.add('shimmer-active');
  harness.setLayerDisplay('none');

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(harness.layer.dataset.suppressionReason, 'responsive_hidden');
  assert.equal(active.main.classList.contains('shimmer-active'), true);
  harness.pipeline.dispose();
  harness.dom.window.close();
});

test('responsive sprite hiding still clears a shimmer when no live thinking remains', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });
  const article = harness.dom.window.document.querySelector('.chat-entry[data-message-id="a1"]');
  const stale = appendReasoningRow(article, { thinkingId: 'thinking-1', status: 'complete', label: 'Done thinking' });
  stale.main.classList.add('shimmer-active');
  harness.setLayerDisplay('none');

  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();

  assert.equal(harness.layer.dataset.suppressionReason, 'responsive_hidden');
  assert.equal(stale.main.classList.contains('shimmer-active'), false);
  harness.pipeline.dispose();
  harness.dom.window.close();
});
