// Cross-seam regression: the terminal coordinator mints the final segment id
// itself, so it must perform the same reasoning-event retarget the boundary
// segment path does. Without it the durable reasoning_phase event anchors to a
// synthetic assistant id no message carries, and the reload projection falls
// back to event_seq -- rendering the final thought BELOW the final answer.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  settleManagedAssistantCompletion,
} = require('../services/backend/chat-stream-managed-terminal-settlement');
const {
  CanonicalTurnEventCollector,
} = require('../services/backend/canonical-turn-event-collector');
const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');

const STREAM_ID = 'stream_own';
const SESSION_ID = 'session_own';
const BASE_ID = `assistant_${STREAM_ID}`;
const FINAL_PHASE_ID = 'phase_reasoning_iter2_1';

// Rows already durable when the terminal settle runs: a reasoning-only pre-tool
// segment (content-less, so visibleAssistantMessageId stays unset and the live
// reasoning capture keeps pointing at the synthetic base id) and the tool span.
function priorMessages() {
  return [
    { id: `user_${STREAM_ID}`, role: 'user', content: 'go', parent_stream_id: STREAM_ID },
    {
      id: `${BASE_ID}_seg0`,
      role: 'assistant',
      content: '',
      parent_stream_id: STREAM_ID,
      phases: [{ phase_kind: 'reasoning', phase_id: 'phase_reasoning_iter1_1' }],
      reasoning: {
        source: 'provider',
        entries: [{ id: 'entry_pre', text: 'Planning the read.', timestamp: 't1' }],
      },
    },
    {
      id: `tool_use_${STREAM_ID}_call_1`,
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_1', tool_name: 'Read', parent_stream_id: STREAM_ID, status: 'completed',
      },
    },
    {
      id: `tool_result_${STREAM_ID}_call_1`,
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_1', tool_name: 'Read', output_text: 'ok', parent_stream_id: STREAM_ID,
      },
    },
  ];
}

