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

// "slot:type" per action, in display order.
function slotPlan(loop) {
  return (loop?.actions || []).map((action) => `${action.slot}:${action.type}`);
}

function boardService({ taskBoardEnabled = false, workspaceState = {} } = {}) {
  const service = new CompanionService({
    configService: createConfigService(),
    nowProvider: () => new Date('2026-03-19T12:00:00.000Z'),
    formatDateKey,
    taskBoardEnabled: () => taskBoardEnabled,
  });
  return {
    build: (followUps, sessions = null) => service._buildFollowUpBoard({ followUps }, sessions, workspaceState),
  };
}

const LOOP_FIXTURES = [
  { id: 'loop-active', label: 'Active', status: 'active', sessionId: 'session-1', updatedAt: '2026-03-19T10:00:00.000Z' },
  {
    id: 'loop-deferred', label: 'Deferred', status: 'deferred', sessionId: 'session-1',
    deferPreset: 'tomorrow', deferredUntil: '2026-03-20T09:00:00.000Z',
  },
  { id: 'loop-resolved', label: 'Resolved', status: 'resolved', sessionId: 'session-1', resolvedAt: '2026-03-19T11:00:00.000Z' },
  {
    id: 'loop-archived', label: 'Archived', status: 'resolved', sessionId: 'session-1',
    resolvedAt: '2026-03-19T09:00:00.000Z', archivedAt: '2026-03-19T09:30:00.000Z',
  },
];

function everyBoardLoop(board) {
  return [...board.active, ...board.deferred, ...board.recentResolved, ...board.archived];
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
    listSessionSummaries: () => null,
    nowProvider: () => new Date('2026-03-19T09:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.openLoopsBoard.active.length, 1);
  assert.equal(payload.openLoopsBoard.active[0].kind, 'follow_up');
  // No session store attached (null list) must not hide Resume.
  assert.deepEqual(payload.openLoopsBoard.active[0].actions[0], {
    id: 'continue_follow_up:followup-1',
    type: 'continue_session',
    label: 'Resume thread',
    labelKey: 'companion.actions.resumeThread',
    slot: 'primary',
    followUpId: 'followup-1',
    sessionId: 'session-1',
  });
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
    labelKey: 'companion.actions.startSession',
    slot: 'primary',
    followUpId: 'task-1',
  }]);
  assert.deepEqual(slotPlan(enabledLoop), [
    'primary:start_task_session',
    'inline:resolve_follow_up',
    'inline:defer_follow_up',
    'overflow:edit_follow_up',
    'overflow:delete_follow_up',
  ]);
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

  assert.deepEqual(slotPlan(loop), [
    'primary:continue_session',
    'inline:resolve_follow_up',
    'inline:defer_follow_up',
    'overflow:edit_follow_up',
    'overflow:delete_follow_up',
  ]);
  assert.equal(loop.actions[0].label, 'Resume thread');
  assert.equal(loop.actions[1].label, 'Done');
  assert.equal(loop.actions[1].labelKey, 'companion.actions.done');
  assert.equal(loop.actions[2].label, 'Later');
});

test('board actions follow the slot-per-status table', () => {
  const board = boardService().build(LOOP_FIXTURES, [{ id: 'session-1', title: 'Thread' }]);

  assert.deepEqual(slotPlan(board.active[0]), [
    'primary:continue_session',
    'inline:resolve_follow_up',
    'inline:defer_follow_up',
    'overflow:edit_follow_up',
    'overflow:delete_follow_up',
  ]);
  assert.deepEqual(slotPlan(board.deferred[0]), [
    'primary:activate_follow_up',
    'inline:continue_session',
    'overflow:edit_follow_up',
    'overflow:delete_follow_up',
  ]);
  assert.equal(findAction(board.deferred[0], 'activate_follow_up').label, 'Make active');
  assert.equal(findAction(board.deferred[0], 'activate_follow_up').labelKey, 'companion.actions.makeActive');
  assert.deepEqual(slotPlan(board.recentResolved[0]), [
    'inline:activate_follow_up',
    'inline:continue_session',
    'overflow:edit_follow_up',
    'overflow:archive_follow_up',
    'overflow:delete_follow_up',
  ]);
  assert.equal(findAction(board.recentResolved[0], 'activate_follow_up').label, 'Reopen');
  assert.equal(findAction(board.recentResolved[0], 'activate_follow_up').labelKey, 'companion.actions.reopen');
  assert.deepEqual(slotPlan(board.archived[0]), [
    'inline:unarchive_follow_up',
    'inline:continue_session',
    'overflow:edit_follow_up',
    'overflow:delete_follow_up',
  ]);
  assert.equal(findAction(board.archived[0], 'unarchive_follow_up').labelKey, 'companion.actions.restore');
});

