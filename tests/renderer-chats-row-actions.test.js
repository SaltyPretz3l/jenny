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

async function openRowMenu(window, sessionId) {
  const menuButton = window.document.querySelector(
    `[data-session-action="menu"][data-session-id="${sessionId}"]`
  );
  assert.ok(menuButton, `expected the ⋯ menu button for ${sessionId}`);
  menuButton.click();
  await waitForUi(window, 10);
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

function spyOnSessionDelete(t, window) {
  const deleteCalls = [];
  const originalDelete = window.jennyShell.sessions.delete;
  window.jennyShell.sessions.delete = async (...args) => {
    deleteCalls.push(String(args[0] || ''));
    return originalDelete(...args);
  };
  t.after(() => {
    window.jennyShell.sessions.delete = originalDelete;
  });
  return deleteCalls;
}

test('the ⋯ button and right-click both open the row menu with the W7 anatomy', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-menu', 'Menu Anatomy', '2026-06-12T08:00:00.000Z'),
  ]);

  await openRowMenu(window, 'session-menu');
  // The leading "Open in New Tab" item is the per-click override of the
  // open-sessions-in-new-tab preference (renderer-session-actions.js), shown
  // whenever the workspace-open path is wired -- which it is in the full shell.
  assert.deepEqual(
    getMenuItems(window).map((button) => button.textContent.trim()),
    ['Open in New Tab', 'Pin', 'Rename', 'Archive', 'Delete'],
    'menu leads with the open-mode override, then Pin / Rename / Archive / Delete'
  );
  assert.ok(
    doc.querySelector('.inv-context-menu .inv-context-menu-separator'),
    'archive and delete are separated'
  );

  // Outside mousedown dismisses.
  doc.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await waitForUi(window, 10);
  assert.equal(doc.querySelector('.inv-context-menu'), null, 'menu dismisses on outside click');
  assert.equal(doc.activeElement.dataset.sessionAction, 'menu', 'dismissal restores focus to the overflow trigger');

  const row = doc.querySelector('[data-session-id="session-menu"]');
  row.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 48,
    clientY: 96,
  }));
  await waitForUi(window, 10);
  assert.ok(doc.querySelector('.inv-context-menu'), 'right-click opens the same menu');
});

test('roving focus supports Arrow/Home/End and Shift+F10 restores the originating session button', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-a', 'Alpha', '2026-06-12T09:00:00.000Z'),
    buildSidebarSession('session-b', 'Beta', '2026-06-12T08:00:00.000Z'),
    buildSidebarSession('session-c', 'Gamma', '2026-06-12T07:00:00.000Z'),
  ]);

  const openButtons = [...doc.querySelectorAll('[data-session-open]')];
  const menuButtons = [...doc.querySelectorAll('[data-session-action="menu"]')];
  assert.equal(openButtons.filter((button) => button.tabIndex === 0).length, 1);
  assert.equal(menuButtons.filter((button) => button.tabIndex === 0).length, 1);
  assert.equal(openButtons[0].getAttribute('aria-current'), 'page');

  openButtons[0].focus();
  openButtons[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement, openButtons[1]);
  assert.equal(openButtons[1].tabIndex, 0);
  assert.equal(openButtons[0].tabIndex, -1);

  openButtons[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement, openButtons[2]);
  openButtons[2].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement, openButtons[0]);

  openButtons[0].dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'F10', shiftKey: true, bubbles: true, cancelable: true,
  }));
  await waitForUi(window, 10);
  assert.ok(doc.querySelector('.inv-context-menu'));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await waitForUi(window, 10);
  assert.equal(doc.querySelector('.inv-context-menu'), null);
  assert.equal(doc.activeElement, openButtons[0]);
});

test('pin and archive round-trip through sessions.setMeta and restamp the row', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-meta', 'Meta Target', '2026-06-12T08:00:00.000Z'),
  ]);

  await openRowMenu(window, 'session-meta');
  await clickMenuItem(window, 'Pin');
  assert.equal(shell.__state.setMetaCalls.length, 1);
  assert.equal(shell.__state.setMetaCalls[0].sessionId, 'session-meta');
  // Spread before comparing: the meta object crosses the jsdom realm boundary.
  assert.deepEqual({ ...shell.__state.setMetaCalls[0].meta }, { pinned: true });
  let row = doc.querySelector('[data-session-id="session-meta"]');
  assert.equal(row.dataset.sessionPinned, 'true');
  assert.ok(row.querySelector('.session-row__pin'), 'pinned rows render the pin glyph');

  await openRowMenu(window, 'session-meta');
  const pinnedMenuLabels = getMenuItems(window).map((button) => button.textContent.trim());
  assert.ok(
    pinnedMenuLabels.includes('Unpin') && !pinnedMenuLabels.includes('Pin'),
    'menu reflects the pinned state'
  );
  await clickMenuItem(window, 'Archive');
  const archiveCall = shell.__state.setMetaCalls.at(-1);
  assert.equal(archiveCall.sessionId, 'session-meta');
  assert.match(String(archiveCall.meta.archived_at), /^\d{4}-\d{2}-\d{2}T/, 'archive stamps an ISO timestamp');
  // Archived sessions leave Recent and remain available through the scope control.
  assert.equal(doc.querySelector('[data-session-id="session-meta"]'), null, 'archived row leaves the default view');
  const archivedOption = doc.querySelector('[data-inv-segmented="chats-scope"] [data-value="archived"]');
  assert.equal(archivedOption.textContent.trim(), 'Archived 1');
  archivedOption.click();
  await waitForUi(window, 20);
  row = doc.querySelector('[data-session-id="session-meta"]');
  assert.ok(row, 'the archived view lists the archived session');
  assert.equal(row.dataset.sessionArchived, 'true');

  await openRowMenu(window, 'session-meta');
  await clickMenuItem(window, 'Unarchive');
  assert.equal(shell.__state.setMetaCalls.at(-1).meta.archived_at, null);
  assert.equal(
    doc.querySelector('[data-session-id="session-meta"]'),
    null,
    'the unarchived row leaves the archived view'
  );
});

