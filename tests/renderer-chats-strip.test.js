const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const actionButton = require('../renderer/inventory/action-button');
const inventoryPopover = require('../renderer/inventory/popover');
const { createChatsStripController } = require('../renderer/shell/renderer-chats-strip');
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

function minutesAgoIso(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

async function collapseChatPanel(window) {
  const doc = window.document;
  doc.getElementById('chatTopRailTab').click();
  await waitForUi(window, 40);
  doc.getElementById('chatsPanelCollapseToggle').click();
  await waitForUi(window, 40);
}

function getChips(window) {
  return [...window.document.querySelectorAll('#chatsStripChips [data-strip-session-id]')];
}

test('collapsing the chat panel shows the strip: pinned-first chips, cap, and 56px width', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const workspace = doc.getElementById('workspace');
  await waitForUi(window, 60);

  // Collapse FIRST, then seed: proves the afterRenderSessions hook re-renders
  // the strip when the session list changes underneath it.
  await collapseChatPanel(window);
  assert.equal(workspace.classList.contains('panel-collapsed'), true);
  const strip = doc.getElementById('chatsStrip');
  assert.ok(strip, 'the strip mounts inside the panel host');
  assert.equal(strip.hidden, false, 'the strip is visible while collapsed');
  assert.equal(
    workspace.style.getPropertyValue('--sidebar-current-width'),
    '56px',
    'the registry writes the strip width into the legacy var (composer offset lockstep)'
  );

  const sessions = [];
  for (let i = 1; i <= 13; i += 1) {
    sessions.push(buildSidebarSession(`session-${i}`, `Chat ${i}`, minutesAgoIso(i * 5)));
  }
  // Oldest session is pinned: it must lead the strip despite its age.
  sessions.push(buildSidebarSession('session-pinned', 'Pinned Plan', minutesAgoIso(600), { pinned: true }));
  sessions.push(buildSidebarSession('session-archived', 'Archived Chat', minutesAgoIso(2), {
    archived_at: '2026-06-11T00:00:00.000Z',
  }));
  await seedSessions(window, shell, sessions);

  const chips = getChips(window);
  assert.equal(chips.length, 12, 'chips cap at 12');
  assert.equal(chips[0].dataset.stripSessionId, 'session-pinned', 'pinned chip leads the strip');
  assert.equal(chips[0].classList.contains('chats-strip__chip--pinned'), true);
  assert.equal(chips[0].getAttribute('title'), 'Open Pinned Plan');
  assert.ok(
    chips.every((chip) => chip.dataset.stripSessionId !== 'session-archived'),
    'archived sessions never become chips'
  );
  assert.ok(
    chips.every((chip) => chip.querySelector('.chats-strip__chip-monogram')?.textContent.trim()),
    'every chip renders a monogram'
  );
  const stripToggle = doc.getElementById('chatsStripPanelToggle');
  assert.equal(stripToggle?.isConnected, true, 'the expand toggle survives chip re-renders');
  assert.equal(strip.firstElementChild, stripToggle, 'the expand toggle stays at the head of the strip');
  const more = doc.querySelector('[data-strip-more]');
  assert.ok(more, 'overflow sessions produce a final more-chats chip');
  assert.equal(more.textContent.trim(), '+2', 'the count includes every non-archived session beyond the chip cap');
  assert.match(more.getAttribute('aria-label'), /2 more chats/i);
  more.click();
  await waitForUi(window, 30);
  assert.equal(workspace.classList.contains('panel-collapsed'), false, 'more expands the panel');
  assert.equal(doc.activeElement, doc.getElementById('conversationSearch'), 'more focuses full-history search');
});

test('the more-chats chip explicitly expands an auto-collapsed 480px panel', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, { windowInnerWidth: 480 });
  const doc = window.document;
  doc.getElementById('chatTopRailTab').click();
  await seedSessions(window, shell, Array.from({ length: 14 }, (_, index) => (
    buildSidebarSession(`narrow-${index}`, `Narrow ${index}`, minutesAgoIso(index + 1))
  )));
  const workspace = doc.getElementById('workspace');
  assert.equal(workspace.dataset.panelAutoCollapsed, 'true');
  const more = doc.querySelector('[data-strip-more]');
  assert.ok(more);
  more.click();
  await waitForUi(window, 30);
  assert.equal(workspace.classList.contains('panel-collapsed'), false);
  assert.equal(workspace.dataset.panelAutoCollapsed, 'false');
  assert.equal(doc.activeElement, doc.getElementById('conversationSearch'));
});

