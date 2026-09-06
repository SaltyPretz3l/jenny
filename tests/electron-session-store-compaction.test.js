// CTL-010: turn_events[] compaction must operate on WHOLE turns, never a raw
// event tail. A bisected turn leaves partial event coverage: the persisted
// projector treats an event-covered turn as authoritative, so the turn's
// uncovered content-bearing messages legacy-render standalone and fire the
// legacy_message_article_markup_render rollout canary as false positives.
// Contract pinned here:
//   - compaction drops OLDEST whole turns (contiguous suffix of newest turns
//     survives intact — no turn is ever bisected, whatever the cut point);
//   - a single turn larger than the whole keep budget is dropped entirely
//     (its messages fall back to message projection — full content, no
//     canary), never retained as an accidental suffix;
//   - the summary marker keeps a SYNTHETIC turn_id that collides with no real
//     turn, so the marker itself cannot mark a dropped turn as event-covered;
//   - re-compaction absorbs prior markers (exactly one marker, cumulative
//     counts);
//   - event_seq stays monotonic across compaction and later appends;
//   - store -> projector round trip renders dropped-turn content from
//     messages with zero rollout canary signals.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');
const {
  createPipelineHarness,
  withWindowGlobals,
  createRenderDom,
} = require('./helpers/render-pipeline-test-harness');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createLogCollector() {
  const entries = [];
  return {
    entries,
    logger(level, event, details = {}) {
      entries.push({ level, event, details });
    },
  };
}

function createStore({ maxEvents, keep, logger } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-ctl010-'));
  trackDirectory(userDataPath);
  return new ElectronSessionStore(path.join(userDataPath, 'sessions.json'), {
    logger,
    maxTurnEventsPerSession: maxEvents,
    turnEventCompactionKeep: keep,
  });
}

// A production-kind multi-event turn: user prompt, reasoning, tool call and
// result, then the assistant answer segment. Five events, five distinct kinds,
// so a raw tail cut lands on a different event type for every keep value.
function turnEvents(turnId, { withTool = true } = {}) {
  const events = [
    {
      event_id: `${turnId}:user_prompt:0`,
      turn_id: turnId,
      kind: 'user_prompt',
      primary_message_id: `user_${turnId}`,
      source_message_ids: [`user_${turnId}`],
      payload: { content: `question for ${turnId}`, attachments: [] },
    },
    {
      event_id: `${turnId}:reasoning:1`,
      turn_id: turnId,
      kind: 'reasoning',
      status: 'completed',
      primary_message_id: `assistant_${turnId}`,
      source_message_ids: [`assistant_${turnId}`],
      payload: { text: 'thinking' },
    },
  ];
  if (withTool) {
    events.push(
      {
        event_id: `${turnId}:tool_use:2`,
        turn_id: turnId,
        kind: 'tool_use',
        status: 'completed',
        tool_call_id: `call_${turnId}`,
        primary_message_id: `tool_use_${turnId}`,
        source_message_ids: [`tool_use_${turnId}`],
        payload: { tool_name: 'Read', input: 'README.md', summary: 'Read README.md' },
      },
      {
        event_id: `${turnId}:tool_result:3`,
        turn_id: turnId,
        kind: 'tool_result',
        status: 'completed',
        tool_call_id: `call_${turnId}`,
        primary_message_id: `tool_result_${turnId}`,
        source_message_ids: [`tool_result_${turnId}`],
        payload: { tool_name: 'Read', output_text: 'file contents', is_error: false },
      }
    );
  }
  events.push({
    event_id: `${turnId}:assistant_text_segment:4`,
    turn_id: turnId,
    kind: 'assistant_text_segment',
    status: 'completed',
    primary_message_id: `assistant_${turnId}`,
    source_message_ids: [`assistant_${turnId}`],
    payload: { text: `answer for ${turnId}`, segment_index: 0, segment_group_index: 0 },
  });
  return events;
}

function groupByTurn(events) {
  const byTurn = new Map();
  for (const event of events) {
    const turnId = String(event.turn_id || '');
    if (!byTurn.has(turnId)) byTurn.set(turnId, []);
    byTurn.get(turnId).push(event);
  }
  return byTurn;
}

function markerEvents(events) {
  return events.filter((event) => event.kind === 'turn_events_compacted');
}

