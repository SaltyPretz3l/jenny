'use strict';

/* Split view gate row D5 (docs/plans/split-view/W1_OWNER_GATE.md §D): "pane 1
 * runs a subagent; its monitor opens for pane 1". Live driving is blocked
 * while the desktop command sandbox is enforced (`delegate: config disabled`),
 * so this drives the renderer half of a delegate run: pane 1 sends, and the
 * chat bridge streams the `agent_status` events a running `delegate` call
 * emits on pane 1's session (the stream handler builds agent_status_steps, pane
 * 1's pipeline renders the subagent row). The inspector opens the way a user
 * opens it, by clicking that row in pane 1's transcript, and then follows the
 * child to its finish in place.
 *
 * Real shell (jsdom harness), two panes from the chord: pane 0 on session-a,
 * pane 1 on session-b. Pane 0 has no subagent at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const STREAM = 'stream-b-delegate';
const CALL = 'call_delegate_live_b';

function buildSummary(id, title) {
  return {
    id,
    title,
    session_type: 'chat',
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    plan_mode: false,
    pinned: false,
    archived_at: null,
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    linked_session_ids: [],
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
  };
}

function transcript(sessionId, text) {
  return [
    { id: `user_${sessionId}`, role: 'user', content: `Question for ${text}`, status: 'complete' },
    { id: `assistant_${sessionId}`, role: 'assistant', content: `Answer from ${text}.`, status: 'complete', finalizedAt: '2026-09-26T10:00:00.000Z' },
  ];
}

async function openTwoPanes(t) {
  const app = await loadRendererApp({ shell: {
    sessions: [buildSummary('session-a', 'Alpha'), buildSummary('session-b', 'Beta')],
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ['session-a', 'session-b'] },
    sessionMessagePayloads: {
      'session-a': { data: transcript('session-a', 'pane zero') },
      'session-b': { data: transcript('session-b', 'pane one') },
    },
    chat: { startStream: async (payload) => ({ sessionId: payload.sessionId, streamId: STREAM }) },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const composition = window.rendererAppPaneComposition.getPaneComposition();
  assert.equal(composition.toggleSplit(), true, 'precondition: the chord opens session-b beside');
  await waitForUi(window, 150);
  const pane1 = composition.getPane(1);
  assert.ok(pane1, 'pane 1 is mounted');
  const state = window.__rendererState;
  assert.equal(state.panes.panes[1].sessionId, 'session-b');
  return { window, shell, doc, pane1, state };
}

const pointerDown = (window, element) => element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));

/* A real click: the capture-phase pointerdown focuses the pane first. */
async function clickInPane(window, element) {
  pointerDown(window, element);
  element.click();
  await waitForUi(window, 80);
}

/* Pane 1 sends; the turn delegates one child whose progress streams in. */
async function startDelegateRunInPaneOne({ window, shell, pane1 }) {
  const input = pane1.dom.chatInput;
  pointerDown(window, input);
  input.value = 'Research the repo with a subagent';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitForUi(window, 80);
  assert.deepEqual(shell.__state.chatCalls.map((call) => call.sessionId), ['session-b'], 'precondition: pane 1 sent session-b\'s turn');

  const emit = (payload) => shell.__emitChat({ sessionId: 'session-b', streamId: STREAM, requestId: STREAM, ...payload });
  await emit({ type: 'started' });
  const child = {
    type: 'agent_status', taskType: 'sub_agent', source: 'delegate',
    taskId: 'delegate-task-b', toolCallId: CALL,
    childTaskId: `delegate:request:${CALL}:task:1`, childOrdinal: 1, childCount: 1,
    childLabel: 'Beta live survey', agentId: `research@${STREAM}:${CALL}:1`,
    parentAgentId: `main@${STREAM}`, terminal: false, success: false,
  };
  await emit({ ...child, status: 'running', stage: 'planning', percent: 20, summary: 'Planning the survey' });
  await emit({ ...child, status: 'running', stage: 'gathering_context', percent: 60, summary: 'Reading pane one files' });
  await waitForUi(window, 150);
  return { emit, child };
}

/* What pane 0 shows, minus the follow-up actions a running turn disables app-wide. */
function paneZeroTranscript(doc) {
  const timeline = doc.getElementById('chatTimeline');
  return {
    ids: Array.from(timeline.querySelectorAll('article[data-message-id]'), (node) => node.getAttribute('data-message-id')),
    text: Array.from(timeline.querySelectorAll('.chat-bubble'), (node) => node.textContent.trim()),
    subagentRows: timeline.querySelectorAll('[data-subagent-open]').length,
  };
}

