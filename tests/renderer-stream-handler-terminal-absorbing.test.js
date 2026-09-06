// CTL-003 acceptance contract: terminal is an ABSORBING renderer state.
// Once a stream reaches complete/error, every late or duplicate event for that
// stream — direct or buffered-replay — must be dropped at dispatch before any
// handler can mutate lifecycle, indicator, reducer, message, or toast state.
// The one deliberate exception is `message_updated`, the settled-message
// reconciliation channel (background monitor metadata), which must keep
// flowing after terminal.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers/renderer-stream-handler-harness');

function lifecycleOf(harness, sessionId) {
  return harness.state.ui.chatSendLifecycleBySession.get(sessionId) || 'idle';
}

async function completeSimpleTurn(harness, sessionId, streamId, content) {
  await harness.emit({ type: 'started', sessionId, streamId });
  await harness.emit({
    type: 'delta', sessionId, streamId, content, aggregate: content,
  });
  await harness.emit({ type: 'complete', sessionId, streamId, content });
}

test('late delta after complete leaves the send lifecycle idle', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await completeSimpleTurn(harness, 'session-1', 'stream-abs-delta', 'hi');
  assert.equal(lifecycleOf(harness, 'session-1'), 'idle', 'terminal settles to idle');

  await harness.emit({
    type: 'delta', sessionId: 'session-1', streamId: 'stream-abs-delta', content: '!', aggregate: 'hi!',
  });

  assert.equal(
    lifecycleOf(harness, 'session-1'),
    'idle',
    'a late delta must not flip the finalized session back to streaming',
  );
  const message = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-abs-delta');
  assert.equal(message.status, 'complete');
  assert.equal(message.content, 'hi', 'late delta content must not leak into the settled bubble');
});

test('late agent_status after complete leaves the send lifecycle idle and the bubble untouched', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await completeSimpleTurn(harness, 'session-1', 'stream-abs-status', 'done');

  await harness.emit({
    type: 'agent_status', sessionId: 'session-1', streamId: 'stream-abs-status', status: 'running', summary: 'late',
  });

  assert.equal(
    lifecycleOf(harness, 'session-1'),
    'idle',
    'a late agent_status must not flip the finalized session back to streaming',
  );
  const message = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-abs-status');
  assert.equal(message.status, 'complete');
  assert.ok(!message.agent_status, 'late agent_status must not attach to the settled bubble');
});

test('late/duplicate started after complete does not restart lifecycle or the thinking indicator', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await completeSimpleTurn(harness, 'session-1', 'stream-abs-started', 'done');
  const indicatorCallsAtTerminal = harness.calls.indicator.length;

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-abs-started' });

  assert.equal(
    lifecycleOf(harness, 'session-1'),
    'idle',
    'a late started must not flip the finalized session back to streaming',
  );
  assert.equal(
    harness.calls.indicator.length,
    indicatorCallsAtTerminal,
    'a late started must not restart the thinking indicator',
  );
  assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), false);
});

test('late thinking_status after complete does not resurrect per-stream thinking state', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await completeSimpleTurn(harness, 'session-1', 'stream-abs-think', 'done');
  const indicatorCallsAtTerminal = harness.calls.indicator.length;

  await harness.emit({
    type: 'thinking_status', sessionId: 'session-1', streamId: 'stream-abs-think', text: 'Reconsidering…',
  });

  assert.equal(
    harness.state.streamThinkingStatusByStream.has('stream-abs-think'),
    false,
    'a late thinking_status must not re-enter streamThinkingStatusByStream',
  );
  assert.equal(harness.calls.indicator.length, indicatorCallsAtTerminal);
  assert.equal(lifecycleOf(harness, 'session-1'), 'idle');
});

test('late phase_started after complete leaves lifecycle idle', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await completeSimpleTurn(harness, 'session-1', 'stream-abs-phase', 'done');

  await harness.emit({
    type: 'phase_started', sessionId: 'session-1', streamId: 'stream-abs-phase', phase: 'analysis',
  });

  assert.equal(lifecycleOf(harness, 'session-1'), 'idle');
  const message = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-abs-phase');
  assert.equal(message.status, 'complete');
});

test('late error after a successful complete fabricates no error bubble and no toast', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await completeSimpleTurn(harness, 'session-1', 'stream-abs-error', 'all good');
  const messagesAtTerminal = harness.state.messagesBySession.get('session-1');
  const messageCountAtTerminal = messagesAtTerminal.length;

  await harness.emit({
    type: 'error', sessionId: 'session-1', streamId: 'stream-abs-error', message: 'late provider failure',
  });

  const messages = harness.state.messagesBySession.get('session-1');
  assert.equal(
    messages.length,
    messageCountAtTerminal,
    'a late error must not append a synthetic bubble after a successful terminal',
  );
  assert.equal(
    messages.some((entry) => String(entry.id || '').startsWith('error_')),
    false,
    'no error_<streamId> row may be synthesized for a finalized stream',
  );
  assert.equal(
    messages.some((entry) => entry.status === 'error'),
    false,
    'the successful turn must not gain an error-status row',
  );
  assert.equal(harness.calls.toasts.length, 0, 'no Streaming Error toast after a successful terminal');
  assert.equal(lifecycleOf(harness, 'session-1'), 'idle');
});

