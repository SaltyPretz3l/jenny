const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

test('renderer memory toast can open settings review without auto-saving the suggestion', async () => {
  const memoryCalls = { suggest: [], save: [] };
  const candidate = {
    title: 'Preference: tea over coffee',
    lesson_text: 'The user prefers tea over coffee.',
    lesson_kind: 'preference',
    confidence: 0.95,
    source_excerpt: 'I prefer tea over coffee',
    content_fingerprint: 'preference:the-user-prefers-tea-over-coffee',
  };
  let pendingCandidates = [];
  const app = await loadRendererApp({
    shell: {
      memory: {
        async suggestForSession(sessionId) {
          memoryCalls.suggest.push(sessionId);
          pendingCandidates = [{ session_id: sessionId, ...candidate }];
          return { suggestions: [candidate] };
        },
        async listApproved() {
          return { memories: [] };
        },
        async listPending() {
          return { candidates: pendingCandidates };
        },
        async save(sessionId, savedCandidate) {
          memoryCalls.save.push({ sessionId, savedCandidate });
          return { created: true, memory: { id: 1, session_id: sessionId, ...savedCandidate } };
        },
      },
    },
  });
  const { window, shell } = app;

  try {
    const input = window.document.getElementById('chatInput');
    input.value = 'Remember this too';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    window.document.getElementById('sendButton').click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'complete',
      sessionId: 'session-1',
      streamId: 'stream-memory-open-hub',
      content: 'Sounds good.',
      interactiveProtocolDrift: false,
      interactiveProtocolDriftPreview: '',
    });
    await waitForUi(window, 20);

    const openReviewButton = window.document
      .getElementById('toastViewport')
      .querySelector('[data-toast-action-id="open-memory-hub"]');
    assert.ok(openReviewButton);
    openReviewButton.click();
    await waitForUi(window, 40);

    assert.equal(memoryCalls.save.length, 0);
    // Review routes directly to the Companion Memory Settings card.
    assert.equal(window.__rendererState.ui.activeView, 'settings');
    assert.equal(window.__rendererState.ui.activeSettingsSection, 'memories');
    assert.equal(
      window.__rendererState.memoryManager.pendingFocusKey,
      'session-1::preference:the-user-prefers-tea-over-coffee'
    );
    assert.equal(
      window.__rendererState.memoryManager.pendingFocusAppliedKey,
      'session-1::preference:the-user-prefers-tea-over-coffee'
    );
    assert.equal(
      window.document.activeElement?.dataset?.pendingMemoryKey,
      'session-1::preference:the-user-prefers-tea-over-coffee'
    );

  } finally {
    await app.dispose();
  }
});

test('renderer memory review focuses the Memory heading when the candidate is no longer pending', async () => {
  const candidate = {
    title: 'Goal: ship Jenny',
    lesson_text: 'The user wants to ship Jenny.',
    lesson_kind: 'goal',
    content_fingerprint: 'goal:ship-jenny',
  };
  const app = await loadRendererApp({
    shell: { memory: {
      async suggestForSession() { return { suggestions: [candidate] }; },
      async listApproved() { return { memories: [] }; },
      async listPending() { return { candidates: [] }; },
    } },
  });
  const { window, shell } = app;

  try {
    const input = window.document.getElementById('chatInput');
    input.value = 'Remember my goal';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    window.document.getElementById('sendButton').click();
    await waitForUi(window, 20);
    await shell.__emitChat({
      type: 'complete', sessionId: 'session-1', streamId: 'stream-memory-missing',
      content: 'Noted.', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '',
    });
    await waitForUi(window, 20);

    window.document.querySelector('[data-toast-action-id="open-memory-hub"]').click();
    await waitForUi(window, 40);

    assert.equal(window.document.activeElement?.id, 'memoryPageHeading');
    assert.equal(window.__rendererState.memoryManager.pendingFocusAppliedKey, 'session-1::goal:ship-jenny');
  } finally {
    await app.dispose();
  }
});

test('renderer refreshes memory data and status after saving from the memory toast', async () => {
  const memoryCalls = { suggest: [], save: [], status: 0, listApproved: 0, listPending: 0 };
  const candidate = {
    title: 'Preference: tea over coffee',
    lesson_text: 'The user prefers tea over coffee.',
    lesson_kind: 'preference',
    confidence: 0.95,
    source_excerpt: 'I prefer tea over coffee',
    content_fingerprint: 'preference:the-user-prefers-tea-over-coffee',
  };
  let approvedMemories = [];
  let pendingCandidates = [];
  const app = await loadRendererApp({
    shell: {
      memory: {
        async status() {
          memoryCalls.status += 1;
          return { available: true, counts: { approved: approvedMemories.length, pending: pendingCandidates.length }, storage: { state: 'ready' }, degraded_reasons: [] };
        },
        async suggestForSession(sessionId) {
          memoryCalls.suggest.push(sessionId);
          pendingCandidates = [{ session_id: sessionId, ...candidate }];
          return { suggestions: [candidate] };
        },
        async save(sessionId, savedCandidate) {
          memoryCalls.save.push({ sessionId, candidate: savedCandidate });
          approvedMemories = [{ id: 1, session_id: sessionId, ...savedCandidate }];
          pendingCandidates = [];
          return { created: true, memory: approvedMemories[0] };
        },
        async listApproved() {
          memoryCalls.listApproved += 1;
          return { memories: approvedMemories };
        },
        async listPending() {
          memoryCalls.listPending += 1;
          return { candidates: pendingCandidates };
        },
      },
    },
  });
  const { window, shell } = app;

  try {
    const input = window.document.getElementById('chatInput');
    input.value = 'Remember this too';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    window.document.getElementById('sendButton').click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'complete',
      sessionId: 'session-1',
      streamId: 'stream-test-3',
      content: 'Sounds good.',
      interactiveProtocolDrift: false,
      interactiveProtocolDriftPreview: '',
    });
    await waitForUi(window, 20);

    const rememberButton = window.document
      .getElementById('toastViewport')
      .querySelector('[data-toast-action-id="remember"]');
    assert.ok(rememberButton);
    const preSaveApprovedCalls = memoryCalls.listApproved;
    const preSavePendingCalls = memoryCalls.listPending;
    const preSaveStatusCalls = memoryCalls.status;
    rememberButton.click();
    await waitForUi(window, 40);

    assert.equal(memoryCalls.save.length, 1);
    assert.ok(memoryCalls.listApproved > preSaveApprovedCalls);
    assert.ok(memoryCalls.listPending > preSavePendingCalls);
    assert.ok(memoryCalls.status > preSaveStatusCalls);
  } finally {
    await app.dispose();
  }
});

