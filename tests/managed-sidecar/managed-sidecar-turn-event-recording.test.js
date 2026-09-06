const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createManagedChatStreamRuntime,
} = require('../../services/backend/chat-stream-managed-runtime');
const {
  CanonicalTurnEventCollector,
} = require('../../services/backend/canonical-turn-event-collector');

// Pins the turn-event RECORDING contract of the managed runtime against the
// 2026-06-11 live-session defect (sess_*efe5d15c9a90, turn stream_*d296e97e):
// a plan-mode multi-tool turn persisted 1,415 per-chunk reasoning_phase
// events and only one assistant_text_segment event (final segment, index 0).
// Expected: one reasoning event per phase, one text-segment event per
// text-bearing persisted segment with the per-turn segment index, and
// reasoning events that reference the persisted segment message carrying them.

function makeService(persistedMessages) {
  return {
    featureFlags: { phase_events: true },
    emit() {},
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        persistedMessages.push(message);
        return message;
      },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
}

function makeRuntime(streamId, service, collector, options = {}) {
  return createManagedChatStreamRuntime({
    service,
    resolvedSessionId: `session-${streamId}`,
    streamId,
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: `user-${streamId}`,
    turnEventCollector: collector,
    canonicalBridge: options.canonicalBridge === true,
  });
}

function streamReasoning(runtime, context, { thinkingId, chunks }) {
  for (const delta of chunks) {
    runtime.handleNotification({
      method: 'chat.thinking',
      params: {
        delta,
        thinking_id: thinkingId,
        kind: 'reasoning',
        persist: true,
      },
    }, context);
  }
}

function streamTool(runtime, context, callId) {
  runtime.handleNotification({
    method: 'tool.executing',
    params: { tool_call_id: callId, tool_name: 'workspace_write', tool_input: {} },
  }, context);
  runtime.handleNotification({
    method: 'tool.result',
    params: { tool_call_id: callId, tool_name: 'workspace_write', success: true, output: 'ok' },
  }, context);
}

test('canonical assistant text retains completion_source for durable diagnosis', () => {
  const streamId = 'stream-completion-source';
  const persistedMessages = [];
  const collector = new CanonicalTurnEventCollector({ turnId: streamId });
  const runtime = makeRuntime(streamId, makeService(persistedMessages), collector);
  const context = { toolContext: {}, handleToolNotification() {} };

  runtime.handleNotification({
    method: 'turn.event',
    params: {
      v: 1,
      turn_id: streamId,
      seq: 1,
      type: 'text_part_completed',
      event_id: `${streamId}:text:completed`,
      payload: {
        text: 'Fallback answer.',
        completion_source: 'deterministic_tool_fallback',
      },
    },
  }, context);

  const event = collector.capturedEvents.find(
    (entry) => entry.kind === 'assistant_text_segment'
  );
  assert.ok(event);
  assert.equal(event.payload.text, 'Fallback answer.');
  assert.equal(event.payload.completion_source, 'deterministic_tool_fallback');
});

test('multi-tool turn records one reasoning_phase event per phase, not per chunk', async () => {
  const streamId = 'stream-event-recording';
  const persistedMessages = [];
  const collector = new CanonicalTurnEventCollector({ turnId: streamId });
  const runtime = makeRuntime(streamId, makeService(persistedMessages), collector);
  const context = { toolContext: {}, handleToolNotification() {} };

  // Three iterations of (reasoning x many chunks -> tool), then a final answer.
  for (let iteration = 1; iteration <= 3; iteration += 1) {
    streamReasoning(runtime, context, {
      thinkingId: `think_iter${iteration}`,
      chunks: Array.from({ length: 40 }, (_unused, index) => `iter${iteration} word${index} `),
    });
    streamTool(runtime, context, `call_${iteration}`);
  }
  streamReasoning(runtime, context, {
    thinkingId: 'think_final',
    chunks: ['final ', 'reasoning.'],
  });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Here is the final answer.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  const reasoningEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'reasoning_phase'
  );
  // 4 phases streamed (3 pre-tool + 1 final) -> exactly 4 events, never 122.
  assert.equal(reasoningEvents.length, 4);
  for (const event of reasoningEvents) {
    assert.ok(event.payload.entries.length >= 1);
  }
  // The coalesced entry carries the full cumulative phase text.
  assert.match(reasoningEvents[0].payload.entries[0].text, /word39\s*$/);
  assert.equal(reasoningEvents[0].payload.chunk_count, 40);
});

