'use strict';

// Ceiling-invariant coverage for the ask_user human-wait / chat.send transport
// deadline interaction (CLAUDE.md defect: Electron's chat.send RPC timeout was
// a fixed setTimeout armed at send time, so a human who took longer than the
// ~61s settlement margin to answer an ask_user question converted the
// sidecar's legitimate credited-deadline extension
// (sidecar/ai/routing/tool_execution_ask_user_wait.py) into a hard transport
// abort + forced sidecar restart. The fix: SidecarClient#suspendRequestTimeout
// pauses/resumes the pending chat.send request's timer, driven from
// ask-user-tool.js's wait create/settle points (streamId doubles as the
// chat.send request_id / requestKey — see session-turn-actor.js, which mints
// `turnId: streamId, streamId` from the same value).

const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SidecarClient } = require('../services/backend/sidecar-client');
const tool = require('../services/tools/builtin/ask-user-tool');
const {
  answerUserQuestions,
  declineUserQuestions,
  handleChatStreamEnd,
} = require('../services/backend/backend-chat-stream');

function createMockProcess() {
  const stdout = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stdin = stdin;
  return proc;
}

// A controllable fake clock: setTimeout/clearTimeout record {fn, delay,
// scheduledAt}; advanceTo(target) fires every unfired, uncleared handle whose
// (scheduledAt + delay) <= target, repeatedly (so a handler that itself arms
// a new timer that is already due also fires within the same advance).
function installFakeClock() {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realDateNow = Date.now;
  const scheduled = [];
  let now = 0;
  global.setTimeout = (fn, delay) => {
    const handle = { fn, delay, scheduledAt: now, cleared: false, fired: false, unref() {} };
    scheduled.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (handle) handle.cleared = true;
  };
  Date.now = () => now;
  // Fires every due timer synchronously, then returns a real-microtask flush
  // so a rejected pending request's .catch() handler (always a later
  // microtask, never synchronous) has actually run by the time the caller's
  // `await` resolves.
  function advanceTo(target) {
    now = target;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const handle of scheduled) {
        if (!handle.cleared && !handle.fired && handle.scheduledAt + handle.delay <= now) {
          handle.fired = true;
          progressed = true;
          handle.fn();
        }
      }
    }
    return flush();
  }
  function restore() {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    Date.now = realDateNow;
  }
  return { advanceTo, restore, setNow: (value) => { now = value; } };
}

// A timer callback that rejects a promise notifies its .catch() handler on a
// later microtask, not synchronously -- flush() (a real, unmocked setImmediate
// round trip) must run before any assertion on a promise's settled state.
function flush() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function buildAskUserContext({ sidecarClient, streamId = 'stream_1', sessionId = 'session_1', callId = 'call_1' }) {
  const events = [];
  const backendService = {
    currentModel: 'test-model',
    pendingUserQuestions: new Map(),
    sidecarClient,
    emit(name, payload) {
      events.push({ name, payload });
    },
  };
  return {
    context: { sessionId, streamId, callId, backendService },
    backendService,
    events,
  };
}

