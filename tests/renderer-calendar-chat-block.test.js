'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const calendarBlock = require('../renderer/chat/renderer-calendar-chat-block');

const NOW = new Date(2026, 8, 7, 11, 0);

function instance(overrides = {}) {
  return {
    instance_id: 'instance-1',
    event_id: 'event-1',
    title: 'Standup',
    start: '2026-09-07T10:00',
    end: '2026-09-07T10:30',
    all_day: false,
    category: 'work',
    source: 'local',
    source_kind: 'user',
    readonly: false,
    tz_approx: false,
    recurrence_unsupported: false,
    kind: 'event',
    ...overrides,
  };
}

function demoCalendar(overrides = {}) {
  const instances = [
    instance({ instance_id: 'earlier', event_id: 'earlier', title: 'Sunday prep', start: '2026-09-06T16:00', end: '2026-09-06T17:00' }),
    instance(),
    instance({ instance_id: 'reminder', event_id: '', title: 'Send agenda', start: '2026-09-08T09:00', end: '2026-09-08T09:00', category: 'default', kind: 'reminder' }),
    instance({ instance_id: 'vendor', event_id: 'vendor', title: 'Vendor review', start: '2026-09-08T13:30', end: '2026-09-08T14:15' }),
    instance({ instance_id: 'dentist', event_id: 'dentist', title: 'Dentist', start: '2026-09-09T09:00', end: '2026-09-09T10:00', category: 'personal' }),
    instance({
      instance_id: 'budget', event_id: 'budget', title: 'Budget review', start: '2026-09-09T15:00', end: '2026-09-09T16:00',
      category: 'meeting', source_kind: 'assistant', recent: 'created', journal_entry_id: 'journal-budget',
    }),
    instance({ instance_id: 'close', event_id: 'close', title: 'Month-end close', start: '2026-09-10T00:00', end: '2026-09-11T00:00', all_day: true, category: 'focus' }),
    instance({
      instance_id: 'sync', event_id: '', title: 'Team sync', start: '2026-09-10T14:00', end: '2026-09-10T15:00',
      source: 'feed', readonly: true, tz_approx: true, recurrence_unsupported: true,
    }),
    instance({ instance_id: 'overlap-a', event_id: 'overlap-a', title: 'Roadmap', start: '2026-09-11T09:00', end: '2026-09-11T10:00' }),
    instance({
      instance_id: 'overlap-b', event_id: 'overlap-b', title: 'Hiring review', start: '2026-09-11T09:30', end: '2026-09-11T10:30',
      recent: 'updated', overlaps: [
        { instance_id: 'overlap-a', title: 'Roadmap', start: '2026-09-11T09:00' },
        { instance_id: 'overlap-c', title: 'Planning', start: '2026-09-11T09:15' },
      ],
    }),
  ];
  return {
    schema_version: 1,
    range_start: '2026-09-06T00:00',
    range_end: '2026-09-13T00:00',
    generated_at: '2026-09-07T11:00',
    instance_count: instances.length,
    omitted_count: 0,
    instances,
    ...overrides,
  };
}

function deps(overrides = {}) {
  return { now: NOW, actionButton, ...overrides };
}

function renderCalendar(value, overrides = {}) {
  return calendarBlock.buildCalendarBlockMarkup(value, deps(overrides));
}

function renderReceipt(value, overrides = {}) {
  return calendarBlock.buildReceiptMarkup(value, deps(overrides));
}

function receipt(overrides = {}) {
  return {
    schema_version: 1,
    kind: 'event',
    op: 'create',
    id: 'event-new',
    title: 'Design review',
    start: '2026-09-09T15:00',
    end: '2026-09-09T16:00',
    all_day: false,
    category: 'meeting',
    journal_entry_id: 'journal-new',
    journaled: true,
    ...overrides,
  };
}

