'use strict';

/**
 * tests/renderer-session-lockdown-ui.test.js -- WO-12c
 *
 * The UI for WO-12b's per-session offline lockdown gate: the session-row
 * context-menu toggle (renderer/shell/renderer-session-actions.js), the
 * persistent header + sidebar badges (renderer-header-utils.js /
 * renderer-chats-panel.js), the composer tool-toggle lock
 * (renderer-composer-v2-toggle.js), and the `lockdown_remote_engine` send
 * refusal card (renderer-error-recovery-utils.js /
 * renderer-shell-runtime-utils.js). Flag: session_offline_lockdown.
 * Preference key: lockdown. Refusal code: lockdown_remote_engine.
 *
 * Groups 1/2/4/5/6 drive the real app through the jsdom harness
 * (tests/helpers/renderer-shell-harness.js, built on the SCRIPT_ORDER
 * extraction in tests/helpers/renderer-shell-harness-support.js) so the
 * assertions exercise the actual wiring, not a stub of it. Group 3 also adds
 * a direct-module check of the composer toggle markup, mirroring the
 * existing renderer-composer-v2-toggle.test.js style, because that is the
 * more precise gate for the exact disabled+tooltip contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const ToggleSwitch = require('../renderer/inventory/toggle-switch');
const Chip = require('../renderer/inventory/chip');
const Popover = require('../renderer/inventory/popover');
const { createComposerV2ToggleController } = require('../renderer/chat/renderer-composer-v2-toggle');
const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');
const { createSessionActionsController } = require('../renderer/shell/renderer-session-actions');
const errorRecoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');

// Shell stub options nest under `shell` (tests/helpers/renderer-shell-harness-dom.js
// calls createShellStub(settings.shell)) -- top-level keys are silently ignored.
const LOCKDOWN_FLAG_ON = { shell: { features: { state: { featureFlags: { session_offline_lockdown: true } } } } };

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

async function collapseChatPanel(window) {
  window.document.getElementById('chatTopRailTab').click();
  await waitForUi(window, 40);
  window.document.getElementById('chatsPanelCollapseToggle').click();
  await waitForUi(window, 40);
}

function getMenuItems(window) {
  return [...window.document.querySelectorAll('.inv-context-menu-item')];
}

// The context-menu primitive appends a second <span class="inv-context-menu-shortcut">
// for shortcutHint (renderer/inventory/context-menu.js:92-96), so the "Offline
// lockdown" item's textContent also carries "On"/"Off" -- match the label span alone.
function menuItemLabel(button) {
  const labelSpan = [...button.querySelectorAll('span')].find(
    (span) => !span.classList.contains('inv-context-menu-shortcut')
  );
  return (labelSpan?.textContent || '').trim();
}

async function clickMenuItemByLabel(window, label) {
  const item = getMenuItems(window).find((button) => menuItemLabel(button) === label);
  assert.ok(item, `expected a "${label}" menu item`);
  item.click();
  await waitForUi(window, 30);
}

/* The harness's sessions.setPreferences stub (tests/helpers/renderer-shell-harness.js)
 * echoes back the mutated session record but does not model the `lockdown` field
 * (it predates WO-12b/12c), so it never reflects a written `lockdown` value in its
 * return. renderer-session-actions.js's toggleOfflineLockdown() and
 * renderer-shell-runtime-utils.js's lockdown_off recovery action both require the
 * acknowledgement to echo `lockdown` back correctly before they accept it. Rather
 * than editing the shared harness (out of this work order's fence), teach THIS
 * test's wrapper the one missing field while preserving the real stub's session
 * lookup and acknowledgement contract. */
function withLockdownAck(t, window, shell) {
  const original = window.jennyShell.sessions.setPreferences;
  window.jennyShell.sessions.setPreferences = async (sessionId, preferences) => {
    const result = await original(sessionId, preferences);
    if (preferences && Object.prototype.hasOwnProperty.call(preferences, 'lockdown')) {
      const normalizedSessionId = String(sessionId || '').trim();
      const session = shell.__state.sessions.find(
        (candidate) => String(candidate?.id || '').trim() === normalizedSessionId
      );
      if (!session || String(result?.id || '').trim() !== normalizedSessionId) {
        throw new Error('Harness setPreferences did not resolve the requested session.');
      }
      session.lockdown = preferences.lockdown === true;
      return { ...result, lockdown: session.lockdown };
    }
    return result;
  };
  t.after(() => {
    window.jennyShell.sessions.setPreferences = original;
  });
}

