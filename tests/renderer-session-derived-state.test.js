const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveCanonicalSessionDisplayState,
} = require('../renderer/shell/renderer-shell-runtime-utils');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

function buildPersistedSession() {
  return {
    id: 'session-derived',
    title: 'Recovered chat',
    conversation_mode: 'chat',
    preferred_model: 'preferred-old',
    last_model_used: 'actual-new',
    reasoning_effort: 'default',
    context_preferences: {
      history_scope: 'session',
      include_personality: true,
      include_memory: true,
    },
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    linked_session_ids: [],
    message_count: 99,
    last_message_preview: 'abcdefgh',
    updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    pinned: false,
    archived_at: null,
  };
}

const persistedMessages = [
  { id: 'user_1', role: 'user', content: 'abcd' },
  { id: 'assistant_1', role: 'assistant', content: 'abcdefgh', status: 'complete' },
];

test('canonical session display prefers actual model and hydrated transcript facts', () => {
  const session = buildPersistedSession();
  const state = {
    currentSessionId: session.id,
    sessions: [session],
    messagesBySession: new Map([[session.id, persistedMessages]]),
    ui: { contextOverheadTokens: 2 },
    status: { effective_context_length: 1000 },
  };

  const display = deriveCanonicalSessionDisplayState(state, session.id, {
    estimateTokens: (messages) => Math.ceil(
      messages.reduce((total, message) => total + String(message.content || '').length, 0) / 4
    ),
  });

  assert.equal(display.model, 'actual-new');
  assert.equal(display.modelSource, 'last_used');
  assert.equal(display.messageCount, 2);
  assert.equal(display.messageCountSource, 'messages');
  assert.equal(display.usedTokens, 5);
  assert.equal(display.contextLimit, 1000);

  const inactiveCached = deriveCanonicalSessionDisplayState({
    ...state,
    currentSessionId: 'another-session',
  }, session.id, { estimateTokens: () => 1 });
  assert.equal(inactiveCached.messageCount, 99);
  assert.equal(inactiveCached.messageCountSource, 'summary');

  const uncached = deriveCanonicalSessionDisplayState({
    sessions: [{ ...session, last_model_used: '', message_count: 7 }],
    messagesBySession: new Map(),
  }, session.id);
  assert.equal(uncached.model, 'preferred-old');
  assert.equal(uncached.modelSource, 'preferred');
  assert.equal(uncached.messageCount, 7);
  assert.equal(uncached.messageCountSource, 'summary');

  const malformed = deriveCanonicalSessionDisplayState({
    sessions: [{ ...session, message_count: 'not-a-number' }],
    messagesBySession: new Map(),
    status: { effective_context_length: -1 },
  }, session.id);
  assert.equal(malformed.messageCount, 0);
  assert.equal(malformed.contextLimit, 0);
});

test('rehydrated session facts agree across pulse, sidebar, and chats strip', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => app.dispose());
  const { window, shell } = app;
  const session = buildPersistedSession();
  shell.__state.sessions = [session];
  shell.__state.messagesBySession.set(session.id, persistedMessages);
  window.__rendererState.ui.contextOverheadTokens = 2;

  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 80);

  assert.equal(window.__rendererState.currentSessionId, session.id);
  assert.deepEqual(
    window.__rendererState.messagesBySession.get(session.id).map((message) => message.id),
    ['user_1', 'assistant_1'],
    'rehydration restores the canonical deduplicated transcript'
  );
  const pulseText = window.document.getElementById('contextPulse').textContent.replace(/\s+/g, ' ');
  assert.match(pulseText, /Model\s*actual-new/);
  const contextLimitLabel = Number(
    window.__rendererState.status.effective_context_length
  ).toLocaleString();
  assert.match(pulseText, new RegExp(`Tokens\\s*5 / ${contextLimitLabel}`));
  assert.match(pulseText, /Messages\s*2/);

  const sidebarTitle = window.document.querySelector(
    `.conversation-item[data-session-id="${session.id}"] [data-session-open]`
  );
  assert.match(sidebarTitle.getAttribute('title'), /Model: actual-new/);

  window.document.getElementById('chatTopRailTab').click();
  await waitForUi(window, 30);
  window.document.getElementById('chatsPanelCollapseToggle').click();
  await waitForUi(window, 50);
  const chip = window.document.querySelector(`[data-strip-session-id="${session.id}"]`);
  assert.ok(chip);
  chip.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await waitForUi(window, 20);
  const peekMeta = window.document.getElementById('chatsStripPeekMeta').textContent;
  assert.match(peekMeta, /actual-new/);
  assert.match(peekMeta, /2 messages/);
});
