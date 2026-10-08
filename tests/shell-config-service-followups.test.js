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
    (error) => error.code === COMPANION_ERROR_CODES.FOLLOW_UP_STATE_CONFLICT
      && /^CMP-COMPANION-0003: Only resolved open loops can be archived\.$/.test(error.message)
  );

  service.resolveFollowUp('followup-1');
  service.archiveFollowUp('followup-1');
  const nextState = service.unarchiveFollowUp('followup-1');

  assert.equal(nextState.followUps[0].status, 'resolved');
  assert.equal(nextState.followUps[0].archivedAt, '');
});

function createClockedService(prefix, startIso) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(userDataPath);
  const clock = { now: new Date(startIso) };
  const service = new ShellConfigService({ userDataPath, nowProvider: () => new Date(clock.now) });
  const changes = [];
  service.on('changed', (_snapshot, context) => {
    changes.push(context?.reason || '');
  });
  const find = (id) => service.getState().followUps.find((entry) => entry.id === id);
  return { service, clock, changes, find };
}

test('updateFollowUp recomputes deferredUntil when the edit picks a different preset', () => {
  const { service, clock, find } = createClockedService('jenny-shell-config-followup-represet-', '2026-03-19T15:00:00.000Z');
  service.upsertFollowUp({ id: 'followup-1', label: 'Loop', status: 'deferred', deferPreset: 'tomorrow' });
  const tomorrowUntil = find('followup-1').deferredUntil;

  clock.now = new Date('2026-03-19T16:00:00.000Z');
  service.updateFollowUp('followup-1', { label: 'Loop', status: 'deferred', deferPreset: 'next_week' });

  const updated = find('followup-1');
  assert.equal(updated.deferPreset, 'next_week');
  assert.equal(updated.deferredUntil, calculateDeferredUntilForPreset('next_week', clock.now));
  assert.notEqual(updated.deferredUntil, tomorrowUntil);
  assert.equal(updated.history[0].detail, 'Updated timing.');
});

test('updateFollowUp applies a snake_case preset alias to both the preset and its deadline', () => {
  const { service, clock, find } = createClockedService('jenny-shell-config-followup-snake-', '2026-03-19T15:00:00.000Z');
  service.upsertFollowUp({ id: 'followup-1', label: 'Loop', status: 'deferred', deferPreset: 'tomorrow' });

  service.updateFollowUp('followup-1', { defer_preset: 'next_week' });

  const updated = find('followup-1');
  assert.equal(updated.deferPreset, 'next_week');
  assert.equal(updated.deferredUntil, calculateDeferredUntilForPreset('next_week', clock.now));
});

test('updateFollowUp gives a due deferred loop a fresh future deferral for the same preset', () => {
  const { service, clock, find } = createClockedService('jenny-shell-config-followup-due-', '2026-03-19T15:00:00.000Z');
  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Due loop',
    status: 'deferred',
    deferPreset: 'tomorrow',
    deferredUntil: '2026-03-19T09:00:00.000Z',
  });

  service.updateFollowUp('followup-1', { label: 'Due loop', status: 'deferred', deferPreset: 'tomorrow' });

  const updated = find('followup-1');
  assert.equal(updated.deferredUntil, calculateDeferredUntilForPreset('tomorrow', clock.now));
  assert.ok(Date.parse(updated.deferredUntil) > clock.now.valueOf());
});

test('updateFollowUp keeps a still-future deferral when the preset is unchanged', () => {
  const { service, clock, find } = createClockedService('jenny-shell-config-followup-same-preset-', '2026-03-19T15:00:00.000Z');
  service.upsertFollowUp({
    id: 'followup-1',
    label: 'Future loop',
    status: 'deferred',
    deferPreset: 'tomorrow',
    deferredUntil: '2026-03-20T09:00:00.000Z',
  });

  clock.now = new Date('2026-03-19T18:00:00.000Z');
  service.updateFollowUp('followup-1', { label: 'Renamed loop', status: 'deferred', deferPreset: 'tomorrow' });

  const updated = find('followup-1');
  assert.equal(updated.label, 'Renamed loop');
  assert.equal(updated.deferredUntil, '2026-03-20T09:00:00.000Z');
  assert.equal(updated.history[0].detail, 'Updated details.');
});

