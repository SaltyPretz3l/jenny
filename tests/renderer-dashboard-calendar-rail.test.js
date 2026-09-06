const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const rail = require('../renderer/features/renderer-dashboard-calendar-rail.js');
const grid = require('../renderer/features/renderer-dashboard-calendar-grid.js');
const actionButton = require('../renderer/inventory/action-button.js');

const NOW = new Date(2026, 5, 11, 8, 48);

function instance(overrides = {}) {
  return {
    instanceId: 'a', eventId: 'a', title: 'Standup',
    start: '2026-06-11T09:00', end: '2026-06-11T09:15',
    allDay: false, readonly: false, categoryId: 'work',
    ...overrides,
  };
}

function fragment(html) {
  return JSDOM.fragment(html);
}

test('mini-month renders complete five- and six-week local calendars', () => {
  const june = fragment(rail.buildMiniMonth({
    weekStart: new Date(2026, 5, 8), instances: [], now: NOW,
    actionButton, gridModule: grid,
  }));
  assert.equal(june.querySelectorAll('[data-cal-day-cell]').length, 35);
  assert.ok(june.querySelector('[data-cal-day-cell="2026-06-01"]'));
  assert.ok(june.querySelector('[data-cal-day-cell="2026-07-04"]'));
  // Sunday-anchored: the June grid opens on May 31 and closes on Jul 4.
  assert.ok(june.querySelector('[data-cal-day-cell="2026-05-31"]'));
  assert.equal(june.querySelectorAll('.cal-rail-month__number--today').length, 1);

  const august = fragment(rail.buildMiniMonth({
    weekStart: new Date(2026, 7, 10), instances: [], now: NOW,
    actionButton, gridModule: grid,
  }));
  assert.equal(august.querySelectorAll('[data-cal-day-cell]').length, 42);
});

test('mini-month marks selection and resolves category ties by earliest event', () => {
  const events = [
    instance({ instanceId: 'first', categoryId: 'meeting', start: '2026-06-11T08:00', end: '2026-06-11T08:30' }),
    instance({ instanceId: 'second', categoryId: 'work' }),
  ];
  assert.equal(rail.chooseDayCategory(events).instanceId, 'first');
  const root = fragment(rail.buildMiniMonth({
    weekStart: new Date(2026, 5, 8), instances: events, now: NOW,
    selectedDayKey: '2026-06-11', actionButton, gridModule: grid,
  }));
  const day = root.querySelector('[data-cal-day-cell="2026-06-11"]');
  assert.equal(day.getAttribute('aria-pressed'), 'true');
  assert.ok(day.querySelector('.cal-event--meeting'));
});

test('agenda and week rails expose up-next, summaries, feeds, and all-day items', () => {
  const timed = instance();
  const allDay = instance({
    instanceId: 'holiday', eventId: 'holiday', title: 'Holiday', allDay: true,
    start: '2026-06-12T00:00', end: '2026-06-13T00:00', categoryId: 'personal',
  });
  const common = {
    now: NOW, weekStart: new Date(2026, 5, 8), instances: [timed, allDay],
    weekInstances: [timed, allDay], categories: [{ id: 'work', label: 'Work' }, { id: 'personal', label: 'Personal' }],
    configFeeds: [{ id: 'team', name: 'Team' }], feeds: [{ id: 'team', ok: false, warning: 'offline' }],
    actionButton, gridModule: grid,
  };
  const agendaRoot = fragment(rail.buildRailMarkup({ ...common, mode: 'agenda' }));
  assert.match(agendaRoot.querySelector('.cal-rail__up-next-meta').textContent, /in 12m/);
  assert.equal(agendaRoot.querySelector('.cal-rail__up-next-meta [data-cal-rel]').dataset.calStart, timed.start);
  assert.equal(agendaRoot.querySelector('[data-cal-feeds-toggle]').dataset.calFeedId, 'team');
  assert.equal(agendaRoot.querySelector('[data-cal-feeds-toggle]').dataset.calFeedFocus, 'feed-0');
  assert.match(agendaRoot.querySelector('.cal-rail__summary').textContent, /Work/);

  const weekRoot = fragment(rail.buildRailMarkup({ ...common, mode: 'week' }));
  assert.match(weekRoot.querySelector('.cal-rail__booked').textContent, /2 events · 15m booked/);
  assert.match(weekRoot.querySelector('.cal-rail__allday-row').textContent, /Holiday/);
  assert.equal(weekRoot.querySelector('.cal-rail-month'), null);
});

test('rail digest advances when the active up-next event ends', () => {
  const first = instance();
  const second = instance({
    instanceId: 'b', eventId: 'b', title: 'Review',
    start: '2026-06-11T10:00', end: '2026-06-11T10:30',
  });
  const base = {
    mode: 'week',
    weekStart: new Date(2026, 5, 8),
    instances: [first, second],
    weekInstances: [first, second],
    categories: [], configFeeds: [], feeds: [], gridModule: grid,
  };
  const before = rail.computeRailDigest({ ...base, now: new Date(2026, 5, 11, 9, 10) });
  const after = rail.computeRailDigest({ ...base, now: new Date(2026, 5, 11, 9, 16) });
  assert.notDeepEqual(after, before);
});

