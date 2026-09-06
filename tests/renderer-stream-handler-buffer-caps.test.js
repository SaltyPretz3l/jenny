// CTL-014: buffered pre-session streams have a per-stream event cap but no
// TOTAL stream/event/byte caps, stale eviction runs only from render postwork
// (a stream buffered precisely because its session does not exist may never
// cause a render), and disposal never clears the buffered map. Contract
// pinned here:
//   - total stream-count cap with whole-stream eviction + structured WARN
//     counters (victim = smallest non-active queue, ties oldest-first —
//     lowest event-loss cost; degenerates to oldest-first for equal sizes);
//   - total event-count and approximate byte caps (whole streams evicted
//     until within budget — the stream being appended to is never trimmed
//     except by the per-stream cap);
//   - per-stream event ORDER is preserved for surviving streams;
//   - a lightweight expiry sweep runs on an injected timer, independent of
//     renders, and disarms once the buffer is empty;
//   - disposal clears the buffered map.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStreamSessionHelpers,
} = require('../renderer/chat/renderer-stream-handler-session-helpers');
const { createHarness } = require('./helpers/renderer-stream-handler-buffering-harness');

function createManualTimers() {
  let nextHandle = 1;
  const pending = new Map();
  return {
    setTimeoutImpl(callback, delayMs) {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimeoutImpl(handle) {
      pending.delete(handle);
    },
    fireAll() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) entry.callback();
      return entries.length;
    },
    pendingCount() {
      return pending.size;
    },
  };
}

function createHelpersHarness(capOverrides = {}) {
  const state = {
    currentSessionId: 'session-live',
    sessions: [],
    messagesBySession: new Map(),
    interactiveDraftsBySession: new Map(),
    bufferedStreamEventsByStream: new Map(),
  };
  const logs = [];
  const timers = createManualTimers();
  const helpers = createStreamSessionHelpers({
    state,
    normalizeId: (value) => String(value || '').trim(),
    appendClientLog: (level, event, details = {}) => logs.push({ level, event, details }),
    isCurrentSession: () => false,
    isVisibleChatSession: () => false,
    approvalToastSessionIds: new Set(),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    ...capOverrides,
  });
  return { state, logs, timers, helpers };
}

function bufferedStreamIds(state) {
  return [...state.bufferedStreamEventsByStream.keys()];
}

function totalBufferedEvents(state) {
  let total = 0;
  for (const events of state.bufferedStreamEventsByStream.values()) total += events.length;
  return total;
}

function evictionWarns(logs) {
  return logs.filter((entry) => entry.event === 'stream.buffered_streams_evicted');
}

test('a flood of distinct stream ids is capped with whole oldest-stream eviction and a counter', () => {
  const { state, logs, helpers } = createHelpersHarness({ maxBufferedStreams: 3 });
  for (let index = 1; index <= 5; index += 1) {
    helpers.bufferStreamEvent({ streamId: `stream_${index}`, type: 'delta', content: `c${index}` });
    helpers.bufferStreamEvent({ streamId: `stream_${index}`, type: 'delta', content: `c${index}b` });
  }
  assert.deepEqual(bufferedStreamIds(state), ['stream_3', 'stream_4', 'stream_5']);
  // Evicted streams disappear whole — no partial queues left behind.
  assert.equal(state.bufferedStreamEventsByStream.has('stream_1'), false);
  assert.equal(state.bufferedStreamEventsByStream.has('stream_2'), false);
  const warns = evictionWarns(logs);
  assert.ok(warns.length >= 1, 'eviction must emit a structured warning');
  assert.equal(warns[0].level, 'WARN');
  assert.equal(warns[0].details.reason, 'stream_cap');
  assert.ok(Number(warns[0].details.droppedEvents) >= 1);
});

test('a total event-count cap evicts oldest streams until within budget', () => {
  const { state, logs, helpers } = createHelpersHarness({
    maxBufferedStreams: 100,
    maxBufferedEventsTotal: 5,
  });
  for (let index = 0; index < 4; index += 1) {
    helpers.bufferStreamEvent({ streamId: 'stream_a', type: 'tool_use', callId: `a${index}` });
  }
  for (let index = 0; index < 4; index += 1) {
    helpers.bufferStreamEvent({ streamId: 'stream_b', type: 'tool_use', callId: `b${index}` });
  }
  assert.ok(totalBufferedEvents(state) <= 5, `total ${totalBufferedEvents(state)} exceeds cap 5`);
  // The newest stream keeps its full queue; the oldest was evicted whole.
  assert.equal(state.bufferedStreamEventsByStream.has('stream_a'), false);
  assert.equal(state.bufferedStreamEventsByStream.get('stream_b').length, 4);
  assert.equal(evictionWarns(logs).some((entry) => entry.details.reason === 'event_cap'), true);
});

