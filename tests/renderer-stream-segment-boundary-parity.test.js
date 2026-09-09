const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/renderer-stream-handler-harness');
const { createStreamToolHandlers } = require('../renderer/chat/renderer-stream-handler-tools');
const { persistCurrentTextSegment } = require('../services/backend/chat-stream-managed-runtime-segments');

test('empty tool boundary does not consume a renderer segment absent backend authority', async () => {
  let messages = [{ id: 'pending', role: 'assistant', content: '', reasoning: { entries: [] } }];
  const segment = { segmentIndex: 0 };
  const state = { pendingStreams: new Map([['stream-1', 'pending']]), toolCallsByStream: new Map(), pendingToolApprovals: new Map() };
  const handlers = createStreamToolHandlers({
    state, streamSegmentState: new Map([['stream-1', segment]]),
    getSessionMessages: () => messages,
    setSessionMessages: (_id, next) => { messages = next; },
    isRowModelEnabled: () => true,
    MESSAGE_STATUS: { COMPLETE: 'complete' },
  });
  const ctx = {
    currentSegmentText: '', textSegmentIndex: 0, streamId: 'stream-1', persistedTextSegmentIds: [], reasoningEntries: [],
    transcriptCollector: { completeCurrentPhase() {}, buildAssistantMessageFields: () => ({ reasoning: { entries: [] } }) },
  };
  persistCurrentTextSegment(ctx, { allowReasoningOnly: true, atToolBoundary: true });
  await handlers.handleToolUse({ type: 'tool_use', streamId: 'stream-1', sessionId: 'session-1', callId: 'call-1', toolName: 'read_file' });
  assert.equal(segment.segmentIndex, ctx.textSegmentIndex);
  assert.equal(messages.some((m) => m.id === 'pending'), false);
});

test('authoritative tool boundary names both the pending message and the live text row', async (t) => {
  const rig = createHarness({ stateOverrides: { ui: { chatTimelineRowModelBySession: new Map([['session-1', true]]) } } });
  t.after(() => { rig.handler.dispose(); rig.restore(); });
  const base = { sessionId: 'session-1', streamId: 'stream-1' };
  await rig.emit({ ...base, type: 'started' });
  await rig.emit({ ...base, type: 'tool_use', callId: 'call-1', toolName: 'read_file', next_assistant_message_id: 'assistant_stream-1_seg0' });
  await rig.emit({ ...base, type: 'delta', content: 'AFTER_TOOL', aggregate: 'AFTER_TOOL' });
  // A subsequent boundary flushes the real pending commit queue.
  await rig.emit({ ...base, type: 'tool_use', callId: 'call-2', toolName: 'read_file', next_assistant_message_id: 'assistant_stream-1_seg1' });
  const messages = rig.state.messagesBySession.get('session-1');
  assert.equal(messages.find((m) => m.content === 'AFTER_TOOL')?.id, 'assistant_stream-1_seg0');
  const live = rig.state.ui.chatTimelineLiveStateBySession.get('session-1').turns_by_id['stream-1'];
  assert.equal(live.rows.find((row) => row.payload?.text === 'AFTER_TOOL')?.primary_message_id, 'assistant_stream-1_seg0');
});


const { handleNotification } = require('../services/backend/chat-stream-managed-runtime-notifications');
const { handleToolNotification } = require('../services/backend/chat-stream-tool-handling');
const { makeCtx, canonicalEvent } = require('./helpers/managed-runtime-notification-harness');
const { buildEnvelopeSources } = require('../services/stream-envelope-shape');
const { streamEnvelopeToLegacyPayload } = require('../renderer/chat/renderer-stream-envelope-v2');
const { createPipelineHarness, createRenderDom, withWindowGlobals } = require('./helpers/render-pipeline-test-harness');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');

function backendBoundaryRig({ text = '', reasoning = [], refuse = false, canonical = false } = {}) {
  const messages = [];
  const emitted = [];
  const ctx = makeCtx({ textSegmentIndex: 0, persistedTextSegmentIds: [], currentSegmentText: text });
  const store = {
    peekSessionMessages: () => messages,
    appendMessage(_id, message) { messages.push(message); return { id: 'session-1' }; },
    updateMessage(_id, id, patch) { Object.assign(messages.find((m) => m.id === id), patch); },
  };
  ctx.service.sessionStore = store;
  ctx.service.emit = (_name, payload) => emitted.push(payload);
  ctx.adapter.appendMessage = (message) => refuse ? null : store.appendMessage('session-1', message);
  ctx.transcriptCollector.completeCurrentPhase = () => {};
  ctx.transcriptCollector.buildAssistantMessageFields = () => ({ reasoning: { source: 'provider', entries: reasoning }, phases: [] });
  ctx.transcriptCollector.resetSlice = () => { reasoning = []; };
  ctx.persistCurrentTextSegment = (options) => persistCurrentTextSegment(ctx, options);
  const toolContext = {
    seenToolCalls: new Set(), toolSummaries: new Map(), model: 'test-model', streamId: 'stream-1', resolvedSessionId: 'session-1',
    eventBase: { streamId: 'stream-1', sessionId: 'session-1' },
  };
  let seq = 0;
  function tool(callId) {
    const params = { tool_call_id: callId, tool_name: 'read_file', next_assistant_message_id: 'provider-injected-id' };
    const notification = canonical
      ? { method: 'turn.event', params: canonicalEvent('tool_execution_started', params, { seq: ++seq }) }
      : { method: 'tool.executing', params };
    handleNotification(ctx, notification, { toolContext, handleToolNotification });
    return emitted.at(-1);
  }
  return { ctx, messages, emitted, tool };
}

