'use strict';

// Row 85 S5 (D9): the Home write path for reminders keeps a scheduled check's
// server-owned fields (action, weekdays, lastDueAt) across a renderer edit, refuses a
// renderer attempt to create or change a check's action, and records a user edit of a
// check's label, prompt or schedule in the schedule log.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const { getBridgeChannel } = require('../services/ipc-contract');
const { ShellConfigService } = require('../services/shell-config-service');

const UPSERT = getBridgeChannel('proactive.upsertReminder', 'invoke');

function setup(t, { backendService = {} } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-reminder-upsert-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const shellConfigService = new ShellConfigService({ userDataPath });
  const handlers = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle(channel, handler) { handlers.set(channel, handler); } },
    personalityWorkspace: {},
    artifactService: {},
    backendService,
    getProactiveStatePayload: () => ({ reminders: shellConfigService.getState().proactive.reminders }),
    shellConfigService,
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions: () => [],
    offlineIntelligenceService: {},
    dialog: {},
    getMainWindow: () => null,
    chooseWorkspaceRoot: async () => null,
    clearWorkspaceRoot: () => null,
    prepareAttachmentEntries: () => ({ accepted: [], rejected: [] }),
    attachmentAssetStore: null,
    processRef: { cwd: () => process.cwd() },
    os: {},
    isChildPath: () => false,
    clipboard: { writeText() {} },
    log: () => null,
    getMainLifecycle: () => null,
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
  });
  const upsert = (reminder) => handlers.get(UPSERT)({}, reminder);
  const remove = (id) => handlers.get(getBridgeChannel('proactive.deleteReminder', 'invoke'))({}, id);
  const stored = (id) => shellConfigService.getState().proactive.reminders.find((entry) => entry.id === id);
  return { shellConfigService, upsert, remove, stored };
}

const CHECK = {
  id: 'rem_check',
  label: 'Morning check',
  prompt: 'Look at my inbox.',
  scheduleType: 'daily_at',
  dailyAt: '09:00',
  weekdays: [1, 3],
  action: 'jenny_turn',
  lastDueAt: '2026-11-01T09:00:00.000Z',
};

function backendWithEvents(events) {
  return { primaryChatControls: { recordScheduleEvent: (event) => { events.push(event); } } };
}

test('an edit that omits action, weekdays and lastDueAt keeps the stored values', (t) => {
  const events = [];
  const { shellConfigService, upsert, stored } = setup(t, { backendService: backendWithEvents(events) });
  shellConfigService.upsertReminder(CHECK);
  upsert({
    id: 'rem_check',
    label: 'Morning check',
    prompt: 'Look at my inbox.',
    scheduleType: 'daily_at',
    dailyAt: '09:00',
    enabled: false,
  });
  const after = stored('rem_check');
  assert.equal(after.action, 'jenny_turn');
  assert.deepEqual(after.weekdays, [1, 3]);
  assert.equal(after.lastDueAt, '2026-11-01T09:00:00.000Z');
  assert.equal(after.enabled, false);
  assert.deepEqual(events, [{ kind: 'schedule_disabled', reminder_id: 'rem_check', label: 'Morning check', by: 'user' }]);
});

test('Turn on re-arms a daily check whose time today has passed and logs it; Delete logs the cancel', (t) => {
  const events = [];
  const { shellConfigService, upsert, remove, stored } = setup(t, { backendService: backendWithEvents(events) });
  shellConfigService.upsertReminder({ ...CHECK, dailyAt: '00:00', weekdays: [], enabled: false, lastFiredAt: '2026-01-01T00:00:00.000Z' });
  upsert({ id: 'rem_check', enabled: true });
  const fired = new Date(stored('rem_check').lastFiredAt);
  assert.equal(fired.toDateString(), new Date().toDateString(), 'counts as fired today, so it does not run at once');
  assert.deepEqual(events.at(-1), { kind: 'schedule_enabled', reminder_id: 'rem_check', label: 'Morning check', by: 'user' });
  shellConfigService.upsertReminder({ id: 'rem_plain', label: 'Stretch', scheduleType: 'daily_at', dailyAt: '10:00' });
  remove('rem_plain');
  assert.equal(events.length, 1, 'a plain reminder delete is not logged');
  remove('rem_check');
  assert.equal(stored('rem_check'), undefined);
  assert.deepEqual(events.at(-1), { kind: 'schedule_cancelled', reminder_id: 'rem_check', label: 'Morning check', by: 'user' });
});

