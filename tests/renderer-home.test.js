const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

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

test('renderer home tab renders local companion information and today cards without sending chat', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: buildCompanionState({
          briefing: {
            dateKey: '2026-03-19',
            dateLabel: 'Thursday, March 19',
            timeZone: 'America/Chicago',
            items: [
              { id: 'workspace', label: 'Workspace', value: 'Workspace root is configured.' },
              { id: 'git', label: 'Git Snapshot', value: 'Git: branch main; 3 changed, 1 staged, 0 untracked.' },
            ],
          },
          todayCards: [
            {
              id: 'recent-commitments',
              title: 'Recent Activity',
              items: [
                {
                  label: 'Ship Slice C',
                  detail: 'Update Companion Home today cards and suggested actions.',
                },
              ],
            },
            {
              id: 'active-sessions',
              title: 'Open Sessions',
              items: [
                {
                  label: 'Current workspace thread',
                  detail: '',
                },
              ],
            },
          ],
          reminders: [
            {
              id: 'rem-1',
              label: 'Morning check-in',
              prompt: 'Ask what matters most today.',
              scheduleLabel: 'Daily at 09:00',
              firedToday: false,
              lastFiredAt: '',
            },
          ],
          openLoops: [
            {
              id: 'loop-1',
              kind: 'reminder',
              title: 'Morning check-in',
              body: 'Ask what matters most today.',
              action: {
                id: 'settings:proactive',
                type: 'open_settings',
                label: 'Open Proactive Settings',
                section: 'proactive',
              },
            },
          ],
          suggestedActions: [
            {
              id: 'prefill:planner',
              type: 'prefill_chat',
              label: 'Start in Planner Mode',
              prompt: 'Help me turn today into a simple plan with the right next steps.',
            },
          ],
          workspaceSnapshot: {
            workspaceRoot: 'G:/workspace/project',
            workspaceRootStatus: {
              state: 'ready',
              message: 'Workspace root is configured.',
            },
            activeSessionId: '',
            openSessionIds: [],
            sessionCount: 1,
          },
        }),
      },
    },
  });
  const { window, shell } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 40);

    assert.equal(window.__rendererState.ui.activeView, 'home');

    /* The hero, presence stage, Briefing, Momentum, and Check-ins rail panels
     * are gone — the dashboard grid owns the surface now. */
    assert.equal(window.document.querySelector('.home-hero'), null);
    assert.equal(window.document.getElementById('homePresenceCanvas'), null);
    assert.equal(window.document.getElementById('homeBriefingList'), null);
    assert.equal(window.document.getElementById('homeTodayCards'), null);
    assert.equal(window.document.getElementById('homeReminderList'), null);

    const infoStrip = window.document.getElementById('homeInfoStrip');
    assert.equal(infoStrip.hidden, false);
    assert.match(infoStrip.querySelector('.home-info-strip__time').textContent, /\d{1,2}:\d{2} (AM|PM)/);
    assert.ok(infoStrip.querySelector('.home-info-strip__greeting').textContent.length > 0);

    const grid = window.document.getElementById('homeDashboardGrid');
    const cardIds = [...grid.children].map((card) => card.dataset.widgetId);
    // The Daybook cut retired resources / model-status / workspace-git /
    // scheduler / recent-sessions / reminders / links, and owner feedback wave 2
    // retired the Tests (test-runner) card too — the Workspace IDE's test-runner
    // panel is the only surface for it now, so Home registers no flag-gated
    // widget at all (registry flag-gating stays covered by
    // tests/renderer-dashboard.test.js).
    // scratchpad is registered FIRST but carries slot:'rail', so it paints into
    // the rail column, not the main grid.
    assert.deepEqual(cardIds, [
      'calendar',
      'open-loops',
    ]);
    const rail = window.document.getElementById('homeDashboardRail');
    assert.deepEqual(
      [...rail.children].map((card) => card.dataset.widgetId),
      ['scratchpad'],
      'the pad lives in the Daybook rail'
    );
    // The rail resizer and its corner grip are SIBLINGS of the rail, never
    // children — the registry's orphan sweep would evict them from inside it.
    const daybook = window.document.getElementById('homeDaybook');
    assert.equal(window.document.getElementById('homeRailResizer').parentNode, daybook);
    assert.equal(window.document.getElementById('homeRailGrip').parentNode, daybook);
    assert.equal(daybook.style.getPropertyValue('--home-rail-width'), '360px');

    // The hero ask pill is built once inside the strip's own region, outside
    // the chrome the 30s clock repaint rewrites.
    const askPill = window.document.getElementById('homeAskPill');
    assert.ok(askPill, 'the strip renders the ask field');
    // W10: Enter is a real send, so the label has to say so. W13 added the
    // newline and draft-only keys, and the whole contract rides the accessible
    // name because the visible hint is revealed by CSS on focus alone.
    assert.equal(
      askPill.getAttribute('aria-label'),
      'Ask Jenny. Enter starts a new chat and sends; Shift plus Enter adds a new line; '
        + 'Control or Command plus Enter drafts without sending.'
    );
    // W13: a real multi-line field, and NOT capped - a 900-character paste used
    // to lose 400 characters with no signal.
    assert.equal(askPill.tagName, 'TEXTAREA');
    assert.equal(askPill.hasAttribute('maxlength'), false);
    assert.equal(askPill.dataset.homeAskInput, '1');
    assert.ok(
      infoStrip.querySelector('.home-info-strip__chrome').contains(
        infoStrip.querySelector('.home-info-strip__time')
      ),
      'clock lives in the repainted chrome'
    );
    assert.equal(infoStrip.querySelector('.home-info-strip__chrome').contains(askPill), false);

    /* The companion-era Jenny panel (mode selector + suggested actions) is
     * retired; companion handoffs now ride the reminders widget. */
    assert.equal(window.document.getElementById('homeCompanionActionsPanel'), null);
    assert.equal(window.document.getElementById('homeModeSelector'), null);
    assert.equal(window.document.getElementById('homeSuggestedActions'), null);

    /* The Open Loops panel is adopted into its card with companion rendering
     * intact. */
    const loopsCard = grid.querySelector('[data-widget-id="open-loops"]');
    assert.ok(loopsCard.contains(window.document.getElementById('homeOpenLoopsPanel')));
    assert.equal(window.document.querySelector('.home-panel--board h3')?.textContent, 'Open Loops');

    assert.equal(shell.__state.chatCalls.length, 0);
  } finally {
    await app.dispose();
  }
});

