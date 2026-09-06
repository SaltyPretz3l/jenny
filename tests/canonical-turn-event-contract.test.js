'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_TURN_COUNTER_FIELDS,
  CANONICAL_TURN_SCHEMA_VERSION,
  DURABLE_EVENT_TYPES,
  EVENT_CAPS,
  EPHEMERAL_EVENT_TYPES,
  UNPERSISTED_DURABLE_TYPES,
  buildCanonicalTurnEvent,
  reduceToTurnEventKind,
  validateTurnEvent,
} = require('../services/backend/canonical-turn-event');
const {
  CanonicalTurnEventCollector,
  buildPersistedTurnEvent,
} = require('../services/backend/canonical-turn-event-collector');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'canonical-turn-events', 'cases.json');

function fixtureCases() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).cases;
}

test('Packet 0 JS contract constants lock schema caps and counters', () => {
  assert.equal(CANONICAL_TURN_SCHEMA_VERSION, 1);
  assert.equal(EVENT_CAPS.id, 128);
  assert.equal(EVENT_CAPS.text_delta, 8192);
  assert.equal(EVENT_CAPS.reasoning_delta, 4096);
  assert.equal(EVENT_CAPS.tool_input_summary, 8192);
  assert.equal(EVENT_CAPS.tool_output_summary, 16384);
  assert.equal(EVENT_CAPS.event_payload_bytes, 32768);
  assert.equal(EPHEMERAL_EVENT_TYPES.has('tool_input_delta'), true);
  assert.deepEqual(CANONICAL_TURN_COUNTER_FIELDS, [
    'canonical_events_emitted',
    'legacy_notifications_emitted',
    'canonical_event_bytes',
    'legacy_notification_bytes',
    'sidecar_notification_to_electron_ms',
    'electron_ingest_to_renderer_commit_ms',
    'orphan_tool_repair_count',
    'live_replay_divergence_count',
    'unknown_or_dropped_canonical_event_count',
  ]);
});

test('durable event types are exhaustively partitioned by persistence', () => {
  const persistedTypes = new Set([...DURABLE_EVENT_TYPES].filter((type) => (
    reduceToTurnEventKind({ type, durability: 'durable' }) !== null
  )));
  assert.deepEqual(
    new Set([...persistedTypes, ...UNPERSISTED_DURABLE_TYPES]),
    DURABLE_EVENT_TYPES
  );
  assert.deepEqual(
    [...persistedTypes].filter((type) => UNPERSISTED_DURABLE_TYPES.has(type)),
    []
  );
});

test('buildCanonicalTurnEvent assigns stable ids and part ids', () => {
  const event = buildCanonicalTurnEvent({
    type: 'text_part_completed',
    turn_id: 'turn_abc',
    seq: 3,
    payload: { text: 'Hello' },
  });

  assert.equal(event.event_id, 'turn_abc:canonical:3');
  assert.equal(event.part_id, 'turn_abc:text_part:3');
  assert.equal(event.durability, 'durable');
  assert.equal(event.payload.text, 'Hello');
});

test('validateTurnEvent matches shared fixture cases', () => {
  for (const item of fixtureCases()) {
    const result = validateTurnEvent(item.input);
    const expected = item.expected;

    assert.equal(result.status, expected.status, item.name);
    if (expected.status !== 'accepted') {
      assert.equal(result.event, null);
      assert.equal(result.diagnostics[0].code, expected.diagnostic_code);
      continue;
    }

    assert.equal(result.event.durability, expected.durability);
    if (expected.event_id) assert.equal(result.event.event_id, expected.event_id);
    if (expected.part_id) assert.equal(result.event.part_id, expected.part_id);
    assert.equal(reduceToTurnEventKind(result.event), expected.persisted_kind);
    if (expected.sanitized_payload) {
      assert.deepEqual(result.event.payload, expected.sanitized_payload, item.name);
    }
    const serialized = JSON.stringify(result.event);
    for (const needle of expected.redacted_substrings_absent || []) {
      assert.equal(serialized.includes(needle), false, needle);
    }
    // Presence assertions pin the redaction *shape*, not just the absence of
    // the raw value: the file:/// prefix survives its own redaction token, and
    // scheme separators in http(s) URLs stay legible instead of being read as
    // drive letters. Mirrored in the Python suite; keep in sync.
    for (const needle of expected.redacted_substrings_present || []) {
      assert.equal(serialized.includes(needle), true, needle);
    }
  }
});

