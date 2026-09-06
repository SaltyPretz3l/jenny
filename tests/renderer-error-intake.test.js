/**
 * EH-W7 gate: pure intake core — envelope normalization + the frozen
 * 12-row routing table (renderer/shared/error-intake.js). No DOM.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const intake = require('../renderer/shared/error-intake');
const recoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');

const { normalizeErrorEnvelope, routeError, ERROR_ROUTING_TABLE } = intake;

test('routing table is frozen and covers the 12 plan rows exactly once', () => {
  assert.ok(Object.isFrozen(ERROR_ROUTING_TABLE));
  for (const row of ERROR_ROUTING_TABLE) {
    assert.ok(Object.isFrozen(row), `row ${row.id} frozen`);
  }
  const ids = ERROR_ROUTING_TABLE.map((row) => row.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(ERROR_ROUTING_TABLE[ERROR_ROUTING_TABLE.length - 1].rule, 'default');
});

/* ── Table-driven route coverage: one case per plan row ── */

const ROUTE_CASES = [
  {
    name: 'row 1: cancelled recovery class -> no surface, error-center only',
    input: { recovery_class: 'cancelled', error_code: 'CMP-CHAT-0002' },
    context: { origin: 'chat-stream' },
    expect: { ruleId: 1, surface: 'none', record: true },
  },
  {
    name: 'row 2: chat-stream turn error -> timeline (toast suppressed)',
    input: { stream_error: 'generation failed', error_code: 'CMP-AI-0005', status: 'runtime_error' },
    context: { origin: 'chat-stream', sessionId: 'sess-1' },
    expect: { ruleId: 2, surface: 'timeline', record: true },
  },
  {
    name: 'row 3: chat-stream + backend unusable -> sticky danger banner',
    input: { stream_error: 'backend gone', error_code: 'CMP-SIDECAR-0001' },
    context: { origin: 'chat-stream', backendUnusable: true, isInflightTurn: true },
    expect: { ruleId: 3, surface: 'banner', record: true },
  },
  {
    name: 'row 4: backend-status phase failure -> banner',
    input: { phase: 'failed', detail: 'Backend exited unexpectedly' },
    context: { origin: 'backend-status' },
    expect: { ruleId: 4, surface: 'banner', record: true },
  },
  {
    name: 'row 5: settings-refresh -> deduped auto-dismiss warning toast',
    input: { message: 'Memory refresh failed' },
    context: { origin: 'settings-refresh', source: 'shell.settings', dedupeKey: 'settings-refresh:memory' },
    expect: { ruleId: 5, surface: 'toast', record: true },
  },
  {
    name: 'row 6: offline-refresh -> error-center only',
    input: { message: 'offline probe failed' },
    context: { origin: 'offline-refresh' },
    expect: { ruleId: 6, surface: 'none', record: true },
  },
  {
    name: 'row 6: health-poll -> error-center only',
    input: { message: 'health poll failed' },
    context: { origin: 'health-poll' },
    expect: { ruleId: 6, surface: 'none', record: true },
  },
  {
    name: 'row 7: update-action -> sticky danger toast',
    input: { message: 'Update download failed', options: { tone: 'error' } },
    context: { origin: 'update-action' },
    expect: { ruleId: 7, surface: 'toast', record: true },
  },
  {
    name: 'row 8: shell-action -> danger toast',
    input: { message: 'Could not rename session' },
    context: { origin: 'shell-action', source: 'shell.session-action' },
    expect: { ruleId: 8, surface: 'toast', record: true },
  },
  {
    name: 'row 9: global-boundary -> deduped warning toast',
    input: { message: 'render boundary tripped', error_code: 'CMP-RENDER-0001' },
    context: { origin: 'global-boundary', dedupeKey: 'global-boundary:CMP-RENDER-0001' },
    expect: { ruleId: 9, surface: 'toast', record: true },
  },
  {
    name: 'row 10: auth -> inline auth text, history-only',
    input: { message: 'Invalid credentials' },
    context: { origin: 'auth' },
    expect: { ruleId: 10, surface: 'auth-inline', record: true },
  },
  {
    name: 'row 11: startup crash -> startup overlay',
    input: { message: 'boot exploded' },
    context: { origin: 'startup-crash' },
    expect: { ruleId: 11, surface: 'startup-overlay', record: true },
  },
  {
    name: 'row 12: unknown origin -> default danger toast',
    input: new Error('mystery failure'),
    context: {},
    expect: { ruleId: 12, surface: 'toast', record: true },
  },
];

