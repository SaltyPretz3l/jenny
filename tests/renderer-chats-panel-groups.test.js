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

function recentIso() {
  return new Date(Date.now() - 5 * 60 * 1000).toISOString();
}

function getMenuItems(window) {
  return [...window.document.querySelectorAll('.inv-context-menu-item')];
}

async function clickMenuItem(window, label) {
  const item = getMenuItems(window).find((button) => button.textContent.trim() === label);
  assert.ok(item, `expected a "${label}" menu item`);
  item.click();
  await waitForUi(window, 30);
}

async function openOverflowMenu(window) {
  const overflowButton = window.document.getElementById('chatsOverflowButton');
  assert.ok(overflowButton, 'the panel overflow button mounts in the header tools');
  overflowButton.click();
  await waitForUi(window, 10);
}

test('pinned sessions render in a leading Pinned group, not in date buckets', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-regular', 'Regular Plan', recentIso()),
    buildSidebarSession('session-pinned', 'Pinned Plan', recentIso(), { pinned: true }),
  ]);

  const groups = [...doc.querySelectorAll('.conversation-group')];
  assert.ok(groups.length >= 2, 'pinned and recent sessions land in separate groups');
  assert.equal(groups[0].querySelector('.group-label').textContent.trim(), 'Pinned');
  assert.ok(
    groups[0].querySelector('[data-session-id="session-pinned"]'),
    'the pinned row renders inside the PINNED group'
  );
  assert.equal(
    groups[0].querySelectorAll('.conversation-item[data-session-id]').length,
    1,
    'PINNED holds only the pinned row'
  );
  assert.equal(
    doc.querySelectorAll('.conversation-item[data-session-id="session-pinned"]').length,
    1,
    'the pinned row does not also render in a date bucket'
  );
  assert.ok(doc.querySelector('[data-session-id="session-regular"]'), 'the regular row still renders');
});

test('the Recent / Archived segmented control switches history scope', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-live', 'Live Chat', recentIso()),
    buildSidebarSession('session-archived', 'Archived Chat', recentIso(), {
      archived_at: '2026-06-11T00:00:00.000Z',
    }),
  ]);

  const count = doc.getElementById('conversationCount');
  assert.equal(
    doc.querySelector('[data-session-id="session-archived"]'),
    null,
    'archived rows are excluded from the default view'
  );
  assert.equal(count.textContent.trim(), '2');
  assert.equal(count.getAttribute('aria-label'), '2 total chats');
  const archivedOption = doc.querySelector('[data-inv-segmented="chats-scope"] [data-value="archived"]');
  const recentOption = doc.querySelector('[data-inv-segmented="chats-scope"] [data-value="recent"]');
  assert.ok(archivedOption, 'the Archived option is always visible');
  assert.equal(archivedOption.textContent.trim(), 'Archived 1');
  assert.equal(recentOption.getAttribute('aria-checked'), 'true');

  archivedOption.click();
  await waitForUi(window, 20);
  assert.ok(
    doc.querySelector('[data-session-id="session-archived"]'),
    'the archived view lists the archived session'
  );
  assert.equal(
    doc.querySelector('[data-session-id="session-live"]'),
    null,
    'live rows leave the archived view'
  );
  assert.equal(count.textContent.trim(), '2', 'the header total stays stable across scope changes');
  assert.equal(doc.querySelector('[data-value="archived"]').getAttribute('aria-checked'), 'true');

  doc.querySelector('[data-value="recent"]').click();
  await waitForUi(window, 20);
  assert.ok(doc.querySelector('[data-session-id="session-live"]'), 'back returns to the default list');
  assert.equal(doc.querySelector('[data-session-id="session-archived"]'), null);
  assert.equal(count.textContent.trim(), '2');
});

test('header search stays visible, filters immediately, and Escape clears it', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-alpha', 'Alpha Notes', recentIso()),
    buildSidebarSession('session-beta', 'Beta Notes', recentIso()),
  ]);

  const searchShell = doc.getElementById('conversationSearchShell');
  const searchInput = doc.getElementById('conversationSearch');
  assert.ok(searchShell, 'search shell renders');
  assert.equal(doc.getElementById('chatsSearchToggle'), null, 'the duplicate search trigger is retired');
  assert.equal(searchInput.hidden, false);

  searchInput.value = 'alpha';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);
  assert.ok(doc.querySelector('[data-session-id="session-alpha"]'), 'matching rows stay');
  assert.equal(
    doc.querySelector('[data-session-id="session-beta"]'),
    null,
    'the filter applies while the shell is open'
  );

  searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(searchInput.value, '');
  assert.ok(doc.querySelector('[data-session-id="session-alpha"]'));
  assert.ok(doc.querySelector('[data-session-id="session-beta"]'));
});