test('renderer home prefers the canonical board payload and renders metadata badges with compact copy', async () => {
  const app = await loadRendererApp({
    shell: {
      companion: {
        state: buildCompanionState({
          openLoops: [
            {
              id: 'legacy-loop',
              kind: 'follow_up',
              status: 'active',
              title: 'Legacy alias loop',
              body: 'This should stay hidden when the board is present.',
              actions: [],
            },
          ],
          openLoopsBoard: {
            active: [
              {
                id: 'followup:board-active',
                kind: 'follow_up',
                status: 'active',
                title: 'Board active loop',
                body: 'Needs a compact metadata row.',
                followUpId: 'board-active',
                sessionId: 'session-2',
                sessionTitle: 'Artifacts planning',
                sessionBadge: 'Open session',
                sourceBadge: 'Assistant reply',
                contextLine: 'Artifacts planning',
                timingLabel: 'Due now',
                isDue: true,
                actions: [
                  {
                    id: 'resolve_follow_up:board-active',
                    type: 'resolve_follow_up',
                    label: 'Done',
                    followUpId: 'board-active',
                  },
                ],
              },
            ],
            deferred: [
              {
                id: 'followup:board-deferred',
                kind: 'follow_up',
                status: 'deferred',
                title: 'Board deferred loop',
                body: 'Returns later.',
                followUpId: 'board-deferred',
                sessionBadge: '',
                sourceBadge: 'Manual',
                contextLine: '',
                deferredUntil: '2026-03-20T09:00:00.000Z',
                timingLabel: 'Deferred until 3/20/2026, 4:00:00 AM',
                actions: [
                  {
                    id: 'activate_follow_up:board-deferred',
                    type: 'activate_follow_up',
                    label: 'Make Active',
                    followUpId: 'board-deferred',
                  },
                ],
              },
            ],
            recentResolved: [
              {
                id: 'followup:board-resolved',
                kind: 'follow_up',
                status: 'resolved',
                title: 'Board resolved loop',
                body: 'Recently completed.',
                followUpId: 'board-resolved',
                sessionId: 'session-3',
                sessionTitle: 'Closed planning session',
                sessionBadge: 'Saved from session',
                sourceBadge: 'Proactive suggestion',
                contextLine: 'Closed planning session',
                timingLabel: 'Completed 3/19/2026, 7:20:00 AM',
                actions: [
                  {
                    id: 'activate_follow_up:board-resolved',
                    type: 'activate_follow_up',
                    label: 'Reopen',
                    followUpId: 'board-resolved',
                  },
                ],
              },
            ],
            counts: {
              active: 1,
              deferred: 1,
              recentResolved: 1,
            },
          },
          openLoopSummary: {
            activeCount: 99,
            deferredCount: 77,
          },
          suggestedActions: [
            {
              id: 'prefill:planner',
              type: 'prefill_chat',
              label: 'Start in Planner Mode',
              prompt: 'Plan the next steps.',
            },
          ],
        }),
      },
    },
  });
  const { window } = app;

  try {
    window.document.getElementById('homeTopRailTab').click();
    await waitForUi(window, 30);

    assert.equal(window.document.getElementById('homeOpenLoopStatus').textContent, '1 active, 1 due now.');
    assert.equal(window.document.getElementById('homeDeferredSection').hidden, false);
    assert.equal(window.document.getElementById('homeDeferredLoopStatus').textContent, '1 deferred. Returns here when due.');
    assert.equal(window.document.getElementById('homeRecentResolvedSection').hidden, false);
    assert.equal(window.document.getElementById('homeRecentResolvedStatus').textContent, '');
    assert.doesNotMatch(window.document.getElementById('homeOpenLoopList').textContent, /Legacy alias loop/);
    assert.match(window.document.getElementById('homeOpenLoopList').textContent, /Board active loop/);
    assert.match(window.document.getElementById('homeDeferredLoopList').textContent, /Board deferred loop/);
    assert.match(window.document.getElementById('homeRecentResolvedList').textContent, /Board resolved loop/);

    const activeItem = window.document.querySelector('#homeOpenLoopList .home-summary-item');
    const activeBadges = [...activeItem.querySelectorAll('.home-loop-badge')].map((node) => node.textContent.trim());
    assert.deepEqual(activeBadges, ['Open session', 'Assistant reply']);
    assert.match(activeItem.textContent, /Artifacts planning/);
    assert.match(activeItem.textContent, /Due now/);

    const deferredItem = window.document.querySelector('#homeDeferredLoopList .home-summary-item');
    const deferredBadges = [...deferredItem.querySelectorAll('.home-loop-badge')].map((node) => node.textContent.trim());
    assert.deepEqual(deferredBadges, ['Manual']);

    const resolvedItem = window.document.querySelector('#homeRecentResolvedList .home-summary-item');
    const resolvedBadges = [...resolvedItem.querySelectorAll('.home-loop-badge')].map((node) => node.textContent.trim());
    assert.deepEqual(resolvedBadges, ['Saved from session', 'Proactive suggestion']);
    assert.match(resolvedItem.textContent, /Closed planning session/);
  } finally {
    await app.dispose();
  }
});

