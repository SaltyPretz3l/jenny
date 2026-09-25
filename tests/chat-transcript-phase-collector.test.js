const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TranscriptPhaseCollector,
  normalizePhaseSummary,
} = require('../services/backend/chat-transcript-phase-collector');

test('transcript phase collector preserves bounded phase summaries', () => {
  const collector = new TranscriptPhaseCollector({ streamId: 'stream-summary' });
  const longSummary = ` ${'phase summary '.repeat(40)} `;

  collector.notePhaseStarted({
    phase_id: 'phase-summary',
    phase_kind: 'reasoning',
    summary: longSummary,
  });
  collector.notePhaseCompleted({
    phase_id: 'phase-summary',
  });

  const fields = collector.buildAssistantMessageFields();
  const summary = fields.reasoning_phases[0].summary;

  assert.equal(summary, normalizePhaseSummary(longSummary));
  assert.equal(summary.length <= 240, true);
  assert.equal(summary.endsWith('...'), true);
  assert.doesNotMatch(summary, /\s{2,}/);
});

test('authoritative text replacement preserves segment-phase alignment', () => {
  const collector = new TranscriptPhaseCollector({ streamId: 'stream-replace' });
  collector.appendText('First ', { phase_id: 'phase-text-1' });
  collector.notePhaseStarted({ phase_id: 'phase-reasoning', phase_kind: 'reasoning' });
  collector.notePhaseCompleted({ phase_id: 'phase-reasoning' });
  collector.appendText('stale tail', { phase_id: 'phase-text-2' });

  collector.replaceVisibleText('Fixed');

  const fields = collector.buildAssistantMessageFields();
  assert.deepEqual(
    fields.visible_segments.map((segment) => segment.text),
    ['Fixed'],
  );
  const textPhases = fields.phases.filter((phase) => phase.phase_kind === 'text');
  assert.deepEqual(
    textPhases.map((phase) => phase.phase_id),
    fields.visible_segments.map((segment) => segment.phase_id),
  );
  assert.equal(fields.phases.some((phase) => phase.phase_kind === 'reasoning'), true);
});

test('assistant message fields omit compaction history until one is noted', () => {
  const collector = new TranscriptPhaseCollector({ streamId: 'stream-no-compaction' });
  const fields = collector.buildAssistantMessageFields();

  assert.equal(Object.hasOwn(fields, 'context_compactions'), false);
  assert.equal(Object.hasOwn(fields, 'context_compacted'), false);
});

test('context compaction entries are bounded and cloned into assistant fields', () => {
  const collector = new TranscriptPhaseCollector({ streamId: 'stream-compaction' });
  const stored = collector.noteContextCompaction({
    historyScopeFallback: 'recent',
    strategy: ` ${'s'.repeat(50)} `,
    tokensBefore: Number.MAX_SAFE_INTEGER + 100,
    tokensAfter: -5,
    phase: ` ${'p'.repeat(50)} `,
    summaryStatus: ` ${'q'.repeat(50)} `,
    reasonCode: ` ${'r'.repeat(100)} `,
    inputComplete: 1,
    droppedMessages: 3.9,
    droppedBytes: Infinity,
    summaryPersisted: 'yes',
    summaryExcerpt: ` ${' excerpt '.repeat(200)} `,
    occurredAt: '2026-09-21T12:00:00.000Z',
  });

  assert.equal(stored.strategy.length, 40);
  assert.equal(stored.tokensBefore, Number.MAX_SAFE_INTEGER);
  assert.equal(stored.tokensAfter, 0);
  assert.equal(stored.phase.length, 40);
  assert.equal(stored.summaryStatus.length, 40);
  assert.equal(stored.reasonCode.length, 80);
  assert.equal(stored.inputComplete, true);
  assert.equal(stored.droppedMessages, 3);
  assert.equal(stored.droppedBytes, 0);
  assert.equal(stored.summaryPersisted, true);
  assert.equal(stored.summaryExcerpt.length, 1200);
  assert.equal(stored.occurredAt, '2026-09-21T12:00:00.000Z');

  const fields = collector.buildAssistantMessageFields();
  assert.deepEqual(fields.context_compacted, stored);
  assert.deepEqual(fields.context_compactions, [stored]);
  fields.context_compacted.strategy = 'mutated';
  assert.notEqual(collector.slice.contextCompactions[0].strategy, 'mutated');
});

test('context compaction history keeps the last 20 entries and reset clears it', () => {
  const collector = new TranscriptPhaseCollector({ streamId: 'stream-compaction-cap' });
  for (let index = 0; index < 22; index += 1) {
    collector.noteContextCompaction({
      strategy: `strategy-${index}`,
      occurredAt: index === 21 ? 'not-a-date' : '2026-09-21T12:00:00.000Z',
    });
  }

  const fields = collector.buildAssistantMessageFields();
  assert.equal(fields.context_compactions.length, 20);
  assert.equal(fields.context_compactions[0].strategy, 'strategy-2');
  assert.equal(fields.context_compacted.strategy, 'strategy-21');
  assert.equal(Object.hasOwn(fields.context_compacted, 'occurredAt'), false);

  collector.resetSlice();
  const resetFields = collector.buildAssistantMessageFields();
  assert.equal(Object.hasOwn(resetFields, 'context_compactions'), false);
  assert.equal(Object.hasOwn(resetFields, 'context_compacted'), false);
});
