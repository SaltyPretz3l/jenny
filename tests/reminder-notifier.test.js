'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');

const {
  isReminderDue,
  reminderDueAt,
} = require('../services/shell-config-followups-schema');
const { createReminderNotifier } = require('../services/main/reminder-notifier');
const { registerWorkspaceIpcHandlers } = require('../services/main/workspace-ipc-registration');
const previousI18nFallback = globalThis.jennyI18nFallback;
globalThis.jennyI18nFallback = function interpolateDefault(_key, fallback, values = {}) {
  return String(fallback).replace(/\{(\w+)\}/g, (_match, name) => String(values[name] ?? ''));
};
const { createHealthPillController } = require('../renderer/shell/renderer-health-pill-utils');
if (previousI18nFallback === undefined) delete globalThis.jennyI18nFallback;
else globalThis.jennyI18nFallback = previousI18nFallback;

function localMs(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function localStamp(year, month, day, hour = 0, minute = 0) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

function reminder(overrides = {}) {
  return {
    id: 'reminder-1',
    label: 'Stretch',
    prompt: 'Stand up and stretch.',
    scheduleType: 'once_at',
    dailyAt: '',
    intervalMinutes: 0,
    onceAt: localStamp(2026, 9, 15, 10, 0),
    enabled: true,
    createdAt: new Date(localMs(2026, 9, 15, 9, 0)).toISOString(),
    lastFiredAt: '',
    ...overrides,
  };
}

function createHarness({
  reminders = [],
  nowMs = localMs(2026, 9, 15, 10, 0),
  supported = true,
  factoryError = null,
  windowAvailable = true,
  windowLoading = null,
} = {}) {
  let currentNow = nowMs;
  let currentWindowLoading = windowLoading;
  let currentReminders = reminders.map((entry) => ({ ...entry }));
  const upserts = [];
  const notifications = [];
  const bridgeEvents = [];
  const logs = [];
  const intervals = [];
  const cleared = [];
  const shellConfigService = new EventEmitter();
  shellConfigService.getState = () => ({
    proactive: { reminders: currentReminders.map((entry) => ({ ...entry })) },
  });
  shellConfigService.upsertReminder = function upsertReminder(next) {
    upserts.push({ ...next });
    currentReminders = currentReminders.filter((entry) => entry.id !== next.id);
    currentReminders.push({ ...next });
    return this.getState();
  };
  const webContents = new EventEmitter();
  webContents.isLoading = () => currentWindowLoading;
  const mainWindow = {
    focused: 0,
    restored: 0,
    minimized: false,
    isDestroyed: () => false,
    isMinimized() { return this.minimized; },
    restore() { this.restored += 1; this.minimized = false; },
    focus() { this.focused += 1; },
  };
  if (typeof windowLoading === 'boolean') mainWindow.webContents = webContents;
  let currentMainWindow = windowAvailable ? mainWindow : null;
  const notifier = createReminderNotifier({
    getShellConfigService: () => shellConfigService,
    getMainWindow: () => currentMainWindow,
    notificationFactory(options) {
      if (factoryError) throw factoryError;
      const listeners = new Map();
      const notification = {
        options,
        showCalls: 0,
        on(event, listener) { listeners.set(event, listener); },
        show() { this.showCalls += 1; },
        click() { listeners.get('click')?.(); },
      };
      notifications.push(notification);
      return notification;
    },
    isSupported: () => supported,
    sendBridgeEvent: (event, payload) => bridgeEvents.push({ event, payload }),
    log: (level, event, details) => logs.push({ level, event, details }),
    now: () => currentNow,
    setIntervalFn(callback, intervalMs) {
      const timer = { callback, intervalMs, unrefCalls: 0, unref() { this.unrefCalls += 1; } };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => cleared.push(timer),
  });
  return {
    bridgeEvents,
    cleared,
    intervals,
    logs,
    mainWindow,
    notifications,
    notifier,
    shellConfigService,
    upserts,
    deleteReminder(id) {
      currentReminders = currentReminders.filter((entry) => entry.id !== id);
      shellConfigService.emit('changed', shellConfigService.getState(), {
        reason: 'proactive_reminder_deleted', reminderId: id,
      });
    },
    finishWindowLoad() {
      currentWindowLoading = false;
      webContents.emit('did-finish-load');
    },
    getReminders: () => currentReminders.map((entry) => ({ ...entry })),
    setMainWindow: (value) => { currentMainWindow = value; },
    setReminders: (value) => { currentReminders = value.map((entry) => ({ ...entry })); },
    setNow: (value) => { currentNow = value; },
  };
}

test('reminderDueAt and isReminderDue implement each cadence and occurrence guard', () => {
  const nowMs = localMs(2026, 9, 15, 10, 0);
  const once = reminder({ onceAt: localStamp(2026, 9, 15, 9, 30) });
  assert.equal(reminderDueAt(once, nowMs), localMs(2026, 9, 15, 9, 30));
  assert.equal(
    reminderDueAt({ ...once, onceAt: '2026-09-15T15:30:00.000Z' }, nowMs),
    Date.parse('2026-09-15T15:30:00.000Z')
  );
  assert.equal(isReminderDue(once, nowMs), true);
  assert.equal(isReminderDue({ ...once, lastFiredAt: new Date(nowMs - 1000).toISOString() }, nowMs), false);

  const daily = reminder({ scheduleType: 'daily_at', dailyAt: '08:45', onceAt: '' });
  assert.equal(reminderDueAt(daily, nowMs), localMs(2026, 9, 15, 8, 45));
  assert.equal(isReminderDue(daily, nowMs), true);
  assert.equal(isReminderDue({ ...daily, lastFiredAt: new Date(nowMs - 1000).toISOString() }, nowMs), false);

  const interval = reminder({
    scheduleType: 'interval_minutes',
    onceAt: '',
    intervalMinutes: 15,
    createdAt: new Date(nowMs - 15 * 60000).toISOString(),
  });
  assert.equal(reminderDueAt(interval, nowMs), nowMs);
  assert.equal(isReminderDue(interval, nowMs), true);
  assert.equal(isReminderDue({ ...interval, lastFiredAt: new Date(nowMs - 5 * 60000).toISOString() }, nowMs), false);
});

test('due-time helpers reject disabled and malformed reminders', () => {
  const nowMs = localMs(2026, 9, 15, 10, 0);
  assert.equal(reminderDueAt(reminder({ enabled: false }), nowMs), null);
  assert.equal(reminderDueAt(reminder({ onceAt: 'not-a-date' }), nowMs), null);
  assert.equal(reminderDueAt(reminder({ scheduleType: 'daily_at', dailyAt: '25:00' }), nowMs), null);
  assert.equal(reminderDueAt(reminder({ scheduleType: 'interval_minutes', intervalMinutes: 0 }), nowMs), null);
  assert.equal(reminderDueAt(reminder({ scheduleType: 'unknown' }), nowMs), null);
  assert.equal(isReminderDue(null, nowMs), false);
});

test('once_at due reminder fires exactly once across three ticks and persists lastFiredAt', () => {
  const nowMs = localMs(2026, 9, 15, 10, 0);
  const harness = createHarness({ reminders: [reminder()], nowMs });

  harness.notifier.tick();
  harness.notifier.tick();
  harness.notifier.tick();

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].showCalls, 1);
  assert.deepEqual(harness.notifications[0].options, {
    title: 'Stretch',
    body: 'Stand up and stretch.',
    silent: false,
  });
  assert.equal(harness.upserts.length, 1);
  assert.equal(harness.upserts[0].lastFiredAt, new Date(nowMs).toISOString());
  assert.deepEqual(harness.bridgeEvents, [{
    event: 'reminders.onFired',
    payload: {
      id: 'reminder-1',
      label: 'Stretch',
      prompt: 'Stand up and stretch.',
      firedAt: new Date(nowMs).toISOString(),
    },
  }]);
});

