'use strict';

// Engine-keyed Electron stream ceilings (resolveChatStreamCeilings in
// services/backend/managed-sidecar-chat-helpers.js). These mirror the
// sidecar's cloud loop profile (sidecar/ai/routing/iteration_limits.py):
// cloud frontier engines get a 28,800s turn wall clock and 1,800s silent
// per-tool budget from the sidecar, so the Electron-side idle watchdog and
// absolute backstop must stay strictly WIDER for those engines — otherwise
// Electron hard-aborts (and restarts the sidecar) before the sidecar's own
// graceful wind-down can fire. Local engines keep the original ceilings.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutomaticCompactionSendContext,
  createChatStreamWatchdog,
  resolveChatStreamCeilings,
} = require('../services/backend/managed-sidecar-chat-helpers');
const {
  CHAT_STREAM_IDLE_TIMEOUT_MS,
  MANAGED_LOCAL_MAX_LOOP_WALL_SECONDS,
  isSessionBusy,
  resolveLocalChatStreamIdleTimeoutMs,
} = require('../services/backend/chat-stream-admission');

// Sidecar-side cloud budgets the Electron ceilings must exceed (kept in
// lockstep with cloud_max_loop_wall_seconds / cloud_tools_execution_timeout_
// seconds in sidecar/ai/config_models.py).
const SIDECAR_CLOUD_WALL_MS = 28_800_000;
const SIDECAR_CLOUD_TOOL_TIMEOUT_MS = 1_800_000;
const SIDECAR_LOCAL_WALL_MS = MANAGED_LOCAL_MAX_LOOP_WALL_SECONDS * 1_000;

test('automatic compaction send context is full-session only with frame-fallback rollback', () => {
  const messages = [{ id: 'u1', role: 'user', content: 'old prompt' }];
  const base = {
    contextPreferences: { history_scope: 'session' },
    featureFlags: { context_compaction: true },
    frameOutcome: { historyScopeFallback: null },
    canonicalSessionMessages: messages,
    userMessageId: 'u2',
  };
  const eligible = buildAutomaticCompactionSendContext(base);
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.boundaryMessageId, 'u1');
  assert.equal(eligible.currentUserMessageId, 'u2');
  assert.equal(buildAutomaticCompactionSendContext({
    ...base,
    frameOutcome: { historyScopeFallback: 'recent' },
  }).eligible, false);
  assert.equal(buildAutomaticCompactionSendContext({
    ...base,
    contextPreferences: { history_scope: 'recent' },
  }).eligible, false);
});

test('local and unknown engine types use finite local ceilings', () => {
  for (const engineType of [
    '', undefined, null, 'ollama', 'vllm', 'openai-compatible', 'mock', 'replay', 'anything-else',
  ]) {
    const ceilings = resolveChatStreamCeilings(engineType);
    assert.deepEqual(
      ceilings,
      // 2026-08-30: default local working time is 1800s. Idle caps at the
      // 660s activity ceiling + 60s margin so hang detection stays in minutes;
      // only the absolute backstop scales with the wall budget.
      { idleTimeoutMs: 720_000, absoluteTimeoutMs: 1_860_000 },
      `engineType=${String(engineType)}`
    );
  }
});

test('local ceilings follow the configured working-time limit', () => {
  assert.deepEqual(
    resolveChatStreamCeilings('ollama', 600),
    { idleTimeoutMs: 660_000, absoluteTimeoutMs: 1_800_000 }
  );
  assert.deepEqual(
    resolveChatStreamCeilings('ollama', 1_800),
    // 2026-08-30: idle capped at the 660s activity ceiling + 60s margin.
    { idleTimeoutMs: 720_000, absoluteTimeoutMs: 1_860_000 }
  );
  // Invariant: the idle hang detector always fires before the absolute cap.
  for (const wall of [60, 300, 600, 1_800, 3_600]) {
    const ceilings = resolveChatStreamCeilings('ollama', wall);
    assert.ok(
      ceilings.idleTimeoutMs < ceilings.absoluteTimeoutMs,
      `idle must stay below absolute at wall=${wall}s`
    );
  }
});

test('local idle ceiling outlasts legitimate silence and owns orphan freshness', () => {
  const local = resolveChatStreamCeilings('ollama');
  // 2026-08-30: idle no longer scales with the sidecar wall budget (30+ min);
  // instead it must exceed the longest LEGITIMATE silent stretch — a
  // run_command honoring its 600s + 5s carve-out with no output — while the
  // absolute backstop still outlasts the sidecar's graceful wind-down.
  const MAX_LEGITIMATE_SILENCE_MS = 605_000;
  assert.ok(local.idleTimeoutMs > MAX_LEGITIMATE_SILENCE_MS);
  assert.ok(local.absoluteTimeoutMs > SIDECAR_LOCAL_WALL_MS);
  assert.equal(CHAT_STREAM_IDLE_TIMEOUT_MS, local.idleTimeoutMs);

  const now = Date.parse('2026-08-12T12:00:00.000Z');
  const store = {
    getActiveTurn: () => ({
      stream_id: 'controllerless-stream',
      last_event_at: new Date(now - 180_001).toISOString(),
    }),
  };
  const service = { activeStreams: new Map() };
  assert.equal(isSessionBusy(service, { sessionId: 'session-1', store, now }), true);

  store.getActiveTurn = () => ({
    stream_id: 'controllerless-stream',
    last_event_at: new Date(now - CHAT_STREAM_IDLE_TIMEOUT_MS - 1).toISOString(),
  });
  assert.equal(isSessionBusy(service, { sessionId: 'session-1', store, now }), false);
});

