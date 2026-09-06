// CTL-006 + CTL-013 acceptance contract: terminal postwork is BOUNDED and
// GENERATION-SCOPED.
//
// CTL-006 — the postwork window (hydration + metadata/snapshot/observability refreshes
// + memory suggestion) keeps the session send-busy; a single hung dependency
// must not hold the busy gate forever. Every postwork stage releases at a
// bounded deadline (any sane production deadline is ≤ 120s — the tests tick
// mocked timers well past it), emits a bounded timed-out diagnostic, and the
// queued follow-up send still drains (or restores) afterward.
//
// CTL-013 — deleting the session while any postwork await is pending must
// invalidate the continuation: a late hydration/refresh resolution must not
// repopulate `messagesBySession` (or any renderer state) for the deleted id.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, createQueuedFrameController } = require('./helpers/renderer-stream-handler-harness');
const { createTerminalPostworkUtils } = require('../renderer/chat/renderer-stream-handler-terminal-postwork-utils');

async function flushMicrotasks(count = 30) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function neverResolves() {
  return new Promise(() => {});
}

function buildPostworkHarness(t, { callbackOverrides = {}, getMessages } = {}) {
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            getMessages: getMessages || (async () => ({ data: [] })),
          },
        },
      },
    },
    callbackOverrides: {
      appendClientLog(level, event, details) { logs.push({ level, event, details }); },
      ...callbackOverrides,
    },
  });
  t.after(() => harness.restore());
  return { harness, logs };
}

function emitCompletedTurn(harness, sessionId, streamId) {
  // Deliberately NOT awaited by hung-postwork tests: with a hung dependency
  // the handler promise stays pending until the deadline fires.
  const emitPromise = (async () => {
    await harness.emit({ type: 'started', sessionId, streamId });
    await harness.emit({ type: 'complete', sessionId, streamId, content: 'settled answer' });
  })();
  emitPromise.catch(() => {});
  return emitPromise;
}

function assertTimeoutDiagnostic(logs) {
  assert.ok(
    logs.some((entry) => /postwork/i.test(String(entry.event || ''))
      && /timeout|deadline|timed_out/i.test(String(entry.event || ''))),
    'the timed-out postwork stage is diagnosed with a bounded log'
  );
}

test('successful terminal metadata refresh schedules a guarded full repaint', async (t) => {
  const order = [];
  const observabilityOptions = [];
  const { harness } = buildPostworkHarness(t, {
    callbackOverrides: {
      refreshSessionSummaries: async () => { order.push('refresh'); },
      refreshObservability: async (options) => { observabilityOptions.push(options); },
      renderAll: () => { order.push('render'); },
    },
  });

  await emitCompletedTurn(harness, 'session-1', 'stream-pw-full-refresh');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(order.includes('refresh'), 'terminal postwork refreshes Electron-owned summaries');
  assert.equal(observabilityOptions.length, 1, 'terminal postwork refreshes usage diagnostics');
  assert.equal(observabilityOptions[0].silent, true);
  assert.equal(observabilityOptions[0].force, true);
  assert.ok(order.includes('render'), 'the refreshed canonical snapshot triggers a full repaint');
  assert.ok(order.indexOf('refresh') < order.indexOf('render'), 'repaint happens after metadata refresh');
});

