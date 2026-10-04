'use strict';

/**
 * tests/renderer-desktop-notifications-shell.test.js
 *
 * The desktop-notification emitters wired into the real shell: a stream that
 * completes and an approval that arrives in a background chat reach the
 * `jennyShell.notifications.notify` bridge through the same entry points the
 * app uses (the terminal-settle wrappers and the "Needs you" inbox pass), the
 * would-be toasts are readable off renderer state, and a toast click
 * (`notifications.onOpen`) opens its chat.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

// Candidates are built inside the renderer realm; compare by value, not prototype.
const plain = (value) => JSON.parse(JSON.stringify(value));

function summary(id, title) {
  return {
    id, title, conversation_mode: 'chat', preferred_model: 'gpt-test', reasoning_effort: 'default',
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    interactive_round_count: 0, interactive_sequence_state: 'idle', pending_question_batch: null,
    linked_session_ids: [], message_count: 1, last_message_preview: 'preview',
    updated_at: new Date().toISOString(), created_at: new Date().toISOString(), pinned: false, archived_at: null,
  };
}

test('a completed stream and a new background approval reach the notify bridge; a toast click opens the chat', async (t) => {
  const sent = [];
  const openListeners = [];
  const notifications = {
    notify: (candidate) => { sent.push(candidate); },
    onOpen: (listener) => {
      openListeners.push(listener);
      return () => {
        const index = openListeners.indexOf(listener);
        if (index !== -1) openListeners.splice(index, 1);
      };
    },
  };
  const app = await loadRendererApp({ shell: { notifications } });
  t.after(() => app.dispose());
  const { window } = app;
  const shell = window.jennyShell;
  shell.__state.sessions = [summary('front-1', 'Front chat'), summary('back-1', 'Background chat')];
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 60);
  const rs = window.__rendererState;
  assert.ok(rs.desktopNotificationsController, 'the shell constructs the controller');
  assert.equal(rs.sessionListLoaded, true, 'precondition: the session list is loaded');
  assert.equal(rs.currentSessionId, 'front-1', 'precondition: back-1 is a background chat');
  assert.deepEqual(plain(sent), [], 'booting and loading the session list sends nothing');

  const emit = async (payload) => {
    await shell.__emitChat(payload);
    await waitForUi(window, 60);
  };
  await emit({ type: 'started', sessionId: 'back-1', streamId: 'stream-back' });
  await emit({
    type: 'tool_approval_needed', sessionId: 'back-1', streamId: 'stream-back',
    callId: 'call-1', approvalId: 'approval-call-1', toolName: 'write_file', input: { path: 'a.txt', content: 'x' },
  });
  assert.deepEqual(plain(sent), [{
    category: 'permissions', key: 'inbox:approval:call-1', sessionId: 'back-1',
    title: 'Needs your permission', body: 'write_file · Background chat',
  }]);

  await emit({ type: 'started', sessionId: 'front-1', streamId: 'stream-front' });
  await emit({ type: 'delta', sessionId: 'front-1', streamId: 'stream-front', content: 'Done.' });
  await emit({ type: 'complete', sessionId: 'front-1', streamId: 'stream-front', content: 'Done.\nThe file is written.' });
  await waitForUi(window, 120);
  assert.equal(sent.length, 2, 'the approval did not re-fire and the reply fired once');
  assert.deepEqual(plain(sent[1]), {
    category: 'replies', key: 'turn:stream-front', sessionId: 'front-1',
    title: 'Reply ready', body: 'Front chat', preview: 'Done.',
  });

  const ring = rs.desktopNotificationLog.map(({ at: _at, ...candidate }) => candidate);
  assert.deepEqual(plain(ring), plain(sent), 'the would-be toasts are on renderer state for the agent snapshot');
  assert.deepEqual(plain(rs.desktopNotificationsController.drain().map((entry) => entry.key)),
    ['inbox:approval:call-1', 'turn:stream-front']);

  assert.equal(openListeners.length, 1, 'the controller subscribed to notifications.onOpen');
  openListeners[0]({ sessionId: 'back-1', category: 'permissions', key: 'inbox:approval:call-1' });
  await waitForUi(window, 80);
  assert.equal(rs.currentSessionId, 'back-1', 'a toast click opens its chat');
});
