const test = require('node:test');
const assert = require('node:assert/strict');

const { JSDOM } = require('jsdom');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');
const { createCompanionActionUtils } = require('../renderer/features/renderer-companion-action-utils.js');
const agendaModule = require('../renderer/features/renderer-dashboard-calendar-agenda.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');

/* This file's companion-reminder mirroring wrapper went with the reminders
 * widget in the Daybook cut: it existed only so the widget's LIST (which read
 * state.proactive.reminders) would render the actions attached to
 * state.companion.reminders. Every surviving test here seeds `reminders: []`
 * and drives the open-loops board instead, so the harness loader is used
 * directly. */

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function buildCompanionState(overrides = {}) {
  return {
    mode: 'planner',
    modeMeta: {
      key: 'planner',
      label: 'Planner',
      description: 'Jenny leans toward structure, priorities, and gentle sequencing.',
      homePrompt: 'Help me turn today into a simple plan with the right next steps.',
    },
    briefing: {
      dateKey: '2026-03-19',
      dateLabel: 'Thursday, March 19',
      timeZone: 'America/Chicago',
      items: [],
    },
    todayCards: [],
    reminders: [],
    openLoops: [],
    suggestedActions: [],
    workspaceSnapshot: {
      workspaceRoot: '',
      workspaceRootStatus: {
        state: 'missing',
        message: 'No workspace root is configured yet.',
      },
      activeSessionId: '',
      openSessionIds: [],
      sessionCount: 0,
    },
    ...overrides,
  };
}

test('renderer home follow-up open loops render Done and Delete actions', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: {
          mode: 'planner',
          modeMeta: {
            key: 'planner',
            label: 'Planner',
            description: 'Plan first.',
            homePrompt: 'Plan my day.',
          },
          briefing: { dateKey: '2026-03-19', dateLabel: 'Thursday, March 19', timeZone: 'America/Chicago', items: [] },
          todayCards: [],
          followUps: [
            {
              id: 'followup-1',
              label: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              createdAt: '2026-03-19T12:00:00.000Z',
              sessionId: 'session-1',
              resolved: false,
            },
          ],
          reminders: [],
          openLoops: [
            {
              id: 'followup:followup-1',
              kind: 'follow_up',
              title: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              action: {
                id: 'resolve_follow_up:followup-1',
                type: 'resolve_follow_up',
                label: 'Done',
                followUpId: 'followup-1',
              },
            },
          ],
          suggestedActions: [],
          workspaceSnapshot: {
            workspaceRoot: '',
            workspaceRootStatus: { state: 'missing', message: 'No workspace root is configured yet.' },
            activeSessionId: '',
            openSessionIds: [],
            sessionCount: 0,
          },
        },
      },
    },
  });
  const { window } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    const actionButtons = [...window.document.querySelectorAll('#homeOpenLoopList .btn')].map((node) =>
      node.textContent.trim()
    );

    assert.deepEqual(actionButtons, ['Edit', 'Resume this thread', 'Done', 'Later', 'Delete']);
  } finally {
    await app.dispose();
  }
});

test('renderer home Done action resolves a follow-up and refreshes the open loops', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: {
          mode: 'planner',
          modeMeta: {
            key: 'planner',
            label: 'Planner',
            description: 'Plan first.',
            homePrompt: 'Plan my day.',
          },
          briefing: { dateKey: '2026-03-19', dateLabel: 'Thursday, March 19', timeZone: 'America/Chicago', items: [] },
          todayCards: [],
          followUps: [
            {
              id: 'followup-1',
              label: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              createdAt: '2026-03-19T12:00:00.000Z',
              sessionId: 'session-1',
              resolved: false,
            },
          ],
          openLoops: [
            {
              id: 'followup:followup-1',
              kind: 'follow_up',
              title: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              action: {
                id: 'resolve_follow_up:followup-1',
                type: 'resolve_follow_up',
                label: 'Done',
                followUpId: 'followup-1',
              },
            },
          ],
          reminders: [],
          suggestedActions: [],
          workspaceSnapshot: {
            workspaceRoot: '',
            workspaceRootStatus: { state: 'missing', message: 'No workspace root is configured yet.' },
            activeSessionId: '',
            openSessionIds: [],
            sessionCount: 0,
          },
        },
      },
    },
  });
  const { window, shell } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    window.document.querySelector('[data-companion-action-id="resolve_follow_up:followup-1"]').click();
    await waitForUi(window, 40);

    assert.deepEqual(shell.__state.companionCalls.resolveFollowUp, ['followup-1']);
    assert.match(window.document.getElementById('homeOpenLoopStatus').textContent, /all loops closed/i);
  } finally {
    await app.dispose();
  }
});