/* ── Group 1: the toggle writes lockdown for the target session only ── */

test('offline lockdown toggle writes lockdown for the clicked session only, and flips back off', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, LOCKDOWN_FLAG_ON);
  withLockdownAck(t, window, shell);
  await seedSessions(window, shell, [
    buildSidebarSession('session-a', 'Session A', '2026-09-04T12:00:00.000Z'),
    buildSidebarSession('session-b', 'Session B', '2026-09-04T11:00:00.000Z'),
  ]);

  await openRowMenu(window, 'session-a');
  await clickMenuItemByLabel(window, 'Offline lockdown');

  const onCall = shell.__state.setPreferenceCalls.at(-1);
  assert.equal(onCall.sessionId, 'session-a');
  assert.equal(onCall.preferences.lockdown, true);
  assert.equal(
    window.__rendererState.sessions.find((s) => s.id === 'session-a').lockdown,
    true
  );
  assert.equal(
    window.__rendererState.sessions.find((s) => s.id === 'session-b').lockdown,
    undefined,
    "session-b's preferences are untouched by session-a's toggle"
  );
  assert.equal(
    shell.__state.setPreferenceCalls.some((call) => call.sessionId === 'session-b'),
    false
  );

  await openRowMenu(window, 'session-a');
  await clickMenuItemByLabel(window, 'Offline lockdown');
  const offCall = shell.__state.setPreferenceCalls.at(-1);
  assert.equal(offCall.sessionId, 'session-a');
  assert.equal(offCall.preferences.lockdown, false);
  assert.equal(
    window.__rendererState.sessions.find((s) => s.id === 'session-a').lockdown,
    false
  );
});

test('locking a streaming session cancels its active turn before persisting lockdown', async () => {
  const events = [];
  const toasts = [];
  const state = {
    features: { featureFlags: { session_offline_lockdown: true } },
    sessions: [{ id: 'session-streaming', lockdown: false }],
    ui: {},
  };
  const controller = createSessionActionsController({
    state,
    windowRef: {
      rendererMultiStreamController: {
        getActiveStreamIdForCancel: (sessionId) => sessionId === 'session-streaming' ? 'stream-live' : '',
      },
      jennyShell: {
        chat: { cancelStream: async (streamId) => { events.push(`cancel:${streamId}`); } },
        sessions: {
          setPreferences: async (sessionId, preferences) => {
            events.push(`preferences:${sessionId}:${preferences.lockdown}`);
            return { id: sessionId, lockdown: preferences.lockdown };
          },
        },
      },
    },
    constants: { TOAST_SOURCE: {} },
    modules: { destructiveUndoUtils: { createDestructiveUndoScheduler: () => ({}) } },
    callbacks: {
      renderAll() {},
      showToastMessage: (message) => toasts.push(message),
      appendClientLog() {},
      registerCleanup() {},
    },
  });

  assert.equal(await controller.toggleOfflineLockdown('session-streaming'), true);
  assert.deepEqual(events, ['cancel:stream-live', 'preferences:session-streaming:true']);
  assert.deepEqual(toasts, ['Turn stopped: session locked.']);
});

function buildLockToggleHarness({ stopSessionStream }) {
  const events = [];
  const toasts = [];
  const controller = createSessionActionsController({
    state: {
      features: { featureFlags: { session_offline_lockdown: true } },
      sessions: [{ id: 'session-streaming', lockdown: false }],
      ui: {},
    },
    windowRef: {
      rendererMultiStreamController: {
        getActiveStreamIdForCancel: (sessionId) => sessionId === 'session-streaming' ? 'stream-live' : '',
      },
      jennyShell: {
        chat: { cancelStream: async (streamId) => { events.push(`raw-cancel:${streamId}`); } },
        sessions: {
          setPreferences: async (sessionId, preferences) => {
            events.push(`preferences:${sessionId}:${preferences.lockdown}`);
            return { id: sessionId, lockdown: preferences.lockdown };
          },
        },
      },
    },
    constants: { TOAST_SOURCE: {} },
    modules: { destructiveUndoUtils: { createDestructiveUndoScheduler: () => ({}) } },
    callbacks: {
      renderAll() {},
      showToastMessage: (message) => toasts.push(message),
      appendClientLog() {},
      registerCleanup() {},
      stopSessionStream: async (sessionId) => { events.push(`stop:${sessionId}`); return stopSessionStream(sessionId); },
    },
  });
  return { controller, events, toasts };
}

