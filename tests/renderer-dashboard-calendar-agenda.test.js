const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const agenda = require('../renderer/features/renderer-dashboard-calendar-agenda.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

// 2026-06-11 is a Thursday (getDay() === 4); its Sunday is 2026-06-07.
const NOW = new Date(2026, 5, 11, 10, 30);

function domFragment(html) {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  return dom.window.document.getElementById('root');
}

function instance(overrides = {}) {
  return {
    instanceId: 'evt:2026-06-11T09:00',
    eventId: 'evt',
    source: 'local',
    readonly: false,
    title: 'Standup',
    start: '2026-06-11T09:00',
    end: '2026-06-11T09:30',
    allDay: false,
    categoryId: 'work',
    notes: '',
    recurring: false,
    recurrenceUnsupported: false,
    ...overrides,
  };
}

// ---- parseQuickAdd ----

test('parseQuickAdd reads weekday + meridiem time into a complete descriptor', () => {
  const parsed = agenda.parseQuickAdd('standup Mon 9am', NOW);
  assert.deepEqual(parsed, {
    ok: true, ambiguous: false, allDay: false,
    title: 'standup', date: '2026-06-15', start: '09:00', end: '10:00',
  });
});

test('parseQuickAdd handles tomorrow + half-hour pm time', () => {
  const parsed = agenda.parseQuickAdd('lunch tomorrow 12:30pm', NOW);
  assert.equal(parsed.title, 'lunch');
  assert.equal(parsed.date, '2026-06-12');
  assert.equal(parsed.start, '12:30');
  assert.equal(parsed.end, '13:30');
});

test('parseQuickAdd defaults the date to today when no day word is present', () => {
  const parsed = agenda.parseQuickAdd('review 3pm', NOW);
  assert.equal(parsed.date, '2026-06-11');
  assert.equal(parsed.start, '15:00');
  assert.equal(parsed.end, '16:00');
});

test('parseQuickAdd reads an all-day phrase with no time', () => {
  const parsed = agenda.parseQuickAdd('all day friday conference', NOW);
  assert.equal(parsed.allDay, true);
  assert.equal(parsed.title, 'conference');
  assert.equal(parsed.date, '2026-06-12');
  assert.equal(parsed.start, '');
});

test('parseQuickAdd reads a shared-meridiem range', () => {
  const parsed = agenda.parseQuickAdd('sync 9-10am', NOW);
  assert.equal(parsed.start, '09:00');
  assert.equal(parsed.end, '10:00');
  assert.equal(parsed.title, 'sync');
});

test('parseQuickAdd infers the preceding meridiem for an ordered shared range', () => {
  const parsed = agenda.parseQuickAdd('lunch 11-1pm', NOW);
  assert.deepEqual(parsed, {
    ok: true, ambiguous: false, allDay: false,
    title: 'lunch', date: '2026-06-11', start: '11:00', end: '13:00',
  });
});

test('parseQuickAdd keeps an invalid descending shared range ambiguous', () => {
  const parsed = agenda.parseQuickAdd('call 9-8am', NOW);
  assert.deepEqual(parsed, {
    ok: true, ambiguous: true, allDay: false,
    title: 'call', date: '2026-06-11', start: '', end: '',
  });
});

test('parseQuickAdd reads a both-sided range', () => {
  const parsed = agenda.parseQuickAdd('call 9am-11am', NOW);
  assert.equal(parsed.start, '09:00');
  assert.equal(parsed.end, '11:00');
});

test('parseQuickAdd flags ambiguity when no time or all-day is given', () => {
  const parsed = agenda.parseQuickAdd('talk to sam tomorrow', NOW);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ambiguous, true);
  // Interior connector words survive edge-only cleanup.
  assert.equal(parsed.title, 'talk to sam');
  assert.equal(parsed.date, '2026-06-12');
});

test('parseQuickAdd rejects empty input and time-only phrases', () => {
  assert.equal(agenda.parseQuickAdd('', NOW).ok, false);
  assert.equal(agenda.parseQuickAdd('   ', NOW).ok, false);
  assert.equal(agenda.parseQuickAdd('3pm', NOW).ok, false);
});

test('parseQuickAdd does not capture a bare integer as a time', () => {
  const parsed = agenda.parseQuickAdd('level 9 retro', NOW);
  assert.equal(parsed.ambiguous, true); // no real time token
  assert.equal(parsed.title, 'level 9 retro');
});

