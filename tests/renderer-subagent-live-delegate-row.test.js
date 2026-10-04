'use strict';

/* A RUNNING delegate must show its live subagent "Open" trigger. The real live
 * stream (found driving the agent-mode app, W1_OWNER_GATE.md "D5 live") sends
 * the delegate's tool_use first, so the call renders as a tool_call row, and
 * the child agent_status steps land on the turn's assistant message, which
 * renders no widget of its own in that shape. The running row used to be a
 * plain `.tool-call-row--minimal` with no [data-subagent-open]. The delegate's
 * own row now carries the live summary and hands off, on the same row and key,
 * to the terminal summary once the tool_result brings the batch report.
 *
 * The agent_status frames mirror sidecar/ai/routing/delegate.py (a start frame
 * without child identity, then queued / running / settled child frames) after
 * Electron's camelCase normalization. Real shell (jsdom harness).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const CALL = 'call_delegate_live_row';
const PROMPT = 'Survey the repo with a subagent';

function buildSummary(id, title) {
  return {
    id, title, conversation_mode: 'chat', preferred_model: 'gpt-test', updated_at: new Date().toISOString(),
    linked_session_ids: [], context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
  };
}

function batchReport() {
  return {
    batch_id: `delegate:request:${CALL}`, source_tool: 'delegate', execution: 'single', status: 'completed',
    tasks: [{
      task_id: `delegate:request:${CALL}:task:1`, ordinal: 1, label: 'Task 1', status: 'completed',
      summary: 'The test script is node --test tests/.', tools_used: ['read_file'], uncertainties: [],
      evidence_trust: 'tool_observed', budget: { elapsed_ms: 2000 }, evidence: [],
    }],
    budget: { elapsed_ms: 2000 },
  };
}

const pointerDown = (window, element) => element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));

async function click(window, element) {
  pointerDown(window, element);
  element.click();
  await waitForUi(window, 80);
}

async function send(window, input) {
  pointerDown(window, input);
  input.value = PROMPT;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitForUi(window, 80);
}

/* The live sequence main forwards for a one-task delegate call. */
function delegateFrames(streamId) {
  const base = { type: 'agent_status', taskType: 'sub_agent', source: 'delegate', taskId: `delegate:request:${CALL}`, toolCallId: CALL, parentAgentId: `main@${streamId}` };
  const child = {
    ...base, childTaskId: `delegate:request:${CALL}:task:1`, childAgentId: `research@${streamId}:${CALL}:1`,
    childOrdinal: 1, childCount: 1, childLabel: 'Task 1',
  };
  return {
    toolUse: { type: 'tool_use', callId: CALL, toolName: 'delegate', summary: 'delegate', input: { tasks: ['Survey the repo'] }, status: 'running' },
    start: { ...base, status: 'running', stage: 'start', percent: 5, summary: 'Starting read-only delegation with 1 task(s).' },
    queued: { ...child, status: 'queued', stage: 'task_1_queued', percent: 0, summary: 'Task 1/1 queued.' },
    running: { ...child, status: 'running', stage: 'task_1_running', percent: 0, summary: 'Task 1/1 running.' },
    settled: {
      ...child, status: 'completed', stage: 'task_1_completed', percent: 100, summary: 'Task 1/1 completed.',
      childTerminal: true, childSuccess: true, terminalReason: 'completed',
    },
    toolResult: {
      type: 'tool_result', callId: CALL, toolName: 'delegate', summary: 'delegate', content: '{"status":"completed"}',
      isError: false, durationMs: 2000, metadata: { subagent_batch_report: batchReport() },
    },
  };
}

function triggersIn(root) {
  return [...root.querySelectorAll('[data-subagent-open]')];
}

function assertOneTrigger(root, source, label) {
  const triggers = triggersIn(root);
  assert.equal(triggers.length, 1, `${label}: exactly one Open trigger`);
  assert.equal(triggers[0].getAttribute('data-subagent-open'), CALL, `${label}: keyed by the delegate call`);
  assert.equal(triggers[0].getAttribute('data-subagent-source'), source, `${label}: ${source} summary`);
  assert.equal(triggers[0].closest('[data-row-kind]')?.getAttribute('data-row-kind'), 'tool_call', `${label}: on the delegate's own row`);
  assert.equal(root.querySelector('.tool-call-row--minimal'), null, `${label}: not the plain minimal tool row`);
  return triggers[0];
}

