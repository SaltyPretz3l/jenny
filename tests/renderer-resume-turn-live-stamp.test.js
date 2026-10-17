const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeferred } = require('./helpers/deferred');
const {
  createHarness,
  flushMicrotasks,
} = require('./helpers/renderer-stream-handler-buffering-harness');

function createDeferredHydrationHarness(t) {
  const hydration = createDeferred();
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return hydration.promise;
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());
  return { harness, hydration };
}

function getAssistantMessage(harness, streamId) {
  return harness.state.messagesBySession.get('session-1')
    .find((message) => message.id === `assistant_${streamId}`);
}

test('complete stamps a valid resumable stop before terminal hydration resolves', async (t) => {
  const { harness, hydration } = createDeferredHydrationHarness(t);
  const streamId = 'stream-live-stamp';

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId });
  const completePromise = harness.emit({
    type: 'complete', sessionId: 'session-1', streamId, content: 'done', resumableStop: 'tool_cap',
  });
  await flushMicrotasks(20);

  const localMessage = getAssistantMessage(harness, streamId);
  assert.equal(localMessage.status, 'complete');
  assert.equal(localMessage.resumable_stop, 'tool_cap');

  hydration.resolve({ data: [localMessage] });
  await completePromise;
});

test('failed terminal hydration keeps the live resumable stop on fallback messages', async (t) => {
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              throw new Error('terminal hydration failed');
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());
  const streamId = 'stream-failed-hydration';

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId });
  await harness.emit({
    type: 'complete', sessionId: 'session-1', streamId, content: 'done', resumableStop: 'tool_cap',
  });

  assert.equal(getAssistantMessage(harness, streamId).resumable_stop, 'tool_cap');
});

test('plain complete does not add a resumable_stop key', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());
  const streamId = 'stream-plain';

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId });
  await harness.emit({ type: 'complete', sessionId: 'session-1', streamId, content: 'done' });

  assert.equal(Object.hasOwn(getAssistantMessage(harness, streamId), 'resumable_stop'), false);
});

test('bogus resumable stops add no key and do not throw', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());
  const bogusValues = ['nonsense', 'TOOL_CAP', 42, {}, null];

  for (const [index, resumableStop] of bogusValues.entries()) {
    const streamId = `stream-bogus-${index}`;
    await harness.emit({ type: 'started', sessionId: 'session-1', streamId });
    await assert.doesNotReject(() => harness.emit({
      type: 'complete', sessionId: 'session-1', streamId, content: 'done', resumableStop,
    }));
    assert.equal(Object.hasOwn(getAssistantMessage(harness, streamId), 'resumable_stop'), false);
  }
});

test('successful hydration keeps the persisted resumable stop value', async (t) => {
  const { harness, hydration } = createDeferredHydrationHarness(t);
  const streamId = 'stream-hydrated-stop';

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId });
  const completePromise = harness.emit({
    type: 'complete', sessionId: 'session-1', streamId, content: 'live', resumableStop: 'tool_cap',
  });
  await flushMicrotasks(20);
  hydration.resolve({
    data: [{
      id: `assistant_${streamId}`,
      role: 'assistant',
      content: 'persisted',
      status: 'complete',
      parent_stream_id: streamId,
      resumable_stop: 'max_iterations',
    }],
  });
  await completePromise;

  assert.equal(getAssistantMessage(harness, streamId).resumable_stop, 'max_iterations');
});

test('row 59 cp5a: complete stamps a valid proposal boundary and drops a malformed one', async (t) => {
  const { harness, hydration } = createDeferredHydrationHarness(t);
  const proposalId = `proposal_${'a'.repeat(64)}`;
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-boundary' });
  const completePromise = harness.emit({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-boundary', content: '', completionReason: 'awaiting_proposal', proposalId,
  });
  await flushMicrotasks(20);
  const local = getAssistantMessage(harness, 'stream-boundary');
  assert.equal(local.completion_reason, 'awaiting_proposal');
  assert.equal(local.completion_proposal_id, proposalId);
  assert.equal(local.resumable_stop, undefined, 'a proposal boundary is not a Resume stop');
  hydration.resolve({ data: [local] });
  await completePromise;
});

test('row 59 cp5a: an unknown completion reason or a bad proposal id stamps nothing', async (t) => {
  const { harness, hydration } = createDeferredHydrationHarness(t);
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-bad' });
  const completePromise = harness.emit({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-bad', content: 'x', completionReason: 'awaiting_proposal', proposalId: 'proposal_nope',
  });
  await flushMicrotasks(20);
  const local = getAssistantMessage(harness, 'stream-bad');
  assert.equal(local.completion_reason, undefined);
  assert.equal(local.completion_proposal_id, undefined);
  hydration.resolve({ data: [local] });
  await completePromise;
});