// ---- findConflicts ----

test('findConflicts reports overlapping same-day timed events', () => {
  const parsed = agenda.parseQuickAdd('review 9:15am', NOW); // 09:15-10:15 today
  const conflicts = agenda.findConflicts(parsed, [
    instance({ title: 'Standup', start: '2026-06-11T09:00', end: '2026-06-11T09:30' }),
    instance({ title: 'Elsewhere', start: '2026-06-11T15:00', end: '2026-06-11T16:00' }),
    instance({ title: 'Other day', start: '2026-06-12T09:15', end: '2026-06-12T10:15' }),
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].title, 'Standup');
});

test('findConflicts ignores all-day events and all-day descriptors', () => {
  const timed = agenda.parseQuickAdd('review 9:15am', NOW);
  assert.deepEqual(agenda.findConflicts(timed, [
    instance({ title: 'Holiday', allDay: true, start: '2026-06-11T00:00', end: '2026-06-12T00:00' }),
  ]), []);
  const allDayParsed = agenda.parseQuickAdd('all day today rest', NOW);
  assert.deepEqual(agenda.findConflicts(allDayParsed, [instance()]), []);
});

// ---- buildAgendaMarkup ----

test('buildAgendaMarkup renders seven day groups with counts and marks up next', () => {
  const root = domFragment(agenda.buildAgendaMarkup({
    weekStart: new Date(2026, 5, 8),
    instances: [
      instance({ title: 'Standup', start: '2026-06-11T09:00', end: '2026-06-11T09:30' }),
      instance({ instanceId: 'r', title: 'Review', start: '2026-06-11T14:00', end: '2026-06-11T15:00', categoryId: 'meeting' }),
      instance({ instanceId: 's', title: 'Saturday thing', start: '2026-06-13T11:00', end: '2026-06-13T12:00' }),
    ],
    now: NOW,
    actionButton: inventoryActionButton,
  }));

  const groups = root.querySelectorAll('.cal-agenda__group');
  assert.equal(groups.length, 7);
  assert.match(root.querySelector('.cal-agenda__day--today').textContent, /Today/);
  assert.match(root.querySelector('.cal-agenda__day--today .cal-agenda__day-count').textContent, /2 events/);

  // Standup already ended at 10:30 now, so Review is "up next" with a pill.
  const next = root.querySelector('.cal-agenda__item--next');
  assert.ok(next);
  assert.match(next.textContent, /Review/);
  assert.ok(root.querySelector('[data-cal-rel]'));
  // Rows carry the edit dataset so the controller's click handler works as-is.
  assert.equal(next.dataset.calEventId, 'evt');
});

test('buildAgendaMarkup always shows an empty today group when today is in the week', () => {
  const root = domFragment(agenda.buildAgendaMarkup({
    weekStart: new Date(2026, 5, 8),
    instances: [instance({ title: 'Saturday', start: '2026-06-13T11:00', end: '2026-06-13T12:00' })],
    now: NOW,
    actionButton: inventoryActionButton,
  }));
  const heads = [...root.querySelectorAll('.cal-agenda__day')].map((el) => el.textContent);
  assert.ok(heads.some((t) => /Today/.test(t)));
  assert.match(root.querySelector('.cal-agenda__day--today').parentElement.textContent, /Open/);
});

/* W8-3: an empty day used to render a thin, inert "Open" <li> while a busy day
 * rendered full rows — so a light week read as barren. Every day now closes
 * with the SAME open-slot row, and it is a real agenda row that reuses the
 * month grid's create hook. */