test('controller-less orphan freshness follows the configured working-time limit', () => {
  const now = Date.parse('2026-08-12T12:00:00.000Z');
  const store = {
    getActiveTurn: () => ({
      stream_id: 'controllerless-stream',
      last_event_at: new Date(now - 500_000).toISOString(),
    }),
  };
  const service = {
    activeStreams: new Map(),
    configService: { getState: () => ({ maxLoopWallSeconds: 600 }) },
  };

  assert.equal(resolveLocalChatStreamIdleTimeoutMs(service), 660_000);
  assert.equal(isSessionBusy(service, { sessionId: 'session-1', store, now }), true);
});

test('approval pauses both watchdog clocks without consuming absolute time', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realDateNow = Date.now;
  const scheduled = [];
  let now = 0;
  global.setTimeout = (_callback, delay) => {
    const handle = { delay, cleared: false, unref() {} };
    scheduled.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    handle.cleared = true;
  };
  Date.now = () => now;

  try {
    const watchdog = createChatStreamWatchdog({
      isAborted: () => false,
      onTimeout: () => assert.fail('watchdog must not fire in a fake-timer test'),
      localMaxLoopWallSeconds: 600,
    });
    watchdog.armAbsolute();
    now = 100_000;
    // 2026-08-30: pauseForApproval hands back the only resume (refcounted).
    const resumeAfterApproval = watchdog.pauseForApproval();
    now = 500_000;
    resumeAfterApproval();

    const activeDelays = scheduled
      .filter((handle) => !handle.cleared)
      .map((handle) => handle.delay)
      .sort((a, b) => a - b);
    // 600s wall is inside the 660s idle-activity ceiling, so idle stays
    // 660_000; absolute resumes on banked time.
    assert.deepEqual(activeDelays, [660_000, 1_700_000]);
    watchdog.clear();
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    Date.now = realDateNow;
  }
});

test('a notification during an approval wait does not resume either clock', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realDateNow = Date.now;
  const scheduled = [];
  let now = 0;
  global.setTimeout = (_callback, delay) => {
    const handle = { delay, cleared: false, unref() {} };
    scheduled.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    handle.cleared = true;
  };
  Date.now = () => now;
  const activeDelays = () => scheduled
    .filter((handle) => !handle.cleared)
    .map((handle) => handle.delay)
    .sort((a, b) => a - b);

  try {
    const watchdog = createChatStreamWatchdog({
      isAborted: () => false,
      onTimeout: () => assert.fail('watchdog must not fire in a fake-timer test'),
      localMaxLoopWallSeconds: 600,
    });
    watchdog.armAbsolute();
    now = 100_000;
    // 2026-08-30: pauseForApproval hands back the only resume (refcounted).
    const resumeAfterApproval = watchdog.pauseForApproval();

    // A monitor started earlier in the turn emits while the human is still
    // deciding. Stream activity is NOT the approval resolving, so it must not
    // restart either clock -- doing so let a slow human decision abort the turn.
    now = 500_000;
    watchdog.noteActivity();
    assert.deepEqual(activeDelays(), []);

    // Only the approval resolving resumes, and it resumes on banked time.
    resumeAfterApproval();
    assert.deepEqual(activeDelays(), [660_000, 1_700_000]);
    watchdog.clear();
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    Date.now = realDateNow;
  }
});

test('a nested pause keeps the clocks parked until every wait resumes', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realDateNow = Date.now;
  const scheduled = [];
  let now = 0;
  global.setTimeout = (_callback, delay) => {
    const handle = { delay, cleared: false, unref() {} };
    scheduled.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    handle.cleared = true;
  };
  Date.now = () => now;
  const activeDelays = () => scheduled
    .filter((handle) => !handle.cleared)
    .map((handle) => handle.delay)
    .sort((a, b) => a - b);

  try {
    const watchdog = createChatStreamWatchdog({
      isAborted: () => false,
      onTimeout: () => assert.fail('watchdog must not fire in a fake-timer test'),
      localMaxLoopWallSeconds: 600,
    });
    watchdog.armAbsolute();
    now = 100_000;
    // ask_user parks the clocks; a tool approval then arrives mid-wait.
    const resumeAskUser = watchdog.pauseForApproval();
    const resumeApproval = watchdog.pauseForApproval();

    // The inner approval resolving must NOT restart the clocks while the
    // ask_user wait is still pending, and each resume is idempotent.
    now = 200_000;
    resumeApproval();
    resumeApproval();
    assert.deepEqual(activeDelays(), []);

    now = 500_000;
    resumeAskUser();
    assert.deepEqual(activeDelays(), [660_000, 1_700_000]);
    watchdog.clear();
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    Date.now = realDateNow;
  }
});

test('cloud engine types get widened ceilings', () => {
  for (const engineType of ['chatgpt', 'codex-cli', ' ChatGPT ', 'CODEX-CLI']) {
    const ceilings = resolveChatStreamCeilings(engineType);
    assert.deepEqual(
      ceilings,
      { idleTimeoutMs: 1_860_000, absoluteTimeoutMs: 29_400_000 },
      `engineType=${String(engineType)}`
    );
  }
});

test('cloud ceilings stay strictly wider than the sidecar cloud budgets', () => {
  const cloud = resolveChatStreamCeilings('chatgpt');
  // Absolute backstop must outlast the sidecar's full cloud wall clock, so the
  // sidecar's graceful wall-clock wind-down always fires before Electron's
  // hard abort + restart.
  assert.ok(cloud.absoluteTimeoutMs > SIDECAR_CLOUD_WALL_MS);
  // Idle watchdog must outlast a single fully-silent cloud tool call.
  assert.ok(cloud.idleTimeoutMs > SIDECAR_CLOUD_TOOL_TIMEOUT_MS);
});
