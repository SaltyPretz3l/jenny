'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  STORE_SCHEMA_VERSION,
  LEGACY_MONOLITHIC_MAX_SCHEMA_VERSION,
  STALE_PENDING_APPROVAL_TERMINAL_STATE,
  normalizeLinkedSessionIds,
  dedupeMessagesByIdKeepLatest,
  repairStalePendingApprovalToolUse,
  migrateAssistantTerminalStatus,
  normalizeDiagnosticMetadataValue,
  normalizeBranchOrigin,
  migrateStorePayload,
  normalizeStorePayload,
  repairSessionForV7,
  repairSessionForV15,
  repairSessionForV16,
  repairSessionForV17,
  repairSessionForV19,
} = require('../services/backend/session-store-migrations');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('STORE_SCHEMA_VERSION === 20', () => {
  assert.equal(STORE_SCHEMA_VERSION, 20);
});

test('v20 normalizes only the five boolean session tool override keys', () => {
  const result = migrateStorePayload({
    schema_version: 19,
    sessions: {
      s1: {
        id: 's1',
        tool_category_overrides: {
          files: false,
          web: true,
          local_browser: 'yes',
          python: null,
          terminal: true,
          unknown: true,
        },
      },
    },
  });
  assert.deepEqual(result.sessions.s1.tool_category_overrides, {
    files: false,
    web: true,
    terminal: true,
  });
});

test('LEGACY_MONOLITHIC_MAX_SCHEMA_VERSION === 9', () => {
  assert.equal(LEGACY_MONOLITHIC_MAX_SCHEMA_VERSION, 9);
});

test('STALE_PENDING_APPROVAL_TERMINAL_STATE === "cancelled"', () => {
  assert.equal(STALE_PENDING_APPROVAL_TERMINAL_STATE, 'cancelled');
});

// ---------------------------------------------------------------------------
// normalizeLinkedSessionIds
// ---------------------------------------------------------------------------

test('normalizeLinkedSessionIds dedupes, trims, drops empties and self id', () => {
  const result = normalizeLinkedSessionIds(['a', 'a', '', ' b ', 'self'], 'self');
  assert.deepEqual(result, ['a', 'b']);
});

test('normalizeLinkedSessionIds with non-array input returns []', () => {
  assert.deepEqual(normalizeLinkedSessionIds(null, 'x'), []);
  assert.deepEqual(normalizeLinkedSessionIds('a,b', 'x'), []);
  assert.deepEqual(normalizeLinkedSessionIds(42, 'x'), []);
});

// ---------------------------------------------------------------------------
// dedupeMessagesByIdKeepLatest
// ---------------------------------------------------------------------------

test('dedupeMessagesByIdKeepLatest keeps latest duplicate id and preserves id-less', () => {
  const msgs = [
    { id: 'm', content: '1' },
    { id: 'm', content: '2' },
    { content: 'x' }, // no id -> always kept
  ];
  const result = dedupeMessagesByIdKeepLatest(msgs);
  assert.equal(result.length, 2);
  const mEntry = result.find((r) => r.id === 'm');
  assert.ok(mEntry, 'entry with id m must exist');
  assert.equal(mEntry.content, '2', 'latest duplicate m must have content "2"');
  const idLessEntry = result.find((r) => !r.id);
  assert.ok(idLessEntry, 'id-less entry must be retained');
  assert.equal(idLessEntry.content, 'x');
});

// ---------------------------------------------------------------------------
// repairStalePendingApprovalToolUse
// ---------------------------------------------------------------------------

test('repairStalePendingApprovalToolUse: pending_approval with no matching tool_result -> cancelled', () => {
  const callId = 'call-1';
  const messages = [
    {
      kind: 'tool_use',
      tool_call: { call_id: callId, status: 'pending_approval', approval_state: 'pending' },
    },
  ];
  const result = repairStalePendingApprovalToolUse(messages);
  assert.equal(result.length, 1);
  assert.equal(result[0].tool_call.status, 'cancelled');
  assert.equal(result[0].tool_call.approval_state, 'cancelled');
});