for (const routeCase of ROUTE_CASES) {
  test(routeCase.name, () => {
    const route = routeError(routeCase.input, routeCase.context);
    assert.equal(route.ruleId, routeCase.expect.ruleId);
    assert.equal(route.surface, routeCase.expect.surface);
    assert.equal(route.recordToErrorCenter, routeCase.expect.record);
    if (route.surface === 'toast') {
      assert.ok(route.toast, 'toast directive present');
      assert.equal(route.banner, null);
    } else {
      assert.equal(route.toast, null, 'non-toast surfaces never carry a toast directive');
    }
    if (route.surface === 'banner') {
      assert.ok(route.banner, 'banner directive present');
    }
  });
}

/* ── Row-level directive details ── */

test('cancelled / denied are silent on every toast-bearing origin', () => {
  for (const origin of ['chat-stream', 'shell-action', 'update-action', 'settings-refresh']) {
    for (const stop of [
      { recovery_class: 'cancelled' },
      { recovery_class: 'denied' },
      { status: 'cancelled' },
      { status: 'aborted' },
      { status: 'denied' },
    ]) {
      const route = routeError({ message: 'stopped', ...stop }, { origin });
      assert.equal(route.ruleId, 1, `${origin} ${JSON.stringify(stop)} hits row 1`);
      assert.equal(route.surface, 'none');
      assert.equal(route.toast, null);
      assert.equal(route.recordToErrorCenter, true, 'still recorded for history');
      assert.equal(route.envelope.severity, 'info');
    }
  }
});

test('canonical cancellation and explicit-denial terminal subcodes route as user stops', () => {
  for (const terminalSubcode of ['user_cancel', 'user_explicit']) {
    const route = routeError({
      message: 'stopped',
      status: 'error',
      terminal_subcode: terminalSubcode,
    }, { origin: 'shell-action' });

    assert.equal(route.envelope.terminalSubcode, terminalSubcode);
    assert.equal(route.ruleId, 1);
    assert.equal(route.surface, 'none');
    assert.equal(route.toast, null);
    assert.equal(route.envelope.severity, 'info');
  }
});

test('backend-unusable chat-stream errors win over the plain chat-stream row', () => {
  const plain = routeError({ stream_error: 'x' }, { origin: 'chat-stream' });
  const unusable = routeError({ stream_error: 'x' }, { origin: 'chat-stream', backendUnusable: true });
  assert.equal(plain.ruleId, 2);
  assert.equal(unusable.ruleId, 3);
  assert.deepEqual(unusable.banner, { tone: 'danger', sticky: true });
});

test('update-action danger override: legacy tone "error" becomes a sticky danger toast', () => {
  const route = routeError(
    { message: 'Update failed', options: { tone: 'error' } },
    { origin: 'update-action' }
  );
  assert.equal(route.envelope.severity, 'danger');
  assert.equal(route.toast.tone, 'danger');
  assert.equal(route.toast.sticky, true);
  /* Even an explicit info tone cannot demote an update failure. */
  const demoted = routeError(
    { message: 'Update failed', options: { tone: 'info' } },
    { origin: 'update-action' }
  );
  assert.equal(demoted.envelope.severity, 'danger');
});

test('settings-refresh toasts auto-dismiss with a dedupe key', () => {
  const route = routeError(
    { message: 'Personality refresh failed' },
    { origin: 'settings-refresh', source: 'shell.settings', dedupeKey: 'settings-refresh:personality' }
  );
  assert.equal(route.toast.tone, 'warning');
  assert.equal(route.toast.sticky, false);
  assert.ok(route.toast.durationMs > 0, 'auto-dismiss requires an explicit duration');
  assert.equal(route.toast.dedupeKey, 'settings-refresh:personality');
  assert.equal(route.toast.source, 'shell.settings');
});

/* ── Envelope normalization ── */

test('severity derivation: origin defaults and explicit severities', () => {
  assert.equal(normalizeErrorEnvelope({ message: 'x' }, { origin: 'settings-refresh' }).severity, 'warning');
  assert.equal(normalizeErrorEnvelope({ message: 'x' }, { origin: 'global-boundary' }).severity, 'warning');
  assert.equal(normalizeErrorEnvelope({ message: 'x' }, { origin: 'health-poll' }).severity, 'warning');
  assert.equal(normalizeErrorEnvelope({ message: 'x' }, { origin: 'shell-action' }).severity, 'danger');
  assert.equal(normalizeErrorEnvelope({ message: 'x', severity: 'info' }, { origin: 'shell-action' }).severity, 'info');
  assert.equal(normalizeErrorEnvelope({ message: 'x', recovery_class: 'cancelled' }, { origin: 'shell-action' }).severity, 'info');
});