test('validateTurnEvent rejects non-finite seq and version without throwing', () => {
  // CTL-015 parity table, non-finite rows: these cannot ride the shared JSON
  // fixture (JSON has no NaN/Infinity literals), so both language suites pin
  // them natively with identical verdicts.
  for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
    const seqResult = validateTurnEvent({
      v: 1,
      turn_id: 'turn_nonfinite',
      seq: bad,
      type: 'text_delta',
      payload: { delta: 'x' },
    });
    assert.equal(seqResult.status, 'dropped', `seq ${bad}`);
    assert.equal(seqResult.diagnostics[0].code, 'invalid_seq', `seq ${bad}`);

    const versionResult = validateTurnEvent({
      v: bad,
      turn_id: 'turn_nonfinite',
      seq: 1,
      type: 'text_delta',
      payload: { delta: 'x' },
    });
    assert.equal(versionResult.status, 'unsupported', `v ${bad}`);
    assert.equal(versionResult.diagnostics[0].code, 'unsupported_version', `v ${bad}`);
  }
});

test('validateTurnEvent caps payload fields and reports truncation', () => {
  const result = validateTurnEvent({
    v: 1,
    turn_id: 'turn_caps',
    seq: 5,
    type: 'text_delta',
    payload: { delta: 'x'.repeat(EVENT_CAPS.text_delta + 100) },
  });

  assert.equal(result.status, 'accepted');
  assert.equal(result.event.payload.delta, 'x'.repeat(EVENT_CAPS.text_delta));
  assert.equal(result.diagnostics.some((entry) => entry.code === 'payload_truncated'), true);
});

test('approval presentation fields are independently capped and redacted', () => {
  const result = validateTurnEvent({
    v: 1,
    turn_id: 'turn_approval_policy',
    seq: 6,
    type: 'tool_approval_requested',
    tool_call_id: 'call_approval_policy',
    payload: {
      policy_scope: `Workspace ${'x'.repeat(200)}`,
      policy_consequence: 'May change C:/Users/example/private.txt with api_key=sk-abcdefghijklmnop',
      reason: `Approval needs api_key=sk-abcdefghijklmnop ${'x'.repeat(3000)}`,
    },
  });

  assert.equal(result.status, 'accepted');
  assert.equal(Buffer.byteLength(result.event.payload.policy_scope, 'utf8') <= 120, true);
  assert.equal(result.event.payload.policy_consequence.includes('C:/Users/example/private.txt'), false);
  assert.equal(result.event.payload.policy_consequence.includes('sk-abcdefghijklmnop'), false);
  assert.equal(Buffer.byteLength(result.event.payload.reason, 'utf8') <= EVENT_CAPS.approval_reason, true);
  assert.equal(result.event.payload.reason.includes('sk-abcdefghijklmnop'), false);
});

test('validateTurnEvent rejects malformed identifiers instead of stringifying them', () => {
  for (const turnId of [0, false, ['turn_array'], { id: 'turn_object' }, 'bad id', '会話']) {
    const result = validateTurnEvent({
      v: 1, turn_id: turnId, seq: 1, type: 'text_delta', payload: { delta: 'x' },
    });
    assert.equal(result.status, 'dropped');
    assert.equal(result.diagnostics[0].code, 'missing_turn_id');
  }
});

test('validateTurnEvent uses UTF-8 caps and contains structural bombs', () => {
  const cjk = validateTurnEvent({
    v: 1,
    turn_id: 'turn_cjk',
    seq: 1,
    type: 'text_delta',
    payload: { delta: '会'.repeat(EVENT_CAPS.text_delta) },
  });
  assert.equal(Buffer.byteLength(cjk.event.payload.delta, 'utf8') <= EVENT_CAPS.text_delta, true);
  assert.equal(cjk.diagnostics.some((entry) => entry.code === 'payload_truncated'), true);

  let deep = { leaf: true };
  for (let index = 0; index < 14; index += 1) deep = { child: deep };
  const bomb = validateTurnEvent({
    v: 1, turn_id: 'turn_depth', seq: 1, type: 'status_part', payload: deep,
  });
  assert.equal(bomb.status, 'accepted');
  assert.deepEqual(bomb.event.payload, { truncated: true, summary: '[truncated:structure]' });
  assert.equal(bomb.diagnostics.some((entry) => entry.code === 'structure_budget_exceeded'), true);
});

test('validateTurnEvent redacts durable prompt paths data URIs and provider maps', () => {
  const result = validateTurnEvent({
    v: 1,
    turn_id: 'turn_redact',
    seq: 7,
    type: 'tool_execution_completed',
    tool_call_id: 'call_1',
    payload: {
      tool_name: 'read_file',
      tool_output_summary: 'Read C:/Users/example/private.txt',
      prompt: 'private prompt text',
      diagnostics: { raw: 'private diagnostics' },
      image: 'data:image/png;base64,abcdef',
    },
  });

  assert.equal(result.status, 'accepted');
  const serialized = JSON.stringify(result.event);
  assert.equal(serialized.includes('private prompt text'), false);
  assert.equal(serialized.includes('private diagnostics'), false);
  assert.equal(serialized.includes('C:/Users/example/private.txt'), false);
  assert.equal(serialized.includes('data:image/png'), false);
  assert.equal(serialized.includes('[redacted:path]'), true);
  assert.equal(serialized.includes('[redacted:data-uri]'), true);
});