test('renderer home Delete action removes a follow-up and refreshes the open loops', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: {
          mode: 'planner',
          modeMeta: {
            key: 'planner',
            label: 'Planner',
            description: 'Plan first.',
            homePrompt: 'Plan my day.',
          },
          briefing: { dateKey: '2026-03-19', dateLabel: 'Thursday, March 19', timeZone: 'America/Chicago', items: [] },
          todayCards: [],
          followUps: [
            {
              id: 'followup-1',
              label: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              createdAt: '2026-03-19T12:00:00.000Z',
              sessionId: 'session-1',
              resolved: false,
            },
          ],
          openLoops: [
            {
              id: 'followup:followup-1',
              kind: 'follow_up',
              title: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              action: {
                id: 'resolve_follow_up:followup-1',
                type: 'resolve_follow_up',
                label: 'Done',
                followUpId: 'followup-1',
              },
            },
          ],
          reminders: [],
          suggestedActions: [],
          workspaceSnapshot: {
            workspaceRoot: '',
            workspaceRootStatus: { state: 'missing', message: 'No workspace root is configured yet.' },
            activeSessionId: '',
            openSessionIds: [],
            sessionCount: 0,
          },
        },
      },
    },
  });
  const { window, shell } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    window.document.querySelector('[data-companion-action-id="delete_follow_up:followup-1"]').click();
    await waitForUi(window, 40);

    assert.deepEqual(shell.__state.companionCalls.deleteFollowUp, ['followup-1']);
    assert.match(window.document.getElementById('homeOpenLoopStatus').textContent, /all loops closed/i);
  } finally {
    await app.dispose();
  }
});

test('renderer home Later action defers a follow-up through preset selection', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: {
          mode: 'planner',
          modeMeta: {
            key: 'planner',
            label: 'Planner',
            description: 'Plan first.',
            homePrompt: 'Plan my day.',
          },
          briefing: { dateKey: '2026-03-19', dateLabel: 'Thursday, March 19', timeZone: 'America/Chicago', items: [] },
          todayCards: [],
          followUps: [
            {
              id: 'followup-1',
              label: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              createdAt: '2026-03-19T12:00:00.000Z',
              updatedAt: '2026-03-19T12:00:00.000Z',
              sessionId: 'session-1',
              status: 'active',
            },
          ],
          availableDeferPresets: [
            { preset: 'tomorrow', label: 'Tomorrow', deferredUntil: '2026-03-20T09:00:00.000Z' },
          ],
          reminders: [],
          suggestedActions: [],
          workspaceSnapshot: {
            workspaceRoot: '',
            workspaceRootStatus: { state: 'missing', message: 'No workspace root is configured yet.' },
            activeSessionId: '',
            openSessionIds: [],
            sessionCount: 0,
          },
        },
      },
    },
  });
  const { window, shell } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    window.document.querySelector('[data-companion-action-id="defer_follow_up:followup-1"]').click();
    await waitForUi(window, 30);

    window.document.querySelector('[data-toast-action-id="defer:followup-1:tomorrow"]').click();
    await waitForUi(window, 40);

    assert.deepEqual(shell.__state.companionCalls.deferFollowUp, [
      { id: 'followup-1', preset: 'tomorrow' },
    ]);
    assert.match(window.document.getElementById('homeDeferredLoopList').textContent, /Review the migration/i);
  } finally {
    await app.dispose();
  }
});

