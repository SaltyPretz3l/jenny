'use strict';

// Row 85 S2: a due `action: "jenny_turn"` reminder goes to the injected port
// instead of the toast, after lastFiredAt/lastDueAt are persisted; it never
// joins the "due while Jenny was closed" group; an unhandled port falls back
// to the plain toast; powerMonitor resume/unlock re-ticks.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createReminderNotifier } = require('../services/main/reminder-notifier');

function localMs(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

const NOW = localMs(2026, 11, 2, 8, 0);

function check(overrides = {}) {
  return {
    id: 'check-1',
    label: 'Overnight',
    prompt: 'Tell me what finished overnight',
    scheduleType: 'daily_at',
    dailyAt: '08:00',
    weekdays: [],
    intervalMinutes: 0,
    onceAt: '',
    enabled: true,
    createdAt: new Date(localMs(2026, 11, 1, 9, 0)).toISOString(),
    lastFiredAt: '',
    action: 'jenny_turn',
    lastDueAt: '',
    ...overrides,
  };
}

function createHarness({ reminders, port, powerMonitor = null, hold = undefined, nowMs = NOW }) {
  let currentNow = nowMs;
  let current = reminders.map((entry) => ({ ...entry }));
  const upserts = [];
  const notifications = [];
  const bridgeEvents = [];
  const logs = [];
  const service = new EventEmitter();
  service.getState = () => ({ proactive: { reminders: current.map((entry) => ({ ...entry })) } });
  service.upsertReminder = (next) => {
    upserts.push({ ...next });
    current = current.filter((entry) => entry.id !== next.id).concat({ ...next });
  };
  const notifier = createReminderNotifier({
    getShellConfigService: () => service,
    getMainWindow: () => ({ isDestroyed: () => false }),
    notificationFactory: (options) => {
      const notification = { options, on() {}, show() {} };
      notifications.push(notification);
      return notification;
    },
    isSupported: () => true,
    sendBridgeEvent: (event, payload) => bridgeEvents.push({ event, payload }),
    log: (level, event, details) => logs.push({ level, event, details }),
    onJennyTurnDue: port,
    ...(hold ? { holdJennyTurn: hold } : {}),
    powerMonitor,
    now: () => currentNow,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  return { notifier, upserts, notifications, bridgeEvents, logs, setNow: (value) => { currentNow = value; } };
}

test('a due check persists lastFiredAt and lastDueAt before the port runs, with no toast', () => {
  const calls = [];
  let upsertsAtCall = -1;
  const harness = createHarness({
    reminders: [check()],
    port: (reminder, dueAtMs, meta) => {
      upsertsAtCall = harness.upserts.length;
      calls.push({ reminder, dueAtMs, meta });
      return { handled: true };
    },
  });
  harness.notifier.tick();
  assert.equal(calls.length, 1);
  assert.equal(upsertsAtCall, 1, 'the record is persisted before the port is called');
  assert.equal(calls[0].dueAtMs, NOW);
  assert.equal(calls[0].reminder.lastDueAt, new Date(NOW).toISOString());
  assert.equal(calls[0].reminder.lastFiredAt, new Date(NOW).toISOString());
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.bridgeEvents.length, 0);

  harness.notifier.tick();
  assert.equal(calls.length, 1, 'the same occurrence never reaches the port twice');
});

test('an unhandled or throwing port falls back to the plain toast with the instruction', () => {
  for (const port of [() => ({ handled: false }), null, () => { throw new Error('boom'); }]) {
    const harness = createHarness({ reminders: [check()], port });
    harness.notifier.tick();
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].options.title, 'Overnight');
    assert.equal(harness.notifications[0].options.body, 'Tell me what finished overnight');
    assert.equal(harness.bridgeEvents.length, 1);
    assert.equal(harness.bridgeEvents[0].event, 'reminders.onFired');
    assert.equal(harness.upserts.length, 1, 'the fallback does not persist a second time');
  }
});

test('missed checks stay out of the "due while Jenny was closed" group on the first tick', () => {
  const calls = [];
  const harness = createHarness({
    reminders: [
      check({ id: 'late-check', scheduleType: 'once_at', dailyAt: '', onceAt: '2026-11-02T06:00' }),
      check({ id: 'plain', action: '', label: 'Stretch', scheduleType: 'once_at', dailyAt: '', onceAt: '2026-11-02T07:00' }),
    ],
    port: (reminder, dueAtMs, meta) => {
      calls.push({ id: reminder.id, dueAtMs, meta });
      return { handled: true };
    },
  });
  harness.notifier.start();
  assert.deepEqual(calls, [{ id: 'late-check', dueAtMs: localMs(2026, 11, 2, 6, 0), meta: undefined }]);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].options.title, '1 reminder was due while Jenny was closed');
  assert.equal(harness.notifications[0].options.body, 'Stretch');
  harness.notifier.stop();
});

test('powerMonitor resume and unlock-screen re-tick, and stop removes the listeners', () => {
  const powerMonitor = new EventEmitter();
  const calls = [];
  const harness = createHarness({
    reminders: [check({ dailyAt: '09:00' })],
    port: (reminder) => { calls.push(reminder.id); return { handled: true }; },
    powerMonitor,
  });
  harness.notifier.start();
  assert.equal(calls.length, 0);
  harness.setNow(localMs(2026, 11, 2, 9, 1));
  powerMonitor.emit('resume');
  assert.deepEqual(calls, ['check-1']);
  assert.equal(powerMonitor.listenerCount('unlock-screen'), 1);
  harness.notifier.stop();
  assert.equal(powerMonitor.listenerCount('resume'), 0);
  assert.equal(powerMonitor.listenerCount('unlock-screen'), 0);
});

test('a held check is neither persisted nor fired until the hold lifts', () => {
  let held = true;
  const calls = [];
  const harness = createHarness({
    reminders: [check({ scheduleType: 'once_at', dailyAt: '', onceAt: '2026-11-02T07:30' })],
    port: (reminder) => { calls.push(reminder.id); return { handled: true }; },
    hold: () => { if (held === 'throw') throw new Error('boom'); return held; },
  });
  harness.notifier.tick();
  assert.equal(harness.upserts.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(harness.notifications.length, 0, 'a held check is not a plain reminder either');
  held = 'throw';
  harness.notifier.tick();
  assert.deepEqual(calls, ['check-1'], 'a throwing hold predicate never mutes a check');
});
