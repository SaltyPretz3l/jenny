const test = require('node:test');
const assert = require('node:assert/strict');

const { CompanionService } = require('../services/companion-service');
const { buildHomeFocus } = require('../services/companion-home-focus');
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

function createGitExecStub(resolveStdout) {
  const calls = [];
  return {
    calls,
    execFileImpl(_command, argv, _options, callback) {
      const call = argv.slice();
      calls.push(call);
      const stdout = resolveStdout({
        argv: call,
        joined: call.join(' '),
        workspaceRoot: call[1],
      });
      setImmediate(() => callback(null, stdout, ''));
    },
  };
}

function findAction(loop, type) {
  return Array.isArray(loop?.actions)
    ? loop.actions.find((action) => action.type === type) || null
    : null;
}

test('companion service builds local-first state with deterministic open loop order and today cards', async () => {
  const now = new Date('2026-03-19T14:30:00.000Z');
  const configService = createConfigService({
    toolsWorkspaceRoot: 'G:/workspace/project',
    companion: { mode: 'coach' },
    proactive: {
      reminders: [
        {
          id: 'rem-1',
          label: 'Check in',
          prompt: 'Ask what matters most today.',
          enabled: true,
        },
        {
          id: 'rem-2',
          label: 'Second check-in',
          prompt: 'Ask about the afternoon block.',
          enabled: true,
        },
      ],
    },
    activeSessionId: 'session-2',
    openSessionIds: ['session-2'],
    workspaceRootStatus: {
      state: 'ready',
      message: 'Workspace root is configured.',
    },
  });
  const companionService = new CompanionService({
    configService,
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => ([
      {
        id: 'session-1',
        title: 'Interactive planning',
        updated_at: '2026-03-19T14:00:00.000Z',
        last_message_preview: 'Choose what Jenny should focus on first.',
        pending_question_batch: { batch_id: 'ib_1' },
        interactive_sequence_state: 'structured_active',
      },
      {
        id: 'session-2',
        title: 'Current workspace thread',
        updated_at: '2026-03-19T13:00:00.000Z',
        last_message_preview: 'Continue from the artifacts follow-up.',
        pending_question_batch: null,
        interactive_sequence_state: 'idle',
      },
    ]),
    nowProvider: () => now,
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.mode, 'coach');
  assert.equal(payload.modeMeta.label, 'Coach');
  assert.equal(payload.briefing.items[0].label, 'Current Mode');
  assert.match(payload.briefing.items[0].value, /Coach/);
  assert.equal(payload.todayCards.length, 2);
  assert.deepEqual(
    payload.todayCards.map((card) => card.id),
    ['recent-commitments', 'active-sessions']
  );
  assert.equal(payload.todayCards[0].items[0].label, 'Interactive planning');
  assert.equal(payload.todayCards[1].items[0].label, 'Current workspace thread');
  assert.equal(payload.reminders.length, 2);
  assert.equal(payload.openLoopsBoard.active.length, 0);
  assert.equal(payload.openLoopsBoard.counts.active, 0);
  assert.equal(payload.openLoopsBoard.counts.deferred, 0);
  assert.equal(payload.openLoopsBoard.counts.recentResolved, 0);
  assert.deepEqual(
    payload.suggestedActions.map((action) => action.type),
    ['prefill_chat', 'prefill_chat', 'prefill_chat', 'continue_session', 'open_view', 'new_session']
  );
  assert.equal(payload.suggestedActions[4].viewId, 'memory');
});

test('companion state exposes structured workspaceGit alongside the flattened briefing item', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      workspaceRootStatus: { state: 'ready', message: 'Workspace root is configured.' },
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-03-19T14:30:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.deepEqual(
    Object.keys(payload.workspaceGit).sort(),
    ['available', 'branch', 'recentCommits', 'summary']
  );
  assert.equal(typeof payload.workspaceGit.available, 'boolean');
  assert.ok(Array.isArray(payload.workspaceGit.recentCommits));
  // The structured field and the flattened briefing item share one source.
  const gitItem = payload.briefing.items.find((item) => item.id === 'git');
  assert.equal(payload.workspaceGit.summary, gitItem.value);
});

