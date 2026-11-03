'use strict';

// Row 85 S1: the Jenny-check fields on Home reminders (action, weekdays,
// lastDueAt), the weekday-aware due math, the next-occurrence helper used by
// approval cards, and the D7 catch-up bound.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JENNY_TURN_MIN_INTERVAL_MINUTES,
  REMINDER_ACTIONS,
  armJennyCheck,
  sameReminderCadence,
  isReminderDue,
  nextReminderOccurrences,
  normalizeReminder,
  reminderCatchUpLimitMs,
  reminderDueAt,
} = require('../services/shell-config-followups-schema');

function localMs(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

// 2026-11-02 is a Monday (getDay() === 1).
const MONDAY = localMs(2026, 11, 2, 10, 0);

test('action is a closed enum and a plain reminder keeps the empty action', () => {
  assert.deepEqual(REMINDER_ACTIONS, ['jenny_turn']);
  assert.equal(normalizeReminder({}).action, '');
  assert.equal(normalizeReminder({ action: 'JENNY_TURN' }).action, 'jenny_turn');
  assert.equal(normalizeReminder({ action: 'run_command' }).action, '');
  assert.equal(normalizeReminder({ action: 7 }).action, '');
});

test('weekdays apply only to daily_at, dedupe, sort, and a full week collapses to every day', () => {
  const daily = (weekdays) => normalizeReminder({ scheduleType: 'daily_at', dailyAt: '08:00', weekdays }).weekdays;
  assert.deepEqual(daily([5, 1, 1, 3]), [1, 3, 5]);
  assert.deepEqual(daily([0, 1, 2, 3, 4, 5, 6]), []);
  assert.deepEqual(daily([7, -1, 1.5, '2', null, 4]), [4]);
  assert.deepEqual(daily('1,2'), []);
  assert.deepEqual(daily(undefined), []);
  assert.deepEqual(
    normalizeReminder({ scheduleType: 'interval_minutes', weekdays: [1, 2] }).weekdays,
    [],
    'a stale weekday set must not survive a cadence change'
  );
});

test('a Jenny check interval has a 30-minute floor; a plain reminder keeps 5', () => {
  assert.equal(JENNY_TURN_MIN_INTERVAL_MINUTES, 30);
  assert.equal(
    normalizeReminder({ scheduleType: 'interval_minutes', intervalMinutes: 10, action: 'jenny_turn' }).intervalMinutes,
    30
  );
  assert.equal(
    normalizeReminder({ scheduleType: 'interval_minutes', intervalMinutes: 10 }).intervalMinutes,
    10
  );
  assert.equal(normalizeReminder({ scheduleType: 'daily_at', action: 'jenny_turn' }).intervalMinutes, 0);
});

test('lastDueAt normalizes to ISO and round-trips with the other new fields', () => {
  const check = normalizeReminder({
    id: 'rem-check',
    label: 'Overnight',
    prompt: 'Tell me what finished overnight',
    scheduleType: 'daily_at',
    dailyAt: '08:00',
    weekdays: [1, 2, 3, 4, 5],
    action: 'jenny_turn',
    last_due_at: '2026-11-02T08:00:00.000Z',
  });
  assert.equal(check.lastDueAt, '2026-11-02T08:00:00.000Z');
  assert.equal(normalizeReminder({ lastDueAt: 'nope' }).lastDueAt, '');
  assert.deepEqual(normalizeReminder(JSON.parse(JSON.stringify(check))), check);
});

test('a weekday daily reminder is due only on its listed days', () => {
  const reminder = normalizeReminder({ scheduleType: 'daily_at', dailyAt: '08:00', weekdays: [1, 3] });
  assert.equal(reminderDueAt(reminder, MONDAY), localMs(2026, 11, 2, 8, 0));
  assert.equal(isReminderDue(reminder, MONDAY), true);
  const tuesday = localMs(2026, 11, 3, 10, 0);
  assert.equal(reminderDueAt(reminder, tuesday), null);
  assert.equal(isReminderDue(reminder, tuesday), false);
  const everyDay = normalizeReminder({ scheduleType: 'daily_at', dailyAt: '08:00' });
  assert.equal(isReminderDue(everyDay, tuesday), true);
});

test('nextReminderOccurrences lists the next three weekday fires after now', () => {
  const reminder = normalizeReminder({ scheduleType: 'daily_at', dailyAt: '08:00', weekdays: [1, 3, 5] });
  // Monday 10:00 is past today's 08:00, so the list starts Wednesday.
  assert.deepEqual(nextReminderOccurrences(reminder, MONDAY), [
    localMs(2026, 11, 4, 8, 0),
    localMs(2026, 11, 6, 8, 0),
    localMs(2026, 11, 9, 8, 0),
  ]);
  const early = localMs(2026, 11, 2, 7, 0);
  assert.equal(nextReminderOccurrences(reminder, early)[0], localMs(2026, 11, 2, 8, 0));
  const firedToday = { ...reminder, lastFiredAt: new Date(localMs(2026, 11, 2, 6, 0)).toISOString() };
  assert.equal(nextReminderOccurrences(firedToday, early)[0], localMs(2026, 11, 4, 8, 0));
});

test('nextReminderOccurrences handles one-off, interval and disabled reminders', () => {
  const once = normalizeReminder({ scheduleType: 'once_at', onceAt: '2026-11-03T16:00' });
  assert.deepEqual(nextReminderOccurrences(once, MONDAY), [localMs(2026, 11, 3, 16, 0)]);
  assert.deepEqual(nextReminderOccurrences({ ...once, lastFiredAt: '2026-11-03T16:00:00.000Z' }, MONDAY), []);
  assert.deepEqual(nextReminderOccurrences(once, localMs(2026, 11, 4)), []);

  const interval = normalizeReminder({
    scheduleType: 'interval_minutes',
    intervalMinutes: 60,
    action: 'jenny_turn',
    createdAt: new Date(MONDAY).toISOString(),
  });
  assert.deepEqual(nextReminderOccurrences(interval, MONDAY, 2), [MONDAY + 3600000, MONDAY + 7200000]);
  assert.deepEqual(nextReminderOccurrences({ ...interval, enabled: false }, MONDAY), []);
});

test('nextReminderOccurrences follows local wall clock across a DST change', () => {
  const reminder = normalizeReminder({ scheduleType: 'daily_at', dailyAt: '09:00' });
  const fires = nextReminderOccurrences(reminder, localMs(2026, 3, 27, 12, 0), 4);
  assert.equal(fires.length, 4);
  for (const fire of fires) {
    const date = new Date(fire);
    assert.equal(date.getHours(), 9);
    assert.equal(date.getMinutes(), 0);
  }
});

test('the catch-up bound is 24 h for a one-off and half the period capped at 6 h otherwise', () => {
  assert.equal(reminderCatchUpLimitMs({ scheduleType: 'once_at' }), 24 * 3600000);
  assert.equal(reminderCatchUpLimitMs({ scheduleType: 'daily_at' }), 6 * 3600000);
  assert.equal(reminderCatchUpLimitMs({ scheduleType: 'interval_minutes', intervalMinutes: 60 }), 30 * 60000);
  assert.equal(reminderCatchUpLimitMs({ scheduleType: 'interval_minutes', intervalMinutes: 24 * 60 }), 6 * 3600000);
});

test('an armed check never fires for an occurrence that passed before it was armed', () => {
  const daily = normalizeReminder({ id: 'd', label: 'D', scheduleType: 'daily_at', dailyAt: '09:00', action: 'jenny_turn' });
  const noon = localMs(2026, 11, 2, 12, 0);
  assert.equal(isReminderDue(daily, noon), true, 'unarmed, a passed time today is due at once');
  const armed = armJennyCheck(daily, noon);
  assert.equal(isReminderDue(armed, noon), false);
  assert.equal(isReminderDue(armed, localMs(2026, 11, 3, 9, 0)), true);
  assert.equal(nextReminderOccurrences(armed, noon, 1)[0], localMs(2026, 11, 3, 9, 0));
  const early = armJennyCheck({ ...daily, lastFiredAt: '2026-11-01T09:00:00.000Z' }, localMs(2026, 11, 2, 7, 0));
  assert.equal(early.lastFiredAt, '', 'a time still ahead today runs today');
  assert.equal(isReminderDue(early, localMs(2026, 11, 2, 9, 0)), true);
  const interval = normalizeReminder({ id: 'i', label: 'I', scheduleType: 'interval_minutes', intervalMinutes: 60, action: 'jenny_turn',
    lastFiredAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(reminderDueAt(armJennyCheck(interval, noon), noon), noon + 3600000);
  const once = normalizeReminder({ id: 'o', label: 'O', scheduleType: 'once_at', onceAt: '2026-11-06T16:00', action: 'jenny_turn' });
  assert.deepEqual(armJennyCheck(once, noon), once, 'a one-off keeps its time');
  assert.equal(sameReminderCadence(daily, { ...daily, label: 'Other' }), true);
  assert.equal(sameReminderCadence(daily, { ...daily, weekdays: [1] }), false);
});
