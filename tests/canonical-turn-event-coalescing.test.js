'use strict';

// Pins the per-phase coalescing contract for live-captured reasoning_phase
// turn events and the recording-layer helpers (retarget/discard) introduced
// for the session-bloat defect where one streamed turn persisted 1,415
// per-chunk reasoning_phase events (one event per delta instead of one per
// phase) into the session JSON.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CanonicalTurnEventCollector,
} = require('../services/backend/canonical-turn-event-collector.js');

const TURN_ID = 'stream_coalesce';

function makeStubStore(turnEventsRef) {
  const turnEvents = turnEventsRef || [];
  return {
    getSession: () => ({ turn_event_log_version: 0, turn_events: turnEvents }),
    getSessionMessages: () => [],
    getSessionTurnEvents: () => turnEvents,
    appendTurnEvents: (_sessionId, events) => {
      turnEvents.push(...events);
    },
  };
}

function reasoningChunk(collector, {
  ordinal,
  phaseId = 'phase_reasoning_iter1',
  thinkingId = 'think_iter1',
  entryId = 'reasoning_entry_1',
  text,
  primaryMessageId = `assistant_${TURN_ID}`,
}) {
  return collector.noteEvent({
    event_id: `${TURN_ID}:reasoning_phase:live:${ordinal}`,
    turn_id: TURN_ID,
    kind: 'reasoning_phase',
    status: 'open',
    primary_message_id: primaryMessageId,
    source_message_ids: [primaryMessageId],
    phase_id: phaseId,
    payload: {
      phase_id: phaseId,
      phase_kind: 'reasoning',
      thinking_id: thinkingId,
      entries: [{ id: entryId, text, thinkingId }],
      chunk_count: 1,
    },
  });
}

test('streamed reasoning chunks for one phase coalesce into a single captured event', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: TURN_ID });

  // The live path emits one snapshot per delta with a phase-stable event_id;
  // the same entry id carries the growing cumulative text.
  for (let chunk = 1; chunk <= 50; chunk += 1) {
    reasoningChunk(collector, {
      ordinal: 0,
      text: `cumulative text through chunk ${chunk}`,
    });
  }

  const reasoningEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'reasoning_phase'
  );
  assert.equal(reasoningEvents.length, 1);
  const [event] = reasoningEvents;
  assert.equal(event.payload.entries.length, 1);
  assert.equal(event.payload.entries[0].text, 'cumulative text through chunk 50');
  assert.equal(event.payload.chunk_count, 50);
  assert.equal(event.phase_id, 'phase_reasoning_iter1');
});

test('coalescing keys on phase identity even when each chunk has a unique event_id', () => {
  // Regression shape from the defective live session: tool-loop emitted a
  // fresh ordinal per chunk, so every chunk had a unique explicit event_id.
  const collector = new CanonicalTurnEventCollector({ turnId: TURN_ID });
  for (let chunk = 0; chunk < 25; chunk += 1) {
    reasoningChunk(collector, {
      ordinal: chunk,
      text: `chunk ${chunk}`,
    });
  }
  assert.equal(
    collector.capturedEvents.filter((event) => event.kind === 'reasoning_phase').length,
    1
  );
});

test('distinct reasoning phases capture as distinct events', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: TURN_ID });
  for (let iteration = 1; iteration <= 5; iteration += 1) {
    for (let chunk = 1; chunk <= 20; chunk += 1) {
      reasoningChunk(collector, {
        ordinal: iteration - 1,
        phaseId: `phase_reasoning_iter${iteration}`,
        thinkingId: `think_iter${iteration}`,
        entryId: `reasoning_entry_iter${iteration}`,
        text: `iter ${iteration} chunk ${chunk}`,
      });
    }
  }
  const reasoningEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'reasoning_phase'
  );
  assert.equal(reasoningEvents.length, 5);
  assert.deepEqual(
    reasoningEvents.map((event) => event.phase_id),
    [1, 2, 3, 4, 5].map((iteration) => `phase_reasoning_iter${iteration}`)
  );
  assert.equal(reasoningEvents[2].payload.entries[0].text, 'iter 3 chunk 20');
});

test('coalescing merges multiple entry ids within one phase and keeps latest snapshot per id', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: TURN_ID });
  reasoningChunk(collector, { ordinal: 0, entryId: 'entry_a', text: 'a partial' });
  reasoningChunk(collector, { ordinal: 0, entryId: 'entry_a', text: 'a full' });
  reasoningChunk(collector, { ordinal: 0, entryId: 'entry_b', text: 'b partial' });
  reasoningChunk(collector, { ordinal: 0, entryId: 'entry_b', text: 'b full' });
  const [event] = collector.capturedEvents;
  assert.deepEqual(
    event.payload.entries.map((entry) => [entry.id, entry.text]),
    [['entry_a', 'a full'], ['entry_b', 'b full']]
  );
});

