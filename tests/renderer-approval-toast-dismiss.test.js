'use strict';

/**
 * tests/renderer-approval-toast-dismiss.test.js
 *
 * A tool approval in a background session raises a sticky "Approval Needed"
 * toast. Once that session has no approval left in
 * state.pendingToolApprovals, whichever path resolved it, the toast must
 * leave the screen, and a later approval in the same session must raise it
 * again.
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

async function openApp(t) {
  const app = await loadRendererApp();
  t.after(async () => { await app.dispose(); });
  const { window } = app;
  const shell = window.jennyShell;
  shell.__state.sessions = [
    summary('front-1', 'Front chat'),
    summary('back-1', 'Background chat'),
    summary('back-2', 'Other background chat'),
  ];
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 60);
  const rs = window.__rendererState;
  assert.equal(rs.currentSessionId, 'front-1', 'precondition: the approvals arrive in background sessions');
  const approvalToasts = () => [...window.document.querySelectorAll('#toastViewport .inv-toast')]
    .map((node) => node.textContent || '')
    .filter((text) => text.includes('waiting for tool approval'));
  const emit = async (payload) => {
    await shell.__emitChat(payload);
    await waitForUi(window, 60);
  };
  const requestApproval = (sessionId, streamId, callId) => emit({
    type: 'tool_approval_needed', sessionId, streamId,
    callId, approvalId: `approval-${callId}`, toolName: 'todo_write', input: { todos: [] },
  });
  return { rs, approvalToasts, emit, requestApproval };
}

test('the approval toast leaves once its session\'s last approval resolves through tool_result, and returns for the next one', async (t) => {
  const { rs, approvalToasts, emit, requestApproval } = await openApp(t);
  await emit({ type: 'started', sessionId: 'back-1', streamId: 'stream-a' });
  await requestApproval('back-1', 'stream-a', 'call-1');
  await requestApproval('back-1', 'stream-a', 'call-2');
  assert.equal(approvalToasts().length, 1, 'precondition: one toast per waiting session');

  await emit({
    type: 'tool_result', sessionId: 'back-1', streamId: 'stream-a',
    callId: 'call-1', approvalId: 'approval-call-1', toolName: 'todo_write', output: 'ok',
  });
  assert.equal(rs.pendingToolApprovals.size, 1, 'precondition: call-2 is still waiting');
  assert.equal(approvalToasts().length, 1, 'the toast stays while the session still waits on an approval');

  await emit({
    type: 'tool_result', sessionId: 'back-1', streamId: 'stream-a',
    callId: 'call-2', approvalId: 'approval-call-2', toolName: 'todo_write', output: 'ok',
  });
  assert.equal(rs.pendingToolApprovals.size, 0, 'precondition: nothing is waiting');
  assert.deepEqual(approvalToasts(), [], 'the toast leaves with the session\'s last approval');

  await requestApproval('back-1', 'stream-a', 'call-3');
  assert.equal(approvalToasts().length, 1, 'a later approval in the same session raises the toast again');
});

test('a non-pending tool_use dismisses only its own session\'s approval toast', async (t) => {
  const { approvalToasts, emit, requestApproval } = await openApp(t);
  await emit({ type: 'started', sessionId: 'back-1', streamId: 'stream-a' });
  await emit({ type: 'started', sessionId: 'back-2', streamId: 'stream-b' });
  await requestApproval('back-1', 'stream-a', 'call-1');
  await requestApproval('back-2', 'stream-b', 'call-9');
  assert.equal(approvalToasts().length, 2, 'precondition: both sessions are waiting');

  await emit({
    type: 'tool_use', sessionId: 'back-1', streamId: 'stream-a',
    callId: 'call-1', approvalId: 'approval-call-1', toolName: 'todo_write', input: { todos: [] }, status: 'running',
  });
  assert.equal(approvalToasts().length, 1, 'the approved session\'s toast leaves; the other session still waits');
});

test('terminal cleanup of a cancelled stream dismisses the approval toast', async (t) => {
  const { rs, approvalToasts, emit, requestApproval } = await openApp(t);
  await emit({ type: 'started', sessionId: 'back-1', streamId: 'stream-a' });
  await requestApproval('back-1', 'stream-a', 'call-1');
  assert.equal(approvalToasts().length, 1, 'precondition: the session is waiting');

  await emit({
    type: 'error', sessionId: 'back-1', streamId: 'stream-a', message: 'Stream cancelled.',
    category: 'cancelled', status: 'cancelled', terminal_subcode: 'user_stop',
  });
  assert.equal(rs.pendingToolApprovals.size, 0, 'precondition: terminal cleanup cleared the approval');
  assert.deepEqual(approvalToasts(), [], 'the toast leaves with the cancelled stream');
});

test('another chat finishing leaves a waiting session\'s approval toast up', async (t) => {
  const { approvalToasts, emit, requestApproval } = await openApp(t);
  await emit({ type: 'started', sessionId: 'back-1', streamId: 'stream-a' });
  await emit({ type: 'started', sessionId: 'back-2', streamId: 'stream-b' });
  await requestApproval('back-1', 'stream-a', 'call-1');
  assert.equal(approvalToasts().length, 1, 'precondition: back-1 is waiting');

  await emit({ type: 'token', sessionId: 'back-2', streamId: 'stream-b', content: 'done' });
  await emit({
    type: 'complete', sessionId: 'back-2', streamId: 'stream-b', content: 'done',
    interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '',
  });
  assert.equal(approvalToasts().length, 1, 'back-2 finishing must not clear back-1\'s still-valid toast');
});