test('repairStalePendingApprovalToolUse: pending_approval WITH matching tool_result -> unchanged', () => {
  const callId = 'call-2';
  const messages = [
    {
      kind: 'tool_use',
      tool_call: { call_id: callId, status: 'pending_approval', approval_state: 'pending' },
    },
    {
      kind: 'tool_result',
      tool_result: { call_id: callId },
    },
  ];
  const result = repairStalePendingApprovalToolUse(messages);
  assert.equal(result.length, 2);
  // tool_use should be returned unchanged (still pending)
  assert.equal(result[0].tool_call.status, 'pending_approval');
  assert.equal(result[0].tool_call.approval_state, 'pending');
});

// ---------------------------------------------------------------------------
// migrateAssistantTerminalStatus
// ---------------------------------------------------------------------------

test('migrateAssistantTerminalStatus: error + category "denied" -> status "denied"', () => {
  const msg = { role: 'assistant', status: 'error', category: 'denied' };
  const result = migrateAssistantTerminalStatus(msg);
  assert.equal(result.status, 'denied');
  // no terminal_subcode for denied
  assert.ok(!result.terminal_subcode, 'denied should not have terminal_subcode');
});

test('migrateAssistantTerminalStatus: error + stream_error containing "cancelled" -> status "cancelled"', () => {
  const msg = { role: 'assistant', status: 'error', stream_error: 'request was cancelled by user' };
  const result = migrateAssistantTerminalStatus(msg);
  assert.equal(result.status, 'cancelled');
  assert.ok(!result.terminal_subcode, 'cancelled should not have terminal_subcode');
});

test('migrateAssistantTerminalStatus: plain error (no denied/cancelled signal) -> runtime_error + unhandled_exception', () => {
  const msg = { role: 'assistant', status: 'error', stream_error: 'network timeout' };
  const result = migrateAssistantTerminalStatus(msg);
  assert.equal(result.status, 'runtime_error');
  assert.equal(result.terminal_subcode, 'unhandled_exception');
});

test('migrateAssistantTerminalStatus: non-assistant message is returned unchanged', () => {
  const msg = { role: 'user', status: 'error', category: 'denied' };
  const result = migrateAssistantTerminalStatus(msg);
  // should be the exact same reference (or at least same status)
  assert.equal(result.status, 'error');
  assert.equal(result.role, 'user');
  assert.ok(!result.terminal_subcode);
});

// ---------------------------------------------------------------------------
// normalizeDiagnosticMetadataValue
// ---------------------------------------------------------------------------

test('normalizeDiagnosticMetadataValue collapses whitespace, strips control chars, truncates to 120 chars', () => {
  // Build a 200-char string (all printable ASCII 'a's with spaces scattered)
  const long = 'a'.repeat(200);
  const result = normalizeDiagnosticMetadataValue(long);
  assert.equal(result.length, 120);
});

test('normalizeDiagnosticMetadataValue collapses internal whitespace', () => {
  const result = normalizeDiagnosticMetadataValue('hello   world');
  assert.equal(result, 'hello world');
});

test('normalizeDiagnosticMetadataValue strips control characters', () => {
  //  is a C0 control char that should be replaced with space then trimmed
  const result = normalizeDiagnosticMetadataValue('helloworld');
  assert.equal(result, 'hello world');
});

// ---------------------------------------------------------------------------
// normalizeBranchOrigin
// ---------------------------------------------------------------------------