test('classifier reuse: category falls back to classifyError, no second classifier', () => {
  const envelope = normalizeErrorEnvelope(
    { stream_error: 'boom', error_code: 'CMP-TOOL-0001' },
    { origin: 'chat-stream' }
  );
  assert.equal(envelope.category, recoveryUtils.classifyError('CMP-TOOL-0001'));
  assert.equal(envelope.category, 'tool');
  /* Backend-supplied category wins over the local fallback. */
  const supplied = normalizeErrorEnvelope(
    { stream_error: 'boom', error_code: 'CMP-TOOL-0001', category: 'runtime' },
    { origin: 'chat-stream' }
  );
  assert.equal(supplied.category, 'runtime');
  /* retryable falls back to the shared isRetryable when not supplied. */
  const transport = normalizeErrorEnvelope({ error_code: 'CMP-AI-0002' }, {});
  assert.equal(transport.retryable, recoveryUtils.isRetryable('CMP-AI-0002', ''));
  assert.equal(transport.retryable, true);
  const explicit = normalizeErrorEnvelope({ error_code: 'CMP-AI-0002', retryable: false }, {});
  assert.equal(explicit.retryable, false);
});

test('chat-stream payload normalization carries the recovery fields through', () => {
  const envelope = normalizeErrorEnvelope({
    stream_error: 'rate limited',
    error_code: 'CMP-AI-0003',
    recovery_class: 'provider_rate_limited',
    terminal_status: 'runtime_error',
    recovery_title: 'Provider busy',
    recovery_hint: 'Wait a moment and retry.',
    recovery_actions: [{ id: 'retry_turn', label: 'Retry turn' }, { bogus: true }],
    next_action: 'retry_turn',
    next_action_label: 'Retry now',
    session_id: 'sess-9',
    id: 'msg-4',
  }, { origin: 'chat-stream', isInflightTurn: true });

  assert.equal(envelope.errorCode, 'CMP-AI-0003');
  assert.equal(envelope.recoveryClass, 'provider_rate_limited');
  assert.equal(envelope.terminalStatus, 'runtime_error');
  assert.equal(envelope.recoveryTitle, 'Provider busy');
  assert.equal(envelope.recoveryHint, 'Wait a moment and retry.');
  assert.deepEqual(envelope.recoveryActions, [{ id: 'retry_turn', label: 'Retry turn' }]);
  assert.equal(envelope.nextAction, 'retry_turn');
  assert.equal(envelope.nextActionLabel, 'Retry now');
  assert.equal(envelope.sessionId, 'sess-9');
  assert.equal(envelope.messageId, 'msg-4');
  assert.equal(envelope.isInflightTurn, true);
  assert.equal(envelope.message, 'rate limited');
});

test('raw Error and backend.onStatus payloads normalize', () => {
  const fromError = normalizeErrorEnvelope(new Error('socket hung up'), { origin: 'shell-action' });
  assert.equal(fromError.message, 'socket hung up');
  assert.equal(fromError.origin, 'shell-action');
  assert.equal(fromError.severity, 'danger');

  const fromStatus = normalizeErrorEnvelope(
    { phase: 'failed', detail: 'Backend exited' },
    { origin: 'backend-status' }
  );
  assert.equal(fromStatus.message, 'Backend exited');
  assert.equal(fromStatus.terminalStatus, 'failed');
});

test('dedupe key and source pass through, with source as the dedupe fallback', () => {
  const explicit = normalizeErrorEnvelope(
    { message: 'x' },
    { origin: 'shell-action', source: 'shell.memory', dedupeKey: 'memory:save' }
  );
  assert.equal(explicit.source, 'shell.memory');
  assert.equal(explicit.dedupeKey, 'memory:save');

  const fallback = normalizeErrorEnvelope(
    { message: 'x' },
    { origin: 'shell-action', source: 'shell.memory' }
  );
  assert.equal(fallback.dedupeKey, 'shell.memory');

  const legacy = normalizeErrorEnvelope(
    { message: 'x', options: { source: 'shell.logs', dedupeKey: 'logs:tail', title: 'Logs' } },
    { origin: 'shell-action' }
  );
  assert.equal(legacy.source, 'shell.logs');
  assert.equal(legacy.dedupeKey, 'logs:tail');
  assert.equal(legacy.title, 'Logs');
});

test('normalization is idempotent: routing an envelope equals routing its input', () => {
  const input = {
    stream_error: 'boom',
    error_code: 'CMP-AI-0005',
    recovery_class: 'provider',
    terminal_status: 'runtime_error',
  };
  const context = { origin: 'chat-stream', sessionId: 's', backendUnusable: true };
  const once = normalizeErrorEnvelope(input, context);
  const twice = normalizeErrorEnvelope(once);
  assert.deepEqual(twice, once);
  assert.equal(routeError(once).ruleId, routeError(input, context).ruleId);
});

test('routeError never throws on garbage input', () => {
  for (const garbage of [null, undefined, 42, 'plain string failure', [], {}]) {
    const route = routeError(garbage);
    assert.equal(route.ruleId, 12);
    assert.equal(route.surface, 'toast');
  }
  assert.equal(routeError('plain string failure').envelope.message, 'plain string failure');
});