test('up next includes an ongoing event that crossed midnight into today', () => {
  const now = new Date(2026, 5, 11, 0, 15);
  const overnight = instance({
    instanceId: 'overnight', eventId: 'overnight', title: 'Deploy',
    start: '2026-06-10T23:30', end: '2026-06-11T00:30',
  });

  assert.equal(rail.findUpNext([overnight], now, grid), overnight);
});

test('week offset calculation survives month and DST boundaries', () => {
  assert.equal(grid.computeWeekOffsetForDate(new Date(2026, 1, 23), new Date(2026, 2, 2)), 1);
  assert.equal(grid.computeWeekOffsetForDate(new Date(2026, 2, 2), new Date(2026, 2, 9)), 1);
  assert.equal(grid.computeWeekOffsetForDate(new Date(2026, 10, 2), new Date(2026, 10, 9)), 1);
});

test('the mini-month weekday header is Sunday-first', () => {
  const root = fragment(rail.buildMiniMonth({
    weekStart: new Date(2026, 5, 8), instances: [], now: NOW,
    actionButton, gridModule: grid,
  }));
  const letters = [...root.querySelectorAll('.cal-rail-month__weekdays span')].map((el) => el.textContent);
  assert.deepEqual(letters, ['S', 'M', 'T', 'W', 'T', 'F', 'S']);
});

// ---- Daybook week strip (inside the agenda card) ----

test('the week strip renders seven Sunday-anchored cells with today marked', () => {
  const weekStart = grid.computeWeekStart(NOW, 0);
  const root = fragment(rail.buildWeekStripMarkup({
    weekStart,
    weekInstances: [instance()],
    now: NOW,
    actionButton,
    gridModule: grid,
  }));
  const cells = [...root.querySelectorAll('[data-cal-day-cell]')];
  assert.equal(cells.length, 7);
  // Sunday-anchored: 2026-06-11 is a Thursday, so the strip opens on Jun 7.
  assert.equal(cells[0].dataset.calDayCell, '2026-06-07');
  assert.equal(cells[6].dataset.calDayCell, '2026-06-13');
  assert.deepEqual(
    cells.map((el) => el.querySelector('.cal-week-strip__letter').textContent),
    ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  );
  assert.deepEqual(cells.map((el) => el.querySelector('.cal-week-strip__num').textContent),
    ['7', '8', '9', '10', '11', '12', '13']);
  const today = root.querySelectorAll('.cal-week-strip__day--today');
  assert.equal(today.length, 1);
  assert.equal(today[0].dataset.calDayCell, '2026-06-11');
  assert.match(today[0].getAttribute('aria-label'), /^Today, /);
});

test('the week strip caps category dots at three and marks the selected day', () => {
  const day = '2026-06-09';
  const busy = ['work', 'personal', 'meeting', 'errand'].map((categoryId, index) => instance({
    instanceId: `busy-${index}`,
    categoryId,
    start: `${day}T${String(8 + index).padStart(2, '0')}:00`,
    end: `${day}T${String(9 + index).padStart(2, '0')}:00`,
  }));
  const root = fragment(rail.buildWeekStripMarkup({
    weekStart: grid.computeWeekStart(NOW, 0),
    weekInstances: busy,
    now: NOW,
    selectedDayKey: day,
    actionButton,
    gridModule: grid,
  }));
  const cell = root.querySelector(`[data-cal-day-cell="${day}"]`);
  assert.equal(cell.querySelectorAll('.cal-week-strip__dot').length, 3);
  assert.ok(cell.querySelector('.cal-event--work'));
  assert.equal(cell.getAttribute('aria-pressed'), 'true');
  assert.ok(cell.classList.contains('cal-week-strip__day--selected'));
  assert.match(cell.getAttribute('aria-label'), /4 events/);
  // A free day still renders a cell, just with no dots.
  const free = root.querySelector('[data-cal-day-cell="2026-06-10"]');
  assert.equal(free.querySelectorAll('.cal-week-strip__dot').length, 0);
  assert.match(free.getAttribute('aria-label'), /0 events/);
});

test('the week strip digest moves when a day gains an event or the selection changes', () => {
  const base = {
    weekStart: grid.computeWeekStart(NOW, 0), now: NOW, gridModule: grid, weekInstances: [instance()],
  };
  const before = rail.computeWeekStripDigest(base);
  assert.notDeepEqual(
    rail.computeWeekStripDigest({ ...base, weekInstances: [instance(), instance({ instanceId: 'b', start: '2026-06-09T09:00', end: '2026-06-09T10:00' })] }),
    before
  );
  assert.notDeepEqual(rail.computeWeekStripDigest({ ...base, selectedDayKey: '2026-06-09' }), before);
  assert.deepEqual(rail.computeWeekStripDigest(base), before);
});