function scenario({ reasoningAnchorId = BASE_ID } = {}) {
  const messages = priorMessages();
  const captured = [];
  const store = {
    getSessionMessages: () => messages.map((message) => ({ ...message })),
    commitTerminal() {},
  };
  const collector = new CanonicalTurnEventCollector({
    store, turnId: STREAM_ID, sessionId: SESSION_ID,
  });

  // Live capture in wire order: the tool span, then the post-tool reasoning
  // phase that the final answer belongs under.
  collector.noteEvent({
    turn_id: STREAM_ID, kind: 'tool_use', event_id: `${STREAM_ID}:tool_use:call_1`,
    tool_call_id: 'call_1', status: 'completed',
    primary_message_id: `tool_use_${STREAM_ID}_call_1`,
    source_message_ids: [`tool_use_${STREAM_ID}_call_1`],
    payload: { tool_name: 'Read' },
  });
  collector.noteEvent({
    turn_id: STREAM_ID, kind: 'approval_requested',
    event_id: `${STREAM_ID}:approval_requested:call_1`,
    tool_call_id: 'call_1', status: 'approval_pending',
    primary_message_id: `tool_use_${STREAM_ID}_call_1`,
    source_message_ids: [`tool_use_${STREAM_ID}_call_1`],
    payload: { tool_name: 'Read' },
  });
  collector.noteEvent({
    turn_id: STREAM_ID, kind: 'approval_resolved',
    event_id: `${STREAM_ID}:approval_resolved:call_1`,
    tool_call_id: 'call_1', status: 'completed',
    primary_message_id: `tool_use_${STREAM_ID}_call_1`,
    source_message_ids: [`tool_use_${STREAM_ID}_call_1`],
    payload: { tool_name: 'Read', decision: 'approved' },
  });
  collector.noteEvent({
    turn_id: STREAM_ID, kind: 'tool_executing',
    event_id: `${STREAM_ID}:tool_executing:call_1`,
    tool_call_id: 'call_1', status: 'running',
    primary_message_id: `tool_use_${STREAM_ID}_call_1`,
    source_message_ids: [`tool_use_${STREAM_ID}_call_1`],
    payload: { tool_name: 'Read' },
  });
  collector.noteEvent({
    turn_id: STREAM_ID, kind: 'tool_result', event_id: `${STREAM_ID}:tool_result:call_1`,
    tool_call_id: 'call_1', status: 'completed',
    primary_message_id: `tool_result_${STREAM_ID}_call_1`,
    source_message_ids: [`tool_result_${STREAM_ID}_call_1`],
    payload: { tool_name: 'Read', output_text: 'ok' },
  });
  collector.noteEvent({
    turn_id: STREAM_ID, kind: 'reasoning_phase',
    event_id: `${STREAM_ID}:reasoning_phase:live:1`,
    phase_id: FINAL_PHASE_ID, status: 'open',
    primary_message_id: reasoningAnchorId,
    source_message_ids: [reasoningAnchorId],
    payload: {
      phase_id: FINAL_PHASE_ID, phase_kind: 'reasoning', thinking_id: FINAL_PHASE_ID,
      entries: [{ id: 'entry_final', text: 'Weighing the result.', timestamp: 't2' }],
      chunk_count: 1,
    },
  });

  const slice = {
    phases: [
      { phase_kind: 'reasoning', phase_id: FINAL_PHASE_ID },
      { phase_kind: 'text', phase_id: 'phase_text_iter2_2' },
    ],
    visibleSegments: [
      { segment_id: `segment_${STREAM_ID}_1`, phase_id: 'phase_text_iter2_2', text: 'Final answer.' },
    ],
    toolSteps: [],
  };

  const ctx = {
    service: {
      terminalCoordinator: {
        async settle(request) {
          captured.push(request);
          return { ok: true, visibleTerminal: true, durableTerminal: true };
        },
      },
    },
    turnLease: {
      identity: {
        sessionId: SESSION_ID, sessionIncarnation: 'inc_1', generation: 1,
        turnId: STREAM_ID, streamId: STREAM_ID, userMessageId: `user_${STREAM_ID}`,
      },
      store,
    },
    streamId: STREAM_ID,
    resolvedSessionId: SESSION_ID,
    assistantBaseMessageId: BASE_ID,
    assistantText: 'Final answer.',
    currentSegmentText: 'Final answer.',
    textSegmentIndex: 1,
    hasPersistedSegments: true,
    persistedTextSegmentIds: [`${BASE_ID}_seg0`],
    segmentPersistRefused: false,
    refusedTextSegments: [],
    reasoningEntries: [],
    model: 'local',
    normalizedPreferences: {},
    normalizedInteractiveResponse: null,
    exchangeTitle: '',
    eventBase: { streamId: STREAM_ID },
    turnUsage: null,
    unfinishedToolRepairs: [],
    turnEventCollector: collector,
    transcriptCollector: { slice, completeCurrentPhase() {}, resetSlice() {} },
    visibleCompletionEmitted: false,
    terminalPersistRefused: false,
    visibleAssistantMessageId: '',
    onVisibleCompletion() {},
    streamSawBatch: false,
    userMessagePersisted: true,
    terminalCoordinatorHandled: false,
  };

  return { ctx, captured, messages };
}

function hydrate(captured, messages) {
  const request = captured[0];
  const finalMessages = [...messages, ...request.messages];
  return projectTurnTree({
    messages: normalizeChatMessages(finalMessages),
    turn_event_log_version: 1,
    turn_events: request.turnEvents,
  });
}

function finalSegmentId(request) {
  return `${BASE_ID}_seg1`;
}

