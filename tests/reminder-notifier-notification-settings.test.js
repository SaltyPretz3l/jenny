'use strict';

// The reminder OS toast honours windowUi.notifications (master switch, the
// reminders category, sound). The in-app reminders.onFired event and the
// persisted lastFiredAt are unaffected by these preferences.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createReminderNotifier } = require('../services/main/reminder-notifier');

const NOW_MS = new Date(2026, 8, 15, 10, 0).getTime();

function dueReminder() {
  return {
    id: 'reminder-1',
    label: 'Stretch',
    prompt: 'Stand up and stretch.',
    scheduleType: 'once_at',
    dailyAt: '',
    intervalMinutes: 0,
    onceAt: '2026-09-15T10:00',
    enabled: true,
    createdAt: new Date(2026, 8, 15, 9, 0).toISOString(),
    lastFiredAt: '',
  };
}

function createHarness({ notificationSettings, getWindowUiState, window } = {}) {
  let reminders = [dueReminder()];
  const notifications = [];
  const bridgeEvents = [];
  const upserts = [];
  const logs = [];
  const shellConfigService = new EventEmitter();
  shellConfigService.getState = () => ({ proactive: { reminders: reminders.map((r) => ({ ...r })) } });
  shellConfigService.upsertReminder = (next) => {
    upserts.push({ ...next });
    reminders = reminders.filter((entry) => entry.id !== next.id).concat({ ...next });
  };
  if (getWindowUiState) {
    shellConfigService.getWindowUiState = getWindowUiState;
  } else if (notificationSettings !== undefined) {
    shellConfigService.getWindowUiState = () => ({
      appZoomPercent: 100,
      notifications: notificationSettings,
    });
  }
  const notifier = createReminderNotifier({
    getShellConfigService: () => shellConfigService,
    getMainWindow: () => ({
      isDestroyed: () => false,
      isMinimized: () => false,
      focus() {},
      ...(window || {}),
    }),
    notificationFactory(options) {
      const notification = { options, on() {}, show() {} };
      notifications.push(notification);
      return notification;
    },
    isSupported: () => true,
    sendBridgeEvent: (event, payload) => bridgeEvents.push({ event, payload }),
    log: (level, event, details) => logs.push({ level, event, details }),
    now: () => NOW_MS,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  return { notifier, notifications, bridgeEvents, upserts, logs };
}

test('without a notifications block the reminder toast keeps its sound', () => {
  const harness = createHarness();
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 1);
  assert.deepEqual(harness.logs.filter((entry) => entry.event === 'reminder_notifier.shown').map((entry) => entry.details),
    [{ silent: false }]);
  assert.deepEqual(harness.notifications[0].options, {
    title: 'Stretch',
    body: 'Stand up and stretch.',
    silent: false,
  });
});

test('reminders category off skips the OS toast but still persists and fires in-app', () => {
  const harness = createHarness({ notificationSettings: { categories: { reminders: false } } });
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 0);
  assert.deepEqual(harness.logs.filter((entry) => entry.event === 'reminder_notifier.suppressed').map((entry) => entry.details),
    [{ reason: 'category_off' }]);
  assert.equal(harness.upserts.length, 1);
  assert.deepEqual(harness.bridgeEvents.map((entry) => entry.event), ['reminders.onFired']);
});

test('the master switch off skips the reminder toast', () => {
  const harness = createHarness({ notificationSettings: { enabled: false } });
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.bridgeEvents.length, 1);
});

test('other categories off do not affect reminders', () => {
  const harness = createHarness({
    notificationSettings: {
      categories: { replies: false, failures: false, permissions: false, questions: false },
    },
  });
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 1);
});

test('onlyWhenUnfocused skips the toast while the window is focused but keeps the in-app event', () => {
  const harness = createHarness({
    notificationSettings: { onlyWhenUnfocused: true },
    window: { isVisible: () => true, isFocused: () => true },
  });
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.upserts.length, 1);
  assert.deepEqual(harness.bridgeEvents.map((entry) => entry.event), ['reminders.onFired']);
  assert.deepEqual(harness.logs.filter((entry) => entry.event === 'reminder_notifier.suppressed').map((entry) => entry.details),
    [{ reason: 'focused' }]);
});

test('onlyWhenUnfocused still shows the toast when the window is unfocused, hidden or minimized', () => {
  for (const window of [
    { isVisible: () => true, isFocused: () => false },
    { isVisible: () => false, isFocused: () => true },
    { isVisible: () => true, isFocused: () => true, isMinimized: () => true },
  ]) {
    const harness = createHarness({ notificationSettings: { onlyWhenUnfocused: true }, window });
    harness.notifier.tick();
    assert.equal(harness.notifications.length, 1);
  }
});

test('onlyWhenUnfocused off shows the toast even while the window is focused', () => {
  const harness = createHarness({
    notificationSettings: { onlyWhenUnfocused: false },
    window: { isVisible: () => true, isFocused: () => true },
  });
  harness.notifier.tick();
  assert.equal(harness.notifications.length, 1);
});

test('the reminder toast sound follows the notifications sound preference', () => {
  const muted = createHarness({ notificationSettings: { sound: false } });
  muted.notifier.tick();
  assert.equal(muted.notifications[0].options.silent, true);

  const audible = createHarness({ notificationSettings: { sound: true } });
  audible.notifier.tick();
  assert.equal(audible.notifications[0].options.silent, false);
});

test('a throwing settings read falls back to defaults and logs once', () => {
  const harness = createHarness({
    getWindowUiState: () => { throw new Error('settings exploded'); },
  });
  assert.doesNotThrow(() => harness.notifier.tick());
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].options.silent, false);
  assert.equal(
    harness.logs.filter((entry) => entry.event === 'reminder_notifier.settings_failed').length,
    1
  );
});