test('disabled reminder never fires', () => {
  const harness = createHarness({ reminders: [reminder({ enabled: false })] });

  harness.notifier.tick();

  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.upserts.length, 0);
  assert.equal(harness.bridgeEvents.length, 0);
});

test('daily_at fires once today and again after local midnight', () => {
  const firstMs = localMs(2026, 9, 15, 23, 59);
  const harness = createHarness({
    nowMs: firstMs,
    reminders: [reminder({ scheduleType: 'daily_at', dailyAt: '00:00', onceAt: '' })],
  });

  harness.notifier.tick();
  harness.notifier.tick();
  harness.setNow(localMs(2026, 9, 16, 0, 0));
  harness.notifier.tick();

  assert.equal(harness.notifications.length, 2);
  assert.equal(harness.upserts.length, 2);
  assert.equal(harness.upserts[1].lastFiredAt, new Date(localMs(2026, 9, 16, 0, 0)).toISOString());
});

test('interval_minutes fires when the interval elapses', () => {
  const nowMs = localMs(2026, 9, 15, 10, 0);
  const harness = createHarness({
    nowMs,
    reminders: [reminder({
      scheduleType: 'interval_minutes',
      intervalMinutes: 15,
      onceAt: '',
      createdAt: new Date(nowMs).toISOString(),
    })],
  });

  harness.notifier.tick();
  harness.setNow(nowMs + 15 * 60000 - 1);
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 0);

  harness.setNow(nowMs + 15 * 60000);
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 1);
});

