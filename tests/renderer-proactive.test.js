const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

const PROACTIVE_SUGGESTION = {
  id: 'suggestion-block',
  kind: 'morning_briefing',
  title: 'Morning Briefing',
  body: 'Morning briefing for today.',
  promptSuggestion: 'Turn this morning briefing into a concrete plan for today.',
  createdAt: '2026-03-17T09:00:00.000Z',
  dedupeKey: 'morning:2026-03-17',
};

const COMPANION_DEFER_STATE = {
  mode: 'planner',
  modeMeta: { key: 'planner', label: 'Planner', description: 'Plan first.', homePrompt: 'Plan my day.' },
  briefing: { dateKey: '2026-03-19', dateLabel: 'Thursday, March 19', timeZone: 'America/Chicago', items: [] },
  todayCards: [],
  followUps: [],
  reminders: [],
  openLoops: [],
  deferredLoops: [],
  openLoopSummary: { activeCount: 0, deferredCount: 0 },
  availableDeferPresets: [
    { preset: 'tomorrow', label: 'Tomorrow', deferredUntil: '2026-03-20T09:00:00.000Z' },
  ],
  suggestedActions: [],
  workspaceSnapshot: {
    workspaceRoot: '',
    workspaceRootStatus: { state: 'missing', message: 'No workspace root is configured yet.' },
    activeSessionId: '',
    openSessionIds: [],
    sessionCount: 0,
  },
};

// Seeds a persisted proactive_suggestion message — the read-only legacy block kept after
// the dead toast path (window.jennyShell.proactive.onSuggestion) was pruned in B1 — opens
// its session, and returns the rendered block. Its Use/Save/Later buttons dispatch the live
// *Message handlers via data-message-action, independent of the removed toast.
async function seedPersistedProactiveBlock(app, suggestion = PROACTIVE_SUGGESTION) {
  const { window, shell } = app;
  shell.__state.sessions = [{
    id: 'session-proactive',
    title: 'Proactive Session',
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
  }];
  shell.__state.messagesBySession.set('session-proactive', [{
    id: 'proactive-message-1',
    role: 'assistant',
    kind: 'proactive_suggestion',
    content: suggestion.body || '',
    proactive_suggestion: suggestion,
    timestamp: new Date().toISOString(),
  }]);
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);
  const conversationItem = window.document.querySelector(
    '.conversation-item[data-session-id="session-proactive"]'
  );
  assert.ok(conversationItem, 'seeded proactive session should appear in the sidebar');
  conversationItem.click();
  await waitForUi(window, 40);
  const block = window.document.querySelector('.proactive-suggestion-block');
  assert.ok(block, 'persisted proactive_suggestion message should render a read-only block');
  return block;
}

function createMutableProactiveShell(initialState = {}) {
  let snapshot = {
    toolsWorkspaceRoot: '',
    workspaceRootStatus: {
      state: 'missing',
      message: 'Workspace-dependent proactive behaviors are blocked until a workspace root is configured.',
    },
    proactive: {
      reminders: [],
    },
    ...initialState,
  };

  return {
    getState() {
      return JSON.parse(JSON.stringify(snapshot));
    },
    chooseWorkspaceRoot() {
      snapshot = {
        ...snapshot,
        toolsWorkspaceRoot: 'G:/workspace/selected',
        workspaceRootStatus: {
          state: 'ready',
          message: 'Workspace root is configured.',
        },
      };
      return this.getState();
    },
    clearWorkspaceRoot() {
      snapshot = {
        ...snapshot,
        toolsWorkspaceRoot: '',
        workspaceRootStatus: {
          state: 'missing',
          message: 'Workspace-dependent proactive behaviors are blocked until a workspace root is configured.',
        },
      };
      return this.getState();
    },
    upsertReminder(reminder) {
      const id = reminder.id || `rem-${snapshot.proactive.reminders.length + 1}`;
      snapshot = {
        ...snapshot,
        proactive: {
          ...snapshot.proactive,
          reminders: [
            ...snapshot.proactive.reminders.filter((entry) => entry.id !== id),
            {
              ...reminder,
              id,
              createdAt: reminder.createdAt || new Date().toISOString(),
              lastFiredAt: reminder.lastFiredAt || '',
            },
          ],
        },
      };
      return this.getState();
    },
    deleteReminder(reminderId) {
      snapshot = {
        ...snapshot,
        proactive: {
          ...snapshot.proactive,
          reminders: snapshot.proactive.reminders.filter((entry) => entry.id !== reminderId),
        },
      };
      return this.getState();
    },
  };
}

