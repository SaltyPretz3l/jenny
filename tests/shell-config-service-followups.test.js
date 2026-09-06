const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateDeferredUntilForPreset,
  CONFIG_VERSION,
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
  ShellConfigService,
} = require('../services/shell-config-service');
const {
  MAX_REMINDER_SOURCE_ID_CHARS,
  REMINDER_SCHEDULE_TYPES,
  REMINDER_SOURCE_KINDS,
  normalizeReminder,
} = require('../services/shell-config-state');
const { COMPANION_ERROR_CODES } = require('../services/backend/error-codes');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});
test('shell config service migrates follow-ups from v4 to v5 with an empty default', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-migrate-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 4,
    companion: {
      mode: 'planner',
    },
  }, null, 2));

  const service = new ShellConfigService({ userDataPath });

  assert.equal(service.getState().version, CONFIG_VERSION);
  assert.deepEqual(service.getState().followUps, []);
});

test('shell config service upsertFollowUp creates a follow-up with generated id and timestamp', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-upsert-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  const nextState = service.upsertFollowUp({
    label: 'Ask about the refactor',
    body: 'Follow up on the refactor note.',
    sessionId: 'session-1',
  });

  assert.equal(nextState.followUps.length, 1);
  assert.match(nextState.followUps[0].id, /^followup-/);
  assert.match(nextState.followUps[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(nextState.followUps[0].status, 'active');
  assert.match(nextState.followUps[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(nextState.followUps[0].resolvedAt, '');
  assert.equal(nextState.followUps[0].deferredUntil, '');
});

test('shell config service preserves reminder-sourced follow-up metadata', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-reminder-source-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  const nextState = service.upsertFollowUp({
    id: 'reminder:reminder-1',
    label: 'Hydrate',
    body: 'Drink water before the next deep work block.',
    status: 'active',
    sourceKind: 'reminder',
    sourceId: 'reminder-1',
    sourceMeta: {
      reminderId: 'reminder-1',
      scheduleLabel: 'Daily at 10:00',
    },
  });

  assert.equal(nextState.followUps.length, 1);
  assert.equal(nextState.followUps[0].id, 'reminder:reminder-1');
  assert.equal(nextState.followUps[0].sourceKind, 'reminder');
  assert.equal(nextState.followUps[0].sourceId, 'reminder-1');
  assert.deepEqual(nextState.followUps[0].sourceMeta, {
    reminderId: 'reminder-1',
    scheduleLabel: 'Daily at 10:00',
  });
});

test('shell config service resolveFollowUp marks the targeted follow-up as resolved', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-resolve-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Check the migration',
    body: 'Verify the migration output.',
    createdAt: '2026-03-19T12:00:00.000Z',
  });

  const nextState = service.resolveFollowUp('followup-1');
  assert.equal(nextState.followUps[0].status, 'resolved');
  assert.match(nextState.followUps[0].resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('shell config service migrates v9 follow-ups into v10 status metadata', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-v10-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 9,
    followUps: [
      {
        id: 'followup-active',
        label: 'Keep visible',
        body: 'Still active.',
        createdAt: '2026-03-19T10:00:00.000Z',
        sessionId: 'session-1',
        resolved: false,
      },
      {
        id: 'followup-resolved',
        label: 'Already done',
        body: 'Should become resolved.',
        createdAt: '2026-03-19T09:00:00.000Z',
        sessionId: 'session-2',
        resolved: true,
      },
    ],
  }, null, 2));

  const service = new ShellConfigService({ userDataPath });
  const state = service.getState();

  assert.equal(state.version, CONFIG_VERSION);
  assert.deepEqual(
    state.followUps.map((followUp) => ({
      id: followUp.id,
      status: followUp.status,
    })),
    [
      { id: 'followup-active', status: 'active' },
      { id: 'followup-resolved', status: 'resolved' },
    ]
  );
  assert.equal(state.followUps[1].resolvedAt, '2026-03-19T09:00:00.000Z');
});

test('shell config service migrates v10 follow-ups into v11 archive and history defaults', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-v11-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 10,
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
        id: 'followup-resolved',
        label: 'Already done',
        body: 'Still resolved.',
        createdAt: '2026-03-19T09:00:00.000Z',
        updatedAt: '2026-03-19T09:30:00.000Z',
        resolvedAt: '2026-03-19T09:30:00.000Z',
        status: 'resolved',
      },
    ],
  }, null, 2));

  const service = new ShellConfigService({ userDataPath });
  const state = service.getState();

  assert.equal(state.version, CONFIG_VERSION);
  assert.deepEqual(
    state.followUps.map((followUp) => ({
      id: followUp.id,
      archivedAt: followUp.archivedAt,
      history: followUp.history,
    })),
    [
      { id: 'followup-active', archivedAt: '', history: [] },
      { id: 'followup-resolved', archivedAt: '', history: [] },
    ]
  );
});

