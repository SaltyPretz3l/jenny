const assert = require('node:assert/strict');
const test = require('node:test');

const { markUserQuestionsStale } = require('../renderer/chat/renderer-stream-handler-tools');
const { renderUserQuestionsReceipt } = require('../renderer/chat/renderer-user-questions-block');
const { createToolHandlerHarness } = require('./helpers/stream-tool-handler-harness');

test('exit plan approval mounts a live plan document and consumes the restored run mode', async (t) => {
  const writes = [];
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { setItem: (...args) => writes.push(args) };
  t.after(() => { globalThis.localStorage = previousStorage; });
  const harness = createToolHandlerHarness({
    initialToolName: 'exit_plan_mode',
    // A session mid-plan whose store-captured pre-plan mode was Auto: the
    // summary patch must restore run_mode too — the projection reads run_mode
    // FIRST, so a plan_mode-only patch strands the renderer in Plan and the
    // next send re-enters read-only planning.
    sessions: [{ id: 'session-1', run_mode: 'plan', plan_mode: true, pre_plan_run_mode: 'auto' }],
  });
  await harness.handlers.handleApprovalNeeded({
    sessionId: 'session-1', streamId: 'stream-1', callId: 'call-1',
    toolName: 'exit_plan_mode', summary: 'Review plan', input: {},
    planDocument: { plan_id: 'p1', title: 'Build', steps: ['Implement'] },
  });
  const pending = harness.messagesBySession.get('session-1')
    .find((message) => message.kind === 'plan_document');
  assert.equal(pending.plan_document.state, 'pending');
  assert.deepEqual(writes, []);
  // The approval, its tool row and the plan document land in one store write.
  assert.deepEqual(harness.messageWrites, ['session-1']);

  await harness.handlers.handleToolResult({
    sessionId: 'session-1', streamId: 'stream-1', callId: 'call-1',
    toolName: 'exit_plan_mode', content: 'approved', summary: 'Plan approved', isError: false,
    metadata: {
      result_kind: 'plan_mode_transition',
      plan_decision: 'approved',
      plan_mode_cleared: true,
      run_mode_restored: 'ask',
    },
  });
  assert.equal(pending.plan_document.state, 'pending');
  const settled = harness.messagesBySession.get('session-1')
    .find((message) => message.kind === 'plan_document');
  assert.equal(settled.plan_document.state, 'approved');
  assert.deepEqual(harness.sessionPatches, [
    { sessionId: 'session-1', patch: { plan_mode: false, run_mode: 'ask' } },
  ]);
  // The sticky plan-mode localStorage key is retired: S4's defaultRunMode owns
  // new-chat defaults, so plan exit no longer touches browser storage.
  assert.deepEqual(writes, []);
});

test('tool_result uses live tool patching to avoid message timeline renders when accepted', async () => {
  const harness = createToolHandlerHarness({ patchAccepted: true });

  await harness.handlers.handleToolResult({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    toolName: 'Read',
    content: 'README contents',
    summary: 'Read README',
    durationMs: 120,
  });

  assert.equal(harness.scheduledPatches.length, 1);
  assert.equal(harness.scheduledPatches[0].details.eventType, 'tool_result');
  assert.equal(harness.scheduledPatches[0].payload.callId, 'call-1');
  assert.equal(harness.renderCalls.length, 1);
  assert.equal(harness.renderCalls[0].flags.messages, false);
  assert.equal(harness.renderCalls[0].flags.composerStatus, true);
  const toolUse = harness.messagesBySession.get('session-1').find((message) => message.kind === 'tool_use');
  assert.equal(toolUse.tool_call.status, 'completed');
});

test('tool_result falls back to message render when live tool patching cannot target a row', async () => {
  const harness = createToolHandlerHarness({ patchAccepted: false });

  await harness.handlers.handleToolResult({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    toolName: 'Read',
    content: 'README contents',
    summary: 'Read README',
  });

  assert.equal(harness.scheduledPatches.length, 1);
  assert.equal(harness.renderCalls.length, 1);
  assert.equal(harness.renderCalls[0].flags.messages, true);
});