test('multi-tool turn records a text-segment event per persisted segment and retargets reasoning onto segment messages', async () => {
  const streamId = 'stream-segment-events';
  const persistedMessages = [];
  const collector = new CanonicalTurnEventCollector({ turnId: streamId });
  const runtime = makeRuntime(streamId, makeService(persistedMessages), collector);
  const context = { toolContext: {}, handleToolNotification() {} };

  // Segment 0: reasoning + visible text, then a tool boundary.
  streamReasoning(runtime, context, { thinkingId: 'think_iter1', chunks: ['plan it.'] });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Text before the tool.' },
  }, context);
  streamTool(runtime, context, 'call_1');
  // Segment 1: reasoning only (gemma-style), then another tool.
  streamReasoning(runtime, context, { thinkingId: 'think_iter2', chunks: ['tool again.'] });
  streamTool(runtime, context, 'call_2');
  // Segment 2: final reasoning + answer.
  streamReasoning(runtime, context, { thinkingId: 'think_iter3', chunks: ['answer now.'] });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Final answer after tools.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  const assistantSegments = persistedMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantSegments.length, 3);

  const textEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'assistant_text_segment'
  );
  // One event per TEXT-BEARING persisted segment (seg1 is reasoning-only).
  assert.equal(textEvents.length, 2);
  assert.equal(textEvents[0].primary_message_id, `assistant_${streamId}_seg0`);
  assert.equal(textEvents[0].payload.text, 'Text before the tool.');
  assert.equal(textEvents[0].payload.segment_index, 0);
  assert.equal(textEvents[0].segment_group_index, 0);
  assert.equal(textEvents[1].primary_message_id, `assistant_${streamId}_seg2`);
  assert.equal(textEvents[1].payload.text, 'Final answer after tools.');
  assert.equal(textEvents[1].payload.segment_index, 2);
  assert.equal(textEvents[1].segment_group_index, 2);

  // Reasoning events reference the persisted segment message that carries the
  // phase, so reasoning-only segments enter the timeline projection too.
  const reasoningEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'reasoning_phase'
  );
  assert.equal(reasoningEvents.length, 3);
  assert.equal(reasoningEvents[0].primary_message_id, `assistant_${streamId}_seg0`);
  assert.equal(reasoningEvents[1].primary_message_id, `assistant_${streamId}_seg1`);
  assert.equal(reasoningEvents[2].primary_message_id, `assistant_${streamId}_seg2`);
});

test('simple turn keeps reasoning events on the base assistant message id', async () => {
  const streamId = 'stream-simple-turn';
  const persistedMessages = [];
  const collector = new CanonicalTurnEventCollector({ turnId: streamId });
  const runtime = makeRuntime(streamId, makeService(persistedMessages), collector);
  const context = { toolContext: {}, handleToolNotification() {} };

  streamReasoning(runtime, context, { thinkingId: 'think_simple', chunks: ['just answer.'] });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'A plain answer.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  // No tool boundary -> the final message persists under the base id, and the
  // reasoning events must keep referencing it.
  const assistantMessages = persistedMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].id, `assistant_${streamId}`);
  const reasoningEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'reasoning_phase'
  );
  assert.equal(reasoningEvents.length, 1);
  assert.equal(reasoningEvents[0].primary_message_id, `assistant_${streamId}`);
});

test('phase_events changes wire emission only, not the managed persisted text phase shape', async () => {
  async function runStream(phaseEventsEnabled) {
    const streamId = 'stream-phase-events-parity';
    const persistedMessages = [];
    const collector = new CanonicalTurnEventCollector({ turnId: streamId });
    const service = makeService(persistedMessages);
    service.featureFlags.phase_events = phaseEventsEnabled;
    const runtime = makeRuntime(streamId, service, collector);
    const context = { toolContext: {}, handleToolNotification() {} };

    for (const delta of ['Hello', ', ', 'managed world.']) {
      runtime.handleNotification({ method: 'chat.token', params: { delta } }, context);
    }
    await runtime.settleTerminalResult({ status: 'completed' });

    const assistant = persistedMessages.find((message) => message.role === 'assistant');
    return {
      id: assistant.id,
      content: assistant.content,
      phases: assistant.phases.map((phase) => ({
        phase_id: phase.phase_id,
        phase_kind: phase.phase_kind,
        iteration: phase.iteration,
      })),
      visible_segments: assistant.visible_segments,
    };
  }

  const flagOff = await runStream(false);
  const flagOn = await runStream(true);

  assert.deepEqual(flagOff, flagOn);
  assert.deepEqual(flagOn, {
    id: 'assistant_stream-phase-events-parity',
    content: 'Hello, managed world.',
    phases: [{
      phase_id: 'phase_text_stream-phase-events-parity_1',
      phase_kind: 'text',
      iteration: 0,
    }],
    visible_segments: [{
      segment_id: 'segment_stream-phase-events-parity_1',
      phase_id: 'phase_text_stream-phase-events-parity_1',
      text: 'Hello, managed world.',
    }],
  });
});