test('locking a streaming session stops it through the shared Stop path, never a raw cancel that skips the outbox hold', async () => {
  const { controller, events, toasts } = buildLockToggleHarness({
    stopSessionStream: async (sessionId) => ({ streamId: 'stream-live', sessionId }),
  });

  assert.equal(await controller.toggleOfflineLockdown('session-streaming'), true);
  assert.deepEqual(events, ['stop:session-streaming', 'preferences:session-streaming:true']);
  assert.deepEqual(toasts, ['Turn stopped: session locked.']);
});

test('a refused stop (stream already finished) still persists lockdown but does not claim the turn stopped', async () => {
  const { controller, events, toasts } = buildLockToggleHarness({ stopSessionStream: async () => null });

  assert.equal(await controller.toggleOfflineLockdown('session-streaming'), true);
  assert.deepEqual(events, ['stop:session-streaming', 'preferences:session-streaming:true']);
  assert.deepEqual(toasts, []);
});

/* ── Group 2: badge visibility + session-switch + aria-live ── */

test('lockdown badge follows active-session switches and backend summary refreshes without repeated announcements', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, LOCKDOWN_FLAG_ON);
  await seedSessions(window, shell, [
    buildSidebarSession('session-locked', 'Locked', '2026-09-04T12:00:00.000Z', { lockdown: true }),
    buildSidebarSession('session-open', 'Open', '2026-09-04T11:00:00.000Z', { lockdown: false }),
  ]);

  // The most recently updated session becomes current on seed (established
  // convention -- see tests/renderer-chats-row-actions.test.js).
  assert.equal(window.__rendererState.currentSessionId, 'session-locked');

  const headerBadge = window.document.querySelector(
    '.session-lockdown-header .session-offline-lockdown-badge'
  );
  assert.ok(headerBadge, 'header badge element exists');
  assert.equal(headerBadge.hidden, false, 'header badge visible for the locked active session');

  const announcer = window.document.querySelector('.session-lockdown-announcer');
  assert.ok(announcer, 'aria-live announcer exists');
  assert.match(announcer.textContent, /on for this session/i);

  let announcementMutations = 0;
  const announcementObserver = new window.MutationObserver((records) => {
    announcementMutations += records.length;
  });
  announcementObserver.observe(announcer, { childList: true, characterData: true, subtree: true });
  t.after(() => announcementObserver.disconnect());

  const lockedRow = window.document.querySelector('[data-session-id="session-locked"]');
  assert.equal(lockedRow.dataset.sessionLockdown, 'true');
  assert.ok(lockedRow.querySelector('.session-row__lockdown-badge'), 'sidebar row shows the lockdown badge');
  assert.equal(lockedRow.querySelector('.session-row__lockdown-label'), null);

  const openRow = window.document.querySelector('[data-session-id="session-open"]');
  assert.equal(openRow.dataset.sessionLockdown, 'false');
  assert.equal(openRow.querySelector('.session-row__lockdown-badge'), null);

  const openButton = window.document.querySelector('[data-session-open="session-open"]');
  assert.ok(openButton);
  openButton.click();
  await waitForUi(window, 40);

  assert.equal(window.__rendererState.currentSessionId, 'session-open');
  assert.equal(headerBadge.hidden, true, 'header badge hides once the active session is unlocked');
  assert.match(announcer.textContent, /off for this session/i);
  assert.equal(announcementMutations, 1, 'session switch announces the state change once');

  // Re-opening the SAME (already current, still unlocked) session must not
  // re-announce -- the announcer fires once per lockdown state CHANGE, not
  // once per render.
  openButton.click();
  await waitForUi(window, 20);
  assert.equal(announcementMutations, 1, 'same-state re-render does not touch the live region');

  // Model a sessions.list summary refresh from the backend rather than a
  // local toggle acknowledgement. The active session must pick up the new
  // persisted value on the next shell refresh.
  shell.__state.sessions = shell.__state.sessions.map((session) => ({
    ...session,
    ...(session.id === 'session-open' ? { lockdown: true } : {}),
  }));
  assert.equal(
    window.__rendererState.sessions.find((session) => session.id === 'session-open').lockdown,
    false,
    'backend summary replacement is not already aliased into renderer state'
  );
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);

  assert.equal(window.__rendererState.currentSessionId, 'session-open');
  assert.equal(headerBadge.hidden, false, 'header badge follows a backend summary refresh');
  assert.equal(
    window.document.querySelector('[data-session-id="session-open"]').dataset.sessionLockdown,
    'true'
  );
  assert.match(announcer.textContent, /on for this session/i);
  assert.equal(announcementMutations, 2, 'backend summary change announces exactly once');

  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);
  assert.equal(announcementMutations, 2, 'unchanged backend summary does not re-announce');

  await collapseChatPanel(window);
  const collapsedChip = window.document.querySelector('[data-strip-session-id="session-open"]');
  assert.ok(collapsedChip, 'active session survives as a collapsed-strip chip');
  assert.equal(collapsedChip.dataset.sessionLockdown, 'true');
  assert.equal(collapsedChip.title, 'Offline lockdown');
  assert.match(collapsedChip.getAttribute('aria-label'), /Offline lockdown/);
  assert.ok(
    collapsedChip.querySelector('.session-offline-lockdown-badge.chats-strip__lockdown-badge svg'),
    'collapsed chip carries the lock icon'
  );
});

