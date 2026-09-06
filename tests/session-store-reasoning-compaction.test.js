'use strict';

// Pins the v14 session-store migration that compacts bloated reasoning_phase
// turn events persisted before commit 0a54288 (2026-06-11). Prior capture
// emitted one event per streamed delta instead of coalescing per phase,
// inflating sessions by 1,000+ events per turn. These tests mirror the
// per-phase coalescing contract in canonical-turn-event-coalescing.test.js
// but exercise the at-rest migration layer instead of the live collector.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  repairSessionForV14,
  mergeReasoningEntriesForCompaction,
  migrateStorePayload,
  STORE_SCHEMA_VERSION,
} = require('../services/backend/session-store-migrations.js');

const TURN_ID = 'stream_migrate_test';

function makeReasoningEvent({
  ordinal = 0,
  turnId = TURN_ID,
  phaseId = 'phase_reasoning_iter1',
  thinkingId = 'think_iter1',
  entryId = 'reasoning_entry_1',
  text = 'some text',
  status = 'open',
  completedAt = '',
  summary = '',
  chunkCount = 1,
} = {}) {
  return {
    event_id: `${turnId}:reasoning_phase:live:${ordinal}`,
    turn_id: turnId,
    kind: 'reasoning_phase',
    status,
    completed_at: completedAt,
    phase_id: phaseId,
    primary_message_id: `assistant_${turnId}`,
    source_message_ids: [`assistant_${turnId}`],
    payload: {
      phase_id: phaseId,
      phase_kind: 'reasoning',
      thinking_id: thinkingId,
      entries: [{ id: entryId, text, thinkingId }],
      chunk_count: chunkCount,
      ...(summary ? { summary } : {}),
    },
  };
}

function makeTextEvent(turnId = TURN_ID) {
  return {
    event_id: `${turnId}:assistant_text_segment:live:0`,
    turn_id: turnId,
    kind: 'assistant_text_segment',
    status: 'completed',
    primary_message_id: `assistant_${turnId}_seg0`,
    payload: { segment_id: `segment_${turnId}_1`, text: 'answer', segment_index: 0 },
  };
}

function makeToolEvent(turnId = TURN_ID) {
  return {
    event_id: `${turnId}:tool_use:call_1`,
    turn_id: turnId,
    kind: 'tool_use',
    tool_call_id: 'call_1',
    primary_message_id: `tool_use_${turnId}_call_1`,
    payload: { tool_name: 'read_file' },
  };
}

function makeSession(turnEvents = []) {
  return { id: 'sess_test', messages: [], turn_events: turnEvents };
}

// ---------------------------------------------------------------------------
// mergeReasoningEntriesForCompaction unit tests
// ---------------------------------------------------------------------------

test('mergeReasoningEntriesForCompaction: new entries append', () => {
  const result = mergeReasoningEntriesForCompaction(
    [{ id: 'a', text: 'a1' }],
    [{ id: 'b', text: 'b1' }]
  );
  assert.deepEqual(result.map((e) => e.id), ['a', 'b']);
});

test('mergeReasoningEntriesForCompaction: existing id replaced with incoming (latest wins)', () => {
  const result = mergeReasoningEntriesForCompaction(
    [{ id: 'a', text: 'partial' }],
    [{ id: 'a', text: 'full' }]
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'full');
});

test('mergeReasoningEntriesForCompaction: preserves order, replaces in place', () => {
  const result = mergeReasoningEntriesForCompaction(
    [{ id: 'a', text: 'a1' }, { id: 'b', text: 'b1' }],
    [{ id: 'a', text: 'a2' }, { id: 'c', text: 'c1' }]
  );
  assert.deepEqual(result.map((e) => [e.id, e.text]), [['a', 'a2'], ['b', 'b1'], ['c', 'c1']]);
});