test('normalizers bound raw calendar arrays and reject malformed shapes', () => {
  const entries = [instance({ start: 'not-a-date' })];
  for (let index = 0; index < 45; index += 1) {
    entries.push(instance({
      instance_id: `instance-${index}`,
      event_id: `event-${index}`,
      start: `2026-09-${String(7 + (index % 3)).padStart(2, '0')}T10:00`,
      overlaps: Array.from({ length: 12 }, (_, overlapIndex) => ({
        instance_id: `other-${overlapIndex}`,
        title: `Other ${overlapIndex}`,
        start: '2026-09-07T09:00',
      })),
    }));
  }
  const normalized = calendarBlock.normalizeCalendarMetadata(demoCalendar({ instances: entries }));
  assert.equal(normalized.instances.length, 40);
  assert.equal(normalized.instances[0].overlaps.length, 8);
  assert.equal(calendarBlock.normalizeCalendarMetadata([]), null);
  assert.equal(calendarBlock.normalizeCalendarMetadata({ schema_version: 2 }), null);
  assert.equal(calendarBlock.normalizeCalendarMetadata({ schema_version: 1 }), null);
  assert.equal(calendarBlock.normalizeCalendarMetadata(demoCalendar({ range_start: '2026-13-99T99:99' })), null);
  assert.equal(calendarBlock.normalizeReceiptMetadata(null), null);
  assert.equal(calendarBlock.normalizeReceiptMetadata({ schema_version: 2 }), null);
});

test('nonpositive calendar ranges fall back instead of rendering backward labels', () => {
  const start = '2026-09-07T00:00';
  for (const end of [start, '2026-09-06T23:59']) {
    const calendar = demoCalendar({ range_start: start, range_end: end });
    assert.equal(calendarBlock.normalizeCalendarMetadata(calendar), null);
    assert.equal(renderCalendar(calendar), '');
    assert.equal(calendarBlock.formatRangeLabel(start, end, NOW), '');
  }
});

test('date headings and ranges follow today, tomorrow, month, and year grammar', () => {
  assert.equal(calendarBlock.formatDayHeading('2026-09-07', NOW), 'Today · Mon, Sep 7');
  assert.equal(calendarBlock.formatDayHeading('2026-09-08', NOW), 'Tomorrow · Tue, Sep 8');
  assert.equal(calendarBlock.formatDayHeading('2026-09-09', NOW), 'Wed, Sep 9');
  assert.equal(calendarBlock.formatDayHeading('2027-09-09', NOW), 'Thu, Sep 9, 2027');
  assert.equal(calendarBlock.formatRangeLabel('2026-09-07T00:00', '2026-09-13T00:00', NOW), 'Sep 7–12');
  assert.equal(calendarBlock.formatRangeLabel('2026-09-28T00:00', '2026-10-04T00:00', NOW), 'Sep 28 – Oct 3');
  assert.equal(calendarBlock.formatRangeLabel('2027-09-07T00:00', '2027-09-13T00:00', NOW), 'Sep 7, 2027 – Sep 12, 2027');
});

test('calendar labels respect exclusive ends across month, year, DST, and partial-day ranges', () => {
  for (const [start, end, expected] of [
    ['2026-09-30T00:00', '2026-10-01T00:00', 'Sep 30'],
    ['2026-12-31T00:00', '2027-01-01T00:00', 'Dec 31'],
    ['2027-01-01T00:00', '2027-01-02T00:00', 'Jan 1, 2027'],
    ['2026-03-08T00:00', '2026-03-09T00:00', 'Mar 8'],
    ['2026-11-01T00:00', '2026-11-02T00:00', 'Nov 1'],
    ['2026-09-07T00:00', '2026-09-08T12:00', 'Sep 7–8'],
  ]) assert.equal(calendarBlock.formatRangeLabel(start, end, NOW), expected);
  const partial = calendarBlock.planVisibleRows(demoCalendar({
    range_start: '2026-09-07T00:00', range_end: '2026-09-08T12:00', instances: [instance()], instance_count: 1,
  }), NOW);
  assert.equal(partial.tail, '', 'an unqueried afternoon is not a free calendar day');
});

