// CTL-005 acceptance contract: terminal hydration must NEVER drop local-only
// messages because of list cardinality. List length is not a set-difference
// invariant — an equal-length snapshot can swap one local item for one newly
// durable item, and a shorter current list can still hold a unique local
// message. The identity/content-multiset reconciliation (and its anchored
// placement) must run unconditionally; only the old `current.length >
// hydrated.length` gate was unsound. Merges that preserve local state emit a
// bounded diagnostic.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAgentProgressSnapshot,
  createTerminalMergeUtils,
} = require('../renderer/chat/renderer-stream-handler-terminal-merge');

// Dependency wiring mirrors renderer-stream-handler-terminal.js exactly
// (normalizeId / associated-stream-id / status classifiers / local-artifact
// rule), so the unit contract matches production behavior.
function createHarness() {
  const logs = [];
  const normalizeId = (value) => String(value || '').trim();
  const readMessageAssociatedStreamId = (message) => normalizeId(
    message?.streamId
    || message?.stream_id
    || message?.parent_stream_id
    || message?.parentStreamId
    || message?.tool_call?.parent_stream_id
    || message?.tool_result?.parent_stream_id
  );
  const isCompleteStatus = (value) => ['complete', 'completed', 'done'].includes(String(value || '').trim().toLowerCase());
  const isTerminalStatus = (value) => isCompleteStatus(value)
    || ['error', 'cancelled', 'canceled', 'aborted'].includes(String(value || '').trim().toLowerCase());
  const utils = createTerminalMergeUtils({
    normalizeId,
    readMessageAssociatedStreamId,
    isTerminalStatus,
    isCompleteStatus,
    isTerminalStreamLocalArtifact: (message, streamId) => Boolean(
      normalizeId(streamId) && readMessageAssociatedStreamId(message) === normalizeId(streamId)
    ),
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
  });
  return { utils, logs };
}

function ids(messages) {
  return messages.map((message) => String(message.id));
}

test('subagent progress snapshots survive terminal errors unless a matching validated report exists', () => {
  const step = {
    taskType: 'sub_agent', toolCallId: 'call-1', childTaskId: 'child-1', status: 'running',
  };
  const message = { agent_status_steps: [step] };
  assert.deepEqual(buildAgentProgressSnapshot(message, [], true), [step]);
  assert.deepEqual(buildAgentProgressSnapshot(message, [{
    tool_result: { call_id: 'call-other', metadata: { subagent_report: {
      task_id: 'other', status: 'completed', summary: 'Done.', evidence: [], tools_used: [], uncertainties: [],
    } } },
  }], true), [step]);
  assert.deepEqual(buildAgentProgressSnapshot(message, [{
    tool_result: { call_id: 'call-1', metadata: { subagent_report: {} } },
  }], true), [step], 'malformed reports cannot suppress the fallback snapshot');
  assert.equal(buildAgentProgressSnapshot(message, [{
    tool_result: { call_id: 'call-1', metadata: { subagent_report: {
      task_id: 'child-1', status: 'completed', summary: 'Done.', evidence: [], tools_used: [], uncertainties: [],
    } } },
  }], true), null);
});

test('equal-length snapshots preserve the local-only message (one local swapped for one durable)', () => {
  const { utils, logs } = createHarness();
  const current = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    { id: 'user_local_1', role: 'user', content: 'a brand new prompt' },
  ];
  const hydrated = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    { id: 'assistant_9', role: 'assistant', content: 'a newly durable answer' },
  ];

  const merged = utils.mergeTerminalHydratedMessages(current, hydrated, {
    sessionId: 'session-eq', streamId: 'stream-other',
  });

  assert.deepEqual(
    ids(merged),
    ['u1', 'user_local_1', 'assistant_9'],
    'the local prompt survives at its anchored position — equal length must not bypass reconciliation'
  );
  assert.ok(
    logs.some((entry) => entry.event === 'stream.terminal_hydration_preserved_local_messages'),
    'a merge that preserves local state emits the bounded diagnostic'
  );
});

