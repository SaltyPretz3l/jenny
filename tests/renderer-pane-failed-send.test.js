'use strict';

/* Split view gate row D8, the failed-send half (docs/plans/split-view/
 * W1_OWNER_GATE.md §D): "force a send failure in pane 1 -> the failed-send
 * notice shows under pane 1 and Retry resends from pane 1".
 *
 * Driven end to end through the real shell (jsdom harness), two panes from the
 * chord: pane 0 on session-a, pane 1 on session-b. The failure is real: the
 * chat bridge's startStream rejects pane 1's first send, so the send path
 * itself annotates the optimistic user row (send_failure) and parks the
 * failed payload in pane 1's shell; nothing hand-writes the failed record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

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
    { id: `assistant_${sessionId}`, role: 'assistant', content: `Answer from ${text}.`, status: 'complete', finalizedAt: new Date().toISOString() },
  ];
}

/* The bridge rejects the first send (a transport failure before acceptance,
   the shape an IPC invoke rejection takes) and accepts every later one. */
function failFirstSend() {
  let attempts = 0;
  return async (payload) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('transport unavailable');
      error.code = 'CMP-CHAT-0002';
      throw error;
    }
    return { sessionId: payload.sessionId, streamId: `stream-retry-${attempts}` };
  };
}

async function openTwoPanes(t) {
  const app = await loadRendererApp({ shell: {
    sessions: [buildSummary('session-a', 'Alpha'), buildSummary('session-b', 'Beta')],
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ['session-a', 'session-b'] },
    sessionMessagePayloads: {
      'session-a': { data: transcript('session-a', 'pane zero') },
      'session-b': { data: transcript('session-b', 'pane one') },
    },
    chat: { startStream: failFirstSend() },
  } });
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const composition = window.rendererAppPaneComposition.getPaneComposition();
  assert.equal(composition.toggleSplit(), true, 'precondition: the chord opens session-b beside');
  await waitForUi(window, 150);
  const pane1 = composition.getPane(1);
  assert.ok(pane1, 'pane 1 is mounted');
  const state = window.__rendererState;
  assert.equal(state.panes.panes[1].sessionId, 'session-b');
  return { window, doc, composition, pane1, state };
}

const isShown = (node) => Boolean(node) && !node.classList.contains('hidden');
const failedRows = (state, sessionId) => (state.messagesBySession.get(sessionId) || [])
  .filter((message) => message?.role === 'user' && message.send_failure?.state === 'failed');

function typeAndSend(window, input, text) {
  input.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

test('a send that fails in pane 1 shows its notice under pane 1; Retry resends session-b through pane 1\'s shell', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  const chatCalls = window.jennyShell.__state.chatCalls;
  const paneOneFailed = pane1.root.querySelector('[data-chat-node="composerV2FailedSendNotice"]');
  const paneZeroFailed = doc.getElementById('composerV2FailedSendNotice');
  assert.ok(paneOneFailed && paneOneFailed !== paneZeroFailed, 'precondition: pane 1 carries its own failed-send host');
  assert.equal(paneOneFailed.dataset.composerV2, 'on', 'precondition: pane 1 mounted its notice (composer v2 on)');
  assert.ok(pane1.dom.composerWrap.contains(paneOneFailed), 'the host sits in pane 1\'s composer wrap');
  const sessionABefore = state.messagesBySession.get('session-a');

  // Spy the seams the notice drives: pane 1's shell (the one it must use).
  const retries = [];
  const realRetry = pane1.shell.retryFailedPayload;
  pane1.shell.retryFailedPayload = (payloadId) => { retries.push(payloadId); return realRetry(payloadId); };

  typeAndSend(window, pane1.dom.chatInput, 'please answer in pane one');
  await waitForUi(window, 120);

  assert.equal(chatCalls.length, 1, 'pane 1\'s send reached the bridge once');
  assert.equal(chatCalls[0].sessionId, 'session-b', 'the failed send targeted session-b');
  const [failed] = failedRows(state, 'session-b');
  assert.ok(failed, 'the send path annotated session-b\'s optimistic user row as failed');
  assert.ok(failed.send_failure.payload_id, 'the failure names its parked payload');
  assert.deepEqual(failedRows(state, 'session-a'), [], 'session-a has no failure');
  assert.equal(pane1.shell.getFailedPayloadRetryAvailability(failed.send_failure.payload_id).available, true,
    'pane 1\'s shell holds the failed payload');

  assert.equal(isShown(paneOneFailed), true, 'the failed-send notice shows in pane 1');
  assert.ok(pane1.root.contains(paneOneFailed));
  assert.equal(isShown(paneZeroFailed), false, 'pane 0\'s notice host stays hidden');
  assert.equal(paneZeroFailed.textContent.trim(), '', 'and empty');
  const retry = paneOneFailed.querySelector('[data-action="retry"]');
  assert.ok(retry, 'pane 1\'s notice offers Retry');
  assert.equal(retry.disabled, false, 'Retry is available');

  retry.click();
  await waitForUi(window, 120);

  assert.deepEqual(retries, [failed.send_failure.payload_id], 'Retry went through pane 1\'s shell with the failed payload');
  assert.equal(chatCalls.length, 2, 'the retry reached the bridge');
  assert.equal(chatCalls[1].sessionId, 'session-b', 'and resent session-b');
  assert.equal(chatCalls[1].prompt, chatCalls[0].prompt, 'with the original prompt');
  assert.equal(state.panes.panes[0].sessionId, 'session-a', 'pane 0 still shows session-a');
  assert.equal(state.messagesBySession.get('session-a'), sessionABefore, 'session-a\'s transcript is untouched');
  assert.equal(failedRows(state, 'session-b').filter((row) => row.send_failure.dismissed !== true).length, 0,
    'the accepted retry cleared the failure marker');
  assert.equal(isShown(paneOneFailed), false, 'pane 1\'s notice cleared after the accepted retry');
  assert.equal(isShown(paneZeroFailed), false, 'pane 0\'s never showed');
});

test('focusing and repainting pane 0 leaves its notice empty; pane 1 keeps showing its own failure', async (t) => {
  const { window, doc, pane1, state } = await openTwoPanes(t);
  typeAndSend(window, pane1.dom.chatInput, 'fails in pane one');
  await waitForUi(window, 120);
  const [failed] = failedRows(state, 'session-b');
  assert.ok(failed, 'precondition: pane 1\'s send failed');

  // Focus pane 0 and repaint it: its notice scans session-a and stays down.
  doc.getElementById('chatInput').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  await waitForUi(window, 60);
  assert.equal(state.currentSessionId, 'session-a', 'precondition: pane 0 is focused');
  state.harness.agentActions.setActiveView('chat');
  await waitForUi(window, 80);
  const paneZeroFailed = doc.getElementById('composerV2FailedSendNotice');
  assert.equal(isShown(paneZeroFailed), false, 'pane 0 shows no failure of session-b\'s');
  assert.equal(paneZeroFailed.textContent.trim(), '');
  assert.equal(isShown(pane1.root.querySelector('[data-chat-node="composerV2FailedSendNotice"]')), true,
    'pane 1 keeps showing its own failure while unfocused');
  assert.equal(doc.getElementById('chatTimeline').querySelector(`[data-message-id="${failed.id}"]`), null,
    'the failed row is not in pane 0\'s transcript');
});
