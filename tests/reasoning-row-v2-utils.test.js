const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REASONING_STATUS_VALUES,
  normalizeReasoningStatus,
  reasoningStatusTone,
  shouldAutoExpandReasoningV2,
  formatReasoningSecondaryMeta,
  formatReasoningDuration,
  buildReasoningPreview,
  deriveReasoningStatus,
} = require('../renderer/chat/reasoning-row-v2-utils');

test('REASONING_STATUS_VALUES exposes the v2 status enum', () => {
  assert.deepEqual(
    [...REASONING_STATUS_VALUES],
    ['streaming', 'complete', 'error', 'empty']
  );
});

test('normalizeReasoningStatus lowercases and trims; falls back to empty', () => {
  assert.equal(normalizeReasoningStatus('streaming'), 'streaming');
  assert.equal(normalizeReasoningStatus('  COMPLETE  '), 'complete');
  assert.equal(normalizeReasoningStatus(''), 'empty');
  assert.equal(normalizeReasoningStatus(null), 'empty');
});

test('reasoningStatusTone maps statuses to the foundation .status-dot palette', () => {
  assert.equal(reasoningStatusTone('streaming'), 'active');
  assert.equal(reasoningStatusTone('complete'), 'ok');
  assert.equal(reasoningStatusTone('error'), 'error');
  assert.equal(reasoningStatusTone('empty'), 'muted');
  assert.equal(reasoningStatusTone('unknown'), 'muted');
});

test('reasoningStatusTone forces active when isStreaming overrides a stale status', () => {
  assert.equal(reasoningStatusTone('complete', { isStreaming: true }), 'active');
});

test('shouldAutoExpandReasoningV2 expands only streaming rows by default (settled collapses, error included)', () => {
  assert.equal(shouldAutoExpandReasoningV2('streaming'), true);
  /* Owner call 2026-07-05: errored turns collapse too — the error card owns the failure story. */
  assert.equal(shouldAutoExpandReasoningV2('error'), false);
  assert.equal(shouldAutoExpandReasoningV2('complete'), false);
  assert.equal(shouldAutoExpandReasoningV2('empty'), false);
});

test('shouldAutoExpandReasoningV2 honors isStreaming for in-flight rows', () => {
  assert.equal(shouldAutoExpandReasoningV2('complete', { isStreaming: true }), true);
});

test('formatReasoningSecondaryMeta formats tokens/sec when available', () => {
  assert.equal(formatReasoningSecondaryMeta({ tokensPerSecond: 12.4 }), '12 tok/s');
  assert.equal(formatReasoningSecondaryMeta({ tokensPerSecond: 4.27 }), '4.3 tok/s');
});

test('formatReasoningSecondaryMeta returns empty string when no rate is available', () => {
  assert.equal(formatReasoningSecondaryMeta({}), '');
  assert.equal(formatReasoningSecondaryMeta({ tokensPerSecond: 0 }), '');
  assert.equal(formatReasoningSecondaryMeta({ tokensPerSecond: -1 }), '');
});

test('formatReasoningDuration formats a settled multi-second span', () => {
  assert.equal(
    formatReasoningDuration('2026-06-22T10:00:00.000Z', '2026-06-22T10:00:03.400Z', { completed: true }),
    '3.4s',
  );
});

test('formatReasoningDuration: B3 suppresses sub-second spans (no low-signal "<1s" badge)', () => {
  assert.equal(
    formatReasoningDuration('2026-06-22T10:00:00.000Z', '2026-06-22T10:00:00.450Z', { completed: true }),
    '',
  );
});

test('formatReasoningDuration returns empty while streaming or not yet completed', () => {
  const a = '2026-06-22T10:00:00.000Z';
  const b = '2026-06-22T10:00:03.000Z';
  assert.equal(formatReasoningDuration(a, b, { completed: true, isStreaming: true }), '');
  assert.equal(formatReasoningDuration(a, b, { completed: false }), '');
});

test('formatReasoningDuration returns empty for missing, unparseable, or non-positive spans', () => {
  assert.equal(formatReasoningDuration('', '', { completed: true }), '');
  assert.equal(formatReasoningDuration('not-a-date', '2026-06-22T10:00:03.000Z', { completed: true }), '');
  assert.equal(
    formatReasoningDuration('2026-06-22T10:00:03.000Z', '2026-06-22T10:00:00.000Z', { completed: true }),
    '',
  );
  // Exact zero-length span (start === completed): the `!(durationMs > 0)` guard
  // must collapse it to empty, not "<1s".
  const sameInstant = '2026-06-22T10:00:00.000Z';
  assert.equal(formatReasoningDuration(sameInstant, sameInstant, { completed: true }), '');
});

test('buildReasoningPreview returns empty string when entries are missing', () => {
  assert.equal(buildReasoningPreview([]), '');
  assert.equal(buildReasoningPreview(null), '');
});

test('buildReasoningPreview returns full text when under the char limit', () => {
  assert.equal(buildReasoningPreview([{ text: 'short reasoning' }]), 'short reasoning');
});

test('buildReasoningPreview trims the tail when text exceeds the char limit', () => {
  const entries = [{
    text: 'a'.repeat(80) + '. ' + 'b'.repeat(80) + '. ' + 'final sentence here.',
  }];
  const preview = buildReasoningPreview(entries, { charLimit: 60 });
  assert.ok(preview.length <= 60);
  assert.ok(preview.endsWith('.') || preview.endsWith('…'));
});

test('deriveReasoningStatus respects explicit reasoning.status when present', () => {
  assert.equal(
    deriveReasoningStatus({ reasoning: { status: 'streaming' } }),
    'streaming'
  );
});

test('deriveReasoningStatus treats completed messages as complete when reasoning status is stale', () => {
  assert.equal(
    deriveReasoningStatus({
      status: 'complete',
      reasoning: {
        status: 'streaming',
        entries: [{ text: 'Checked the request.' }],
      },
    }),
    'complete'
  );
  assert.equal(
    deriveReasoningStatus({
      status: 'cancelled',
      reasoning: {
        status: 'streaming',
        entries: [{ text: 'Stopped before final answer.' }],
      },
    }),
    'complete'
  );
});

test('deriveReasoningStatus surfaces error from message.status', () => {
  assert.equal(deriveReasoningStatus({ status: 'error', reasoning: {} }), 'error');
});

test('deriveReasoningStatus settles a completed phase inside an active message', () => {
  assert.equal(
    deriveReasoningStatus(
      { status: 'streaming', reasoning: { status: 'streaming' } },
      { phaseCompleted: true },
    ),
    'complete',
  );
});

test('deriveReasoningStatus marks streaming when the tail of an active stream', () => {
  assert.equal(
    deriveReasoningStatus({ reasoning: { entries: [{ text: 'x' }] } }, { isStreamingTail: true }),
    'streaming'
  );
});

test('deriveReasoningStatus returns complete when entries exist but stream is done', () => {
  assert.equal(
    deriveReasoningStatus({ reasoning: { entries: [{ text: 'x' }] } }),
    'complete'
  );
});

test('deriveReasoningStatus returns empty for messages without reasoning entries', () => {
  assert.equal(deriveReasoningStatus({ reasoning: { entries: [] } }), 'empty');
  assert.equal(deriveReasoningStatus({}), 'empty');
});