test('stored todo_write tool results refresh the task rail once and other tools do not', async (t) => {
  const previousActions = globalThis.rendererTaskRailActions;
  let refreshCount = 0;
  globalThis.rendererTaskRailActions = {
    refreshChecklist() {
      const stored = todoHarness.messagesBySession.get('session-1');
      assert.ok(stored.some((message) => message.kind === 'tool_result'));
      refreshCount += 1;
    },
  };
  t.after(() => { globalThis.rendererTaskRailActions = previousActions; });
  const todoHarness = createToolHandlerHarness({ initialToolName: 'todo_write' });
  await todoHarness.handlers.handleToolResult({
    type: 'tool_result', sessionId: 'session-1', streamId: 'stream-1', callId: 'call-1',
    toolName: 'todo_write', content: '{"count":0,"todos":[]}', summary: 'Updated todos', isError: false,
  });
  assert.equal(refreshCount, 1);

  const readHarness = createToolHandlerHarness({ initialToolName: 'Read' });
  await readHarness.handlers.handleToolResult({
    type: 'tool_result', sessionId: 'session-1', streamId: 'stream-1', callId: 'call-1',
    toolName: 'Read', content: 'contents', summary: 'Read file', isError: false,
  });
  assert.equal(refreshCount, 1);
});

test('tool_result falls back to message render when live patch scheduling throws', async () => {
  const harness = createToolHandlerHarness({ patchThrows: true });

  await harness.handlers.handleToolResult({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    toolName: 'Read',
    content: 'README contents',
    summary: 'Read README',
  });

  assert.equal(harness.scheduledPatches.length, 1);
  assert.equal(harness.renderCalls.length, 1);
  assert.equal(harness.renderCalls[0].flags.messages, true);
});

test('approval-needed events use message render so approval UI can be inserted', async () => {
  const harness = createToolHandlerHarness({ patchAccepted: true });

  await harness.handlers.handleApprovalNeeded({
    type: 'tool_approval_needed',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    approvalId: 'approval-1',
    toolName: 'Read',
    summary: 'Read README',
    input: { path: 'README.md' },
  });

  assert.equal(harness.scheduledPatches.length, 0);
  assert.equal(harness.renderCalls.length, 1);
  assert.equal(harness.renderCalls[0].flags.messages, true);
  assert.deepEqual(harness.operationOrder, ['invalidate', 'render']);
  const toolUse = harness.messagesBySession.get('session-1').find((message) => message.kind === 'tool_use');
  assert.equal(toolUse.tool_call.status, 'pending_approval');
});

test('user-questions events mark the matching ask_user row pending with question data', async () => {
  const harness = createToolHandlerHarness({ initialToolName: 'ask_user' });
  const questions = [{ id: 'editor', prompt: 'Which editor?', options: ['VS Code', 'Vim'], multi_select: false, allow_other: true }];

  await harness.handlers.handleUserQuestionsRequested({
    type: 'user_questions_requested',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    questionRef: 'question_session-1_stream-1_call-1_q1',
    toolName: 'ask_user',
    questions,
    summary: 'Ask user 1 question',
    input: { questions },
  });

  const toolUse = harness.messagesBySession.get('session-1').find((message) => message.kind === 'tool_use');
  assert.equal(toolUse.tool_call.status, 'pending_user_input');
  assert.equal(toolUse.tool_call.question_ref, 'question_session-1_stream-1_call-1_q1');
  assert.deepEqual(toolUse.tool_call.user_questions, questions);
  assert.notEqual(toolUse.tool_call.user_questions, questions, 'handler snapshots the model-supplied array');
  assert.equal(harness.renderCalls.length, 1);
  assert.equal(harness.renderCalls[0].flags.messages, true);
  assert.deepEqual(harness.operationOrder, ['invalidate', 'render']);
});

