const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHAT_SEND_FRAME_BUDGET_BYTES,
  FRAME_BUDGET_RESERVE_BYTES,
  boundCanonicalSessionMessagesForFrame,
  fitChatSendParamsToFrameBudgetWithOutcome,
} = require('../services/backend/chat-send-frame-budget');
const {
  MAX_OUTBOUND_FRAME_BODY_BYTES,
  encodeFrame,
} = require('../services/backend/sidecar-client-transport-codec');
// The real prepared-messages builder, so the escalation is exercised through
// selectRecentTurnGroups exactly as managed-sidecar-chat.js wires it.
const { buildPreparedMessages } = require('../services/backend/chat-stream-reasoning');

// Wrap params exactly as SidecarClient.request/chatSend does before the
// transport codec encodes the wire frame, so frame-size assertions match what
// _writeFrame would actually measure and gate on.
function encodeChatSendFrame(params) {
  return encodeFrame({
    jsonrpc: '2.0',
    id: 1,
    method: 'chat.send',
    params: { accept_version: '2026-08-17', ...params },
  });
}

// One canonical message carrying a heavy tool_result.metadata snapshot — the
// real growth driver. `marker` makes ordering assertions unambiguous.
function bigCanonicalMessage(index, payloadBytes) {
  return {
    id: `msg_${String(index).padStart(5, '0')}`,
    role: 'tool',
    kind: 'tool_result',
    marker: index,
    tool_result: {
      call_id: `call_${index}`,
      tool_name: 'read_file',
      summary: 'read notes.txt',
      metadata: {
        result_kind: 'read_snapshot',
        path: `/repo/file_${index}.txt`,
        snapshot: { content: 'x'.repeat(payloadBytes) },
      },
    },
  };
}

