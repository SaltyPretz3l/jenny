const test = require('node:test');
const assert = require('node:assert/strict');
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

async function seedSessions(window, shell, sessions) {
  shell.__state.sessions = sessions;
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);
}

function rerenderSessions(window) {
  const searchInput = window.document.getElementById('conversationSearch');
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
}

test('compact rows: one-line title with bounded accessible controls and tooltip meta', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-compact', 'Compact Row Plan', '2026-06-12T08:00:00.000Z'),
  ]);

  const row = doc.querySelector('.conversation-item[data-session-id="session-compact"]');
  assert.ok(row, 'row renders with the legacy contract class');
  assert.equal(row.classList.contains('session-row'), true, 'row carries the redesign class');
  assert.equal(row.querySelector('.conversation-preview'), null, '2-line preview is gone');
  assert.equal(row.querySelector('.model-badge'), null, 'model chip is gone from the row');

  const title = row.querySelector('.conversation-title');
  const openButton = row.querySelector('[data-session-open]');
  assert.ok(title, 'badge-pass contract element .conversation-title survives');
  assert.ok(openButton, 'the row exposes a dedicated open-session button');
  assert.equal(title.classList.contains('session-row__title'), true);
  assert.equal(title.textContent.trim(), 'Compact Row Plan');
  assert.match(openButton.getAttribute('title'), /Compact Row Plan preview/, 'preview moves to the tooltip');
  assert.match(openButton.getAttribute('title'), /Model: gpt-test/, 'model moves to the tooltip');
  assert.match(openButton.getAttribute('aria-label'), /Open session Compact Row Plan/);

  const stateDot = row.querySelector('.session-row__dot');
  assert.ok(stateDot, 'the exceptional-state indicator hook remains available');
  assert.equal(stateDot.getAttribute('aria-hidden'), 'true', 'the visual indicator never duplicates the bounded status label');
  assert.equal(row.querySelector('.conversation-monogram'), null, 'expanded rows do not duplicate collapsed-strip monograms');
  assert.equal(row.getAttribute('role'), null, 'the li keeps native list semantics');
});

test('compact rows: relative time renders and the actions menu hook survives', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await seedSessions(window, shell, [
    buildSidebarSession('session-time', 'Timekeeper', twoHoursAgo),
  ]);

  const row = doc.querySelector('[data-session-id="session-time"]');
  const time = row.querySelector('.session-row__time');
  assert.ok(time, 'relative time element renders');
  assert.equal(time.textContent.trim(), '2h');
  assert.equal(time.getAttribute('datetime'), twoHoursAgo);

  const actions = [...row.querySelectorAll('[data-session-action]')];
  assert.deepEqual(
    actions.map((button) => button.dataset.sessionAction),
    ['menu'],
    'the single ⋯ overflow button carries the delegated action hook'
  );
  assert.equal(actions[0].getAttribute('aria-haspopup'), 'menu');
});

test('pin/archive changes update a keyed row without replacing its element', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-pin', 'Pin Target', '2026-06-12T08:00:00.000Z'),
  ]);

  let row = doc.querySelector('[data-session-id="session-pin"]');
  const originalRow = row;
  assert.equal(row.dataset.sessionPinned, 'false');

  const state = window.__rendererState;
  state.sessions.find((session) => session.id === 'session-pin').pinned = true;
  rerenderSessions(window);
  await waitForUi(window, 20);

  row = doc.querySelector('[data-session-id="session-pin"]');
  assert.equal(row, originalRow, 'keyed reconciliation preserves the row element');
  assert.equal(row.dataset.sessionPinned, 'true', 'pinned changes update row content');
});

test('plugin sessions render their bounded icon token and repaint on binding change', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-img', 'Sunset Study', '2026-06-12T08:00:00.000Z', {
      session_type: 'plugin',
      plugin_session: { provider_name: 'Local Image Generation', icon_token: 'image' },
    }),
    buildSidebarSession('session-chat', 'Plain Chat', '2026-06-12T07:00:00.000Z'),
  ]);

  const imageRow = doc.querySelector('[data-session-id="session-img"]');
  assert.equal(window.__rendererState.sessions.find((session) => session.id === 'session-img')
    ?.plugin_session?.provider_name, 'Local Image Generation');
  assert.ok(imageRow, 'plugin session row renders');
  assert.ok(
    imageRow.querySelector('.session-row__type-icon svg'),
    'expanded title carries the photo glyph'
  );
  assert.match(imageRow.querySelector('[data-session-open]').getAttribute('aria-label') || '', /local image generation session/i);

  const chatRow = doc.querySelector('[data-session-id="session-chat"]');
  assert.equal(chatRow.querySelector('.session-row__type-icon'), null);
  assert.doesNotMatch(chatRow.querySelector('[data-session-open]').getAttribute('aria-label') || '', /local image generation session/i);

  // Type and provider binding changes must defeat the signature memo.
  const state = window.__rendererState;
  Object.assign(state.sessions.find((session) => session.id === 'session-chat'), {
    session_type: 'plugin',
    plugin_session: { provider_name: 'Local Image Generation', icon_token: 'image' },
  });
  rerenderSessions(window);
  await waitForUi(window, 20);
  assert.ok(
    doc.querySelector('[data-session-id="session-chat"] .session-row__type-icon svg'),
    'plugin binding changes repaint the keyed row'
  );
});

test('runtime state remains accessible without injecting visible state badges', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-badge', 'Badge Carrier', '2026-06-12T08:00:00.000Z'),
  ]);

  const state = window.__rendererState;
  state.workspace = state.workspace || {};
  state.workspace.openSessionIds = ['session-badge'];
  rerenderSessions(window);
  await waitForUi(window, 20);

  const row = doc.querySelector('[data-session-id="session-badge"]');
  assert.equal(row.dataset.sessionDominantState, 'open', 'runtime patching stamps the dominant state');
  assert.equal(row.querySelector('.conversation-state-badge'), null, 'open state does not add visible badge clutter');
  assert.match(
    row.querySelector('[data-session-open]').getAttribute('aria-label'),
    /Status: Open/,
    'open state remains available to assistive technology'
  );
});

test('compact rows badge queued and failed background sends per session', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-outbox', 'Background Work', '2026-06-12T08:00:00.000Z'),
  ]);

  const state = window.__rendererState;
  state.sendOutboxBySession.set('session-outbox', [
    { id: 'queued-1', revision: 1, status: 'failed' },
    { id: 'queued-2', revision: 2, status: 'ready' },
  ]);
  rerenderSessions(window);
  await waitForUi(window, 20);

  const badge = doc.querySelector('[data-session-id="session-outbox"] .send-outbox-badge');
  assert.ok(badge);
  assert.equal(badge.textContent, '1 failed');
  assert.equal(badge.classList.contains('send-outbox-badge--failed'), true);
});