test('shell config service deferFollowUp and activateFollowUp manage deferred metadata', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-defer-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({
    userDataPath,
    nowProvider: () => new Date('2026-03-19T15:00:00.000Z'),
  });

  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Check the release plan',
    body: 'Come back to this later.',
    createdAt: '2026-03-19T12:00:00.000Z',
  });

  const deferredState = service.deferFollowUp('followup-1', 'tomorrow');
  assert.equal(deferredState.followUps[0].status, 'deferred');
  assert.equal(deferredState.followUps[0].deferPreset, 'tomorrow');
  assert.equal(
    deferredState.followUps[0].deferredUntil,
    calculateDeferredUntilForPreset('tomorrow', new Date('2026-03-19T15:00:00.000Z'))
  );

  const activatedState = service.activateFollowUp('followup-1');
  assert.equal(activatedState.followUps[0].status, 'active');
  assert.equal(activatedState.followUps[0].deferredUntil, '');
  assert.equal(activatedState.followUps[0].deferPreset, '');
});

test('shell config service can calculate defer timing in a resolved time zone', () => {
  const now = new Date('2026-03-19T23:30:00.000Z');

  assert.equal(
    calculateDeferredUntilForPreset('later_today', now, { timeZone: 'America/Los_Angeles' }),
    '2026-03-20T00:00:00.000Z'
  );
  assert.equal(
    calculateDeferredUntilForPreset('tomorrow', now, { timeZone: 'America/Los_Angeles' }),
    '2026-03-20T16:00:00.000Z'
  );
});

test('shell config service deferFollowUp uses the supplied resolved time zone', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-tz-defer-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({
    userDataPath,
    nowProvider: () => new Date('2026-03-19T23:30:00.000Z'),
  });

  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Check the release plan',
    body: 'Come back to this later.',
  });

  const deferredState = service.deferFollowUp('followup-1', 'tomorrow', {
    timeZone: 'America/Los_Angeles',
  });

  assert.equal(deferredState.followUps[0].deferredUntil, '2026-03-20T16:00:00.000Z');
});

test('shell config service activateFollowUp reopens a resolved follow-up without a schema change', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-reopen-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({
    userDataPath,
    nowProvider: () => new Date('2026-03-19T15:30:00.000Z'),
  });

  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Check the release plan',
    body: 'Come back to this later.',
    createdAt: '2026-03-19T12:00:00.000Z',
  });
  service.resolveFollowUp('followup-1');

  const reopenedState = service.activateFollowUp('followup-1');
  assert.equal(reopenedState.followUps[0].status, 'active');
  assert.equal(reopenedState.followUps[0].resolvedAt, '');
  assert.equal(reopenedState.followUps[0].deferredUntil, '');
  assert.equal(reopenedState.followUps[0].deferPreset, '');
});

test('shell config service rejects invalid defer presets', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-invalid-defer-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({
    userDataPath,
    nowProvider: () => new Date('2026-03-19T15:00:00.000Z'),
  });

  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Check the release plan',
    body: 'Come back to this later.',
  });

  assert.throws(
    () => service.deferFollowUp('followup-1', 'never'),
    /Invalid defer preset/i
  );
});

test('shell config service rejects oversized follow-up text with companion error code', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-caps-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath });

  assert.throws(
    () => service.upsertFollowUp({
      id: 'followup-label',
      label: 'L'.repeat(MAX_FOLLOW_UP_LABEL_CHARS + 1),
      body: 'Body',
    }),
    (error) => error.code === COMPANION_ERROR_CODES.FOLLOW_UP_INVALID
  );

  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Original',
    body: 'Original body.',
  });

  assert.throws(
    () => service.updateFollowUp('followup-1', {
      body: 'B'.repeat(MAX_FOLLOW_UP_BODY_CHARS + 1),
    }),
    (error) => error.code === COMPANION_ERROR_CODES.FOLLOW_UP_INVALID
  );
});

test('shell config service rejects malformed follow-up payloads with companion error code', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-malformed-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath });

  for (const payload of [null, [], 'follow-up']) {
    assert.throws(
      () => service.upsertFollowUp(payload),
      (error) => error.code === COMPANION_ERROR_CODES.FOLLOW_UP_INVALID
    );
  }
});

test('shell config service preserves existing deferredUntil when editing a deferred follow-up', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-preserve-defer-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({
    userDataPath,
    nowProvider: () => new Date('2026-03-19T15:00:00.000Z'),
  });

  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Original',
    body: 'Original body.',
    status: 'deferred',
    deferPreset: 'tomorrow',
    deferredUntil: '2026-03-20T09:00:00.000Z',
  });

  const nextState = service.upsertFollowUp({
    id: 'followup-1',
    label: 'Updated label',
  });

  assert.equal(nextState.followUps[0].status, 'deferred');
  assert.equal(nextState.followUps[0].deferredUntil, '2026-03-20T09:00:00.000Z');
  assert.equal(nextState.followUps[0].label, 'Updated label');
});