test('the more-chats chip resets stale Archived and search state before expansion', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const sessions = Array.from({ length: 14 }, (_, index) => (
    buildSidebarSession(`recent-more-${index}`, `Recent ${index}`, minutesAgoIso(index + 1))
  ));
  sessions.push(buildSidebarSession('archived-more', 'Archived', minutesAgoIso(30), {
    archived_at: minutesAgoIso(20),
  }));
  await seedSessions(window, shell, sessions);
  doc.querySelector('[data-inv-segmented="chats-scope"] [data-value="archived"]').click();
  await waitForUi(window, 20);
  const search = doc.getElementById('conversationSearch');
  search.value = 'no-match';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);
  assert.ok(doc.querySelector('[data-chats-empty][data-empty-kind="search"]'));

  await collapseChatPanel(window);
  doc.querySelector('[data-strip-more]').click();
  await waitForUi(window, 40);

  assert.equal(doc.querySelector('[data-value="recent"]').getAttribute('aria-checked'), 'true');
  assert.equal(doc.querySelector('[data-value="archived"]').getAttribute('aria-checked'), 'false');
  assert.equal(search.value, '');
  assert.ok(doc.querySelector('[data-session-id="recent-more-0"]'));
  assert.equal(doc.querySelector('[data-chats-empty]'), null);
  assert.equal(doc.activeElement, search);
  assert.equal(doc.getElementById('workspace').classList.contains('panel-collapsed'), false);
});

test('runtime-only strip patching never reads or sorts the complete session collection', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [buildSidebarSession('runtime-chip', 'Runtime', minutesAgoIso(1))]);
  await collapseChatPanel(window);
  const chip = doc.querySelector('[data-strip-session-id="runtime-chip"]');
  chip.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(doc.getElementById('chatsStripPeek').hidden, false);
  window.rendererMultiStreamController.registerStream('runtime-chip', 'stream-runtime-chip');
  const originalSessions = window.__rendererState.sessions;
  Object.defineProperty(window.__rendererState, 'sessions', {
    configurable: true,
    get() { throw new Error('runtime strip patch scanned full history'); },
  });
  try {
    assert.doesNotThrow(() => window.rendererTopNavShellController.patchChatsStripRuntime());
    assert.equal(chip.dataset.sessionDominantState, 'streaming');
    assert.equal(doc.getElementById('chatsStripPeekState').textContent, 'Streaming');
  } finally {
    Object.defineProperty(window.__rendererState, 'sessions', {
      configurable: true, writable: true, value: originalSessions,
    });
  }
});

test('collapsed chips retain canonical runtime state when the expanded list shows Archived', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await seedSessions(window, shell, [
    buildSidebarSession('recent-runtime', 'Recent Runtime', minutesAgoIso(1)),
    buildSidebarSession('archived-only', 'Archived Only', minutesAgoIso(2), {
      archived_at: minutesAgoIso(1),
    }),
  ]);
  doc.querySelector('[data-inv-segmented="chats-scope"] [data-value="archived"]').click();
  await waitForUi(window, 20);
  assert.equal(doc.querySelector('[data-session-id="recent-runtime"]'), null, 'Recent row is not mounted');

  window.rendererMultiStreamController.registerStream('recent-runtime', 'stream-filtered-chip');
  await collapseChatPanel(window);
  const chip = doc.querySelector('[data-strip-session-id="recent-runtime"]');
  assert.ok(chip, 'the recent session remains available in the collapsed shortlist');
  assert.equal(chip.dataset.sessionDominantState, 'streaming');
  chip.focus();
  await waitForUi(window, 20);
  assert.equal(doc.getElementById('chatsStripPeekState').textContent, 'Streaming');

  window.rendererMultiStreamController.clearStream('stream-filtered-chip');
  window.__rendererState.pendingToolApprovals.set('approval-filtered-chip', {
    sessionId: 'recent-runtime',
  });
  window.rendererTopNavShellController.patchChatsStripRuntime();
  assert.equal(chip.dataset.sessionDominantState, 'approval');
  assert.equal(doc.getElementById('chatsStripPeekState').textContent, 'Approval');
});