test('closing terminal postwork recomputes composer state after a mid-postwork render', async (t) => {
  const frames = createQueuedFrameController();
  const composerBusyStates = []; let composerStatusRenders = 0;
  const composerStateLogs = [];
  let harness; const turnClock = { startedAt: Date.now() - 100, endedAt: null };
  let resolveMemoryCapture;
  let markMemoryCaptureStarted;
  const memoryCaptureStarted = new Promise((resolve) => { markMemoryCaptureStarted = resolve; });
  const memoryCapturePending = new Promise((resolve) => { resolveMemoryCapture = resolve; });
  // Dock surface (activeView 'ide' + open dock) so the close-time
  // ide_chat_dock.composer_state instrumentation branch executes too.
  const previousSurfaceLive = globalThis.rendererChatSurfaceLiveUtils;
  globalThis.rendererChatSurfaceLiveUtils = require('../renderer/chat/renderer-chat-surface-live-utils');
  harness = createHarness({
    requestAnimationFrameImpl: frames.requestAnimationFrame,
    cancelAnimationFrameImpl: frames.cancelAnimationFrame,
    stateOverrides: { ui: { activeView: 'ide', ideChatDockOpen: true }, features: { featureFlags: { ide_chat_dock: true } }, turnClockBySession: new Map([['session-1', turnClock]]) },
    callbackOverrides: {
      refreshSessionMetadata: async () => {},
      maybeSuggestMemoryCapture() {
        markMemoryCaptureStarted();
        return memoryCapturePending;
      },
      renderComposerState() {
        composerBusyStates.push(harness.multiStreamController.isSessionSendBusy('session-1'));
      }, renderComposerStatusNotice() { composerStatusRenders += 1; },
      appendClientLog(_level, event) { if (event === 'ide_chat_dock.composer_state') composerStateLogs.push(event); },
    },
  });
  t.after(() => {
    resolveMemoryCapture();
    globalThis.rendererChatSurfaceLiveUtils = previousSurfaceLive;
    harness.restore();
  });

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-composer-latch' });
  const donePromise = harness.emit({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-composer-latch', content: 'done',
  });
  await memoryCaptureStarted;
  assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), true);
  const rendersBeforeMidPostworkDrain = composerBusyStates.length;
  assert.ok(frames.pendingCount() > 0, 'the post-refresh composer render is queued');
  await frames.drainNextFrame();
  assert.ok(composerBusyStates.length > rendersBeforeMidPostworkDrain, 'the queued composer render drains');
  assert.equal(composerBusyStates.at(-1), true, 'the queued render observes postwork send-busy');
  const rendersBeforeClose = composerBusyStates.length;

  resolveMemoryCapture();
  await donePromise;
  await frames.drainNextFrame();

  assert.ok(composerBusyStates.length > rendersBeforeClose, 'composer renders after postwork closes');
  assert.equal(composerBusyStates.at(-1), false, 'the last composer render observes send-busy cleared');
  assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), false); assert.equal(Number.isFinite(turnClock.endedAt), true, 'completed postwork stamps endedAt');
  assert.ok(composerStateLogs.length >= 1, 'close-time instrumentation logged on the dock surface'); assert.ok(composerStatusRenders > 0, 'composerStatus: true still renders composer status');
});

// ---------------------------------------------------------------------------
// CTL-006: each hung postwork dependency releases the busy gate at a deadline
// ---------------------------------------------------------------------------

test('hung terminal hydration (getMessages never resolves): busy releases at a bounded deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const turnClock = { startedAt: Date.now() - 100, endedAt: null }; const { harness, logs } = buildPostworkHarness(t, { getMessages: neverResolves }); harness.state.turnClockBySession = new Map([['session-1', turnClock]]);

  emitCompletedTurn(harness, 'session-1', 'stream-pw-hydration');
  await flushMicrotasks();
  assert.equal(
    harness.multiStreamController.isSessionInTerminalPostwork('session-1'),
    true,
    'precondition: the postwork window is open while hydration is pending'
  );

  t.mock.timers.tick(120_000);
  await flushMicrotasks();

  assert.equal(
    harness.multiStreamController.isSessionInTerminalPostwork('session-1'),
    false,
    'a hung hydration must not hold terminal postwork forever'
  );
  assert.equal(
    harness.multiStreamController.isSessionSendBusy('session-1'),
    false,
    'the send-busy gate is released at the deadline'
  ); assert.equal(Number.isFinite(turnClock.endedAt), true, 'deadline release stamps endedAt');
  assertTimeoutDiagnostic(logs);
});