test('user-questions race fallback creates the pending ask_user tool row before tool_use commits', async () => {
  const harness = createToolHandlerHarness({ initialToolName: 'ask_user' });
  harness.messagesBySession.set('session-1', []);
  const questions = [{ id: 'notes', prompt: 'Anything else?', options: [], multi_select: false, allow_other: false }];

  await harness.handlers.handleUserQuestionsRequested({
    type: 'user_questions_requested',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-race',
    questionRef: 'question-race',
    toolName: 'ask_user',
    questions,
    summary: 'Ask user 1 question',
    input: { questions },
  });

  const messages = harness.messagesBySession.get('session-1');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'tool_use_stream-1_call-race');
  assert.equal(messages[0].tool_call.call_id, 'call-race');
  assert.equal(messages[0].tool_call.status, 'pending_user_input');
  assert.equal(messages[0].tool_call.question_ref, 'question-race');
  assert.deepEqual(messages[0].tool_call.user_questions, questions);
});

test('tool_result settles a pending ask_user row and forces the message/projector render path', async () => {
  const harness = createToolHandlerHarness({ initialToolName: 'ask_user', patchAccepted: true });
  const questions = [{ id: 'choice', prompt: 'Choose', options: ['A'], multi_select: false, allow_other: false }];
  await harness.handlers.handleUserQuestionsRequested({
    type: 'user_questions_requested', sessionId: 'session-1', streamId: 'stream-1', callId: 'call-1',
    questionRef: 'question-settle', toolName: 'ask_user', questions, input: { questions },
  });

  await harness.handlers.handleToolResult({
    type: 'tool_result', sessionId: 'session-1', streamId: 'stream-1', callId: 'call-1',
    toolName: 'ask_user', content: 'Q: Choose\nA: A', summary: 'User answered questions', isError: false,
  });

  const toolUse = harness.messagesBySession.get('session-1').find((message) => message.kind === 'tool_use');
  assert.equal(toolUse.tool_call.status, 'completed');
  assert.notEqual(toolUse.tool_call.status, 'pending_user_input');
  assert.equal(harness.scheduledPatches.length, 0);
  assert.equal(harness.renderCalls.at(-1).flags.messages, true);
});

test('markUserQuestionsStale settles the matching pending message and maps its marker to the stale receipt', () => {
  const harness = createToolHandlerHarness({ initialToolName: 'ask_user' });
  const messages = harness.messagesBySession.get('session-1');
  messages[0].tool_call.status = 'pending_user_input';
  messages[0].tool_call.question_ref = 'question-stale';
  messages[0].tool_call.user_questions = [{ id: 'choice', prompt: 'Choose', options: ['A'] }];

  const updated = markUserQuestionsStale('session-1', 'question-stale', {
    getSessionMessages: (sessionId) => harness.messagesBySession.get(sessionId) || [],
    setSessionMessages: (sessionId, nextMessages) => harness.messagesBySession.set(sessionId, nextMessages),
  });

  assert.equal(updated, true);
  const toolUse = harness.messagesBySession.get('session-1')[0];
  assert.equal(toolUse.tool_call.status, 'completed');
  assert.equal(toolUse.user_questions_result_kind, 'user_questions_stale');
  assert.equal(toolUse.tool_call.user_questions_result_kind, 'user_questions_stale');
  assert.equal(toolUse.tool_call.user_questions_stale, true);
  assert.match(renderUserQuestionsReceipt({
    toolCallId: toolUse.tool_call.call_id,
    stale: toolUse.tool_call.user_questions_stale,
  }), /Questions no longer active/);
  assert.equal(markUserQuestionsStale('session-1', 'question-stale', {
    getSessionMessages: (sessionId) => harness.messagesBySession.get(sessionId) || [],
    setSessionMessages() { throw new Error('settled message must not be written twice'); },
  }), false);
});

test('tool_result with structural UI payload uses message render', async () => {
  const harness = createToolHandlerHarness({ patchAccepted: true });

  await harness.handlers.handleToolResult({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    toolName: 'Write',
    content: 'Wrote plan.md',
    summary: 'Wrote plan.md',
    generatedArtifacts: [{
      artifact_id: 'artifact_plan',
      title: 'plan.md',
    }],
    metadata: {
      diff: {
        additions: 1,
        deletions: 0,
        hunks: [],
      },
    },
  });

  assert.equal(harness.scheduledPatches.length, 0);
  assert.equal(harness.renderCalls.length, 1);
  assert.equal(harness.renderCalls[0].flags.messages, true);
});