for (const canonical of [false, true]) {
  for (const scenario of [
    { name: 'empty', text: '', next: 0 },
    { name: 'whitespace', text: ' \n ', next: 0 },
    { name: 'text', text: 'BEFORE_TOOL', next: 1 },
    { name: 'reasoning only', reasoning: [{ text: 'Thinking before tool' }], next: 1 },
    { name: 'refused text persistence', text: 'BEFORE_TOOL', refuse: true, next: 1 },
  ]) {
    test(`${canonical ? 'canonical' : 'legacy'} backend names the post-boundary segment: ${scenario.name}`, () => {
      const backend = backendBoundaryRig({ ...scenario, canonical });
      const payload = backend.tool('call-1');
      assert.equal(payload.next_assistant_message_id, `assistant_stream-1_seg${scenario.next}`);
      assert.equal(backend.ctx.textSegmentIndex, scenario.next);
      const source = buildEnvelopeSources(payload)[0];
      const roundtrip = streamEnvelopeToLegacyPayload({ schemaVersion: 2, streamId: 'stream-1', sessionId: 'session-1', ...source });
      assert.equal(roundtrip.next_assistant_message_id, payload.next_assistant_message_id);
      if (scenario.refuse) {
        assert.equal(backend.ctx.segmentPersistRefused, true);
        assert.equal(backend.ctx.persistedTextSegmentIds.length, 0);
      }
    });
  }
}

function toolRig(message, segment = { segmentIndex: 0 }) {
  let messages = message ? [{ id: 'pending', role: 'assistant', ...message }] : [];
  const logs = [];
  const state = { pendingStreams: new Map(message ? [['stream-1', 'pending']] : []), toolCallsByStream: new Map(), pendingToolApprovals: new Map() };
  const handlers = createStreamToolHandlers({
    state, streamSegmentState: new Map([['stream-1', segment]]),
    getSessionMessages: () => messages,
    setSessionMessages: (_id, next) => { messages = next; },
    isRowModelEnabled: () => true,
    appendClientLog: (...args) => logs.push(args),
    MESSAGE_STATUS: { COMPLETE: 'complete' },
  });
  return { segment, logs, state, messages: () => messages, tool: (extra = {}) => handlers.handleToolUse({ type: 'tool_use', streamId: 'stream-1', sessionId: 'session-1', callId: 'call-1', toolName: 'read_file', ...extra }) };
}

for (const [name, message, next] of [
  ['empty shell', { content: '' }, 0],
  ['whitespace', { content: '  ' }, 0],
  ['phase shell', { reasoning_phases: [{ phaseKind: 'reasoning', summary: 'Working' }] }, 0],
  ['empty reasoning', { reasoning: { entries: [{ text: ' ' }] } }, 0],
  ['malformed reasoning', { reasoning: { entries: {} } }, 0],
  ['actual reasoning', { reasoning: { entries: [{ text: 'Evidence' }] } }, 1],
  ['text', { content: 'Evidence' }, 1],
]) {
  test(`legacy renderer boundary consumes only a content-bearing segment: ${name}`, async () => {
    const rig = toolRig(message);
    await rig.tool();
    assert.equal(rig.segment.segmentIndex, next);
    assert.equal(rig.messages().some((m) => m.id === 'pending'), next === 1);
  });
}

for (const value of ['', 'assistant_other_seg0', 'assistant_stream-1_seg-1', 'assistant_stream-1_seg1.5', 'assistant_stream-1_seg9007199254740992', { secret: 'must-not-be-logged' }]) {
  test(`malformed boundary authority falls back without retaining it: ${JSON.stringify(value)}`, async () => {
    const rig = toolRig({ content: '' });
    await rig.tool({ next_assistant_message_id: value });
    await rig.tool({ callId: 'call-2', next_assistant_message_id: value });
    assert.equal(rig.segment.segmentIndex, 0);
    assert.equal(rig.segment.authoritativeAssistantMessageId, '');
    assert.deepEqual(rig.logs, [['WARN', 'stream.assistant_segment_identity_invalid', { boundary: 'tool' }]]);
  });
}

