'use strict';

// Dogfood HB-026: a plan-approved turn ("Build it") continues the build inside
// the same chat.send, and the sidecar gives that build leg a fresh working-time
// budget (sidecar/runtime/request_dispatch_chat.py _fresh_build_budget) on top
// of crediting every approval wait (_credit_approval_wait). Electron's chat.send
// transport timer and the stream watchdog's absolute backstop were armed once
// at send time, so the client timed out first (3,661,000ms from the ORIGINAL
// send), surfaced "Sidecar connection issue / restart the sidecar", and never
// told the sidecar to stop -- the orphaned generation kept the GPU busy and
// the session was left quarantined with a held follow-up.

const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SidecarClient } = require('../services/backend/sidecar-client');
const { buildManagedSidecarChatSendOptions } = require('../services/backend/electron-tool-bridge');
const { createChatStreamWatchdog } = require('../services/backend/managed-sidecar-chat-helpers');
const { buildTerminalErrorPayload } = require('../services/backend/chat-stream-terminal-utils');
const { buildAssistantErrorRecoveryMetadata } = require('../services/backend/chat-error-recovery');

const WALL_SECONDS = 3_600;
const WALL_MS = WALL_SECONDS * 1_000;
// managed-sidecar-chat.js: watchdog absolute cap (wall + 60s) + 1s settle grace.
const TRANSPORT_TIMEOUT_MS = WALL_MS + 61_000;

function createMockProcess(frames) {
  const stdout = new Readable({ read() {} });
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      frames.push(String(chunk));
      cb();
    },
  });
  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stdin = stdin;
  return proc;
}

function flush() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

// Fake setTimeout/clearTimeout/Date.now; advanceTo() fires every due timer
// (including ones armed by a firing handler), then flushes real microtasks.
function installFakeClock(t) {
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
  t.after(() => {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    Date.now = realDateNow;
  });
  return {
    async advanceTo(target) {
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
      await flush();
    },
  };
}

function startChatSend({ frames = [], batch4 = true } = {}) {
  const client = new SidecarClient();
  client.attachProcess(createMockProcess(frames));
  client._setSidecarFeatureFlags({ multiplexer: batch4, chat_cancel: batch4 });
  const outcome = { rejected: false, error: null };
  client.chatSend(
    { request_id: 'stream_hb026', session_id: 'sess_hb026', trace_id: 'trace_hb026' },
    { timeoutMs: TRANSPORT_TIMEOUT_MS }
  ).catch((error) => {
    outcome.rejected = true;
    outcome.error = error;
  });
  return { client, outcome, frames };
}

// A managed chat.send's option set wired to the real client and the real
// watchdog; the approval waiter resolves when the test calls answer().
function buildManagedTurn(client) {
  const watchdogTimeouts = [];
  const watchdog = createChatStreamWatchdog({
    isAborted: () => false,
    onTimeout: (message) => watchdogTimeouts.push({ at: Date.now(), message }),
    localMaxLoopWallSeconds: WALL_SECONDS,
  });
  watchdog.armAbsolute();
  let answer;
  const options = buildManagedSidecarChatSendOptions({
    service: {
      sidecarClient: client,
      sessionExecutionAuthority: { requireCurrent() {}, noteApproved() {} },
    },
    controller: new AbortController(),
    streamId: 'stream_hb026',
    resolvedSessionId: 'sess_hb026',
    requestId: 'stream_hb026',
    requestTraceId: 'trace_hb026',
    runtime: { handleNotification() {} },
    toolContext: {},
    handleToolNotification() {},
    waitForToolApproval: () => new Promise((resolve) => { answer = resolve; }),
    turnEventCollector: { turnId: 'stream_hb026' },
    normalizedPreferences: {},
    timeoutMs: TRANSPORT_TIMEOUT_MS,
    noteStreamActivity: watchdog.noteActivity,
    pauseStreamIdleTimer: watchdog.pauseForApproval,
  });
  const absoluteTimeouts = () => watchdogTimeouts.filter((entry) => /absolute cap/.test(entry.message));
  return { options, answer: (result) => answer(result), absoluteTimeouts };
}