test('board keeps the legacy action id formats', () => {
  const board = boardService({ taskBoardEnabled: true }).build(
    LOOP_FIXTURES.map((loop) => ({ ...loop, sourceKind: 'agent_task' }))
  );
  const ids = new Set(everyBoardLoop(board).flatMap((loop) => loop.actions.map((action) => action.id)));
  for (const expected of [
    'continue_follow_up:loop-active',
    'resolve_follow_up:loop-active',
    'defer_follow_up:loop-active',
    'start_task_session:loop-active',
    'activate_follow_up:loop-deferred',
    'activate_follow_up:loop-resolved',
    'archive_follow_up:loop-resolved',
    'unarchive_follow_up:loop-archived',
    'edit_follow_up:loop-archived',
    'delete_follow_up:loop-archived',
  ]) {
    assert.ok(ids.has(expected), expected);
  }
});

test('agent-task loops place Start a new session in overflow behind Resume, never on archived loops', () => {
  const board = boardService({ taskBoardEnabled: true }).build(
    LOOP_FIXTURES.map((loop) => ({ ...loop, sourceKind: 'agent_task' }))
  );
  const overflowStart = {
    type: 'start_task_session',
    slot: 'overflow',
    label: 'Start a new session',
    labelKey: 'companion.actions.startNewSession',
  };
  for (const loop of [board.active[0], board.deferred[0], board.recentResolved[0]]) {
    const { type, slot, label, labelKey } = findAction(loop, 'start_task_session');
    assert.deepEqual({ type, slot, label, labelKey }, overflowStart, loop.status);
  }
  assert.equal(board.active[0].actions[0].type, 'continue_session');
  assert.equal(findAction(board.archived[0], 'start_task_session'), null);
});

test('board emits each action at most once per loop for every status', () => {
  for (const taskBoardEnabled of [false, true]) {
    const board = boardService({ taskBoardEnabled }).build(
      LOOP_FIXTURES.map((loop) => ({ ...loop, sourceKind: 'agent_task' }))
    );
    const loops = everyBoardLoop(board);
    assert.equal(loops.length, 4);
    for (const loop of loops) {
      const ids = loop.actions.map((action) => action.id);
      const types = loop.actions.map((action) => action.type);
      assert.equal(new Set(ids).size, ids.length, `${loop.status} ids ${ids}`);
      assert.equal(new Set(types).size, types.length, `${loop.status} types ${types}`);
    }
  }
});

test('resolved and archived loops have no primary action', () => {
  const board = boardService().build(LOOP_FIXTURES);
  for (const loop of [...board.recentResolved, ...board.archived]) {
    assert.equal(loop.actions.some((action) => action.slot === 'primary'), false, loop.status);
  }
  for (const loop of [...board.active, ...board.deferred]) {
    assert.equal(loop.actions.filter((action) => action.slot === 'primary').length, 1, loop.status);
  }
});

test('Resume is omitted when a loaded sessions list lacks the linked session', () => {
  const service = boardService();
  const missing = service.build(LOOP_FIXTURES, [{ id: 'session-other', title: 'Other' }]);
  for (const loop of everyBoardLoop(missing)) {
    assert.equal(findAction(loop, 'continue_session'), null, loop.status);
    assert.equal(loop.sessionState, 'missing', loop.status);
    assert.equal(loop.sessionBadge, '');
    assert.equal(loop.contextLine, '');
  }
  assert.deepEqual(slotPlan(missing.active[0]).slice(0, 2), ['primary:resolve_follow_up', 'inline:defer_follow_up']);

  const notLoaded = service.build(LOOP_FIXTURES, null);
  for (const loop of everyBoardLoop(notLoaded)) {
    assert.ok(findAction(loop, 'continue_session'), loop.status);
    assert.equal(loop.sessionState, 'saved', loop.status);
  }

  // An empty list from an attached store is authoritative: every session is gone.
  const emptyStore = service.build(LOOP_FIXTURES, []);
  for (const loop of everyBoardLoop(emptyStore)) {
    assert.equal(findAction(loop, 'continue_session'), null, loop.status);
    assert.equal(loop.sessionState, 'missing', loop.status);
  }
});