test('reasoning_part_completed with persist false is ephemeral', () => {
  const result = validateTurnEvent({
    v: 1,
    turn_id: 'turn_reasoning',
    seq: 1,
    type: 'reasoning_part_completed',
    payload: { text: 'transient', persist: false },
  });

  assert.equal(result.status, 'accepted');
  assert.equal(result.event.durability, 'ephemeral');
  assert.equal(reduceToTurnEventKind(result.event), null);
});

test('unknown event type is unsupported without throwing', () => {
  const result = validateTurnEvent({
    v: 1,
    turn_id: 'turn_future',
    seq: 8,
    type: 'future_event_type',
    payload: { raw: 'ignored' },
  });

  assert.equal(result.status, 'unsupported');
  assert.equal(result.event, null);
  assert.equal(result.diagnostics[0].code, 'unsupported_event_type');
});

test('collector accepts durable canonical turn events through existing storage shape', () => {
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn_collect',
    sessionId: 'session_collect',
  });
  const event = buildCanonicalTurnEvent({
    type: 'tool_call_requested',
    turn_id: 'turn_collect',
    session_id: 'session_collect',
    seq: 11,
    tool_call_id: 'call_collect',
    payload: {
      tool_name: 'read_file',
      tool_input: { path: 'README.md' },
    },
  });

  const captured = collector.noteEvent(event);

  assert.equal(captured.kind, 'tool_use');
  assert.equal(captured.turn_id, 'turn_collect');
  assert.equal(captured.event_id, event.event_id);
  assert.equal(captured.tool_call_id, 'call_collect');
  assert.equal(captured.payload.canonical_event_type, 'tool_call_requested');
  assert.equal(captured.payload.tool_name, 'read_file');
  assert.deepEqual(captured.payload.tool_input, { path: 'README.md' });
});

test('collector can finalize from captured canonical assistant text as primary source', () => {
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn_canonical_primary',
    sessionId: 'session_canonical_primary',
    canonicalPrimary: true,
  });
  collector.noteEvent(buildCanonicalTurnEvent({
    type: 'text_part_completed',
    turn_id: 'turn_canonical_primary',
    session_id: 'session_canonical_primary',
    seq: 3,
    payload: {
      text: 'Canonical text wins.',
      assistant_phase: 'final_answer',
      segment_id: 'assistant_turn_canonical_primary_seg_0',
      segment_group_index: 0,
    },
  }));

  const finalized = collector.buildFinalizedTurnEvents('turn_canonical_primary', [
    { id: 'user_turn_canonical_primary', role: 'user', content: 'Hello' },
    {
      id: 'assistant_turn_canonical_primary',
      role: 'assistant',
      streamId: 'turn_canonical_primary',
      content: 'Legacy projected text loses.',
    },
  ]);

  assert.deepEqual(
    finalized.map((event) => event.kind),
    ['user_prompt', 'assistant_text_segment']
  );
  assert.equal(finalized[1].primary_message_id, 'assistant_turn_canonical_primary');
  assert.equal(finalized[1].payload.text, 'Canonical text wins.');
  assert.equal(finalized[1].payload.canonical_event_type, 'text_part_completed');
});

test('collector falls back to projected assistant text when captured canonical text is truncated', () => {
  const warnings = [];
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn_canonical_truncated_text',
    sessionId: 'session_canonical_truncated_text',
    canonicalPrimary: true,
    logger: (level, event, details) => warnings.push({ level, event, details }),
  });
  collector.noteEvent(buildCanonicalTurnEvent({
    type: 'text_part_completed',
    turn_id: 'turn_canonical_truncated_text',
    session_id: 'session_canonical_truncated_text',
    seq: 3,
    payload: {
      text: 'x'.repeat(40_000),
      assistant_phase: 'final_answer',
      segment_id: 'assistant_turn_canonical_truncated_text_seg_0',
      segment_group_index: 0,
    },
  }));

  const finalized = collector.buildFinalizedTurnEvents('turn_canonical_truncated_text', [
    { id: 'user_turn_canonical_truncated_text', role: 'user', content: 'Hello' },
    {
      id: 'assistant_turn_canonical_truncated_text',
      role: 'assistant',
      streamId: 'turn_canonical_truncated_text',
      content: 'Projected assistant text survives truncation.',
    },
  ]);
  const assistant = finalized.find((event) => event.kind === 'assistant_text_segment');

  assert.equal(assistant.payload.text, 'Projected assistant text survives truncation.');
  assert.equal(assistant.payload.canonical_event_type, undefined);
  assert.equal(
    warnings.some((entry) => entry.event === 'canonical_turn_event.assistant_text_fallback_to_projection'),
    true
  );
});