test('snooze delays the next interval fire by ten minutes', () => {
  const nowMs = localMs(2026, 9, 15, 10, 0);
  const harness = createHarness({
    nowMs,
    reminders: [reminder({
      scheduleType: 'interval_minutes',
      intervalMinutes: 5,
      onceAt: '',
      createdAt: new Date(nowMs - 5 * 60000).toISOString(),
    })],
  });

  harness.notifier.tick();
  assert.deepEqual(harness.notifier.snooze('reminder-1'), {
    id: 'reminder-1', minutes: 10, untilMs: nowMs + 10 * 60000,
  });
  harness.setNow(nowMs + 5 * 60000);
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 1);

  harness.setNow(nowMs + 10 * 60000);
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 2);

  harness.notifier.tick();
  assert.equal(harness.notifications.length, 2);
});

test('snoozed once_at reminder fires again when the snooze expires', () => {
  const nowMs = localMs(2026, 9, 15, 10, 0);
  const harness = createHarness({ nowMs, reminders: [reminder()] });

  harness.notifier.tick();
  harness.notifier.snooze('reminder-1');
  harness.setNow(nowMs + 5 * 60000);
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 1);

  harness.setNow(nowMs + 10 * 60000);
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 2);
  assert.equal(
    harness.bridgeEvents.filter((entry) => entry.event === 'reminders.onFired').length,
    2
  );
});

test('daily snooze across midnight preserves the next scheduled occurrence', () => {
  const firstFireMs = localMs(2026, 9, 15, 23, 55);
  const harness = createHarness({
    nowMs: firstFireMs,
    reminders: [reminder({ scheduleType: 'daily_at', dailyAt: '23:55', onceAt: '' })],
  });

  harness.notifier.tick();
  harness.notifier.snooze('reminder-1');
  harness.setNow(localMs(2026, 9, 16, 0, 5));
  harness.notifier.tick();
  harness.setNow(localMs(2026, 9, 16, 23, 55));
  harness.notifier.tick();

  assert.equal(harness.notifications.length, 3);
  assert.equal(harness.upserts.length, 2);
  assert.equal(
    harness.bridgeEvents.filter((entry) => entry.event === 'reminders.onFired').length,
    3
  );
});

test('snoozed reminder deleted before expiry does not re-fire', () => {
  const nowMs = localMs(2026, 9, 15, 10, 0);
  const harness = createHarness({ nowMs, reminders: [reminder()] });

  harness.notifier.tick();
  harness.notifier.snooze('reminder-1');
  harness.deleteReminder('reminder-1');
  harness.setNow(nowMs + 10 * 60000);
  harness.notifier.tick();

  assert.equal(harness.notifications.length, 1);
  assert.equal(
    harness.bridgeEvents.filter((entry) => entry.event === 'reminders.onFired').length,
    1
  );
});