test('a LONGER hydrated snapshot still preserves a unique local message', () => {
  const { utils } = createHarness();
  const current = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    { id: 'user_local_2', role: 'user', content: 'unpersisted follow-up' },
  ];
  const hydrated = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    { id: 'u2', role: 'user', content: 'another durable prompt' },
    { id: 'assistant_2', role: 'assistant', content: 'durable answer' },
  ];

  const merged = utils.mergeTerminalHydratedMessages(current, hydrated, {
    sessionId: 'session-longer', streamId: 'stream-other',
  });

  assert.deepEqual(
    ids(merged),
    ['u1', 'user_local_2', 'u2', 'assistant_2'],
    'the unique local prompt is anchored after its preceding hydrated-known message'
  );
});

test('a SHORTER current list with only a unique local message keeps it', () => {
  const { utils } = createHarness();
  const current = [
    { id: 'user_local_3', role: 'user', content: 'only local content' },
  ];
  const hydrated = [
    { id: 'u1', role: 'user', content: 'durable prompt' },
    { id: 'assistant_1', role: 'assistant', content: 'durable answer' },
  ];

  const merged = utils.mergeTerminalHydratedMessages(current, hydrated, {
    sessionId: 'session-shorter', streamId: 'stream-other',
  });

  // Documented anchor rule: a local message with no preceding hydrated-known
  // anchor goes to the front. The contract here is PRESERVATION; the placement
  // pin just tracks the module's stated rule.
  assert.deepEqual(ids(merged), ['user_local_3', 'u1', 'assistant_1']);
});

test('repeated identical prompts: the multiset consumes one hydrated twin and preserves the extra local copy', () => {
  const { utils } = createHarness();
  const current = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    { id: 'user_local_a', role: 'user', content: 'same text' },
    { id: 'user_local_b', role: 'user', content: 'same text' },
  ];
  const hydrated = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    { id: 'user_stream_7', role: 'user', content: 'same text' },
    { id: 'assistant_7', role: 'assistant', content: 'answer' },
  ];

  const merged = utils.mergeTerminalHydratedMessages(current, hydrated, {
    sessionId: 'session-dup', streamId: 'stream-other',
  });

  const sameTextUsers = merged.filter(
    (message) => message.role === 'user' && message.content === 'same text'
  );
  assert.equal(sameTextUsers.length, 2, 'one hydrated twin consumed, one genuinely-extra local copy preserved');
  assert.ok(ids(merged).includes('user_stream_7'), 'the durable twin is kept');
  assert.ok(ids(merged).includes('user_local_b'), 'the extra repeated prompt is preserved');
  assert.ok(!ids(merged).includes('user_local_a'), 'the matched optimistic copy is consumed, not duplicated');
});

test('attachments-only prompts with different attachment ids stay distinct under equal length', () => {
  const { utils } = createHarness();
  const current = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    { id: 'user_local_att', role: 'user', content: '', attachments: [{ id: 'att_2' }] },
  ];
  const hydrated = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    { id: 'user_stream_att', role: 'user', content: '', attachments: [{ id: 'att_1' }] },
  ];

  const merged = utils.mergeTerminalHydratedMessages(current, hydrated, {
    sessionId: 'session-att', streamId: 'stream-other',
  });

  assert.deepEqual(
    ids(merged),
    ['u1', 'user_local_att', 'user_stream_att'],
    'different attachment multisets are different prompts — the local one survives'
  );
});

// Green pin: canonical-id adoption. An optimistic bubble whose prompt already
// hydrated under its canonical id is consumed — never duplicated — regardless
// of list lengths.
test('an optimistic user bubble matching a hydrated prompt by content is consumed, not duplicated', () => {
  const { utils } = createHarness();
  const current = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    { id: 'user_local_x', role: 'user', content: 'the same prompt' },
  ];
  const hydrated = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    { id: 'user_stream_x', role: 'user', content: 'the same prompt' },
  ];

  const merged = utils.mergeTerminalHydratedMessages(current, hydrated, {
    sessionId: 'session-adopt', streamId: 'stream-other',
  });

  assert.deepEqual(ids(merged), ['u1', 'user_stream_x'], 'exactly one copy of the prompt survives');
});

