const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTurnEffectProbe,
  isChatgptAuthRejection,
  isDuplicateRequestIdRejection,
  sendManagedChatWithAuthRetry,
} = require('../../services/backend/chatgpt-auth-turn-retry');
const {
  buildManagedSidecarChatSendOptions,
} = require('../../services/backend/electron-tool-bridge');

// M2: a ChatGPT access token that expires mid-session surfaces as a request-time
// 401 (CMP-CLOUD-1003 + classification invalid_api_key) and used to be terminal
// for the turn AND leave the dead token installed in the sidecar. These pin the
// one-shot refresh+reconfigure+retry: it fires ONLY before the turn produced any
// output or tool effect, reuses the SAME request_id, and never runs twice.

const REQUEST_ID = 'turn_stream_1';
const RECONFIGURE_TIMEOUT_MS = 8000;

function authRejection(overrides = {}) {
  const error = new Error('model generation failed: 401 Unauthorized');
  error.rpc = {
    data: {
      category: 'provider',
      classification: 'invalid_api_key',
      provider_code: 'CMP-CLOUD-1003',
      ...overrides,
    },
  };
  return error;
}

function duplicateRequestIdRejection() {
  const error = new Error('duplicate request id');
  error.rpc = { data: { code: 'CMP-PROTO-0002', reason: 'duplicate_request_id' } };
  return error;
}