test('a memory tool_result takes the full render so its chip (Undo) appears live', async () => {
  const harness = createToolHandlerHarness({ patchAccepted: true, initialToolName: 'memory' });

  await harness.handlers.handleToolResult({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    toolName: 'memory',
    content: 'Remembered.',
    summary: 'Remembered.',
    metadata: { result_kind: 'memory', action: 'remember', status: 'saved', operation_id: 'tool:s1:call-1', undoable: true },
  });

  assert.equal(harness.scheduledPatches.length, 0);
  assert.equal(harness.renderCalls.length, 1);
  assert.equal(harness.renderCalls[0].flags.messages, true);
});

test('tool_result with shell metadata uses message render for specialized body chrome', async () => {
  const harness = createToolHandlerHarness({ patchAccepted: true });

  await harness.handlers.handleToolResult({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    toolName: 'Bash',
    content: 'hello',
    summary: 'exit 0',
    metadata: {
      stdout: 'hello',
      stderr: '',
      exitCode: 0,
    },
  });

  assert.equal(harness.scheduledPatches.length, 0);
  assert.equal(harness.renderCalls.length, 1);
  assert.equal(harness.renderCalls[0].flags.messages, true);
});

test('tool_result uses prior tool name when result payload omits it', async () => {
  const harness = createToolHandlerHarness({ patchAccepted: true, initialToolName: 'Bash' });

  await harness.handlers.handleToolResult({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    content: 'plain output',
    summary: 'exit 0',
  });

  assert.equal(harness.scheduledPatches.length, 0);
  assert.equal(harness.renderCalls.length, 1);
  assert.equal(harness.renderCalls[0].flags.messages, true);
});

test('tool_result updates the matching stream when call ids are reused', async () => {
  const harness = createToolHandlerHarness({ patchAccepted: false });
  const messages = harness.messagesBySession.get('session-1');
  messages.unshift({
    id: 'tool_use_stream-old_call-1',
    role: 'assistant',
    content: 'Old read',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-1',
      tool_name: 'Read',
      input: { path: 'old.md' },
      input_json: '{"path":"old.md"}',
      summary: 'Old read',
      status: 'running',
      parent_stream_id: 'stream-old',
    },
    status: 'complete',
  });
  messages.unshift({
    id: 'tool_result_stream-old_call-1',
    role: 'tool',
    content: 'Old output',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call-1',
      tool_name: 'Read',
      output_text: 'old',
      summary: 'Old read',
      parent_stream_id: 'stream-old',
      generated_artifacts: [],
      metadata: {},
    },
    status: 'complete',
  });

  await harness.handlers.handleToolResult({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    toolName: 'Read',
    content: 'new output',
    summary: 'Read current file',
  });

  const updated = harness.messagesBySession.get('session-1');
  const oldUse = updated.find((message) => message.id === 'tool_use_stream-old_call-1');
  const currentUse = updated.find((message) => message.id === 'tool_use_call-1');
  const oldResult = updated.find((message) => message.id === 'tool_result_stream-old_call-1');
  const currentResult = updated.find((message) => message.id === 'tool_result_stream-1_call-1');

  assert.equal(oldUse.tool_call.status, 'running');
  assert.equal(currentUse.tool_call.status, 'completed');
  assert.equal(oldResult.tool_result.output_text, 'old');
  assert.equal(currentResult.tool_result.output_text, 'new output');
  assert.equal(currentResult.tool_result.parent_stream_id, 'stream-1');
});