test('the panel overflow menu contains only secondary panel actions', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-overflow', 'Overflow Anchor', recentIso()),
  ]);

  await openOverflowMenu(window);
  assert.deepEqual(
    getMenuItems(window).map((button) => button.textContent.trim()),
    ['Sweep empty chats'],
    'scope switching belongs to the visible segmented control'
  );
  doc.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await waitForUi(window, 10);
  assert.equal(doc.querySelector('.inv-context-menu'), null, 'the menu dismisses on outside click');
});

test('sweep with no candidates records only the dry run and shows an info toast', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-busy', 'Busy Chat', recentIso()),
  ]);

  await openOverflowMenu(window);
  await clickMenuItem(window, 'Sweep empty chats');

  assert.equal(shell.__state.sweepCalls.length, 1, 'only the dry run hits the sweep IPC');
  // Spread before comparing: the call record crosses the jsdom realm boundary.
  assert.deepEqual({ ...shell.__state.sweepCalls[0] }, { dryRun: true, currentSessionId: 'session-busy' });
  const toast = doc.querySelector('.inv-toast');
  assert.ok(toast, 'an info toast reports the empty sweep');
  assert.match(toast.textContent, /No empty chats to sweep/);
  assert.equal(
    doc.querySelector('[data-toast-action-id="session-sweep-confirm"]'),
    null,
    'no confirm action is offered'
  );
});

test('the sweep confirm toast deletes empty New Chat sessions through the real sweep call', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  // The busy session seeds first so it becomes the current session; the empty
  // "New Chat" is the lone sweep candidate.
  await seedSessions(window, shell, [
    buildSidebarSession('session-busy', 'Busy Chat', recentIso()),
    buildSidebarSession('session-empty', 'New Chat', recentIso(), {
      message_count: 0,
      last_message_preview: '',
    }),
  ]);

  await openOverflowMenu(window);
  await clickMenuItem(window, 'Sweep empty chats');

  const confirmButton = doc.querySelector('[data-toast-action-id="session-sweep-confirm"]');
  assert.ok(confirmButton, 'the dry run surfaces a confirm toast action');
  assert.equal(confirmButton.textContent.trim(), 'Delete 1');
  assert.deepEqual(
    shell.__state.sweepCalls.map((call) => call.dryRun),
    [true],
    'nothing is deleted before the confirm click'
  );
  assert.ok(
    doc.querySelector('[data-session-id="session-empty"]'),
    'the candidate row is still listed pre-confirm'
  );

  confirmButton.click();
  await waitForUi(window, 80);

  assert.deepEqual(
    shell.__state.sweepCalls.map((call) => ({ ...call })),
    [
      { dryRun: true, currentSessionId: 'session-busy' },
      { dryRun: false, currentSessionId: 'session-busy' },
    ],
    'the confirm runs the real sweep with the same exclusions'
  );
  assert.equal(
    doc.querySelector('[data-session-id="session-empty"]'),
    null,
    'the swept session leaves the list'
  );
  assert.ok(doc.querySelector('[data-session-id="session-busy"]'), 'non-candidates survive the sweep');
});

// The overflow trigger rests at opacity 0 and only paints on sidebar hover or
// focus, so while its menu is open it needs a state the stylesheet can pin it
// visible with -- otherwise the dots fade out the moment the pointer leaves the
// sidebar for the menu they just opened.
test('the overflow trigger stays pinned visible while its menu is open', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-overflow', 'Overflow Anchor', recentIso()),
  ]);

  const overflowButton = doc.getElementById('chatsOverflowButton');
  assert.equal(
    overflowButton.hasAttribute('data-menu-open'),
    false,
    'the trigger rests without the open flag'
  );

  await openOverflowMenu(window);
  assert.equal(
    overflowButton.hasAttribute('data-menu-open'),
    true,
    'opening the menu pins the trigger visible'
  );

  doc.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await waitForUi(window, 10);
  assert.equal(
    overflowButton.hasAttribute('data-menu-open'),
    false,
    'dismissing the menu releases the trigger back to its resting state'
  );
});

// contextMenu.show() hides any open menu first, and that hide fires the
// PREVIOUS onHide. Setting the flag before show() would therefore have it
// deleted again the instant the same trigger reopened its own menu.
test('reopening the overflow menu on the same trigger keeps it pinned visible', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-overflow', 'Overflow Anchor', recentIso()),
  ]);

  const overflowButton = doc.getElementById('chatsOverflowButton');
  await openOverflowMenu(window);
  await openOverflowMenu(window);

  assert.ok(doc.querySelector('.inv-context-menu'), 'the menu is open after reopening');
  assert.equal(
    overflowButton.hasAttribute('data-menu-open'),
    true,
    'the reopen must not clear the flag through the previous menu\u2019s onHide'
  );
});
