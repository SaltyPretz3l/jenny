const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

test('renderer keeps a deleted session tombstoned without leaking dismissed memory state to its replacement', async () => {
  const memoryCalls = {
    suggest: [],
    dismiss: [],
  };
  const candidate = {
    title: 'Preference: concise answers',
    lesson_text: 'The user prefers concise answers.',
    lesson_kind: 'preference',
    confidence: 0.95,
    source_excerpt: 'Keep it concise',
    content_fingerprint: 'preference:the-user-prefers-concise-answers',
  };
  const app = await loadRendererApp({
    shell: {
      memory: {
        async suggestForSession(sessionId) {
          memoryCalls.suggest.push(sessionId);
          return { suggestions: [candidate] };
        },
        async listApproved() {
          return { memories: [] };
        },
        async dismiss(fingerprint) {
          memoryCalls.dismiss.push(fingerprint);
        },
      },
    },
  });
  const { window, shell } = app;

  try {
    const toastViewport = window.document.getElementById('toastViewport');

    shell.__state.sessions = [{
      id: 'session-memory-delete',
      title: 'Memory Delete Session',
      conversation_mode: 'chat',
      preferred_model: 'gpt-test',
      reasoning_effort: 'default',
      context_preferences: {
        history_scope: 'session',
        include_personality: true,
        include_memory: true,
      },
      interactive_round_count: 0,
      interactive_sequence_state: 'idle',
      pending_question_batch: null,
      updated_at: new Date().toISOString(),
    }];
    shell.__state.messagesBySession.set('session-memory-delete', []);
    await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
    await waitForUi(window, 40);
    await shell.__emitChat({
      type: 'complete',
      sessionId: 'session-memory-delete',
      streamId: 'stream-memory-delete-1',
      content: 'Concise reply.',
      interactiveProtocolDrift: false,
      interactiveProtocolDriftPreview: '',
    });
    await waitForUi(window, 20);

    const dismissButton = toastViewport.querySelector('[data-toast-action-id="dismiss"]');
    assert.ok(dismissButton);
    dismissButton.click();
    await waitForUi(window, 20);

    const menuButton = window.document.querySelector(
      '[data-session-action="menu"][data-session-id="session-memory-delete"]'
    );
    assert.ok(menuButton);
    menuButton.click();
    await waitForUi(window, 10);
    const deleteItem = [...window.document.querySelectorAll('.inv-context-menu-item')]
      .find((button) => button.textContent.trim() === 'Delete');
    assert.ok(deleteItem);
    deleteItem.click();
    await waitForUi(window, 20);
    window.document.querySelector('[data-toast-action-id="session-delete-now"]').click();
    await waitForUi(window, 40);

    shell.__state.sessions = [{
      id: 'session-memory-replacement',
      title: 'Memory Replacement Session',
      conversation_mode: 'chat',
      preferred_model: 'gpt-test',
      reasoning_effort: 'default',
      context_preferences: {
        history_scope: 'session',
        include_personality: true,
        include_memory: true,
      },
      interactive_round_count: 0,
      interactive_sequence_state: 'idle',
      pending_question_batch: null,
      updated_at: new Date().toISOString(),
    }];
    shell.__state.messagesBySession.set('session-memory-replacement', []);
    await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
    await waitForUi(window, 40);
    window.document.querySelector('[data-session-open="session-memory-replacement"]')?.click();
    await waitForUi(window, 30);
    assert.equal(window.__rendererState.currentSessionId, 'session-memory-replacement');

    await shell.__emitChat({
      type: 'complete',
      sessionId: 'session-memory-replacement',
      streamId: 'stream-memory-delete-2',
      content: 'Concise reply again.',
      interactiveProtocolDrift: false,
      interactiveProtocolDriftPreview: '',
    });
    await waitForUi(window, 20);

    assert.equal(memoryCalls.suggest.length, 2);
    const reappearedDismissButton = toastViewport.querySelector('[data-toast-action-id="dismiss"]');
    assert.ok(reappearedDismissButton);
    assert.deepEqual(memoryCalls.dismiss, [candidate.content_fingerprint]);
  } finally {
    await app.dispose();
  }
});