test('an event beyond the real home-service query is not advertised as a free day', () => {
  const { HomeAssistantService } = require('../services/home-assistant-service');
  const { shapeCalendarMetadata } = require('../services/tools/builtin/home-calendar-result-shape');
  const start = '2026-09-07T00:00';
  const end = '2026-09-08T00:00';
  const listing = HomeAssistantService.prototype.listCalendar.call({ calendarService: { getState: () => ({
    windowStart: start, windowEnd: '2026-09-10T00:00', instances: [
      { instanceId: 'mon', eventId: 'mon', title: 'Monday', start: '2026-09-07T10:00', end: '2026-09-07T11:00' },
      { instanceId: 'tue', eventId: 'tue', title: 'Tuesday appointment', start: '2026-09-08T09:00', end: '2026-09-08T10:00' },
    ],
  }) } }, { start, end });
  assert.equal(listing.instances.length, 1);
  const html = renderCalendar(shapeCalendarMetadata({ listing, now: NOW }));
  assert.match(html, /Calendar, Sep 7, 1 event/);
  assert.doesNotMatch(html, /Tue|nothing scheduled/);
});

test('visible-row plan groups, sorts, counts reminders, and marks only ended timed events past', () => {
  const plan = calendarBlock.planVisibleRows(demoCalendar(), NOW);
  assert.equal(plan.earlierCount, 1);
  assert.deepEqual(plan.days.map((day) => day.heading), [
    'Today · Mon, Sep 7', 'Tomorrow · Tue, Sep 8', 'Wed, Sep 9', 'Thu, Sep 10', 'Fri, Sep 11',
  ]);
  assert.deepEqual(plan.days[1], {
    dayKey: '2026-09-08',
    heading: 'Tomorrow · Tue, Sep 8',
    eventCount: 1,
    reminderCount: 1,
    rows: plan.days[1].rows,
  });
  assert.equal(plan.days[3].rows[0].title, 'Month-end close');
  assert.equal(plan.days[3].rows[0].all_day, true);
  assert.equal(plan.days[0].rows[0].isPast, true);
  assert.equal(plan.days[1].rows[0].isPast, false);
  assert.equal(plan.remaining, 0);
  assert.equal(plan.tail, 'Sat · nothing scheduled');
  assert.equal(plan.empty, false);
  assert.equal(plan.firstDayKey, '2026-09-07');
});

test('row cap stops at twelve, includes omitted results, and suppresses the quiet tail', () => {
  const instances = Array.from({ length: 14 }, (_, index) => instance({
    instance_id: `cap-${index}`,
    event_id: `cap-${index}`,
    title: `Event ${String(index).padStart(2, '0')}`,
    start: `2026-09-${String(7 + Math.floor(index / 4)).padStart(2, '0')}T${String(8 + (index % 4)).padStart(2, '0')}:00`,
    end: `2026-09-${String(7 + Math.floor(index / 4)).padStart(2, '0')}T${String(9 + (index % 4)).padStart(2, '0')}:00`,
  }));
  const calendar = demoCalendar({ instances, instance_count: 16, omitted_count: 2 });
  const plan = calendarBlock.planVisibleRows(calendar, NOW);
  assert.equal(plan.days.reduce((count, day) => count + day.rows.length, 0), 12);
  assert.equal(plan.remaining, 4);
  assert.equal(plan.tail, '');
  const html = renderCalendar(calendar);
  assert.match(html, /<span class="cal-chat__more">4 more<\/span>/);
  assert.doesNotMatch(html, /nothing scheduled/);
});

test('tail and empty-range planning covers one day, multiple days, and no rows', () => {
  const oneDay = calendarBlock.planVisibleRows(demoCalendar({
    range_start: '2026-09-07T00:00', range_end: '2026-09-08T00:00', instances: [instance()], instance_count: 1,
  }), NOW);
  assert.equal(oneDay.tail, '');
  assert.equal(oneDay.rangeLabel, 'Sep 7');

  const severalDays = calendarBlock.planVisibleRows(demoCalendar({
    range_start: '2026-09-07T00:00', range_end: '2026-09-10T00:00', instances: [instance()], instance_count: 1,
  }), NOW);
  assert.equal(severalDays.tail, 'Tue–Wed · nothing scheduled');

  const emptyCalendar = demoCalendar({
    range_start: '2026-09-07T00:00', range_end: '2026-09-09T00:00', instances: [], instance_count: 0,
  });
  const empty = calendarBlock.planVisibleRows(emptyCalendar, NOW);
  assert.equal(empty.empty, true);
  assert.equal(empty.tail, 'Tue · nothing scheduled');
  const html = renderCalendar(emptyCalendar);
  assert.match(html, /No events Sep 7–8\./);
  assert.match(html, /data-cal-open-day="2026-09-07"/);
});