test('companion service recent activity card shows up to 3 sessions in recency order', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      workspaceRootStatus: {
        state: 'ready',
        message: 'Workspace root is configured.',
      },
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => ([
      { id: 'session-4', title: 'Fourth', updated_at: '2026-03-19T11:00:00.000Z', last_message_preview: 'Fourth preview' },
      { id: 'session-3', title: 'Third', updated_at: '2026-03-19T12:00:00.000Z', last_message_preview: 'Third preview' },
      { id: 'session-2', title: 'Second', updated_at: '2026-03-19T13:00:00.000Z', last_message_preview: 'Second preview' },
      { id: 'session-1', title: 'First', updated_at: '2026-03-19T14:00:00.000Z', last_message_preview: 'First preview' },
    ]),
    nowProvider: () => new Date('2026-03-19T14:30:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();
  const recentActivity = payload.todayCards.find((card) => card.id === 'recent-commitments');

  assert.ok(recentActivity);
  assert.deepEqual(
    recentActivity.items.map((item) => item.label),
    ['First', 'Second', 'Third']
  );
});

test('companion service active sessions card shows only open sessions', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      activeSessionId: 'session-2',
      openSessionIds: ['session-2', 'session-4'],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => ([
      { id: 'session-1', title: 'Closed session', updated_at: '2026-03-19T14:00:00.000Z', last_message_preview: 'Closed' },
      { id: 'session-2', title: 'Open session one', updated_at: '2026-03-19T13:00:00.000Z', last_message_preview: 'Open one' },
      { id: 'session-3', title: 'Another closed session', updated_at: '2026-03-19T12:00:00.000Z', last_message_preview: 'Closed again' },
      { id: 'session-4', title: 'Open session two', updated_at: '2026-03-19T11:00:00.000Z', last_message_preview: 'Open two' },
    ]),
    nowProvider: () => new Date('2026-03-19T14:30:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();
  const openSessions = payload.todayCards.find((card) => card.id === 'active-sessions');

  assert.ok(openSessions);
  assert.deepEqual(
    openSessions.items.map((item) => item.label),
    ['Open session one', 'Open session two']
  );
});

test('companion service recent activity ordering tolerates malformed session timestamps', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      workspaceRootStatus: {
        state: 'ready',
        message: 'Workspace root is configured.',
      },
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => ([
      { id: 'session-invalid', title: 'Malformed', updated_at: 'not-a-date', last_message_preview: 'Malformed preview' },
      { id: 'session-newest', title: 'Newest', updated_at: '2026-03-19T14:00:00.000Z', last_message_preview: 'Newest preview' },
      { id: 'session-middle', title: 'Middle', updated_at: '2026-03-19T13:00:00.000Z', last_message_preview: 'Middle preview' },
    ]),
    nowProvider: () => new Date('2026-03-19T14:30:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();
  const recentActivity = payload.todayCards.find((card) => card.id === 'recent-commitments');

  assert.ok(recentActivity);
  assert.deepEqual(
    recentActivity.items.map((item) => item.label),
    ['Newest', 'Middle', 'Malformed']
  );
});