test('stream reset discards live text/reasoning capture so finalize cannot persist stale segment events', async () => {
  const streamId = 'stream-reset-capture';
  const persistedMessages = [];
  const collector = new CanonicalTurnEventCollector({ turnId: streamId });
  const runtime = makeRuntime(streamId, makeService(persistedMessages), collector);
  const context = { toolContext: {}, handleToolNotification() {} };

  streamReasoning(runtime, context, { thinkingId: 'think_pre_reset', chunks: ['stale.'] });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Stale text. ' },
  }, context);
  streamTool(runtime, context, 'call_pre_reset');
  runtime.handleNotification({ method: 'chat.stream_reset', params: {} }, context);
  streamReasoning(runtime, context, { thinkingId: 'think_post_reset', chunks: ['fresh.'] });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Fresh answer.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  const textEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'assistant_text_segment'
  );
  assert.equal(textEvents.length, 0);
  const reasoningEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'reasoning_phase'
  );
  assert.equal(reasoningEvents.length, 1);
  assert.match(reasoningEvents[0].payload.entries[0].text, /fresh/);
});

test('tool_continuation reset preserves pre-tool commentary as a phased segment when the display flag is on', async () => {
  const streamId = 'stream-reset-preserve';
  const persistedMessages = [];
  const collector = new CanonicalTurnEventCollector({ turnId: streamId });
  const service = makeService(persistedMessages);
  // Phase 1 preservation is gated behind the shared display flag + canonical path.
  service.featureFlags.response_loop_display_v2 = true;
  const runtime = makeRuntime(streamId, service, collector, { canonicalBridge: true });
  const context = { toolContext: {}, handleToolNotification() {} };

  // Segment 0: pre-tool reasoning + genuine commentary, then a tool boundary.
  streamReasoning(runtime, context, { thinkingId: 'think_pre', chunks: ['plan it.'] });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Let me check the file. ' },
  }, context);
  streamTool(runtime, context, 'call_commentary');
  // The benign loop restart after the tool round: preserve, do not discard.
  runtime.handleNotification(
    { method: 'chat.stream_reset', params: { reason: 'tool_continuation' } },
    context,
  );
  // Final iteration: reasoning + the answer.
  streamReasoning(runtime, context, { thinkingId: 'think_final', chunks: ['answer now.'] });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Here is the answer.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  const textEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'assistant_text_segment'
  );
  // Both the preserved commentary (seg0) and the final answer (seg1) survive.
  assert.equal(textEvents.length, 2);
  assert.equal(textEvents[0].primary_message_id, `assistant_${streamId}_seg0`);
  assert.equal(textEvents[0].payload.text, 'Let me check the file. ');
  // The first pre-tool slice is stamped commentary (Codex-style phase).
  assert.equal(textEvents[0].payload.assistant_phase, 'commentary');
  // The final answer stays unstamped so the renderer's positional pass marks it
  // final_answer rather than honoring an explicit intermediate/commentary phase.
  assert.equal(textEvents[1].payload.text, 'Here is the answer.');
  assert.equal(textEvents[1].payload.assistant_phase, undefined);

  // Interleaved reasoning is retargeted onto each carrying segment, not lost.
  const reasoningEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'reasoning_phase'
  );
  assert.equal(reasoningEvents.length, 2);
  assert.equal(reasoningEvents[0].primary_message_id, `assistant_${streamId}_seg0`);
  assert.match(reasoningEvents[0].payload.entries[0].text, /plan it/);
  // The post-reset reasoning rides the FINAL answer's segment, not seg0 — a
  // retargeting regression (e.g. the reasoning ordinal not advancing across the
  // preserved reset) would surface here even though the length check passes.
  assert.equal(reasoningEvents[1].primary_message_id, textEvents[1].primary_message_id);
  assert.notEqual(reasoningEvents[1].primary_message_id, `assistant_${streamId}_seg0`);
  assert.match(reasoningEvents[1].payload.entries[0].text, /answer now/);
});