test('an approximate total byte cap evicts oldest streams', () => {
  const bigPayload = 'x'.repeat(300);
  const { state, logs, helpers } = createHelpersHarness({
    maxBufferedStreams: 100,
    maxBufferedEventsTotal: 1000,
    maxBufferedBytesTotal: 500,
  });
  helpers.bufferStreamEvent({ streamId: 'stream_big_1', type: 'delta', content: bigPayload });
  helpers.bufferStreamEvent({ streamId: 'stream_big_2', type: 'delta', content: bigPayload });
  assert.equal(state.bufferedStreamEventsByStream.has('stream_big_1'), false, 'oldest stream evicted for bytes');
  assert.equal(state.bufferedStreamEventsByStream.has('stream_big_2'), true);
  assert.equal(evictionWarns(logs).some((entry) => entry.details.reason === 'byte_cap'), true);
});

test('cap accounting survives external flush mutation of the buffered map', () => {
  // renderer-stream-handler-dispatch.js flushes a buffered stream by mutating
  // state.bufferedStreamEventsByStream directly (delete without going through
  // the helpers). Cap accounting must reflect the live map, not a running
  // counter that ratchets upward forever and eventually evicts every stream.
  const { state, logs, helpers } = createHelpersHarness({
    maxBufferedStreams: 100,
    maxBufferedEventsTotal: 5,
  });
  for (let index = 0; index < 4; index += 1) {
    helpers.bufferStreamEvent({ streamId: 'stream_flushed', type: 'delta', content: `f${index}` });
  }
  // Simulate a dispatch flush: the stream's session arrived and dispatch
  // drained + deleted it behind the helpers' back.
  state.bufferedStreamEventsByStream.delete('stream_flushed');
  helpers.bufferStreamEvent({ streamId: 'stream_b', type: 'delta', content: 'b0' });
  helpers.bufferStreamEvent({ streamId: 'stream_b', type: 'delta', content: 'b1' });
  helpers.bufferStreamEvent({ streamId: 'stream_c', type: 'delta', content: 'c0' });
  // True semantic total is 2 events (contiguous deltas coalesce); nothing may be evicted.
  assert.deepEqual(bufferedStreamIds(state), ['stream_b', 'stream_c']);
  assert.equal(totalBufferedEvents(state), 2);
  assert.equal(evictionWarns(logs).length, 0, 'no eviction may fire under the true total');
});

test('contiguous deltas coalesce without losing content (I6)', () => {
  const { state, helpers } = createHelpersHarness({ maxBufferedStreams: 3 });
  for (let index = 0; index < 5; index += 1) {
    helpers.bufferStreamEvent({ streamId: 'stream_keep', type: 'delta', content: `k${index}` });
  }
  helpers.bufferStreamEvent({ streamId: 'stream_evict_bait', type: 'delta', content: 'bait' });
  helpers.bufferStreamEvent({ streamId: 'stream_new', type: 'delta', content: 'n0' });
  const kept = state.bufferedStreamEventsByStream.get('stream_keep');
  assert.deepEqual(kept.map((event) => event.content), ['k0k1k2k3k4']);
});

test('the per-stream cap stops suffix replay and records a durable degraded marker', () => {
  const { state, helpers } = createHelpersHarness({ maxBufferPerStream: 2 });
  for (let index = 0; index < 4; index += 1) {
    helpers.bufferStreamEvent({ streamId: 'stream_solo', sessionId: 'session_solo', type: 'tool_use', callId: `s${index}` });
  }
  assert.equal(state.bufferedStreamEventsByStream.has('stream_solo'), false);
  assert.equal(state.degradedBufferedStreamsByStream.get('stream_solo')?.type, 'buffer_degraded');
  assert.equal(state.degradedBufferedStreamsByStream.get('stream_solo')?.reason, 'per_stream_event_cap');
  assert.equal(helpers.consumeBufferedStreamDegradation('stream_solo')?.sessionId, 'session_solo');
  assert.equal(state.degradedBufferedStreamsByStream.has('stream_solo'), false);
});

test('a degraded buffer replays the newest terminal payload', () => {
  const { state, helpers } = createHelpersHarness({ maxBufferPerStream: 2 });
  helpers.bufferStreamEvent({ streamId: 'stream_terminal', sessionId: 'session_terminal', type: 'question_batch' });
  helpers.bufferStreamEvent({ streamId: 'stream_terminal', sessionId: 'session_terminal', type: 'complete' });
  helpers.bufferStreamEvent({ streamId: 'stream_terminal', sessionId: 'session_terminal', type: 'tool_use', callId: 'call_1' });

  const marker = state.degradedBufferedStreamsByStream.get('stream_terminal');
  assert.equal(marker?.terminalPayload?.type, 'complete');
});