test('companion service surfaces explicit empty states and utility actions when local context is sparse', async () => {
  const companionService = new CompanionService({
    configService: createConfigService(),
    personalityWorkspace: {
      async getResolvedTimeZone() {
        return 'America/Chicago';
      },
    },
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-03-19T08:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.workspaceSnapshot.workspaceRootStatus.state, 'missing');
  assert.deepEqual(payload.todayCards, []);
  assert.equal(payload.reminders.length, 0);
  assert.equal(payload.openLoopsBoard.active.length, 0);
  assert.equal(payload.suggestedActions.length, 6);
  assert.deepEqual(
    payload.suggestedActions.map((action) => action.type),
    ['prefill_chat', 'prefill_chat', 'prefill_chat', 'open_settings', 'open_view', 'new_session']
  );
  assert.deepEqual(
    payload.suggestedActions.filter((action) => action.type === 'open_settings').map((action) => action.section),
    ['tools']
  );
  assert.equal(
    payload.suggestedActions.find((action) => action.id === 'memory')?.viewId,
    'memory'
  );
  assert.match(
    payload.briefing.items.find((item) => item.id === 'workspace')?.value || '',
    /No workspace root/
  );
});

test('companion service caches and coalesces the daily briefing snapshot', async () => {
  const { calls, execFileImpl } = createGitExecStub(({ joined }) => (
    joined.includes('rev-parse')
      ? 'main\n'
      : joined.includes('status')
        ? ' M services/companion-service.js\n?? tests/companion-service.test.js\n'
        : 'abc123 Tighten companion briefing\n'
  ));
  const configService = createConfigService({
    toolsWorkspaceRoot: 'G:/workspace/project',
    workspaceRootStatus: {
      state: 'ready',
      message: 'Workspace root is configured.',
    },
  });
  const companionService = new CompanionService({
    configService,
    personalityWorkspace: createPersonalityWorkspace(),
    execFileImpl,
    nowProvider: () => new Date('2026-03-19T14:30:00.000Z'),
    formatDateKey,
  });

  const [firstPayload, secondPayload] = await Promise.all([
    companionService.getState(),
    companionService.getState(),
  ]);
  const thirdPayload = await companionService.getState();

  assert.equal(calls.length, 3);
  assert.equal(firstPayload.briefing.items.find((item) => item.id === 'git')?.value,
    'Git: branch main; 2 changed, 0 staged, 1 untracked.');
  assert.equal(secondPayload.briefing.items.find((item) => item.id === 'git')?.value,
    firstPayload.briefing.items.find((item) => item.id === 'git')?.value);
  assert.equal(thirdPayload.briefing.items.find((item) => item.id === 'git')?.value,
    firstPayload.briefing.items.find((item) => item.id === 'git')?.value);
});

test('companion service keeps long-term notes fresh while reusing the git snapshot', async () => {
  let notes = 'First note.';
  const { calls, execFileImpl } = createGitExecStub(({ joined }) => (
    joined.includes('rev-parse')
      ? 'main\n'
      : joined.includes('status')
        ? ''
        : 'abc123 Work item\n'
  ));
  const companionService = new CompanionService({
    configService: createConfigService({
      toolsWorkspaceRoot: 'G:/workspace/project',
      workspaceRootStatus: {
        state: 'ready',
        message: 'Workspace root is configured.',
      },
    }),
    personalityWorkspace: {
      async getResolvedTimeZone() {
        return 'America/Chicago';
      },
      async getNotesSnapshot() {
        return { available: Boolean(notes), notes };
      },
    },
    execFileImpl,
    nowProvider: () => new Date('2026-03-19T14:30:00.000Z'),
    formatDateKey,
  });

  const firstPayload = await companionService.getState();
  notes = 'Second note.';
  const secondPayload = await companionService.getState();

  assert.equal(calls.length, 3);
  assert.equal(
    firstPayload.briefing.items.find((item) => item.id === 'notes')?.value,
    'First note.'
  );
  assert.equal(
    secondPayload.briefing.items.find((item) => item.id === 'notes')?.value,
    'Second note.'
  );
  // The retired daily-memory pair must not reappear as briefing rows.
  assert.deepEqual(
    secondPayload.briefing.items.filter(
      (item) => item.id === 'today-memory' || item.id === 'yesterday-memory'
    ),
    []
  );
});

test('companion service invalidates the briefing cache when workspace root changes', async () => {
  const { calls, execFileImpl } = createGitExecStub(({ joined, workspaceRoot }) => (
    joined.includes('rev-parse')
      ? `${workspaceRoot.includes('project-b') ? 'release' : 'main'}\n`
      : joined.includes('status')
        ? ''
        : `${workspaceRoot.includes('project-b') ? 'def456' : 'abc123'} Work item\n`
  ));
  let workspaceRoot = 'G:/workspace/project-a';
  const configService = {
    getState() {
      return {
        toolsWorkspaceRoot: workspaceRoot,
        companion: { mode: 'planner' },
        proactive: { reminders: [] },
        followUps: [],
      };
    },
    getWorkspaceState() {
      return {
        activeSessionId: '',
        openSessionIds: [],
      };
    },
    getWorkspaceRootStatus() {
      return {
        state: 'ready',
        message: 'Workspace root is configured.',
      };
    },
  };
  const companionService = new CompanionService({
    configService,
    personalityWorkspace: createPersonalityWorkspace(),
    execFileImpl,
    nowProvider: () => new Date('2026-03-19T14:30:00.000Z'),
    formatDateKey,
  });

  await companionService.getState();
  workspaceRoot = 'G:/workspace/project-b';
  const payload = await companionService.getState();

  assert.equal(calls.length, 6);
  assert.equal(
    payload.briefing.items.find((item) => item.id === 'git')?.value,
    'Git: branch release; 0 changed, 0 staged, 0 untracked.'
  );
});

test('companion service builds defer presets from the resolved personality time zone', async () => {
  const companionService = new CompanionService({
    configService: createConfigService(),
    personalityWorkspace: {
      async getResolvedTimeZone() {
        return 'America/Los_Angeles';
      },
    },
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-03-19T23:30:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(
    payload.availableDeferPresets.find((preset) => preset.preset === 'later_today')?.deferredUntil,
    '2026-03-20T00:00:00.000Z'
  );
  assert.equal(
    payload.availableDeferPresets.find((preset) => preset.preset === 'tomorrow')?.deferredUntil,
    '2026-03-20T16:00:00.000Z'
  );
});

test('companion service caps suggested actions at six and preserves workspace recovery when continue action exists', async () => {
  const companionService = new CompanionService({
    configService: createConfigService(),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => ([
      {
        id: 'session-1',
        title: 'Interactive planning',
        updated_at: '2026-03-19T14:00:00.000Z',
        last_message_preview: 'Pick the next task.',
        pending_question_batch: { batch_id: 'ib_1' },
        interactive_sequence_state: 'structured_active',
      },
    ]),
    nowProvider: () => new Date('2026-03-19T14:30:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.suggestedActions.length, 6);
  assert.ok(payload.suggestedActions.some((action) => action.type === 'continue_session'));
  assert.ok(payload.suggestedActions.some((action) => action.id === 'settings:tools'));
  assert.ok(payload.suggestedActions.some((action) => action.type === 'new_session'));
  assert.ok(!payload.suggestedActions.some((action) => action.id === 'memory'));
  assert.ok(!payload.suggestedActions.some((action) => action.id === 'settings:proactive'));
});

test('companion service adds a ready-to-resume today card from due and session-linked active loops', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      followUps: [
        {
          id: 'followup-due',
          label: 'Due today',
          body: 'Resurface this now.',
          createdAt: '2026-03-19T08:00:00.000Z',
          updatedAt: '2026-03-19T08:00:00.000Z',
          status: 'deferred',
          deferPreset: 'later_today',
          deferredUntil: '2026-03-19T08:30:00.000Z',
        },
        {
          id: 'followup-session-a',
          label: 'Linked session A',
          body: 'Keep momentum here.',
          createdAt: '2026-03-19T09:00:00.000Z',
          updatedAt: '2026-03-19T09:00:00.000Z',
          status: 'active',
          sessionId: 'session-a',
        },
        {
          id: 'followup-session-b',
          label: 'Linked session B',
          body: 'Another active thread.',
          createdAt: '2026-03-19T07:00:00.000Z',
          updatedAt: '2026-03-19T07:00:00.000Z',
          status: 'active',
          sessionId: 'session-b',
        },
        {
          id: 'followup-plain',
          label: 'Unlinked active loop',
          body: 'Should stay out of the resume card.',
          createdAt: '2026-03-19T06:00:00.000Z',
          updatedAt: '2026-03-19T06:00:00.000Z',
          status: 'active',
        },
      ],
      openSessionIds: ['session-a'],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => ([
      {
        id: 'session-a',
        title: 'Session A',
        updated_at: '2026-03-19T09:15:00.000Z',
        last_message_preview: 'Continue session A.',
      },
      {
        id: 'session-b',
        title: 'Session B',
        updated_at: '2026-03-19T07:15:00.000Z',
        last_message_preview: 'Continue session B.',
      },
    ]),
    nowProvider: () => new Date('2026-03-19T09:30:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();
  const readyToResume = payload.todayCards.find((card) => card.id === 'ready-to-resume');

  assert.ok(readyToResume);
  assert.deepEqual(
    readyToResume.items.map((item) => item.label),
    ['Due today', 'Linked session A', 'Linked session B']
  );
  assert.equal(readyToResume.items[0].detail, 'Due now');
  assert.match(readyToResume.items[1].detail, /Session A/);
  assert.match(readyToResume.items[2].detail, /Session B/);
});

test('companion service adds source and session metadata on the canonical board payload', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      activeSessionId: 'session-1',
      openSessionIds: ['session-1', 'session-2'],
      followUps: [
        {
          id: 'followup-current',
          label: 'Current session follow-up',
          body: 'Stay with the active thread.',
          createdAt: '2026-03-19T13:00:00.000Z',
          updatedAt: '2026-03-19T13:00:00.000Z',
          sessionId: 'session-1',
          status: 'active',
          sourceKind: 'manual',
        },
        {
          id: 'followup-open',
          label: 'Open session follow-up',
          body: 'Still linked to another open thread.',
          createdAt: '2026-03-19T12:00:00.000Z',
          updatedAt: '2026-03-19T12:00:00.000Z',
          sessionId: 'session-2',
          status: 'active',
          sourceKind: 'assistant_reply',
        },
        {
          id: 'followup-saved',
          label: 'Saved session follow-up',
          body: 'Comes from an older thread.',
          createdAt: '2026-03-19T11:00:00.000Z',
          updatedAt: '2026-03-19T11:00:00.000Z',
          sessionId: 'session-3',
          status: 'active',
          sourceKind: 'proactive_suggestion',
        },
        {
          id: 'followup-standalone',
          label: 'Standalone follow-up',
          body: 'No source or session context.',
          createdAt: '2026-03-19T10:00:00.000Z',
          updatedAt: '2026-03-19T10:00:00.000Z',
          status: 'active',
        },
        {
          id: 'followup-deferred',
          label: 'Deferred follow-up',
          body: 'Returns later.',
          createdAt: '2026-03-19T09:00:00.000Z',
          updatedAt: '2026-03-19T09:00:00.000Z',
          status: 'deferred',
          deferPreset: 'tomorrow',
          deferredUntil: '2026-03-20T09:00:00.000Z',
          sourceKind: 'manual',
        },
      ],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => ([
      {
        id: 'session-1',
        title: 'Current planning thread',
        updated_at: '2026-03-19T13:30:00.000Z',
        last_message_preview: 'Current thread preview.',
      },
      {
        id: 'session-2',
        title: 'Open artifact thread',
        updated_at: '2026-03-19T12:30:00.000Z',
        last_message_preview: 'Open thread preview.',
      },
      {
        id: 'session-3',
        title: 'Saved archive thread',
        updated_at: '2026-03-19T11:30:00.000Z',
        last_message_preview: 'Saved thread preview.',
      },
    ]),
    nowProvider: () => new Date('2026-03-19T08:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();
  const [currentLoop, openLoop, savedLoop, standaloneLoop] = payload.openLoopsBoard.active;

  assert.equal(currentLoop.sessionBadge, 'Current session');
  assert.equal(currentLoop.sourceBadge, 'Manual');
  assert.equal(currentLoop.sessionTitle, 'Current planning thread');
  assert.equal(currentLoop.contextLine, '');

  assert.equal(openLoop.sessionBadge, 'Open session');
  assert.equal(openLoop.sourceBadge, 'Assistant reply');
  assert.equal(openLoop.sessionTitle, 'Open artifact thread');
  assert.equal(openLoop.contextLine, 'Open artifact thread');

  assert.equal(savedLoop.sessionBadge, 'Saved from session');
  assert.equal(savedLoop.sourceBadge, 'Proactive suggestion');
  assert.equal(savedLoop.sessionTitle, 'Saved archive thread');
  assert.equal(savedLoop.contextLine, 'Saved archive thread');

  assert.equal(standaloneLoop.sessionBadge, '');
  assert.equal(standaloneLoop.sourceBadge, '');
  assert.equal(standaloneLoop.sessionTitle, '');
  assert.equal(standaloneLoop.contextLine, '');

  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'openLoops'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'deferredLoops'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'openLoopSummary'), false);
});

test('companion service falls back to valid timestamps when follow-up metadata is malformed', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      followUps: [
        {
          id: 'followup-valid-due',
          label: 'Valid due follow-up',
          body: 'Deferred with a valid due time.',
          createdAt: '2026-03-19T09:00:00.000Z',
          updatedAt: '2026-03-19T09:30:00.000Z',
          status: 'deferred',
          deferredUntil: '2026-03-19T08:00:00.000Z',
        },
        {
          id: 'followup-invalid-due',
          label: 'Malformed due follow-up',
          body: 'Deferred with a malformed due time.',
          createdAt: '2026-03-19T10:00:00.000Z',
          updatedAt: 'not-a-date',
          status: 'deferred',
          deferredUntil: 'not-a-date',
        },
        {
          id: 'followup-resolved-valid',
          label: 'Resolved with valid timestamp',
          body: 'Resolved cleanly.',
          createdAt: '2026-03-19T07:00:00.000Z',
          updatedAt: '2026-03-19T07:30:00.000Z',
          resolvedAt: '2026-03-19T11:00:00.000Z',
          status: 'resolved',
        },
        {
          id: 'followup-resolved-fallback',
          label: 'Resolved with malformed timestamp',
          body: 'Resolved timestamp is malformed.',
          createdAt: '2026-03-19T06:00:00.000Z',
          updatedAt: '2026-03-19T10:30:00.000Z',
          resolvedAt: 'not-a-date',
          status: 'resolved',
        },
      ],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-03-19T09:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.deepEqual(
    payload.openLoopsBoard.active.map((loop) => loop.title),
    ['Valid due follow-up', 'Malformed due follow-up']
  );
  assert.deepEqual(
    payload.openLoopsBoard.recentResolved.map((loop) => loop.title),
    ['Resolved with valid timestamp', 'Resolved with malformed timestamp']
  );
});

test('companion service labels agent task follow-ups with the dedicated source badge', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      followUps: [
        {
          id: 'followup-agent-task',
          label: 'Scout investigation',
          body: 'Resume the Scout subagent work.',
          createdAt: '2026-03-19T11:00:00.000Z',
          updatedAt: '2026-03-19T11:30:00.000Z',
          status: 'active',
          sourceKind: 'agent_task',
          sourceId: 'agent:agent_42',
          sourceMeta: {
            agentId: 'agent_42',
            nickname: 'Scout',
          },
        },
      ],
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-03-19T12:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.openLoopsBoard.active.length, 1);
  assert.equal(payload.openLoopsBoard.active[0].sourceBadge, 'Agent task');
  assert.equal(payload.openLoopsBoard.active[0].sourceLabel, 'Tracked from an agent task');
});

test('companion service uses active_turn lifecycle summaries for the ready-to-resume card when task lifecycle is enabled', async () => {
  const configService = createConfigService({
    followUps: [
      {
        id: 'followup-linked',
        label: 'Linked loop thread',
        body: 'Keep momentum here.',
        createdAt: '2026-03-19T10:00:00.000Z',
        updatedAt: '2026-03-19T10:30:00.000Z',
        status: 'active',
        sessionId: 'session-open-loop',
      },
    ],
    activeSessionId: 'session-active',
    openSessionIds: ['session-active', 'session-open-loop'],
    workspaceRootStatus: {
      state: 'ready',
      message: 'Workspace root is configured.',
    },
  });
  const companionService = new CompanionService({
    configService,
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => ([
      {
        id: 'session-active',
        title: 'Current workspace thread',
        updated_at: '2026-03-19T13:00:00.000Z',
        last_message_preview: 'Continue from the artifacts follow-up.',
      },
      {
        id: 'session-open-loop',
        title: 'Linked loop thread',
        updated_at: '2026-03-19T12:00:00.000Z',
        last_message_preview: 'Session-linked loop preview.',
      },
    ]),
    listSessionRecords: () => ([
      {
        id: 'session-active',
        title: 'Current workspace thread',
        updated_at: '2026-03-19T13:00:00.000Z',
        last_message_preview: 'Continue from the artifacts follow-up.',
        active_turn: {
          request_id: 'req_active',
          stream_id: 'stream_active',
          user_message_id: 'user_active',
          started_at: '2026-03-19T12:58:00.000Z',
          last_event_at: '2026-03-19T12:59:00.000Z',
          status: 'streaming',
          task_id: 'local_agent_1',
          task_type: 'local_agent',
          agent_stage: 'tool_loop',
          agent_summary: 'Running tool loop and gathering outputs.',
          agent_percent: 55,
        },
      },
      {
        id: 'session-open-loop',
        title: 'Linked loop thread',
        updated_at: '2026-03-19T12:00:00.000Z',
        last_message_preview: 'Session-linked loop preview.',
        active_turn: null,
      },
    ]),
    taskLifecycleEnabled: () => true,
    nowProvider: () => new Date('2026-03-19T13:30:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();
  const readyToResume = payload.todayCards.find((card) => card.id === 'ready-to-resume');

  assert.ok(readyToResume);
  assert.deepEqual(
    readyToResume.items.map((item) => item.label),
    ['Current workspace thread', 'Linked loop thread']
  );
  assert.equal(readyToResume.items[0].detail, 'Running tool loop and gathering outputs.');
  assert.equal(readyToResume.items[0].action.type, 'continue_session');
  assert.equal(readyToResume.items[0].action.sessionId, 'session-active');
  assert.equal(readyToResume.items[1].action.type, 'continue_session');
  assert.equal(readyToResume.items[1].action.sessionId, 'session-open-loop');
});

test('companion service builds a commitments-first home focus and reminder promotion actions', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      proactive: {
        reminders: [
          {
            id: 'reminder-1',
            label: 'Hydrate',
            prompt: 'Drink water before the next deep work block.',
            enabled: true,
          },
        ],
      },
      followUps: [
        {
          id: 'followup-due',
          label: 'Finish rollout note',
          body: 'Close the loop after checking the release note.',
          createdAt: '2026-03-19T09:00:00.000Z',
          updatedAt: '2026-03-19T09:30:00.000Z',
          status: 'deferred',
          deferPreset: 'morning',
          deferredUntil: '2026-03-19T09:45:00.000Z',
        },
      ],
      workspaceRootStatus: {
        state: 'ready',
        message: 'Workspace root is configured.',
      },
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => ([{
      id: 'session-1',
      title: 'Recent work',
      updated_at: '2026-03-19T10:00:00.000Z',
      last_message_preview: 'Continue later.',
    }]),
    nowProvider: () => new Date('2026-03-19T10:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.homeFocus.kind, 'open_loop');
  assert.equal(payload.homeFocus.label, 'Due now');
  assert.equal(payload.homeFocus.title, 'Finish rollout note');
  assert.equal(payload.homeFocus.primaryAction.type, 'resolve_follow_up');
  assert.equal(payload.reminders[0].action.type, 'promote_reminder');
  assert.equal(payload.reminders[0].action.reminderId, 'reminder-1');
  assert.equal(payload.reminders[0].action.label, 'Promote to Open Loop');
  // No scheduler exists: built reminders must not advertise schedule or
  // fired state (UIUX-017).
  assert.deepEqual(
    Object.keys(payload.reminders[0]).sort(),
    ['action', 'id', 'label', 'prompt']
  );
});

test('companion service falls back to reminder focus before mode suggestions when no commitments are waiting', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      proactive: {
        reminders: [
          {
            id: 'reminder-2',
            label: 'Stretch',
            prompt: 'Take a minute to stretch.',
            enabled: true,
          },
        ],
      },
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [],
    nowProvider: () => new Date('2026-03-19T10:00:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.homeFocus.kind, 'reminder');
  assert.equal(payload.homeFocus.label, 'Reminder');
  assert.equal(payload.homeFocus.title, 'Stretch');
  assert.equal(payload.homeFocus.primaryAction.type, 'promote_reminder');
  assert.equal(payload.homeFocus.primaryAction.reminderId, 'reminder-2');
});

test('home focus helper degrades from malformed inputs to suggestions and clear runway', () => {
  const suggestedFocus = buildHomeFocus({
    openLoopsBoard: { active: null },
    todayCards: [{ id: 'ready-to-resume', items: [{ label: 'Thread without action' }] }],
    reminders: [{ id: 'reminder-without-action', label: 'Reminder without action' }],
    suggestedActions: [{
      id: 'prefill:planner',
      type: 'prefill_chat',
      label: 'Start in Planner Mode',
      prompt: 'Plan the day.',
    }],
  });

  assert.equal(suggestedFocus.kind, 'suggested');
  assert.equal(suggestedFocus.primaryAction.type, 'prefill_chat');

  const clearFocus = buildHomeFocus({
    openLoopsBoard: null,
    todayCards: [{ id: 'ready-to-resume', items: [{ detail: 'Missing label' }] }],
    reminders: [{ id: 'reminder-no-action', label: 'Reminder missing a promote action' }],
    suggestedActions: [],
  });

  assert.equal(clearFocus.kind, 'clear');
  assert.equal(clearFocus.primaryAction, null);
});

test('companion service does not surface active_turn resume cards when task lifecycle is disabled', async () => {
  const companionService = new CompanionService({
    configService: createConfigService({
      workspaceRootStatus: {
        state: 'ready',
        message: 'Workspace root is configured.',
      },
    }),
    personalityWorkspace: createPersonalityWorkspace(),
    listSessionSummaries: () => [],
    listSessionRecords: () => ([
      {
        id: 'session-active',
        title: 'Current workspace thread',
        updated_at: '2026-03-19T13:00:00.000Z',
        active_turn: {
          request_id: 'req_active',
          last_event_at: '2026-03-19T12:59:00.000Z',
          status: 'streaming',
          agent_summary: 'Running tool loop and gathering outputs.',
        },
      },
    ]),
    taskLifecycleEnabled: () => false,
    nowProvider: () => new Date('2026-03-19T13:30:00.000Z'),
    formatDateKey,
  });

  const payload = await companionService.getState();

  assert.equal(payload.todayCards.some((card) => card.id === 'ready-to-resume'), false);
});