test('compaction drops oldest whole turns and never bisects a surviving turn', () => {
  // Three 5-event turns (15 events). Cap 8 / keep 6: only the newest turn (5
  // events) fits the whole-turn budget; t1 and t2 must drop ENTIRELY. The old
  // tail-slice implementation would instead retain a 6-event suffix that
  // bisects t2 (keeping its tool_result + answer while losing its prompt).
  const logs = createLogCollector();
  const store = createStore({ maxEvents: 8, keep: 6, logger: logs.logger });
  const created = store.createSession({ title: 'Whole turns' });
  store.appendTurnEvents(created.id, [
    ...turnEvents('turn_a'),
    ...turnEvents('turn_b'),
    ...turnEvents('turn_c'),
  ]);

  const events = store.getSessionTurnEvents(created.id);
  const markers = markerEvents(events);
  assert.equal(markers.length, 1);
  const marker = markers[0];
  const realEvents = events.filter((event) => event.kind !== 'turn_events_compacted');
  const byTurn = groupByTurn(realEvents);

  // Newest turn survives whole; older turns leave no events at all.
  assert.deepEqual([...byTurn.keys()], ['turn_c']);
  assert.equal(byTurn.get('turn_c').length, 5);
  assert.deepEqual(
    byTurn.get('turn_c').map((event) => event.kind),
    ['user_prompt', 'reasoning', 'tool_use', 'tool_result', 'assistant_text_segment']
  );

  // The marker must not resurrect event coverage for any real turn.
  assert.equal(['turn_a', 'turn_b', 'turn_c'].includes(marker.turn_id), false);
  assert.equal(marker.payload.compacted_count, 10);
  assert.equal(marker.payload.compacted_turn_count, 2);

  const warn = logs.entries.find((entry) => entry.event === 'session_store.turn_events_compacted');
  assert.ok(warn);
  assert.equal(warn.level, 'WARN');
  assert.equal(warn.details.sessionId, created.id);
  assert.equal(warn.details.compactedCount, 10);
});

test('no keep value can bisect a turn regardless of which event type sits at the cut', () => {
  // Sweep the keep budget across every event type of the middle turn. For
  // each cut point the surviving events must group into WHOLE seeded turns
  // (each retained turn keeps exactly its original 5 events).
  for (let keep = 1; keep <= 10; keep += 1) {
    const store = createStore({ maxEvents: 11, keep });
    const created = store.createSession({ title: `Sweep keep=${keep}` });
    store.appendTurnEvents(created.id, [
      ...turnEvents('turn_a'),
      ...turnEvents('turn_b'),
      ...turnEvents('turn_c'),
    ]);
    const events = store.getSessionTurnEvents(created.id);
    const realEvents = events.filter((event) => event.kind !== 'turn_events_compacted');
    const byTurn = groupByTurn(realEvents);
    for (const [turnId, turnSlice] of byTurn) {
      assert.equal(
        turnSlice.length,
        5,
        `keep=${keep}: turn ${turnId} was bisected (${turnSlice.length} of 5 events)`
      );
    }
    // Survivors are the newest contiguous suffix of turns that fits.
    const expectedTurnCount = Math.floor(Math.min(keep, 10) / 5);
    assert.equal(
      byTurn.size,
      expectedTurnCount,
      `keep=${keep}: expected ${expectedTurnCount} whole surviving turns, got ${byTurn.size}`
    );
  }
});

test('a single turn larger than the whole budget is dropped entirely, not retained as a suffix', () => {
  const store = createStore({ maxEvents: 4, keep: 3 });
  const created = store.createSession({ title: 'Oversized turn' });
  store.appendTurnEvents(created.id, turnEvents('turn_huge'));

  const events = store.getSessionTurnEvents(created.id);
  const realEvents = events.filter((event) => event.kind !== 'turn_events_compacted');
  assert.equal(realEvents.length, 0, 'no accidental suffix of the oversized turn may survive');
  const markers = markerEvents(events);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].payload.compacted_count, 5);
  assert.equal(markers[0].payload.compacted_turn_count, 1);
  assert.equal(markers[0].turn_id === 'turn_huge', false);
});

test('re-compaction absorbs the prior marker into one cumulative marker', () => {
  const store = createStore({ maxEvents: 8, keep: 6 });
  const created = store.createSession({ title: 'Marker merge' });
  store.appendTurnEvents(created.id, [
    ...turnEvents('turn_a'),
    ...turnEvents('turn_b'),
    ...turnEvents('turn_c'),
  ]);
  // First compaction dropped turn_a + turn_b. Appending two more turns forces
  // a second compaction that must absorb the first marker, not stack a new one.
  store.appendTurnEvents(created.id, [
    ...turnEvents('turn_d'),
    ...turnEvents('turn_e'),
  ]);

  const events = store.getSessionTurnEvents(created.id);
  const markers = markerEvents(events);
  assert.equal(markers.length, 1, 'exactly one cumulative marker after re-compaction');
  assert.equal(markers[0].payload.compacted_count, 20);
  assert.equal(markers[0].payload.compacted_turn_count, 4);
  const realEvents = events.filter((event) => event.kind !== 'turn_events_compacted');
  assert.deepEqual([...groupByTurn(realEvents).keys()], ['turn_e']);
});