test('RED-FIRST: a plan-build approval gives the transport and watchdog the sidecar\'s fresh build budget', async (t) => {
  const clock = installFakeClock(t);
  const { client, outcome } = startChatSend();
  const turn = buildManagedTurn(client);

  // The incident: ~23.5 min of planning, a 24 s plan card, then "Build it, auto mode".
  const cardShownAt = 1_407_000;
  const approvedAt = cardShownAt + 24_000;
  await clock.advanceTo(cardShownAt);
  const approval = turn.options.onApprovalRequest({ tool_name: 'exit_plan_mode', tool_call_id: 'call_plan' });
  await clock.advanceTo(approvedAt);
  turn.answer({ approved: true, decision: 'approved_auto' });
  await approval;

  // Sidecar build-leg deadline: _fresh_build_budget = approval + full wall budget.
  const sidecarBuildDeadline = approvedAt + WALL_MS;

  // Without the fix the transport fired here (original send + 3,661,000ms,
  // even with the 24 s wait credited) while the sidecar kept building.
  await clock.advanceTo(TRANSPORT_TIMEOUT_MS + 24_000 + 1);
  assert.equal(outcome.rejected, false, 'transport must not time out before the sidecar build deadline');
  assert.deepEqual(turn.absoluteTimeouts(), [], 'watchdog backstop must not fire before the sidecar build deadline');

  // The sidecar's own clean turn_deadline gets the whole settlement margin.
  await clock.advanceTo(sidecarBuildDeadline + 59_999);
  assert.equal(outcome.rejected, false);
  assert.deepEqual(turn.absoluteTimeouts(), []);

  // Backstops still exist: watchdog at build deadline + 60s, transport 1s later.
  await clock.advanceTo(sidecarBuildDeadline + 60_000);
  assert.equal(turn.absoluteTimeouts().length, 1);
  assert.equal(outcome.rejected, false);
  await clock.advanceTo(sidecarBuildDeadline + 61_000);
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.error.category, 'timeout');
});

test('a non-plan approval wait is credited to the transport deadline, with no fresh budget', async (t) => {
  const clock = installFakeClock(t);
  const { client, outcome } = startChatSend();
  const turn = buildManagedTurn(client);

  await clock.advanceTo(1_000_000);
  const approval = turn.options.onApprovalRequest({ tool_name: 'write_file', tool_call_id: 'call_write' });
  const waitMs = 30 * 60_000; // the human walks away for half an hour
  await clock.advanceTo(1_000_000 + waitMs);
  turn.answer(true);
  await approval;

  // The sidecar credits the wait (_credit_approval_wait); so must the transport.
  await clock.advanceTo(TRANSPORT_TIMEOUT_MS + waitMs - 1);
  assert.equal(outcome.rejected, false, 'the approval wait must not burn transport time');
  await clock.advanceTo(TRANSPORT_TIMEOUT_MS + waitMs);
  assert.equal(outcome.rejected, true, 'a non-plan approval must not renew the whole budget');
});

test('a denied or plan-only approval does not renew the budget', async (t) => {
  for (const result of [false, { approved: true, decision: 'accepted' }]) {
    const clock = installFakeClock(t);
    const { client, outcome } = startChatSend();
    const turn = buildManagedTurn(client);
    await clock.advanceTo(2_000_000);
    const approval = turn.options.onApprovalRequest({ tool_name: 'exit_plan_mode', tool_call_id: 'call_plan' });
    await clock.advanceTo(2_010_000);
    turn.answer(result);
    await approval;
    await clock.advanceTo(TRANSPORT_TIMEOUT_MS + 10_000);
    assert.equal(outcome.rejected, true, `decision ${JSON.stringify(result)} must not renew the budget`);
  }
});

test('a fresh-budget resume under a nested suspend renews once the outer wait ends and never shortens', async (t) => {
  const clock = installFakeClock(t);
  const { client, outcome } = startChatSend();
  await clock.advanceTo(100_000);
  const resumeOuter = client.suspendRequestTimeout('stream_hb026'); // e.g. an ask_user wait
  const resumeInner = client.suspendRequestTimeout('stream_hb026'); // the plan card
  await clock.advanceTo(200_000);
  resumeInner({ freshBudget: true });
  await clock.advanceTo(TRANSPORT_TIMEOUT_MS + 500_000);
  assert.equal(outcome.rejected, false, 'still suspended by the outer wait');
  resumeOuter();
  await clock.advanceTo(TRANSPORT_TIMEOUT_MS + 500_000 + TRANSPORT_TIMEOUT_MS - 1);
  assert.equal(outcome.rejected, false, 'renewed to the full budget from the final resume');
  await clock.advanceTo(TRANSPORT_TIMEOUT_MS + 500_000 + TRANSPORT_TIMEOUT_MS);
  assert.equal(outcome.rejected, true);
});