test('mergeReasoningEntriesForCompaction: handles empty inputs', () => {
  assert.deepEqual(mergeReasoningEntriesForCompaction([], [{ id: 'a', text: 'x' }]), [{ id: 'a', text: 'x' }]);
  assert.deepEqual(mergeReasoningEntriesForCompaction([{ id: 'a', text: 'x' }], []), [{ id: 'a', text: 'x' }]);
  assert.deepEqual(mergeReasoningEntriesForCompaction([], []), []);
});

// ---------------------------------------------------------------------------
// repairSessionForV14 unit tests
// ---------------------------------------------------------------------------

test('repairSessionForV14: session with no turn_events passes through', () => {
  const session = makeSession([]);
  const result = repairSessionForV14(session);
  assert.deepEqual(result.turn_events, []);
});

test('repairSessionForV14: session with no reasoning_phase events passes through unchanged', () => {
  const events = [makeTextEvent(), makeToolEvent()];
  const session = makeSession(events);
  const result = repairSessionForV14(session);
  assert.equal(result.turn_events, session.turn_events);
});

test('repairSessionForV14: 1,415 per-chunk events for one phase compact to one event', () => {
  const events = [];
  for (let chunk = 1; chunk <= 1415; chunk += 1) {
    events.push(makeReasoningEvent({ ordinal: chunk, text: `cumulative text through chunk ${chunk}` }));
  }
  const result = repairSessionForV14(makeSession(events));
  const reasoning = result.turn_events.filter((e) => e.kind === 'reasoning_phase');
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0].payload.entries.length, 1);
  assert.equal(reasoning[0].payload.entries[0].text, 'cumulative text through chunk 1415');
  assert.equal(reasoning[0].payload.chunk_count, 1415);
});

test('repairSessionForV14: distinct phases remain as distinct events', () => {
  const events = [];
  for (let iteration = 1; iteration <= 5; iteration += 1) {
    for (let chunk = 1; chunk <= 20; chunk += 1) {
      events.push(makeReasoningEvent({
        ordinal: iteration - 1,
        phaseId: `phase_reasoning_iter${iteration}`,
        thinkingId: `think_iter${iteration}`,
        entryId: `reasoning_entry_iter${iteration}`,
        text: `iter ${iteration} chunk ${chunk}`,
      }));
    }
  }
  const result = repairSessionForV14(makeSession(events));
  const reasoning = result.turn_events.filter((e) => e.kind === 'reasoning_phase');
  assert.equal(reasoning.length, 5);
  assert.deepEqual(
    reasoning.map((e) => e.phase_id),
    [1, 2, 3, 4, 5].map((i) => `phase_reasoning_iter${i}`)
  );
  assert.equal(reasoning[2].payload.entries[0].text, 'iter 3 chunk 20');
});

test('repairSessionForV14: entry merge by id — multiple entry ids within one phase', () => {
  const events = [
    makeReasoningEvent({ ordinal: 0, entryId: 'entry_a', text: 'a partial' }),
    makeReasoningEvent({ ordinal: 0, entryId: 'entry_a', text: 'a full' }),
    makeReasoningEvent({ ordinal: 0, entryId: 'entry_b', text: 'b partial' }),
    makeReasoningEvent({ ordinal: 0, entryId: 'entry_b', text: 'b full' }),
  ];
  const result = repairSessionForV14(makeSession(events));
  const [event] = result.turn_events;
  assert.deepEqual(
    event.payload.entries.map((e) => [e.id, e.text]),
    [['entry_a', 'a full'], ['entry_b', 'b full']]
  );
});

test('repairSessionForV14: chunk_count is summed across all compacted events', () => {
  const events = [];
  for (let i = 0; i < 10; i += 1) {
    events.push(makeReasoningEvent({ ordinal: i, chunkCount: 3 }));
  }
  const result = repairSessionForV14(makeSession(events));
  assert.equal(result.turn_events[0].payload.chunk_count, 30);
});