test('renderer home deferred loop section renders Make Active and reactivates follow-ups', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: {
          mode: 'planner',
          modeMeta: {
            key: 'planner',
            label: 'Planner',
            description: 'Plan first.',
            homePrompt: 'Plan my day.',
          },
          briefing: { dateKey: '2026-03-19', dateLabel: 'Thursday, March 19', timeZone: 'America/Chicago', items: [] },
          todayCards: [],
          followUps: [
            {
              id: 'followup-1',
              label: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              createdAt: '2026-03-19T12:00:00.000Z',
              updatedAt: '2026-03-19T12:00:00.000Z',
              sessionId: 'session-1',
              status: 'deferred',
              deferPreset: 'tomorrow',
              deferredUntil: '2026-03-20T09:00:00.000Z',
            },
          ],
          reminders: [],
          suggestedActions: [],
          workspaceSnapshot: {
            workspaceRoot: '',
            workspaceRootStatus: { state: 'missing', message: 'No workspace root is configured yet.' },
            activeSessionId: '',
            openSessionIds: [],
            sessionCount: 0,
          },
        },
      },
    },
  });
  const { window, shell } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    assert.match(window.document.getElementById('homeDeferredLoopStatus').textContent, /returns here when due/i);
    assert.match(window.document.getElementById('homeDeferredLoopList').textContent, /Review the migration/i);

    window.document.querySelector('[data-companion-action-id="activate_follow_up:followup-1"]').click();
    await waitForUi(window, 40);

    assert.deepEqual(shell.__state.companionCalls.activateFollowUp, ['followup-1']);
    assert.match(window.document.getElementById('homeOpenLoopList').textContent, /Review the migration/i);
  } finally {
    await app.dispose();
  }
});

test('renderer home recently completed section shows Reopen and moves a loop back to active', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: buildCompanionState({
          followUps: [
            {
              id: 'followup-1',
              label: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              createdAt: '2026-03-19T12:00:00.000Z',
              updatedAt: '2026-03-19T12:20:00.000Z',
              resolvedAt: '2026-03-19T12:20:00.000Z',
              sessionId: 'session-1',
              status: 'resolved',
            },
          ],
        }),
      },
    },
  });
  const { window, shell } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    assert.match(window.document.getElementById('homeRecentResolvedList').textContent, /Review the migration/i);
    assert.match(window.document.getElementById('homeRecentResolvedList').textContent, /Reopen/i);
    assert.match(window.document.getElementById('homeRecentResolvedList').textContent, /Archive/i);

    window.document.querySelector('[data-companion-action-id="activate_follow_up:followup-1"]').click();
    await waitForUi(window, 40);

    assert.deepEqual(shell.__state.companionCalls.activateFollowUp, ['followup-1']);
    assert.match(window.document.getElementById('homeOpenLoopList').textContent, /Review the migration/i);
  } finally {
    await app.dispose();
  }
});

test('renderer home manual add form saves active and deferred open loops', async () => {
  const app = await loadRendererApp();
  const { window, shell } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    window.document.getElementById('homeOpenLoopAddButton').click();
    await waitForUi(window, 20);

    window.document.getElementById('homeOpenLoopTitleInput').value = 'Check the rollout';
    window.document.getElementById('homeOpenLoopNotesInput').value = 'Circle back after QA.';
    window.document.getElementById('homeOpenLoopSaveButton').click();
    await waitForUi(window, 40);

    assert.equal(shell.__state.companionCalls.addFollowUp.length, 1);
    assert.equal(shell.__state.companionCalls.addFollowUp[0].label, 'Check the rollout');
    assert.equal(shell.__state.companionCalls.addFollowUp[0].status, 'active');
    assert.match(window.document.getElementById('homeOpenLoopList').textContent, /Manual/);

    window.document.getElementById('homeOpenLoopAddButton').click();
    await waitForUi(window, 20);

    window.document.getElementById('homeOpenLoopTitleInput').value = 'Review the retrospective';
    window.document.getElementById('homeOpenLoopDeferSelect').value = 'tomorrow';
    window.document.getElementById('homeOpenLoopSaveButton').click();
    await waitForUi(window, 40);

    assert.equal(shell.__state.companionCalls.addFollowUp.length, 2);
    assert.equal(shell.__state.companionCalls.addFollowUp[1].label, 'Review the retrospective');
    assert.equal(shell.__state.companionCalls.addFollowUp[1].status, 'deferred');
    assert.equal(shell.__state.companionCalls.addFollowUp[1].deferPreset, 'tomorrow');
    assert.match(window.document.getElementById('homeDeferredLoopList').textContent, /Manual/);
  } finally {
    await app.dispose();
  }
});

