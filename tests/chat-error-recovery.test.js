const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAssistantErrorRecoveryMetadata,
  classifyAssistantError,
} = require('../services/backend/chat-error-recovery');

test('assistant error recovery metadata includes friendly provider next action copy', () => {
  const metadata = buildAssistantErrorRecoveryMetadata({
    code: 'CMP-AI-0003',
    category: 'provider',
    message: 'rate limit reached',
    retryable: true,
  });

  assert.equal(classifyAssistantError({ code: 'CMP-AI-0003' }), 'provider');
  assert.equal(metadata.recovery_class, 'provider');
  assert.equal(metadata.next_action, 'retry_turn');
  assert.match(metadata.recovery_hint, /wait a moment/i);
  assert.equal(metadata.next_action_label, 'Retry turn');
});

test('assistant error recovery metadata includes sidecar restart guidance', () => {
  const metadata = buildAssistantErrorRecoveryMetadata({
    code: 'CMP-SIDECAR-0003',
    category: 'process_exit',
    retryable: true,
  });

  assert.equal(metadata.recovery_class, 'sidecar_transport');
  assert.equal(metadata.next_action, 'retry_turn');
  assert.match(metadata.recovery_hint, /restart the local sidecar/i);
  assert.equal(metadata.next_action_label, 'Retry turn');
});

test('assistant error recovery routes CMP-CFG- config errors to the setup class', () => {
  const metadata = buildAssistantErrorRecoveryMetadata({
    code: 'CMP-CFG-0001',
    message: 'A tools workspace root is not configured or set to null, but tools are enabled.',
    retryable: false,
  });

  // A missing-workspace config error must NOT borrow the context-window copy
  // ("Context limit reached" / "start a new session"); it routes to Settings.
  assert.equal(classifyAssistantError({ code: 'CMP-CFG-0001' }), 'setup');
  assert.equal(metadata.recovery_class, 'setup');
  assert.equal(metadata.recovery_title, 'Setup required');
  assert.equal(metadata.next_action, 'open_settings');
  assert.deepEqual(metadata.recovery_actions.map((a) => a.id), ['open_settings', 'open_diagnostics']);
  assert.match(metadata.recovery_hint, /workspace root/i);
});

test('context-budget exhaustion offers a new-session recovery path', () => {
  const metadata = buildAssistantErrorRecoveryMetadata({
    code: 'CMP-CTX-0002',
    message: 'Context remained too large after compaction.',
    retryable: false,
  });

  assert.equal(classifyAssistantError({ code: 'CMP-CTX-0002' }), 'context');
  assert.equal(metadata.recovery_class, 'context');
  assert.equal(metadata.recovery_title, 'Context limit reached');
  assert.equal(metadata.next_action, 'start_new_session');
  assert.deepEqual(metadata.recovery_actions.map((action) => action.id), [
    'start_new_session',
    'open_diagnostics',
  ]);
});

test('turn working-time exhaustion is distinct from provider inactivity', () => {
  const timeout = {
    code: 'CMP-CHAT-0002',
    category: 'timeout',
    terminal_subcode: 'turn',
    retryable: true,
  };
  const metadata = buildAssistantErrorRecoveryMetadata(timeout);

  assert.equal(classifyAssistantError(timeout), 'turn_deadline');
  assert.equal(metadata.recovery_class, 'turn_deadline');
  assert.equal(metadata.recovery_title, 'Turn working-time limit reached');
  assert.equal(metadata.next_action, 'retry_turn');
  assert.deepEqual(metadata.recovery_actions.map((action) => action.id), [
    'retry_turn',
    'open_diagnostics',
  ]);
});

test('thinking-budget terminals get dedicated recovery copy and actions', () => {
  const error = {
    code: 'CMP-STREAM-INCOMPLETE',
    terminal_subcode: 'thinking_budget',
    retryable: true,
  };
  const metadata = buildAssistantErrorRecoveryMetadata(error);

  assert.equal(classifyAssistantError(error), 'thinking_budget');
  assert.equal(metadata.recovery_class, 'thinking_budget');
  assert.equal(metadata.recovery_title, 'Hit its thinking budget');
  assert.equal(
    metadata.recovery_hint,
    "The model kept reasoning past its budget without finishing. Retry, lower the reasoning effort, or raise this model's context in Settings."
  );
  assert.deepEqual(metadata.recovery_actions.map((action) => action.id), [
    'retry_turn',
    'open_settings',
    'open_diagnostics',
  ]);
});

test('generic stream-incomplete terminals keep retryable recovery', () => {
  const error = {
    code: 'CMP-STREAM-INCOMPLETE',
    terminal_subcode: 'stream_incomplete',
    retryable: true,
  };

  assert.equal(classifyAssistantError(error), 'retryable');
  assert.equal(buildAssistantErrorRecoveryMetadata(error).recovery_class, 'retryable');
});