test('repairSessionForV14: status and completed_at take the latest values', () => {
  const events = [
    makeReasoningEvent({ ordinal: 0, text: 'thinking', status: 'open' }),
    {
      ...makeReasoningEvent({ ordinal: 0, text: '' }),
      status: 'completed',
      completed_at: '2026-06-11T00:00:01.000Z',
      payload: {
        phase_id: 'phase_reasoning_iter1',
        thinking_id: 'think_iter1',
        summary: 'Worked through the plan',
        chunk_count: 1,
      },
    },
  ];
  const result = repairSessionForV14(makeSession(events));
  assert.equal(result.turn_events.length, 1);
  const [event] = result.turn_events;
  assert.equal(event.status, 'completed');
  assert.equal(event.completed_at, '2026-06-11T00:00:01.000Z');
  assert.equal(event.payload.summary, 'Worked through the plan');
  assert.equal(event.payload.chunk_count, 2);
});

test('repairSessionForV14: non-reasoning event kinds are left untouched', () => {
  const textEvent = makeTextEvent();
  const toolEvent = makeToolEvent();
  const events = [textEvent, makeReasoningEvent({ ordinal: 0 }), toolEvent];
  const result = repairSessionForV14(makeSession(events));
  assert.equal(result.turn_events.length, 3);
  assert.equal(result.turn_events[0], textEvent);
  assert.equal(result.turn_events[2], toolEvent);
});

test('repairSessionForV14: event order — first occurrence holds position, non-reasoning events keep their slots', () => {
  const tool = makeToolEvent();
  const text = makeTextEvent();
  const events = [
    makeReasoningEvent({ ordinal: 0, phaseId: 'phase_1', text: 'chunk 1' }),
    tool,
    makeReasoningEvent({ ordinal: 1, phaseId: 'phase_1', text: 'chunk 2' }),
    text,
    makeReasoningEvent({ ordinal: 2, phaseId: 'phase_2', thinkingId: 'think_2', entryId: 'entry_2', text: 'other phase' }),
  ];
  const result = repairSessionForV14(makeSession(events));
  const output = result.turn_events;
  assert.equal(output.length, 4);
  assert.equal(output[0].kind, 'reasoning_phase');
  assert.equal(output[0].phase_id, 'phase_1');
  assert.equal(output[0].payload.entries[0].text, 'chunk 2');
  assert.equal(output[1], tool);
  assert.equal(output[2], text);
  assert.equal(output[3].kind, 'reasoning_phase');
  assert.equal(output[3].phase_id, 'phase_2');
});

test('repairSessionForV14: reasoning event without phase_id or thinking_id kept as-is', () => {
  const orphan = {
    event_id: 'no_id',
    turn_id: TURN_ID,
    kind: 'reasoning_phase',
    phase_id: '',
    payload: {},
  };
  const result = repairSessionForV14(makeSession([orphan]));
  assert.equal(result.turn_events.length, 1);
  assert.equal(result.turn_events[0], orphan);
});

test('repairSessionForV14: reasoning event with no turn_id kept as-is', () => {
  const orphan = {
    event_id: 'no_turn',
    turn_id: '',
    kind: 'reasoning_phase',
    phase_id: 'phase_1',
    payload: { phase_id: 'phase_1' },
  };
  const result = repairSessionForV14(makeSession([orphan]));
  assert.equal(result.turn_events.length, 1);
  assert.equal(result.turn_events[0], orphan);
});