test('shell config service updateFollowUp, archiveFollowUp, and unarchiveFollowUp track bounded history', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-history-'));
  trackDirectory(userDataPath);
  const timestamps = [
    '2026-03-19T12:00:00.000Z',
    '2026-03-19T12:05:00.000Z',
    '2026-03-19T12:10:00.000Z',
    '2026-03-19T12:15:00.000Z',
    '2026-03-19T12:20:00.000Z',
    '2026-03-19T12:25:00.000Z',
    '2026-03-19T12:30:00.000Z',
    '2026-03-19T12:35:00.000Z',
    '2026-03-19T12:40:00.000Z',
    '2026-03-19T12:45:00.000Z',
    '2026-03-19T12:50:00.000Z',
    '2026-03-19T12:55:00.000Z',
    '2026-03-19T13:00:00.000Z',
    '2026-03-19T13:05:00.000Z',
    '2026-03-19T13:10:00.000Z',
  ];
  let nowIndex = 0;
  const service = new ShellConfigService({
    userDataPath,
    nowProvider: () => new Date(timestamps[Math.min(nowIndex++, timestamps.length - 1)]),
  });

  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Original',
    body: 'Original body.',
    createdAt: '2026-03-19T12:00:00.000Z',
  });
  service.updateFollowUp('followup-1', {
    label: 'Updated once',
    body: 'Updated body.',
    status: 'deferred',
    deferPreset: 'tomorrow',
  });
  service.resolveFollowUp('followup-1');
  service.archiveFollowUp('followup-1');
  let nextState = service.unarchiveFollowUp('followup-1');

  assert.equal(nextState.followUps[0].status, 'resolved');
  assert.equal(nextState.followUps[0].archivedAt, '');
  assert.deepEqual(
    nextState.followUps[0].history.slice(0, 4).map((entry) => entry.kind),
    ['unarchived', 'archived', 'resolved', 'edited']
  );

  for (let index = 0; index < 10; index += 1) {
    nextState = service.updateFollowUp('followup-1', {
      label: `Updated ${index + 2}`,
      body: `Body ${index + 2}.`,
    });
  }

  assert.equal(nextState.followUps[0].history.length, 12);
  assert.equal(nextState.followUps[0].history[0].kind, 'edited');
  assert.equal(nextState.followUps[0].history[0].at, '2026-03-19T13:10:00.000Z');
  assert.equal(nextState.followUps[0].history[11].kind, 'archived');
  assert.ok(!nextState.followUps[0].history.some((entry) => entry.kind === 'created'));
});

test('shell config service archiveFollowUp rejects non-resolved loops and unarchiveFollowUp keeps loops resolved', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-archive-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({
    userDataPath,
    nowProvider: () => new Date('2026-03-19T12:00:00.000Z'),
  });

  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Archive me later',
    body: 'Still active.',
  });

  assert.throws(
    () => service.archiveFollowUp('followup-1'),
    /Only resolved open loops can be archived\./i
  );

  service.resolveFollowUp('followup-1');
  service.archiveFollowUp('followup-1');
  const nextState = service.unarchiveFollowUp('followup-1');

  assert.equal(nextState.followUps[0].status, 'resolved');
  assert.equal(nextState.followUps[0].archivedAt, '');
});

test('shell config service follow-up mutations are no-ops when nothing changes', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-noop-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({
    userDataPath,
    nowProvider: () => new Date('2026-03-19T15:00:00.000Z'),
  });
  const changes = [];
  service.on('changed', (_snapshot, context) => {
    changes.push(context?.reason || '');
  });

  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Original',
    body: 'Original body.',
    status: 'active',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T15:00:00.000Z',
  });
  const afterCreate = changes.length;

  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Original',
    body: 'Original body.',
    status: 'active',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T15:00:00.000Z',
  });
  service.resolveFollowUp('missing');
  service.activateFollowUp('missing');
  service.deferFollowUp('missing', 'tomorrow');

  assert.equal(changes.length, afterCreate);
});

test('shell config service deleteFollowUp removes the targeted follow-up', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-delete-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Keep',
    body: 'This one should be removed.',
  });

  const nextState = service.deleteFollowUp('followup-1');
  assert.deepEqual(nextState.followUps, []);
});