test('Resume follows sessionState so the badge and the action never disagree', () => {
  const board = boardService({
    workspaceState: { activeSessionId: 'session-current', openSessionIds: ['session-current', 'session-open'] },
  }).build([
    // Current/open sessions absent from a loaded list still show their badge.
    { id: 'current', status: 'active', sessionId: 'session-current', updatedAt: '2026-03-19T11:04:00.000Z' },
    { id: 'open', status: 'active', sessionId: 'session-open', updatedAt: '2026-03-19T11:03:00.000Z' },
    { id: 'saved', status: 'active', sessionId: 'session-saved', updatedAt: '2026-03-19T11:02:00.000Z' },
    { id: 'gone', status: 'active', sessionId: 'session-gone', updatedAt: '2026-03-19T11:01:00.000Z' },
    { id: 'none', status: 'active', updatedAt: '2026-03-19T11:00:00.000Z' },
  ], [{ id: 'session-saved', title: 'Saved' }]);

  assert.deepEqual(
    board.active.map((loop) => [loop.followUpId, loop.sessionState, Boolean(findAction(loop, 'continue_session'))]),
    [
      ['current', 'current', true],
      ['open', 'open', true],
      ['saved', 'saved', true],
      ['gone', 'missing', false],
      ['none', '', false],
    ]
  );
});