test('approval placeholder does not consume the execution boundary; duplicate execution does not cut later text', async () => {
  const rig = toolRig({ content: 'BEFORE_TOOL' });
  await rig.tool({ status: 'pending_approval' });
  assert.equal(rig.segment.segmentIndex, 0);
  await rig.tool({ status: 'running', next_assistant_message_id: 'assistant_stream-1_seg1' });
  assert.equal(rig.segment.segmentIndex, 1);
  rig.messages().push({ id: 'later', role: 'assistant', content: 'AFTER_TOOL', status: 'streaming' });
  rig.state.pendingStreams.set('stream-1', 'later');
  await rig.tool({ status: 'running', next_assistant_message_id: 'assistant_stream-1_seg1' });
  assert.equal(rig.state.pendingStreams.get('stream-1'), 'later');
  assert.equal(rig.messages().find((m) => m.id === 'later').status, 'streaming');
  assert.equal(rig.segment.segmentIndex, 1);
});

test('backend tool boundaries keep live DOM rows in order before settlement', async (t) => {
  const dom = createRenderDom();
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  const visible = [{ id: 'user-1', role: 'user', content: 'Investigate', status: 'complete' }];
  let render;
  let canonicalMessages = [];
  let canonicalEvents = [];
  const testWindow = { jennyShell: { sessions: { getMessages: async () => ({ data: canonicalMessages, turn_events: canonicalEvents, turn_event_log_version: 4 }) } } };
  const rig = createHarness({
    stateOverrides: { window: testWindow, messagesBySession: new Map([['session-1', [...visible]]]), ui: { chatTimelineRowModelBySession: new Map([['session-1', true]]) } },
    callbackOverrides: { renderMessages: () => render?.() },
  });
  const paint = withWindowGlobals(dom, () => createPipelineHarness({ dom, visibleMessages: visible, currentSessionId: 'session-1', rowModelEnabled: true }));
  paint.state.pendingStreams = rig.state.pendingStreams;
  render = () => {
    visible.splice(0, visible.length, ...rig.state.messagesBySession.get('session-1'));
    paint.state.ui.chatTimelineLiveStateBySession = rig.state.ui.chatTimelineLiveStateBySession;
    paint.state.messagesBySession = rig.state.messagesBySession;
    paint.state.turnEventsBySession = rig.state.turnEventsBySession;
    withWindowGlobals(dom, () => paint.pipeline.renderMessages());
  };
  t.after(() => { rig.handler.dispose(); paint.pipeline.dispose(); rig.restore(); dom.window.close(); });
  const backend = backendBoundaryRig();
  const base = { sessionId: 'session-1', streamId: 'stream-1' };
  await rig.emit({ ...base, type: 'started' });
  await rig.emit({ ...base, type: 'phase_started', phaseKind: 'text', phaseId: 'empty' });
  await rig.emit(backend.tool('call-1'));
  await rig.emit({ ...base, type: 'delta', content: 'AFTER_FIRST_TOOL', aggregate: 'AFTER_FIRST_TOOL' });
  backend.ctx.currentSegmentText = 'AFTER_FIRST_TOOL';
  await rig.emit(backend.tool('call-2'));
  await rig.emit({ ...base, type: 'delta', content: 'AFTER_SECOND_TOOL', aggregate: 'AFTER_FIRST_TOOLAFTER_SECOND_TOOL' });
  // Flush staged content through a real nonterminal event, preserving a live tail.
  await rig.emit({ ...base, type: 'phase_completed', phaseKind: 'text', phaseId: 'tail' });
  render();
  const snapshot = () => [...dom.window.document.querySelectorAll('.chat-row')]
    .filter((row) => row.dataset.rowKind === 'assistant_text' || row.dataset.toolCallId)
    .map((row) => row.dataset.toolCallId || row.textContent.trim());
  assert.deepEqual(snapshot(), ['call-1', 'AFTER_FIRST_TOOL', 'call-2', 'AFTER_SECOND_TOOL']);
  const live = rig.state.ui.chatTimelineLiveStateBySession.get('session-1').turns_by_id['stream-1'];
  assert.deepEqual(live.rows.filter((row) => row.kind === 'assistant_text').map((row) => row.primary_message_id), ['assistant_stream-1_seg0', 'assistant_stream-1_seg1']);
  assert.ok(rig.state.pendingStreams.has('stream-1'), 'order is checked while the turn is live');
  backend.ctx.currentSegmentText = 'AFTER_SECOND_TOOL';
  persistCurrentTextSegment(backend.ctx);
  canonicalMessages = [{ id: 'user-1', role: 'user', content: 'Investigate' }, ...backend.messages];
  canonicalEvents = projectTurnTree({ messages: canonicalMessages }).turns.flatMap((turn) => turn.events)
    .map((event, eventSeq) => ({ ...event, event_seq: eventSeq }));
  await rig.emit({ ...base, type: 'complete', content: 'AFTER_SECOND_TOOL' });
  render();
  assert.deepEqual(snapshot(), ['call-1', 'AFTER_FIRST_TOOL', 'call-2', 'AFTER_SECOND_TOOL'], 'settlement preserves live order');
  const frozen = snapshot();
  await rig.emit({ ...base, type: 'tool_use', callId: 'late', next_assistant_message_id: 'assistant_stream-1_seg9' });
  await rig.emit({ ...base, type: 'delta', content: 'LATE_TEXT' });
  render();
  assert.deepEqual(snapshot(), frozen, 'late events cannot resurrect the terminal turn');
  const reloaded = withWindowGlobals(dom, () => createPipelineHarness({ dom, visibleMessages: canonicalMessages, currentSessionId: 'session-1', rowModelEnabled: true, turnEventsBySession: new Map([['session-1', { turnEventLogVersion: 4, turnEvents: canonicalEvents }]]) }));
  try {
    withWindowGlobals(dom, () => reloaded.pipeline.renderMessages({ forceFullRender: true }));
    assert.deepEqual(snapshot(), frozen, 'fresh canonical hydration preserves the same order');
  } finally {
    reloaded.pipeline.dispose();
  }
});