/* ── Group 3: composer tool toggles locked while active, freed when not ── */

test('composer setToggle is a no-op while the current session is locked, and works once unlocked', async () => {
  const state = {
    features: { featureFlags: { session_offline_lockdown: true } },
    sessions: [{ id: 'sess-1', lockdown: true }],
    currentSessionId: 'sess-1',
  };
  const controller = createComposerV2ToggleController({ state });
  controller.setAvailableTools(['web_search']);

  const blockedResult = await controller.setToggle('web_search', false);
  assert.equal(blockedResult, false);
  assert.equal(controller.getToggleStates().web_search, true, 'toggle state unchanged while locked');

  state.sessions[0].lockdown = false;
  const allowedResult = await controller.setToggle('web_search', false);
  assert.equal(allowedResult, true);
  assert.equal(controller.getToggleStates().web_search, false, 'toggle takes effect once unlocked');
});

test('composer tool toggle markup is disabled with the lockdown tooltip while locked, and normal once unlocked', () => {
  const previousInventory = global.inventory;
  global.inventory = {
    toggleSwitch: ToggleSwitch.toggleSwitch,
    chip: Chip,
    popover: Popover,
  };
  try {
    const state = {
      features: { featureFlags: { session_offline_lockdown: true } },
      sessions: [{ id: 'sess-1', lockdown: true }],
      currentSessionId: 'sess-1',
    };
    const controller = createComposerV2ToggleController({ state });
    controller.setAvailableTools(['web_search']);

    const lockedMarkup = controller.renderToolToggles();
    assert.ok(lockedMarkup.includes('Offline lockdown is on for this session'), 'lockdown tooltip present');
    assert.ok(lockedMarkup.includes('aria-disabled="true"'), 'toggle rendered disabled while locked');

    state.sessions[0].lockdown = false;
    const unlockedMarkup = controller.renderToolToggles();
    assert.ok(
      !unlockedMarkup.includes('Offline lockdown is on for this session'),
      'lockdown tooltip absent once unlocked'
    );
  } finally {
    global.inventory = previousInventory;
  }
});

/* ── Group 4: the lockdown_remote_engine refusal card and its two actions ── */

test('renderTimelineErrorCard renders a calm lockdown-refusal card with exactly its three recovery actions', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_lockdown',
    session_id: 'sess_lockdown',
    stream_error: 'Offline lockdown blocks this session from using a remote engine.',
    error_code: 'lockdown_remote_engine',
    terminal_subcode: 'lockdown_remote_engine',
    retryable: false,
    recovery_actions: [{ id: 'settings', label: 'Open settings' }],
  });
  assert.ok(html.includes('chat-error-card--calm'), 'calm variant, not a crash-styled danger card');
  assert.ok(!html.includes('role="alert"'));
  assert.ok(
    html.includes('This session is in offline lockdown; the selected engine is remote. '
      + 'Switch to a local model or turn lockdown off.'),
    'system-row copy'
  );
  assert.ok(html.includes('data-inv-error-action="lockdown_off"'));
  assert.ok(html.includes('data-inv-error-action="switch_local_model"'));
  assert.ok(html.includes('data-inv-error-action="retry_turn"'), 'the refused turn is already persisted, so the card must offer a re-send');
  assert.ok(!html.includes('data-inv-error-action="settings"'), 'stale backend actions cannot replace the lockdown recovery set');
  assert.equal((html.match(/data-inv-error-action=/g) || []).length, 3);
  assert.ok(html.includes('data-session-id="sess_lockdown"'));
  assert.ok(html.includes('Turn lockdown off'));
  assert.ok(html.includes('Switch to a local model'));
});