test('every day closes with exactly one open-slot row, empty or busy', () => {
  const root = domFragment(agenda.buildAgendaMarkup({
    weekStart: new Date(2026, 5, 8),
    instances: [
      instance({ title: 'Standup', start: '2026-06-11T09:00', end: '2026-06-11T09:30' }),
      instance({ instanceId: 'r', title: 'Review', start: '2026-06-11T14:00', end: '2026-06-11T15:00' }),
    ],
    now: NOW,
    actionButton: inventoryActionButton,
  }));

  // Seven days, seven slots — no day is skipped and none is doubled up.
  assert.equal(root.querySelectorAll('.cal-agenda__group').length, 7);
  assert.equal(root.querySelectorAll('.cal-agenda__item--open').length, 7);

  // The busy day keeps its two event rows AND gets one slot, rendered last.
  const busy = root.querySelector('[data-cal-agenda-day="2026-06-11"]');
  assert.equal(busy.querySelectorAll('[data-cal-instance]').length, 2);
  const busySlots = busy.querySelectorAll('.cal-agenda__item--open');
  assert.equal(busySlots.length, 1, 'a day with events renders it once, not per event');
  assert.equal(busy.querySelector('.cal-agenda__list').lastElementChild, busySlots[0].parentElement);

  // An empty day carries the same row class as an event row — same grid, same
  // weight — rather than the old thin label.
  const emptyDay = root.querySelector('[data-cal-agenda-day="2026-06-09"] .cal-agenda__item--open');
  assert.ok(emptyDay);
  assert.ok(emptyDay.classList.contains('cal-agenda__item'), 'styled as an agenda row');
  assert.equal(emptyDay.closest('.cal-agenda__item-wrap').tagName, 'LI');
  assert.match(emptyDay.textContent, /Open/);

  // It targets ITS OWN date through the month grid's existing create hook, so
  // the calendar controller opens the form pre-dated to that day.
  assert.equal(emptyDay.dataset.calMonthDay, '2026-06-09');
  assert.equal(busySlots[0].dataset.calMonthDay, '2026-06-11');
  assert.match(emptyDay.getAttribute('aria-label'), /^Open — add an event on \S/);
  assert.equal(root.querySelector('.cal-agenda__empty-day'), null, 'the thin label is gone');
});

/* Owner feedback wave 2: the slot used to DOUBLE-LABEL — "Open" in the time cell
 * AND "Add an event" as the title — which read as clutter seven rows deep. The
 * time cell is now empty (kept, so the row keeps an event row's grid geometry),
 * the title is just "Open", and the invitation moved to the meta slot, which CSS
 * reveals on hover/focus. The accessible name must NOT be hover-gated. */
test('the open slot labels once: empty time cell, "Open" title, hover-revealed meta hint', () => {
  const root = domFragment(agenda.buildAgendaMarkup({
    weekStart: new Date(2026, 5, 8),
    instances: [],
    now: NOW,
    actionButton: inventoryActionButton,
  }));
  const slot = root.querySelector('[data-cal-agenda-day="2026-06-09"] .cal-agenda__item--open');

  // The time cell survives (grid alignment with event rows) but says nothing.
  const time = slot.querySelector('.cal-agenda__time');
  assert.ok(time, 'the time cell is kept so the columns still line up');
  assert.equal(time.textContent, '', 'the time cell no longer duplicates the label');

  // The hollow dot stays; the title is the single at-rest label.
  assert.ok(slot.querySelector('.cal-agenda__dot'));
  assert.equal(slot.querySelector('.cal-agenda__title').textContent, 'Open');

  // The invitation lives in the meta slot, tagged for the hover/focus reveal.
  const hint = slot.querySelector('.cal-agenda__meta');
  assert.ok(hint.classList.contains('cal-agenda__open-hint'), 'the reveal hook is on the meta cell');
  assert.match(hint.textContent, /add an event/);

  // A screen reader gets the whole sentence with no hover involved.
  assert.match(slot.getAttribute('aria-label'), /^Open — add an event on Tuesday · Jun 9$/);
});

/* Owner feedback wave 2 supersedes the old "No events this week" block: a wholly
 * empty week is not a dead end, it is seven bookable days. It renders the SAME
 * seven day groups every other week renders, each closing with its own open
 * slot targeting its own date. */