test('calendar markup renders day grammar, statuses, overlap detail, and safe sibling undo', () => {
  const html = renderCalendar(demoCalendar());
  assert.match(html, /aria-label="Calendar, Sep 6–12, 10 events"/);
  assert.match(html, /Earlier · 1 event/);
  assert.match(html, /cal-chat__day--today/);
  assert.match(html, /1 event · 1 reminder/);
  assert.match(html, /cal-chat__row--past/);
  assert.match(html, /cal-chat__row--all-day/);
  assert.match(html, /cal-chat__row--feed/);
  assert.match(html, /title="Subscribed feed event">feed/);
  assert.match(html, /title="Approximate time \(unrecognized feed time zone\)">~tz/);
  assert.match(html, /title="Recurrence only partially supported">↻/);
  assert.match(html, /cal-chat__row--reminder/);
  assert.match(html, /title="Reminder — nudges are manual">reminder/);
  assert.match(html, /title="Added by jenny">jenny/);
  assert.match(html, /<span class="cal-chat__new">new<\/span>/);
  assert.match(html, /<span class="cal-chat__new">updated<\/span>/);
  assert.match(html, /overlaps Roadmap \(9 AM\) \+1/);
  assert.match(html, /data-cal-undo-journal="journal-budget"/);
  assert.match(html, /Undo jenny&#39;s change to Budget review/);
});

test('calendar undo marks evicted journals while preserving live and missing states', () => {
  const evicted = renderCalendar(demoCalendar(), { hasLiveJournalEntry: () => false });
  assert.match(evicted, /data-cal-undo-journal="journal-budget"/);
  assert.match(evicted, /data-cal-undo-evicted="1"/);

  const live = renderCalendar(demoCalendar(), { hasLiveJournalEntry: () => true });
  assert.match(live, /data-cal-undo-journal="journal-budget"/);
  assert.doesNotMatch(live, /data-cal-undo-evicted/);

  const withoutJournal = demoCalendar({
    instances: [instance({ recent: 'created', source_kind: 'assistant', journal_entry_id: '' })],
    instance_count: 1,
  });
  assert.doesNotMatch(renderCalendar(withoutJournal), /data-cal-undo-journal/);
});

test('calendar markup escapes titles and falls back for unsafe category suffixes', () => {
  const html = renderCalendar(demoCalendar({
    instances: [instance({ title: '<script>alert(1)</script>', category: 'work bad' })],
    instance_count: 1,
  }));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /cal-event--default/);
});

test('event receipts cover timed, all-day, delete, category, jenny, and undo states', () => {
  const created = renderReceipt(receipt());
  assert.match(created, /data-cal-receipt-op="create"/);
  assert.match(created, /Wed, Sep 9 · 3 PM–4 PM/);
  assert.match(created, />meeting<\/span>/);
  assert.match(created, /title="Added by jenny">jenny/);
  assert.match(created, /data-cal-undo-journal="journal-new"/);

  const allDay = renderReceipt(receipt({ start: '2026-09-10T00:00', end: '2026-09-11T00:00', all_day: true }));
  assert.match(allDay, /Thu, Sep 10 · All day/);

  const deleted = renderReceipt(receipt({ op: 'delete' }));
  assert.match(deleted, /cal-chat__row--deleted/);
  assert.match(deleted, />deleted<\/span>/);

  const notJournaled = renderReceipt(receipt({ journaled: false }));
  assert.doesNotMatch(notJournaled, /data-cal-undo-journal/);
  assert.equal(renderReceipt(receipt({ start: '2026-02-30T09:00' })), '');
  assert.equal(renderReceipt(receipt({ kind: 'task' })), '');
});

test('equal-start rows use instance ids and keep overlap annotation on the marked row', () => {
  const html = renderCalendar(demoCalendar({
    instances: [
      instance({ instance_id: 'a', event_id: 'a', title: 'Zebra', start: '2026-09-09T09:00', end: '2026-09-09T10:00' }),
      instance({
        instance_id: 'b', event_id: 'b', title: 'Alpha', start: '2026-09-09T09:00', end: '2026-09-09T10:00',
        overlaps: [{ instance_id: 'a', title: 'Zebra', start: '2026-09-09T09:00' }],
      }),
    ],
    instance_count: 2,
  }));
  const rows = [...JSDOM.fragment(html).querySelectorAll('.cal-chat__row')];
  assert.deepEqual(rows.map((row) => row.querySelector('.cal-chat__title').textContent), ['Zebra', 'Alpha']);
  assert.equal(rows[0].querySelector('.cal-chat__overlap'), null);
  assert.equal(rows[1].querySelector('.cal-chat__overlap').textContent, 'overlaps Zebra (9 AM)');
});