function phaseStarted(runtime, context, { phaseId, thinkingId, iteration }) {
  runtime.handleNotification({
    method: 'chat.phase_started',
    params: {
      phase_id: phaseId,
      phase_kind: 'reasoning',
      iteration,
      thinking_id: thinkingId,
    },
  }, context);
}

test('sidecar phase-id reuse after an approval resume keeps one reasoning event per segment', async () => {
  // 2026-07-06 reasoning mis-retargeting RCA (sess_1783175733195, turn
  // stream_1783175987817): the sidecar restarts iteration numbering at 1 when
  // a tool loop resumes after an approval, so a post-resume reasoning phase
  // carries the SAME phase_id/thinking_id as the first iteration
  // (phase_reasoning_<req>_iter1_1 / think_<req>_iter1). The collector's
  // phase-keyed dedupe then merged both phases into one captured event and the
  // final segment's retarget stole it from seg0, leaving seg0's reasoning
  // entry unreferenced by any event.
  const streamId = 'stream-phase-id-reuse';
  const persistedMessages = [];
  const collector = new CanonicalTurnEventCollector({ turnId: streamId });
  const runtime = makeRuntime(streamId, makeService(persistedMessages), collector);
  const context = { toolContext: {}, handleToolNotification() {} };

  // Iteration 1: reasoning-only slice, then a tool boundary.
  phaseStarted(runtime, context, {
    phaseId: `phase_reasoning_${streamId}_iter1_1`,
    thinkingId: `think_${streamId}_iter1`,
    iteration: 1,
  });
  streamReasoning(runtime, context, {
    thinkingId: `think_${streamId}_iter1`,
    chunks: ['first thoughts.'],
  });
  streamTool(runtime, context, 'call_1');
  // Iteration 2: second reasoning slice, then the tool that needs approval.
  phaseStarted(runtime, context, {
    phaseId: `phase_reasoning_${streamId}_iter2_1`,
    thinkingId: `think_${streamId}_iter2`,
    iteration: 2,
  });
  streamReasoning(runtime, context, {
    thinkingId: `think_${streamId}_iter2`,
    chunks: ['second thoughts.'],
  });
  streamTool(runtime, context, 'call_2');
  // The approval-resumed loop restarts numbering: IDENTICAL ids to iteration 1.
  phaseStarted(runtime, context, {
    phaseId: `phase_reasoning_${streamId}_iter1_1`,
    thinkingId: `think_${streamId}_iter1`,
    iteration: 1,
  });
  streamReasoning(runtime, context, {
    thinkingId: `think_${streamId}_iter1`,
    chunks: ['third thoughts.'],
  });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Final answer after the resume.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  const assistantSegments = persistedMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantSegments.length, 3);

  const reasoningEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'reasoning_phase'
  );
  // One event per segment slice — the reused phase id must NOT merge the
  // post-resume phase into iteration 1's already-sealed event.
  assert.equal(reasoningEvents.length, 3);
  assert.equal(reasoningEvents[0].primary_message_id, `assistant_${streamId}_seg0`);
  assert.equal(reasoningEvents[1].primary_message_id, `assistant_${streamId}_seg1`);
  assert.equal(reasoningEvents[2].primary_message_id, `assistant_${streamId}_seg2`);
  // Each event carries only its own phase's entries (no cross-slice merge).
  assert.equal(reasoningEvents[0].payload.entries.length, 1);
  assert.match(reasoningEvents[0].payload.entries[0].text, /first thoughts/);
  assert.equal(reasoningEvents[2].payload.entries.length, 1);
  assert.match(reasoningEvents[2].payload.entries[0].text, /third thoughts/);
  // Distinct event ids: a reused phase key after a boundary must mint a fresh
  // live ordinal (the journal dedupes by event_id).
  const eventIds = new Set(reasoningEvents.map((event) => event.event_id));
  assert.equal(eventIds.size, 3);
});