test('a wholly empty week renders seven day groups with seven open slots', () => {
  const weekStart = new Date(2026, 6, 6); // no instances, and today is not in it
  const root = domFragment(agenda.buildAgendaMarkup({
    weekStart,
    instances: [],
    now: NOW,
    actionButton: inventoryActionButton,
  }));

  // The retired empty block, in all three of its parts.
  assert.equal(root.querySelector('.cal-agenda__empty'), null);
  assert.equal(root.querySelector('.cal-agenda__empty-title'), null);
  assert.equal(root.querySelector('.cal-agenda__empty-hint'), null);

  const groups = [...root.querySelectorAll('.cal-agenda__group')];
  assert.equal(groups.length, 7, 'seven day groups, exactly as a busy week renders');
  assert.equal(root.querySelectorAll('.cal-agenda__item--open').length, 7);

  // Every group carries its day heading and its em-dash count, unchanged from
  // the populated path — no zero-data divergence in the group chrome.
  assert.deepEqual(
    groups.map((group) => group.dataset.calAgendaDay),
    ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12']
  );
  assert.deepEqual(
    groups.map((group) => group.querySelector('.cal-agenda__day-count').textContent),
    ['—', '—', '—', '—', '—', '—', '—']
  );
  groups.forEach((group) => {
    assert.ok(group.querySelector('.cal-agenda__day-label').textContent.length > 0);
  });

  // Each slot is pre-dated to ITS OWN day through the month grid's create hook.
  assert.deepEqual(
    [...root.querySelectorAll('.cal-agenda__item--open')].map((el) => el.dataset.calMonthDay),
    ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12']
  );

  // Still true from the retired test: creation belongs to the header's New
  // button, so the agenda body renders no create button of its own.
  assert.equal(root.querySelector('[data-cal-new-event]'), null);
});

test('buildAgendaMarkup treats a prior event ending at week start as outside the week', () => {
  const root = domFragment(agenda.buildAgendaMarkup({
    weekStart: new Date(2026, 5, 8),
    instances: [instance({
      title: 'Sunday late shift',
      start: '2026-06-07T23:00',
      end: '2026-06-08T00:00',
    })],
    now: NOW,
    actionButton: inventoryActionButton,
  }));
  // The event contributes no row anywhere in the week, so every day is bare and
  // the week is all open slots — no event row survives the boundary test.
  assert.equal(root.querySelectorAll('[data-cal-instance]').length, 0);
  assert.equal(root.querySelectorAll('.cal-agenda__item--open').length, 7);
  assert.equal(root.querySelector('[data-cal-agenda-day="2026-06-08"] .cal-agenda__day-count').textContent, '—');
});

test('buildAgendaMarkup tags timed rows with their end and dims already-ended ones', () => {
  const root = domFragment(agenda.buildAgendaMarkup({
    weekStart: new Date(2026, 5, 8),
    instances: [
      instance({ title: 'Standup', start: '2026-06-11T09:00', end: '2026-06-11T09:30' }), // ended (now 10:30)
      instance({ instanceId: 'r', title: 'Review', start: '2026-06-11T14:00', end: '2026-06-11T15:00' }), // upcoming
    ],
    now: NOW,
    actionButton: inventoryActionButton,
  }));
  const items = [...root.querySelectorAll('.cal-agenda__item')];
  // Both timed rows carry data-cal-end so the 30s tick can re-evaluate past-ness.
  assert.equal(items.filter((el) => el.dataset.calEnd).length, 2);
  const standup = items.find((el) => /Standup/.test(el.textContent));
  const review = items.find((el) => /Review/.test(el.textContent));
  assert.ok(standup.classList.contains('cal-agenda__item--past'), 'ended row dimmed at build time');
  assert.ok(!review.classList.contains('cal-agenda__item--past'));
  // The "up next" row is never simultaneously marked past.
  assert.ok(review.classList.contains('cal-agenda__item--next'));
});

test('buildAgendaMarkup never tags all-day rows past or gives them an end marker', () => {
  const root = domFragment(agenda.buildAgendaMarkup({
    weekStart: new Date(2026, 5, 8),
    instances: [instance({ title: 'Holiday', allDay: true, start: '2026-06-11T00:00', end: '2026-06-12T00:00' })],
    now: NOW,
    actionButton: inventoryActionButton,
  }));
  const item = root.querySelector('.cal-agenda__item');
  assert.equal(item.dataset.calEnd, undefined);
  assert.ok(!item.classList.contains('cal-agenda__item--past'));
});

// ---- formatRelative + buildQuickAddMarkup ----

test('formatRelative renders minute, hour, and in-progress forms', () => {
  assert.equal(agenda.formatRelative(NOW, new Date(2026, 5, 11, 10, 30)), 'now');
  assert.equal(agenda.formatRelative(NOW, new Date(2026, 5, 11, 11, 5)), 'in 35m');
  assert.equal(agenda.formatRelative(NOW, new Date(2026, 5, 11, 13, 0)), 'in 2h 30m');
  assert.equal(agenda.formatRelative(NOW, new Date(2026, 5, 11, 12, 30)), 'in 2h');
});

