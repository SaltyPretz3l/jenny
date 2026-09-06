'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CanonicalTurnEventCollector,
} = require('../../services/backend/canonical-turn-event-collector.js');

const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'replays');
const VOLATILE_TURN_EVENT_FIELDS = Object.freeze([
  'event_id',
  'event_seq',
  'started_at',
  'completed_at',
  'turn_id',
]);

function readFixtureFiles() {
  if (!fs.existsSync(FIXTURE_ROOT)) {
    return [];
  }
  return fs
    .readdirSync(FIXTURE_ROOT)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function loadFixture(filename) {
  const raw = fs.readFileSync(path.join(FIXTURE_ROOT, filename), 'utf8');
  return JSON.parse(raw);
}

function stripVolatile(entry) {
  const cloned = { ...entry };
  for (const key of VOLATILE_TURN_EVENT_FIELDS) {
    delete cloned[key];
  }
  return cloned;
}

function makeStubStore() {
  return {
    persistTurnEvents: () => {},
    persistFinalizedTurn: () => {},
    finalizeTurn: () => {},
  };
}

const CANONICAL_TYPE_BY_KIND = Object.freeze({
  assistant_text_segment: 'text_part_completed',
  reasoning_phase: 'reasoning_part_completed',
  tool_use: 'tool_call_requested',
  tool_executing: 'tool_execution_started',
  approval_requested: 'tool_approval_requested',
  approval_resolved: 'tool_approval_resolved',
});

function documentedToolCalls(fixture) {
  const calls = Array.isArray(fixture?.expected_generation_result?.tool_calls)
    ? fixture.expected_generation_result.tool_calls.map((call) => ({
      callId: call.call_id,
      toolName: call.tool_id,
      toolInput: call.arguments,
      outcome: 'completed',
    }))
    : [];
  const family = fixture?.metadata?.fixture_family;
  if (family === 'malformed_tool_arguments') {
    return [{
      callId: 'call_bad',
      toolName: 'read_file',
      toolInput: {},
      outcome: 'malformed',
    }];
  }
  if (family === 'tool_call_canceled_or_rejected') {
    return [{
      callId: 'call_dangerous_op',
      toolName: fixture?.approval_resolution?.tool_name,
      toolInput: {},
      outcome: 'rejected',
    }];
  }
  return calls;
}

function canonicalPartKind(canonicalType) {
  if (canonicalType.startsWith('text_')) return 'text_part';
  if (canonicalType.startsWith('reasoning_')) return 'reasoning_part';
  return 'tool_part';
}

function assertCanonicalFixtureOracle(filename, fixture, events) {
  assert.ok(
    Array.isArray(events) && events.length > 0,
    `${filename} must define at least one expected_turn_events entry`
  );

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const seq = index + 1;
    const canonicalType = event?.kind === 'tool_result'
      ? (event?.payload?.success === false ? 'tool_execution_failed' : 'tool_execution_completed')
      : CANONICAL_TYPE_BY_KIND[event?.kind];
    assert.equal(event?.turn_id, 't_replay', `${filename} event ${seq} turn_id`);
    assert.equal(event?.event_id, `t_replay:canonical:${seq}`, `${filename} event ${seq} event_id`);
    assert.equal(event?.payload?.canonical_seq, seq, `${filename} event ${seq} canonical_seq`);
    assert.equal(
      event?.payload?.canonical_event_type,
      canonicalType,
      `${filename} event ${seq} canonical_event_type`
    );
    assert.equal(
      event?.payload?.canonical_part_id,
      `t_replay:${canonicalPartKind(canonicalType)}:${seq}`,
      `${filename} event ${seq} canonical_part_id`
    );
  }

  const tokenText = (fixture.expected_notifications || [])
    .filter((entry) => entry?.method === 'chat.token')
    .map((entry) => String(entry?.params?.delta || ''))
    .join('');
  const textEvents = events.filter((event) => event.kind === 'assistant_text_segment');
  assert.equal(textEvents.map((event) => event.payload.text).join(''), tokenText, `${filename} text`);

  const thinkingDeltas = (fixture.expected_notifications || [])
    .filter((entry) => entry?.method === 'chat.thinking' && entry?.params?.kind === 'reasoning')
    .map((entry) => String(entry?.params?.delta || ''));
  const reasoningEvents = events.filter((event) => event.kind === 'reasoning_phase');
  const reasoningEntries = reasoningEvents.flatMap((event) => event.payload.entries || []);
  assert.deepEqual(
    reasoningEntries.map((entry) => entry.text),
    thinkingDeltas,
    `${filename} reasoning deltas`
  );
  for (const event of reasoningEvents) {
    assert.match(
      event.payload.thinking_id,
      /^t_replay:reasoning_part:\d+$/,
      `${filename} canonical thinking_id`
    );
    assert.equal(event.payload.chunk_count, event.payload.entries.length, `${filename} chunk_count`);
  }

  const documentedCalls = documentedToolCalls(fixture);
  const toolUseIds = events
    .filter((event) => event.kind === 'tool_use')
    .map((event) => event.tool_call_id);
  assert.deepEqual(
    toolUseIds,
    documentedCalls.map((call) => call.callId),
    `${filename} tool request order`
  );
  for (const call of documentedCalls) {
    const callEvents = events.filter((event) => event.tool_call_id === call.callId);
    const toolUse = callEvents.find((event) => event.kind === 'tool_use');
    const toolResult = callEvents.find((event) => event.kind === 'tool_result');
    assert.equal(toolUse?.payload?.tool_name, call.toolName, `${filename} ${call.callId} tool_name`);
    assert.deepEqual(toolUse?.payload?.tool_input, call.toolInput, `${filename} ${call.callId} input`);
    assert.ok(toolResult, `${filename} ${call.callId} must have a tool_result`);
    if (call.outcome === 'completed') {
      assert.ok(
        callEvents.some((event) => event.kind === 'tool_executing'),
        `${filename} ${call.callId} must execute`
      );
      assert.equal(toolResult.payload.success, true, `${filename} ${call.callId} success`);
    } else {
      assert.equal(toolResult.payload.success, false, `${filename} ${call.callId} failure`);
      assert.equal(
        toolResult.payload.error_code,
        call.outcome === 'malformed' ? 'CMP-LOOP-0002' : 'CMP-APPROVAL-REJECTED',
        `${filename} ${call.callId} error_code`
      );
    }
    if (call.outcome === 'rejected') {
      assert.deepEqual(
        callEvents.filter((event) => event.kind.startsWith('approval_')).map((event) => event.kind),
        ['approval_requested', 'approval_resolved'],
        `${filename} ${call.callId} approval lifecycle`
      );
    }
  }
}