function createHarness({
  attempts = [],
  engineType = 'chatgpt',
  featureFlags = {},
  runtime = null,
  aborted = false,
  getAccessToken = null,
  refreshManagedConfig = null,
} = {}) {
  const record = {
    chatSendParams: [],
    getAccessTokenCalls: [],
    refreshCalls: [],
    permanentlyExpireCalls: 0,
    logs: [],
  };
  let attemptIndex = 0;
  const service = {
    featureFlags: { chatgpt_auth_turn_retry: true, ...featureFlags },
    sidecarClient: {
      async chatSend(params, options) {
        record.chatSendParams.push(params);
        const outcome = attemptIndex < attempts.length
          ? attempts[attemptIndex]
          : attempts[attempts.length - 1];
        attemptIndex += 1;
        if (typeof outcome === 'function') {
          return outcome(params, options);
        }
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
    },
    chatgptAuthService: {
      async getAccessToken(options) {
        record.getAccessTokenCalls.push(options);
        if (typeof getAccessToken === 'function') {
          return getAccessToken(options);
        }
        return 'fresh-access-token';
      },
      async permanentlyExpireAuth() {
        record.permanentlyExpireCalls += 1;
        return '';
      },
    },
    async refreshManagedConfig(reason, options) {
      record.refreshCalls.push({ reason, options });
      if (typeof refreshManagedConfig === 'function') {
        return refreshManagedConfig(reason, options);
      }
      return { active_engine: 'chatgpt' };
    },
  };
  const probe = createTurnEffectProbe();
  const controller = { signal: { aborted } };
  const send = () => sendManagedChatWithAuthRetry({
    service,
    engineType,
    runtime,
    controller,
    probe,
    params: { request_id: REQUEST_ID, messages: [] },
    options: {},
    log: (level, event, details) => record.logs.push({ level, event, details }),
    ids: { sessionId: 'session_1', streamId: REQUEST_ID, traceId: 'trace_1' },
  });
  return { controller, probe, record, send, service };
}

function loggedEvents(record) {
  return record.logs.map((entry) => entry.event);
}

test('a 401 before any output refreshes once, reconfigures once, and retries the same request_id', async () => {
  const harness = createHarness({
    attempts: [authRejection(), { status: 'completed', attempt: 2 }],
  });

  const result = await harness.send();

  assert.deepEqual(result, { status: 'completed', attempt: 2 });
  assert.equal(harness.record.chatSendParams.length, 2);
  assert.equal(harness.record.chatSendParams[0].request_id, REQUEST_ID);
  assert.equal(
    harness.record.chatSendParams[1].request_id,
    REQUEST_ID,
    'the retry must reuse the turn request_id (lease + notification-routing identity)'
  );
  assert.equal(harness.record.getAccessTokenCalls.length, 1);
  assert.deepEqual(harness.record.getAccessTokenCalls[0], { force: true });
  assert.equal(harness.record.refreshCalls.length, 1);
  assert.equal(harness.record.refreshCalls[0].options.requestedEngineType, 'chatgpt');
  assert.equal(harness.record.refreshCalls[0].options.inactivityTimeoutMs, RECONFIGURE_TIMEOUT_MS);
  assert.equal(harness.record.refreshCalls[0].options.absoluteTimeoutMs, RECONFIGURE_TIMEOUT_MS);
  assert.equal(harness.record.permanentlyExpireCalls, 0);
  assert.ok(loggedEvents(harness.record).includes('chatgpt_auth.turn_retry_started'));
});

const PROBE_EFFECT_CASES = [
  ['a chat.token delta', (probe) => probe.note({ method: 'chat.token', params: { delta: 'hi' } })],
  ['a tool.result', (probe) => probe.note({ method: 'tool.result', params: { tool_call_id: 'c1' } })],
  ['an approval request', (probe) => probe.noteApproval()],
];

for (const [label, applyEffect] of PROBE_EFFECT_CASES) {
  test(`no retry after ${label}`, async () => {
    const original = authRejection();
    let harness;
    harness = createHarness({
      attempts: [
        () => {
          applyEffect(harness.probe);
          throw original;
        },
        { status: 'completed', attempt: 2 },
      ],
    });

    await assert.rejects(harness.send(), (error) => error === original);

    assert.equal(harness.record.chatSendParams.length, 1);
    assert.equal(harness.record.getAccessTokenCalls.length, 0);
    assert.equal(harness.record.refreshCalls.length, 0);
  });
}

const RUNTIME_EFFECT_CASES = [
  ['the runtime reports a visible completion', {
    isVisibleCompletionEmitted: () => true,
    getDiagnosticToolEvents: () => [],
  }],
  ['the runtime recorded a diagnostic tool event', {
    isVisibleCompletionEmitted: () => false,
    getDiagnosticToolEvents: () => [{ tool_name: 'read_file' }],
  }],
];

for (const [label, runtime] of RUNTIME_EFFECT_CASES) {
  test(`no retry after ${label}`, async () => {
    const original = authRejection();
    const harness = createHarness({
      attempts: [original, { status: 'completed', attempt: 2 }],
      runtime,
    });

    await assert.rejects(harness.send(), (error) => error === original);

    assert.equal(harness.record.chatSendParams.length, 1);
    assert.equal(harness.record.getAccessTokenCalls.length, 0);
    assert.equal(harness.record.refreshCalls.length, 0);
  });
}

test('a non-401 provider error carrying the same provider_code is never retried', async () => {
  const original = authRejection({ classification: 'server_error' });
  const harness = createHarness({
    attempts: [original, { status: 'completed', attempt: 2 }],
  });

  await assert.rejects(harness.send(), (error) => error === original);

  assert.equal(harness.record.chatSendParams.length, 1);
  assert.equal(harness.record.getAccessTokenCalls.length, 0);
  assert.equal(harness.record.refreshCalls.length, 0);
});

test('a 401 on a non-chatgpt engine is never retried', async () => {
  const original = authRejection();
  const harness = createHarness({
    attempts: [original, { status: 'completed', attempt: 2 }],
    engineType: 'ollama',
  });

  await assert.rejects(harness.send(), (error) => error === original);

  assert.equal(harness.record.chatSendParams.length, 1);
  assert.equal(harness.record.getAccessTokenCalls.length, 0);
});

test('at most one refresh+retry per turn: a fresh token that still 401s expires the credential', async () => {
  const original = authRejection();
  const retryFailure = authRejection();
  const harness = createHarness({ attempts: [original, retryFailure] });

  await assert.rejects(harness.send(), (error) => error === retryFailure);

  assert.equal(harness.record.chatSendParams.length, 2);
  assert.equal(harness.record.getAccessTokenCalls.length, 1);
  assert.equal(harness.record.refreshCalls.length, 1);
  assert.equal(harness.record.permanentlyExpireCalls, 1);
  assert.ok(loggedEvents(harness.record).includes('chatgpt_auth.turn_retry_token_rejected'));
});

test('a throwing refresh surfaces the ORIGINAL 401 and does not expire the credential', async () => {
  const original = authRejection();
  const harness = createHarness({
    attempts: [original, { status: 'completed', attempt: 2 }],
    getAccessToken: () => {
      throw Object.assign(new Error('refresh failed'), { code: 'refresh_failed' });
    },
  });

  await assert.rejects(harness.send(), (error) => error === original);

  assert.equal(harness.record.chatSendParams.length, 1);
  assert.equal(harness.record.refreshCalls.length, 0);
  assert.equal(harness.record.permanentlyExpireCalls, 0);
  assert.ok(loggedEvents(harness.record).includes('chatgpt_auth.turn_retry_refresh_failed'));
});

test('an empty refreshed token surfaces the ORIGINAL 401 without a second expiry call', async () => {
  const original = authRejection();
  const harness = createHarness({
    attempts: [original, { status: 'completed', attempt: 2 }],
    getAccessToken: () => '',
  });

  await assert.rejects(harness.send(), (error) => error === original);

  assert.equal(harness.record.chatSendParams.length, 1);
  assert.equal(harness.record.refreshCalls.length, 0);
  // permanentlyExpireAuth already ran INSIDE the auth service on this path.
  assert.equal(harness.record.permanentlyExpireCalls, 0);
  assert.ok(loggedEvents(harness.record).includes('chatgpt_auth.turn_retry_refresh_failed'));
});

test('a failed reconfiguration surfaces the ORIGINAL 401', async () => {
  const original = authRejection();
  const harness = createHarness({
    attempts: [original, { status: 'completed', attempt: 2 }],
    refreshManagedConfig: () => {
      throw new Error('managed initialize timed out');
    },
  });

  await assert.rejects(harness.send(), (error) => error === original);

  assert.equal(harness.record.chatSendParams.length, 1);
  assert.equal(harness.record.getAccessTokenCalls.length, 1);
  assert.equal(harness.record.refreshCalls.length, 1);
  assert.equal(harness.record.permanentlyExpireCalls, 0);
  assert.ok(loggedEvents(harness.record).includes('chatgpt_auth.turn_retry_reconfigure_failed'));
});

test('a duplicate-request-id rejection on the retry surfaces the ORIGINAL 401', async () => {
  const original = authRejection();
  const harness = createHarness({ attempts: [original, duplicateRequestIdRejection()] });

  await assert.rejects(harness.send(), (error) => error === original);

  assert.equal(harness.record.chatSendParams.length, 2);
  assert.equal(harness.record.permanentlyExpireCalls, 0);
});

test('an aborted controller suppresses the retry', async () => {
  const original = authRejection();
  const harness = createHarness({
    attempts: [original, { status: 'completed', attempt: 2 }],
    aborted: true,
  });

  await assert.rejects(harness.send(), (error) => error === original);

  assert.equal(harness.record.chatSendParams.length, 1);
  assert.equal(harness.record.getAccessTokenCalls.length, 0);
});

test('the feature flag off short-circuits to a bare chatSend', async () => {
  const original = authRejection();
  const harness = createHarness({
    attempts: [original, { status: 'completed', attempt: 2 }],
    featureFlags: { chatgpt_auth_turn_retry: false },
  });

  await assert.rejects(harness.send(), (error) => error === original);

  assert.equal(harness.record.chatSendParams.length, 1);
  assert.equal(harness.record.getAccessTokenCalls.length, 0);
  assert.equal(harness.record.logs.length, 0);
});

test('the turn effect probe recognizes every output/tool/approval signal', () => {
  const effectful = [
    { method: 'chat.token', params: { delta: 'a' } },
    { method: 'turn.event', params: { type: 'text_delta' } },
    { method: 'turn.event', params: { type: 'reasoning_delta' } },
    { method: 'turn.event', params: { event: { type: 'message_completed' } } },
    { method: 'chat.thinking', params: { persist: true, delta: 'x' } },
    { method: 'tool.executing', params: {} },
    { method: 'tool.output_chunk', params: {} },
    { method: 'tool.result', params: {} },
    { method: 'chat.question_batch', params: {} },
    { method: 'chat.phase_started', params: {} },
    { method: 'chat.stream_reset', params: {} },
    { method: 'context.compacted', params: {} },
    { method: 'chat.done', params: {} },
  ];
  for (const notification of effectful) {
    const probe = createTurnEffectProbe();
    probe.note(notification);
    assert.equal(
      probe.hadEffect(),
      true,
      `${notification.method} (${JSON.stringify(notification.params)}) must count as a turn effect`
    );
  }
});

test('the turn effect probe ignores pre-output signals and resets', () => {
  const probe = createTurnEffectProbe();
  probe.note({ method: 'chat.thinking', params: { persist: false, delta: 'status' } });
  probe.note({ method: 'agent.progress', params: {} });
  probe.note({ method: 'turn.event', params: { type: 'tool_input_started' } });
  probe.note(null);
  probe.note({});
  assert.equal(probe.hadEffect(), false);

  probe.note({ method: 'chat.token', params: { delta: 'a' } });
  assert.equal(probe.hadEffect(), true);
  probe.reset();
  assert.equal(probe.hadEffect(), false);
});

test('rejection classifiers key on classification, not provider_code alone', () => {
  assert.equal(isChatgptAuthRejection(authRejection(), 'chatgpt'), true);
  assert.equal(isChatgptAuthRejection(authRejection(), 'CHATGPT'), true);
  assert.equal(isChatgptAuthRejection(authRejection({ classification: 'server_error' }), 'chatgpt'), false);
  assert.equal(isChatgptAuthRejection(authRejection({ provider_code: 'CMP-CLOUD-1001' }), 'chatgpt'), false);
  assert.equal(isChatgptAuthRejection(authRejection(), 'ollama'), false);
  assert.equal(isChatgptAuthRejection(new Error('boom'), 'chatgpt'), false);
  assert.equal(isChatgptAuthRejection(null, 'chatgpt'), false);

  assert.equal(isDuplicateRequestIdRejection(duplicateRequestIdRejection()), true);
  assert.equal(isDuplicateRequestIdRejection(authRejection()), false);
  assert.equal(isDuplicateRequestIdRejection(null), false);
});

function buildProbeWiredOptions({ onNotificationObserved, onApprovalObserved, runtime }) {
  const controller = new AbortController();
  return buildManagedSidecarChatSendOptions({
    service: { _emitServiceLog() {} },
    controller,
    streamId: REQUEST_ID,
    resolvedSessionId: 'session_1',
    requestId: REQUEST_ID,
    requestTraceId: 'trace_1',
    runtime,
    toolContext: {},
    handleToolNotification: () => {},
    waitForToolApproval: async () => ({ approved: true }),
    turnEventCollector: null,
    normalizedPreferences: { plan_mode: false },
    timeoutMs: 1000,
    noteStreamActivity: () => {},
    pauseStreamIdleTimer: () => {},
    onNotificationObserved,
    onApprovalObserved,
  });
}

test('the managed send options thread notification and approval observations to the probe', async () => {
  const observed = [];
  const handled = [];
  let approvals = 0;
  const options = buildProbeWiredOptions({
    onNotificationObserved: (notification) => observed.push(notification.method),
    onApprovalObserved: () => { approvals += 1; },
    runtime: { handleNotification: (notification) => handled.push(notification.method) },
  });

  options.onNotification({ method: 'chat.token', params: { delta: 'a' } });
  await options.onApprovalRequest({ tool_name: 'shell' });

  assert.deepEqual(observed, ['chat.token']);
  assert.deepEqual(handled, ['chat.token']);
  assert.equal(approvals, 1);
});

test('a throwing turn-effect observer never breaks the turn', async () => {
  const handled = [];
  const options = buildProbeWiredOptions({
    onNotificationObserved: () => { throw new Error('probe exploded'); },
    onApprovalObserved: () => { throw new Error('probe exploded'); },
    runtime: { handleNotification: (notification) => handled.push(notification.method) },
  });

  options.onNotification({ method: 'chat.token', params: { delta: 'a' } });
  const approval = await options.onApprovalRequest({ tool_name: 'shell' });

  assert.deepEqual(handled, ['chat.token']);
  assert.deepEqual(approval, { approved: true });
});