test('the strip hides on expand and on panel-less views, and returns on chat', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await waitForUi(window, 60);
  await seedSessions(window, shell, [buildSidebarSession('session-1', 'Solo Chat', minutesAgoIso(3))]);

  await collapseChatPanel(window);
  const strip = doc.getElementById('chatsStrip');
  assert.equal(strip.hidden, false, 'visible while the chat panel is collapsed');

  doc.getElementById('chatsStripPanelToggle').click();
  await waitForUi(window, 40);
  assert.equal(strip.hidden, true, 'expanding via the strip toggle hides the strip');

  doc.getElementById('chatsPanelCollapseToggle').click();
  await waitForUi(window, 40);
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 40);
  assert.equal(strip.hidden, true, 'panel-less views never show the strip');

  doc.getElementById('chatTopRailTab').click();
  await waitForUi(window, 40);
  assert.equal(strip.hidden, false, 'returning to chat restores the collapsed strip');
});

test('chip click opens that session; the strip New Chat starts a fresh one', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await waitForUi(window, 60);
  await seedSessions(window, shell, [
    buildSidebarSession('session-a', 'Alpha', minutesAgoIso(2)),
    buildSidebarSession('session-b', 'Beta', minutesAgoIso(10)),
  ]);

  await collapseChatPanel(window);
  const targetChip = getChips(window).find((chip) => chip.dataset.stripSessionId === 'session-b');
  assert.ok(targetChip, 'the Beta chip renders');
  targetChip.click();
  await waitForUi(window, 60);
  assert.equal(window.__rendererState.currentSessionId, 'session-b', 'chip click activates the session');

  const sessionCountBefore = Number(shell.__state.sessionCounter || 0);
  doc.getElementById('chatsStripNewChat').click();
  await waitForUi(window, 60);
  assert.equal(
    Number(shell.__state.sessionCounter || 0),
    sessionCountBefore + 1,
    'the strip New Chat rides the panel button pipeline'
  );
});

test('hovering a chip opens the quick-peek with title/time/model and leaving closes it', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  await waitForUi(window, 60);
  await seedSessions(window, shell, [
    buildSidebarSession('session-peek', 'Peek Target', minutesAgoIso(5), { pinned: true }),
  ]);

  await collapseChatPanel(window);
  const chip = getChips(window).find((entry) => entry.dataset.stripSessionId === 'session-peek');
  assert.ok(chip, 'the chip renders');
  const peek = doc.getElementById('chatsStripPeek');
  assert.equal(peek.parentElement, doc.body, 'the quick peek is portaled outside the clipped panel');
  assert.equal(peek.getAttribute('role'), 'tooltip');
  assert.equal(peek.hidden, true, 'the peek ships closed');

  chip.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(peek.hidden, false, 'hover opens the peek');
  assert.equal(doc.getElementById('chatsStripPeekTitle').textContent, 'Peek Target');
  const meta = doc.getElementById('chatsStripPeekMeta').textContent;
  assert.ok(meta.includes('5m'), `peek meta carries the relative time (got "${meta}")`);
  assert.ok(meta.includes('gpt-test'), 'peek meta carries the model');
  assert.equal(doc.getElementById('chatsStripPeekState').textContent, 'Pinned', 'idle pinned chips peek as Pinned');
  assert.equal(doc.activeElement === chip, false, 'hover never steals focus');
  assert.equal(chip.getAttribute('aria-describedby'), 'chatsStripPeek');

  chip.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(peek.hidden, true, 'leaving the chip closes the peek');
  assert.equal(chip.hasAttribute('aria-describedby'), false);
});