test('overlapping getState calls each build the board from their own session list', async () => {
  const lists = [null, []];
  const service = new CompanionService({
    configService: createConfigService({
      followUps: [{ id: 'loop-1', label: 'Linked', status: 'active', sessionId: 'session-1' }],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => lists.shift(),
    nowProvider: () => new Date('2026-03-19T12:00:00.000Z'),
    formatDateKey,
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const realCache = service.briefingCache;
  service.briefingCache = {
    async getSnapshot(args) {
      await gate;
      return realCache.getSnapshot(args);
    },
  };

  // The first call sees no store (null), the second an authoritative empty list.
  const first = service.getState();
  const second = service.getState();
  release();
  const [unknownList, emptyList] = await Promise.all([first, second]);

  assert.equal(unknownList.openLoopsBoard.active[0].sessionState, 'saved');
  assert.ok(findAction(unknownList.openLoopsBoard.active[0], 'continue_session'));
  assert.equal(emptyList.openLoopsBoard.active[0].sessionState, 'missing');
  assert.equal(findAction(emptyList.openLoopsBoard.active[0], 'continue_session'), null);
  assert.equal(Object.prototype.hasOwnProperty.call(service, '_sessionListKnown'), false);
});

test('companion service keeps loops whose session was deleted out of the ready-to-resume card', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      followUps: [
        {
          id: 'followup-gone',
          label: 'Deleted thread loop',
          createdAt: '2026-03-19T09:00:00.000Z',
          updatedAt: '2026-03-19T09:00:00.000Z',
          status: 'active',
          sessionId: 'session-deleted',
        },
        {
          id: 'followup-gone-due',
          label: 'Due deleted thread loop',
          createdAt: '2026-03-19T08:00:00.000Z',
          updatedAt: '2026-03-19T08:00:00.000Z',
          status: 'deferred',
          deferPreset: 'later_today',
          deferredUntil: '2026-03-19T08:30:00.000Z',
          sessionId: 'session-deleted',
        },
        {
          id: 'followup-live',
          label: 'Live thread loop',
          createdAt: '2026-03-19T07:00:00.000Z',
          updatedAt: '2026-03-19T07:00:00.000Z',
          status: 'active',
          sessionId: 'session-live',
        },
      ],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => ([{ id: 'session-live', title: 'Live session' }]),
    nowProvider: () => new Date('2026-03-19T09:30:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();
  const readyToResume = payload.todayCards.find((card) => card.id === 'ready-to-resume');

  assert.equal(
    payload.openLoopsBoard.active.filter((loop) => loop.sessionState === 'missing').length,
    2,
    'fixture must include loops whose session is missing'
  );
  assert.deepEqual(readyToResume.items.map((item) => item.label), ['Live thread loop']);
});

test('board items carry sessionState, resolvedAt and guarded timing labels', () => {
  const board = boardService({
    workspaceState: { activeSessionId: 'session-current', openSessionIds: ['session-current', 'session-open'] },
  }).build([
    { id: 'current', status: 'active', sessionId: 'session-current', updatedAt: '2026-03-19T11:04:00.000Z' },
    { id: 'open', status: 'active', sessionId: 'session-open', updatedAt: '2026-03-19T11:03:00.000Z' },
    { id: 'saved', status: 'active', sessionId: 'session-saved', updatedAt: '2026-03-19T11:02:00.000Z' },
    { id: 'gone', status: 'active', sessionId: 'session-gone', updatedAt: '2026-03-19T11:01:00.000Z' },
    { id: 'none', status: 'active', updatedAt: '2026-03-19T11:00:00.000Z' },
    { id: 'done', status: 'resolved', resolvedAt: '2026-03-19T10:00:00.000Z' },
    { id: 'archived-bad', status: 'resolved', resolvedAt: 'nope', archivedAt: 'not-a-date' },
  ], [
    { id: 'session-current', title: 'Current' },
    { id: 'session-open', title: 'Open' },
    { id: 'session-saved', title: 'Saved' },
  ]);

  assert.deepEqual(
    board.active.map((loop) => [loop.followUpId, loop.sessionState, loop.sessionBadge, loop.contextLine]),
    [
      ['current', 'current', 'Current session', ''],
      ['open', 'open', 'Open session', 'Open'],
      ['saved', 'saved', 'Saved from session', 'Saved'],
      ['gone', 'missing', '', ''],
      ['none', '', '', ''],
    ]
  );
  assert.equal(board.recentResolved[0].resolvedAt, '2026-03-19T10:00:00.000Z');
  assert.match(board.recentResolved[0].timingLabel, /^Completed /);
  assert.equal(board.active[0].resolvedAt, '');
  assert.equal(board.archived[0].timingLabel, 'Archived');
  for (const loop of everyBoardLoop(board)) {
    assert.doesNotMatch(loop.timingLabel, /Invalid Date/);
    assert.equal(Object.prototype.hasOwnProperty.call(loop, 'sourceLabel'), false);
  }
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
  assert.equal(findAction(payload.openLoopsBoard.recentResolved[0], 'edit_follow_up')?.slot, 'overflow');
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
  assert.equal(payload.openLoopsBoard.deferred[0].actions[0].type, 'activate_follow_up');
  assert.equal(payload.openLoopsBoard.deferred[0].actions[0].slot, 'primary');
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

test('companion service returns every recently completed follow-up newest first with the full count', async () => {
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

  // The renderer shows the newest five and offers "Show all"; the service
  // returns them all.
  assert.equal(payload.openLoopsBoard.recentResolved.length, 6);
  assert.equal(payload.openLoopsBoard.counts.recentResolved, 6);
  assert.deepEqual(
    payload.openLoopsBoard.recentResolved.map((loop) => loop.title),
    ['Resolved 6', 'Resolved 5', 'Resolved 4', 'Resolved 3', 'Resolved 2', 'Resolved 1']
  );
  assert.equal(payload.openLoopsBoard.recentResolved[0].actions[0].type, 'activate_follow_up');
  assert.equal(findAction(payload.openLoopsBoard.recentResolved[0], 'activate_follow_up')?.label, 'Reopen');
  assert.ok(
    payload.openLoopsBoard.recentResolved[4].actions.some((action) => action.type === 'delete_follow_up')
  );
});

test('recently completed follow-ups cap at the archive bound while the count stays total', () => {
  const followUps = Array.from({ length: 55 }, (_, index) => ({
    id: `resolved-${index}`,
    status: 'resolved',
    resolvedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  const board = boardService().build(followUps);
  assert.equal(board.recentResolved.length, 50);
  assert.equal(board.recentResolved[0].followUpId, 'resolved-54');
  assert.equal(board.counts.recentResolved, 55);
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