test('coalescing updates status, completion, and summary in place', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: TURN_ID });
  reasoningChunk(collector, { ordinal: 0, text: 'thinking' });
  collector.noteEvent({
    event_id: `${TURN_ID}:reasoning_phase:live:0`,
    turn_id: TURN_ID,
    kind: 'reasoning_phase',
    status: 'completed',
    completed_at: '2026-06-11T00:00:01.000Z',
    phase_id: 'phase_reasoning_iter1',
    payload: {
      phase_id: 'phase_reasoning_iter1',
      summary: 'Worked through the plan',
      chunk_count: 1,
    },
  });
  const [event] = collector.capturedEvents;
  assert.equal(collector.capturedEvents.length, 1);
  assert.equal(event.status, 'completed');
  assert.equal(event.completed_at, '2026-06-11T00:00:01.000Z');
  assert.equal(event.payload.summary, 'Worked through the plan');
  assert.equal(event.payload.chunk_count, 2);
});

test('persistFinalizedTurn writes one reasoning event per phase, not per chunk', () => {
  const persisted = [];
  const collector = new CanonicalTurnEventCollector({
    store: makeStubStore(persisted),
    turnId: TURN_ID,
    sessionId: 'session_coalesce',
  });
  for (let iteration = 1; iteration <= 3; iteration += 1) {
    for (let chunk = 1; chunk <= 100; chunk += 1) {
      reasoningChunk(collector, {
        ordinal: iteration - 1,
        phaseId: `phase_reasoning_iter${iteration}`,
        thinkingId: `think_iter${iteration}`,
        entryId: `reasoning_entry_iter${iteration}`,
        text: `iter ${iteration} cumulative ${chunk}`,
      });
    }
  }
  const result = collector.persistFinalizedTurn('session_coalesce', TURN_ID, [
    { id: `user_${TURN_ID}`, role: 'user', content: 'prompt', streamId: TURN_ID },
  ]);
  assert.equal(result.skipped, false);
  const reasoningEvents = persisted.filter((event) => event.kind === 'reasoning_phase');
  assert.equal(reasoningEvents.length, 3);
  for (const event of reasoningEvents) {
    assert.equal(event.payload.entries.length, 1);
    assert.match(event.payload.entries[0].text, /cumulative 100$/);
  }
});

test('persistFinalizedTurn settles captured reasoning from the completed transcript phase', () => {
  const persisted = [];
  const collector = new CanonicalTurnEventCollector({
    store: makeStubStore(persisted),
    turnId: TURN_ID,
    sessionId: 'session_coalesce',
  });
  reasoningChunk(collector, {
    ordinal: 0,
    phaseId: 'phase_reasoning_iter1',
    thinkingId: 'think_iter1',
    text: 'finished reasoning',
  });

  collector.persistFinalizedTurn('session_coalesce', TURN_ID, [
    { id: `user_${TURN_ID}`, role: 'user', content: 'prompt', streamId: TURN_ID },
    {
      id: `assistant_${TURN_ID}`,
      role: 'assistant',
      content: 'answer',
      status: 'complete',
      streamId: TURN_ID,
      reasoning: {
        source: 'provider',
        status: 'complete',
        entries: [{ id: 'reasoning_entry_1', text: 'finished reasoning', thinkingId: 'think_iter1' }],
      },
      reasoning_phases: [{
        phaseId: 'phase_reasoning_iter1',
        phaseKind: 'reasoning',
        thinkingId: 'think_iter1',
        completed: true,
        startedAt: '2026-06-11T00:00:00.000Z',
        completedAt: '2026-06-11T00:00:01.000Z',
      }],
      phases: [{
        phase_id: 'phase_reasoning_iter1',
        phase_kind: 'reasoning',
        thinking_id: 'think_iter1',
        started_at: '2026-06-11T00:00:00.000Z',
        completed_at: '2026-06-11T00:00:01.000Z',
        entries: [{ id: 'reasoning_entry_1', text: 'finished reasoning', thinkingId: 'think_iter1' }],
      }],
    },
  ]);

  const event = persisted.find((candidate) => candidate.kind === 'reasoning_phase');
  assert.equal(event?.status, 'completed');
  assert.equal(event?.completed_at, '2026-06-11T00:00:01.000Z');
  assert.equal(event?.payload?.completed, true);
});

test('retargetCapturedEvents repoints reasoning events for a phase onto the persisted segment message', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: TURN_ID });
  reasoningChunk(collector, { ordinal: 0, text: 'pre-tool reasoning' });
  reasoningChunk(collector, {
    ordinal: 1,
    phaseId: 'phase_reasoning_iter2',
    thinkingId: 'think_iter2',
    entryId: 'reasoning_entry_iter2',
    text: 'post-tool reasoning',
  });

  const retargeted = collector.retargetCapturedEvents(TURN_ID, {
    phaseIds: ['phase_reasoning_iter1'],
    messageId: `assistant_${TURN_ID}_seg0`,
  });
  assert.equal(retargeted, 1);
  const [first, second] = collector.capturedEvents;
  assert.equal(first.primary_message_id, `assistant_${TURN_ID}_seg0`);
  assert.deepEqual(first.source_message_ids, [`assistant_${TURN_ID}_seg0`]);
  // The other phase keeps its original target.
  assert.equal(second.primary_message_id, `assistant_${TURN_ID}`);
});

