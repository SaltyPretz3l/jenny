const test = require('node:test');
const assert = require('node:assert/strict');

const {
  copyAssistantErrorRecoveryFields,
  getMessageById,
  getReasoningPhaseField,
  hasAssistantErrorRecoveryMetadata,
  normalizeReasoningPhase,
  formatDurationMs,
} = require('../renderer/chat/renderer-turn-row-model-utils');

test('turn row model utils copy sanitized recovery metadata with payload precedence', () => {
  const target = {};
  const payload = {
    error_code: ' CMP-RUNTIME-0001 ',
    retryable: false,
    recovery_actions: [
      { id: ' retry ', label: ' Retry now ' },
      { id: 'inspect' },
      { id: ' ', label: 'Ignore' },
      ['invalid'],
    ],
  };
  const sourceMessage = {
    error_code: 'CMP-SOURCE-0001',
    recovery_class: ' transient ',
    next_action: ' retry_after_refresh ',
    retryable: true,
    recovery_actions: [{ id: 'source-action' }],
  };

  copyAssistantErrorRecoveryFields(target, payload, sourceMessage);
  payload.recovery_actions[0].id = 'mutated';

  assert.deepEqual(target, {
    error_code: 'CMP-RUNTIME-0001',
    recovery_class: 'transient',
    next_action: 'retry_after_refresh',
    retryable: false,
    recovery_actions: [
      { id: 'retry', label: 'Retry now' },
      { id: 'inspect' },
    ],
  });
});

test('turn row model utils detect recovery metadata and resolve messages by map or array', () => {
  const mappedMessage = { id: 'mapped', content: 'from map' };
  const fallbackMessage = { id: 'fallback', content: 'from array' };

  assert.equal(
    hasAssistantErrorRecoveryMetadata({ recovery_actions: [{ id: ' retry ' }] }),
    true
  );
  assert.equal(
    hasAssistantErrorRecoveryMetadata({ error_code: ' ', recovery_actions: [{ label: 'No id' }] }),
    false
  );
  assert.equal(getMessageById(' mapped ', [fallbackMessage], new Map([['mapped', mappedMessage]])), mappedMessage);
  assert.equal(getMessageById('fallback', [fallbackMessage], null), fallbackMessage);
  assert.equal(getMessageById('', [fallbackMessage], null), null);
});

test('turn row model utils normalize reasoning phases and durations', () => {
  const phase = {
    phase_kind: 'planning',
    phaseId: 'phase-camel',
    thinking_id: 'thinking-snake',
    render_collapsed: true,
    iteration: '2',
    summary: ' summary text ',
    tokens_per_second: '18.5',
    completed_at: '2026-08-14T12:00:00.000Z',
  };

  assert.equal(getReasoningPhaseField({ render_collapsed: true }, 'renderCollapsed'), true);
  assert.deepEqual(normalizeReasoningPhase(phase), {
    phaseKind: 'planning',
    phaseId: 'phase-camel',
    thinkingId: 'thinking-snake',
    renderCollapsed: true,
    iteration: 2,
    summary: 'summary text',
    tokensPerSecond: 18.5,
    completedAt: '2026-08-14T12:00:00.000Z',
    completed: true,
  });
  assert.equal(formatDurationMs(0), '');
  assert.equal(formatDurationMs(999), '999ms');
  assert.equal(formatDurationMs(2150), '2.1s');
});