test('handleErrorRecoveryAction: lockdown_off writes lockdown:false for the refusal\'s own session only', async () => {
  const state = {
    sessions: [
      { id: 'sess_lockdown', lockdown: true },
      { id: 'sess_other', lockdown: true },
    ],
  };
  const setPreferenceCalls = [];
  let renderAllCalls = 0;
  const controller = createShellRuntimeController({
    state,
    windowRef: {
      jennyShell: {
        sessions: {
          async setPreferences(sessionId, preferences) {
            setPreferenceCalls.push({ sessionId, preferences });
            return { id: sessionId, lockdown: preferences.lockdown === true };
          },
        },
      },
    },
    callbacks: {
      renderAll: () => { renderAllCalls += 1; },
    },
  });

  await controller.handleErrorRecoveryAction({ action: 'lockdown_off', sessionId: 'sess_lockdown' });

  assert.deepEqual(setPreferenceCalls, [{ sessionId: 'sess_lockdown', preferences: { lockdown: false } }]);
  assert.equal(state.sessions.find((s) => s.id === 'sess_lockdown').lockdown, false);
  assert.equal(state.sessions.find((s) => s.id === 'sess_other').lockdown, true, "the other session's preference is untouched");
  assert.equal(renderAllCalls, 1);
});

test('handleErrorRecoveryAction dispatches switch_local_model and retry_turn through existing paths', async () => {
  const opens = [];
  const retries = [];
  const controller = createShellRuntimeController({
    state: {},
    callbacks: {
      openSettingsSection: (...args) => opens.push(args),
    },
  });

  await controller.handleErrorRecoveryAction({ action: 'switch_local_model' });
  await controller.handleErrorRecoveryAction(
    { action: 'retry_turn', messageId: 'msg_retry' },
    { handleRegenerateMessage: (...args) => retries.push(args) }
  );

  assert.equal(opens.length, 1);
  assert.equal(opens[0][0], 'models');
  assert.deepEqual(retries, [['msg_retry', { failureRetry: true }]]);
});

test('a lockdown refusal card in the real transcript wires both actions end-to-end and never touches the composer draft', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, LOCKDOWN_FLAG_ON);
  await seedSessions(window, shell, [
    buildSidebarSession('session-lockdown', 'Locked Session', '2026-09-04T09:00:00.000Z', { lockdown: true }),
  ]);

  const input = window.document.getElementById('chatInput');
  input.value = 'unsent draft';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));

  const setPreferenceCalls = [];
  const originalSetPreferences = window.jennyShell.sessions.setPreferences;
  window.jennyShell.sessions.setPreferences = async (sessionId, preferences) => {
    setPreferenceCalls.push({ sessionId, preferences });
    return { id: sessionId, lockdown: preferences.lockdown === true };
  };
  t.after(() => {
    window.jennyShell.sessions.setPreferences = originalSetPreferences;
  });

  const chatTimeline = window.document.getElementById('chatTimeline');
  assert.ok(chatTimeline, 'expected #chatTimeline in index.html');
  chatTimeline.innerHTML = window.rendererErrorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_lockdown_1',
    session_id: 'session-lockdown',
    stream_error: 'Offline lockdown blocks this session from using a remote engine.',
    error_code: 'lockdown_remote_engine',
    terminal_subcode: 'lockdown_remote_engine',
    retryable: false,
  });

  const lockdownOffButton = chatTimeline.querySelector('[data-inv-error-action="lockdown_off"]');
  assert.ok(lockdownOffButton, 'expected a Turn lockdown off action button');
  lockdownOffButton.click();
  await waitForUi(window, 30);

  assert.equal(setPreferenceCalls.length, 1);
  assert.equal(setPreferenceCalls[0].sessionId, 'session-lockdown');
  assert.equal(setPreferenceCalls[0].preferences.lockdown, false);
  assert.equal(input.value, 'unsent draft', 'the composer draft is untouched by the lockdown_off recovery action');

  chatTimeline.innerHTML = window.rendererErrorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_lockdown_2',
    session_id: 'session-lockdown',
    stream_error: 'Offline lockdown blocks this session from using a remote engine.',
    error_code: 'lockdown_remote_engine',
    terminal_subcode: 'lockdown_remote_engine',
    retryable: false,
  });
  const switchButton = chatTimeline.querySelector('[data-inv-error-action="switch_local_model"]');
  assert.ok(switchButton, 'expected a Switch to a local model action button');
  switchButton.click();
  await waitForUi(window, 30);

  assert.equal(window.__rendererState.ui.activeSettingsSection, 'models', 'opens the existing models picker');
  assert.equal(input.value, 'unsent draft', 'the composer draft is still untouched after opening the picker');
});

