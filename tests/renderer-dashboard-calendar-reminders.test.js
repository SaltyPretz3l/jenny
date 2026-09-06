const test = require('node:test');
const assert = require('node:assert/strict');

const reminders = require('../renderer/features/renderer-dashboard-calendar-reminders.js');
const { normalizeReminder } = require('../services/shell-config-followups-schema');

// 2026-06-11 is a Thursday.
const THURSDAY = new Date(2026, 5, 11);

function reminder(overrides = {}) {
  return {
    id: 'r1',
    label: 'Stretch',
    prompt: 'Time to stand up.',
    scheduleType: 'daily_at',
    dailyAt: '09:00',
    intervalMinutes: 0,
    onceAt: '',
    sourceKind: '',
    sourceId: '',
    enabled: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastFiredAt: '',
    ...overrides,
  };
}

// ---- daily_at ----

test('a daily_at reminder places one pseudo-instance on a rendered day', () => {
  const mapped = reminders.remindersForDay([reminder()], THURSDAY);
  assert.equal(mapped.length, 1);
  const first = mapped[0];
  assert.equal(first.instanceId, 'reminder:r1');
  assert.equal(first.reminderId, 'r1');
  assert.equal(first.kind, 'reminder');
  assert.equal(first.eventId, '');
  assert.equal(first.title, 'Stretch');
  assert.equal(first.allDay, false);
  assert.equal(first.categoryId, 'default');
  // One-minute span: sorts by clock time, never paints as a duration.
  assert.equal(first.start, '2026-06-11T09:00');
  assert.equal(first.end, '2026-06-11T09:01');
});

test('a daily_at reminder with a missing or malformed time falls back to 09:00', () => {
  assert.equal(reminders.reminderInstanceForDay(reminder({ dailyAt: '' }), THURSDAY).start, '2026-06-11T09:00');
  assert.equal(reminders.reminderInstanceForDay(reminder({ dailyAt: '25:00' }), THURSDAY).start, '2026-06-11T09:00');
  assert.equal(reminders.reminderInstanceForDay(reminder({ dailyAt: '7:5' }), THURSDAY).start, '2026-06-11T09:00');
  assert.equal(reminders.reminderInstanceForDay(reminder({ dailyAt: '17:45' }), THURSDAY).start, '2026-06-11T17:45');
});

test('daily_at reminder normalization accepts clock boundaries and rejects overflows', () => {
  const dailyAt = (value) => normalizeReminder({ scheduleType: 'daily_at', dailyAt: value }).dailyAt;
  assert.equal(dailyAt('00:00'), '00:00');
  assert.equal(dailyAt('23:59'), '23:59');
  assert.equal(dailyAt('24:00'), '09:00');
  assert.equal(dailyAt('23:60'), '09:00');
  assert.equal(dailyAt('25:99'), '09:00');
});

// ---- once_at ----

test('a once_at reminder lands exactly once, on its own date', () => {
  const mapped = reminders.remindersForDay([
    reminder({ id: 'once', scheduleType: 'once_at', dailyAt: '', onceAt: '2026-06-10T14:30' }),
  ], new Date(2026, 5, 10));
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].start, '2026-06-10T14:30');
  assert.equal(mapped[0].end, '2026-06-10T14:31');
  assert.equal(mapped[0].instanceId, 'reminder:once');
});

test('a once_at reminder outside the rendered days places nothing', () => {
  const outside = reminder({ id: 'once', scheduleType: 'once_at', dailyAt: '', onceAt: '2026-07-04T08:00' });
  assert.deepEqual(reminders.remindersForDay([outside], THURSDAY), []);
});

test('a once_at reminder with a malformed stamp is never invented on an arbitrary day', () => {
  for (const onceAt of ['', 'tomorrow', '2026-06-11', '2026-02-30T09:00']) {
    const broken = reminder({ id: 'once', scheduleType: 'once_at', dailyAt: '', onceAt });
    assert.deepEqual(
      reminders.remindersForDay([broken], THURSDAY), [],
      `malformed onceAt ${JSON.stringify(onceAt)} must place nothing`
    );
  }
});

test('a once_at reminder at 23:59 rolls its one-minute end into the next day', () => {
  const late = reminder({ id: 'late', scheduleType: 'once_at', dailyAt: '', onceAt: '2026-06-11T23:59' });
  assert.equal(reminders.reminderInstanceForDay(late, THURSDAY).end, '2026-06-12T00:00');
});

// ---- interval_minutes ----

test('an interval_minutes reminder never reaches the timeline, only the standing list', () => {
  const interval = reminder({
    id: 'legacy', scheduleType: 'interval_minutes', dailyAt: '', intervalMinutes: 45,
  });
  assert.deepEqual(reminders.remindersForDay([interval], THURSDAY), []);
  assert.deepEqual(reminders.listStandingReminders([interval]), [{
    id: 'legacy', label: 'Stretch', intervalMinutes: 45, sourceKind: '', sourceId: '',
  }]);
});

