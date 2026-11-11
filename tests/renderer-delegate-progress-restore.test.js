'use strict';

// Reopening a chat mid-delegation replaces the renderer-only message that held
// the live steps. The real shell must rebuild the summary card and the full
// child list from the live active-turn snapshot, without waiting for a frame.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const SESSION_ID = 'session-delegate-live';
const STREAM = 'stream_delegate_live';
const TURN = `turn_${STREAM}`;
const CALL = 'call_delegate_live';
const SUMMARY = { id: SESSION_ID, title: 'Delegate', conversation_mode: 'chat', preferred_model: 'gpt-test',
  updated_at: new Date().toISOString(), linked_session_ids: [],
  context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } };

const row = (ordinal, status, updated) => ({
  tool_call_id: CALL, task_id: `delegate:${CALL}`, source: 'delegate',
  child_task_id: `task:${ordinal}`, child_agent_id: `agent:${ordinal}`, ordinal, count: 3, label: `Check ${ordinal}`,
  status, summary: `Task ${ordinal}/3 ${status}.`,
  child_terminal: status === 'completed', child_success: status === 'completed',
  started_at_ms: 1000 * ordinal, updated_at_ms: updated,
});
const CHILDREN = [row(1, 'completed', 9000), row(2, 'running', 9500), row(3, 'queued', 2000)];

const ACTIVE_TURN = { request_id: TURN, stream_id: STREAM, turn_id: TURN, status: 'streaming',
  started_at: '2026-11-09T19:07:10.000Z', last_event_at: '2026-11-09T19:08:20.000Z' };

function messages({ settled = false } = {}) {
  const at = '2026-11-09T19:08:20.000Z';
  const list = [
    { id: `user_${STREAM}`, role: 'user', content: 'Verify this', turn_id: TURN, event_seq: 0, timestamp: at },
    {
      id: `tool_use_${STREAM}_${CALL}`, role: 'assistant', kind: 'tool_use', content: 'Delegate', turn_id: TURN,
      event_seq: 1, timestamp: at, finalizedAt: at,
      tool_call: { call_id: CALL, tool_name: 'delegate', input: { tasks: ['a', 'b', 'c'] }, input_json: '{}',
        summary: 'Delegate', status: 'running', approval_state: 'auto', parent_stream_id: STREAM },
    },
  ];
  if (settled) {
    list.push({
      id: `tool_result_${STREAM}_${CALL}`, role: 'tool', kind: 'tool_result', content: 'Done', turn_id: TURN,
      event_seq: 2, timestamp: at,
      tool_result: { call_id: CALL, tool_name: 'delegate', output_text: '{}', summary: 'Done', is_error: false,
        error_code: '', duration_ms: 5, parent_stream_id: STREAM, generated_artifacts: [], metadata: {} },
    });
  }
  return list;
}

async function openApp(t, { snapshot, settled = false }) {
  const app = await loadRendererApp({ shell: {
    sessions: [SUMMARY],
    workspaceState: { activeSessionId: SESSION_ID, openSessionIds: [SESSION_ID] },
    sessionMessagePayloads: { [SESSION_ID]: { data: messages({ settled }), turn_events: [], active_turn: ACTIVE_TURN } },
    chat: { getActiveTurnState: async (sessionId) => (sessionId === SESSION_ID ? snapshot : null) },
  } });
  t.after(() => app.dispose());
  await waitForUi(app.window, 150);
  return app;
}

function restoredSteps(window) {
  return window.__rendererState.messagesBySession.get(SESSION_ID)
    .flatMap((message) => (Array.isArray(message.agent_status_steps) ? message.agent_status_steps : []));
}

const liveSnapshot = { ...ACTIVE_TURN, session_id: SESSION_ID, state: 'streaming', delegate_children: CHILDREN };

test('a reopened chat rebuilds the live card and lists every child, the queued one included', async (t) => {
  const { window } = await openApp(t, { snapshot: liveSnapshot });
  const doc = window.document;
  const trigger = doc.querySelector(`#chatTimeline [data-subagent-open="${CALL}"]`);
  assert.ok(trigger, 'the clickable summary is back without waiting for a frame');
  assert.equal(trigger.getAttribute('data-subagent-source'), 'live');
  assert.equal(doc.querySelectorAll('#chatTimeline [data-subagent-open]').length, 1);

  trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  trigger.click();
  await waitForUi(window, 80);
  const monitor = doc.querySelector('#artifactReviewPanel .subagent-monitor-shell');
  assert.ok(monitor, 'the panel opens from the restored card');
  for (const label of ['Check 1', 'Check 2', 'Check 3']) assert.match(monitor.textContent, new RegExp(label));
  assert.equal(monitor.querySelectorAll('[data-subagent-select]').length, 3);
});

test('restored rows keep their clock and live frames continue on top of them', async (t) => {
  const app = await openApp(t, { snapshot: liveSnapshot });
  const { window } = app;
  const before = restoredSteps(window);
  assert.equal(before.length, 3);
  assert.equal(before.find((step) => step.childOrdinal === 2).startedAt, 2000, 'the running child keeps its start time');

  await app.shell.__emitChat({
    type: 'agent_status', sessionId: SESSION_ID, streamId: STREAM, turnId: TURN, taskId: `delegate:${CALL}`,
    taskType: 'sub_agent', source: 'delegate', toolCallId: CALL, childTaskId: 'task:2', childAgentId: 'agent:2',
    childOrdinal: 2, childCount: 3, childLabel: 'Check 2', status: 'running', stage: 'task_2_activity', percent: 40,
    summary: 'Reading results', childActivity: { sequence: 3, steps: [], step_count: 1, text: '' },
  });
  await waitForUi(window, 80);
  const after = restoredSteps(window);
  assert.equal(after.length, 3, 'one row per child, no duplicates');
  const second = after.find((step) => step.childOrdinal === 2);
  assert.equal(second.summary, 'Reading results');
  assert.equal(second.startedAt, 2000);
  assert.equal(after.find((step) => step.childOrdinal === 3).status, 'queued');
});

test('a call whose result already landed is not restored as live', async (t) => {
  const { window } = await openApp(t, { snapshot: liveSnapshot, settled: true });
  assert.equal(restoredSteps(window).length, 0);
});

test('a pending approval on the same turn does not block the restore', async (t) => {
  const { window } = await openApp(t, { snapshot: { ...liveSnapshot,
    pending_approval: { approval_id: 'approval-1', call_id: 'call_other', tool_name: 'write_file', summary: 'Write' } } });
  assert.equal(restoredSteps(window).length, 3);
  assert.ok(window.document.querySelector(`#chatTimeline [data-subagent-open="${CALL}"]`));
});

test('only the delegate tools hand their status to the tool row', () => {
  const { isCallBoundSubagent } = require('../renderer/chat/renderer-turn-tree-projector-message-utils');
  const step = { taskType: 'sub_agent', toolCallId: CALL, source: 'delegate' };
  assert.equal(isCallBoundSubagent(step), true);
  assert.equal(isCallBoundSubagent({ ...step, source: 'subagent_batch' }), true);
  assert.equal(isCallBoundSubagent({ ...step, source: 'local_agent' }), false, 'another agent keeps its notice row');
  assert.equal(isCallBoundSubagent({ ...step, toolCallId: '' }), false);
  assert.equal(isCallBoundSubagent(null), false);
});

test('no live stream means nothing is restored', async (t) => {
  const { window } = await openApp(t, { snapshot: null });
  assert.equal(restoredSteps(window).length, 0);
  assert.equal(window.document.querySelector('#chatTimeline [data-subagent-open]'), null);
});
