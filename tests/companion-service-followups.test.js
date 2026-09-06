const test = require('node:test');
const assert = require('node:assert/strict');

const { CompanionService, trimSuggestedActions } = require('../services/companion-service');
const { formatDateKey } = require('../services/personality-workspace-service');

function createConfigService(overrides = {}) {
  let state = {
    toolsWorkspaceRoot: '',
    companion: { mode: 'planner' },
    proactive: {
      reminders: [],
    },
    followUps: [],
    ...overrides,
  };
  return {
    getState() {
      return JSON.parse(JSON.stringify(state));
    },
    getWorkspaceState() {
      return {
        activeSessionId: overrides.activeSessionId || '',
        openSessionIds: overrides.openSessionIds || [],
      };
    },
    getWorkspaceRootStatus() {
      return overrides.workspaceRootStatus || {
        state: 'missing',
        message: 'No workspace root is configured yet.',
      };
    },
    setCompanionMode(mode) {
      state = {
        ...state,
        companion: { mode },
      };
      return this.getState();
    },
  };
}

function createPersonalityWorkspace() {
  return {
    async getResolvedTimeZone() {
      return 'America/Chicago';
    },
    async getNotesSnapshot() {
      return { available: true, notes: 'Ship the thin companion slice.' };
    },
  };
}

function findAction(loop, type) {
  return Array.isArray(loop?.actions)
    ? loop.actions.find((action) => action.type === type) || null
    : null;
}

test('companion service includes unresolved follow-ups in open loops', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      followUps: [
        {
          id: 'followup-1',
          label: 'Check release notes',
          body: 'Ask whether the release notes still need edits.',
          createdAt: '2026-03-19T11:00:00.000Z',
          sessionId: 'session-1',
          resolved: false,
        },
      ],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-03-19T09:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.openLoopsBoard.active.length, 1);
  assert.equal(payload.openLoopsBoard.active[0].kind, 'follow_up');
  assert.equal(payload.openLoopsBoard.active[0].actions[0].type, 'edit_follow_up');
  assert.equal(payload.openLoopsBoard.active[0].actions[1].type, 'continue_session');
  assert.equal(payload.openLoopsBoard.active[0].actions[1].label, 'Resume this thread');
  assert.equal(payload.openLoopsBoard.active[0].actions[1].sessionId, 'session-1');
  assert.equal(findAction(payload.openLoopsBoard.active[0], 'resolve_follow_up')?.followUpId, 'followup-1');
  assert.equal(payload.openLoopsBoard.active[0].actions.filter((action) => action.type === 'continue_session').length, 1);
});

test('agent-task rows expose one Start a session action only while task-board flag is on', async () => {
  const configService = createConfigService({
    followUps: [{
      id: 'task-1', label: 'Ship WO-10c', body: 'Keep the brief unsent.',
      status: 'active', sourceKind: 'agent_task', createdAt: '2026-09-04T12:00:00.000Z',
    }],
  });
  const build = async (enabled) => new CompanionService({
    configService,
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-09-04T13:00:00.000Z'),
    formatDateKey,
    taskBoardEnabled: () => enabled,
  }).getState();

  const enabledLoop = (await build(true)).openLoopsBoard.active[0];
  assert.deepEqual(enabledLoop.actions.filter((action) => action.type === 'start_task_session'), [{
    id: 'start_task_session:task-1',
    type: 'start_task_session',
    label: 'Start a session',
    followUpId: 'task-1',
  }]);
  assert.equal(findAction((await build(false)).openLoopsBoard.active[0], 'start_task_session'), null);
});

test('companion service keeps Done reachable after promoting session-linked resume action', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      followUps: [
        {
          id: 'followup-1',
          label: 'Finish runtime notes',
          body: 'Resume the original thread before closing the loop.',
          createdAt: '2026-03-19T11:00:00.000Z',
          sessionId: 'session-1',
          resolved: false,
        },
      ],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [
      {
        id: 'session-1',
        title: 'Runtime review thread',
        last_message_preview: 'Check local runtime timing notes.',
      },
    ],
    nowProvider: () => new Date('2026-03-19T09:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();
  const loop = payload.openLoopsBoard.active[0];

  assert.deepEqual(loop.actions.map((action) => action.type), [
    'edit_follow_up',
    'continue_session',
    'resolve_follow_up',
    'defer_follow_up',
    'delete_follow_up',
  ]);
  assert.equal(loop.actions[1].label, 'Resume this thread');
  assert.equal(loop.actions[2].label, 'Done');
});