test('a tool boundary breaks reasoning-entry coalescing so no entry id spans two segments', async () => {
  // Sibling defect (sess_1783373307787 haiku turn): with absent/unchanged
  // thinking ids the tail entry kept coalescing ACROSS the tool boundary, so
  // the same entry id (with two different phase windows) persisted on both
  // seg0 and seg1 and the same "Thought" rendered twice.
  const streamId = 'stream-boundary-entry-break';
  const persistedMessages = [];
  const collector = new CanonicalTurnEventCollector({ turnId: streamId });
  const runtime = makeRuntime(streamId, makeService(persistedMessages), collector);
  const context = { toolContext: {}, handleToolNotification() {} };

  // No thinking ids at all (legacy models): phaseChanged never fires.
  streamReasoning(runtime, context, { thinkingId: '', chunks: ['step one thinking.'] });
  streamTool(runtime, context, 'call_a');
  streamReasoning(runtime, context, { thinkingId: '', chunks: ['step two thinking.'] });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Done.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  const assistantSegments = persistedMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantSegments.length, 2);
  const [seg0, seg1] = assistantSegments;
  const seg0Entries = seg0.reasoning?.entries || [];
  const seg1Entries = seg1.reasoning?.entries || [];
  assert.equal(seg0Entries.length, 1);
  assert.equal(seg1Entries.length, 1);
  // The boundary must start a NEW entry: no shared ids, and seg0's persisted
  // text must not have been extended by post-boundary deltas.
  assert.notEqual(seg0Entries[0].id, seg1Entries[0].id);
  assert.equal(seg0Entries[0].text, 'step one thinking.');
  assert.equal(seg1Entries[0].text, 'step two thinking.');
});

test('reasoning chunk-final newlines survive coalescing into the persisted entry', async () => {
  // Newline-loss sibling: coalescing appended the next delta to the SANITIZED
  // (trailing-trimmed) previous text, so every newline that ended a chunk was
  // destroyed at the join ("sequentially:1. Create...haiku2. Edit").
  const streamId = 'stream-newline-preserve';
  const persistedMessages = [];
  const collector = new CanonicalTurnEventCollector({ turnId: streamId });
  const runtime = makeRuntime(streamId, makeService(persistedMessages), collector);
  const context = { toolContext: {}, handleToolNotification() {} };

  streamReasoning(runtime, context, {
    thinkingId: 'think_newlines',
    chunks: ['I will proceed sequentially:\n', '1. Create the haiku\n', '2. Edit the file'],
  });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Here it is.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  const assistantMessages = persistedMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
  const entries = assistantMessages[0].reasoning?.entries || [];
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].text,
    'I will proceed sequentially:\n1. Create the haiku\n2. Edit the file'
  );
});

test('tool_continuation reset preserves commentary with the canonical bridge OFF (default config)', async () => {
  // 2026-07-06 completion-flicker RCA: canonical_bridge defaults off, and the
  // old preserve gate required it — so every default-config multi-tool turn
  // discarded its interim reasoning/commentary from the turn-event log and the
  // terminal reconcile deleted the live rows the user had watched stream.
  const streamId = 'stream-reset-preserve-nobridge';
  const persistedMessages = [];
  const collector = new CanonicalTurnEventCollector({ turnId: streamId });
  const service = makeService(persistedMessages);
  service.featureFlags.response_loop_display_v2 = true;
  const runtime = makeRuntime(streamId, service, collector, { canonicalBridge: false });
  const context = { toolContext: {}, handleToolNotification() {} };

  streamReasoning(runtime, context, { thinkingId: 'think_pre', chunks: ['plan it.'] });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Let me check the file. ' },
  }, context);
  streamTool(runtime, context, 'call_commentary_nb');
  runtime.handleNotification(
    { method: 'chat.stream_reset', params: { reason: 'tool_continuation' } },
    context,
  );
  streamReasoning(runtime, context, { thinkingId: 'think_final', chunks: ['answer now.'] });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Here is the answer.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  const textEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'assistant_text_segment'
  );
  assert.equal(textEvents.length, 2);
  assert.equal(textEvents[0].payload.text, 'Let me check the file. ');
  assert.equal(textEvents[1].payload.text, 'Here is the answer.');
  const reasoningEvents = collector.capturedEvents.filter(
    (event) => event.kind === 'reasoning_phase'
  );
  assert.equal(reasoningEvents.length, 2);
  assert.match(reasoningEvents[0].payload.entries[0].text, /plan it/);
  assert.match(reasoningEvents[1].payload.entries[0].text, /answer now/);
});