test('renderer memory toast rejects an unavailable false-success save response', async () => {
  const candidate = {
    title: 'Preference: tea over coffee',
    lesson_text: 'The user prefers tea over coffee.',
    lesson_kind: 'preference',
    confidence: 0.95,
    source_excerpt: 'I prefer tea over coffee',
    content_fingerprint: 'preference:the-user-prefers-tea-over-coffee',
  };
  const app = await loadRendererApp({
    shell: {
      memory: {
        async suggestForSession() { return { suggestions: [candidate] }; },
        async listApproved() { return { memories: [] }; },
        async listPending() { return { candidates: [] }; },
        async save() { return { created: false, memory: null }; },
      },
    },
  });
  const { window, shell } = app;

  try {
    const input = window.document.getElementById('chatInput');
    input.value = 'Remember this';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    window.document.getElementById('sendButton').click();
    await waitForUi(window, 20);
    await shell.__emitChat({
      type: 'complete',
      sessionId: 'session-1',
      streamId: 'stream-false-save',
      content: 'Noted.',
      interactiveProtocolDrift: false,
      interactiveProtocolDriftPreview: '',
    });
    await waitForUi(window, 20);

    window.document.querySelector('[data-toast-action-id="remember"]').click();
    await waitForUi(window, 40);

    assert.match(window.document.getElementById('toastViewport').textContent, /Memory Save Failed/i);
    assert.doesNotMatch(window.document.getElementById('toastViewport').textContent, /Memory Saved/i);
  } finally {
    await app.dispose();
  }
});

test('renderer dismiss action tracks fingerprint and calls memory.dismiss', async () => {
  const memoryCalls = { suggest: [], dismiss: [] };
  const candidate = {
    title: 'Preference: dark mode',
    lesson_text: 'The user prefers dark mode.',
    lesson_kind: 'preference',
    confidence: 0.95,
    source_excerpt: 'I prefer dark mode',
    content_fingerprint: 'preference:the-user-prefers-dark-mode',
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
    const input = window.document.getElementById('chatInput');
    input.value = 'I prefer dark mode';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    window.document.getElementById('sendButton').click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'complete',
      sessionId: 'session-1',
      streamId: 'stream-dismiss-1',
      content: 'Noted.',
      interactiveProtocolDrift: false,
      interactiveProtocolDriftPreview: '',
    });
    await waitForUi(window, 20);

    const dismissButton = window.document
      .getElementById('toastViewport')
      .querySelector('[data-toast-action-id="dismiss"]');
    assert.ok(dismissButton);
    dismissButton.click();
    await waitForUi(window, 20);

    assert.ok(memoryCalls.dismiss.length >= 1);
    assert.equal(memoryCalls.dismiss[0], candidate.content_fingerprint);
  } finally {
    await app.dispose();
  }
});

test('renderer auth reset clears dismissed memory state so the suggestion can reappear', async () => {
  const memoryCalls = { suggest: [], dismiss: [] };
  const candidate = {
    title: 'Preference: dark mode',
    lesson_text: 'The user prefers dark mode.',
    lesson_kind: 'preference',
    confidence: 0.95,
    source_excerpt: 'I prefer dark mode',
    content_fingerprint: 'preference:the-user-prefers-dark-mode',
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
    const input = window.document.getElementById('chatInput');
    input.value = 'Remember my theme';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    window.document.getElementById('sendButton').click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'complete',
      sessionId: 'session-1',
      streamId: 'stream-memory-reset-1',
      content: 'Noted.',
      interactiveProtocolDrift: false,
      interactiveProtocolDriftPreview: '',
    });
    await waitForUi(window, 20);

    const dismissButton = window.document
      .getElementById('toastViewport')
      .querySelector('[data-toast-action-id="dismiss"]');
    assert.ok(dismissButton);
    dismissButton.click();
    await waitForUi(window, 20);

    await shell.__emitAuthState({ authenticated: false, user: null });
    await waitForUi(window, 30);

    shell.__state.sessions = [{
      id: 'session-1',
      title: 'Memory Reset Session',
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

    await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
    await waitForUi(window, 40);

    await shell.__emitChat({
      type: 'complete',
      sessionId: 'session-1',
      streamId: 'stream-memory-reset-2',
      content: 'Still noted.',
      interactiveProtocolDrift: false,
      interactiveProtocolDriftPreview: '',
    });
    await waitForUi(window, 20);

    const reappearedDismissButton = window.document
      .getElementById('toastViewport')
      .querySelector('[data-toast-action-id="dismiss"]');
    assert.ok(reappearedDismissButton);
    assert.equal(memoryCalls.suggest.length, 2);
    assert.deepEqual(memoryCalls.dismiss, [candidate.content_fingerprint]);
  } finally {
    await app.dispose();
  }
});