// Green pin: the unpersisted-terminal-artifact path and the local-only path
// must not double-count the same failure bubble once the cardinality gate is
// gone — the artifact appears exactly once.
test('a local failure artifact plus a newly hydrated assistant result: artifact kept exactly once', () => {
  const { utils, logs } = createHarness();
  const failedBubble = {
    id: 'assistant_stream_f', role: 'assistant', status: 'error',
    streamId: 'stream_f', content: 'partial text before the crash',
  };
  const current = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    failedBubble,
  ];
  const hydrated = [
    { id: 'u1', role: 'user', content: 'first prompt' },
    { id: 'assistant_other', role: 'assistant', content: 'an unrelated durable answer' },
  ];

  const merged = utils.mergeTerminalHydratedMessages(current, hydrated, {
    sessionId: 'session-artifact', streamId: 'stream_f',
  });

  const artifactCopies = merged.filter((message) => String(message.id) === 'assistant_stream_f');
  assert.equal(artifactCopies.length, 1, 'the failure artifact is preserved exactly once (no double-count)');
  assert.ok(ids(merged).includes('assistant_other'), 'the hydrated assistant result is kept');
  assert.ok(
    logs.some((entry) => entry.event === 'stream.terminal_hydration_kept_unpersisted_bubble'),
    'keeping the unpersisted bubble stays diagnosed'
  );
});

test('a complete unsaved reply survives terminal hydration when no canonical twin exists', () => {
  const { utils } = createHarness();
  const unsaved = {
    id: 'assistant_stream_unsaved',
    role: 'assistant',
    status: 'complete',
    streamId: 'stream_unsaved',
    content: 'Useful output whose durable write failed.',
    durability: { state: 'unsaved', reason: 'write_failed', scope: 'assistant' },
  };

  const merged = utils.mergeTerminalHydratedMessages([unsaved], [], {
    sessionId: 'session-unsaved',
    streamId: 'stream_unsaved',
  });

  assert.deepEqual(ids(merged), ['assistant_stream_unsaved']);
  assert.equal(merged[0].durability.state, 'unsaved');
});

test('an ordinary complete local reply remains deduped when hydration has no stream marker', () => {
  const { utils } = createHarness();
  const ordinaryComplete = {
    id: 'assistant_stream_complete',
    role: 'assistant',
    status: 'complete',
    streamId: 'stream_complete',
    content: 'Already persisted output.',
  };

  const merged = utils.mergeTerminalHydratedMessages([ordinaryComplete], [], {
    sessionId: 'session-complete',
    streamId: 'stream_complete',
  });

  assert.deepEqual(merged, []);
});

test('a durable canonical message with the same id wins over the complete unsaved local reply', () => {
  const { utils } = createHarness();
  const unsaved = {
    id: 'assistant_same', role: 'assistant', status: 'complete',
    streamId: 'stream_same', content: 'local',
    durability: { state: 'unsaved' },
  };
  const canonical = {
    id: 'assistant_same', role: 'assistant', status: 'complete', content: 'durable',
  };

  const merged = utils.mergeTerminalHydratedMessages([unsaved], [canonical], {
    sessionId: 'session-same', streamId: 'stream_same',
  });

  assert.deepEqual(merged, [canonical]);
});

test('a durable canonical client-identity twin wins even when its row id differs', () => {
  const { utils } = createHarness();
  const unsaved = {
    id: 'assistant_local', role: 'assistant', status: 'complete',
    streamId: 'stream_client', content: 'local',
    client_message_id: 'assistant_client_identity',
    durability: { state: 'unsaved' },
  };
  const canonical = {
    id: 'assistant_canonical', role: 'assistant', status: 'complete', content: 'durable',
    client_message_id: 'assistant_client_identity',
  };

  const merged = utils.mergeTerminalHydratedMessages([unsaved], [canonical], {
    sessionId: 'session-client', streamId: 'stream_client',
  });

  assert.deepEqual(merged, [canonical]);
});