test('started is preserved once and status updates keep only the newest value per key', () => {
  const { state, helpers } = createHelpersHarness({});
  helpers.bufferStreamEvent({ streamId: 'stream_semantic', type: 'started', marker: 'first' });
  helpers.bufferStreamEvent({ streamId: 'stream_semantic', type: 'started', marker: 'duplicate' });
  helpers.bufferStreamEvent({ streamId: 'stream_semantic', type: 'agent_status', taskId: 'task_1', percent: 10 });
  helpers.bufferStreamEvent({ streamId: 'stream_semantic', type: 'tool_use', callId: 'call_1' });
  helpers.bufferStreamEvent({ streamId: 'stream_semantic', type: 'agent_status', taskId: 'task_1', percent: 90 });
  const events = state.bufferedStreamEventsByStream.get('stream_semantic');
  assert.equal(events.filter((event) => event.type === 'started').length, 1);
  assert.equal(events.find((event) => event.type === 'started').marker, 'first');
  assert.equal(events.filter((event) => event.type === 'agent_status').length, 1);
  assert.equal(events.find((event) => event.type === 'agent_status').percent, 90);
  assert.equal(events.some((event) => event.type === 'tool_use'), true);
});

test('stale buffered events expire on a timer without any render', () => {
  const { state, timers, helpers } = createHelpersHarness({
    bufferExpiryMs: 1000,
    bufferSweepIntervalMs: 1000,
  });
  helpers.bufferStreamEvent({ streamId: 'stream_stale', type: 'delta', content: 'old' });
  assert.ok(timers.pendingCount() >= 1, 'buffering must arm an expiry sweep timer');
  // Age the buffered event past the expiry window, then fire the sweep. No
  // render, no evictStaleBufferedEvents call from postwork — the timer alone
  // must clear it.
  const events = state.bufferedStreamEventsByStream.get('stream_stale');
  for (const event of events) event._bufferedAt = Date.now() - 60_000;
  timers.fireAll();
  assert.equal(state.bufferedStreamEventsByStream.size, 0, 'stale stream must be swept by the timer');
  assert.equal(timers.pendingCount(), 0, 'sweep timer disarms once the buffer is empty');
});

test('the sweep timer rearms while fresh events remain buffered', () => {
  const { state, timers, helpers } = createHelpersHarness({
    bufferExpiryMs: 60_000,
    bufferSweepIntervalMs: 1000,
  });
  helpers.bufferStreamEvent({ streamId: 'stream_fresh', type: 'delta', content: 'fresh' });
  timers.fireAll();
  assert.equal(state.bufferedStreamEventsByStream.size, 1, 'fresh events survive the sweep');
  assert.ok(timers.pendingCount() >= 1, 'sweep rearms while the buffer is non-empty');
});

test('clearBufferedStreamEvents empties the map and cancels the sweep timer', () => {
  const { state, timers, helpers } = createHelpersHarness({});
  helpers.bufferStreamEvent({ streamId: 'stream_a', type: 'delta', content: 'a' });
  helpers.bufferStreamEvent({ streamId: 'stream_b', type: 'delta', content: 'b' });
  assert.equal(typeof helpers.clearBufferedStreamEvents, 'function');
  helpers.clearBufferedStreamEvents();
  assert.equal(state.bufferedStreamEventsByStream.size, 0);
  assert.equal(state.degradedBufferedStreamsByStream.size, 0);
  assert.equal(timers.pendingCount(), 0);
});

test('stream handler disposal clears the buffered stream map', () => {
  const harness = createHarness();
  try {
    harness.state.bufferedStreamEventsByStream.set('stream_orphan', [
      { streamId: 'stream_orphan', type: 'delta', content: 'x', _bufferedAt: Date.now() },
    ]);
    harness.handler.dispose();
    assert.equal(harness.state.bufferedStreamEventsByStream.size, 0);
  } finally {
    harness.restore();
  }
});

test('a terminal arriving after degradation replaces the marker terminal so replay can settle the stream', () => {
  const { state, helpers } = createHelpersHarness({ maxBufferPerStream: 2 });
  for (let index = 0; index < 3; index += 1) {
    helpers.bufferStreamEvent({ streamId: 'stream_late', sessionId: 'session_late', type: 'tool_use', callId: `late${index}` });
  }
  assert.equal(state.degradedBufferedStreamsByStream.get('stream_late')?.terminalPayload, undefined);

  helpers.bufferStreamEvent({ streamId: 'stream_late', sessionId: 'session_late', type: 'text_delta', delta: 'dropped' });
  helpers.bufferStreamEvent({ streamId: 'stream_late', sessionId: 'session_late', type: 'Complete', message: { id: 'm_late' } });

  assert.equal(state.bufferedStreamEventsByStream.has('stream_late'), false, 'deltas stay dropped after degradation');
  const degradation = helpers.consumeBufferedStreamDegradation('stream_late');
  assert.equal(degradation?.terminalPayload?.type, 'complete');
  assert.equal(degradation?.terminalPayload?.message?.id, 'm_late');
});