function assertMonitorForPaneOne({ doc, pane1, state }, trigger, pattern) {
  const panel = doc.getElementById('artifactReviewPanel');
  const monitor = panel.querySelector('.subagent-monitor-shell');
  const inspector0 = doc.getElementById('subagentInspector');
  const inspector1 = pane1.root.querySelector('aside.subagent-monitor-inspector[data-chat-node="subagentInspector"]');
  assert.ok(inspector1 && inspector1 !== inspector0, 'pane 1 still carries its own aside (the IDE dock host)');
  assert.equal(inspector1.id, 'subagentInspector-pane1', 'with the -pane1 id');
  assert.equal(panel.dataset.artifactReviewMode, 'subagents', 'Chat hosts the monitor in the shared artifact panel');
  assert.equal(panel.classList.contains('hidden'), false);
  assert.ok(monitor, 'painted into the panel by the pull');
  assert.match(monitor.textContent, pattern, 'showing pane 1\'s subagent');
  assert.equal(state.ui.subagentMonitor.sessionId, 'session-b', 'the record belongs to pane 1\'s chat');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'the row reports its monitor open');
  assert.equal(trigger.getAttribute('aria-controls'), 'artifactReviewPanel', 'and controls the panel that hosts it');

  assert.equal(inspector1.hidden, true, 'pane 1\'s aside stays closed in Chat');
  assert.equal(inspector1.innerHTML, '', 'and empty');
  assert.equal(inspector0.hidden, true, 'pane 0\'s #subagentInspector stays hidden');
  assert.equal(inspector0.innerHTML, '', 'and empty');
  assert.match(panel.querySelector(':scope > .side-panel-owner-line').textContent, /Beta/, 'the owner line names pane 1\'s chat');
}

test('a delegate run streaming in pane 1 opens its monitor in the shared panel; pane 0 is untouched', async (t) => {
  const rig = await openTwoPanes(t);
  const { window, doc, pane1, state } = rig;
  const paneZeroBefore = paneZeroTranscript(doc);
  const messagesA = state.messagesBySession.get('session-a');
  await startDelegateRunInPaneOne(rig);

  const trigger = pane1.dom.chatTimeline.querySelector(`[data-subagent-open="${CALL}"]`);
  assert.ok(trigger, 'pane 1\'s transcript renders the running subagent row');
  assert.equal(trigger.getAttribute('data-subagent-source'), 'live');
  assert.equal(doc.getElementById('chatTimeline').querySelector('[data-subagent-open]'), null, 'pane 0 renders no subagent row');

  await clickInPane(window, trigger);
  assert.equal(state.currentSessionId, 'session-b', 'the click focused pane 1');
  assertMonitorForPaneOne(rig, trigger, /Beta live survey/);
  assert.deepEqual(paneZeroTranscript(doc), paneZeroBefore, 'pane 0\'s transcript is untouched');
  assert.equal(state.messagesBySession.get('session-a'), messagesA, 'session-a\'s messages are untouched');

  // Closing from inside the panel ends the record and restores the closed panel.
  doc.getElementById('artifactReviewPanel').querySelector('[data-subagent-close]').click();
  await waitForUi(window, 40);
  assert.equal(state.ui.subagentMonitor, null);
  assert.equal(doc.getElementById('artifactReviewPanel').querySelector('.subagent-monitor-shell'), null);
  assert.equal(doc.getElementById('artifactReviewPanel').classList.contains('hidden'), true, 'the panel is back to closed');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('pane 1\'s open monitor follows its subagent to the finish in the panel; pane 0 never opens', async (t) => {
  const rig = await openTwoPanes(t);
  const { window, doc, pane1, state } = rig;
  const paneZeroBefore = paneZeroTranscript(doc);
  const { emit, child } = await startDelegateRunInPaneOne(rig);
  const trigger = pane1.dom.chatTimeline.querySelector(`[data-subagent-open="${CALL}"]`);
  assert.ok(trigger, 'precondition: pane 1 renders the running subagent row');
  await clickInPane(window, trigger);
  const panel = doc.getElementById('artifactReviewPanel');
  const monitor = () => panel.querySelector('.subagent-monitor-shell');
  assert.match(monitor().textContent, /Beta live survey/, 'precondition: the monitor shows the child');
  assert.match(monitor().textContent, /Reading pane one files/, 'and the running child\'s summary');
  assert.match(monitor().textContent, /Steps appear when this subagent finishes\./);

  // The child finishes while the parent turn is still streaming: the open monitor re-renders in place.
  await emit({
    ...child, status: 'completed', stage: 'completed', percent: 100, summary: 'Survey written',
    childTerminal: true, childSuccess: true, terminal: true, success: true,
  });
  await waitForUi(window, 150);
  const liveTrigger = pane1.dom.chatTimeline.querySelector(`[data-subagent-open="${CALL}"]`);
  assertMonitorForPaneOne(rig, liveTrigger, /Beta live survey/);
  assert.match(monitor().textContent, /Completed/, 'the monitor shows the child finished');
  assert.match(monitor().textContent, /Survey written/, 'with its final summary');
  assert.doesNotMatch(monitor().textContent, /Reading pane one files/);
  assert.deepEqual(paneZeroTranscript(doc), paneZeroBefore, 'pane 0\'s transcript is untouched');
  assert.equal(state.currentSessionId, 'session-b');
  // Back to the tree at any width: the delegation with its one child, and the parent synthesizing.
  monitor().querySelector('[data-subagent-back]').click();
  assert.match(monitor().textContent, /Synthesizing results/, 'the tree shows the parent synthesizing');
});