test('discardCapturedEvents drops live text/reasoning capture after a stream reset', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: TURN_ID });
  reasoningChunk(collector, { ordinal: 0, text: 'discarded reasoning' });
  collector.noteEvent({
    event_id: `${TURN_ID}:assistant_text_segment:live:0`,
    turn_id: TURN_ID,
    kind: 'assistant_text_segment',
    primary_message_id: `assistant_${TURN_ID}_seg0`,
    payload: { segment_id: `segment_${TURN_ID}_1`, text: 'discarded text', segment_index: 0 },
  });
  collector.noteEvent({
    turn_id: TURN_ID,
    kind: 'tool_use',
    tool_call_id: 'call_keep',
    primary_message_id: `tool_use_${TURN_ID}_call_keep`,
    payload: { tool_name: 'read_file' },
  });

  const discarded = collector.discardCapturedEvents(TURN_ID, [
    'assistant_text_segment',
    'reasoning_phase',
  ]);
  assert.equal(discarded, 2);
  assert.deepEqual(
    collector.capturedEvents.map((event) => event.kind),
    ['tool_use']
  );
  // The dedupe slot is freed: a re-streamed phase captures fresh.
  reasoningChunk(collector, { ordinal: 1, text: 'fresh reasoning after reset' });
  assert.equal(
    collector.capturedEvents.filter((event) => event.kind === 'reasoning_phase').length,
    1
  );
});

test('discardCapturedEvents can limit replacement to the active message slice', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: TURN_ID });
  collector.noteEvent({
    event_id: `${TURN_ID}:assistant_text_segment:preserved`,
    turn_id: TURN_ID,
    kind: 'assistant_text_segment',
    primary_message_id: `assistant_${TURN_ID}_seg0`,
    payload: { text: 'preserved' },
  });
  collector.noteEvent({
    event_id: `${TURN_ID}:assistant_text_segment:active`,
    turn_id: TURN_ID,
    kind: 'assistant_text_segment',
    primary_message_id: `assistant_${TURN_ID}`,
    payload: { text: 'replace me' },
  });

  const discarded = collector.discardCapturedEvents(
    TURN_ID,
    ['assistant_text_segment'],
    { primaryMessageId: `assistant_${TURN_ID}` },
  );

  assert.equal(discarded, 1);
  assert.deepEqual(
    collector.capturedEvents.map((event) => event.primary_message_id),
    [`assistant_${TURN_ID}_seg0`],
  );
});

test('live-captured text segments supersede their projected duplicates at finalize', () => {
  const persisted = [];
  const collector = new CanonicalTurnEventCollector({
    store: makeStubStore(persisted),
    turnId: TURN_ID,
    sessionId: 'session_text_dedupe',
  });
  reasoningChunk(collector, { ordinal: 0, text: 'reasoning before answer' });
  collector.noteEvent({
    event_id: `${TURN_ID}:assistant_text_segment:live:0`,
    turn_id: TURN_ID,
    kind: 'assistant_text_segment',
    status: 'completed',
    primary_message_id: `assistant_${TURN_ID}_seg0`,
    source_message_ids: [`assistant_${TURN_ID}_seg0`],
    segment_group_index: 0,
    phase_id: 'phase_text_iter1',
    payload: {
      segment_id: `segment_${TURN_ID}_1`,
      phase_id: 'phase_text_iter1',
      text: 'The visible answer.',
      segment_index: 0,
    },
  });
  const messages = [
    { id: `user_${TURN_ID}`, role: 'user', content: 'prompt', streamId: TURN_ID },
    {
      id: `assistant_${TURN_ID}_seg0`,
      role: 'assistant',
      content: 'The visible answer.',
      parent_stream_id: TURN_ID,
      visible_segments: [
        {
          segment_id: `segment_${TURN_ID}_1`,
          phase_id: 'phase_text_iter1',
          text: 'The visible answer.',
        },
      ],
      phases: [
        {
          phase_id: 'phase_text_iter1',
          phase_kind: 'text',
        },
      ],
    },
  ];
  const result = collector.persistFinalizedTurn('session_text_dedupe', TURN_ID, messages);
  assert.equal(result.skipped, false);
  const textEvents = persisted.filter((event) => event.kind === 'assistant_text_segment');
  assert.equal(textEvents.length, 1);
  assert.equal(textEvents[0].payload.segment_index, 0);
  assert.equal(textEvents[0].payload.text, 'The visible answer.');
  assert.equal(textEvents[0].primary_message_id, `assistant_${TURN_ID}_seg0`);
});
