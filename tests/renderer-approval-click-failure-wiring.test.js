'use strict';

// F15 (1.2.0 gate A4 attempt 3): a failed Allow once must reach the reader.
// The transcript bindings' failure branch logs through appendClientLog, so the
// full shell has to wire it in; without it the .catch threw and the card sat
// busy with no error shown.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

test('a failed Allow once shows the approval error and frees the card', async (t) => {
  const sessionId = 'approval-failure-session';
  const streamId = 'approval-failure-stream';
  const app = await loadRendererApp({
    shell: { tools: { async approve() { throw new Error('Approval is already resolved'); } }, chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{ id: sessionId, title: sessionId, conversation_mode: 'chat', preferred_model: 'gpt-test',
          updated_at: new Date().toISOString(), linked_session_ids: [],
          context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
        state.messagesBySession.set(sessionId, []);
        return { sessionId, streamId };
      },
    } },
  });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  input.value = 'Write the file';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 60);
  const emit = async (payload) => {
    await shell.__emitChat({ sessionId, streamId, ...payload });
    await waitForUi(window, 65);
  };
  await emit({ type: 'started' });
  await emit({ type: 'tool_approval_needed', callId: 'call-write', approvalId: 'call-write',
    toolName: 'write_file', input: { path: 'a.txt', content: 'x' } });

  const allow = doc.querySelector('.tool-approve-btn:not(.tool-approve-always-btn)');
  assert.ok(allow, 'Allow once is on the card');
  allow.click();
  await waitForUi(window, 80);

  assert.match(doc.body.textContent, /Approval Failed/);
  assert.equal(allow.disabled, false, 'the card is usable again');
});

// F14 (A4 attempt 3): Resume leaves the paused card live about a second before
// main re-offers the call under a new approval id. An Allow clicked in that gap
// must answer the re-offer, not the suspended approval.
test('an Allow clicked before the resumed re-offer answers the new approval id', async (t) => {
  const approveCalls = [];
  const app = await loadRendererApp({ shell: { tools: { approve: (ref) => { approveCalls.push(ref); return { ok: true }; } } } });
  t.after(() => app.dispose());
  const { window } = app;
  const shell = window.jennyShell;
  shell.__state.sessions = [{ id: 'resume-1', title: 'Resume', conversation_mode: 'chat', preferred_model: 'gpt-test',
    updated_at: new Date().toISOString(), linked_session_ids: [],
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 60);
  window.document.querySelector('[data-session-open="resume-1"]').click();
  await waitForUi(window, 60);
  await shell.__emitChat({ type: 'started', sessionId: 'resume-1', streamId: 'stream-a' });
  await shell.__emitChat({ type: 'tool_approval_needed', sessionId: 'resume-1', streamId: 'stream-a',
    callId: 'call-x', approvalId: 'approval-a', toolName: 'write_file', input: { path: 'a.txt', content: 'x' } });
  await waitForUi(window, 80);
  const allow = window.document.querySelector('.tool-approve-btn:not(.tool-approve-always-btn)');
  assert.ok(allow, 'precondition: the card offers Allow once');

  // The runtime pause suspended approval-a; Resume has not been re-offered yet.
  window.__rendererState.pendingToolApprovals.delete('approval-a');
  allow.click();
  await waitForUi(window, 30);
  assert.deepEqual(approveCalls, [], 'nothing is sent before main re-offers the call');

  await shell.__emitChat({ type: 'started', sessionId: 'resume-1', streamId: 'stream-b' });
  await shell.__emitChat({ type: 'tool_approval_needed', sessionId: 'resume-1', streamId: 'stream-b',
    callId: 'call-x', approvalId: 'approval-b', toolName: 'write_file', input: { path: 'a.txt', content: 'x' } });
  await waitForUi(window, 300);
  assert.deepEqual(approveCalls, ['approval-b']);
});

// Astra review of F14: call ids recur across sessions (fallbacks such as call_1),
// so the re-offer lookup must stay inside the card's own session.
test('an Allow in the resume gap never answers another session with the same call id', async (t) => {
  const approveCalls = [];
  const app = await loadRendererApp({ shell: { tools: { approve: (ref) => { approveCalls.push(ref); return { ok: true }; } } } });
  t.after(() => app.dispose());
  const { window } = app;
  const shell = window.jennyShell;
  shell.__state.sessions = [{ id: 'resume-1', title: 'Resume', conversation_mode: 'chat', preferred_model: 'gpt-test',
    updated_at: new Date().toISOString(), linked_session_ids: [],
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 60);
  window.document.querySelector('[data-session-open="resume-1"]').click();
  await waitForUi(window, 60);
  await shell.__emitChat({ type: 'started', sessionId: 'resume-1', streamId: 'stream-a' });
  await shell.__emitChat({ type: 'tool_approval_needed', sessionId: 'resume-1', streamId: 'stream-a',
    callId: 'call-x', approvalId: 'approval-a', toolName: 'write_file', input: { path: 'a.txt', content: 'x' } });
  await waitForUi(window, 80);
  const allow = window.document.querySelector('.tool-approve-btn:not(.tool-approve-always-btn)');
  assert.ok(allow, 'precondition: the card offers Allow once');

  const approvals = window.__rendererState.pendingToolApprovals;
  approvals.delete('approval-a');
  approvals.set('approval-other', { approvalId: 'approval-other', callId: 'call-x', sessionId: 'other-session' });
  allow.click();
  await waitForUi(window, 30);
  assert.deepEqual(approveCalls, [], 'another session\'s approval is never answered');

  await shell.__emitChat({ type: 'started', sessionId: 'resume-1', streamId: 'stream-b' });
  await shell.__emitChat({ type: 'tool_approval_needed', sessionId: 'resume-1', streamId: 'stream-b',
    callId: 'call-x', approvalId: 'approval-b', toolName: 'write_file', input: { path: 'a.txt', content: 'x' } });
  await waitForUi(window, 300);
  assert.deepEqual(approveCalls, ['approval-b']);
});