test('normalizeBranchOrigin: fully valid origin normalizes to canonical shape', () => {
  const origin = {
    source_session_id: 'sess-1',
    source_message_id: 'msg-1',
    source_title: 'My Title',
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const result = normalizeBranchOrigin(origin);
  assert.ok(result !== null, 'valid origin should not be null');
  assert.equal(result.source_session_id, 'sess-1');
  assert.equal(result.source_message_id, 'msg-1');
  assert.equal(result.source_title, 'My Title');
  assert.equal(result.created_at, '2026-01-01T00:00:00.000Z');
  // Only the four canonical keys should be present
  assert.deepEqual(Object.keys(result).sort(), [
    'created_at',
    'source_message_id',
    'source_session_id',
    'source_title',
  ]);
});

test('normalizeBranchOrigin: missing source_message_id -> null', () => {
  const origin = {
    source_session_id: 'sess-1',
    // source_message_id is absent
    source_title: 'My Title',
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const result = normalizeBranchOrigin(origin);
  assert.equal(result, null);
});

test('normalizeBranchOrigin: null input -> null', () => {
  assert.equal(normalizeBranchOrigin(null), null);
});

// ---------------------------------------------------------------------------
// migrateStorePayload + normalizeStorePayload
// ---------------------------------------------------------------------------

test('migrateStorePayload from v1 bumps schema_version to 19 and adds durable turn identity', () => {
  const payload = {
    schema_version: 1,
    sessions: {
      s1: { linked_session_ids: ['s1', 'x', 'x'] },
    },
  };
  const result = migrateStorePayload(payload);
  assert.equal(result.schema_version, 20);
  // 's1' is the session id (self), 'x' appears twice -> deduped to ['x']
  assert.deepEqual(result.sessions.s1.linked_session_ids, ['x']);
  assert.equal(result.sessions.s1.session_incarnation, '');
  assert.equal(result.sessions.s1.turn_generation, 0);
  // A pre-image-gen row predates plugin sessions, so it lands as chat.
  assert.equal(result.sessions.s1.session_type, 'chat');
  assert.equal(Object.hasOwn(result.sessions.s1, 'image_config'), false);
});

test('normalizeStorePayload returns only schema_version and sessions (no extra top-level keys)', () => {
  const payload = {
    schema_version: 1,
    sessions: { s1: { linked_session_ids: ['s1', 'x', 'x'] } },
    extra_key: 'should be dropped',
  };
  const result = normalizeStorePayload(payload);
  assert.equal(result.schema_version, 20);
  assert.deepEqual(Object.keys(result).sort(), ['schema_version', 'sessions']);
  assert.deepEqual(result.sessions.s1.linked_session_ids, ['x']);
});

test('migrateStorePayload runs the legacy chain for malformed and unsupported schema versions', () => {
  for (const schemaVersion of ['bad', 1.5, -1, 0, 21, Number.MAX_SAFE_INTEGER + 1]) {
    const result = migrateStorePayload({
      schema_version: schemaVersion,
      sessions: { s1: { messages: [{
        id: 'm1', kind: 'tool_use',
        tool_call: { call_id: 'call_1', status: 'pending_approval', approval_state: 'pending' },
      }] } },
    });

    assert.equal(result.schema_version, STORE_SCHEMA_VERSION);
    assert.equal(result.sessions.s1.messages[0].tool_call.status, 'cancelled');
    assert.equal(result.sessions.s1.messages[0].tool_call.approval_state, 'cancelled');
  }
});

// ---------------------------------------------------------------------------
// repairSessionForV15
// ---------------------------------------------------------------------------

test('repairSessionForV15 defaults omitted durable turn identity fields', () => {
  const result = repairSessionForV15({ id: 's1' });

  assert.equal(result.session_incarnation, '');
  assert.equal(result.turn_generation, 0);
});

test('repairSessionForV15 trims incarnation and preserves a valid generation', () => {
  const result = repairSessionForV15({
    id: 's1',
    session_incarnation: '  inc_persisted  ',
    turn_generation: 7,
  });

  assert.equal(result.session_incarnation, 'inc_persisted');
  assert.equal(result.turn_generation, 7);
});

test('repairSessionForV15 resets malformed generations without dropping other fields', () => {
  for (const turnGeneration of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'invalid']) {
    const result = repairSessionForV15({
      id: 's1',
      title: 'Preserved',
      turn_generation: turnGeneration,
    });

    assert.equal(result.title, 'Preserved');
    assert.equal(result.turn_generation, 0);
  }
});

test('migrateStorePayload from v14 applies durable identity repair and lands at v19', () => {
  const result = migrateStorePayload({
    schema_version: 14,
    sessions: {
      missing: { title: 'Missing identity' },
      valid: {
        title: 'Valid identity',
        session_incarnation: ' inc_existing ',
        turn_generation: 9,
      },
      malformed: {
        title: 'Malformed generation',
        session_incarnation: null,
        turn_generation: -4,
      },
    },
  });

  assert.equal(result.schema_version, 20);
  assert.equal(result.sessions.missing.session_incarnation, '');
  assert.equal(result.sessions.missing.turn_generation, 0);
  assert.equal(result.sessions.valid.session_incarnation, 'inc_existing');
  assert.equal(result.sessions.valid.turn_generation, 9);
  assert.equal(result.sessions.malformed.session_incarnation, '');
  assert.equal(result.sessions.malformed.turn_generation, 0);
});

// ---------------------------------------------------------------------------
// repairSessionForV16
// ---------------------------------------------------------------------------

test('repairSessionForV16 defaults the compaction snapshot to null and fails malformed shapes closed', () => {
  assert.equal(repairSessionForV16({ id: 's1' }).compaction_snapshot, null);
  assert.equal(
    repairSessionForV16({
      id: 's1',
      compaction_snapshot: { version: 99, strategy: 'experimental', messages: 'not-a-list' },
    }).compaction_snapshot,
    null
  );
});

test('repairSessionForV16 preserves a valid compaction snapshot and other fields', () => {
  const snapshot = {
    version: 1,
    created_at: '2026-07-20T12:00:00.000Z',
    strategy: 'full',
    tokens_before: 100,
    tokens_after: 40,
    boundary_message_id: 'a1',
    boundary_message_count: 2,
    messages: [{ role: 'system', content: 'summary' }],
  };
  const result = repairSessionForV16({
    id: 's1',
    title: 'Preserved',
    compaction_snapshot: snapshot,
  });
  assert.equal(result.title, 'Preserved');
  assert.deepEqual(result.compaction_snapshot, {
    ...snapshot,
    version: 2,
    origin: 'manual',
    // Derived from the replacement messages by normalizeCompactionSnapshot (P2 Wave 1).
    replacement_tokens: 6,
  });
});

test('repairSessionForV19 retires research context and upgrades v1 snapshots', () => {
  const result = repairSessionForV19({
    context_preferences: {
      history_scope: 'recent',
      include_personality: true,
      include_memory: false,
      include_research_mode: true,
    },
    compaction_snapshot: {
      version: 1,
      created_at: '2026-08-01T12:00:00.000Z',
      strategy: 'full',
      tokens_before: 100,
      tokens_after: 40,
      boundary_message_id: 'a1',
      boundary_message_count: 2,
      messages: [{ role: 'system', content: 'summary' }],
    },
  });

  assert.deepEqual(result.context_preferences, {
    history_scope: 'recent',
    include_personality: true,
    include_memory: false,
    include_git_context: true,
    include_codebase_context: true,
    include_active_file_context: true,
  });
  assert.equal(result.compaction_snapshot.version, 2);
  assert.equal(result.compaction_snapshot.origin, 'manual');
});

// ---------------------------------------------------------------------------
// repairSessionForV17
// ---------------------------------------------------------------------------

test('repairSessionForV17 lands unknown and pre-v17 rows on chat with no image config', () => {
  // Every pre-v17 record lacks the field, and a type this build does not
  // understand must never become an image session (C2: that would refuse
  // chat.send on a normal transcript).
  for (const session of [
    { id: 's1' },
    { id: 's1', session_type: '' },
    { id: 's1', session_type: 'video' },
    { id: 's1', session_type: null },
  ]) {
    const result = repairSessionForV17(session);
    assert.equal(result.session_type, 'chat');
    assert.equal(result.image_config, null);
  }
});

test('repairSessionForV17 strips image_config from a chat row however it arrived', () => {
  const result = repairSessionForV17({
    id: 's1',
    session_type: 'chat',
    image_config: { model_id: 'hidream-o1', resolution: '1024x1024', steps: 50 },
  });

  assert.equal(result.session_type, 'chat');
  assert.equal(result.image_config, null);
});

test('repairSessionForV17 preserves a valid image config and other fields', () => {
  const result = repairSessionForV17({
    id: 's1',
    title: 'Preserved',
    session_type: 'image',
    image_config: { model_id: 'hidream-o1', resolution: '1024x1024', steps: 50 },
  });

  assert.equal(result.title, 'Preserved');
  assert.equal(result.session_type, 'image');
  assert.deepEqual(result.image_config, {
    model_id: 'hidream-o1',
    resolution: '1024x1024',
    steps: 50,
  });
});

test('repairSessionForV17 fails a malformed image config closed without dropping other fields', () => {
  for (const imageConfig of [
    { model_id: '', resolution: '1024x1024', steps: 50 },
    { model_id: 'hidream-o1', resolution: 'huge', steps: 50 },
    { model_id: 'hidream-o1', resolution: '1024x1024', steps: 0 },
    { model_id: 'hidream-o1', resolution: '1024x1024', steps: 1.5 },
    'not-an-object',
  ]) {
    const result = repairSessionForV17({
      id: 's1',
      title: 'Preserved',
      session_type: 'image',
      image_config: imageConfig,
    });

    assert.equal(result.title, 'Preserved');
    assert.equal(result.session_type, 'image');
    assert.equal(result.image_config, null);
  }
});

// ---------------------------------------------------------------------------
// repairSessionForV7
// ---------------------------------------------------------------------------

test('repairSessionForV7: normalizeMessageFn is invoked once per message and output is used', () => {
  const calls = [];
  const normalizeMessageFn = (message, modelHint) => {
    calls.push({ message, modelHint });
    // Return a transformed version so we can verify output
    return { ...message, normalized: true };
  };

  const session = {
    last_model_used: 'gpt-test',
    messages: [
      { id: 'a', content: 'hello' },
      { id: 'b', content: 'world' },
    ],
  };

  const result = repairSessionForV7(session, normalizeMessageFn);

  // normalizeMessageFn should be called exactly once per message
  assert.equal(calls.length, 2, 'normalizeMessageFn must be invoked once per message');

  // Each call receives the correct message and modelHint
  assert.equal(calls[0].message.id, 'a');
  assert.equal(calls[0].modelHint, 'gpt-test');
  assert.equal(calls[1].message.id, 'b');
  assert.equal(calls[1].modelHint, 'gpt-test');

  // Output messages reflect the normalizer's output (normalized: true)
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].normalized, true);
  assert.equal(result.messages[1].normalized, true);
});

test('repairSessionForV7: non-function second arg returns source messages unchanged', () => {
  const session = {
    messages: [{ id: 'x', content: 'data' }],
  };
  const result = repairSessionForV7(session, 'not-a-function');
  // Should return source unchanged (same messages array content)
  assert.deepEqual(result.messages, session.messages);
});

test('repairSessionForV7: normalizeMessageFn returning falsy values are filtered out', () => {
  const calls = [];
  const normalizeMessageFn = (message) => {
    calls.push(message);
    // Return null for the first message -> should be filtered
    return message.id === 'drop' ? null : message;
  };

  const session = {
    messages: [
      { id: 'drop', content: 'gone' },
      { id: 'keep', content: 'here' },
    ],
  };

  const result = repairSessionForV7(session, normalizeMessageFn);
  assert.equal(calls.length, 2, 'normalizeMessageFn called for each message');
  assert.equal(result.messages.length, 1, 'null-returning message is filtered out');
  assert.equal(result.messages[0].id, 'keep');
});