test('deleting a reminder clears its in-memory snooze', () => {
  const nowMs = localMs(2026, 9, 15, 10, 0);
  const intervalReminder = reminder({
    scheduleType: 'interval_minutes',
    intervalMinutes: 5,
    onceAt: '',
    createdAt: new Date(nowMs).toISOString(),
  });
  const harness = createHarness({ nowMs, reminders: [intervalReminder] });

  harness.notifier.snooze('reminder-1');
  harness.notifier.start();
  harness.deleteReminder('reminder-1');
  harness.setReminders([intervalReminder]);
  harness.setNow(nowMs + 5 * 60000);
  harness.notifier.tick();

  assert.equal(harness.notifications.length, 1);
  harness.notifier.stop();
});

test('first start tick groups past once_at reminders and marks each missed', () => {
  const nowMs = localMs(2026, 9, 15, 10, 0);
  const harness = createHarness({
    nowMs,
    reminders: [
      reminder({ id: 'one', label: 'First', onceAt: localStamp(2026, 9, 15, 8, 0) }),
      reminder({ id: 'two', label: 'Second', onceAt: localStamp(2026, 9, 15, 9, 0) }),
    ],
  });

  harness.notifier.start();

  assert.equal(harness.notifications.length, 1);
  assert.deepEqual(harness.notifications[0].options, {
    title: '2 reminders were due while Jenny was closed',
    body: 'First\nSecond',
    silent: false,
  });
  assert.equal(harness.upserts.length, 2);
  assert.equal(harness.bridgeEvents.length, 2);
  assert.deepEqual(harness.bridgeEvents.map((entry) => entry.payload.missed), [true, true]);
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].unrefCalls, 1);

  harness.notifier.stop();
  assert.deepEqual(harness.cleared, [harness.intervals[0]]);
});

test('startup waits for a live main window before consuming the missed-reminder tick', () => {
  const nowMs = localMs(2026, 9, 15, 10, 0);
  const harness = createHarness({
    nowMs,
    windowAvailable: false,
    reminders: [reminder({ onceAt: localStamp(2026, 9, 15, 9, 0) })],
  });

  harness.notifier.start();
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.upserts.length, 0);
  assert.equal(harness.bridgeEvents.length, 0);

  harness.setMainWindow(harness.mainWindow);
  harness.notifier.tick();

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.upserts.length, 1);
  assert.deepEqual(harness.bridgeEvents, [{
    event: 'reminders.onFired',
    payload: {
      id: 'reminder-1',
      label: 'Stretch',
      prompt: 'Stand up and stretch.',
      firedAt: new Date(nowMs).toISOString(),
      missed: true,
    },
  }]);
  harness.notifier.stop();
});

test('startup waits for renderer load plus one interval before firing missed reminders', () => {
  const nowMs = localMs(2026, 9, 15, 10, 0);
  const harness = createHarness({
    nowMs,
    windowLoading: true,
    reminders: [reminder({ onceAt: localStamp(2026, 9, 15, 9, 0) })],
  });

  harness.notifier.start();
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.upserts.length, 0);
  assert.equal(harness.bridgeEvents.length, 0);

  harness.finishWindowLoad();
  harness.setNow(nowMs + 30000);
  harness.notifier.tick();

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.upserts.length, 1);
  assert.deepEqual(harness.bridgeEvents, [{
    event: 'reminders.onFired',
    payload: {
      id: 'reminder-1',
      label: 'Stretch',
      prompt: 'Stand up and stretch.',
      firedAt: new Date(nowMs + 30000).toISOString(),
      missed: true,
    },
  }]);
  harness.notifier.stop();
});

test('unsupported OS notifications still persist and send the fallback bridge event', () => {
  const harness = createHarness({ reminders: [reminder()], supported: false });

  assert.doesNotThrow(() => harness.notifier.tick());

  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.upserts.length, 1);
  assert.equal(harness.bridgeEvents.length, 1);
  assert.equal(harness.logs.filter((entry) => entry.event === 'reminder_notifier.unsupported').length, 1);
});