test('updateFollowUp no-op edit writes no history and keeps updatedAt', () => {
  const { service, clock, changes, find } = createClockedService('jenny-shell-config-followup-noop-edit-', '2026-03-19T15:00:00.000Z');
  service.upsertFollowUp({ id: 'active-1', label: 'Active', body: 'Body.', status: 'active' });
  service.upsertFollowUp({
    id: 'deferred-1',
    label: 'Deferred',
    status: 'deferred',
    deferPreset: 'tomorrow',
    deferredUntil: '2026-03-20T09:00:00.000Z',
  });
  const before = JSON.parse(JSON.stringify(service.getState().followUps));
  const changeCount = changes.length;

  clock.now = new Date('2026-03-19T16:00:00.000Z');
  service.updateFollowUp('active-1', { label: 'Active', body: 'Body.', status: 'active', deferPreset: '' });
  service.updateFollowUp('deferred-1', { label: 'Deferred', body: '', status: 'deferred', deferPreset: 'tomorrow' });

  assert.equal(changes.length, changeCount);
  assert.deepEqual(service.getState().followUps, before);
  assert.equal(find('active-1').history.length, 1);
});

test('updateFollowUp no-op edit of a legacy record without timestamps writes nothing', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-followup-legacy-noop-'));
  trackDirectory(userDataPath);
  fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify({
    version: CONFIG_VERSION,
    followUps: [
      { id: 'legacy-active', label: 'Legacy', body: 'Old body.', status: 'active' },
      { id: 'legacy-resolved', label: 'Legacy done', body: '', status: 'resolved' },
    ],
  }, null, 2));
  const clock = { now: new Date('2026-03-19T15:00:00.000Z') };
  const service = new ShellConfigService({ userDataPath, nowProvider: () => new Date(clock.now) });
  const changes = [];
  service.on('changed', (_snapshot, context) => changes.push(context?.reason || ''));
  const before = JSON.parse(JSON.stringify(service.getState().followUps));
  assert.equal(before[0].createdAt, '', 'fixture must be a legacy record without createdAt');
  assert.equal(before[1].resolvedAt, '', 'fixture must be a resolved record without resolvedAt');

  service.updateFollowUp('legacy-active', { label: 'Legacy', body: 'Old body.', status: 'active' });
  service.updateFollowUp('legacy-resolved', { label: 'Legacy done', body: '' });

  assert.equal(changes.length, 0);
  assert.deepEqual(service.getState().followUps, before);

  // A real edit still persists the backfilled createdAt.
  service.updateFollowUp('legacy-active', { label: 'Legacy renamed' });
  const edited = service.getState().followUps.find((entry) => entry.id === 'legacy-active');
  assert.equal(edited.label, 'Legacy renamed');
  assert.equal(edited.createdAt, clock.now.toISOString());
  assert.equal(edited.history[0].kind, 'edited');
});

test('deferFollowUp refuses resolved and archived loops with a state-conflict code', () => {
  const { service, changes, find } = createClockedService('jenny-shell-config-followup-defer-conflict-', '2026-03-19T15:00:00.000Z');
  service.upsertFollowUp({ id: 'resolved-1', label: 'Done loop', status: 'active' });
  service.resolveFollowUp('resolved-1');
  service.upsertFollowUp({ id: 'archived-1', label: 'Archived loop', status: 'active' });
  service.resolveFollowUp('archived-1');
  service.archiveFollowUp('archived-1');
  const before = JSON.parse(JSON.stringify(service.getState().followUps));
  const changeCount = changes.length;

  for (const id of ['resolved-1', 'archived-1']) {
    assert.throws(
      () => service.deferFollowUp(id, 'tomorrow'),
      (error) => error.code === COMPANION_ERROR_CODES.FOLLOW_UP_STATE_CONFLICT
        && error.errorCode === 'CMP-COMPANION-0003'
        && error.message.startsWith('CMP-COMPANION-0003: ')
    );
  }
  assert.equal(changes.length, changeCount);
  assert.deepEqual(service.getState().followUps, before);
  assert.ok(find('archived-1').archivedAt);
  assert.ok(find('resolved-1').resolvedAt);
});