test('buildQuickAddMarkup renders the bar and a conflict chip when pending', () => {
  const collapsed = domFragment(agenda.buildQuickAddMarkup({
    value: 'standup', deps: { textField: inventoryTextField, actionButton: inventoryActionButton },
  }));
  assert.ok(collapsed.querySelector('[data-cal-quickadd-expand]'));
  assert.equal(collapsed.querySelector('[data-cal-quickadd-input]'), null);

  const plain = domFragment(agenda.buildQuickAddMarkup({
    expanded: true, value: 'standup', deps: { textField: inventoryTextField, actionButton: inventoryActionButton },
  }));
  assert.ok(plain.querySelector('[data-cal-quickadd-input]'));
  assert.ok(plain.querySelector('[data-cal-quickadd-add]'));
  assert.equal(plain.querySelector('.cal-quickadd__suggest'), null);

  const pending = domFragment(agenda.buildQuickAddMarkup({
    expanded: true,
    value: 'review 9am',
    now: NOW,
    pending: {
      parsed: { ok: true, title: 'Review', date: '2026-06-11', start: '09:00', end: '10:00', allDay: false },
      conflicts: [{ title: 'Standup', timeLabel: '9 AM' }],
    },
    deps: { textField: inventoryTextField, actionButton: inventoryActionButton },
  }));
  assert.ok(pending.querySelector('[data-cal-quickadd-confirm]'));
  assert.match(pending.querySelector('.cal-quickadd__conflict').textContent, /Overlaps Standup/);
});

// ---- reminders folded into the agenda ----

function reminder(overrides = {}) {
  return {
    id: 'r1',
    label: 'Stretch',
    prompt: 'Stand up.',
    scheduleType: 'daily_at',
    dailyAt: '11:00',
    intervalMinutes: 0,
    onceAt: '',
    sourceKind: '',
    sourceId: '',
    enabled: true,
    ...overrides,
  };
}

function renderWeek(instances, reminders) {
  return domFragment(agenda.buildAgendaMarkup({
    weekStart: new Date(2026, 5, 7), // Sunday-anchored week of Jun 7
    instances,
    reminders,
    now: NOW,
    actionButton: inventoryActionButton,
  }));
}

function todayRowTitles(root) {
  const group = root.querySelector('[data-cal-agenda-day="2026-06-11"]');
  // The trailing open-slot row is chrome, not content — every day carries one.
  return [...group.querySelectorAll('.cal-agenda__item:not(.cal-agenda__item--open)')]
    .map((el) => el.querySelector('.cal-agenda__title').textContent);
}

test('reminders interleave with events in clock order, not in a separate block', () => {
  const root = renderWeek(
    [
      instance({ instanceId: 'a', title: 'Standup', start: '2026-06-11T09:00', end: '2026-06-11T09:30' }),
      instance({ instanceId: 'b', title: 'Review', start: '2026-06-11T14:00', end: '2026-06-11T15:00' }),
    ],
    [
      reminder({ id: 'morning', label: 'Stretch', dailyAt: '11:00' }),
      reminder({ id: 'evening', label: 'Log the day', dailyAt: '17:30' }),
    ]
  );
  assert.deepEqual(todayRowTitles(root), ['Standup', 'Stretch', 'Review', 'Log the day']);
});

test('a daily_at reminder appears on all seven days; once_at appears exactly once', () => {
  const root = renderWeek([], [
    reminder({ id: 'daily', label: 'Stretch', dailyAt: '11:00' }),
    reminder({ id: 'once', label: 'Call the dentist', scheduleType: 'once_at', dailyAt: '', onceAt: '2026-06-10T15:00' }),
  ]);
  assert.equal(root.querySelectorAll('[data-cal-reminder-id="daily"]').length, 7);
  const once = root.querySelectorAll('[data-cal-reminder-id="once"]');
  assert.equal(once.length, 1);
  assert.equal(
    once[0].closest('[data-cal-agenda-day]').getAttribute('data-cal-agenda-day'),
    '2026-06-10'
  );
});