test('collector canonical primary only replaces projected live events with matching captured kinds', () => {
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn_canonical_partial_capture',
    sessionId: 'session_canonical_partial_capture',
    canonicalPrimary: true,
  });
  collector.noteEvent(buildCanonicalTurnEvent({
    type: 'text_part_completed',
    turn_id: 'turn_canonical_partial_capture',
    session_id: 'session_canonical_partial_capture',
    seq: 3,
    payload: {
      text: 'Canonical final text.',
      assistant_phase: 'final_answer',
      segment_id: 'assistant_turn_canonical_partial_capture_seg_0',
      segment_group_index: 0,
    },
  }));

  const finalized = collector.buildFinalizedTurnEvents('turn_canonical_partial_capture', [
    { id: 'user_turn_canonical_partial_capture', role: 'user', content: 'Use a tool' },
    {
      id: 'tool_use_turn_canonical_partial_capture_call_1',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_1',
        tool_name: 'read_file',
        parent_stream_id: 'turn_canonical_partial_capture',
        status: 'completed',
        input: { path: 'README.md' },
      },
    },
    {
      id: 'assistant_turn_canonical_partial_capture',
      role: 'assistant',
      streamId: 'turn_canonical_partial_capture',
      content: 'Legacy projected text loses.',
    },
  ]);

  assert.equal(finalized.some((event) => event.kind === 'tool_use' && event.tool_call_id === 'call_1'), true);
  const assistant = finalized.find((event) => event.kind === 'assistant_text_segment');
  assert.equal(assistant.payload.text, 'Canonical final text.');
});

test('collector drops unsupported canonical turn events without throwing', () => {
  const warnings = [];
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn_drop',
    logger: (level, event, details) => warnings.push({ level, event, details }),
  });

  const captured = collector.noteEvent({
    v: 1,
    turn_id: 'turn_drop',
    seq: 2,
    type: 'future_event_type',
    payload: { raw: 'ignored' },
  });

  assert.equal(captured, null);
  assert.equal(warnings.some((entry) => entry.event === 'canonical_turn_event.dropped'), true);
});

test('buildPersistedTurnEvent redacts absolute artifact paths in tool_result payloads', () => {
  const persisted = buildPersistedTurnEvent({
    event_id: 'turn_paths:tool_result:0',
    turn_id: 'turn_paths',
    kind: 'tool_result',
    tool_call_id: 'call_paths',
    payload: {
      tool_name: 'worktree_list',
      generated_artifacts: [{
        artifact_id: 'artifact-1',
        title: 'Capture',
        file_name: 'capture.png',
        display_path: '.jenny/artifacts/capture.png',
        absolute_path: 'C:/Users/demo/workspace/.jenny/artifacts/capture.png',
      }],
    },
  }, new Map());

  assert.equal(
    persisted.payload.generated_artifacts[0].absolute_path,
    '[redacted:path]'
  );
});

test('validateTurnEvent marks truncated display fields with a visible ellipsis inside the cap', () => {
  const result = validateTurnEvent({
    v: 1,
    turn_id: 'turn_marker',
    seq: 6,
    type: 'tool_execution_completed',
    payload: { summary: 's'.repeat(EVENT_CAPS.summary + 60) },
  });

  assert.equal(result.status, 'accepted');
  const capped = result.event.payload.summary;
  assert.equal(capped.endsWith('…'), true, 'display truncation carries a visible marker');
  assert.equal(Buffer.byteLength(capped, 'utf8') <= EVENT_CAPS.summary, true, 'marker fits inside the byte cap');
  assert.equal(result.diagnostics.some((entry) => entry.code === 'payload_truncated'), true);
});

test('validateTurnEvent never injects the marker into concatenating delta fields', () => {
  // text_delta marker-freedom is already pinned by the caps test above; this
  // covers the arguments_delta stream field, which shares FIELD_CAPS with
  // marked display fields.
  const args = validateTurnEvent({
    v: 1,
    turn_id: 'turn_marker_args',
    seq: 8,
    type: 'tool_input_delta',
    payload: { arguments_delta: 'a'.repeat(EVENT_CAPS.tool_input_summary + 100) },
  });
  assert.equal(
    args.event.payload.arguments_delta,
    'a'.repeat(EVENT_CAPS.tool_input_summary),
    'tool-argument deltas stay marker-free'
  );
});