test('late complete after a terminal error does not settle the stream a second time', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-abs-err-first' });
  await harness.emit({
    type: 'error', sessionId: 'session-1', streamId: 'stream-abs-err-first', message: 'engine crashed',
  });

  const failedMessage = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-abs-err-first');
  assert.equal(failedMessage.status, 'error');
  const indicatorCallsAtTerminal = harness.calls.indicator.length;
  const settleWritesAtTerminal = harness.calls.setSessionMessages.length;

  await harness.emit({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-abs-err-first', content: 'phantom success',
  });

  const messageAfter = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-abs-err-first');
  assert.equal(messageAfter.status, 'error', 'a late complete must not overwrite a terminal error');
  assert.notEqual(messageAfter.content, 'phantom success');
  assert.equal(
    harness.calls.indicator.length,
    indicatorCallsAtTerminal,
    'a late complete must not drive the thinking indicator again',
  );
  assert.equal(
    harness.calls.setSessionMessages.length,
    settleWritesAtTerminal,
    'a late complete must not write session messages again',
  );
});

test('duplicate complete is dropped before any handler side effect', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await completeSimpleTurn(harness, 'session-1', 'stream-abs-dup', 'once');
  const indicatorCallsAtTerminal = harness.calls.indicator.length;
  const settleWritesAtTerminal = harness.calls.setSessionMessages.length;

  await harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-abs-dup', content: 'twice' });

  const message = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-abs-dup');
  assert.equal(message.content, 'once');
  assert.equal(
    harness.calls.indicator.length,
    indicatorCallsAtTerminal,
    'a duplicate complete must not drive the thinking indicator again',
  );
  assert.equal(
    harness.calls.setSessionMessages.length,
    settleWritesAtTerminal,
    'a duplicate complete must not rewrite session messages',
  );
});

test('buffered replay [started, delta, complete, error] yields one successful bubble, no error row, no toast', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  harness.state.bufferedStreamEventsByStream.set('stream-abs-buf', [
    { type: 'started', sessionId: 'session-1', streamId: 'stream-abs-buf' },
    {
      type: 'delta', sessionId: 'session-1', streamId: 'stream-abs-buf', content: 'answer', aggregate: 'answer',
    },
    { type: 'complete', sessionId: 'session-1', streamId: 'stream-abs-buf', content: 'answer' },
    { type: 'error', sessionId: 'session-1', streamId: 'stream-abs-buf', message: 'protocol drift' },
  ]);

  const result = await harness.handler.flushBufferedStreamEvents('stream-abs-buf');

  assert.equal(result.terminal, true);
  assert.equal(
    result.discardedCount,
    1,
    'the post-terminal tail must be reported as terminal-discarded, not silently replayed',
  );
  const messages = harness.state.messagesBySession.get('session-1');
  const assistantRows = messages.filter((entry) => entry.role === 'assistant');
  assert.equal(assistantRows.length, 1, 'exactly one assistant row for the turn');
  assert.equal(assistantRows[0].status, 'complete');
  assert.equal(assistantRows[0].content, 'answer');
  assert.equal(
    messages.some((entry) => String(entry.id || '').startsWith('error_')),
    false,
    'buffered replay must stop at the terminal instead of dispatching the trailing error',
  );
  assert.equal(harness.calls.toasts.length, 0, 'no Streaming Error toast from the discarded tail');
  assert.equal(lifecycleOf(harness, 'session-1'), 'idle');
  assert.equal(
    harness.state.bufferedStreamEventsByStream.has('stream-abs-buf'),
    false,
    'the buffered queue is released after a terminal replay',
  );
});

test('buffered replay drops the whole multi-event tail after terminal and reports the count', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  harness.state.bufferedStreamEventsByStream.set('stream-abs-buf-tail', [
    { type: 'started', sessionId: 'session-1', streamId: 'stream-abs-buf-tail' },
    { type: 'complete', sessionId: 'session-1', streamId: 'stream-abs-buf-tail', content: 'settled' },
    {
      type: 'delta', sessionId: 'session-1', streamId: 'stream-abs-buf-tail', content: 'zombie', aggregate: 'settledzombie',
    },
    {
      type: 'agent_status', sessionId: 'session-1', streamId: 'stream-abs-buf-tail', status: 'running', summary: 'zombie',
    },
  ]);

  const result = await harness.handler.flushBufferedStreamEvents('stream-abs-buf-tail');

  assert.equal(result.terminal, true);
  assert.equal(result.discardedCount, 2, 'both post-terminal events are discarded');
  const message = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-abs-buf-tail');
  assert.equal(message.status, 'complete');
  assert.equal(message.content, 'settled', 'discarded tail content must not reach the settled bubble');
  assert.equal(lifecycleOf(harness, 'session-1'), 'idle');
});