test('a focused quick-peek refresh preserves keyboard focus when canonical session facts change', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const initial = buildSidebarSession('session-refresh', 'Refresh Target', minutesAgoIso(5), {
    last_model_used: 'model-before',
  });
  await waitForUi(window, 60);
  await seedSessions(window, shell, [initial]);
  await collapseChatPanel(window);

  const initialChip = getChips(window).find(
    (entry) => entry.dataset.stripSessionId === initial.id
  );
  initialChip.focus();
  await waitForUi(window, 20);
  const peek = doc.getElementById('chatsStripPeek');
  assert.equal(peek.hidden, false);
  assert.match(doc.getElementById('chatsStripPeekMeta').textContent, /model-before/);

  const refreshed = {
    ...initial,
    last_model_used: 'model-after',
    message_count: 2,
    last_message_preview: 'replacement answer',
    updated_at: minutesAgoIso(1),
  };
  shell.__state.sessions = [refreshed];
  shell.__state.messagesBySession.set(initial.id, [
    { id: 'user-refresh', role: 'user', content: 'retry me' },
    { id: 'assistant-refresh', role: 'assistant', content: 'replacement answer' },
  ]);
  window.__rendererState.sessions = [refreshed];
  window.__rendererState.messagesBySession.set(initial.id, [
    { id: 'user-refresh', role: 'user', content: 'retry me' },
    { id: 'assistant-refresh', role: 'assistant', content: 'replacement answer' },
  ]);
  await shell.__emitBackendStatus(shell.__state.backendStatus);
  await waitForUi(window, 40);

  assert.equal(peek.hidden, false, 'the mounted peek remains open across its chip refresh');
  const refreshedChip = getChips(window).find(
    (entry) => entry.dataset.stripSessionId === initial.id
  );
  assert.notEqual(refreshedChip, initialChip, 'canonical fact changes replace the rendered chip');
  assert.equal(doc.activeElement, refreshedChip, 'the replacement reclaims keyboard focus');
  assert.equal(refreshedChip.getAttribute('aria-describedby'), 'chatsStripPeek');
  const refreshedMeta = doc.getElementById('chatsStripPeekMeta').textContent;
  assert.match(refreshedMeta, /model-after/);
  assert.match(refreshedMeta, /2 messages/);
  assert.match(refreshedMeta, /1m/);
});

test('Escape dismissal clears quick-peek ownership and later refreshes do not reopen it', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const initial = buildSidebarSession('escape-peek', 'Escape Target', minutesAgoIso(5));
  await seedSessions(window, shell, [initial]);
  await collapseChatPanel(window);
  const chip = getChips(window).find((entry) => entry.dataset.stripSessionId === initial.id);
  chip.focus();
  await waitForUi(window, 20);
  const peek = doc.getElementById('chatsStripPeek');
  assert.equal(peek.hidden, false);
  assert.equal(chip.getAttribute('aria-describedby'), 'chatsStripPeek');

  chip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(peek.hidden, true);
  assert.equal(chip.hasAttribute('aria-describedby'), false);

  const refreshed = { ...initial, title: 'Escape Target Updated', updated_at: minutesAgoIso(1) };
  shell.__state.sessions = [refreshed];
  window.__rendererState.sessions = [refreshed];
  await shell.__emitBackendStatus(shell.__state.backendStatus);
  await waitForUi(window, 40);
  const refreshedChip = getChips(window).find((entry) => entry.dataset.stripSessionId === initial.id);
  assert.equal(doc.activeElement, refreshedChip, 'chip refresh still preserves the keyboard location');
  assert.equal(peek.hidden, true, 'dismissed supplementary content stays dismissed');
  assert.equal(refreshedChip.hasAttribute('aria-describedby'), false);
});

test('isolated strip rendering escapes monograms when no caller escaper is supplied', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><aside id="panel"></aside></body></html>', {
    pretendToBeVisual: true,
  });
  const previousActionButton = global.inventoryActionButton;
  const previousPopover = global.inventoryPopover;
  global.inventoryActionButton = actionButton;
  global.inventoryPopover = inventoryPopover;
  t.after(() => {
    global.inventoryActionButton = previousActionButton;
    global.inventoryPopover = previousPopover;
    dom.window.close();
  });
  const state = {
    sessions: [buildSidebarSession('unsafe-strip', 'Unsafe', minutesAgoIso(1))],
    currentSessionId: 'unsafe-strip',
    ui: { pendingSessionDeletes: [] },
    workspace: { openSessionIds: [] },
    pendingToolApprovals: new Map(),
  };
  const controller = createChatsStripController({
    state,
    documentRef: dom.window.document,
    dom: { viewPanel: dom.window.document.getElementById('panel') },
    callbacks: {
      getSessionMonogram: () => '<img src=x onerror=alert(1)>',
    },
  });
  controller.sync({ visible: true });
  const monogram = dom.window.document.querySelector('.chats-strip__chip-monogram');
  assert.equal(monogram.querySelector('img'), null);
  assert.equal(monogram.textContent, '<img src=x onerror=alert(1)>');
  controller.dispose();
  controller.sync({ visible: true });
  controller.patchRuntimeState();
  assert.equal(dom.window.document.getElementById('chatsStrip'), null);
  assert.equal(dom.window.document.getElementById('chatsStripPeek'), null);
});

