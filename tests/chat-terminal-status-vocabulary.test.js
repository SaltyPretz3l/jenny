const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STREAMING_STATUS,
  COMPLETE_STATUS,
  ERROR_STATUS,
  CANCELLED_STATUS,
  DENIED_STATUS,
  TIMEOUT_STATUS,
  PREEMPTED_STATUS,
  INTERRUPTED_STATUS,
  UNKNOWN_STATUS,
  CANONICAL_TERMINAL_STATUSES,
  TERMINAL_STATUSES,
  ALIASES,
  normalizeTerminalStatus,
  isTerminalStatus,
  coarseRenderStatus,
} = require('../renderer/chat/chat-terminal-status-vocabulary');

test('normalizeTerminalStatus returns empty string for absent/empty input (callers own their legacy default)', () => {
  assert.equal(normalizeTerminalStatus(''), '');
  assert.equal(normalizeTerminalStatus(null), '');
  assert.equal(normalizeTerminalStatus(undefined), '');
  assert.equal(normalizeTerminalStatus('   '), '');
});

test('normalizeTerminalStatus trims and lowercases known canonical values', () => {
  assert.equal(normalizeTerminalStatus('  Streaming '), STREAMING_STATUS);
  assert.equal(normalizeTerminalStatus('COMPLETE'), COMPLETE_STATUS);
  assert.equal(normalizeTerminalStatus('Error'), ERROR_STATUS);
});

test('normalizeTerminalStatus resolves aliases for both legacy spellings and forms', () => {
  assert.equal(normalizeTerminalStatus('completed'), COMPLETE_STATUS);
  assert.equal(normalizeTerminalStatus('done'), COMPLETE_STATUS);
  assert.equal(normalizeTerminalStatus('cancelled'), CANCELLED_STATUS);
  assert.equal(normalizeTerminalStatus('canceled'), CANCELLED_STATUS);
  assert.equal(normalizeTerminalStatus('aborted'), CANCELLED_STATUS);
  assert.equal(normalizeTerminalStatus('runtime_error'), ERROR_STATUS);
});

test('normalizeTerminalStatus fails closed to unknown for a present but unrecognized string', () => {
  assert.equal(normalizeTerminalStatus('some_bogus_status'), UNKNOWN_STATUS);
});

test('isTerminalStatus + TERMINAL_STATUSES cover terminal outcomes but not streaming/unknown', () => {
  assert.equal(isTerminalStatus(COMPLETE_STATUS), true);
  assert.equal(isTerminalStatus(ERROR_STATUS), true);
  assert.equal(isTerminalStatus(CANCELLED_STATUS), true);
  assert.equal(isTerminalStatus(DENIED_STATUS), true);
  assert.equal(isTerminalStatus(TIMEOUT_STATUS), true);
  assert.equal(isTerminalStatus(PREEMPTED_STATUS), true);
  assert.equal(isTerminalStatus(INTERRUPTED_STATUS), true);
  assert.equal(isTerminalStatus(STREAMING_STATUS), false);
  assert.equal(isTerminalStatus(UNKNOWN_STATUS), false);
  assert.equal(TERMINAL_STATUSES.has(STREAMING_STATUS), false);
  assert.equal(TERMINAL_STATUSES.has(UNKNOWN_STATUS), false);
});

test('coarseRenderStatus buckets canonical statuses into streaming/complete/error/unknown/empty', () => {
  assert.equal(coarseRenderStatus(STREAMING_STATUS), STREAMING_STATUS);
  assert.equal(coarseRenderStatus(COMPLETE_STATUS), COMPLETE_STATUS);
  assert.equal(coarseRenderStatus(ERROR_STATUS), ERROR_STATUS);
  assert.equal(coarseRenderStatus(CANCELLED_STATUS), ERROR_STATUS);
  assert.equal(coarseRenderStatus(DENIED_STATUS), ERROR_STATUS);
  assert.equal(coarseRenderStatus(TIMEOUT_STATUS), ERROR_STATUS);
  assert.equal(coarseRenderStatus(PREEMPTED_STATUS), ERROR_STATUS);
  assert.equal(coarseRenderStatus(INTERRUPTED_STATUS), ERROR_STATUS);
  assert.equal(coarseRenderStatus(UNKNOWN_STATUS), UNKNOWN_STATUS);
  assert.equal(coarseRenderStatus(''), '');
});

test('CANONICAL_TERMINAL_STATUSES enumerates the full canonical vocabulary', () => {
  const expected = [
    STREAMING_STATUS,
    COMPLETE_STATUS,
    ERROR_STATUS,
    CANCELLED_STATUS,
    DENIED_STATUS,
    TIMEOUT_STATUS,
    PREEMPTED_STATUS,
    INTERRUPTED_STATUS,
    UNKNOWN_STATUS,
  ];
  for (const status of expected) {
    assert.equal(CANONICAL_TERMINAL_STATUSES.has(status), true, `missing ${status}`);
  }
  assert.equal(CANONICAL_TERMINAL_STATUSES.size, expected.length);
});

test('ALIASES maps every documented legacy spelling to its canonical target', () => {
  assert.equal(ALIASES.get('completed'), COMPLETE_STATUS);
  assert.equal(ALIASES.get('done'), COMPLETE_STATUS);
  assert.equal(ALIASES.get('canceled'), CANCELLED_STATUS);
  assert.equal(ALIASES.get('aborted'), CANCELLED_STATUS);
  assert.equal(ALIASES.get('runtime_error'), ERROR_STATUS);
});