test('a renderer cannot overwrite the scheduler cursor', (t) => {
  const { shellConfigService, upsert, stored } = setup(t);
  shellConfigService.upsertReminder(CHECK);
  upsert({ id: 'rem_check', lastDueAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(stored('rem_check').lastDueAt, '2026-11-01T09:00:00.000Z');
});

test('setting action on a new reminder is refused and nothing is written', (t) => {
  const { shellConfigService, upsert } = setup(t);
  assert.throws(
    () => upsert({
      id: 'rem_new', label: 'Sneaky', scheduleType: 'daily_at', dailyAt: '09:00', action: 'jenny_turn',
    }),
    (error) => /action/i.test(error.message) && typeof error.code === 'string'
  );
  assert.deepEqual(shellConfigService.getState().proactive.reminders, []);
});

test('changing or clearing the action of a stored reminder is refused', (t) => {
  const { shellConfigService, upsert, stored } = setup(t);
  shellConfigService.upsertReminder(CHECK);
  shellConfigService.upsertReminder({
    id: 'rem_plain', label: 'Water', scheduleType: 'daily_at', dailyAt: '08:00',
  });
  assert.throws(() => upsert({ id: 'rem_check', label: 'x', action: '' }), /action/i);
  assert.throws(() => upsert({ id: 'rem_check', label: 'x', action: 'other' }), /action/i);
  assert.throws(() => upsert({ id: 'rem_plain', label: 'x', action: 'jenny_turn' }), /action/i);
  assert.equal(stored('rem_check').label, 'Morning check');
  assert.equal(stored('rem_check').action, 'jenny_turn');
  assert.equal(stored('rem_plain').action, '');
  // Re-sending the same action is not a change.
  upsert({ id: 'rem_check', label: 'Same action', action: 'jenny_turn' });
  assert.equal(stored('rem_check').label, 'Same action');
});

test('a user edit of a check label, prompt or schedule records schedule_updated', (t) => {
  const events = [];
  const { shellConfigService, upsert } = setup(t, { backendService: backendWithEvents(events) });
  shellConfigService.upsertReminder(CHECK);
  upsert({ id: 'rem_check', label: 'Evening check' });
  upsert({ id: 'rem_check', prompt: 'Look at the calendar.' });
  upsert({ id: 'rem_check', dailyAt: '18:30' });
  upsert({ id: 'rem_check', weekdays: [2] });
  upsert({ id: 'rem_check', dailyAt: '18:30' }); // unchanged: records nothing
  const event = (label) => ({
    kind: 'schedule_updated', reminder_id: 'rem_check', label, by: 'user',
  });
  assert.deepEqual(events, [
    event('Evening check'), event('Evening check'), event('Evening check'), event('Evening check'),
  ]);
});

test('a missing or throwing schedule log never blocks the write', (t) => {
  const { shellConfigService, upsert, stored } = setup(t, {
    backendService: { primaryChatControls: { recordScheduleEvent: () => { throw new Error('log down'); } } },
  });
  shellConfigService.upsertReminder(CHECK);
  upsert({ id: 'rem_check', label: 'Renamed' });
  assert.equal(stored('rem_check').label, 'Renamed');
  const bare = setup(t);
  bare.shellConfigService.upsertReminder(CHECK);
  bare.upsert({ id: 'rem_check', label: 'Renamed' });
  assert.equal(bare.stored('rem_check').label, 'Renamed');
});

test('plain reminders behave as before and record nothing', (t) => {
  const events = [];
  const { upsert, stored } = setup(t, { backendService: backendWithEvents(events) });
  upsert({ id: 'rem_plain', label: 'Water', scheduleType: 'daily_at', dailyAt: '08:00' });
  upsert({
    id: 'rem_plain', label: 'Water plants', scheduleType: 'daily_at', dailyAt: '07:30', action: '',
  });
  const after = stored('rem_plain');
  assert.equal(after.label, 'Water plants');
  assert.equal(after.dailyAt, '07:30');
  assert.equal(after.action, '');
  assert.deepEqual(events, []);
});