test('a running delegate shows one live trigger that opens the inspector, follows the child and hands off to the terminal one', async (t) => {
  const SESSION_ID = 'session-live-delegate';
  const STREAM = 'stream_live_delegate_row';
  const app = await loadRendererApp({ shell: {
    sessions: [buildSummary(SESSION_ID, 'Delegate')],
    workspaceState: { activeSessionId: SESSION_ID, openSessionIds: [SESSION_ID] },
    sessionMessagePayloads: { [SESSION_ID]: { data: [] } },
    chat: { startStream: async (request) => ({ sessionId: request.sessionId, streamId: STREAM }) },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const timeline = doc.getElementById('chatTimeline');
  await send(window, doc.getElementById('chatInput'));
  assert.deepEqual(shell.__state.chatCalls.map((call) => call.sessionId), [SESSION_ID], 'precondition: the turn was sent');

  const emit = (payload) => shell.__emitChat({ sessionId: SESSION_ID, streamId: STREAM, requestId: STREAM, ...payload });
  const frames = delegateFrames(STREAM);
  await emit({ type: 'started' });
  await emit(frames.toolUse);
  await emit(frames.start);
  await emit(frames.queued);
  await emit(frames.running);
  await waitForUi(window, 120);

  const liveTrigger = assertOneTrigger(timeline, 'live', 'while the child runs');
  await click(window, liveTrigger);
  // In Chat the monitor is the artifact panel's `subagents` rail mode; the in-stage aside stays hidden.
  const panel = doc.getElementById('artifactReviewPanel');
  const monitor = () => panel.querySelector('.subagent-monitor-shell');
  assert.equal(panel.dataset.artifactReviewMode, 'subagents', 'the live trigger opens the monitor in the artifact panel');
  assert.equal(panel.classList.contains('hidden'), false);
  assert.equal(doc.getElementById('subagentInspector').hidden, true, 'not the in-stage aside');
  assert.equal(timeline.querySelector('[data-subagent-open]').getAttribute('aria-expanded'), 'true');
  assert.equal(timeline.querySelector('[data-subagent-open]').getAttribute('aria-controls'), 'artifactReviewPanel');
  assert.ok(monitor().querySelector('[data-subagent-page="detail"]'), 'a single child lands on its drill-in');
  assert.match(monitor().textContent, /Task 1/, 'showing the running child');
  assert.match(monitor().textContent, /Task 1\/1 running\./);
  assert.match(monitor().textContent, /Steps appear when this subagent finishes\./);

  await emit(frames.settled);
  await waitForUi(window, 120);
  assertOneTrigger(timeline, 'live', 'after the child settles');
  assert.ok(monitor(), 'the open monitor follows the child');
  assert.match(monitor().textContent, /Task 1\/1 completed\./, 'to its finish');

  await emit(frames.toolResult);
  await waitForUi(window, 120);
  const terminalTrigger = assertOneTrigger(timeline, 'terminal', 'once the batch report lands');
  assert.equal(terminalTrigger.getAttribute('aria-expanded'), 'true', 'the hand-off keeps the monitor open');
  assert.equal(panel.dataset.artifactReviewMode, 'subagents');
  assert.match(monitor().textContent, /The test script is node --test tests\/\./, 'now showing the batch report');

  await emit({ type: 'token', content: 'The test command is node --test tests/.' });
  await emit({ type: 'complete', content: 'The test command is node --test tests/.', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' });
  await waitForUi(window, 200);
  assertOneTrigger(timeline, 'terminal', 'after complete');
});

test('pane 1\'s running delegate opens pane 1\'s inspector from its live trigger; pane 0 shows none', async (t) => {
  const STREAM = 'stream_live_delegate_pane1';
  const app = await loadRendererApp({ shell: {
    sessions: [buildSummary('session-a', 'Alpha'), buildSummary('session-b', 'Beta')],
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ['session-a', 'session-b'] },
    sessionMessagePayloads: {
      'session-a': { data: [{ id: 'user_a', role: 'user', content: 'Hello', status: 'complete' }, { id: 'assistant_a', role: 'assistant', content: 'Hi.', status: 'complete', finalizedAt: '2026-09-26T10:00:00.000Z' }] },
      'session-b': { data: [] },
    },
    chat: { startStream: async (request) => ({ sessionId: request.sessionId, streamId: STREAM }) },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const composition = window.rendererAppPaneComposition.getPaneComposition();
  assert.equal(composition.toggleSplit(), true, 'precondition: the chord opens session-b beside');
  await waitForUi(window, 150);
  const pane1 = composition.getPane(1);
  assert.equal(window.__rendererState.panes.panes[1].sessionId, 'session-b');
  await send(window, pane1.dom.chatInput);
  assert.deepEqual(shell.__state.chatCalls.map((call) => call.sessionId), ['session-b'], 'precondition: pane 1 sent session-b\'s turn');

  const emit = (payload) => shell.__emitChat({ sessionId: 'session-b', streamId: STREAM, requestId: STREAM, ...payload });
  const frames = delegateFrames(STREAM);
  await emit({ type: 'started' });
  await emit(frames.toolUse);
  await emit(frames.start);
  await emit(frames.running);
  await waitForUi(window, 150);

  const pane0Timeline = doc.getElementById('chatTimeline');
  const trigger = assertOneTrigger(pane1.dom.chatTimeline, 'live', 'pane 1 while the child runs');
  assert.equal(triggersIn(pane0Timeline).length, 0, 'pane 0 renders no subagent trigger');
  await click(window, trigger);
  // One shared panel hosts the monitor, owned by pane 1's chat; neither pane's aside opens.
  const panel = doc.getElementById('artifactReviewPanel');
  const monitor = () => panel.querySelector('.subagent-monitor-shell');
  const inspector1 = pane1.root.querySelector('[data-chat-node="subagentInspector"]');
  assert.equal(panel.dataset.artifactReviewMode, 'subagents', 'pane 1 trigger opens the shared panel monitor');
  assert.equal(window.__rendererState.ui.subagentMonitor.sessionId, 'session-b');
  assert.match(monitor().textContent, /Task 1\/1 running\./);
  assert.equal(trigger.getAttribute('aria-controls'), 'artifactReviewPanel');
  assert.equal(inspector1.hidden, true, 'pane 1 aside stays hidden');
  assert.equal(doc.getElementById('subagentInspector').hidden, true, 'pane 0 aside stays hidden');

  await emit(frames.settled);
  await emit(frames.toolResult);
  await waitForUi(window, 150);
  assertOneTrigger(pane1.dom.chatTimeline, 'terminal', 'pane 1 once the report lands');
  assert.equal(triggersIn(pane0Timeline).length, 0, 'pane 0 still renders none');
  assert.equal(panel.dataset.artifactReviewMode, 'subagents');
  assert.match(monitor().textContent, /The test script is node --test tests\/\./);
});