test('watchdog: a fresh-budget resume renews the absolute backstop only after every pause ends', async (t) => {
  const clock = installFakeClock(t);
  const fired = [];
  const watchdog = createChatStreamWatchdog({
    isAborted: () => false,
    onTimeout: (message) => { if (/absolute cap/.test(message)) fired.push(Date.now()); },
    localMaxLoopWallSeconds: WALL_SECONDS,
  });
  const cap = watchdog.getCeilings().absoluteTimeoutMs;
  watchdog.armAbsolute();
  await clock.advanceTo(1_000_000);
  const resumeOuter = watchdog.pauseForApproval();
  const resumeInner = watchdog.pauseForApproval();
  resumeInner({ freshBudget: true });
  await clock.advanceTo(1_100_000);
  resumeOuter();
  await clock.advanceTo(1_100_000 + cap - 1);
  assert.deepEqual(fired, []);
  await clock.advanceTo(1_100_000 + cap);
  assert.deepEqual(fired, [1_100_000 + cap]);
});

test('RED-FIRST: a chat.send transport timeout cancels the sidecar turn instead of orphaning it', async (t) => {
  const clock = installFakeClock(t);
  const { client, outcome, frames } = startChatSend();
  await clock.advanceTo(TRANSPORT_TIMEOUT_MS);
  assert.equal(outcome.rejected, true);
  const cancels = frames
    .flatMap((chunk) => chunk.split(/\r?\n/u))
    .filter((line) => line.includes('"chat.cancel"'))
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
  assert.equal(cancels.length, 1, 'exactly one best-effort chat.cancel must reach the sidecar');
  assert.deepEqual(
    {
      request_id: cancels[0].params.request_id,
      trace_id: cancels[0].params.trace_id,
      session_id: cancels[0].params.session_id,
      cancel_reason: cancels[0].params.cancel_reason,
    },
    { request_id: 'stream_hb026', trace_id: 'trace_hb026', session_id: 'sess_hb026', cancel_reason: 'timeout' }
  );
  // Late reverse requests for the dead turn are refused, as after a user cancel.
  assert.equal(client._isCancelledRequestKey('stream_hb026'), true);
});

test('a transport timeout without the chat.cancel transport sends no cancel frame', async (t) => {
  const clock = installFakeClock(t);
  const { outcome, frames } = startChatSend({ batch4: false });
  await clock.advanceTo(TRANSPORT_TIMEOUT_MS);
  assert.equal(outcome.rejected, true);
  assert.equal(frames.some((chunk) => chunk.includes('"chat.cancel"')), false);
});

test('RED-FIRST: chat.send working-time exhaustion reads as the working-time limit, not a sidecar connection issue', async (t) => {
  const clock = installFakeClock(t);
  const { outcome } = startChatSend();
  await clock.advanceTo(TRANSPORT_TIMEOUT_MS);
  const metadata = buildAssistantErrorRecoveryMetadata(buildTerminalErrorPayload(outcome.error, 'timeout'));
  assert.equal(metadata.recovery_class, 'turn_deadline');
  assert.equal(metadata.recovery_title, 'Turn working-time limit reached');
  assert.doesNotMatch(metadata.recovery_hint, /restart/i);
  assert.equal(metadata.recovery_actions.some((action) => action.id === 'restart_sidecar'), false);
});

test('other sidecar request timeouts keep the sidecar-transport recovery copy', async (t) => {
  const clock = installFakeClock(t);
  const client = new SidecarClient();
  client.attachProcess(createMockProcess([]));
  let error = null;
  client.request('models.list', {}).catch((failure) => { error = failure; });
  await clock.advanceTo(10_000);
  assert.ok(error, 'models.list must time out');
  assert.equal(error.terminal_subcode, undefined);
  const metadata = buildAssistantErrorRecoveryMetadata(buildTerminalErrorPayload(error, 'timeout'));
  assert.equal(metadata.recovery_class, 'sidecar_transport');
});