const fixtureFiles = readFixtureFiles();

test('replay corpus directory exists with fixtures', () => {
  assert.ok(fixtureFiles.length > 0, 'Expected at least one fixture under tests/fixtures/replays/');
});

test('replay corpus fixtures have non-empty canonical turn-event expectations', () => {
  for (const filename of fixtureFiles) {
    const fixture = loadFixture(filename);
    assertCanonicalFixtureOracle(filename, fixture, fixture.expected_turn_events);
  }
});

test('canonical collector coalesces live reasoning chunks per phase and flushes before tool events', () => {
  const journalAppends = [];
  const collector = new CanonicalTurnEventCollector({
    store: makeStubStore(),
    turnId: 'turn_journal_batch',
    sessionId: 'session_journal_batch',
    journal: {
      append(sessionId, turnId, events) {
        journalAppends.push({ sessionId, turnId, events });
      },
      clear() {},
    },
  });

  for (let index = 0; index < 12; index += 1) {
    collector.noteEvent({
      event_id: `turn_journal_batch:reasoning_phase:live:${index}`,
      turn_id: 'turn_journal_batch',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_turn_journal_batch',
      source_message_ids: ['assistant_turn_journal_batch'],
      phase_id: 'phase_reasoning',
      payload: {
        phase_id: 'phase_reasoning',
        thinking_id: 'think_batch',
        entries: [{ id: `reason_${index}`, text: `Reasoning chunk ${index}.` }],
      },
    });
  }
  assert.ok(
    journalAppends.length < 12,
    `expected fewer journal writes than reasoning chunks, saw ${journalAppends.length}`
  );
  // Per-phase coalescing: one captured event for the whole streamed phase.
  assert.equal(
    collector.capturedEvents.filter((event) => event.kind === 'reasoning_phase').length,
    1
  );

  collector.noteEvent({
    event_id: 'turn_journal_batch:tool_use:live:0',
    turn_id: 'turn_journal_batch',
    kind: 'tool_use',
    primary_message_id: 'tool_use_turn_journal_batch',
    source_message_ids: ['tool_use_turn_journal_batch'],
    tool_call_id: 'call_batch',
    payload: { tool_name: 'read_file' },
  });

  const flattened = journalAppends.flatMap((entry) => entry.events);
  const journaledReasoning = flattened.filter((event) => event.kind === 'reasoning_phase');
  // One journaled reasoning event per phase, carrying every streamed entry.
  assert.equal(journaledReasoning.length, 1);
  assert.equal(journaledReasoning[0].payload.entries.length, 12);
  assert.equal(flattened.at(-1).kind, 'tool_use');
});