for (const hungStage of ['refreshSessionMetadata', 'refreshSnapshots', 'refreshObservability', 'maybeSuggestMemoryCapture']) {
  test(`hung ${hungStage}: busy releases at a bounded deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { harness, logs } = buildPostworkHarness(t, {
      callbackOverrides: { [hungStage]: neverResolves },
    });

    emitCompletedTurn(harness, 'session-1', `stream-pw-${hungStage}`);
    await flushMicrotasks();

    t.mock.timers.tick(120_000);
    await flushMicrotasks();

    assert.equal(
      harness.multiStreamController.isSessionInTerminalPostwork('session-1'),
      false,
      `a hung ${hungStage} must not hold terminal postwork forever`
    );
    assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), false);
    assertTimeoutDiagnostic(logs);
  });
}

test('a queued follow-up send still drains after a postwork deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dispatched = [];
  let queued = { prompt: 'queued follow-up' };
  const { harness } = buildPostworkHarness(t, {
    getMessages: neverResolves,
    callbackOverrides: {
      getQueuedSend(sessionId) {
        return String(sessionId || '') === 'session-1' ? queued : null;
      },
      dispatchQueuedSendForSession: async (sessionId) => {
        dispatched.push(sessionId);
        queued = null;
        return { streamId: 'stream-queued' };
      },
    },
  });

  emitCompletedTurn(harness, 'session-1', 'stream-pw-queued');
  await flushMicrotasks();
  assert.deepEqual(dispatched, [], 'the queued send must not dispatch while postwork is pending');

  t.mock.timers.tick(120_000);
  await flushMicrotasks();

  assert.deepEqual(
    dispatched,
    ['session-1'],
    'the queued follow-up drains once the postwork deadline releases the busy gate'
  );
});

// ---------------------------------------------------------------------------
// CTL-013: session deletion invalidates in-flight postwork continuations
// ---------------------------------------------------------------------------

function simulateSessionDelete(harness, sessionId) {
  harness.state.sessions = harness.state.sessions.filter((session) => session.id !== sessionId);
  harness.state.messagesBySession.delete(sessionId);
}

test('delete during terminal hydration: a late getMessages resolution must not repopulate the deleted session', async (t) => {
  let resolveGetMessages;
  const { harness } = buildPostworkHarness(t, {
    getMessages: () => new Promise((resolve) => { resolveGetMessages = resolve; }),
  });

  emitCompletedTurn(harness, 'session-1', 'stream-pw-delete');
  await flushMicrotasks();
  assert.equal(typeof resolveGetMessages, 'function', 'precondition: hydration is in flight');

  simulateSessionDelete(harness, 'session-1');
  const writesAtDelete = harness.calls.setSessionMessages.length;

  resolveGetMessages({
    data: [
      { id: 'user_resurrect', role: 'user', content: 'zombie prompt' },
      { id: 'assistant_resurrect', role: 'assistant', content: 'zombie answer', status: 'complete' },
    ],
  });
  await flushMicrotasks();

  assert.equal(
    harness.state.messagesBySession.has('session-1'),
    false,
    'the deleted session id must not be repopulated by a late hydration'
  );
  const lateWrites = harness.calls.setSessionMessages.slice(writesAtDelete)
    .filter((entry) => entry.sessionId === 'session-1');
  assert.deepEqual(lateWrites, [], 'no setSessionMessages call may land for the deleted session after deletion');
  assert.equal(
    harness.multiStreamController.isSessionInTerminalPostwork('session-1'),
    false,
    'no postwork membership is left behind for the deleted session'
  );
});

test('delete during error-path postwork: a late hydration must not repopulate the deleted session', async (t) => {
  let resolveGetMessages;
  const { harness } = buildPostworkHarness(t, {
    getMessages: () => new Promise((resolve) => { resolveGetMessages = resolve; }),
  });

  const emitPromise = (async () => {
    await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-pw-err' });
    await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-pw-err', content: 'partial' });
    await harness.emit({ type: 'error', sessionId: 'session-1', streamId: 'stream-pw-err', message: 'stream failed' });
  })();
  emitPromise.catch(() => {});
  await flushMicrotasks();
  assert.equal(typeof resolveGetMessages, 'function', 'precondition: error-path hydration is in flight');

  simulateSessionDelete(harness, 'session-1');
  const writesAtDelete = harness.calls.setSessionMessages.length;

  resolveGetMessages({
    data: [{ id: 'assistant_zombie', role: 'assistant', content: 'zombie', status: 'error' }],
  });
  await flushMicrotasks();

  assert.equal(harness.state.messagesBySession.has('session-1'), false);
  const lateWrites = harness.calls.setSessionMessages.slice(writesAtDelete)
    .filter((entry) => entry.sessionId === 'session-1');
  assert.deepEqual(lateWrites, [], 'error-path postwork must respect deletion too');
});

// Green pin: normal postwork (everything resolves promptly) still completes,
// clears the busy window, and dispatches nothing it should not.
test('healthy postwork completes, clears the busy window, and repopulates nothing after it ends', async (t) => {
  const { harness } = buildPostworkHarness(t, {
    getMessages: async () => ({ data: [] }),
  });

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-pw-ok' });
  await harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-pw-ok', content: 'done' });
  await flushMicrotasks();

  assert.equal(harness.multiStreamController.isSessionInTerminalPostwork('session-1'), false);
  assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), false);
  const message = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-pw-ok');
  assert.equal(message.status, 'complete');
});

// ---------------------------------------------------------------------------
// Code-review pins (2026-07-10)
// ---------------------------------------------------------------------------

// Hydration always degraded to the local fallback on FAILURE (pre-CTL-006
// `.catch(() => null)`); the deadline racer re-throws real rejections, so the
// hydration stage must swallow them itself — otherwise a transient getMessages
// rejection skips the settle/toast/refresh chain wholesale.
test('a getMessages REJECTION degrades to local state: error toast still fires, postwork completes', async (t) => {
  const { harness, logs } = buildPostworkHarness(t, {
    getMessages: async () => { throw new Error('EIPC transient failure'); },
  });

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-hydr-reject' });
  await harness.emit({
    type: 'error', sessionId: 'session-1', streamId: 'stream-hydr-reject', message: 'engine crashed',
  });

  assert.equal(
    harness.calls.toasts.some((toast) => toast.options?.title === 'Streaming Error'),
    true,
    'the Streaming Error toast must survive a hydration rejection'
  );
  assert.ok(
    logs.some((entry) => entry.event === 'stream.terminal_hydration_failed'),
    'the rejection is diagnosed as a hydration failure'
  );
  assert.equal(
    logs.some((entry) => entry.event === 'stream.terminal_postwork_failed'),
    false,
    'the rejection must be absorbed at the hydration stage, not escape to the outer postwork catch'
  );
  const settled = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-hydr-reject');
  assert.equal(settled.status, 'error', 'the bubble still settles from local state');
});

// A late terminal for a PREEMPTED stream must not open a postwork window: the
// per-session generation counter would supersede (abort) the LIVE turn's
// in-flight postwork on the same session — the stale preempt terminal would
// beat the real turn.
test('a late preempt terminal does not supersede the live turn\'s in-flight postwork', async (t) => {
  let resolveHydration = null;
  let hydrationCalls = 0;
  const { harness, logs } = buildPostworkHarness(t, {
    getMessages: () => {
      hydrationCalls += 1;
      return new Promise((resolve) => {
        resolveHydration = () => resolve({
          data: [{
            id: 'assistant_stream-live',
            role: 'assistant',
            status: 'complete',
            content: 'hydrated-after-late-terminal',
            streamId: 'stream-live',
          }],
        });
      });
    },
  });

  // Preempted stream A: finalized with no terminal settle, partial bubble stays.
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-preempted' });
  await harness.emit({
    type: 'delta', sessionId: 'session-1', streamId: 'stream-preempted', content: 'partial', aggregate: 'partial',
  });
  harness.multiStreamController.clearStream('stream-preempted');

  // Live stream B: complete enters postwork and blocks on the deferred hydration.
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-live' });
  const livePromise = harness.emit({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-live', content: 'live answer',
  });
  await flushMicrotasks();
  assert.equal(hydrationCalls, 1, 'the live turn is mid-hydration');

  // The provider's one genuine late error for A arrives DURING B's postwork.
  await harness.emit({
    type: 'error', sessionId: 'session-1', streamId: 'stream-preempted', message: 'late provider failure',
  });
  const preempted = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-preempted');
  assert.equal(preempted.status, 'error', 'the late terminal still settles the preempted partial');

  resolveHydration();
  await livePromise;
  await flushMicrotasks();

  assert.equal(
    logs.some((entry) => entry.event === 'stream.terminal_postwork_stale_continuation'),
    false,
    'the live turn\'s postwork must not be superseded by the late preempt terminal'
  );
  const hydrated = harness.state.messagesBySession.get('session-1')
    .some((entry) => String(entry.content || '') === 'hydrated-after-late-terminal');
  assert.equal(hydrated, true, 'the live turn\'s hydrated settle still lands');
});

// ---------------------------------------------------------------------------
// L1 diagnostics (Chat Lifecycle v2 plan §4): lifecycle.stale_continuation_drop
// — a module-internal counter inside createTerminalPostworkUtils that fires an
// INFO structured event every time isPostworkContinuationValid rejects a
// continuation (CTL-013's gate). Unit-tested directly against the factory
// (rather than through the full stream-handler harness) so both rejection
// reasons — dead_session and stale_generation — are cheaply reachable without
// staging a real hung-dependency race.
// ---------------------------------------------------------------------------

test('lifecycle.stale_continuation_drop: a dead-session gate emits an INFO event with a running count', () => {
  const logs = [];
  const state = { sessions: [], messagesBySession: new Map() };
  const postworkUtils = createTerminalPostworkUtils({
    state,
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
  });

  const firstValid = postworkUtils.isPostworkContinuationValid('session-dead', 'token-1');
  const secondValid = postworkUtils.isPostworkContinuationValid('session-dead', 'token-1');

  assert.equal(firstValid, false);
  assert.equal(secondValid, false);
  const events = logs.filter((entry) => entry.event === 'lifecycle.stale_continuation_drop');
  assert.equal(events.length, 2, 'one event per rejected continuation');
  assert.equal(events[0].level, 'INFO');
  assert.equal(events[0].details.reason, 'dead_session');
  assert.equal(events[0].details.sessionId, 'session-dead');
  assert.equal(events[0].details.count, 1);
  assert.equal(events[1].details.count, 2, 'the counter is monotonic across calls on this controller');
});

test('lifecycle.stale_continuation_drop: a stale-generation gate reports that reason and bounds sessionId to 30 chars', () => {
  const logs = [];
  const longSessionId = 'session-'.padEnd(40, 'x');
  const state = {
    sessions: [{ id: longSessionId }],
    messagesBySession: new Map([[longSessionId, []]]),
  };
  const postworkUtils = createTerminalPostworkUtils({
    state,
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
    isTerminalPostworkGenerationCurrent: () => false,
  });

  const valid = postworkUtils.isPostworkContinuationValid(longSessionId, 'token-1');

  assert.equal(valid, false, 'precondition: the session is alive but the generation token is stale');
  const event = logs.find((entry) => entry.event === 'lifecycle.stale_continuation_drop');
  assert.ok(event, 'the stale-generation gate emits the same structured event as the dead-session gate');
  assert.equal(event.details.reason, 'stale_generation');
  assert.equal(event.details.sessionId.length, 30, 'sessionId is bounded to 30 chars, matching the existing DEBUG log convention');
});

test('lifecycle.stale_continuation_drop: a valid continuation emits nothing', () => {
  const logs = [];
  const state = { sessions: [{ id: 'session-1' }], messagesBySession: new Map() };
  const postworkUtils = createTerminalPostworkUtils({
    state,
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
  });

  const valid = postworkUtils.isPostworkContinuationValid('session-1', 'token-1');

  assert.equal(valid, true);
  assert.equal(logs.some((entry) => entry.event === 'lifecycle.stale_continuation_drop'), false);
});

test('lifecycle.stale_continuation_drop: emission is best-effort and never throws out of isPostworkContinuationValid', () => {
  const state = { sessions: [], messagesBySession: new Map() };
  const postworkUtils = createTerminalPostworkUtils({
    state,
    appendClientLog: () => { throw new Error('log sink down'); },
  });

  let valid;
  assert.doesNotThrow(() => {
    valid = postworkUtils.isPostworkContinuationValid('session-x', 'token-1');
  });
  assert.equal(valid, false, 'the gate result itself is unaffected by a throwing log sink');
});

test('deadline aborts the stage signal and rejects guarded mutations after timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = {
    sessions: [{ id: 'session-1' }],
    messagesBySession: new Map([['session-1', []]]),
  };
  const utils = createTerminalPostworkUtils({
    state,
    isTerminalPostworkGenerationCurrent: () => true,
  });
  let stageSignal = null;
  let stageGuard = null;
  const stage = utils.runDeadlineStage(
    'late-stage', 'session-1', 'stream-1',
    ({ signal, guard }) => {
      stageSignal = signal;
      stageGuard = guard;
      return neverResolves();
    },
    50,
    { postworkToken: 1 }
  );

  await flushMicrotasks();
  assert.equal(stageSignal.aborted, false);
  t.mock.timers.tick(50);
  const result = await stage;

  assert.equal(result.timedOut, true);
  assert.equal(stageSignal.aborted, true);
  let mutated = false;
  assert.equal(stageGuard.mutate(() => { mutated = true; }), false);
  assert.equal(mutated, false);
});

test('question guardrail postwork cannot mutate after a newer stream generation starts', async (t) => {
  let resolvePersist;
  const calls = { notices: [], answer: 0 };
  const { harness } = buildPostworkHarness(t, {
    callbackOverrides: {
      persistInteractiveFallbackRequest: () => new Promise((resolve) => { resolvePersist = resolve; }),
      setComposerStatusNotice(message) { calls.notices.push(String(message || '')); },
      requestInteractiveGuardrailAnswer: async () => { calls.answer += 1; },
    },
  });

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-question-old' });
  const oldTerminal = harness.emit({
    type: 'question_batch', sessionId: 'session-1', streamId: 'stream-question-old',
    batch: {
      batch_id: 'batch-old', round_index: 4, intro_text: 'Old questions',
      questions: [{ id: 'q1', prompt: 'Old?', options: [{ id: 'yes', label: 'Yes' }] }],
    },
  });
  await flushMicrotasks();
  assert.equal(typeof resolvePersist, 'function');

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-question-new' });
  const noticesBeforeOldResume = calls.notices.length;
  resolvePersist();
  await oldTerminal;

  assert.equal(calls.notices.length, noticesBeforeOldResume, 'the old guardrail cannot replace the new turn composer state');
  assert.equal(calls.answer, 0, 'the old guardrail cannot launch a fallback answer');
});

// GUI finding 2026-07-20: an intentional Stop settled with a red sticky
// "Streaming Error" toast + failure styling. User-intent terminals must
// settle calmly — the timeline card (calm treatment) is the only surface.
test('a user-cancelled stream settles calmly: no Streaming Error toast, classification preserved', async (t) => {
  const { harness } = buildPostworkHarness(t, {
    getMessages: async () => ({ data: [] }),
  });

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-cancel' });
  await harness.emit({
    type: 'error', sessionId: 'session-1', streamId: 'stream-cancel',
    message: 'Stream cancelled.', status: 'cancelled', terminal_subcode: 'user_stop',
    error_code: 'CMP-SIDECAR-0002', category: 'cancelled',
  });
  await flushMicrotasks();

  assert.equal(
    harness.calls.toasts.some((toast) => toast.options?.title === 'Streaming Error'),
    false,
    'an intentional stop must not raise the danger toast'
  );
  const settled = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-cancel');
  assert.equal(settled.status, 'error', 'retry affordances still key off the coarse error status');
  assert.equal(settled.terminal_status, 'cancelled');
});
