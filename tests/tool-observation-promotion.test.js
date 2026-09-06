const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildElectronOrphanRepairPromotion,
  buildPromotionsFromToolObservations,
  createPromotedObservationQueue,
  mergePromotedObservationsIntoTurnEvents,
  noteToolObservationPromotions,
} = require('../services/backend/tool-observation-promotion');

test('buildPromotionsFromToolObservations promotes only allowlisted observation rows', () => {
  const promotions = buildPromotionsFromToolObservations([
    {
      kind: 'turn_failed',
      request_id: 'stream-promote',
      summary: 'semantic stuck loop pattern=repeated_errors',
      error_code: 'CMP-LOOP-0018',
      sequence: 7,
    },
    {
      kind: 'turn_failed',
      request_id: 'stream-promote',
      summary: 'per-turn budget exhausted',
      error_code: 'CMP-LOOP-0011',
      sequence: 8,
    },
    {
      kind: 'tool_execution_failed',
      request_id: 'stream-promote',
      tool_call_id: 'call-cancelled',
      tool_name: 'inspect_harness',
      summary: 'tool interrupted',
      error_code: 'CMP-LOOP-0013',
      sequence: 9,
    },
    {
      kind: 'user_approval_rejected',
      request_id: 'stream-promote',
      tool_call_id: 'call-denied',
      tool_name: 'write_file',
      summary: 'user rejected write_file',
      error_code: 'CMP-APPROVAL-REJECTED',
      sequence: 10,
    },
    {
      kind: 'model_visible_text_delta',
      request_id: 'stream-promote',
      summary: 'not a durable promotion',
      sequence: 11,
    },
  ], {
    requestId: 'stream-promote',
    turnId: 'stream-promote',
  });

  assert.deepEqual(
    promotions.map((entry) => entry.promoted_observation.event_type),
    [
      'agent.stopped_due_to_loop',
      'budget.exceeded',
      'tool.cancelled',
      'approval.gap_resolved',
    ]
  );
  assert.equal(promotions[0].target_kind, 'assistant_error');
  assert.equal(promotions[0].target_error_code, 'CMP-LOOP-0018');
  assert.equal(
    promotions[0].promoted_observation.observation_id,
    'stream-promote:tool_observation:7'
  );
  assert.equal(promotions[2].target_kind, 'tool_result');
  assert.equal(promotions[2].target_tool_call_id, 'call-cancelled');
  assert.equal(promotions[2].promoted_observation.source, 'sidecar_tool_observation');
  assert.equal(promotions[3].target_kind, 'approval_resolved');
  assert.equal(promotions[3].target_tool_call_id, 'call-denied');
});

test('mergePromotedObservationsIntoTurnEvents enriches existing events without new kinds', () => {
  const events = [
    {
      event_id: 'stream-promote:assistant_error:0',
      turn_id: 'stream-promote',
      kind: 'assistant_error',
      tool_call_id: '',
      payload: { error_code: 'CMP-LOOP-0018' },
    },
    {
      event_id: 'stream-promote:tool_result:0',
      turn_id: 'stream-promote',
      kind: 'tool_result',
      tool_call_id: 'call-cancelled',
      payload: { error_code: 'CMP-LOOP-0013' },
    },
  ];
  const promotions = buildPromotionsFromToolObservations([
    {
      kind: 'turn_failed',
      request_id: 'stream-promote',
      summary: 'semantic stuck loop pattern=repeated_errors',
      error_code: 'CMP-LOOP-0018',
      sequence: 7,
    },
    {
      kind: 'turn_failed',
      request_id: 'stream-promote',
      summary: 'semantic stuck loop pattern=repeated_errors',
      error_code: 'CMP-LOOP-0018',
      sequence: 7,
    },
    {
      kind: 'tool_execution_failed',
      request_id: 'stream-promote',
      tool_call_id: 'call-cancelled',
      tool_name: 'inspect_harness',
      summary: 'tool interrupted',
      error_code: 'CMP-LOOP-0013',
      sequence: 9,
    },
  ], {
    requestId: 'stream-promote',
    turnId: 'stream-promote',
  });

  const merged = mergePromotedObservationsIntoTurnEvents(events, promotions);

  assert.deepEqual(merged.map((event) => event.kind), ['assistant_error', 'tool_result']);
  assert.equal(merged[0].payload.promoted_observations.length, 1);
  assert.equal(
    merged[0].payload.promoted_observations[0].event_type,
    'agent.stopped_due_to_loop'
  );
  assert.equal(merged[1].payload.promoted_observations.length, 1);
  assert.equal(merged[1].payload.promoted_observations[0].event_type, 'tool.cancelled');
});