test('companion service excludes resolved follow-ups from open loops', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      followUps: [
        {
          id: 'followup-1',
          label: 'Resolved item',
          body: 'This should stay hidden.',
          createdAt: '2026-03-19T11:00:00.000Z',
          sessionId: 'session-1',
          resolved: true,
        },
      ],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-03-19T09:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.openLoopsBoard.active.length, 0);
  assert.equal(payload.openLoopsBoard.recentResolved.length, 1);
  assert.equal(payload.openLoopsBoard.recentResolved[0].actions[0].label, 'Edit');
  assert.equal(findAction(payload.openLoopsBoard.recentResolved[0], 'activate_follow_up')?.label, 'Reopen');
  assert.equal(findAction(payload.openLoopsBoard.recentResolved[0], 'archive_follow_up')?.label, 'Archive');
});

test('companion service separates deferred follow-ups from ready-now open loops', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      followUps: [
        {
          id: 'followup-active',
          label: 'Ready now',
          body: 'Still active.',
          createdAt: '2026-03-19T11:00:00.000Z',
          updatedAt: '2026-03-19T11:00:00.000Z',
          sessionId: 'session-1',
          status: 'active',
        },
        {
          id: 'followup-deferred',
          label: 'Tomorrow',
          body: 'Show me later.',
          createdAt: '2026-03-19T10:00:00.000Z',
          updatedAt: '2026-03-19T10:00:00.000Z',
          sessionId: 'session-1',
          status: 'deferred',
          deferPreset: 'tomorrow',
          deferredUntil: '2026-03-20T09:00:00.000Z',
        },
      ],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-03-19T09:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.openLoopsBoard.active.length, 1);
  assert.equal(payload.openLoopsBoard.active[0].title, 'Ready now');
  assert.equal(payload.openLoopsBoard.deferred.length, 1);
  assert.equal(payload.openLoopsBoard.deferred[0].title, 'Tomorrow');
  assert.equal(payload.openLoopsBoard.deferred[0].actions[0].type, 'edit_follow_up');
  assert.equal(findAction(payload.openLoopsBoard.deferred[0], 'activate_follow_up')?.type, 'activate_follow_up');
  assert.equal(payload.openLoopsBoard.counts.active, 1);
  assert.equal(payload.openLoopsBoard.counts.deferred, 1);
});

test('companion service returns due deferred follow-ups to the active open-loop list', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      followUps: [
        {
          id: 'followup-due',
          label: 'Due now',
          body: 'This defer window expired.',
          createdAt: '2026-03-19T09:00:00.000Z',
          updatedAt: '2026-03-19T09:00:00.000Z',
          sessionId: 'session-1',
          status: 'deferred',
          deferPreset: 'later_today',
          deferredUntil: '2026-03-19T08:30:00.000Z',
        },
      ],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-03-19T09:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.openLoopsBoard.active.length, 1);
  assert.equal(payload.openLoopsBoard.active[0].title, 'Due now');
  assert.equal(payload.openLoopsBoard.deferred.length, 0);
  assert.equal(payload.openLoopsBoard.counts.active, 1);
  assert.equal(payload.openLoopsBoard.counts.deferred, 0);
});