test('RED-FIRST: chat.send transport deadline is extended by exactly an ask_user human wait', async () => {
  const clock = installFakeClock();
  try {
    const client = new SidecarClient();
    const proc = createMockProcess();
    client.attachProcess(proc);

    const T = 100_000;
    const rejected = { value: false, error: null };
    const chatSendPromise = client.chatSend(
      { request_id: 'stream_1', session_id: 'session_1' },
      { timeoutMs: T }
    );
    chatSendPromise.catch((error) => {
      rejected.value = true;
      rejected.error = error;
    });

    // Ask_user opens the wait at t=90_000 -- 10s of the original T=100_000
    // budget still remaining -- and the human takes W=70_000ms to answer,
    // comfortably past the ~61s settlement margin the defect report cites.
    clock.setNow(90_000);
    const { context, backendService } = buildAskUserContext({ sidecarClient: client });
    const pendingResult = tool.execute({
      questions: [{ id: 'choice', prompt: 'Which direction?', options: ['A', 'B'] }],
    }, context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(backendService.pendingUserQuestions.size, 1, 'ask_user must register its waiter');

    const W = 70_000;
    await clock.advanceTo(90_000 + W); // 160_000: well past the original T=100_000 deadline

    // Without the fix, the chat.send timer fired at the raw T=100_000 mark
    // and this assertion fails here: the RPC already timed out mid-wait.
    assert.equal(rejected.value, false,
      'the chat.send RPC must not time out while a human is still answering');

    const [questionRef] = backendService.pendingUserQuestions.keys();
    assert.equal(answerUserQuestions(backendService, questionRef, {
      answers: [{ id: 'choice', value: 'A' }],
    }), true);
    await pendingResult;

    // Net effect: transport deadline extended by exactly the wait duration.
    // Remaining budget at suspend = T - 90_000 = 10_000; resumed at 160_000,
    // so the timer should now be due at 170_000 == T + W.
    await clock.advanceTo(90_000 + W + 10_000 - 1); // 169_999
    assert.equal(rejected.value, false, 'must not fire even 1ms before T+W');

    await clock.advanceTo(90_000 + W + 10_000 + 1); // 170_001
    assert.equal(rejected.value, true, 'must fire once the extended (T+W) deadline elapses');
    assert.match(String(rejected.error?.message || ''), /timed out/i);
  } finally {
    clock.restore();
  }
});

test('two sequential ask_user waits in one turn each extend the transport deadline', async () => {
  const clock = installFakeClock();
  try {
    const client = new SidecarClient();
    const proc = createMockProcess();
    client.attachProcess(proc);

    const T = 50_000;
    const rejected = { value: false };
    client.chatSend(
      { request_id: 'stream_seq', session_id: 'session_1' },
      { timeoutMs: T }
    ).catch(() => { rejected.value = true; });

    // First ask_user wait: opens at t=10_000, human takes 40_000ms.
    clock.setNow(10_000);
    const first = buildAskUserContext({ sidecarClient: client, streamId: 'stream_seq' });
    const firstPending = tool.execute({
      questions: [{ id: 'q1', prompt: 'First?' }],
    }, first.context);
    await new Promise((resolve) => setImmediate(resolve));
    await clock.advanceTo(50_000); // already past the raw T=50_000 deadline
    assert.equal(rejected.value, false, 'first wait must extend past the raw deadline');
    const [ref1] = first.backendService.pendingUserQuestions.keys();
    assert.equal(answerUserQuestions(first.backendService, ref1, { answers: [] }), true);
    await firstPending;
    // Remaining at first suspend = T - 10_000 = 40_000; resumes at 50_000, due
    // at 90_000 unless extended again.

    // Second ask_user wait: opens at t=60_000 (10_000ms after the first
    // resumed), human takes 50_000ms -- past the would-be 90_000 deadline.
    clock.setNow(60_000);
    const second = buildAskUserContext({ sidecarClient: client, streamId: 'stream_seq' });
    const secondPending = tool.execute({
      questions: [{ id: 'q2', prompt: 'Second?' }],
    }, second.context);
    await new Promise((resolve) => setImmediate(resolve));
    await clock.advanceTo(110_000); // past the un-extended 90_000 deadline
    assert.equal(rejected.value, false, 'second wait must also extend the deadline');
    const [ref2] = second.backendService.pendingUserQuestions.keys();
    assert.equal(answerUserQuestions(second.backendService, ref2, { answers: [] }), true);
    await secondPending;

    // Remaining at second suspend = 40_000 - (60_000 - 50_000) = 30_000;
    // resumes at 110_000, due at 140_000.
    await clock.advanceTo(139_999);
    assert.equal(rejected.value, false);
    await clock.advanceTo(140_001);
    assert.equal(rejected.value, true);
  } finally {
    clock.restore();
  }
});

test('a plain (non-ask_user) RPC times out on its unmodified schedule', async () => {
  const clock = installFakeClock();
  try {
    const client = new SidecarClient();
    const proc = createMockProcess();
    client.attachProcess(proc);

    const rejected = { value: false, error: null };
    client.request('memory.recall', { query: 'style' }, { timeoutMs: 5_000 })
      .catch((error) => { rejected.value = true; rejected.error = error; });

    await clock.advanceTo(4_999);
    assert.equal(rejected.value, false);
    await clock.advanceTo(5_001);
    assert.equal(rejected.value, true);
    assert.match(String(rejected.error?.message || ''), /timed out after 5000ms/);
  } finally {
    clock.restore();
  }
});

test('suspendRequestTimeout on an unrelated or unknown key is a safe no-op', async () => {
  const clock = installFakeClock();
  try {
    const client = new SidecarClient();
    const proc = createMockProcess();
    client.attachProcess(proc);

    const rejected = { value: false };
    client.chatSend({ request_id: 'stream_real', session_id: 's1' }, { timeoutMs: 10_000 })
      .catch(() => { rejected.value = true; });

    const resume = client.suspendRequestTimeout('stream_does_not_exist');
    assert.equal(typeof resume, 'function');
    resume(); // must not throw, must not touch the unrelated pending request

    await clock.advanceTo(9_999);
    assert.equal(rejected.value, false);
    await clock.advanceTo(10_001);
    assert.equal(rejected.value, true, 'the unrelated pending request must still time out normally');
  } finally {
    clock.restore();
  }
});

test('decline settles the wait and restores the timer (never left permanently suspended)', async () => {
  const clock = installFakeClock();
  try {
    const client = new SidecarClient();
    const proc = createMockProcess();
    client.attachProcess(proc);

    const T = 20_000;
    const rejected = { value: false };
    client.chatSend({ request_id: 'stream_decline', session_id: 's1' }, { timeoutMs: T })
      .catch(() => { rejected.value = true; });

    clock.setNow(5_000);
    const { context, backendService } = buildAskUserContext({ sidecarClient: client, streamId: 'stream_decline' });
    const pendingResult = tool.execute({ questions: [{ id: 'q', prompt: 'Choose?' }] }, context);
    await new Promise((resolve) => setImmediate(resolve));

    const W = 30_000;
    await clock.advanceTo(5_000 + W); // 35_000, past the raw T=20_000
    assert.equal(rejected.value, false);

    const [questionRef] = backendService.pendingUserQuestions.keys();
    assert.equal(declineUserQuestions(backendService, questionRef), true);
    const result = await pendingResult;
    assert.equal(result.metadata.result_kind, 'user_questions_declined');

    // Remaining at suspend = 20_000 - 5_000 = 15_000; resumes at 35_000, due
    // at 50_000. The timer must actually fire there (not stay parked forever).
    await clock.advanceTo(49_999);
    assert.equal(rejected.value, false);
    await clock.advanceTo(50_001);
    assert.equal(rejected.value, true, 'the timer must be restored, not permanently suspended');
  } finally {
    clock.restore();
  }
});

test('stream end (handleChatStreamEnd) settles the wait and restores the timer', async () => {
  const clock = installFakeClock();
  try {
    const client = new SidecarClient();
    const proc = createMockProcess();
    client.attachProcess(proc);

    const T = 20_000;
    const rejected = { value: false };
    client.chatSend({ request_id: 'stream_end_case', session_id: 's1' }, { timeoutMs: T })
      .catch(() => { rejected.value = true; });

    clock.setNow(5_000);
    const { context, backendService } = buildAskUserContext({ sidecarClient: client, streamId: 'stream_end_case' });
    const pendingResult = tool.execute({ questions: [{ id: 'q', prompt: 'Choose?' }] }, context);
    await new Promise((resolve) => setImmediate(resolve));

    await clock.advanceTo(35_000); // past the raw T=20_000
    assert.equal(rejected.value, false);

    // The stream ends (e.g. cancelled) while the ask_user wait is still open.
    handleChatStreamEnd(backendService, { type: 'error', streamId: 'stream_end_case' });
    const result = await pendingResult;
    assert.equal(result.metadata.result_kind, 'user_questions_declined');

    // Remaining at suspend = 15_000; resumes at 35_000, due at 50_000.
    await clock.advanceTo(49_999);
    assert.equal(rejected.value, false);
    await clock.advanceTo(50_001);
    assert.equal(rejected.value, true);
  } finally {
    clock.restore();
  }
});