test('assertFollowUpExists throws the not-found code for unknown ids and returns the record otherwise', () => {
  const { service } = createClockedService('jenny-shell-config-followup-exists-', '2026-03-19T15:00:00.000Z');
  service.upsertFollowUp({ id: 'followup-1', label: 'Present' });

  assert.equal(service.assertFollowUpExists(' followup-1 ').id, 'followup-1');
  for (const id of ['missing', '', null]) {
    assert.throws(
      () => service.assertFollowUpExists(id),
      (error) => error.code === COMPANION_ERROR_CODES.FOLLOW_UP_NOT_FOUND
        && error.message === 'CMP-COMPANION-0002: That open loop no longer exists.'
    );
  }
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

function createProjectStampService(prefix) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath });
  const commits = [];
  const commit = service._commitState.bind(service);
  service._commitState = (state, reason, details) => {
    commits.push(reason);
    return commit(state, reason, details);
  };
  return { service, commits };
}

test('follow-up projectId round-trips through upsert and normalizes invalid ids to empty', () => {
  const { service } = createProjectStampService('jenny-shell-config-followup-project-id-');
  service.upsertFollowUp({ id: 'task-a', label: 'A', sourceKind: 'agent_task', projectId: 'project_abc' });
  service.upsertFollowUp({ id: 'task-b', label: 'B', sourceKind: 'agent_task', projectId: '../x' });
  service.upsertFollowUp({ id: 'task-c', label: 'C', sourceKind: 'agent_task', projectId: 'Project_ABC!' });
  service.upsertFollowUp({ id: 'task-d', label: 'D', sourceKind: 'agent_task', project_id: 'project_snake' });
  service.upsertFollowUp({ id: 'task-e', label: 'E', sourceKind: 'agent_task' });
  const byId = Object.fromEntries(service.getState().followUps.map((entry) => [entry.id, entry.projectId]));
  assert.deepEqual(byId, {
    'task-a': 'project_abc',
    'task-b': '',
    'task-c': '',
    'task-d': 'project_snake',
    'task-e': '',
  });
  // An unrelated edit keeps the stamp.
  service.updateFollowUp('task-a', { label: 'A renamed' });
  assert.equal(service.getState().followUps.find((entry) => entry.id === 'task-a').projectId, 'project_abc');
});

test('stampFollowUpProjects changes only projectId, writes once, and a no-op writes nothing', () => {
  const { service, commits } = createProjectStampService('jenny-shell-config-followup-stamp-');
  service.upsertFollowUp({ id: 'task-a', label: 'A', sourceKind: 'agent_task', sessionId: 's1' });
  service.upsertFollowUp({ id: 'task-b', label: 'B', sourceKind: 'agent_task', sessionId: 's2' });
  const before = service.getState().followUps;
  commits.length = 0;

  const result = service.stampFollowUpProjects([
    { id: 'task-a', projectId: 'project_one' },
    { id: 'task-b', projectId: 'not a project id' },
    { id: 'missing', projectId: 'project_two' },
  ]);
  assert.equal(result.changed, 1);
  assert.deepEqual(commits, ['follow_up_projects_stamped']);
  const after = service.getState().followUps;
  const taskA = after.find((entry) => entry.id === 'task-a');
  const beforeA = before.find((entry) => entry.id === 'task-a');
  assert.equal(taskA.projectId, 'project_one');
  assert.deepEqual({ ...taskA, projectId: '' }, { ...beforeA, projectId: '' });
  assert.equal(taskA.updatedAt, beforeA.updatedAt);
  assert.deepEqual(taskA.history, beforeA.history);
  assert.equal(after.find((entry) => entry.id === 'task-b').projectId, '');

  commits.length = 0;
  const again = service.stampFollowUpProjects([{ id: 'task-a', projectId: 'project_one' }]);
  assert.equal(again.changed, 0);
  assert.deepEqual(commits, []);
  assert.equal(service.stampFollowUpProjects(null).changed, 0);
  assert.deepEqual(commits, []);
});