test('inline rename commits through sessions.rename and Escape discards', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('session-rename', 'Old Title', '2026-06-12T08:00:00.000Z'),
  ]);

  await openRowMenu(window, 'session-rename');
  await clickMenuItem(window, 'Rename');
  let input = doc.querySelector('.inv-inline-title-editor');
  assert.ok(input, 'inline editor mounts in the row');
  assert.equal(input.value, 'Old Title');

  input.value = 'Shiny New Title';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitForUi(window, 60);

  assert.deepEqual(shell.__state.renameCalls, [
    { sessionId: 'session-rename', title: 'Shiny New Title' },
  ]);
  const title = doc.querySelector('[data-session-id="session-rename"] .conversation-title');
  assert.equal(title.textContent.trim(), 'Shiny New Title');

  await openRowMenu(window, 'session-rename');
  await clickMenuItem(window, 'Rename');
  input = doc.querySelector('.inv-inline-title-editor');
  input.value = 'Discarded Title';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await waitForUi(window, 30);
  assert.equal(shell.__state.renameCalls.length, 1, 'Escape does not call rename');
  assert.equal(doc.querySelector('.inv-inline-title-editor'), null, 'editor unmounts on Escape');
});

test('delete is optimistic with an undo toast; Undo restores without any delete IPC', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const deleteCalls = spyOnSessionDelete(t, window);
  await seedSessions(window, shell, [
    buildSidebarSession('session-undo', 'Undo Candidate', '2026-06-12T08:00:00.000Z'),
  ]);

  await openRowMenu(window, 'session-undo');
  await clickMenuItem(window, 'Delete');

  assert.equal(
    doc.querySelector('[data-session-id="session-undo"]'),
    null,
    'row disappears immediately (optimistic)'
  );
  assert.deepEqual(deleteCalls, [], 'delete IPC is deferred during the undo window');
  const undoButton = doc.querySelector('[data-toast-action-id="session-delete-undo"]');
  assert.ok(undoButton, 'undo toast appears');

  undoButton.click();
  await waitForUi(window, 30);
  assert.ok(
    doc.querySelector('[data-session-id="session-undo"]'),
    'undo restores the row'
  );
  assert.deepEqual(deleteCalls, [], 'undo never issues the delete IPC');
});

test('"Delete now" flushes the deferred delete through the workspace-aware path', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const deleteCalls = spyOnSessionDelete(t, window);
  await seedSessions(window, shell, [
    buildSidebarSession('session-flush', 'Flush Me', '2026-06-12T08:00:00.000Z'),
  ]);

  await openRowMenu(window, 'session-flush');
  await clickMenuItem(window, 'Delete');
  const deleteNowButton = doc.querySelector('[data-toast-action-id="session-delete-now"]');
  assert.ok(deleteNowButton, 'the undo toast offers Delete now');

  deleteNowButton.click();
  await waitForUi(window, 80);

  assert.deepEqual(deleteCalls, ['session-flush'], 'flush issues the delete IPC once');
  assert.equal(doc.querySelector('[data-session-id="session-flush"]'), null, 'row stays gone');
});

test('a pending delete is canceled when the session gains new activity', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const deleteCalls = spyOnSessionDelete(t, window);
  await seedSessions(window, shell, [
    buildSidebarSession('session-guard', 'Activity Guard', '2026-06-12T08:00:00.000Z'),
  ]);

  await openRowMenu(window, 'session-guard');
  await clickMenuItem(window, 'Delete');
  assert.equal(doc.querySelector('[data-session-id="session-guard"]'), null);

  // A stream lands while the undo toast is up: the summary mutates.
  const summary = window.__rendererState.sessions.find((session) => session.id === 'session-guard');
  summary.updated_at = '2026-06-12T09:30:00.000Z';
  summary.message_count = 5;

  doc.querySelector('[data-toast-action-id="session-delete-now"]').click();
  await waitForUi(window, 60);

  assert.deepEqual(deleteCalls, [], 'fresher data than the user saw is never deleted');
  assert.ok(
    doc.querySelector('[data-session-id="session-guard"]'),
    'the row is restored instead'
  );
});
