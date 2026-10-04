'use strict';

/* A finished delegate turn must stay reopenable from history. Live, the
 * delegate's agent_status steps render the subagent summary ("Open" trigger).
 * Once the delegate's tool_result lands (live, and again when `complete`
 * reconciles against the backend copy or the chat reloads) the call is a
 * tool_call row, which used to render a plain minimal tool row with no
 * [data-subagent-open]. The fixtures follow what
 * main persists (chat-stream-tool-handling.js): a tool_use message, a
 * tool_result message whose tool_result.metadata carries the
 * subagent_batch_report, and the matching turn_events (the tool_result event's
 * payload.metadata carries the report too).
 *
 * Real shell (jsdom harness), one pane.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const SESSION_ID = 'session-delegate';
const CALL = 'call_delegate_done';
const PROMPT = 'Survey the repo with a subagent';
const ANSWER = 'The test command is npm test.';

const SUMMARY = {
  id: SESSION_ID, title: 'Delegate', conversation_mode: 'chat', preferred_model: 'gpt-test',
  updated_at: new Date().toISOString(), linked_session_ids: [],
  context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
};

function batchReport() {
  return {
    batch_id: `delegate:request:${CALL}`, source_tool: 'delegate', execution: 'single', status: 'completed',
    tasks: [{
      task_id: `delegate:request:${CALL}:task:1`, ordinal: 1, label: 'Repo survey', status: 'completed',
      summary: 'Found the test command in package.json.', tools_used: ['read_file'], uncertainties: [],
      evidence_trust: 'tool_observed', budget: { elapsed_ms: 900 }, evidence: [],
    }],
    budget: { elapsed_ms: 900 },
  };
}

/* The session as main persists it once the delegate turn settles. */
function persistedDelegateTurn(streamId, { report = batchReport() } = {}) {
  const turnId = `turn_${streamId}`;
  const userId = `user_${streamId}`;
  const useId = `tool_use_${streamId}_${CALL}`;
  const resultId = `tool_result_${streamId}_${CALL}`;
  const assistantId = `assistant_${streamId}`;
  const metadata = report ? { subagent_batch_report: report } : {};
  const at = (second) => `2026-09-26T10:00:0${second}.000Z`;
  const data = [
    { id: userId, role: 'user', content: PROMPT, turn_id: turnId, event_seq: 0, timestamp: at(0) },
    {
      id: useId, role: 'assistant', kind: 'tool_use', content: 'Delegate', turn_id: turnId, event_seq: 1,
      timestamp: at(1), finalizedAt: at(1),
      tool_call: {
        call_id: CALL, tool_name: 'delegate', input: { tasks: ['Survey the repo'] },
        input_json: '{"tasks":["Survey the repo"]}', summary: 'Delegate', status: 'completed',
        approval_state: 'auto', parent_stream_id: streamId,
      },
    },
    {
      id: resultId, role: 'tool', kind: 'tool_result', content: 'Delegation completed.', turn_id: turnId,
      event_seq: 2, timestamp: at(5),
      tool_result: {
        call_id: CALL, tool_name: 'delegate', output_text: '{"status":"completed"}', summary: 'Delegation completed.',
        is_error: false, error_code: '', duration_ms: 900, parent_stream_id: streamId, generated_artifacts: [], metadata,
      },
    },
    {
      id: assistantId, role: 'assistant', content: ANSWER, turn_id: turnId, event_seq: 3, status: 'complete',
      parent_stream_id: streamId, timestamp: at(6), finalizedAt: at(6),
    },
  ];
  const event = (seq, kind, fields) => ({
    event_id: `${streamId}:canonical:${seq}`, event_seq: seq, turn_id: turnId, kind, status: '',
    target_message_id: '', tool_call_id: '', segment_group_index: 0, phase_id: '',
    started_at: at(seq), completed_at: at(seq), ...fields,
  });
  const turnEvents = [
    event(0, 'user_prompt', { primary_message_id: userId, source_message_ids: [userId], payload: { content: PROMPT, attachments: [] } }),
    event(1, 'tool_use', {
      status: 'pending', primary_message_id: useId, source_message_ids: [useId], tool_call_id: CALL,
      payload: { tool_name: 'delegate', tool_input: { tasks: ['Survey the repo'] }, canonical_event_type: 'tool_call_requested' },
    }),
    event(2, 'tool_executing', {
      status: 'running', primary_message_id: useId, source_message_ids: [useId], tool_call_id: CALL,
      payload: { tool_name: 'delegate', canonical_event_type: 'tool_execution_started' },
    }),
    event(3, 'tool_result', {
      status: 'completed', primary_message_id: resultId, source_message_ids: [resultId], tool_call_id: CALL,
      payload: {
        tool_name: 'delegate', success: true, tool_output_summary: 'Delegation completed.', duration_ms: 900,
        ...(report ? { metadata } : {}), canonical_event_type: 'tool_execution_completed',
      },
    }),
    event(4, 'assistant_text_segment', {
      primary_message_id: assistantId, source_message_ids: [assistantId],
      payload: {
        text: ANSWER, assistant_phase: 'final_answer', segment_id: `${assistantId}_seg_0`, segment_group_index: 0,
        completion_source: 'model', canonical_event_type: 'text_part_completed',
      },
    }),
  ];
  return { data, turn_events: turnEvents, turn_event_log_version: 4, active_turn: null };
}

async function openApp(t, shellOptions) {
  const app = await loadRendererApp({ shell: {
    sessions: [SUMMARY],
    workspaceState: { activeSessionId: SESSION_ID, openSessionIds: [SESSION_ID] },
    ...shellOptions,
  } });
  t.after(() => app.dispose());
  await waitForUi(app.window, 150);
  return app;
}