/* ── Group 5: flag OFF hides the control and the badges entirely ── */

test('flag off hides the toggle and both badges, and leaves composer toggles unaffected, even with lockdown persisted true', async (t) => {
  const { window, shell } = await loadRendererTestApp(t); // session_offline_lockdown not set -> off
  await seedSessions(window, shell, [
    buildSidebarSession('session-flagged-off', 'Flag Off', '2026-09-04T10:00:00.000Z', { lockdown: true }),
  ]);

  await openRowMenu(window, 'session-flagged-off');
  assert.equal(
    getMenuItems(window).some((button) => menuItemLabel(button) === 'Offline lockdown'),
    false,
    'no Offline lockdown menu item when the flag is off'
  );
  window.document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await waitForUi(window, 10);

  const headerBadge = window.document.querySelector('.session-offline-lockdown-badge');
  assert.ok(!headerBadge || headerBadge.hidden === true, 'header badge never shown when the flag is off');

  const row = window.document.querySelector('[data-session-id="session-flagged-off"]');
  assert.equal(row.dataset.sessionLockdown, 'false');
  assert.equal(row.querySelector('.session-row__lockdown-badge'), null);

  await collapseChatPanel(window);
  const collapsedChip = window.document.querySelector(
    '[data-strip-session-id="session-flagged-off"]'
  );
  assert.ok(collapsedChip);
  assert.equal(collapsedChip.dataset.sessionLockdown, 'false');
  // Chips carry an Open <title> tooltip; only lockdown replaces it.
  assert.equal(collapsedChip.getAttribute('title'), 'Open Flag Off');
  assert.doesNotMatch(collapsedChip.getAttribute('aria-label'), /Offline lockdown/);
  assert.equal(collapsedChip.querySelector('.chats-strip__lockdown-badge'), null);

  const state = {
    features: { featureFlags: {} },
    sessions: [{ id: 'sess-1', lockdown: true }],
    currentSessionId: 'sess-1',
  };
  const controller = createComposerV2ToggleController({ state });
  controller.setAvailableTools(['web_search']);
  const result = await controller.setToggle('web_search', false);
  assert.equal(result, true, 'composer toggle is not gated by a persisted lockdown when the flag is off');
  assert.equal(controller.getToggleStates().web_search, false);

  const previousInventory = global.inventory;
  global.inventory = {
    toggleSwitch: ToggleSwitch.toggleSwitch,
    chip: Chip,
    popover: Popover,
  };
  try {
    const markup = controller.renderToolToggles();
    assert.ok(markup, 'composer tool toggle remains rendered');
    assert.ok(!markup.includes('Offline lockdown is on for this session'));
    const webToggle = markup.match(
      /<button[^>]*data-inv-toggle="tool-toggle-web_search"[^>]*>/
    )?.[0];
    assert.ok(webToggle, 'web-search toggle remains rendered');
    assert.ok(!webToggle.includes('disabled'), 'web-search toggle remains enabled');
    assert.ok(webToggle.includes('aria-checked="false"'), 'the successful toggle change remains visible');
  } finally {
    global.inventory = previousInventory;
  }
});

/* ── Group 6: reduced motion drops the fade transition class ── */

test('reduced motion suppresses the badge fade transition class on both the header and sidebar badges', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    ...LOCKDOWN_FLAG_ON,
    reducedMotion: true,
  });
  await seedSessions(window, shell, [
    buildSidebarSession('session-locked-rm', 'Locked RM', '2026-09-04T13:00:00.000Z', { lockdown: true }),
  ]);

  const headerBadge = window.document.querySelector('.session-offline-lockdown-badge');
  assert.ok(headerBadge);
  assert.equal(headerBadge.hidden, false);
  assert.equal(
    headerBadge.classList.contains('session-offline-lockdown-badge--fade'),
    false,
    'no header transition class under prefers-reduced-motion'
  );

  const sidebarBadge = window.document.querySelector('.session-row__lockdown-badge');
  assert.ok(sidebarBadge);
  assert.equal(
    sidebarBadge.classList.contains('session-offline-lockdown-badge--fade'),
    false,
    'no sidebar transition class under prefers-reduced-motion'
  );
});