function baseChatSendParams(canonical) {
  return {
    request_id: 'stream_1',
    trace_id: 'trace_1',
    session_id: 'session_1',
    mode: 'assist',
    messages: [{ role: 'user', content: 'hello' }],
    canonical_session_messages: canonical,
    session_title: 'Long session',
  };
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

test('budget sits a fixed reserve below the hard transport cap', () => {
  assert.equal(
    CHAT_SEND_FRAME_BUDGET_BYTES,
    MAX_OUTBOUND_FRAME_BODY_BYTES - FRAME_BUDGET_RESERVE_BYTES
  );
  assert.ok(CHAT_SEND_FRAME_BUDGET_BYTES < MAX_OUTBOUND_FRAME_BODY_BYTES);
});

// ---------------------------------------------------------------------------
// no-op path: realistic frames are untouched
// ---------------------------------------------------------------------------

test('a normal-sized frame is returned unchanged with no trim', () => {
  const canonical = Array.from({ length: 8 }, (_, i) => bigCanonicalMessage(i, 4_096));
  const params = baseChatSendParams(canonical);
  const { params: out, trim } = boundCanonicalSessionMessagesForFrame(params);
  assert.equal(trim, null);
  assert.strictEqual(out, params, 'untouched params keep the same object reference');
  assert.equal(out.canonical_session_messages.length, 8);
});

test('non-object / array params are passed through untouched', () => {
  assert.deepEqual(boundCanonicalSessionMessagesForFrame(null), { params: null, trim: null });
  assert.deepEqual(boundCanonicalSessionMessagesForFrame([1, 2]), { params: [1, 2], trim: null });
});

// ---------------------------------------------------------------------------
// core defect: an oversized session degrades gracefully instead of crashing
// ---------------------------------------------------------------------------

test('an oversized canonical history that would be hard-rejected today is trimmed to fit the frame', () => {
  // ~220 KB per message * 60 messages ≈ 13 MB canonical — comfortably past the
  // 10 MiB transport cap, exactly the long-lived-session tail this fixes.
  const canonical = Array.from({ length: 60 }, (_, i) => bigCanonicalMessage(i, 220_000));
  const params = baseChatSendParams(canonical);

  // Precondition: today this frame exceeds the cap, so _writeFrame would reject
  // the chat.send non-retryably and brick the session.
  assert.ok(
    encodeChatSendFrame(params).bodyLength > MAX_OUTBOUND_FRAME_BODY_BYTES,
    'fixture must actually exceed the transport cap before trimming'
  );

  const { params: out, trim } = boundCanonicalSessionMessagesForFrame(params);

  // After the fix the wire frame fits, so _writeFrame accepts it.
  assert.ok(trim, 'oversized frame must report a trim');
  assert.ok(trim.droppedCount > 0, 'must drop the oldest canonical messages');
  assert.equal(trim.keptCount + trim.droppedCount, 60);
  assert.equal(trim.canonicalOriginalCount, 60);
  assert.equal(trim.fitsBudget, true);
  assert.ok(trim.finalBytes <= CHAT_SEND_FRAME_BUDGET_BYTES);
  assert.ok(
    encodeChatSendFrame(out).bodyLength <= MAX_OUTBOUND_FRAME_BODY_BYTES,
    'bounded frame must pass the _writeFrame oversized-frame guard'
  );
});

test('trimming drops the OLDEST messages and preserves the newest contiguous tail', () => {
  const canonical = Array.from({ length: 60 }, (_, i) => bigCanonicalMessage(i, 220_000));
  const params = baseChatSendParams(canonical);
  const { params: out } = boundCanonicalSessionMessagesForFrame(params);

  const kept = out.canonical_session_messages;
  assert.ok(kept.length > 0 && kept.length < 60);
  // The retained slice is the newest tail: markers are the highest indices, in
  // order, ending at the very last message — what rebuild_read_snapshot_cache
  // (latest-snapshot-wins) and scan_history_for_undeferrals care about most.
  const markers = kept.map((m) => m.marker);
  assert.equal(markers[markers.length - 1], 59, 'newest message is always retained');
  const expected = Array.from({ length: kept.length }, (_, i) => 60 - kept.length + i);
  assert.deepEqual(markers, expected, 'kept messages are the contiguous newest tail');
});

test('original params object is not mutated when trimming', () => {
  const canonical = Array.from({ length: 60 }, (_, i) => bigCanonicalMessage(i, 220_000));
  const params = baseChatSendParams(canonical);
  boundCanonicalSessionMessagesForFrame(params);
  assert.equal(params.canonical_session_messages.length, 60, 'caller array stays intact');
});

// ---------------------------------------------------------------------------
// residual / edge cases
// ---------------------------------------------------------------------------

test('when a NON-canonical field alone exceeds the budget, canonical empties and the residual is flagged', () => {
  // A single message array can't be trimmed away; here the prompt `messages`
  // field is the offender. canonical trims to empty (safe — sidecar consumers
  // guard `or []`) and fitsBudget=false surfaces the residual to telemetry.
  const params = baseChatSendParams([bigCanonicalMessage(0, 1_000)]);
  params.messages = [{ role: 'user', content: 'y'.repeat(MAX_OUTBOUND_FRAME_BODY_BYTES) }];
  const { params: out, trim } = boundCanonicalSessionMessagesForFrame(params);
  assert.ok(trim);
  assert.equal(out.canonical_session_messages.length, 0, 'canonical drained to its floor');
  assert.equal(trim.keptCount, 0);
  assert.equal(trim.fitsBudget, false, 'residual over-budget frame is reported, not hidden');
});

test('a tiny budget keeps only the messages that fit, newest-first', () => {
  const canonical = Array.from({ length: 5 }, (_, i) => bigCanonicalMessage(i, 10_000));
  const params = baseChatSendParams(canonical);
  const base = Buffer.byteLength(
    JSON.stringify({ ...params, canonical_session_messages: [] }),
    'utf8'
  );
  // Budget that fits roughly two ~10 KB messages on top of the base frame.
  const { params: out, trim } = boundCanonicalSessionMessagesForFrame(params, {
    budgetBytes: base + 25_000,
  });
  assert.ok(trim);
  assert.equal(out.canonical_session_messages.length, 2);
  assert.deepEqual(
    out.canonical_session_messages.map((m) => m.marker),
    [3, 4]
  );
  assert.ok(trim.finalBytes <= base + 25_000);
});

// ---------------------------------------------------------------------------
// history-scope escalation: the provider `messages` array is the offender
//
// The byte trimmer deliberately never touches params.messages — a naive
// oldest-first slice can drop a tool_use while keeping its tool_result (or the
// reverse), which most providers hard-reject. So when emptying canonical still
// leaves the frame over budget, the fallback narrows history_scope instead,
// which slices WHOLE user-anchored turn groups and cannot split a pair.
// ---------------------------------------------------------------------------

// Store-shaped turn group: user anchor -> assistant tool_use -> tool_result ->
// assistant answer. `padBytes` inflates the assistant answer, the realistic
// growth path into the provider array (tool results are summarized down).
function storeTurnGroup(index, padBytes) {
  return [
    { role: 'user', content: `question ${index}` },
    {
      role: 'assistant',
      kind: 'tool_use',
      tool_call: { call_id: `call_${index}`, tool_name: 'read_file', input: { path: `f${index}` } },
    },
    {
      role: 'tool',
      kind: 'tool_result',
      tool_result: { call_id: `call_${index}`, tool_name: 'read_file', summary: `read f${index}` },
    },
    { role: 'assistant', content: `answer ${index} ${'z'.repeat(padBytes)}` },
  ];
}

function storeHistory(groupCount, padBytes) {
  return Array.from({ length: groupCount }, (_, i) => storeTurnGroup(i, padBytes)).flat();
}

function rebuilderFor(history) {
  return (historyScope) => buildPreparedMessages(history, 'the next question', {
    contextPreferences: { history_scope: historyScope },
  });
}

// Every tool_calls id must still have its matching role:'tool' reply, and every
// role:'tool' reply must still have its originating tool_calls id.
function assertToolPairsIntact(messages, label) {
  const callIds = [];
  const resultIds = [];
  for (const message of messages) {
    for (const call of message.tool_calls || []) {
      callIds.push(call.id);
    }
    if (message.role === 'tool') {
      resultIds.push(message.tool_call_id);
    }
  }
  assert.deepEqual(callIds.sort(), resultIds.sort(), `${label}: split tool_use/tool_result pair`);
}

test('a >10 MiB provider history escalates to a narrower scope and the frame fits', () => {
  // 20 turn groups x ~600 KB ≈ 12 MB at history_scope 'session' — past the cap
  // even with canonical_session_messages emptied entirely.
  const history = storeHistory(20, 600_000);
  const rebuildMessages = rebuilderFor(history);
  const params = baseChatSendParams([bigCanonicalMessage(0, 1_000)]);
  params.messages = rebuildMessages('session');

  // Precondition: canonical trimming ALONE cannot rescue this frame.
  const canonicalOnly = boundCanonicalSessionMessagesForFrame(params);
  assert.equal(canonicalOnly.trim.fitsBudget, false, 'fixture must defeat canonical-only trimming');
  assert.ok(encodeChatSendFrame(canonicalOnly.params).bodyLength > MAX_OUTBOUND_FRAME_BODY_BYTES);

  const records = [];
  const out = fitChatSendParamsToFrameBudgetWithOutcome(params, {
    rebuildMessages,
    log: (level, event, payload) => records.push({ level, event, payload }),
  }).params;

  assert.ok(
    encodeChatSendFrame(out).bodyLength <= MAX_OUTBOUND_FRAME_BODY_BYTES,
    'escalated frame must pass the _writeFrame oversized-frame guard'
  );
  assert.equal(records.length, 1, 'exactly one telemetry record per send');
  assert.equal(records[0].level, 'WARN', 'a recovered frame is a WARN, not an ERROR');
  assert.equal(records[0].payload.historyScopeFallback, 'recent');
  assert.equal(records[0].payload.fitsBudget, true);
  assert.ok(records[0].payload.finalBytes <= CHAT_SEND_FRAME_BUDGET_BYTES);
  assertToolPairsIntact(out.messages, 'recent-scope escalation');
});

test('the detailed frame-fit result discloses automatic history narrowing', () => {
  const history = storeHistory(20, 600_000);
  const params = baseChatSendParams([]);
  params.messages = rebuilderFor(history)('session');

  const result = fitChatSendParamsToFrameBudgetWithOutcome(params, {
    rebuildMessages: rebuilderFor(history),
  });

  assert.equal(result.outcome.fitsBudget, true);
  assert.equal(result.outcome.historyScopeFallback, 'recent');
  assertToolPairsIntact(result.params.messages, 'detailed outcome');
});

test('escalation drops whole OLDEST rounds and keeps the newest tail intact', () => {
  const history = storeHistory(20, 600_000);
  const out = fitChatSendParamsToFrameBudgetWithOutcome(
    { ...baseChatSendParams([]), messages: rebuilderFor(history)('session') },
    { rebuildMessages: rebuilderFor(history) }
  ).params;

  // RECENT_TURN_GROUP_LIMIT is 6, so the newest six rounds survive whole.
  const anchors = out.messages.filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepEqual(
    anchors,
    [...Array.from({ length: 6 }, (_, i) => `question ${14 + i}`), 'the next question'],
    'kept anchors are the contiguous newest rounds plus the live prompt'
  );
  assert.equal(out.messages.filter((m) => m.role === 'tool').length, 6);
  assertToolPairsIntact(out.messages, 'oldest-round drop');
});

test('escalation walks on to fresh when recent is still too large', () => {
  const history = storeHistory(20, 10_000);
  const rebuildMessages = rebuilderFor(history);
  const params = { ...baseChatSendParams([]), messages: rebuildMessages('session') };
  // Budget below the six-group 'recent' slice but above an empty history.
  const budgetBytes = Buffer.byteLength(JSON.stringify({ ...params, messages: [] }), 'utf8') + 5_000;

  const records = [];
  const out = fitChatSendParamsToFrameBudgetWithOutcome(params, {
    budgetBytes,
    rebuildMessages,
    log: (level, event, payload) => records.push({ level, event, payload }),
  }).params;

  assert.equal(records[0].payload.historyScopeFallback, 'fresh');
  assert.equal(records[0].level, 'WARN');
  assert.deepEqual(out.messages.map((m) => m.role), ['user'], 'only the live prompt survives');
  assertToolPairsIntact(out.messages, 'fresh-scope escalation');
});

test('an irreducible frame still reports the residual at ERROR after exhausting both scopes', () => {
  // The offender is neither canonical nor history: a single outsized field that
  // no scope narrowing can shrink. The typed oversized-frame error must still
  // surface downstream, so the residual is reported rather than silently passed.
  const history = storeHistory(4, 1_000);
  const rebuildMessages = rebuilderFor(history);
  const params = {
    ...baseChatSendParams([bigCanonicalMessage(0, 1_000)]),
    messages: rebuildMessages('session'),
    session_title: 'y'.repeat(MAX_OUTBOUND_FRAME_BODY_BYTES),
  };

  const records = [];
  const out = fitChatSendParamsToFrameBudgetWithOutcome(params, {
    rebuildMessages,
    log: (level, event, payload) => records.push({ level, event, payload }),
  }).params;

  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'ERROR', 'unrecoverable residual must not be a routine WARN');
  assert.equal(records[0].payload.fitsBudget, false);
  assert.equal(records[0].payload.historyScopeFallback, 'fresh', 'both fallbacks were exhausted');
  assert.ok(
    encodeChatSendFrame(out).bodyLength > MAX_OUTBOUND_FRAME_BODY_BYTES,
    'still oversized, so the existing non-retryable CMP-SIDECAR guard still fires'
  );
});