test('event_seq stays monotonic across compaction and later appends', () => {
  const store = createStore({ maxEvents: 8, keep: 6 });
  const created = store.createSession({ title: 'Seq monotonic' });
  store.appendTurnEvents(created.id, [
    ...turnEvents('turn_a'),
    ...turnEvents('turn_b'),
    ...turnEvents('turn_c'),
  ]);
  const afterCompaction = store.getSessionTurnEvents(created.id);
  const retainedSeqs = afterCompaction
    .filter((event) => event.kind !== 'turn_events_compacted')
    .map((event) => event.event_seq);

  store.appendTurnEvents(created.id, turnEvents('turn_d', { withTool: false }));
  const finalEvents = store.getSessionTurnEvents(created.id);
  const appended = finalEvents.filter((event) => String(event.turn_id) === 'turn_d');
  assert.equal(appended.length, 3);
  const maxRetained = Math.max(...retainedSeqs);
  for (const event of appended) {
    assert.ok(
      event.event_seq > maxRetained,
      `appended seq ${event.event_seq} must exceed retained max ${maxRetained}`
    );
  }
  const realSeqs = finalEvents
    .filter((event) => event.kind !== 'turn_events_compacted')
    .map((event) => event.event_seq);
  for (let index = 1; index < realSeqs.length; index += 1) {
    assert.ok(realSeqs[index] > realSeqs[index - 1], 'stored real events keep ascending event_seq');
  }
});

test('store -> projector round trip renders dropped-turn content with zero rollout canary signals', () => {
  const store = createStore({ maxEvents: 5, keep: 3 });
  const created = store.createSession({ title: 'Round trip' });
  // Two simple turns (user + answer; 3 events each with reasoning). Cap 5 /
  // keep 3: turn_one's events drop whole, turn_two survives whole.
  const simpleTurn = (turnId) => [
    {
      event_id: `${turnId}:user_prompt:0`,
      turn_id: turnId,
      kind: 'user_prompt',
      primary_message_id: `user_${turnId}`,
      source_message_ids: [`user_${turnId}`],
      payload: { content: `question for ${turnId}`, attachments: [] },
    },
    {
      event_id: `${turnId}:reasoning:1`,
      turn_id: turnId,
      kind: 'reasoning',
      status: 'completed',
      primary_message_id: `assistant_${turnId}`,
      source_message_ids: [`assistant_${turnId}`],
      payload: { text: 'thinking' },
    },
    {
      event_id: `${turnId}:assistant_text_segment:2`,
      turn_id: turnId,
      kind: 'assistant_text_segment',
      status: 'completed',
      primary_message_id: `assistant_${turnId}`,
      source_message_ids: [`assistant_${turnId}`],
      payload: { text: `answer for ${turnId}`, segment_index: 0, segment_group_index: 0 },
    },
  ];
  store.appendTurnEvents(created.id, [...simpleTurn('turn_one'), ...simpleTurn('turn_two')]);
  const storedEvents = store.getSessionTurnEvents(created.id);

  // The dropped turn must leave NO events behind (any survivor would mark the
  // turn event-covered and orphan its content messages onto the canary path).
  assert.equal(storedEvents.some((event) => String(event.turn_id) === 'turn_one'), false);

  const sessionId = 'session-ctl010-round-trip';
  const messages = [];
  for (const turnId of ['turn_one', 'turn_two']) {
    messages.push(
      {
        id: `user_${turnId}`,
        role: 'user',
        content: `question for ${turnId}`,
        status: 'complete',
        streamId: turnId,
      },
      {
        id: `assistant_${turnId}`,
        role: 'assistant',
        content: `answer for ${turnId}`,
        status: 'complete',
        streamId: turnId,
      }
    );
  }
  const dom = createRenderDom();
  const harness = createPipelineHarness({
    dom,
    visibleMessages: messages,
    rowModelEnabled: true,
    currentSessionId: sessionId,
    turnEventsBySession: new Map([
      [sessionId, { turnEventLogVersion: 3, turnEvents: storedEvents }],
    ]),
  });
  withWindowGlobals(harness.dom, () => {
    harness.pipeline.renderMessages({ forceFullRender: true });
  });

  const timelineText = harness.dom.window.document.getElementById('timeline').textContent;
  assert.match(timelineText, /question for turn_one/);
  assert.match(timelineText, /answer for turn_one/);
  assert.match(timelineText, /answer for turn_two/);
  const canarySignals = harness.rolloutSignals.filter(
    (entry) => entry.signal === 'legacy_message_article_markup_render'
  );
  assert.deepEqual(canarySignals, [], 'compaction artifacts must not fire the legacy-markup canary');
});