async function assertTriggerOpensBatchReport(window) {
  const doc = window.document;
  const timeline = doc.getElementById('chatTimeline');
  const trigger = timeline.querySelector(`[data-subagent-open="${CALL}"]`);
  assert.ok(trigger, 'the finished delegate row keeps its Open trigger');
  assert.equal(timeline.querySelectorAll('[data-subagent-open]').length, 1, 'exactly one Open trigger (no stale live summary beside it)');
  assert.equal(trigger.getAttribute('data-subagent-source'), 'terminal', 'rendered from the terminal batch report');
  assert.match(trigger.textContent, /Open/);
  assert.equal(timeline.querySelector('.tool-call-row--minimal'), null, 'not the plain minimal tool row');

  trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  trigger.click();
  await waitForUi(window, 80);
  // In Chat the monitor is the artifact panel's `subagents` rail mode.
  const panel = doc.getElementById('artifactReviewPanel');
  const monitor = panel.querySelector('.subagent-monitor-shell');
  assert.equal(panel.dataset.artifactReviewMode, 'subagents', 'the subagent monitor opened in the artifact panel');
  assert.ok(monitor, 'painted by the panel pull');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(trigger.getAttribute('aria-controls'), 'artifactReviewPanel');
  assert.match(monitor.textContent, /Repo survey/, 'showing the batch report child');
  assert.match(monitor.textContent, /Found the test command in package\.json\./, 'with its summary');
  assert.match(monitor.textContent, /Completed/);
}

for (const [label, payload] of [
  ['turn_events', persistedDelegateTurn('stream_delegate_reload')],
  ['messages only (no turn_events)', { data: persistedDelegateTurn('stream_delegate_reload').data }],
]) {
  test(`a reloaded finished delegate turn (${label}) keeps its Open trigger and opens the inspector`, async (t) => {
    const { window } = await openApp(t, { sessionMessagePayloads: { [SESSION_ID]: payload } });
    await assertTriggerOpensBatchReport(window);
  });
}

test('a delegate result without a subagent report keeps the plain tool row', async (t) => {
  const payload = persistedDelegateTurn('stream_delegate_noreport', { report: null });
  const { window } = await openApp(t, { sessionMessagePayloads: { [SESSION_ID]: payload } });
  const timeline = window.document.getElementById('chatTimeline');
  assert.equal(timeline.querySelector('[data-subagent-open]'), null, 'no Open trigger without a report');
  assert.ok(timeline.querySelector('.tool-call-row--minimal'), 'the persisted row keeps its default markup');
});

test('a live delegate turn keeps its Open trigger after complete reconciles against the backend copy', async (t) => {
  const STREAM = 'stream_delegate_live';
  const app = await openApp(t, {
    sessionMessagePayloads: { [SESSION_ID]: { data: [] } },
    chat: { startStream: async (request) => ({ sessionId: request.sessionId, streamId: STREAM }) },
  });
  const { window, shell } = app;
  const input = window.document.getElementById('chatInput');
  input.value = PROMPT;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitForUi(window, 80);
  assert.deepEqual(shell.__state.chatCalls.map((call) => call.sessionId), [SESSION_ID], 'precondition: the turn was sent');

  const emit = (payload) => shell.__emitChat({ sessionId: SESSION_ID, streamId: STREAM, requestId: STREAM, ...payload });
  await emit({ type: 'started' });
  await emit({ type: 'tool_use', callId: CALL, toolName: 'delegate', summary: 'Delegate', input: { tasks: ['Survey the repo'] }, status: 'running' });
  const child = {
    type: 'agent_status', taskType: 'sub_agent', source: 'delegate', taskId: 'delegate-task', toolCallId: CALL,
    childTaskId: `delegate:request:${CALL}:task:1`, childOrdinal: 1, childCount: 1, childLabel: 'Repo survey',
    agentId: `research@${STREAM}:${CALL}:1`, parentAgentId: `main@${STREAM}`,
  };
  await emit({ ...child, status: 'running', stage: 'planning', percent: 20, summary: 'Planning the survey', terminal: false, success: false });
  await emit({
    ...child, status: 'completed', stage: 'completed', percent: 100, summary: 'Found the test command in package.json.',
    childTerminal: true, childSuccess: true, terminal: true, success: true,
  });
  await emit({
    type: 'tool_result', callId: CALL, toolName: 'delegate', summary: 'Delegation completed.', content: '{"status":"completed"}',
    isError: false, durationMs: 900, metadata: { subagent_batch_report: batchReport() },
  });
  await waitForUi(window, 120);
  const liveTriggers = window.document.querySelectorAll('#chatTimeline [data-subagent-open]');
  assert.equal(liveTriggers.length, 1, 'the finished call keeps one trigger while the turn still streams');
  assert.equal(liveTriggers[0].getAttribute('data-subagent-open'), CALL);
  assert.equal(liveTriggers[0].getAttribute('data-subagent-source'), 'terminal', 'the live summary gave way to the terminal one');

  // `complete` reconciles the turn against main's persisted copy.
  const persisted = persistedDelegateTurn(STREAM);
  const getMessages = shell.sessions.getMessages;
  shell.sessions.getMessages = async (sessionId) => (sessionId === SESSION_ID ? structuredClone(persisted) : getMessages(sessionId));
  await emit({ type: 'token', content: ANSWER });
  await emit({ type: 'complete', content: ANSWER, interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' });
  await waitForUi(window, 200);
  assert.match(window.document.getElementById('chatTimeline').textContent, /The test command is npm test\./, 'precondition: the turn settled');
  await assertTriggerOpensBatchReport(window);
});
