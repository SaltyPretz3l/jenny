'use strict';

// Row 85 S7 (owner pick A1): Jenny checks stay off the Daybook timeline and show in one "Jenny checks"
// list under the week, off ones included, with cadence, next run, Turn off / Turn on and Delete. A
// weekday daily reminder lands only on its days. Turn off / Turn on writes `enabled` through
// proactive.upsertReminder.

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.jennyI18nFallback = (_key, fallback, values = {}) => String(fallback).replace(/\{(\w+)\}/g, (_m, name) => String(values[name] ?? ''));
const actionButtonModule = require('../renderer/inventory/action-button');
const reminders = require('../renderer/features/renderer-dashboard-calendar-reminders');
const agenda = require('../renderer/features/renderer-dashboard-calendar-agenda');
const runtime = require('../renderer/features/renderer-dashboard-calendar-runtime');

const actionButton = actionButtonModule.actionButton || actionButtonModule;
const NOW = new Date(2026, 10, 2, 9, 30); // Monday

function record(extra = {}) {
  return {
    id: 'c1', label: 'What finished overnight', prompt: 'Tell me what finished overnight', scheduleType: 'daily_at',
    dailyAt: '08:00', weekdays: [1, 2, 3, 4, 5], intervalMinutes: 0, onceAt: '', enabled: true, sourceKind: 'assistant',
    action: 'jenny_turn', createdAt: '2026-11-01T00:00:00.000Z', lastFiredAt: '', ...extra,
  };
}

test('a Jenny check never lands on the timeline or in the standing footer', () => {
  assert.deepEqual(reminders.remindersForDay([record()], NOW), []);
  assert.deepEqual(reminders.listStandingReminders([record({ scheduleType: 'interval_minutes', intervalMinutes: 60 })]), []);
});

test('a weekday daily reminder lands only on its days', () => {
  const plain = record({ id: 'p1', action: '', weekdays: [1, 3] });
  assert.equal(reminders.remindersForDay([plain], NOW).length, 1);
  assert.equal(reminders.remindersForDay([plain], new Date(2026, 10, 3, 9)).length, 0);
  assert.equal(reminders.remindersForDay([record({ id: 'p2', action: '', weekdays: [] })], new Date(2026, 10, 3, 9)).length, 1);
});

test('listJennyChecks keeps off checks, sorts enabled by next run, and computes the next run', () => {
  const list = reminders.listJennyChecks([
    record({ id: 'off', label: 'Off one', enabled: false }),
    record({ id: 'later', label: 'Release', scheduleType: 'once_at', onceAt: '2026-11-02T16:00', weekdays: [] }),
    record(),
    { id: 'plain', label: 'Stretch', scheduleType: 'daily_at', dailyAt: '10:00', enabled: true },
  ], NOW);
  assert.deepEqual(list.map((check) => check.id), ['later', 'c1', 'off']);
  assert.equal(list[0].nextAt.getTime(), new Date(2026, 10, 2, 16, 0).getTime());
  assert.equal(list[1].nextAt.getTime(), new Date(2026, 10, 3, 8, 0).getTime(), 'Monday 08:00 has passed: next is Tuesday');
  assert.equal(list[2].nextAt, null);
  const friday = reminders.listJennyChecks([record()], new Date(2026, 10, 6, 9, 0));
  assert.equal(friday[0].nextAt.getTime(), new Date(2026, 10, 9, 8, 0).getTime(), 'Friday after 08:00: next is Monday');
  const firedToday = reminders.listJennyChecks([record({ lastFiredAt: new Date(2026, 10, 2, 8, 0).toISOString() })], new Date(2026, 10, 2, 7, 0));
  assert.equal(firedToday[0].nextAt.getTime(), new Date(2026, 10, 3, 8, 0).getTime());
});

test('the render digest changes when a check is turned off or its days change', () => {
  const base = JSON.stringify(reminders.computeRemindersDigest([record()]));
  assert.notEqual(JSON.stringify(reminders.computeRemindersDigest([record({ enabled: false })])), base);
  assert.notEqual(JSON.stringify(reminders.computeRemindersDigest([record({ weekdays: [1] })])), base);
  assert.notEqual(JSON.stringify(reminders.computeRemindersDigest([record({ action: '' })])), base);
});

test('the agenda renders one "Jenny checks" list with cadence, next run and the two actions', () => {
  const html = agenda.buildAgendaMarkup({
    weekStart: new Date(2026, 10, 1), instances: [], categories: [], now: NOW, selectedDayKey: '2026-11-02', actionButton,
    reminders: [record(), record({ id: 'off', label: 'Tidy-up', enabled: false, weekdays: [5], dailyAt: '17:00' })],
  });
  assert.ok(!html.includes('cal-agenda__item--reminder'), 'no check rows in the day timeline');
  assert.equal((html.match(/class="cal-agenda__standing cal-agenda__checks"/g) || []).length, 1);
  assert.match(html, />Jenny checks</);
  assert.match(html, /data-cal-check-id="c1"/);
  assert.match(html, /title="Tell me what finished overnight">What finished overnight</);
  assert.match(html, /cal-agenda__standing-cadence">Weekdays · /);
  assert.match(html, /cal-agenda__check-next">tomorrow /);
  assert.match(html, /data-cal-check-toggle="c1" data-cal-check-enable="false">Turn off</);
  assert.match(html, /cal-agenda__standing-row cal-agenda__standing-row--off" data-cal-check-id="off"/);
  assert.match(html, /data-cal-check-toggle="off" data-cal-check-enable="true">Turn on</);
  assert.match(html, /cal-agenda__check-next">off</);
  assert.match(html, /data-cal-reminder-dismiss="c1">Delete</);
  const none = agenda.buildAgendaMarkup({ weekStart: new Date(2026, 10, 1), instances: [], reminders: [], now: NOW, actionButton });
  assert.ok(!none.includes('cal-agenda__checks'), 'no list when there are no checks');
});

test('Turn off writes enabled through the Home write path and repaints', async () => {
  const calls = [];
  const applied = [];
  const trigger = { dataset: { calCheckToggle: 'c1', calCheckEnable: 'false' }, disabled: false };
  const event = { target: { closest: (selector) => (selector === '[data-cal-check-toggle]' ? trigger : null) } };
  const shell = { proactive: { upsertReminder: async (input) => { calls.push(input); return { proactive: { reminders: [record({ enabled: false })] } }; } } };
  assert.equal(runtime.handleCheckToggleClick(event, {
    shell, onAiPayload: (payload) => applied.push(payload), onApplied: () => applied.push('render'),
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ id: 'c1', enabled: false }]);
  assert.equal(applied[0].proactive.reminders[0].enabled, false);
  assert.equal(applied[1], 'render');
  assert.equal(runtime.handleCheckToggleClick({ target: { closest: () => null } }, { shell }), false);
});