test('a throwing notification factory is caught and logged once across later ticks', () => {
  const harness = createHarness({
    reminders: [reminder()],
    factoryError: new Error('notification exploded'),
  });

  assert.doesNotThrow(() => harness.notifier.tick());
  assert.doesNotThrow(() => harness.notifier.tick());
  assert.doesNotThrow(() => harness.notifier.tick());

  assert.equal(harness.upserts.length, 1);
  assert.equal(harness.bridgeEvents.length, 1);
  assert.equal(harness.logs.filter((entry) => entry.event === 'reminder_notifier.notification_failed').length, 1);
});

test('notification click restores and focuses the main window before opening Home', () => {
  const harness = createHarness({ reminders: [reminder()] });
  harness.mainWindow.minimized = true;

  harness.notifier.tick();
  harness.notifications[0].click();

  assert.equal(harness.mainWindow.restored, 1);
  assert.equal(harness.mainWindow.focused, 1);
  assert.deepEqual(harness.bridgeEvents.at(-1), {
    event: 'reminders.onOpen',
    payload: { id: 'reminder-1' },
  });
});

test('workspace IPC registration forwards reminders.snooze to the notifier', () => {
  const handlers = new Map();
  const calls = [];
  registerWorkspaceIpcHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    reminderNotifier: {
      snooze(id, minutes) {
        calls.push({ id, minutes });
        return { id, minutes, untilMs: 123 };
      },
    },
  });

  const result = handlers.get('reminders:snooze')({}, 'reminder-1', 10);

  assert.deepEqual(calls, [{ id: 'reminder-1', minutes: 10 }]);
  assert.deepEqual(result, { id: 'reminder-1', minutes: 10, untilMs: 123 });
});

test('renderer reminder events show a sticky snooze toast and open Home', async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const listeners = {};
  const unsubscribed = [];
  const snoozes = [];
  const toasts = [];
  const views = [];
  const previousRunModeControl = globalThis.rendererRunModeControl;
  const previousHealthPillController = globalThis.rendererHealthPillController;
  globalThis.rendererRunModeControl = { currentRunMode: () => 'ask' };
  window.jennyShell = {
    diagnostics: { getJennyStatus: async () => null },
    reminders: {
      onFired(listener) {
        listeners.fired = listener;
        return () => unsubscribed.push('fired');
      },
      onOpen(listener) {
        listeners.open = listener;
        return () => unsubscribed.push('open');
      },
      snooze: async (id, minutes) => snoozes.push({ id, minutes }),
    },
  };
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot: window.document.getElementById('slot'),
    setActiveView: (view) => views.push(view),
    showToastMessage: (...args) => {
      toasts.push(args);
      return `toast-${toasts.length}`;
    },
  });
  t.after(() => {
    controller.dispose();
    if (previousRunModeControl === undefined) delete globalThis.rendererRunModeControl;
    else globalThis.rendererRunModeControl = previousRunModeControl;
    if (previousHealthPillController === undefined) delete globalThis.rendererHealthPillController;
    else globalThis.rendererHealthPillController = previousHealthPillController;
    dom.window.close();
  });

  listeners.fired({ id: 'reminder-1', label: 'Stretch', prompt: 'Stand up.' });

  assert.equal(toasts[0][0], 'Stand up.');
  assert.deepEqual(toasts[0][1], {
    title: 'Stretch',
    tone: 'info',
    sticky: true,
    source: 'reminders.notifier',
    dedupeKey: 'reminders:fired:reminder-1',
    actions: [{
      id: 'reminder_snooze_10',
      label: 'Snooze 10 min',
      kind: 'secondary',
      onClick: toasts[0][1].actions[0].onClick,
    }],
  });

  await toasts[0][1].actions[0].onClick();
  assert.deepEqual(snoozes, [{ id: 'reminder-1', minutes: 10 }]);
  assert.equal(toasts[1][0], 'Snoozed 10 min while Jenny stays open');

  listeners.open({ id: 'reminder-1' });
  assert.deepEqual(views, ['home']);
  controller.dispose();
  assert.deepEqual(unsubscribed.sort(), ['fired', 'open']);
});