// Boundary with the preempt-retry ordering contract: clearStream (stop/
// preempt) finalizes a stream WITHOUT any terminal handler settling its
// partial bubble. The provider's one genuine late terminal must pass the
// gate and settle the bubble; only DUPLICATE terminals after that settle
// are absorbed. (Full ordering coverage lives in
// renderer-stream-handler-terminal-preempt-retry-ordering.test.js.)
test('late error for a preempt-finalized stream settles the partial once, then duplicates absorb', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-abs-preempt' });
  await harness.emit({
    type: 'delta', sessionId: 'session-1', streamId: 'stream-abs-preempt', content: 'partial', aggregate: 'partial',
  });
  // Preempt: finalized with NO terminal settle; the partial bubble stays.
  harness.multiStreamController.clearStream('stream-abs-preempt');
  assert.equal(harness.multiStreamController.isStreamFinalized('stream-abs-preempt'), true);

  await harness.emit({
    type: 'error', sessionId: 'session-1', streamId: 'stream-abs-preempt', message: 'CMP-AI-0002 connection dropped',
  });

  const settled = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-abs-preempt');
  assert.equal(
    settled.status,
    'error',
    'the one genuine late terminal for a preempt-finalized stream must settle the partial bubble',
  );
  const settleWritesAtTerminal = harness.calls.setSessionMessages.length;
  const toastsAtTerminal = harness.calls.toasts.length;

  await harness.emit({
    type: 'error', sessionId: 'session-1', streamId: 'stream-abs-preempt', message: 'duplicate late failure',
  });

  assert.equal(
    harness.calls.setSessionMessages.length,
    settleWritesAtTerminal,
    'a duplicate terminal after the late settle must be absorbed at dispatch',
  );
  assert.equal(harness.calls.toasts.length, toastsAtTerminal, 'no second Streaming Error toast');
  assert.equal(lifecycleOf(harness, 'session-1'), 'idle');
});

test('message_updated still applies to a settled message after its stream finalized (reconciliation passthrough)', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await completeSimpleTurn(harness, 'session-1', 'stream-abs-recon', 'tool ran');

  await harness.emit({
    type: 'message_updated',
    sessionId: 'session-1',
    streamId: 'stream-abs-recon',
    messageId: 'assistant_stream-abs-recon',
    patch: { tool_result: { metadata: { monitor: { progress: 0.5, note: 'background refresh' } } } },
  });

  const message = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-abs-recon');
  assert.equal(
    message.tool_result?.metadata?.monitor?.note,
    'background refresh',
    'message_updated is the settled-message reconciliation channel and must pass the terminal gate',
  );
  assert.equal(message.status, 'complete');
});

// Code-review pin (2026-07-10): the one-shot late-terminal allowance admits
// COMPLETE as well as error — a late complete for a preempt-finalized stream
// must reconcile the surviving partial bubble in place (previously it was
// admitted, marked settled, then silently no-opped, stranding the bubble at
// 'streaming'), and duplicates after that settle absorb.
test('late complete for a preempt-finalized stream settles the partial once, then duplicates absorb', async (t) => {
  const usageUpdates = [];
  const harness = createHarness({
    callbackOverrides: {
      updateContextUsage(sessionId, payload) {
        usageUpdates.push({ sessionId, payload });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-abs-preempt-c' });
  await harness.emit({
    type: 'delta', sessionId: 'session-1', streamId: 'stream-abs-preempt-c', content: 'partial', aggregate: 'partial',
  });
  harness.multiStreamController.clearStream('stream-abs-preempt-c');
  assert.equal(harness.multiStreamController.isStreamFinalized('stream-abs-preempt-c'), true);

  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-abs-preempt-c',
    content: 'the late final answer',
    usage: { context_tokens: 321, context_window: 4096 },
  });

  const settled = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-abs-preempt-c');
  assert.equal(settled.status, 'complete', 'the late complete settles the partial bubble');
  assert.equal(settled.content, 'the late final answer', 'the bubble carries the terminal content');
  assert.equal(usageUpdates.length, 1, 'the admitted late terminal reconciles exact usage once');
  assert.equal(usageUpdates[0].sessionId, 'session-1');
  assert.deepEqual(usageUpdates[0].payload.usage, {
    context_tokens: 321,
    context_window: 4096,
  });
  const settleWritesAtTerminal = harness.calls.setSessionMessages.length;

  await harness.emit({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-abs-preempt-c', content: 'duplicate late complete',
  });

  assert.equal(
    harness.calls.setSessionMessages.length,
    settleWritesAtTerminal,
    'a duplicate terminal after the late settle must be absorbed at dispatch',
  );
  assert.equal(usageUpdates.length, 1, 'a duplicate terminal must not apply usage twice');
});