test('restampAgentTasksForProject moves every agent task of that project and nothing else', () => {
  const { service, commits } = createProjectStampService('jenny-shell-config-followup-restamp-project-');
  service.upsertFollowUp({ id: 'rail', label: 'Rail', sourceKind: 'agent_task', sessionId: '', projectId: 'project_gone' });
  service.upsertFollowUp({ id: 'chat', label: 'Chat', sourceKind: 'agent_task', sessionId: 's1', projectId: 'project_gone' });
  service.upsertFollowUp({ id: 'other', label: 'Other', sourceKind: 'agent_task', sessionId: 's2', projectId: 'project_keep' });
  service.upsertFollowUp({ id: 'plain', label: 'Plain', sourceKind: 'assistant_reply', sessionId: 's1', projectId: 'project_gone' });
  commits.length = 0;

  const result = service.restampAgentTasksForProject('project_gone', 'project_general');
  assert.equal(result.changed, 2);
  assert.deepEqual(commits, ['follow_up_projects_stamped']);
  const byId = Object.fromEntries(service.getState().followUps.map((entry) => [entry.id, entry.projectId]));
  assert.deepEqual(byId, { rail: 'project_general', chat: 'project_general', other: 'project_keep', plain: 'project_gone' });

  assert.deepEqual(service.restampAgentTasksForProject('project_gone', 'project_general'), { changed: 0 });
  assert.deepEqual(service.restampAgentTasksForProject('project_keep', 'project_keep'), { changed: 0 });
  assert.deepEqual(service.restampAgentTasksForProject('nope', 'project_general'), { changed: 0 });
});

test('restampAgentTasksForSession moves only that chat agent tasks', () => {
  const { service, commits } = createProjectStampService('jenny-shell-config-followup-restamp-');
  service.upsertFollowUp({ id: 'task-mine', label: 'Mine', sourceKind: 'agent_task', sessionId: 's1', projectId: 'project_old' });
  service.upsertFollowUp({ id: 'task-other', label: 'Other', sourceKind: 'agent_task', sessionId: 's2', projectId: 'project_old' });
  service.upsertFollowUp({ id: 'task-manual', label: 'Manual', sourceKind: 'agent_task', sessionId: '', projectId: 'project_old' });
  service.upsertFollowUp({ id: 'loop-mine', label: 'Loop', sourceKind: 'assistant_reply', sessionId: 's1' });
  commits.length = 0;

  assert.deepEqual(service.restampAgentTasksForSession('s1', 'project_new'), { changed: 1 });
  const byId = Object.fromEntries(service.getState().followUps.map((entry) => [entry.id, entry.projectId]));
  assert.deepEqual(byId, {
    'task-mine': 'project_new',
    'task-other': 'project_old',
    'task-manual': 'project_old',
    'loop-mine': '',
  });
  assert.equal(commits.length, 1);

  commits.length = 0;
  assert.deepEqual(service.restampAgentTasksForSession('', 'project_new'), { changed: 0 });
  assert.deepEqual(service.restampAgentTasksForSession('s1', 'project_new'), { changed: 0 });
  assert.deepEqual(service.restampAgentTasksForSession('s1', 'bad id'), { changed: 0 });
  assert.deepEqual(commits, []);
});