test('renderer home promotes session-linked loops to a primary resume action', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      companion: {
        state: buildCompanionState({
          openLoopsBoard: {
            active: [
              {
                id: 'followup:session-loop',
                kind: 'follow_up',
                status: 'active',
                title: 'Continue release thread',
                body: 'Pick up the original release conversation before closing this.',
                followUpId: 'session-loop',
                sessionId: 'session-7',
                sessionTitle: 'Release thread',
                sessionBadge: 'Saved from session',
                sourceBadge: 'Assistant reply',
                contextLine: 'Release thread',
                actions: [
                  {
                    id: 'edit_follow_up:session-loop',
                    type: 'edit_follow_up',
                    label: 'Edit',
                    followUpId: 'session-loop',
                  },
                  {
                    id: 'continue_follow_up:session-loop',
                    type: 'continue_session',
                    label: 'Resume this thread',
                    sessionId: 'session-7',
                    followUpId: 'session-loop',
                  },
                  {
                    id: 'resolve_follow_up:session-loop',
                    type: 'resolve_follow_up',
                    label: 'Done',
                    followUpId: 'session-loop',
                  },
                  {
                    id: 'defer_follow_up:session-loop',
                    type: 'defer_follow_up',
                    label: 'Later',
                    followUpId: 'session-loop',
                  },
                ],
              },
            ],
            deferred: [],
            recentResolved: [],
            archived: [],
            counts: { active: 1, deferred: 0, recentResolved: 0, archived: 0 },
          },
        }),
      },
    },
  });

  window.document.getElementById('homeTopRailTab').click();
  await waitForUi(window, 30);

  const activeItem = window.document.querySelector('#homeOpenLoopList .home-summary-item');
  const buttons = [...activeItem.querySelectorAll('.btn')];
  assert.deepEqual(buttons.map((button) => button.textContent.trim()), [
    'Edit',
    'Resume this thread',
    'Done',
    'Later',
  ]);
  assert.equal(buttons[1].classList.contains('btn--primary'), true);
  assert.equal(buttons[2].classList.contains('btn--primary'), false);
});