test('canonical collector finalization keeps captured reasoning before and after tool events', () => {
  const collector = new CanonicalTurnEventCollector({
    store: makeStubStore(),
    turnId: 'turn_order',
    sessionId: 'session_order',
  });
  const messages = [
    { id: 'user_turn_order', role: 'user', content: 'Inspect the harness.' },
    {
      id: 'assistant_notice_turn_order',
      role: 'assistant',
      streamId: 'turn_order',
      content: '',
      agent_status: { summary: 'Preparing tool context.' },
    },
    {
      id: 'tool_use_turn_order',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_order',
        tool_name: 'inspect_harness',
        parent_stream_id: 'turn_order',
        status: 'completed',
      },
    },
    {
      id: 'tool_result_turn_order',
      role: 'tool',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_order',
        tool_name: 'inspect_harness',
        parent_stream_id: 'turn_order',
        output_text: '{}',
      },
    },
    {
      id: 'assistant_turn_order',
      role: 'assistant',
      streamId: 'turn_order',
      content: 'The harness is empty.',
      reasoning: {
        source: 'provider',
        entries: [
          { id: 'reason_pre', text: 'Need the tool.' },
          { id: 'reason_post', text: 'Use the result.' },
        ],
      },
    },
  ];

  collector.noteEvent({
    event_id: 'turn_order:reasoning_phase:live:0',
    turn_id: 'turn_order',
    kind: 'reasoning_phase',
    primary_message_id: 'assistant_turn_order',
    source_message_ids: ['assistant_turn_order'],
    phase_id: 'phase_pre',
    payload: {
      phase_id: 'phase_pre',
      thinking_id: 'think_pre',
      entries: [{ id: 'reason_pre', text: 'Need the tool.' }],
    },
  });
  collector.noteEvent({
    event_id: 'turn_order:tool_use:live:0',
    turn_id: 'turn_order',
    kind: 'tool_use',
    primary_message_id: 'tool_use_turn_order',
    source_message_ids: ['tool_use_turn_order'],
    tool_call_id: 'call_order',
    payload: { tool_name: 'inspect_harness' },
  });
  collector.noteEvent({
    event_id: 'turn_order:tool_executing:live:0',
    turn_id: 'turn_order',
    kind: 'tool_executing',
    primary_message_id: 'tool_use_turn_order',
    source_message_ids: ['tool_use_turn_order'],
    tool_call_id: 'call_order',
    payload: { tool_name: 'inspect_harness' },
  });
  collector.noteEvent({
    event_id: 'turn_order:tool_result:live:0',
    turn_id: 'turn_order',
    kind: 'tool_result',
    primary_message_id: 'tool_result_turn_order',
    source_message_ids: ['tool_result_turn_order'],
    tool_call_id: 'call_order',
    payload: { tool_name: 'inspect_harness', output_text: '{}', is_error: false },
  });
  collector.noteEvent({
    event_id: 'turn_order:reasoning_phase:live:1',
    turn_id: 'turn_order',
    kind: 'reasoning_phase',
    primary_message_id: 'assistant_turn_order',
    source_message_ids: ['assistant_turn_order'],
    phase_id: 'phase_post',
    payload: {
      phase_id: 'phase_post',
      thinking_id: 'think_post',
      entries: [{ id: 'reason_post', text: 'Use the result.' }],
    },
  });

  const finalized = collector.buildFinalizedTurnEvents('turn_order', messages);

  assert.deepEqual(
    finalized.map((event) => event.kind),
    [
      'user_prompt',
      'system_notice',
      'reasoning_phase',
      'tool_use',
      'tool_executing',
      'tool_result',
      'reasoning_phase',
      'assistant_text_segment',
    ]
  );
  assert.deepEqual(
    finalized
      .filter((event) => event.kind === 'reasoning_phase')
      .map((event) => event.payload.entries[0].text),
    ['Need the tool.', 'Use the result.']
  );
  assert.equal(finalized[1].payload.subkind, 'agent_status');
});