test('moving from a chip into its nested monogram does not reopen the quick peek', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><aside id="panel"></aside></body></html>', {
    pretendToBeVisual: true,
  });
  const previousActionButton = global.inventoryActionButton;
  const previousPopover = global.inventoryPopover;
  let openCalls = 0;
  function countingPopover(options) { return inventoryPopover(options); }
  Object.assign(countingPopover, inventoryPopover);
  countingPopover.open = (...args) => { openCalls += 1; return inventoryPopover.open(...args); };
  global.inventoryActionButton = actionButton;
  global.inventoryPopover = countingPopover;
  t.after(() => {
    global.inventoryActionButton = previousActionButton;
    global.inventoryPopover = previousPopover;
    dom.window.close();
  });
  const state = {
    sessions: [buildSidebarSession('nested-hover', 'Nested Hover', minutesAgoIso(1))],
    currentSessionId: 'nested-hover',
    ui: { pendingSessionDeletes: [] },
    workspace: { openSessionIds: [] },
    pendingToolApprovals: new Map(),
  };
  const controller = createChatsStripController({
    state,
    documentRef: dom.window.document,
    dom: { viewPanel: dom.window.document.getElementById('panel') },
  });
  controller.sync({ visible: true });
  const chip = dom.window.document.querySelector('[data-strip-session-id="nested-hover"]');
  const monogram = chip.querySelector('.chats-strip__chip-monogram');

  chip.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
  monogram.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: chip }));

  assert.equal(openCalls, 1, 'nested child transition keeps the existing peek open');
  assert.equal(dom.window.document.getElementById('chatsStripPeek').hidden, false);
  controller.dispose();
});

test('the palette gains session hygiene commands: pin/unpin and the archived view', async (t) => {
  // The harness boots with empty feature flags; the palette gates its bind on
  // command_palette (default-on in the real app).
  const { window, shell } = await loadRendererTestApp(t, {
    shell: { features: { state: { featureFlags: { command_palette: true } } } },
  });
  const doc = window.document;
  await waitForUi(window, 60);
  await seedSessions(window, shell, [
    buildSidebarSession('session-a', 'Alpha', minutesAgoIso(2)),
    buildSidebarSession('session-b', 'Beta', minutesAgoIso(10)),
  ]);

  doc.querySelector('[data-session-open="session-a"]').click();
  await waitForUi(window, 60);
  assert.equal(window.__rendererState.currentSessionId, 'session-a');

  const openPalette = async () => {
    doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await waitForUi(window, 20);
  };

  await openPalette();
  for (const id of ['action:pin-session', 'action:archive-session', 'action:show-archived', 'action:sweep-empty']) {
    assert.ok(doc.querySelector(`[data-palette-id="${id}"]`), `palette lists ${id}`);
  }
  const pinItem = doc.querySelector('[data-palette-id="action:pin-session"]');
  assert.equal(pinItem.textContent.includes('Pin current chat'), true);
  pinItem.click();
  await waitForUi(window, 60);
  assert.equal(
    window.__rendererState.sessions.find((session) => session.id === 'session-a')?.pinned,
    true,
    'the pin command pins the active session'
  );

  await openPalette();
  assert.equal(
    doc.querySelector('[data-palette-id="action:pin-session"]').textContent.includes('Unpin current chat'),
    true,
    'the label flips once the session is pinned'
  );
  doc.querySelector('[data-palette-id="action:show-archived"]').click();
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.sidebarArchivedView, true, 'the archived view command toggles the view');

  await openPalette();
  assert.equal(
    doc.querySelector('[data-palette-id="action:show-archived"]').textContent.includes('Back to recent chats'),
    true,
    'the archived command relabels inside the archived view'
  );
});