test('repairSessionForV14: compaction key uses thinking_id when phase_id absent', () => {
  const events = [
    {
      event_id: `${TURN_ID}:reasoning_phase:live:0`,
      turn_id: TURN_ID,
      kind: 'reasoning_phase',
      phase_id: '',
      payload: { thinking_id: 'think_only', entries: [{ id: 'e1', text: 'first' }], chunk_count: 1 },
    },
    {
      event_id: `${TURN_ID}:reasoning_phase:live:1`,
      turn_id: TURN_ID,
      kind: 'reasoning_phase',
      phase_id: '',
      payload: { thinking_id: 'think_only', entries: [{ id: 'e1', text: 'second' }], chunk_count: 1 },
    },
  ];
  const result = repairSessionForV14(makeSession(events));
  assert.equal(result.turn_events.length, 1);
  assert.equal(result.turn_events[0].payload.entries[0].text, 'second');
  assert.equal(result.turn_events[0].payload.chunk_count, 2);
});

test('repairSessionForV14: multiple turns each get their own phase compaction', () => {
  const events = [];
  for (const turnId of ['turn_a', 'turn_b']) {
    for (let chunk = 1; chunk <= 5; chunk += 1) {
      events.push({
        ...makeReasoningEvent({ ordinal: chunk, turnId, phaseId: `phase_1_${turnId}`, text: `${turnId} chunk ${chunk}` }),
        turn_id: turnId,
        phase_id: `phase_1_${turnId}`,
      });
    }
  }
  const result = repairSessionForV14(makeSession(events));
  const reasoning = result.turn_events.filter((e) => e.kind === 'reasoning_phase');
  assert.equal(reasoning.length, 2);
  assert.equal(reasoning[0].payload.chunk_count, 5);
  assert.equal(reasoning[1].payload.chunk_count, 5);
  assert.notEqual(reasoning[0].phase_id, reasoning[1].phase_id);
});

test('repairSessionForV14: null/non-object entries in turn_events are preserved', () => {
  const events = [null, makeReasoningEvent({ ordinal: 0 }), undefined];
  const result = repairSessionForV14(makeSession(events));
  assert.equal(result.turn_events[0], null);
  assert.equal(result.turn_events[2], undefined);
  const reasoning = result.turn_events.filter((e) => e && e.kind === 'reasoning_phase');
  assert.equal(reasoning.length, 1);
});

// ---------------------------------------------------------------------------
// migrateStorePayload v14 integration
// ---------------------------------------------------------------------------

test('migrateStorePayload: v13 payload triggers v14 reasoning compaction', () => {
  const events = [];
  for (let chunk = 1; chunk <= 50; chunk += 1) {
    events.push(makeReasoningEvent({ ordinal: chunk, text: `chunk ${chunk}` }));
  }
  const payload = {
    schema_version: 13,
    sessions: {
      sess_bloated: { id: 'sess_bloated', messages: [], turn_events: events },
    },
  };
  const result = migrateStorePayload(payload);
  assert.equal(result.schema_version, STORE_SCHEMA_VERSION);
  const reasoning = result.sessions.sess_bloated.turn_events.filter((e) => e.kind === 'reasoning_phase');
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0].payload.chunk_count, 50);
  assert.equal(reasoning[0].payload.entries[0].text, 'chunk 50');
});

test('migrateStorePayload: already-v14 payload is not re-migrated', () => {
  const events = [makeReasoningEvent({ ordinal: 0, text: 'already clean' })];
  const payload = {
    schema_version: 14,
    sessions: {
      sess_clean: { id: 'sess_clean', messages: [], turn_events: events },
    },
  };
  const result = migrateStorePayload(payload);
  const reasoning = result.sessions.sess_clean.turn_events.filter((e) => e.kind === 'reasoning_phase');
  assert.equal(reasoning.length, 1);
});

test('migrateStorePayload: sessions without turn_events survive v14 migration', () => {
  const payload = {
    schema_version: 13,
    sessions: {
      sess_empty: { id: 'sess_empty', messages: [], turn_events: [] },
      sess_no_field: { id: 'sess_no_field', messages: [] },
    },
  };
  const result = migrateStorePayload(payload);
  assert.equal(result.schema_version, STORE_SCHEMA_VERSION);
  assert.ok('sess_empty' in result.sessions);
  assert.ok('sess_no_field' in result.sessions);
});