test('buildElectronOrphanRepairPromotion creates local cancelled-tool metadata', () => {
  const promotion = buildElectronOrphanRepairPromotion({
    requestId: 'stream-running',
    turnId: 'stream-running',
    toolCallId: 'call-running',
    toolName: 'inspect_harness',
    summary: 'Inspect Harness',
    terminalState: 'interrupted',
  });

  assert.equal(promotion.target_kind, 'tool_result');
  assert.equal(promotion.target_tool_call_id, 'call-running');
  assert.equal(promotion.promoted_observation.event_type, 'tool.cancelled');
  assert.equal(
    promotion.promoted_observation.observation_id,
    'stream-running:electron_orphan_repair:call-running'
  );
  assert.equal(promotion.promoted_observation.source, 'electron_orphan_repair');
  assert.equal(promotion.promoted_observation.error_code, 'CMP-LOOP-0013');
});

test('mergePromotedObservationsIntoTurnEvents skips malformed promotion metadata', () => {
  const events = [
    {
      event_id: 'stream-promote:assistant_error:0',
      turn_id: 'stream-promote',
      kind: 'assistant_error',
      payload: { error_code: 'CMP-LOOP-0018' },
    },
  ];

  mergePromotedObservationsIntoTurnEvents(events, [
    {
      turn_id: 'stream-promote',
      target_kind: 'assistant_error',
      target_error_code: 'CMP-LOOP-0018',
      promoted_observation: {
        event_type: '',
        observation_id: '',
      },
    },
  ]);

  assert.equal(events[0].payload.promoted_observations, undefined);
});

test('noteToolObservationPromotions records promotions and logs fail-open errors', () => {
  const observed = [];
  const turnEventCollector = {
    notePromotedObservation(promotion) {
      observed.push(promotion);
      throw new Error('collector unavailable');
    },
  };
  const logs = [];

  const count = noteToolObservationPromotions({
    turnEventCollector,
    observations: [
      {
        kind: 'tool_execution_failed',
        request_id: 'stream-promote',
        tool_call_id: 'call-cancelled',
        tool_name: 'inspect_harness',
        summary: 'tool interrupted',
        error_code: 'CMP-LOOP-0013',
        sequence: 9,
      },
    ],
    requestId: 'stream-promote',
    turnId: 'stream-promote',
    logger: (level, event, payload) => logs.push({ level, event, payload }),
    logContext: { sessionId: 'session-a', streamId: 'stream-promote' },
  });

  assert.equal(count, 0);
  assert.equal(observed.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].event, 'chat.tool_observation_promotion_failed');
  assert.deepEqual(
    {
      sessionId: logs[0].payload.sessionId,
      streamId: logs[0].payload.streamId,
    },
    {
      sessionId: 'session-a',
      streamId: 'stream-promote',
    }
  );
});

test('noteToolObservationPromotions skips one bad promotion and continues', () => {
  const observed = [];
  const turnEventCollector = {
    notePromotedObservation(promotion) {
      observed.push(promotion);
      if (promotion.promoted_observation.event_type === 'tool.cancelled') {
        throw new Error('first promotion failed');
      }
      return promotion;
    },
  };
  const logs = [];

  const count = noteToolObservationPromotions({
    turnEventCollector,
    observations: [
      {
        kind: 'tool_execution_failed',
        request_id: 'stream-promote',
        tool_call_id: 'call-cancelled',
        tool_name: 'inspect_harness',
        summary: 'tool interrupted',
        error_code: 'CMP-LOOP-0013',
        sequence: 9,
      },
      {
        kind: 'turn_failed',
        request_id: 'stream-promote',
        summary: 'per-turn budget exhausted',
        error_code: 'CMP-LOOP-0011',
        sequence: 10,
      },
    ],
    requestId: 'stream-promote',
    turnId: 'stream-promote',
    logger: (level, event, payload) => logs.push({ level, event, payload }),
    logContext: { sessionId: 'session-a', streamId: 'stream-promote' },
  });

  assert.equal(count, 1);
  assert.deepEqual(
    observed.map((entry) => entry.promoted_observation.event_type),
    ['tool.cancelled', 'budget.exceeded']
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].payload.eventType, 'tool.cancelled');
});

test('createPromotedObservationQueue normalizes, dedupes, and filters by turn', () => {
  const queue = createPromotedObservationQueue({ turnId: 'stream-promote' });
  const promotion = {
    target_kind: 'tool_result',
    target_tool_call_id: 'call-cancelled',
    target_error_code: 'cmp-loop-0013',
    promoted_observation: {
      event_type: 'tool.cancelled',
      observation_id: 'stream-promote:tool_observation:9',
      request_id: 'stream-promote',
      turn_id: '',
      sequence: 9,
    },
  };

  const first = queue.note(promotion);
  const second = queue.note(promotion);

  assert.equal(first, second);
  assert.equal(first.turn_id, 'stream-promote');
  assert.equal(first.target_error_code, 'cmp-loop-0013');
  assert.equal(queue.forTurn('stream-promote').length, 1);
  assert.equal(queue.forTurn('other-turn').length, 0);
  assert.equal(queue.note({ target_kind: 'tool_result' }), null);
});