test('the terminal coordinator persists the final reasoning under the segment that carries it', async () => {
  const { ctx, captured } = scenario();

  await settleManagedAssistantCompletion(ctx);

  const reasoning = captured[0].turnEvents.filter((event) => event.kind === 'reasoning_phase');
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0].phase_id, FINAL_PHASE_ID);
  assert.equal(reasoning[0].primary_message_id, finalSegmentId(captured[0]));
  assert.deepEqual(reasoning[0].source_message_ids, [finalSegmentId(captured[0])]);
});

test('a rehydrated segmented turn renders the final thought above the final answer', async () => {
  const { ctx, captured, messages } = scenario();

  await settleManagedAssistantCompletion(ctx);
  const events = hydrate(captured, messages).turns[0].events;

  const reasoningIndex = events.findIndex((event) => event.kind === 'reasoning_phase');
  const answerIndex = events.findIndex((event) => event.kind === 'assistant_text_segment');
  assert.ok(reasoningIndex >= 0, 'the reasoning phase must survive rehydration');
  assert.ok(answerIndex >= 0, 'the final answer must survive rehydration');
  assert.ok(
    reasoningIndex < answerIndex,
    `final thought must sort above the final answer, got ${JSON.stringify(
      events.map((event) => [event.kind, event.sort_key])
    )}`
  );
  // The orphaned-ownership signature: an event whose anchor matches no message
  // falls back to event_seq, which is what put the thought below the answer.
  assert.equal(
    events.some((event) => event.primary_message_id === BASE_ID),
    false,
    'no durable event may anchor to the synthetic base assistant id'
  );
});

test('a stale anchor on the previous segment is retargeted onto the final one', async () => {
  // Second production shape: when the last boundary segment carried TEXT,
  // visibleAssistantMessageId advanced, so the post-tool reasoning was captured
  // on that EARLIER segment. It resolves to a real message, so it does not fall
  // back to event_seq -- it sorts above the tool rows it actually followed.
  const { ctx, captured, messages } = scenario({ reasoningAnchorId: `${BASE_ID}_seg0` });

  await settleManagedAssistantCompletion(ctx);

  const reasoning = captured[0].turnEvents.find((event) => event.kind === 'reasoning_phase');
  assert.equal(reasoning.primary_message_id, `${BASE_ID}_seg1`);

  const events = hydrate(captured, messages).turns[0].events;
  const kinds = events.map((event) => event.kind);
  assert.ok(
    kinds.indexOf('reasoning_phase') > kinds.lastIndexOf('tool_result'),
    `the thought must follow the tool span it came after, got ${JSON.stringify(kinds)}`
  );
  assert.ok(kinds.indexOf('reasoning_phase') < kinds.indexOf('assistant_text_segment'));
});

test('a text-less settle persists a reasoning-only segment after the tool span', async () => {
  const { ctx, captured, messages } = scenario({ reasoningAnchorId: `${BASE_ID}_seg0` });
  messages[1].content = 'Answer before the tool.';
  ctx.assistantText = 'Answer before the tool.';
  ctx.currentSegmentText = '';
  ctx.visibleAssistantMessageId = `${BASE_ID}_seg0`;
  ctx.transcriptCollector.slice.phases = [{
    phase_kind: 'reasoning',
    phase_id: FINAL_PHASE_ID,
    entries: [{ id: 'entry_final', text: 'Weighing the result.', timestamp: 't2' }],
  }];
  ctx.transcriptCollector.slice.visibleSegments = [];

  await settleManagedAssistantCompletion(ctx);

  assert.deepEqual(
    captured[0].messages.map((message) => [message.id, message.content]),
    [[`${BASE_ID}_seg1`, '']]
  );
  const events = hydrate(captured, messages).turns[0].events;
  const kinds = events.map((event) => event.kind);
  assert.ok(
    kinds.indexOf('reasoning_phase') > kinds.lastIndexOf('tool_result'),
    `the trailing thought must follow the tool span, got ${JSON.stringify(kinds)}`
  );
  assert.equal(
    events.find((event) => event.kind === 'reasoning_phase').primary_message_id,
    `${BASE_ID}_seg1`
  );
});