test('companion service sorts due follow-ups ahead of ordinary active follow-ups and keeps reminders separate', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      proactive: {
        reminders: [
          {
            id: 'rem-1',
            label: 'Reminder one',
            prompt: 'First reminder.',
            scheduleType: 'daily_at',
            dailyAt: '09:00',
            enabled: true,
            lastFiredAt: '',
          },
        ],
      },
      followUps: [
        {
          id: 'followup-due',
          label: 'Due follow-up',
          body: 'Due body',
          createdAt: '2026-03-19T10:00:00.000Z',
          updatedAt: '2026-03-19T10:00:00.000Z',
          sessionId: 'session-1',
          status: 'deferred',
          deferPreset: 'later_today',
          deferredUntil: '2026-03-19T08:30:00.000Z',
        },
        {
          id: 'followup-newer',
          label: 'Newer follow-up',
          body: 'Newer body',
          createdAt: '2026-03-19T11:00:00.000Z',
          sessionId: 'session-1',
          resolved: false,
        },
        {
          id: 'followup-third',
          label: 'Third follow-up',
          body: 'Third body',
          createdAt: '2026-03-19T09:00:00.000Z',
          sessionId: 'session-1',
          resolved: false,
        },
      ],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [
      {
        id: 'session-1',
        title: 'Current session',
        updated_at: '2026-03-19T08:00:00.000Z',
        last_message_preview: 'Continue from the prior note.',
        pending_question_batch: null,
        interactive_sequence_state: 'idle',
      },
    ],
    nowProvider: () => new Date('2026-03-19T09:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.reminders.length, 1);
  assert.equal(payload.openLoopsBoard.active.length, 3);
  assert.equal(payload.openLoopsBoard.active[0].title, 'Due follow-up');
  assert.equal(payload.openLoopsBoard.active[0].isDue, true);
  assert.equal(payload.openLoopsBoard.active[1].title, 'Newer follow-up');
  assert.equal(payload.openLoopsBoard.active[2].title, 'Third follow-up');
  assert.equal(payload.openLoopsBoard.counts.active, 3);
});

test('companion service caps recently completed follow-ups to five most recent items', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      followUps: Array.from({ length: 6 }, (_, index) => ({
        id: `followup-${index + 1}`,
        label: `Resolved ${index + 1}`,
        body: `Resolved body ${index + 1}`,
        createdAt: `2026-03-19T0${index}:00:00.000Z`,
        updatedAt: `2026-03-19T0${index}:00:00.000Z`,
        resolvedAt: `2026-03-19T1${index}:00:00.000Z`,
        sessionId: index === 0 ? 'session-1' : '',
        status: 'resolved',
      })),
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => ([
      {
        id: 'session-1',
        title: 'Current session',
        updated_at: '2026-03-19T08:00:00.000Z',
        last_message_preview: 'Continue from the prior note.',
      },
    ]),
    nowProvider: () => new Date('2026-03-19T12:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.openLoopsBoard.recentResolved.length, 5);
  assert.deepEqual(
    payload.openLoopsBoard.recentResolved.map((loop) => loop.title),
    ['Resolved 6', 'Resolved 5', 'Resolved 4', 'Resolved 3', 'Resolved 2']
  );
  assert.equal(payload.openLoopsBoard.recentResolved[0].actions[0].label, 'Edit');
  assert.equal(findAction(payload.openLoopsBoard.recentResolved[0], 'activate_follow_up')?.label, 'Reopen');
  assert.ok(
    payload.openLoopsBoard.recentResolved[4].actions.some((action) => action.type === 'delete_follow_up')
  );
});

test('companion service separates archived follow-ups from compatibility aliases and active counts', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      followUps: [
        {
          id: 'followup-active',
          label: 'Keep visible',
          body: 'Still active.',
          createdAt: '2026-03-19T10:00:00.000Z',
          updatedAt: '2026-03-19T10:00:00.000Z',
          status: 'active',
        },
        {
          id: 'followup-archived',
          label: 'Archived loop',
          body: 'Should only appear in archive.',
          createdAt: '2026-03-19T08:00:00.000Z',
          updatedAt: '2026-03-19T09:00:00.000Z',
          resolvedAt: '2026-03-19T09:30:00.000Z',
          archivedAt: '2026-03-19T10:30:00.000Z',
          status: 'resolved',
          history: [
            {
              kind: 'archived',
              at: '2026-03-19T10:30:00.000Z',
              detail: 'Archived from Home.',
            },
          ],
        },
      ],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-03-19T11:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.openLoopsBoard.active.length, 1);
  assert.equal(payload.openLoopsBoard.active[0].title, 'Keep visible');
  assert.equal(payload.openLoopsBoard.deferred.length, 0);
  assert.equal(payload.openLoopsBoard.counts.active, 1);
  assert.equal(payload.openLoopsBoard.counts.archived, 1);
  assert.equal(payload.openLoopsBoard.archived.length, 1);
  assert.equal(payload.openLoopsBoard.archived[0].title, 'Archived loop');
  assert.equal(payload.openLoopsBoard.archived[0].status, 'archived');
  assert.equal(findAction(payload.openLoopsBoard.archived[0], 'unarchive_follow_up')?.label, 'Restore');
  assert.deepEqual(payload.openLoopsBoard.archived[0].history, [
    {
      kind: 'archived',
      at: '2026-03-19T10:30:00.000Z',
      detail: 'Archived from Home.',
    },
  ]);
});

