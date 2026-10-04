'use strict';

/**
 * tests/renderer-attention-inbox-pause.test.js
 *
 * Gate row A4 (1.2.0): a runtime pause suspends a pending approval main-side.
 * The renderer must drop that approval from "Needs you" when main withdraws
 * it, and a new stream in the same session supersedes any approval still
 * filed under an older stream, so Resume's re-offer of the same call id is
 * answered with its own approval id instead of the suspended one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function summary(id, title) {
  return {
    id, title, conversation_mode: 'chat', preferred_model: 'gpt-test', reasoning_effort: 'default',
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    interactive_round_count: 0, interactive_sequence_state: 'idle', pending_question_batch: null,
    linked_session_ids: [], message_count: 1, last_message_preview: 'preview',
    updated_at: new Date().toISOString(), created_at: new Date().toISOString(), pinned: false, archived_at: null,
  };
}

async function openBackgroundApproval(t) {
  const approveCalls = [];
  const app = await loadRendererApp({ shell: { tools: { approve: (ref) => { approveCalls.push(ref); return true; } } } });
  t.after(async () => { await app.dispose(); });
  const { window } = app;
  const shell = window.jennyShell;
  shell.__state.sessions = [summary('front-1', 'Front chat'), summary('back-1', 'Background chat')];
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 60);
  await shell.__emitChat({ type: 'started', sessionId: 'back-1', streamId: 'stream-a' });
  await shell.__emitChat({
    type: 'tool_approval_needed', sessionId: 'back-1', streamId: 'stream-a',
    callId: 'call-x', approvalId: 'approval-a', toolName: 'todo_write', input: { todos: [] },
  });
  await waitForUi(window, 80);
  const rs = window.__rendererState;
  const host = window.document.getElementById('attentionInbox');
  assert.equal(rs.pendingToolApprovals.has('approval-a'), true, 'precondition: the approval is pending');
  assert.ok(host.querySelector('[data-attention-key="approval:call-x"]'), 'precondition: the row is in Needs you');
  return { window, shell, rs, host, approveCalls };
}

test('a paused turn\'s approval leaves Needs you when its session\'s next stream starts, and the re-offer is answered with its own id', async (t) => {
  const { window, shell, rs, host, approveCalls } = await openBackgroundApproval(t);

  // The queued follow-up (or Resume) starts a new stream in the same session.
  await shell.__emitChat({ type: 'started', sessionId: 'back-1', streamId: 'stream-b' });
  await waitForUi(window, 80);
  assert.equal(rs.pendingToolApprovals.has('approval-a'), false, 'the older stream\'s approval is superseded');
  assert.equal(host.querySelector('.attention-inbox__row'), null);

  // Resume re-offers the same call id under a new scoped approval id.
  await shell.__emitChat({
    type: 'tool_approval_needed', sessionId: 'back-1', streamId: 'stream-b',
    callId: 'call-x', approvalId: 'approval-b', toolName: 'todo_write', input: { todos: [] },
  });
  await waitForUi(window, 80);
  const rows = [...host.querySelectorAll('.attention-inbox__row')].map((node) => node.dataset.attentionKey);
  assert.deepEqual(rows, ['approval:call-x']);
  host.querySelector('[data-attention-action="allow"]').click();
  await waitForUi(window, 40);
  assert.deepEqual(approveCalls, ['approval-b'], 'Allow answers the live approval, not the suspended one');
});

test('a runtime pause withdraws the approval from Needs you with nothing else starting, and leaves the transcript row pending', async (t) => {
  const { window, shell, rs, host } = await openBackgroundApproval(t);
  const toolCall = () => (rs.messagesBySession.get('back-1') || [])
    .find((message) => message?.kind === 'tool_use' && message.tool_call?.call_id === 'call-x')?.tool_call;
  assert.equal(toolCall()?.status, 'pending_approval', 'precondition: the transcript card awaits approval');

  await shell.__emitChat({
    type: 'tool_approval_withdrawn', sessionId: 'back-1', streamId: 'stream-a', turnId: 'stream-a',
    callId: 'call-x', approvalId: 'approval-a', toolName: 'todo_write', reason: 'runtime_pause',
  });
  await waitForUi(window, 80);
  assert.equal(rs.pendingToolApprovals.has('approval-a'), false, 'the withdrawn approval leaves the map');
  assert.equal(host.querySelector('.attention-inbox__row'), null, 'and the inbox');
  assert.equal(host.hidden, true);
  assert.equal(toolCall()?.status, 'pending_approval', 'the checkpoint keeps the tool row as it was');
});

// The ask_user half: "Needs you" lists question batches, not ask_user waits,
// so the waiting chat's "Input needed" attention is what a pause must clear.
const QUESTION_SESSION = 'session-q1';
const QUESTIONS = [{ id: 'choice', prompt: 'Which value?', options: ['One', 'Two'] }];
const questionEvent = (streamId, questionRef, type = 'user_questions_requested') => ({
  type, sessionId: QUESTION_SESSION, streamId, turnId: 'turn-q', callId: 'call-q', questionId: `id-${questionRef}`,
  questionRef, toolName: 'ask_user',
  ...(type === 'user_questions_requested' ? { questions: QUESTIONS, input: { questions: QUESTIONS },
    summary: 'Ask user 1 question', status: 'pending_user_input', resultKind: 'user_questions' } : { reason: 'runtime_pause' }),
});

async function openQuestion(t) {
  const answers = [];
  const app = await loadRendererApp({ shell: {
    sessions: [summary(QUESTION_SESSION, 'Questions')],
    workspaceState: { activeSessionId: QUESTION_SESSION, openSessionIds: [QUESTION_SESSION] },
    sessionMessagePayloads: { [QUESTION_SESSION]: { data: [], turn_events: [] } },
  } });
  t.after(async () => { await app.dispose(); });
  Object.assign(app.shell.chat, {
    async hasPendingUserQuestions(ref) { return ref === 'ref-b'; },
    async answerUserQuestions(ref) { answers.push(ref); return ref === 'ref-b'; },
  });
  const { window, shell } = app;
  await waitForUi(window, 100);
  const offer = async (streamId, questionRef) => {
    await shell.__emitChat({ type: 'started', sessionId: QUESTION_SESSION, streamId, turnId: 'turn-q' });
    await shell.__emitChat({ type: 'tool_use', sessionId: QUESTION_SESSION, streamId, turnId: 'turn-q', callId: 'call-q',
      toolName: 'ask_user', status: 'running', input: { questions: QUESTIONS }, summary: 'Ask user' });
    await shell.__emitChat(questionEvent(streamId, questionRef));
    await waitForUi(window, 80);
  };
  await offer('stream-a', 'ref-a');
  const attention = () => window.rendererMultiStreamController.getSessionAttentionStates([QUESTION_SESSION]).get(QUESTION_SESSION);
  const toolCall = (streamId) => (window.__rendererState.messagesBySession.get(QUESTION_SESSION) || [])
    .find((message) => message?.id === `tool_use_${streamId}_call-q`)?.tool_call;
  assert.equal(attention(), 'input_needed', 'precondition: the chat reads Input needed');
  return { window, shell, answers, offer, attention, toolCall };
}

test('a runtime pause withdraws ask_user questions from Input needed and leaves the transcript card pending', async (t) => {
  const { window, shell, attention, toolCall } = await openQuestion(t);
  await shell.__emitChat(questionEvent('stream-a', 'ref-other', 'user_questions_withdrawn'));
  await waitForUi(window, 60);
  assert.equal(attention(), 'input_needed', 'a withdrawal for another question ref changes nothing');

  await shell.__emitChat(questionEvent('stream-a', 'ref-a', 'user_questions_withdrawn'));
  await waitForUi(window, 80);
  assert.equal(attention(), undefined, 'the withdrawn questions no longer ask for input');
  assert.equal(toolCall('stream-a')?.status, 'pending_user_input', 'the checkpoint keeps the card as it was');
  assert.equal(toolCall('stream-a')?.question_ref, 'ref-a');
  assert.ok(window.document.querySelector('.user-questions-block[data-question-ref="ref-a"]'), 'the card still renders');
});

for (const withdrawn of [true, false]) {
  test(`Resume re-offers the questions under a new ref and the card answers with it (${withdrawn ? 'after a withdrawal' : 'next stream only'})`, async (t) => {
    const { window, shell, answers, offer, attention } = await openQuestion(t);
    if (withdrawn) await shell.__emitChat(questionEvent('stream-a', 'ref-a', 'user_questions_withdrawn'));
    await shell.__emitChat({ type: 'started', sessionId: QUESTION_SESSION, streamId: 'stream-b', turnId: 'turn-q' });
    await waitForUi(window, 60);
    assert.equal(attention(), undefined, 'the next stream supersedes the older stream\'s questions');

    await offer('stream-b', 'ref-b');
    assert.equal(attention(), 'input_needed', 'the re-offer asks again');
    const cards = [...window.document.querySelectorAll('.user-questions-block')].map((card) => card.dataset.questionRef);
    assert.deepEqual(cards, ['ref-b']);
    const card = window.document.querySelector('.user-questions-block');
    card.querySelector('[data-user-question-option][value="Two"]').closest('label').click();
    card.querySelector('.user-questions-submit-btn').click();
    await waitForUi(window, 60);
    assert.deepEqual(answers, ['ref-b'], 'the card answers the live question ref, not the suspended one');
  });
}
