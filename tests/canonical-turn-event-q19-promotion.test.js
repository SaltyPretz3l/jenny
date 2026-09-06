'use strict';

// Integration test for the Phase 6 Q19 promotion bridge.
//
// Drives ``noteToolObservationPromotions`` (the function
// ``managed-sidecar-chat.js`` invokes on every ``chat.send`` result and
// every ``ChatRequestError.data``) through the real
// ``CanonicalTurnEventCollector`` and asserts that all four allow-listed
// event types end up on ``payload.promoted_observations`` of the right
// captured ``turn_event``.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CanonicalTurnEventCollector,
} = require('../services/backend/canonical-turn-event-collector');
const {
  noteToolObservationPromotions,
} = require('../services/backend/tool-observation-promotion');
const {
  makeAllSidecarToolObservations,
  makeSidecarToolObservation,
} = require('./helpers/q19-bridge-fixtures');

function captureBaselineEvents(collector, turnId) {
  collector.noteEvent({
    turn_id: turnId,
    kind: 'assistant_error',
    primary_message_id: `${turnId}:assistant_error:0`,
    payload: { error_code: 'CMP-LOOP-0018', message: 'stuck loop' },
  });
  collector.noteEvent({
    turn_id: turnId,
    kind: 'assistant_error',
    primary_message_id: `${turnId}:assistant_error:1`,
    payload: {
      error_code: 'CMP-LOOP-0001',
      message: 'agent loop reached the maximum iteration depth',
    },
  });
  collector.noteEvent({
    turn_id: turnId,
    kind: 'assistant_error',
    primary_message_id: `${turnId}:assistant_error:2`,
    payload: { error_code: 'CMP-LOOP-0011', message: 'budget exceeded' },
  });
  collector.noteEvent({
    turn_id: turnId,
    kind: 'tool_result',
    tool_call_id: 'call-cancelled',
    primary_message_id: 'tool_result_call-cancelled',
    payload: {
      tool_name: 'inspect_harness',
      output_text: 'interrupted',
      is_error: true,
      error_code: 'CMP-LOOP-0013',
    },
  });
  collector.noteEvent({
    turn_id: turnId,
    kind: 'approval_resolved',
    tool_call_id: 'call-denied',
    primary_message_id: `${turnId}:approval_resolved:0`,
    payload: { tool_name: 'write_file', resolution: 'denied' },
  });
}

test('Q19 sidecar tool_observations promote into payload.promoted_observations end-to-end', () => {
  const turnId = 'stream-q19';
  const collector = new CanonicalTurnEventCollector({ turnId });

  captureBaselineEvents(collector, turnId);

  const promotedCount = noteToolObservationPromotions({
    turnEventCollector: collector,
    observations: makeAllSidecarToolObservations(turnId),
    requestId: turnId,
    turnId,
  });

  assert.equal(promotedCount, 5);

  const merged = collector.mergePromotedObservations(turnId, collector.capturedEvents);
  const promotionsByEventType = new Map();
  for (const event of merged) {
    const list = Array.isArray(event?.payload?.promoted_observations)
      ? event.payload.promoted_observations
      : [];
    for (const promotion of list) {
      const matches = promotionsByEventType.get(promotion.event_type) || [];
      matches.push({ event, promotion });
      promotionsByEventType.set(promotion.event_type, matches);
    }
  }

  for (const expected of [
    'agent.stopped_due_to_loop',
    'budget.exceeded',
    'tool.cancelled',
    'approval.gap_resolved',
  ]) {
    assert.ok(
      promotionsByEventType.has(expected),
      `missing promotion for ${expected}`
    );
  }

  // Stuck loop pattern (CMP-LOOP-0018) lands on its own assistant_error.
  const loopStops = promotionsByEventType.get('agent.stopped_due_to_loop') || [];
  const stuck = loopStops.find(({ event }) => event?.payload?.error_code === 'CMP-LOOP-0018');
  assert.equal(stuck.event.kind, 'assistant_error');
  assert.equal(stuck.event.payload.error_code, 'CMP-LOOP-0018');

  // Tool cancellation lands on the matching tool_result via tool_call_id.
  const cancelled = promotionsByEventType.get('tool.cancelled')[0];
  assert.equal(cancelled.event.kind, 'tool_result');
  assert.equal(cancelled.event.tool_call_id, 'call-cancelled');

  // Approval rejection lands on the matching approval_resolved row.
  const approvalGap = promotionsByEventType.get('approval.gap_resolved')[0];
  assert.equal(approvalGap.event.kind, 'approval_resolved');
  assert.equal(approvalGap.event.tool_call_id, 'call-denied');

  // Budget exceeded lands on its own assistant_error (CMP-LOOP-0011).
  const budget = promotionsByEventType.get('budget.exceeded')[0];
  assert.equal(budget.event.kind, 'assistant_error');
  assert.equal(budget.event.payload.error_code, 'CMP-LOOP-0011');
});

test('CMP-LOOP-0001 max-iterations promotes into agent.stopped_due_to_loop (Finding 1b)', () => {
  const turnId = 'stream-max-iter';
  const collector = new CanonicalTurnEventCollector({ turnId });

  collector.noteEvent({
    turn_id: turnId,
    kind: 'assistant_error',
    primary_message_id: `${turnId}:assistant_error:0`,
    payload: {
      error_code: 'CMP-LOOP-0001',
      message: 'agent loop reached the maximum iteration depth',
    },
  });

  const promotedCount = noteToolObservationPromotions({
    turnEventCollector: collector,
    observations: [makeSidecarToolObservation('max_iterations', turnId, 1)],
    requestId: turnId,
    turnId,
  });

  assert.equal(promotedCount, 1);

  const merged = collector.mergePromotedObservations(turnId, collector.capturedEvents);
  const promoted = merged[0]?.payload?.promoted_observations;
  assert.ok(Array.isArray(promoted) && promoted.length === 1);
  assert.equal(promoted[0].event_type, 'agent.stopped_due_to_loop');
  assert.equal(promoted[0].error_code, 'CMP-LOOP-0001');
});

test('canonical turn event collector stores bounded stream envelope replay metadata', () => {
  const turnId = 'stream-envelope-metadata';
  const collector = new CanonicalTurnEventCollector({ turnId });

  const captured = collector.noteEvent({
    turn_id: turnId,
    kind: 'reasoning_phase',
    phase_id: 'phase-reasoning',
    stream_envelope: {
      sequence: 7,
      sequenceEnd: 9,
      channel: 'reasoning',
      channelSequence: 3,
      channelSequenceEnd: 4,
      eventKind: 'delta',
      phase: {
        phaseId: 'phase-reasoning',
        phaseKind: 'reasoning',
        iteration: 2,
        summary: 'Provider summary',
      },
      payload: {
        prompt: 'do not persist arbitrary payload maps',
        local_path: 'C:/Users/example/secret.txt',
      },
    },
    payload: {
      entries: [{ id: 'reason-1', text: 'Checking.' }],
    },
  });

  assert.deepEqual(captured.payload.stream_envelope, {
    sequence: 7,
    sequence_end: 9,
    channel: 'reasoning',
    channel_sequence: 3,
    channel_sequence_end: 4,
    event_kind: 'delta',
    phase: {
      phase_id: 'phase-reasoning',
      phase_kind: 'reasoning',
      iteration: 2,
      summary: 'Provider summary',
    },
  });
  assert.equal(JSON.stringify(captured.payload.stream_envelope).includes('secret.txt'), false);
  assert.equal(JSON.stringify(captured.payload.stream_envelope).includes('do not persist'), false);
});
