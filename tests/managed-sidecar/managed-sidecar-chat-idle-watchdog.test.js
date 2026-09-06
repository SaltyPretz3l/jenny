const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');
const {
  buildManagedSidecarChatSendOptions,
} = require('../../services/backend/electron-tool-bridge');
const { createManagedChatServiceStub } = require('../helpers/managed-sidecar-chat-lifecycle-helpers');
const { resolveChatStreamCeilings } = require('../../services/backend/managed-sidecar-chat-helpers');

// The watchdog starts on the local ceilings (engine unknown until the turn
// resolves); read them from the helper so a ceiling change cannot strand a
// literal here (the local absolute cap already grew past 1_800_000 once).
const {
  idleTimeoutMs: IDLE_TIMEOUT_MS,
  absoluteTimeoutMs: ABSOLUTE_TIMEOUT_MS,
} = resolveChatStreamCeilings('');

function buildChatRequest(overrides = {}) {
  const prompt = String(overrides.prompt || 'Idle watchdog request');
  return {
    sessionId: overrides.sessionId || 'session_idle_watchdog',
    prompt,
    visiblePrompt: prompt,
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  };
}

// Installs a virtual timer registry over global setTimeout/clearTimeout so the
// test can inspect armed timers by delay and fire them deterministically.
function installVirtualTimers() {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const timers = new Map();
  let nextId = 1;
  let idleArmCount = 0;
  global.setTimeout = (fn, delay) => {
    if (delay === IDLE_TIMEOUT_MS) {
      idleArmCount += 1;
    }
    const id = nextId++;
    timers.set(id, { fn, delay });
    return { _timerId: id, unref() {} };
  };
  global.clearTimeout = (handle) => {
    if (handle && handle._timerId) {
      timers.delete(handle._timerId);
    }
  };
  return {
    timersWithDelay: (delay) => [...timers.values()].filter((t) => t.delay === delay),
    fireFirstWithDelay: (delay) => {
      const timer = [...timers.values()].find((t) => t.delay === delay);
      assert.ok(timer, `expected an armed timer with delay ${delay}ms`);
      timer.fn();
    },
    getIdleArmCount: () => idleArmCount,
    restore: () => {
      global.setTimeout = previousSetTimeout;
      global.clearTimeout = previousClearTimeout;
    },
  };
}

test('idle watchdog re-arms on each stream event and only one idle timer stays armed', async () => {
  const vt = installVirtualTimers();
  const service = createManagedChatServiceStub();
  let signalReady;
  const ready = new Promise((resolve) => { signalReady = resolve; });
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      // Three activity events; each should re-arm (clear + reset) the idle timer.
      options.onNotification({ method: 'chat.token', params: { delta: 'a' } });
      options.onNotification({ method: 'chat.token', params: { delta: 'b' } });
      options.onNotification({ method: 'chat.token', params: { delta: 'c' } });
      signalReady();
      // Keep the request pending so the idle watchdog is the live terminal path.
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(options.signal.reason || new Error('aborted')),
          { once: true }
        );
      });
    },
  };

  try {
    const stream = await startManagedSidecarChatStream(service, buildChatRequest());
    await ready;

    // Exactly one absolute timer; exactly one *surviving* idle timer (older
    // arms were cleared), but it was armed more than once (initial + activity).
    assert.equal(vt.timersWithDelay(ABSOLUTE_TIMEOUT_MS).length, 1);
    assert.equal(vt.timersWithDelay(IDLE_TIMEOUT_MS).length, 1);
    assert.ok(vt.getIdleArmCount() >= 4, 'idle timer should re-arm on initial leg + each activity event');

    // Firing the idle timer aborts the otherwise-healthy-looking stream.
    vt.fireFirstWithDelay(IDLE_TIMEOUT_MS);
    await service.activeStreams.get(stream.streamId)._pendingPromise;

    assert.equal(
      service.serviceLogs.some((entry) => entry.event === 'chat.stream_timeout'),
      true
    );
    const errorEvent = service.emittedEvents.find(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
    );
    assert.ok(errorEvent);
    assert.equal(errorEvent.payload.category, 'timeout');
    assert.match(String(errorEvent.payload.message || ''), /idle/i);
  } finally {
    vt.restore();
  }
});

test('absolute backstop aborts the turn regardless of ongoing activity', async () => {
  const vt = installVirtualTimers();
  const service = createManagedChatServiceStub();
  let signalReady;
  const ready = new Promise((resolve) => { signalReady = resolve; });
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.token', params: { delta: 'still going' } });
      signalReady();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(options.signal.reason || new Error('aborted')),
          { once: true }
        );
      });
    },
  };

  try {
    const stream = await startManagedSidecarChatStream(service, buildChatRequest({
      sessionId: 'session_idle_watchdog_absolute',
    }));
    await ready;

    vt.fireFirstWithDelay(ABSOLUTE_TIMEOUT_MS);
    await service.activeStreams.get(stream.streamId)._pendingPromise;

    const errorEvent = service.emittedEvents.find(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
    );
    assert.ok(errorEvent);
    assert.equal(errorEvent.payload.category, 'timeout');
    assert.match(String(errorEvent.payload.message || ''), /absolute/i);
  } finally {
    vt.restore();
  }
});

test('buildManagedSidecarChatSendOptions re-arms idle watchdog before handling each notification', () => {
  const calls = [];
  const controller = new AbortController();
  const options = buildManagedSidecarChatSendOptions({
    service: { _emitServiceLog() {} },
    controller,
    streamId: 'stream_unit',
    resolvedSessionId: 'session_unit',
    requestId: 'req_unit',
    requestTraceId: 'trace_unit',
    runtime: { handleNotification: () => calls.push('handle') },
    toolContext: {},
    handleToolNotification: () => {},
    waitForToolApproval: async () => true,
    turnEventCollector: {},
    normalizedPreferences: {},
    noteStreamActivity: () => calls.push('activity'),
    pauseStreamIdleTimer: () => calls.push('pause'),
    timeoutMs: 1000,
  });

  options.onNotification({ method: 'chat.token', params: { delta: 'x' } });

  // Activity is recorded before the notification is dispatched downstream.
  assert.deepEqual(calls, ['activity', 'handle']);
});

test('buildManagedSidecarChatSendOptions pauses idle watchdog during approval wait and re-arms after', async () => {
  const calls = [];
  const controller = new AbortController();
  const options = buildManagedSidecarChatSendOptions({
    service: { _emitServiceLog() {} },
    controller,
    streamId: 'stream_unit',
    resolvedSessionId: 'session_unit',
    requestId: 'req_unit',
    requestTraceId: 'trace_unit',
    runtime: { handleNotification: () => {} },
    toolContext: {},
    handleToolNotification: () => {},
    waitForToolApproval: async () => {
      calls.push('wait');
      return true;
    },
    turnEventCollector: {},
    normalizedPreferences: {},
    noteStreamActivity: () => calls.push('activity'),
    pauseStreamIdleTimer: () => calls.push('pause'),
    timeoutMs: 1000,
  });

  const result = await options.onApprovalRequest({ tool_name: 'read_file' });

  assert.equal(result, true);
  // Pause before the (potentially long) human wait, re-arm once it resolves.
  assert.deepEqual(calls, ['pause', 'wait', 'activity']);
});