test('standing reminders exclude timeline cadences and disabled records', () => {
  const list = reminders.listStandingReminders([
    reminder(),
    reminder({ id: 'once', scheduleType: 'once_at', onceAt: '2026-06-11T09:00' }),
    reminder({ id: 'off', scheduleType: 'interval_minutes', intervalMinutes: 30, enabled: false }),
    reminder({ id: 'on', scheduleType: 'interval_minutes', intervalMinutes: 30 }),
  ]);
  assert.deepEqual(list.map((entry) => entry.id), ['on']);
});

// ---- enablement + attribution ----

test('disabled reminders are excluded from every day', () => {
  const off = reminder({ enabled: false });
  assert.deepEqual(reminders.remindersForDay([off], THURSDAY), []);
  assert.equal(reminders.reminderInstanceForDay(off, THURSDAY), null);
  // An absent `enabled` key means enabled (the schema default).
  const implied = { id: 'r2', label: 'Implied', scheduleType: 'daily_at', dailyAt: '08:00' };
  assert.ok(reminders.reminderInstanceForDay(implied, THURSDAY));
});

test('an id-less reminder is dropped rather than mapped to "reminder:"', () => {
  assert.equal(reminders.reminderInstanceForDay(reminder({ id: '' }), THURSDAY), null);
});

test('sourceKind and sourceId pass through to the pseudo-instance', () => {
  const attributed = reminders.reminderInstanceForDay(
    reminder({ sourceKind: 'assistant', sourceId: 'msg-42' }), THURSDAY
  );
  assert.equal(attributed.sourceKind, 'assistant');
  assert.equal(attributed.sourceId, 'msg-42');
  const bare = reminders.reminderInstanceForDay(reminder(), THURSDAY);
  assert.equal(bare.sourceKind, '');
  assert.equal(bare.sourceId, '');
});

test('an unknown cadence places nothing rather than guessing a time', () => {
  const weird = reminder({ id: 'weird', scheduleType: 'weekly_at', dailyAt: '' });
  assert.deepEqual(reminders.remindersForDay([weird], THURSDAY), []);
});

// ---- digest ----

test('the reminders digest moves on label, cadence, time, and enablement changes', () => {
  const base = [reminder()];
  const before = reminders.computeRemindersDigest(base);
  assert.deepEqual(reminders.computeRemindersDigest([reminder()]), before);
  assert.notDeepEqual(reminders.computeRemindersDigest([reminder({ label: 'Renamed' })]), before);
  assert.notDeepEqual(reminders.computeRemindersDigest([reminder({ dailyAt: '10:00' })]), before);
  assert.notDeepEqual(reminders.computeRemindersDigest([reminder({ enabled: false })]), before);
  assert.notDeepEqual(
    reminders.computeRemindersDigest([reminder({ scheduleType: 'once_at', onceAt: '2026-06-11T09:00' })]),
    before
  );
  assert.deepEqual(reminders.computeRemindersDigest(null), []);
});

// ---- input tolerance ----

test('non-array and empty inputs degrade to empty results, never throw', () => {
  assert.deepEqual(reminders.remindersForDay(null, THURSDAY), []);
  assert.deepEqual(reminders.remindersForDay([], THURSDAY), []);
  assert.deepEqual(reminders.remindersForDay([reminder()], 'not-a-date'), []);
  assert.deepEqual(reminders.listStandingReminders(undefined), []);
});

/* ---- agenda-card wiring: the week strip and the reminder affordances ----
 *
 * These drive the real calendar controller (not just the pure builders), so
 * they live here rather than in renderer-dashboard-calendar.test.js, which is
 * within a handful of lines of the 1015-line ceiling. */

const { JSDOM } = require('jsdom');

