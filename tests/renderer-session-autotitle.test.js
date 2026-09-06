const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUTOTITLE_MAX_LENGTH,
  deriveTitleFromFirstMessage,
} = require('../renderer/shell/renderer-session-autotitle');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function buildSidebarSession(id, title, updatedAt, extra = {}) {
  return {
    id,
    title,
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
    linked_session_ids: [],
    message_count: 1,
    last_message_preview: `${title} preview`,
    updated_at: updatedAt,
    created_at: updatedAt,
    pinned: false,
    archived_at: null,
    ...extra,
  };
}

function buildUserMessage(content) {
  return {
    id: `msg_${Math.random().toString(16).slice(2, 10)}`,
    role: 'user',
    kind: 'user',
    content,
    timestamp: '2026-06-01T09:00:00.000Z',
    status: 'complete',
  };
}

async function seedSessions(window, shell, sessions) {
  shell.__state.sessions = sessions;
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);
}

function recentIso() {
  return new Date(Date.now() - 5 * 60 * 1000).toISOString();
}

function getTitleSetMetaCalls(shell) {
  return shell.__state.setMetaCalls
    .map((call) => ({ sessionId: call.sessionId, meta: { ...call.meta } }))
    .filter((call) => Object.prototype.hasOwnProperty.call(call.meta, 'title'));
}

test('deriveTitleFromFirstMessage collapses whitespace and strips slash-commands', () => {
  assert.equal(deriveTitleFromFirstMessage('  Fix \n the   bug  '), 'Fix the bug');
  assert.equal(deriveTitleFromFirstMessage('/context the login flow'), 'the login flow');
  assert.equal(
    deriveTitleFromFirstMessage('/plugin-skills:pdf merge these reports'),
    'merge these reports'
  );
  // A message that was only a slash-command still beats "New Chat".
  assert.equal(deriveTitleFromFirstMessage('/review'), '/review');
  assert.equal(deriveTitleFromFirstMessage(''), '');
  assert.equal(deriveTitleFromFirstMessage('   '), '');
});

test('deriveTitleFromFirstMessage clips at a word boundary near the 48-char budget', () => {
  const sentence = 'Refactor the renderer stream handler to support resumable sessions';
  assert.equal(
    deriveTitleFromFirstMessage(sentence),
    'Refactor the renderer stream handler to support...'
  );
  assert.ok(deriveTitleFromFirstMessage(sentence).length <= AUTOTITLE_MAX_LENGTH + 3);

  // One giant token has no boundary to respect: hard clip, never empty.
  assert.equal(deriveTitleFromFirstMessage('x'.repeat(60)), `${'x'.repeat(48)}...`);

  // Short prompts pass through untouched.
  assert.equal(deriveTitleFromFirstMessage('Quick question'), 'Quick question');
});

test('opening an untitled session backfills its title from the first user message', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  shell.__state.messagesBySession.set('session-legacy', [
    buildUserMessage('Fix the flaky sidebar resize test on Windows runners'),
    buildUserMessage('Any progress?'),
  ]);
  await seedSessions(window, shell, [
    buildSidebarSession('session-current', 'Already Titled', recentIso()),
    buildSidebarSession('session-legacy', 'New Chat', recentIso(), { message_count: 2 }),
  ]);

  const updatedAtBefore = shell.__state.sessions.find((s) => s.id === 'session-legacy').updated_at;
  doc.querySelector('[data-session-open="session-legacy"]').click();
  await waitForUi(window, 60);

  assert.deepEqual(getTitleSetMetaCalls(shell), [
    { sessionId: 'session-legacy', meta: { title: 'Fix the flaky sidebar resize test on Windows...' } },
  ], 'backfill persists through the non-bumping setMeta path');
  const row = doc.querySelector('.conversation-item[data-session-id="session-legacy"]');
  assert.match(
    row.querySelector('.conversation-title').textContent,
    /Fix the flaky sidebar resize test on Windows/,
    'the row reflects the backfilled title'
  );
  assert.equal(
    shell.__state.sessions.find((s) => s.id === 'session-legacy').updated_at,
    updatedAtBefore,
    'backfill must not bump updated_at (no re-sort on open)'
  );
});

test('opening a titled session never rewrites its title', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  shell.__state.messagesBySession.set('session-named', [
    buildUserMessage('This prompt must not become the title'),
  ]);
  await seedSessions(window, shell, [
    buildSidebarSession('session-current', 'Already Titled', recentIso()),
    buildSidebarSession('session-named', 'Deliberate Name', recentIso(), { message_count: 1 }),
  ]);

  doc.querySelector('[data-session-open="session-named"]').click();
  await waitForUi(window, 60);

  assert.deepEqual(getTitleSetMetaCalls(shell), [], 'no title write for a titled session');
  // The open-state badge rides inside .conversation-title, so assert on the
  // summary rather than concatenated DOM text.
  assert.equal(
    window.__rendererState.sessions.find((s) => s.id === 'session-named').title,
    'Deliberate Name'
  );
});

test('the first send into an untitled session titles it immediately from the prompt', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-fresh', 'New Chat', recentIso(), {
      message_count: 0,
      last_message_preview: '',
    }),
  ]);

  doc.getElementById('chatInput').value = 'Fix the resize bug in the sidebar panel please';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 80);

  assert.deepEqual(getTitleSetMetaCalls(shell), [
    { sessionId: 'session-fresh', meta: { title: 'Fix the resize bug in the sidebar panel please' } },
  ], 'the send hook persists the derived title before the stream settles');
  const row = doc.querySelector('.conversation-item[data-session-id="session-fresh"]');
  assert.match(
    row.querySelector('.conversation-title').textContent,
    /Fix the resize bug in the sidebar panel please/
  );
});

test('a backend without the meta surface leaves the default title alone', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  shell.__state.messagesBySession.set('session-legacy-api', [
    buildUserMessage('Backfill candidate prompt'),
  ]);
  await seedSessions(window, shell, [
    buildSidebarSession('session-current', 'Already Titled', recentIso()),
    buildSidebarSession('session-legacy-api', 'New Chat', recentIso(), { message_count: 1 }),
  ]);
  // Legacy API mode: sessions.setMeta resolves null (no managed store).
  const originalSetMeta = window.jennyShell.sessions.setMeta;
  window.jennyShell.sessions.setMeta = async () => null;
  t.after(() => {
    window.jennyShell.sessions.setMeta = originalSetMeta;
  });

  doc.querySelector('[data-session-open="session-legacy-api"]').click();
  await waitForUi(window, 60);

  assert.equal(
    window.__rendererState.sessions.find((s) => s.id === 'session-legacy-api').title,
    'New Chat',
    'a null meta result skips the rename'
  );
  assert.match(
    doc.querySelector('.conversation-item[data-session-id="session-legacy-api"] .conversation-title').textContent,
    /New Chat/
  );
});