/* RESTORED (Daybook calendar wave): 'renderer home reminder promotion saves a
 * reminder-sourced open loop' lost its surface when the Check-ins widget was
 * cut, leaving the addFollowUp PAYLOAD that promoteReminderToOpenLoop builds —
 * id / label / body / status / sourceKind / sourceMeta — uncovered. The
 * Daybook agenda now re-exposes the action, so the coverage is back: the
 * affordance below is the PRODUCTION agenda markup and the handler is the
 * PRODUCTION companion action router. It drives them directly rather than
 * through the full app harness, which has no calendar service stub (so the
 * calendar widget would render "Calendar unavailable" and no agenda at all). */

test('the agenda promote affordance saves a reminder-sourced open loop payload', async () => {
  const reminder = {
    id: 'reminder-1',
    label: 'Hydrate',
    prompt: 'Drink water before the next deep work block.',
    action: {
      id: 'promote_reminder:reminder-1',
      type: 'promote_reminder',
      label: 'Promote to Open Loop',
      reminderId: 'reminder-1',
    },
  };
  const addFollowUpCalls = [];
  const companionState = { ...buildCompanionState({ reminders: [reminder] }) };
  const utils = createCompanionActionUtils({
    windowRef: {
      jennyShell: {
        companion: {
          async addFollowUp(payload) {
            addFollowUpCalls.push(payload);
            return companionState;
          },
        },
      },
    },
    callbacks: {
      getCompanionState: () => companionState,
      applyCompanionPayload: () => {},
    },
  });

  // Real agenda markup: the promote button and its action id come from
  // production, not from a hand-written fixture.
  const dom = new JSDOM(`<div id="home">${agendaModule.buildAgendaMarkup({
    weekStart: new Date(2026, 5, 7),
    instances: [],
    reminders: [{
      id: 'reminder-1', label: 'Hydrate', scheduleType: 'daily_at', dailyAt: '09:00', enabled: true,
    }],
    now: new Date(2026, 5, 11, 10, 30),
    actionButton: inventoryActionButton,
  })}</div>`);
  const home = dom.window.document.getElementById('home');
  home.addEventListener('click', utils.handleHomeClick);
  const promote = home.querySelector('[data-companion-action-id="promote_reminder:reminder-1"]');
  assert.ok(promote, 'the agenda renders the promote affordance');

  promote.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(addFollowUpCalls.length, 1);
  assert.equal(addFollowUpCalls[0].id, 'reminder:reminder-1');
  assert.equal(addFollowUpCalls[0].label, 'Hydrate');
  assert.equal(addFollowUpCalls[0].body, 'Drink water before the next deep work block.');
  assert.equal(addFollowUpCalls[0].status, 'active');
  assert.equal(addFollowUpCalls[0].sourceKind, 'reminder');
  assert.equal(addFollowUpCalls[0].sourceId, 'reminder-1');
  assert.deepEqual(JSON.parse(JSON.stringify(addFollowUpCalls[0].sourceMeta)), {
    reminderId: 'reminder-1',
  });
});