test('a fitting frame neither rebuilds history nor logs', () => {
  const history = storeHistory(4, 1_000);
  let rebuilds = 0;
  const records = [];
  const params = { ...baseChatSendParams([]), messages: rebuilderFor(history)('session') };
  const out = fitChatSendParamsToFrameBudgetWithOutcome(params, {
    rebuildMessages: (scope) => { rebuilds += 1; return rebuilderFor(history)(scope); },
    log: (level, event, payload) => records.push({ level, event, payload }),
  }).params;
  assert.strictEqual(out, params, 'a fitting frame is passed through by reference');
  assert.equal(rebuilds, 0, 'history must not be rebuilt on the hot path');
  assert.equal(records.length, 0);
});

test('canonical trimming alone is preferred and never escalates when it suffices', () => {
  const history = storeHistory(4, 1_000);
  let rebuilds = 0;
  const canonical = Array.from({ length: 60 }, (_, i) => bigCanonicalMessage(i, 220_000));
  const params = { ...baseChatSendParams(canonical), messages: rebuilderFor(history)('session') };

  const records = [];
  const out = fitChatSendParamsToFrameBudgetWithOutcome(params, {
    rebuildMessages: () => { rebuilds += 1; return []; },
    log: (level, event, payload) => records.push({ level, event, payload }),
  }).params;

  assert.equal(rebuilds, 0, 'history scope must stay untouched when canonical trimming fits');
  assert.equal(records[0].payload.historyScopeFallback, undefined);
  assert.equal(records[0].level, 'WARN');
  assert.ok(out.canonical_session_messages.length > 0);
  assert.deepEqual(out.messages, params.messages, 'provider messages are left alone');
});