test('canonical collector keeps internal capture ordering out of stored events', () => {
  const journalEvents = [];
  const collector = new CanonicalTurnEventCollector({
    store: makeStubStore(),
    turnId: 'turn_storage_shape',
    sessionId: 'session_storage_shape',
    journal: {
      append(_sessionId, _turnId, events) {
        journalEvents.push(...events);
      },
    },
  });
  const messages = [
    { id: 'user_storage_shape', role: 'user', content: 'Run a tool.' },
    {
      id: 'tool_use_storage_shape',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_storage_shape',
        tool_name: 'inspect_harness',
        parent_stream_id: 'turn_storage_shape',
        status: 'completed',
      },
    },
    {
      id: 'tool_result_storage_shape',
      role: 'tool',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_storage_shape',
        tool_name: 'inspect_harness',
        parent_stream_id: 'turn_storage_shape',
        output_text: '{}',
      },
    },
    {
      id: 'assistant_storage_shape',
      role: 'assistant',
      streamId: 'turn_storage_shape',
      content: 'Done.',
    },
  ];

  collector.noteEvent({
    event_id: 'turn_storage_shape:tool_use:live:0',
    turn_id: 'turn_storage_shape',
    kind: 'tool_use',
    primary_message_id: 'tool_use_storage_shape',
    source_message_ids: ['tool_use_storage_shape'],
    tool_call_id: 'call_storage_shape',
    payload: { tool_name: 'inspect_harness' },
  });
  collector.noteEvent({
    event_id: 'turn_storage_shape:tool_result:live:0',
    turn_id: 'turn_storage_shape',
    kind: 'tool_result',
    primary_message_id: 'tool_result_storage_shape',
    source_message_ids: ['tool_result_storage_shape'],
    tool_call_id: 'call_storage_shape',
    payload: { tool_name: 'inspect_harness', output_text: '{}', is_error: false },
  });

  const finalized = collector.buildFinalizedTurnEvents('turn_storage_shape', messages);

  assert.equal(journalEvents.length, 2);
  assert.equal(finalized.some((event) => Object.hasOwn(event, '_capture_order')), false);
  assert.equal(journalEvents.some((event) => Object.hasOwn(event, '_capture_order')), false);
});

for (const filename of fixtureFiles) {
  const fixture = loadFixture(filename);
  const targetPhase = fixture?.metadata?.target_phase;
  const description = fixture?.metadata?.description ?? '';
  const turnId = 't_replay';

  const skip = Number.isInteger(targetPhase) && targetPhase >= 5;
  const todo = !skip && targetPhase === 4 ? `Phase 4: ${description}` : null;
  const testOptions = skip ? { skip: `Phase ${targetPhase}: ${description}` } : todo ? { todo } : {};

  test(`replay corpus ${filename} round-trips through CanonicalTurnEventCollector`, testOptions, () => {
    const collector = new CanonicalTurnEventCollector({
      store: makeStubStore(),
      turnId,
      sessionId: 's_replay',
      canonicalPrimary: true,
    });

    const expectedTurnEvents = Array.isArray(fixture.expected_turn_events)
      ? fixture.expected_turn_events
      : [];

    for (const entry of expectedTurnEvents) {
      collector.noteEvent({
        ...entry,
        turn_id: turnId,
      });
    }

    const finalized = collector.buildFinalizedTurnEvents(turnId, []);
    const finalizedStripped = (finalized || []).map(stripVolatile);
    const expectedStripped = expectedTurnEvents.map(stripVolatile);

    assert.deepStrictEqual(finalizedStripped, expectedStripped);
  });
}