test('renderer home renders agent task source badges through the existing open loops surface', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      companion: {
        state: buildCompanionState({
          openLoopsBoard: {
            active: [
              {
                id: 'followup:agent-task',
                kind: 'follow_up',
                status: 'active',
                title: 'Agent task follow-up',
                body: 'Resume the delegated implementation if it stalls.',
                followUpId: 'agent-task',
                sessionId: 'session-2',
                sessionTitle: 'Delegation session',
                sessionBadge: 'Open session',
                sourceBadge: 'Agent task',
                contextLine: 'Delegation session',
                timingLabel: 'Due now',
                isDue: true,
                actions: [
                  {
                    id: 'resolve_follow_up:agent-task',
                    type: 'resolve_follow_up',
                    label: 'Done',
                    followUpId: 'agent-task',
                  },
                  {
                    id: 'continue_follow_up:agent-task',
                    type: 'continue_session',
                    label: 'Continue Session',
                    sessionId: 'session-2',
                    followUpId: 'agent-task',
                  },
                ],
              },
            ],
            deferred: [],
            recentResolved: [],
            archived: [],
            counts: {
              active: 1,
              deferred: 0,
              recentResolved: 0,
              archived: 0,
            },
          },
        }),
      },
    },
  });

  window.document.getElementById('homeTopRailTab').click();
  await waitForUi(window, 30);

  const activeItem = window.document.querySelector('#homeOpenLoopList .home-summary-item');
  const activeBadges = [...activeItem.querySelectorAll('.home-loop-badge')].map((node) => node.textContent.trim());
  const actionButtons = [...activeItem.querySelectorAll('.btn')].map((node) => node.textContent.trim());

  assert.deepEqual(activeBadges, ['Open session', 'Agent task']);
  assert.match(activeItem.textContent, /Agent task follow-up/);
  assert.match(activeItem.textContent, /Delegation session/);
  assert.deepEqual(actionButtons, ['Done', 'Continue Session']);
});