test('an interval_minutes reminder is footer-only and never a timeline row', () => {
  const root = renderWeek([], [
    reminder({ id: 'legacy', label: 'Posture check', scheduleType: 'interval_minutes', dailyAt: '', intervalMinutes: 45 }),
  ]);
  assert.equal(root.querySelectorAll('.cal-agenda__item--reminder').length, 0);
  const standing = root.querySelector('.cal-agenda__standing');
  assert.ok(standing, 'standing footer present');
  assert.match(standing.textContent, /Posture check/);
  assert.match(standing.textContent, /every 45 min/);
  assert.equal(standing.querySelector('[data-cal-reminder-dismiss]').dataset.calReminderDismiss, 'legacy');
});

test('disabled reminders are excluded from both the timeline and the footer', () => {
  const root = renderWeek([instance()], [
    reminder({ id: 'off', label: 'Hidden', enabled: false }),
    reminder({ id: 'offInterval', label: 'Hidden interval', scheduleType: 'interval_minutes', dailyAt: '', intervalMinutes: 30, enabled: false }),
  ]);
  assert.equal(root.querySelectorAll('.cal-agenda__item--reminder').length, 0);
  assert.equal(root.querySelector('.cal-agenda__standing'), null);
  assert.doesNotMatch(root.textContent, /Hidden/);
});

test('a reminder row carries no duration and is never marked up next', () => {
  // The only today row is a reminder placed BEFORE the next event, so if
  // "up next" could ever attach to a reminder, it would attach here.
  const root = renderWeek(
    [instance({ instanceId: 'later', title: 'Review', start: '2026-06-11T14:00', end: '2026-06-11T15:00' })],
    [reminder({ id: 'r1', label: 'Stretch', dailyAt: '11:00' })]
  );
  const row = root.querySelector('[data-cal-reminder-id="r1"]');
  assert.ok(row.classList.contains('cal-agenda__item--reminder'));
  assert.equal(row.querySelector('.cal-agenda__duration'), null);
  assert.equal(row.dataset.calEnd, undefined);
  assert.equal(row.classList.contains('cal-agenda__item--next'), false);
  assert.equal(row.querySelector('[data-cal-rel]'), null);
  // The event after it still takes the marker.
  const next = root.querySelector('.cal-agenda__item--next');
  assert.match(next.textContent, /Review/);
});

test('a reminder row exposes Done and promote-to-open-loop affordances', () => {
  const root = renderWeek([], [reminder({ id: 'r1', label: 'Stretch', sourceKind: 'assistant', sourceId: 'msg-9' })]);
  const row = root.querySelector('[data-cal-reminder-id="r1"]');
  const done = row.querySelector('[data-cal-reminder-dismiss]');
  assert.ok(done, 'Done affordance present');
  assert.equal(done.dataset.calReminderDismiss, 'r1');
  assert.equal(done.tagName, 'BUTTON');
  assert.equal(done.title, 'Mark reminder done: Stretch');
  const promote = row.querySelector('[data-companion-action-id]');
  assert.ok(promote, 'promote affordance present');
  assert.equal(promote.title, 'Promote reminder to an open loop: Stretch');
  // Preserves the companion router's existing action-id shape.
  assert.equal(promote.dataset.companionActionId, 'promote_reminder:r1');
  // Attribution the undo/attribution wave hangs its chip off.
  assert.equal(row.dataset.calSourceKind, 'assistant');
  // A reminder row is NOT an event button: it must not open the event form.
  assert.equal(row.getAttribute('data-cal-instance'), null);
  assert.equal(row.tagName, 'DIV');
});

test('day counts separate events from reminders', () => {
  const root = renderWeek(
    [instance({ instanceId: 'a', title: 'Standup', start: '2026-06-11T09:00', end: '2026-06-11T09:30' })],
    [reminder({ id: 'r1', dailyAt: '11:00' })]
  );
  const count = root.querySelector('[data-cal-agenda-day="2026-06-11"] .cal-agenda__day-count');
  assert.equal(count.textContent, '1 event · 1 reminder');
});

test('a week with only reminders still renders day groups, not the empty state', () => {
  const root = renderWeek([], [reminder({ id: 'r1', dailyAt: '11:00' })]);
  assert.equal(root.querySelector('.cal-agenda__empty'), null);
  assert.equal(root.querySelectorAll('.cal-agenda__group').length, 7);
});