test('reminder receipts format once and daily schedules without event duration grammar', () => {
  const once = renderReceipt(receipt({
    kind: 'reminder', id: 'reminder-once', title: 'Send notes', schedule_type: 'once_at', when: '2026-09-08T09:00', category: '',
  }));
  assert.match(once, /Tue, Sep 8 · 9 AM/);
  assert.match(once, /title="Reminder — nudges are manual">reminder/);
  assert.match(once, /aria-label="Added reminder: Send notes, Tue, Sep 8 · 9 AM"/);

  const daily = renderReceipt(receipt({
    kind: 'reminder', id: 'reminder-daily', title: 'Stretch', schedule_type: 'daily_at', when: '09:30', category: '',
  }));
  assert.match(daily, /Daily · 9:30 AM/);
  assert.doesNotMatch(daily, /data-cal-open-day/);

  const intervalMinutes = renderReceipt(receipt({
    kind: 'reminder', id: 'reminder-interval', title: 'Move around', schedule_type: 'interval_minutes', when: '45', category: '',
  }));
  assert.match(intervalMinutes, /Every 45 min/);
  assert.doesNotMatch(intervalMinutes, /data-cal-open-day/);

  const intervalHours = renderReceipt(receipt({
    kind: 'reminder', id: 'reminder-hours', title: 'Check queue', schedule_type: 'interval_minutes', when: '120', category: '',
  }));
  assert.match(intervalHours, /Every 2 h/);

  const malformedOnce = renderReceipt(receipt({
    kind: 'reminder', id: 'reminder-bad-once', schedule_type: 'once_at', when: 'junk', category: '',
  }));
  assert.doesNotMatch(malformedOnce, /data-cal-open-day/);
  assert.doesNotMatch(malformedOnce, /aria-label="[^"]+, "/);

  const malformedDaily = calendarBlock.normalizeReceiptMetadata(receipt({
    kind: 'reminder', id: 'reminder-bad-daily', schedule_type: 'daily_at', when: '9:00', category: '',
  }));
  assert.equal(malformedDaily.when, '');
});

test('home result dispatch is fail-closed for non-home and malformed metadata', () => {
  assert.match(calendarBlock.buildHomeResultBlockMarkup({ result_kind: 'home', calendar: demoCalendar() }, deps()), /data-cal-chat="list"/);
  assert.match(calendarBlock.buildHomeResultBlockMarkup({ result_kind: 'home', calendar_receipt: receipt() }, deps()), /data-cal-chat="receipt"/);
  assert.equal(calendarBlock.buildHomeResultBlockMarkup({ result_kind: 'verify', calendar: demoCalendar() }, deps()), '');
  assert.equal(calendarBlock.buildHomeResultBlockMarkup({ result_kind: 'home' }, deps()), '');
  assert.equal(calendarBlock.buildHomeResultBlockMarkup({
    result_kind: 'home', status: ' confirmation_required ', calendar_receipt: receipt(),
  }, deps()), '');
  assert.equal(calendarBlock.buildHomeResultBlockMarkup({ result_kind: 'home', calendar: { schema_version: 1 } }, deps()), '');
  assert.equal(calendarBlock.buildHomeResultBlockMarkup(null, deps()), '');
  assert.equal(calendarBlock.buildHomeResultBlockMarkup({
    get result_kind() { throw new Error('malformed'); },
  }, deps()), '');
});

test('every rendered calendar and receipt control carries a title attribute', () => {
  for (const html of [renderCalendar(demoCalendar()), renderReceipt(receipt())]) {
    const fragment = JSDOM.fragment(html);
    const controls = [...fragment.querySelectorAll('button')];
    assert.ok(controls.length > 0);
    assert.ok(controls.every((control) => control.hasAttribute('title')));
  }
});