test('renderer home collapses empty loop subsections to a compact board', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      companion: {
        state: buildCompanionState({
          suggestedActions: [],
        }),
      },
    },
  });

  window.document.getElementById('homeTopRailTab').click();
  await waitForUi(window, 30);

  /* The status line carries the empty-state copy exactly once: empty lists
   * stay empty (no duplicate placeholder item) and empty subsections
   * (Deferred / Recently Completed / Archived) collapse entirely. */
  assert.equal(window.document.getElementById('homeOpenLoopStatus').textContent, 'All loops closed.');
  assert.equal(window.document.getElementById('homeOpenLoopList').textContent, '');
  assert.equal(window.document.getElementById('homeDeferredSection').hidden, true);
  assert.equal(window.document.getElementById('homeRecentResolvedSection').hidden, true);
  assert.equal(window.document.getElementById('homeArchivedSection').hidden, true);
});

test('renderer home shows stable skeletons while companion state hydrates', async (t) => {
  let resolveCompanionState;
  const loadedState = buildCompanionState({
    loaded: true,
    openLoops: [
      {
        id: 'hydrated-loop',
        kind: 'follow_up',
        status: 'active',
        title: 'Hydrated open loop',
        body: 'Rendered after async companion state arrives.',
        actions: [],
      },
    ],
  });
  const { window } = await loadRendererTestApp(t, {
    shell: {
      companion: {
        state: buildCompanionState({ loaded: false }),
        getState() {
          return new Promise((resolve) => {
            resolveCompanionState = () => resolve(loadedState);
          });
        },
      },
    },
  });

  window.document.getElementById('homeTopRailTab').click();
  await waitForUi(window, 20);

  assert.equal(window.document.getElementById('homeOpenLoopList').getAttribute('aria-busy'), 'true');
  assert.ok(
    window.document.querySelectorAll('#homeOpenLoopList .skeleton, #homeDeferredLoopList .skeleton').length > 0,
    'Home should reserve space with skeleton rows while companion state is loading'
  );

  resolveCompanionState();
  await waitForUi(window, 40);

  assert.equal(window.document.getElementById('homeOpenLoopList').hasAttribute('aria-busy'), false);
  assert.equal(window.document.querySelectorAll('#homeOpenLoopList .skeleton, #homeDeferredLoopList .skeleton').length, 0);
  assert.match(window.document.getElementById('homeOpenLoopList').textContent, /Hydrated open loop/);
});

test('renderer home lazily hydrates companion state on first open', async (t) => {
  let companionGetCalls = 0;
  const { window } = await loadRendererTestApp(t, {
    shell: {
      companion: {
        state: buildCompanionState({
          openLoops: [
            {
              id: 'lazy-loop',
              kind: 'follow_up',
              status: 'active',
              title: 'Lazy open loop',
              body: 'This loop should appear after the Home surface initializes.',
              actions: [],
            },
          ],
        }),
        async getState({ state }) {
          companionGetCalls += 1;
          return state.companionState;
        },
      },
    },
  });

  await waitForUi(window, 60);
  assert.equal(companionGetCalls, 0);

  window.document.getElementById('homeTopRailTab').click();
  await waitForUi(window, 40);

  assert.equal(companionGetCalls, 1);
  assert.match(window.document.getElementById('homeOpenLoopList').textContent, /Lazy open loop/);
  assert.match(window.document.getElementById('homeOpenLoopList').textContent, /This loop should appear after the Home surface initializes\./);
});

/* The reminder-action handoff test (and the whole
 * tests/renderer-home-handoff.test.js companion surface) went with the
 * reminders widget in the Daybook cut: every one of those tests reached the
 * companion action router through `[data-companion-action-id]` buttons that
 * only the reminders widget rendered. The router itself is untouched and still
 * covered from the open-loops surface in tests/renderer-home-followups.test.js;
 * the Daybook agenda wave re-opens a Home entry point for reminders. */