test('tool_result ignores legacy same-call rows without stream identity', async () => {
  const harness = createToolHandlerHarness({ patchAccepted: false });
  const messages = harness.messagesBySession.get('session-1');
  messages.unshift({
    id: 'tool_use_legacy_call-1',
    role: 'assistant',
    content: 'Legacy read',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-1',
      tool_name: 'Read',
      input: { path: 'legacy.md' },
      input_json: '{"path":"legacy.md"}',
      summary: 'Legacy read',
      status: 'running',
    },
    status: 'complete',
  });

  await harness.handlers.handleToolResult({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    toolName: 'Read',
    content: 'new output',
    summary: 'Read current file',
  });

  const updated = harness.messagesBySession.get('session-1');
  const legacyUse = updated.find((message) => message.id === 'tool_use_legacy_call-1');
  const currentUse = updated.find((message) => message.id === 'tool_use_call-1');

  assert.equal(legacyUse.tool_call.status, 'running');
  assert.equal(currentUse.tool_call.status, 'completed');
});

test('failed, refused and timed-out classic results take the message render, not the field patch', async () => {
  const cases = [
    { name: 'isError', extra: { isError: true, errorCode: 'CMP-TOOL-0003', content: 'ENOENT: README.md' } },
    { name: 'denied', extra: { approvalState: 'denied' } },
    { name: 'approval timed_out', extra: { approvalState: 'timed_out' } },
    { name: 'sidecar timed_out', extra: { metadata: { timed_out: true } } },
  ];
  for (const { name, extra } of cases) {
    const harness = createToolHandlerHarness({ patchAccepted: true });
    await harness.handlers.handleToolResult({
      type: 'tool_result', sessionId: 'session-1', streamId: 'stream-1', callId: 'call-1',
      toolName: 'read_file', content: 'x', summary: 'Read README', ...extra,
    });
    assert.equal(harness.scheduledPatches.length, 0, name);
    assert.equal(harness.renderCalls[0].flags.messages, true, name);
  }
  // An approved, successful result still patches in place.
  const harness = createToolHandlerHarness({ patchAccepted: true });
  await harness.handlers.handleToolResult({
    type: 'tool_result', sessionId: 'session-1', streamId: 'stream-1', callId: 'call-1',
    toolName: 'read_file', content: 'x', summary: 'Read README', approvalState: 'approved',
  });
  assert.equal(harness.scheduledPatches.length, 1);
  assert.equal(harness.renderCalls[0].flags.messages, false);
});

// Tool and approval events change no session summary the sidebar row renders
// from (title, preview, time, unread, outbox): their only sidebar effect is a
// runtime dot, which the runtime chrome pass queueSessionRender adds already
// repaints. A sessions render per event would rebuild the panel several times
// a second during an agentic turn.
test('tool, approval and question events queue no structural sessions render', async () => {
  const harness = createToolHandlerHarness({ initialToolName: 'ask_user' });
  const base = { sessionId: 'session-1', streamId: 'stream-1' };
  await harness.handlers.handleToolUse({ ...base, type: 'tool_use', callId: 'call-2', toolName: 'Read', input: { path: 'a.md' }, summary: 'Read a.md', status: 'running' });
  await harness.handlers.handleApprovalNeeded({ ...base, type: 'tool_approval_needed', callId: 'call-2', approvalId: 'approval-2', toolName: 'Read', input: { path: 'a.md' } });
  await harness.handlers.handleApprovalNeeded({ ...base, type: 'tool_approval_withdrawn', callId: 'call-2', approvalId: 'approval-2' });
  const questionRef = 'question_session-1_stream-1_call-1_q1';
  const questions = [{ id: 'editor', prompt: 'Which editor?', options: ['VS Code', 'Vim'] }];
  await harness.handlers.handleUserQuestionsRequested({ ...base, type: 'user_questions_requested', callId: 'call-1', questionRef, toolName: 'ask_user', questions });
  await harness.handlers.handleUserQuestionsRequested({ ...base, type: 'user_questions_withdrawn', callId: 'call-1', questionRef });
  await harness.handlers.handleToolResult({ ...base, type: 'tool_result', callId: 'call-2', toolName: 'Read', content: 'a', summary: 'Read a.md' });
  assert.equal(harness.renderCalls.length, 6);
  assert.deepEqual(harness.renderCalls.filter((call) => call.flags.sessions === true).map((call) => call.flags), []);
});