test('renderer leaves workspace authority in Tools', async () => {
  const proactiveShell = createMutableProactiveShell({
    toolsWorkspaceRoot: 'G:/workspace/project',
    workspaceRootStatus: {
      state: 'ready',
      message: 'Workspace root is configured.',
    },
    proactive: {
      reminders: [
        {
          id: 'rem-1',
          label: 'Morning prompt',
          prompt: 'Ask what matters most today.',
          scheduleType: 'daily_at',
          dailyAt: '09:00',
          intervalMinutes: 0,
          enabled: true,
          createdAt: '2026-03-17T12:00:00.000Z',
          lastFiredAt: '',
        },
      ],
    },
  });

  const app = await loadRendererApp({
    shell: {
      proactive: proactiveShell,
    },
  });
  const { window } = app;

  try {
    window.document.querySelector('[data-tab-id="settings"]').click();
    await waitForUi(window, 40);

    assert.equal(window.document.getElementById('toolsWorkspacePath').textContent, 'G:/workspace/project');
  } finally {
    await app.dispose();
  }
});

// UIUX-017 backward compat: a reminder persisted under the old schema
// (scheduleType/dailyAt/intervalMinutes/lastFiredAt) must still normalize
// and render without crashing — the fields are just ignored, not migrated
// away, since services/shell-config-followups-schema.js's normalizeReminder
// still accepts and defaults them server-side.
test('renderer ingests a reminder with old-shape schedule fields without crashing', async () => {
  const proactiveShell = createMutableProactiveShell({
    proactive: {
      reminders: [
        {
          id: 'rem-old-shape',
          label: 'Legacy scheduled reminder',
          prompt: 'This reminder was created before UIUX-017.',
          scheduleType: 'interval_minutes',
          dailyAt: '09:00',
          intervalMinutes: 45,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastFiredAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    },
  });

  const app = await loadRendererApp({
    shell: {
      proactive: proactiveShell,
    },
  });
  const { window } = app;

  try {
    window.document.querySelector('[data-tab-id="home"]').click();
    await waitForUi(window, 40);

    /* The reminders widget that used to render this row left Home in the
     * Daybook cut, so its DOM assertions went with it. The contract this test
     * actually guards survives intact: a legacy-shaped reminder (pre-UIUX-017
     * schedule fields) must flow through the dashboard manager's proactive
     * payload application without throwing, and its dead schedule fields must
     * ride along untouched rather than being re-interpreted as live schedule
     * state. The Daybook agenda consumes this same slice next. */
    const reminders = window.__rendererState.proactive.reminders;
    assert.equal(reminders.length, 1, 'the legacy reminder reached renderer state');
    assert.equal(reminders[0].id, 'rem-old-shape');
    assert.equal(reminders[0].label, 'Legacy scheduled reminder');
    assert.equal(reminders[0].prompt, 'This reminder was created before UIUX-017.');
    // Carried verbatim, not acted on: nothing re-derives a schedule from these.
    assert.equal(reminders[0].scheduleType, 'interval_minutes');
    assert.equal(reminders[0].intervalMinutes, 45);
    // And Home no longer grows a reminders card for it at all.
    assert.equal(window.document.querySelector('#homeDashboardGrid [data-widget-id="reminders"]'), null);
    assert.doesNotMatch(window.document.getElementById('homeDashboardGrid').textContent, /Every 45 minutes|Daily at/);
  } finally {
    await app.dispose();
  }
});

test('renderer Tools workspace link routes to the authoritative Workspace chrome', async () => {
  let featureGetStateCalls = 0;
  let companionGetStateCalls = 0;
  const app = await loadRendererApp({
    shell: {
      features: {
        getState() {
          featureGetStateCalls += 1;
          if (featureGetStateCalls < 2) {
            return null;
          }
          return {
            availability: {
              runtime: {
                managedSidecarActive: true,
                windowsOnly: true,
                workspaceRootStatus: {
                  state: 'missing',
                  message: 'No workspace root is configured yet.',
                },
              },
              tools: {},
              featureFlags: {},
            },
          };
        },
      },
      companion: {
        getState() {
          companionGetStateCalls += 1;
          throw new Error('companion refresh failed');
        },
      },
    },
  });
  const { window } = app;

  try {
    window.document.querySelector('[data-tab-id="settings"]').click();
    await waitForUi(window, 40);

    const baselineCompanionCalls = companionGetStateCalls;
    window.document.getElementById('toolsWorkspaceChooseButton').click();
    await waitForUi(window, 40);

    assert.equal(window.document.getElementById('ideView').getAttribute('aria-hidden'), 'false');
    assert.equal(
      companionGetStateCalls,
      baselineCompanionCalls,
      'Tools link does not mutate or refresh root-owned state'
    );
  } finally {
    await app.dispose();
  }
});

test('renderer Tools workspace link does not invoke chooser refresh fan-out', async () => {
  let featureGetStateCalls = 0;
  const app = await loadRendererApp({
    shell: {
      workspaceRoot: {
        prepareChoose() {
          return {
            prepared: false,
            changed: false,
            canceled: true,
          };
        },
      },
      features: {
        getState() {
          featureGetStateCalls += 1;
          return null;
        },
      },
    },
  });
  const { window } = app;

  try {
    window.document.querySelector('[data-tab-id="settings"]').click();
    await waitForUi(window, 40);

    const baselineFeatureCalls = featureGetStateCalls;
    window.document.getElementById('toolsWorkspaceChooseButton').click();
    await waitForUi(window, 40);

    assert.equal(featureGetStateCalls, baselineFeatureCalls);
    assert.equal(window.document.getElementById('ideView').getAttribute('aria-hidden'), 'false');
  } finally {
    await app.dispose();
  }
});

test('renderer persisted proactive block Use button prefills the composer without auto-sending', async () => {
  const app = await loadRendererApp();
  const { window, shell } = app;

  try {
    await seedPersistedProactiveBlock(app);

    const usePromptButton = window.document.querySelector('[data-message-action="use-suggestion"]');
    assert.ok(usePromptButton);
    usePromptButton.click();
    await waitForUi(window, 30);

    assert.equal(
      window.document.getElementById('chatInput').value,
      'Turn this morning briefing into a concrete plan for today.'
    );
    assert.equal(shell.__state.chatCalls.length, 0);
  } finally {
    await app.dispose();
  }
});

test('renderer persisted proactive block Save button captures an open loop', async () => {
  const app = await loadRendererApp({ shell: { companion: { state: COMPANION_DEFER_STATE } } });
  const { window, shell } = app;

  try {
    await seedPersistedProactiveBlock(app);

    window.document.querySelector('[data-message-action="save-suggestion"]').click();
    await waitForUi(window, 40);

    assert.equal(shell.__state.companionCalls.addFollowUp.length, 1);
    assert.equal(shell.__state.companionCalls.addFollowUp[0].sourceKind, 'proactive_suggestion');
    assert.equal(shell.__state.companionCalls.addFollowUp[0].status, 'active');
  } finally {
    await app.dispose();
  }
});

test('renderer persisted proactive block Later button defers an open loop', async () => {
  const app = await loadRendererApp({ shell: { companion: { state: COMPANION_DEFER_STATE } } });
  const { window, shell } = app;

  try {
    await seedPersistedProactiveBlock(app);

    window.document.querySelector('[data-message-action="later-suggestion"]').click();
    await waitForUi(window, 30);

    window.document.querySelector('[data-toast-action-id^="follow-up-defer:"][data-toast-action-id$=":tomorrow"]').click();
    await waitForUi(window, 40);

    assert.equal(shell.__state.companionCalls.addFollowUp.length, 1);
    assert.equal(shell.__state.companionCalls.addFollowUp[0].sourceKind, 'proactive_suggestion');
    assert.equal(shell.__state.companionCalls.addFollowUp[0].status, 'deferred');
    assert.equal(shell.__state.companionCalls.addFollowUp[0].deferPreset, 'tomorrow');
  } finally {
    await app.dispose();
  }
});