test('renderer home edit form reuses the add surface for active loops and can retime them', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: buildCompanionState({
          followUps: [
            {
              id: 'followup-1',
              label: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              createdAt: '2026-03-19T12:00:00.000Z',
              updatedAt: '2026-03-19T12:00:00.000Z',
              sessionId: 'session-1',
              status: 'active',
            },
          ],
        }),
      },
    },
  });
  const { window, shell } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    window.document.querySelector('[data-companion-action-id="edit_follow_up:followup-1"]').click();
    await waitForUi(window, 20);

    assert.equal(window.document.getElementById('homeOpenLoopFormHeading').textContent, 'Edit Open Loop');
    assert.match(window.document.getElementById('homeOpenLoopFormNote').textContent, /adjust details or timing/i);
    assert.equal(window.document.getElementById('homeOpenLoopTitleInput').value, 'Review the migration');
    assert.equal(window.document.getElementById('homeOpenLoopDeferSelect').disabled, false);

    window.document.getElementById('homeOpenLoopTitleInput').value = 'Review the rollout';
    window.document.getElementById('homeOpenLoopNotesInput').value = 'Circle back tomorrow.';
    window.document.getElementById('homeOpenLoopDeferSelect').value = 'tomorrow';
    window.document.getElementById('homeOpenLoopSaveButton').click();
    await waitForUi(window, 40);

    assert.equal(shell.__state.companionCalls.updateFollowUp.length, 1);
    assert.equal(shell.__state.companionCalls.updateFollowUp[0].id, 'followup-1');
    assert.equal(shell.__state.companionCalls.updateFollowUp[0].patch.label, 'Review the rollout');
    assert.equal(shell.__state.companionCalls.updateFollowUp[0].patch.body, 'Circle back tomorrow.');
    assert.equal(shell.__state.companionCalls.updateFollowUp[0].patch.status, 'deferred');
    assert.equal(shell.__state.companionCalls.updateFollowUp[0].patch.deferPreset, 'tomorrow');
    assert.match(window.document.getElementById('homeDeferredLoopList').textContent, /Review the rollout/i);
    assert.equal(window.document.getElementById('homeOpenLoopForm').hidden, true);
  } finally {
    await app.dispose();
  }
});

test('renderer home resolved edit disables timing and shows loop history', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: buildCompanionState({
          openLoopsBoard: {
            active: [],
            deferred: [],
            recentResolved: [
              {
                id: 'followup:followup-1',
                kind: 'follow_up',
                status: 'resolved',
                title: 'Review the migration',
                body: 'Ask if the migration still needs a final check.',
                followUpId: 'followup-1',
                timingLabel: 'Completed 3/19/2026, 7:20:00 AM',
                history: [
                  {
                    kind: 'resolved',
                    at: '2026-03-19T12:20:00.000Z',
                    detail: 'Marked complete.',
                  },
                ],
                actions: [
                  {
                    id: 'edit_follow_up:followup-1',
                    type: 'edit_follow_up',
                    label: 'Edit',
                    followUpId: 'followup-1',
                  },
                  {
                    id: 'activate_follow_up:followup-1',
                    type: 'activate_follow_up',
                    label: 'Reopen',
                    followUpId: 'followup-1',
                  },
                  {
                    id: 'archive_follow_up:followup-1',
                    type: 'archive_follow_up',
                    label: 'Archive',
                    followUpId: 'followup-1',
                  },
                ],
              },
            ],
            archived: [],
            counts: {
              active: 0,
              deferred: 0,
              recentResolved: 1,
              archived: 0,
            },
          },
        }),
      },
    },
  });
  const { window } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    assert.match(window.document.getElementById('homeRecentResolvedList').textContent, /History \(1\)/);
    assert.match(window.document.getElementById('homeRecentResolvedList').textContent, /Marked complete\./);

    window.document.querySelector('[data-companion-action-id="edit_follow_up:followup-1"]').click();
    await waitForUi(window, 20);

    assert.match(window.document.getElementById('homeOpenLoopFormNote').textContent, /completed loops keep their current status/i);
    assert.equal(window.document.getElementById('homeOpenLoopDeferSelect').disabled, true);
  } finally {
    await app.dispose();
  }
});

