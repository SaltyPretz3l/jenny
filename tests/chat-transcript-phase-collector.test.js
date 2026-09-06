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