const gridModule = require('../renderer/features/renderer-dashboard-calendar-grid.js');
const agendaModule = require('../renderer/features/renderer-dashboard-calendar-agenda.js');
const toolbarModule = require('../renderer/features/renderer-dashboard-calendar-toolbar.js');
const monthModule = require('../renderer/features/renderer-dashboard-calendar-month.js');
const formModule = require('../renderer/features/renderer-dashboard-calendar-form.js');
const runtimeModule = require('../renderer/features/renderer-dashboard-calendar-runtime.js');
const railModule = require('../renderer/features/renderer-dashboard-calendar-rail.js');
const { createCalendarWidget } = require('../renderer/features/renderer-dashboard-calendar.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryStatusRow = require('../renderer/inventory/status-row.js');
const inventoryChip = require('../renderer/inventory/chip.js');
const inventoryPopover = require('../renderer/inventory/popover.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

const NOW = new Date(2026, 5, 11, 10, 30);

function makeState(remindersList) {
  return {
    calendar: {
      generatedAt: '2026-06-11T10:00:00.000Z',
      windowStart: '2026-06-04T00:00',
      windowEnd: '2026-08-11T00:00',
      categories: [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }],
      instances: [{
        instanceId: 'evt_a:2026-06-11T09:00',
        eventId: 'evt_a',
        readonly: false,
        title: 'Standup',
        start: '2026-06-11T09:00',
        end: '2026-06-11T09:30',
        allDay: false,
        categoryId: 'work',
      }],
      events: [],
      feeds: [],
    },
    proactive: { reminders: Array.isArray(remindersList) ? remindersList : [] },
  };
}

function createHarness({ state = makeState(), viewMode, reminderActions } = {}) {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  inventoryPopover.initPopoverHandlers(dom.window.document);
  if (viewMode) {
    state.homeConfig = { calendar: { viewMode } };
  }
  const widget = createCalendarWidget({
    shell: { calendar: {} },
    actionButton: inventoryActionButton,
    statusRow: inventoryStatusRow,
    gridModule,
    formModule,
    agendaModule,
    toolbarModule,
    monthModule,
    runtimeModule,
    railModule,
    remindersModule: reminders,
    reminderActions,
    chip: inventoryChip,
    popover: inventoryPopover,
    formPrimitives: { actionButton: inventoryActionButton, textField: inventoryTextField },
    nowProvider: () => NOW,
    appendClientLog: () => {},
  });
  return { dom, body, widget, ctx: { state, documentRef: dom.window.document }, state };
}

function click(dom, element) {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));


test('the agenda pane leads with a Sunday-anchored week strip whose cells select a day', () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  const strip = body.querySelector('.cal-week-strip');
  assert.ok(strip, 'week strip lives inside the agenda pane');
  assert.equal(strip.parentElement.classList.contains('cal-pane'), true);
  assert.equal(strip, body.querySelector('.cal-pane').firstElementChild);
  const cells = [...strip.querySelectorAll('[data-cal-day-cell]')];
  assert.equal(cells.length, 7);
  assert.equal(cells[0].dataset.calDayCell, '2026-06-07');
  assert.equal(strip.querySelector('.cal-week-strip__day--today').dataset.calDayCell, '2026-06-11');

  // Reuses the existing day-cell delegation: no new handler, selection for free.
  click(dom, strip.querySelector('[data-cal-day-cell="2026-06-09"]'));
  const selected = body.querySelector('.cal-week-strip [aria-pressed="true"]');
  assert.equal(selected.dataset.calDayCell, '2026-06-09');
  assert.equal(body.querySelector('.cal-agenda__day--selected').textContent.includes('Jun 9'), true);
});

test('the week strip is agenda-only and stands down while a panel owns the pane', () => {
  const { dom, body, widget, ctx } = createHarness({ viewMode: 'week' });
  widget.render(body, ctx);
  assert.equal(body.querySelector('.cal-week-strip'), null);

  const agenda = createHarness();
  agenda.widget.render(agenda.body, agenda.ctx);
  click(agenda.dom, agenda.body.querySelector('[data-cal-new-event]'));
  assert.equal(agenda.body.querySelector('.cal-week-strip'), null);
});

test('reminders render in the agenda and Done calls the manager remove action', async () => {
  const removed = [];
  const { dom, body, widget, ctx } = createHarness({
    state: makeState([{
      id: 'r1', label: 'Stretch', scheduleType: 'daily_at', dailyAt: '11:00', enabled: true,
    }]),
    reminderActions: { remove: async (id) => { removed.push(id); } },
  });
  widget.render(body, ctx);

  const row = body.querySelector('[data-cal-reminder-id="r1"]');
  assert.ok(row, 'reminder row present in the agenda');
  click(dom, row.querySelector('[data-cal-reminder-dismiss]'));
  await flush();
  assert.deepEqual(removed, ['r1']);
});

test('a reminder edit repaints the agenda even though reminders are outside the calendar snapshot', () => {
  const { body, widget, ctx } = createHarness({
    state: makeState([{
      id: 'r1', label: 'Stretch', scheduleType: 'daily_at', dailyAt: '11:00', enabled: true,
    }]),
  });
  widget.render(body, ctx);
  const firstKey = body.dataset.calRenderKey;
  assert.match(body.textContent, /Stretch/);

  ctx.state.proactive.reminders = [{
    id: 'r1', label: 'Walk', scheduleType: 'daily_at', dailyAt: '11:00', enabled: true,
  }];
  widget.render(body, ctx);
  assert.notEqual(body.dataset.calRenderKey, firstKey);
  assert.match(body.textContent, /Walk/);
  assert.doesNotMatch(body.textContent, /Stretch/);
});