test('renderer home archive and restore move loops between recently completed and archived', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: buildCompanionState({
          followUps: [
            {
              id: 'followup-1',
              label: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              createdAt: '2026-03-19T12:00:00.000Z',
              updatedAt: '2026-03-19T12:20:00.000Z',
              resolvedAt: '2026-03-19T12:20:00.000Z',
              sessionId: 'session-1',
              status: 'resolved',
            },
          ],
        }),
      },
    },
  });
  const { window, shell } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    assert.equal(window.document.getElementById('homeArchivedLoopList').hidden, true);
    window.document.querySelector('[data-companion-action-id="archive_follow_up:followup-1"]').click();
    await waitForUi(window, 40);

    assert.deepEqual(shell.__state.companionCalls.archiveFollowUp, ['followup-1']);
    assert.equal(window.document.getElementById('homeArchivedLoopCount').textContent, '1');
    assert.match(window.document.getElementById('homeArchivedLoopStatus').textContent, /1 archived\./i);
    assert.match(window.document.getElementById('homeRecentResolvedStatus').textContent, /nothing closed yet/i);

    window.document.getElementById('homeArchivedLoopToggle').click();
    await waitForUi(window, 20);

    assert.equal(window.document.getElementById('homeArchivedLoopList').hidden, false);
    assert.match(window.document.getElementById('homeArchivedLoopList').textContent, /Review the migration/i);
    assert.match(window.document.getElementById('homeArchivedLoopList').textContent, /Restore/i);

    window.document.querySelector('[data-companion-action-id="unarchive_follow_up:followup-1"]').click();
    await waitForUi(window, 40);

    assert.deepEqual(shell.__state.companionCalls.unarchiveFollowUp, ['followup-1']);
    assert.match(window.document.getElementById('homeRecentResolvedList').textContent, /Review the migration/i);
  } finally {
    await app.dispose();
  }
});

test('renderer home save button surfaces a shell error when open-loop save fails', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        async addFollowUp() {
          throw new Error('save failed');
        },
      },
    },
  });
  const { window, shell } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    window.document.getElementById('homeOpenLoopAddButton').click();
    await waitForUi(window, 20);
    window.document.getElementById('homeOpenLoopTitleInput').value = 'Check the rollout';
    window.document.getElementById('homeOpenLoopSaveButton').click();
    await waitForUi(window, 40);

    assert.equal(shell.__state.companionCalls.addFollowUp.length, 1);
    assert.match(window.document.getElementById('toastViewport').textContent || '', /Open Loop Failed/i);
    assert.match(window.document.getElementById('toastViewport').textContent || '', /save failed/i);
    assert.equal(window.document.getElementById('homeOpenLoopForm').hidden, false);
  } finally {
    await app.dispose();
  }
});

test('renderer home defer picker surfaces a shell error when the defer mutation fails', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: buildCompanionState({
          followUps: [
            {
              id: 'followup-1',
              label: 'Review the migration',
              body: 'Ask if the migration still needs a final check.',
              createdAt: '2026-03-19T12:00:00.000Z',
              updatedAt: '2026-03-19T12:00:00.000Z',
              sessionId: 'session-1',
              status: 'active',
            },
          ],
          availableDeferPresets: [
            { preset: 'tomorrow', label: 'Tomorrow', deferredUntil: '2026-03-20T09:00:00.000Z' },
          ],
        }),
        async deferFollowUp() {
          throw new Error('defer failed');
        },
      },
    },
  });
  const { window, shell } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    window.document.querySelector('[data-companion-action-id="defer_follow_up:followup-1"]').click();
    await waitForUi(window, 30);
    window.document.querySelector('[data-toast-action-id="defer:followup-1:tomorrow"]').click();
    await waitForUi(window, 40);

    assert.deepEqual(shell.__state.companionCalls.deferFollowUp, [
      { id: 'followup-1', preset: 'tomorrow' },
    ]);
    assert.match(window.document.getElementById('toastViewport').textContent || '', /Open Loop Failed/i);
    assert.match(window.document.getElementById('toastViewport').textContent || '', /defer failed/i);
    assert.match(window.document.getElementById('homeOpenLoopList').textContent, /Review the migration/i);
  } finally {
    await app.dispose();
  }
});