test('reminder scheduleType accepts once_at and round-trips its local-naive onceAt', () => {
  assert.deepEqual(REMINDER_SCHEDULE_TYPES, ['daily_at', 'interval_minutes', 'once_at']);

  const once = normalizeReminder({
    id: 'rem-once',
    label: 'Ship the wave',
    scheduleType: 'ONCE_AT',
    onceAt: '2026-08-20T14:30',
  });
  assert.equal(once.scheduleType, 'once_at');
  assert.equal(once.onceAt, '2026-08-20T14:30');
  // The other cadences' fields stay inert for a one-shot.
  assert.equal(once.dailyAt, '');
  assert.equal(once.intervalMinutes, 0);
  // Idempotent on its own output.
  assert.deepEqual(normalizeReminder(JSON.parse(JSON.stringify(once))), once);

  // snake_case payloads are accepted like every other reminder field.
  assert.equal(
    normalizeReminder({ schedule_type: 'once_at', once_at: '2026-12-01T07:05' }).onceAt,
    '2026-12-01T07:05'
  );
});

test('reminder onceAt rejects non-local-naive and overflow datetimes', () => {
  const at = (value) => normalizeReminder({ scheduleType: 'once_at', onceAt: value }).onceAt;
  assert.equal(at('2026-02-30T09:00'), '', 'Feb 30 must not roll forward to Mar 2');
  assert.equal(at('2026-13-01T09:00'), '');
  assert.equal(at('2026-08-20T25:00'), '');
  assert.equal(at('2026-08-20T14:30:00'), '', 'seconds are not part of the stored shape');
  assert.equal(at('2026-08-20T14:30Z'), '', 'no zone suffix: times are local wall-clock');
  assert.equal(at('2026-08-20'), '');
  assert.equal(at('not a time'), '');
  assert.equal(at(undefined), '');
  assert.equal(at(1755700000000), '');
});

test('reminder onceAt is cleared when the schedule changes away from once_at', () => {
  const stored = normalizeReminder({
    id: 'rem-once',
    scheduleType: 'once_at',
    onceAt: '2026-08-20T14:30',
  });
  assert.equal(stored.onceAt, '2026-08-20T14:30');

  const toDaily = normalizeReminder({ ...stored, scheduleType: 'daily_at', dailyAt: '09:15' });
  assert.equal(toDaily.scheduleType, 'daily_at');
  assert.equal(toDaily.onceAt, '', 'a stale one-shot time must not survive a cadence change');
  assert.equal(toDaily.dailyAt, '09:15');

  const toInterval = normalizeReminder({ ...stored, scheduleType: 'interval_minutes' });
  assert.equal(toInterval.onceAt, '');
  assert.equal(toInterval.intervalMinutes, 60);

  // An unknown cadence still falls back to daily_at, as before.
  assert.equal(normalizeReminder({ scheduleType: 'weekly_at' }).scheduleType, 'daily_at');
  assert.equal(normalizeReminder({}).onceAt, '');
});

test('reminder attribution coerces sourceKind and bounds sourceId', () => {
  assert.deepEqual(REMINDER_SOURCE_KINDS, ['assistant']);
  const kind = (value) => normalizeReminder({ sourceKind: value }).sourceKind;
  // 'user' is deliberately not a member — nothing writes it and no reader
  // distinguishes it from unattributed.
  assert.equal(kind('user'), '');
  assert.equal(kind('ASSISTANT'), 'assistant');
  assert.equal(kind('agent_task'), '', 'follow-up source kinds are not reminder source kinds');
  assert.equal(kind('manual'), '');
  assert.equal(kind(7), '');
  assert.equal(kind(null), '');
  assert.equal(normalizeReminder({}).sourceKind, '');
  assert.equal(normalizeReminder({ source_kind: 'assistant' }).sourceKind, 'assistant');

  assert.equal(normalizeReminder({}).sourceId, '');
  assert.equal(normalizeReminder({ sourceId: 'msg_42' }).sourceId, 'msg_42');
  assert.equal(normalizeReminder({ source_id: 'msg_42' }).sourceId, 'msg_42');
  assert.equal(
    normalizeReminder({ sourceId: 'z'.repeat(500) }).sourceId.length,
    MAX_REMINDER_SOURCE_ID_CHARS
  );
});

test('shell config service persists a once_at reminder with attribution intact', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-once-at-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  service.upsertReminder({
    id: 'rem-once',
    label: 'One shot',
    prompt: 'Nudge me once.',
    scheduleType: 'once_at',
    onceAt: '2026-08-20T14:30',
    sourceKind: 'assistant',
    sourceId: 'msg_42',
  });

  const reloaded = new ShellConfigService({ userDataPath }).getState().proactive.reminders;
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].scheduleType, 'once_at');
  assert.equal(reloaded[0].onceAt, '2026-08-20T14:30');
  assert.equal(reloaded[0].sourceKind, 'assistant');
  assert.equal(reloaded[0].sourceId, 'msg_42');
});
