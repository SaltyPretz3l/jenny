const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPipelineHarness,
  withWindowGlobals,
  createRenderDom,
} = require('./helpers/render-pipeline-test-harness');

const SESSION_ID = 'session-row-count-sanity';

function makeTurnEventsMap(turnEvents) {
  return new Map([[SESSION_ID, { turnEventLogVersion: 3, turnEvents }]]);
}

function renderScenario(t, visibleMessages, turnEvents = []) {
  const dom = createRenderDom();
  const harness = createPipelineHarness({
    dom,
    visibleMessages,
    rowModelEnabled: true,
    currentSessionId: SESSION_ID,
    turnEventsBySession: makeTurnEventsMap(turnEvents),
  });
  harness.state.ui.chatTimelineRowModelBySession.set(SESSION_ID, true);
  t.after(() => harness.pipeline.dispose?.());
  withWindowGlobals(dom, () => {
    harness.pipeline.renderMessages({ forceFullRender: true });
  });
  return harness;
}

function rowCountSanitySignals(harness) {
  return harness.rolloutSignals.filter((entry) => entry.signal === 'row_count_sanity');
}

function projectedRowCount(harness) {
  const context = harness.uiRuntime.projectionContextBySession.get(SESSION_ID)?.currentContext;
  assert.ok(context?.rowsByTurnId instanceof Map, 'the hydrated projection must expose rows');
  let count = 0;
  for (const rows of context.rowsByTurnId.values()) {
    count += Array.isArray(rows) ? rows.length : 0;
  }
  return count;
}

function makeToolHeavyTurn(turnId, toolCount) {
  const userMessageId = `user_${turnId}`;
  const events = [{
    event_id: `event_${turnId}_user`,
    event_seq: 0,
    turn_id: turnId,
    kind: 'user_prompt',
    primary_message_id: userMessageId,
    source_message_ids: [userMessageId],
    payload: { content: 'Run the tools', attachments: [] },
  }];
  for (let index = 0; index < toolCount; index += 1) {
    const callId = `call_${turnId}_${index}`;
    const toolUseMessageId = `tool_use_${turnId}_${index}`;
    const toolResultMessageId = `tool_result_${turnId}_${index}`;
    events.push({
      event_id: `event_${turnId}_tool_use_${index}`,
      event_seq: events.length,
      turn_id: turnId,
      kind: 'tool_use',
      status: 'completed',
      tool_call_id: callId,
      primary_message_id: toolUseMessageId,
      source_message_ids: [toolUseMessageId],
      payload: { tool_name: 'Read', input_summary: `file-${index}.txt` },
    }, {
      event_id: `event_${turnId}_tool_result_${index}`,
      event_seq: events.length + 1,
      turn_id: turnId,
      kind: 'tool_result',
      status: 'completed',
      tool_call_id: callId,
      primary_message_id: toolUseMessageId,
      tool_result_message_id: toolResultMessageId,
      source_message_ids: [toolUseMessageId, toolResultMessageId],
      payload: { tool_name: 'Read', output_text: `result ${index}`, is_error: false },
    });
  }
  return {
    messages: [{
      id: userMessageId,
      role: 'user',
      content: 'Run the tools',
      status: 'complete',
      streamId: turnId,
    }],
    events,
  };
}

function makeReasoningTurn(turnId, phaseCount) {
  const phases = Array.from({ length: phaseCount }, (_, index) => ({
    phaseId: `phase_${turnId}_${index}`,
    phaseKind: 'reasoning',
    iteration: index,
    thinkingId: `thinking_${turnId}_${index}`,
    renderCollapsed: false,
    entries: [{ id: `reason_${turnId}_${index}`, text: `Reason ${index + 1}`, timestamp: '' }],
  }));
  return [{
    id: `user_${turnId}`,
    role: 'user',
    content: 'Think through this',
    status: 'complete',
    streamId: turnId,
  }, {
    id: `assistant_${turnId}`,
    role: 'assistant',
    streamId: turnId,
    content: '',
    status: 'complete',
    phases,
    visible_segments: [],
    reasoning: {
      available: true,
      status: 'complete',
      source: 'provider',
      entries: phases.flatMap((phase) => phase.entries),
    },
    reasoning_phases: phases.map((phase) => ({
      phaseId: phase.phaseId,
      phaseKind: phase.phaseKind,
      iteration: phase.iteration,
      thinkingId: phase.thinkingId,
      completed: true,
      renderCollapsed: false,
    })),
  }];
}

test('tool-heavy event-log rows do not trigger row-count rollback', (t) => {
  const turn = makeToolHeavyTurn('turn_tool_heavy', 7);
  const harness = renderScenario(t, turn.messages, turn.events);

  assert.ok(projectedRowCount(harness) > 12, 'the event log must produce enough rows to exceed the old floor');
  assert.equal(harness.state.ui.chatTimelineRowModelBySession.get(SESSION_ID), true);
  assert.deepEqual(rowCountSanitySignals(harness), []);
});

test('rows far exceeding messages and turn events still trigger row-count rollback', (t) => {
  const messages = makeReasoningTurn('turn_duplicate', 16);
  const harness = renderScenario(t, messages);
  const [signal] = rowCountSanitySignals(harness);

  assert.ok(signal, 'a single message minting many reasoning rows must trip the canary');
  assert.ok(signal.details.hydratedRowCount > signal.details.rowCountLimit);
  assert.equal(signal.details.legacyVisibleCount, 2);
});

test('row-count rollback signal records the canonical turn-event population', (t) => {
  const priorTurnId = 'turn_prior';
  const priorMessages = [
    { id: 'user_prior', role: 'user', content: 'Earlier question', status: 'complete', streamId: priorTurnId },
    { id: 'assistant_prior', role: 'assistant', content: 'Earlier answer', status: 'complete', streamId: priorTurnId },
  ];
  const priorEvents = [{
    event_id: 'event_prior_user',
    event_seq: 0,
    turn_id: priorTurnId,
    kind: 'user_prompt',
    primary_message_id: 'user_prior',
    source_message_ids: ['user_prior'],
    payload: { content: 'Earlier question', attachments: [] },
  }, {
    event_id: 'event_prior_assistant',
    event_seq: 1,
    turn_id: priorTurnId,
    kind: 'assistant_text_segment',
    status: 'completed',
    primary_message_id: 'assistant_prior',
    source_message_ids: ['assistant_prior'],
    payload: { text: 'Earlier answer', segment_index: 0, segment_group_index: 0 },
  }];
  const harness = renderScenario(
    t,
    priorMessages.concat(makeReasoningTurn('turn_diagnosable', 30)),
    priorEvents
  );
  const [signal] = rowCountSanitySignals(harness);

  assert.ok(signal, 'genuine overflow must remain diagnosable when turn events are present');
  assert.equal(signal.details.turnEventCount, priorEvents.length);
});