test('reset authority is also used by the real pending-message path before an approval resume', async (t) => {
  const rig = createHarness({ stateOverrides: { ui: { chatTimelineRowModelBySession: new Map([['session-1', true]]) } } });
  t.after(() => { rig.handler.dispose(); rig.restore(); });
  const base = { sessionId: 'session-1', streamId: 'stream-1' };
  await rig.emit({ ...base, type: 'started' });
  await rig.emit({ ...base, type: 'delta', content: 'discard me', aggregate: 'discard me' });
  await rig.emit({ ...base, type: 'stream_reset', reason: 'nudge_retry', next_assistant_message_id: 'assistant_stream-1_seg0', preserve_prior_segments: false, discard_scope: 'all' });
  await rig.emit({ ...base, type: 'delta', content: 'RESUMED', aggregate: 'RESUMED' });
  await rig.emit({ ...base, type: 'tool_approval_needed', callId: 'approve', toolName: 'read_file', approvalId: 'approval-1' });
  assert.equal(rig.state.messagesBySession.get('session-1').find((m) => m.content === 'RESUMED')?.id, 'assistant_stream-1_seg0');
  await rig.emit({ ...base, type: 'tool_use', callId: 'approve', toolName: 'read_file', status: 'running', next_assistant_message_id: 'assistant_stream-1_seg1' });
  await rig.emit({ ...base, type: 'delta', content: 'AFTER_APPROVAL', aggregate: 'RESUMEDAFTER_APPROVAL' });
  await rig.emit({ ...base, type: 'phase_completed', phaseKind: 'text', phaseId: 'tail' });
  assert.equal(rig.state.messagesBySession.get('session-1').find((m) => m.content === 'AFTER_APPROVAL')?.id, 'assistant_stream-1_seg1');
  await rig.emit({ ...base, type: 'error', message: 'Cancelled', category: 'cancelled' });
  const settled = JSON.stringify(rig.state.messagesBySession.get('session-1'));
  await rig.emit({ ...base, type: 'tool_use', callId: 'late', next_assistant_message_id: 'assistant_stream-1_seg9' });
  await rig.emit({ ...base, type: 'delta', content: 'LATE' });
  assert.equal(JSON.stringify(rig.state.messagesBySession.get('session-1')), settled);
  assert.equal(rig.state.pendingStreams.has('stream-1'), false);
});


for (const canonical of [false, true]) {
  test(`${canonical ? 'canonical' : 'legacy'} duplicate execution cannot persist post-tool text as another boundary`, () => {
    const backend = backendBoundaryRig({ text: 'BEFORE_TOOL', canonical });
    backend.tool('call-1');
    backend.ctx.currentSegmentText = 'AFTER_TOOL';
    backend.tool('call-1');
    assert.equal(backend.ctx.currentSegmentText, 'AFTER_TOOL');
    assert.equal(backend.ctx.textSegmentIndex, 1);
    assert.equal(backend.emitted.length, 1);
    assert.equal(backend.messages.filter((m) => m.content === 'AFTER_TOOL').length, 0);
  });
}