test('companion service caps archived board items while preserving the full count', () => {
  const companionService = new CompanionService({
    configService: createConfigService(),
    nowProvider: () => new Date('2026-01-01T01:00:00.000Z'),
    formatDateKey,
  });
  const followUps = Array.from({ length: 60 }, (_, index) => ({
    id: `followup-${index}`,
    label: `Archived ${index}`,
    status: 'resolved',
    archivedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));

  const board = companionService._buildFollowUpBoard({ followUps }, [], {});

  assert.equal(board.archived.length, 50);
  assert.deepEqual(
    board.archived.map((followUp) => followUp.id),
    Array.from({ length: 50 }, (_, index) => `followup:followup-${59 - index}`)
  );
  assert.equal(board.counts.archived, 60);
});

test('trimSuggestedActions returns short lists untouched', () => {
  const actions = [
    { id: 'prefill:planner' },
    { id: 'settings:tools' },
    { id: 'memory' },
    { id: 'new-session' },
  ];
  assert.equal(trimSuggestedActions(actions, true), actions);
});

test('trimSuggestedActions drops optional settings before anything else at the cap', () => {
  const actions = [
    { id: 'prefill:planner' },
    { id: 'prefill:planner:secondary:1' },
    { id: 'prefill:planner:secondary:2' },
    { id: 'settings:tools' },
    { id: 'continue:recent' },
    { id: 'memory' },
    { id: 'new-session' },
  ];
  const trimmed = trimSuggestedActions(actions, true);
  assert.deepEqual(trimmed.map((action) => action.id), [
    'prefill:planner',
    'prefill:planner:secondary:1',
    'prefill:planner:secondary:2',
    'settings:tools',
    'continue:recent',
    'new-session',
  ]);
});

test('trimSuggestedActions drops secondary prefills from the end when nothing prunable remains', () => {
  const actions = [
    { id: 'prefill:planner' },
    { id: 'prefill:planner:secondary:1' },
    { id: 'prefill:planner:secondary:2' },
    { id: 'settings:tools' },
    { id: 'continue:a' },
    { id: 'continue:b' },
    { id: 'continue:c' },
    { id: 'continue:d' },
  ];
  const trimmed = trimSuggestedActions(actions, true);
  assert.deepEqual(trimmed.map((action) => action.id), [
    'prefill:planner',
    'settings:tools',
    'continue:a',
    'continue:b',
    'continue:c',
    'continue:d',
  ]);
});

test('trimSuggestedActions final cap keeps the protected recovery action even when it sits past the cap', () => {
  const actions = [
    { id: 'prefill:planner' },
    { id: 'continue:one' },
    { id: 'continue:two' },
    { id: 'continue:three' },
    { id: 'continue:four' },
    { id: 'continue:five' },
    { id: 'continue:six' },
    { id: 'settings:tools' },
  ];
  const trimmed = trimSuggestedActions(actions, true);
  assert.deepEqual(trimmed.map((action) => action.id), [
    'prefill:planner',
    'continue:one',
    'continue:two',
    'continue:three',
    'continue:four',
    'settings:tools',
  ]);
});

test('trimSuggestedActions does not protect settings:tools when the workspace is ready', () => {
  const actions = [
    { id: 'prefill:planner' },
    { id: 'continue:one' },
    { id: 'continue:two' },
    { id: 'continue:three' },
    { id: 'continue:four' },
    { id: 'continue:five' },
    { id: 'continue:six' },
    { id: 'settings:tools' },
  ];
  const trimmed = trimSuggestedActions(actions, false);
  assert.equal(trimmed.length, 6);
  assert.ok(!trimmed.some((action) => action.id === 'settings:tools'));
});
