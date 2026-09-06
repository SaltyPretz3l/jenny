const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enrichTerminalErrorPayloadForEmit,
} = require('../services/backend/chat-stream-terminal-utils');

test('live emit enrichment adds sidecar transport recovery metadata', () => {
  const payload = {
    message: 'Sidecar process exited unexpectedly.',
    error_code: 'CMP-SIDECAR-0003',
    retryable: true,
    category: 'process_exit',
    status: 'runtime_error',
    terminal_subcode: 'sidecar_crash',
  };

  const enriched = enrichTerminalErrorPayloadForEmit(payload, {
    terminalStatus: 'runtime_error',
    terminalSubcode: 'sidecar_crash',
  });

  assert.equal(enriched.recovery_class, 'sidecar_transport');
  assert.equal(enriched.next_action, 'retry_turn');
  assert.equal(enriched.next_action_label, 'Retry turn');
  assert.ok(enriched.recovery_title);
  assert.ok(enriched.recovery_hint);
  assert.deepEqual(
    enriched.recovery_actions.map((action) => action.id),
    ['retry_turn', 'restart_sidecar', 'open_diagnostics']
  );
  assert.equal(enriched.message, payload.message);
  assert.equal(enriched.error_code, payload.error_code);
});

test('live emit enrichment classifies provider errors with settings action', () => {
  const enriched = enrichTerminalErrorPayloadForEmit({
    message: 'Model failed to load.',
    error_code: 'CMP-AI-0004',
    retryable: true,
    category: 'provider',
    status: 'runtime_error',
  });

  assert.equal(enriched.recovery_class, 'provider');
  assert.deepEqual(
    enriched.recovery_actions.map((action) => action.id),
    ['retry_turn', 'open_settings', 'open_diagnostics']
  );
});

test('live emit enrichment never clobbers metadata already on the payload', () => {
  const enriched = enrichTerminalErrorPayloadForEmit({
    message: 'Custom failure.',
    error_code: 'CMP-AI-0002',
    category: 'provider',
    status: 'runtime_error',
    recovery_class: 'custom_class',
    recovery_title: 'Custom title',
    recovery_actions: [{ id: 'custom_action', kind: 'retry', label: 'Custom', priority: 1 }],
  });

  assert.equal(enriched.recovery_class, 'custom_class');
  assert.equal(enriched.recovery_title, 'Custom title');
  assert.deepEqual(
    enriched.recovery_actions.map((action) => action.id),
    ['custom_action']
  );
});

test('live emit enrichment leaves cancelled turns without retry actions', () => {
  const enriched = enrichTerminalErrorPayloadForEmit({
    message: 'Stream cancelled.',
    retryable: true,
    category: 'cancelled',
    status: 'cancelled',
    cancel_reason: 'user_cancel',
    terminal_subcode: 'user_cancel',
  });

  assert.equal(enriched.recovery_class, 'cancelled');
  assert.equal('recovery_actions' in enriched, false);
  assert.equal(enriched.next_action || '', '');
  assert.ok(enriched.recovery_title);
});

test('live emit enrichment does not mutate the input payload', () => {
  const payload = {
    message: 'Transport failure.',
    error_code: 'CMP-SIDECAR-0004',
    category: 'transport',
    status: 'runtime_error',
  };

  const enriched = enrichTerminalErrorPayloadForEmit(payload);

  assert.notEqual(enriched, payload);
  assert.equal('recovery_class' in payload, false);
  assert.equal(enriched.recovery_class, 'sidecar_transport');
});

test('live emit enrichment is a no-op on malformed input', () => {
  assert.equal(enrichTerminalErrorPayloadForEmit(null), null);
  assert.equal(enrichTerminalErrorPayloadForEmit(undefined), undefined);
  assert.equal(enrichTerminalErrorPayloadForEmit('broken'), 'broken');
  const list = ['not', 'a', 'payload'];
  assert.equal(enrichTerminalErrorPayloadForEmit(list), list);
});
