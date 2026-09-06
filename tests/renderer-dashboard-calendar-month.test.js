const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const month = require('../renderer/features/renderer-dashboard-calendar-month.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryChip = require('../renderer/inventory/chip.js');
const inventoryPopover = require('../renderer/inventory/popover.js');

// 2026-06-11 is a Thursday (getDay() === 4); its Sunday is 2026-06-07.
// The fixed snapshot window for that "now" is 2026-06-04..2026-08-11.
const NOW = new Date(2026, 5, 11, 10, 30);
const WINDOW_START = '2026-06-04T00:00';
const WINDOW_END = '2026-08-11T00:00';

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

function render(instances, overrides = {}) {
  const span = month.computeMonthSpan(WINDOW_START, WINDOW_END);
  return domFragment(month.buildMonthMarkup({
    gridStart: span.gridStart,
    weekCount: span.weekCount,
    instances,
    now: NOW,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    actionButton: inventoryActionButton,
    chip: inventoryChip,
    popover: inventoryPopover,
    ...overrides,
  }));
}

function cell(root, dayKey) {
  return root.querySelector(`[data-cal-month-day="${dayKey}"]`);
}

function visibleChips(cellEl) {
  const events = cellEl.querySelector('.cal-month__events');
  return Array.from(events.children).filter((el) => el.classList.contains('cal-month__event'));
}

// ---- computeMonthSpan ----

test('computeMonthSpan returns a Sunday gridStart and a weekCount covering the window', () => {
  const { gridStart, weekCount } = month.computeMonthSpan(WINDOW_START, WINDOW_END);
  assert.equal(gridStart.getDay(), 0, 'gridStart is a Sunday');
  assert.equal(`${gridStart.getFullYear()}-${String(gridStart.getMonth() + 1).padStart(2, '0')}-${String(gridStart.getDate()).padStart(2, '0')}`, '2026-05-31');
  // Sundays May 31 .. Aug 9 inclusive = 11 rows; the row holding Aug 11 is last.
  assert.equal(weekCount, 11);
});

test('computeMonthSpan falls back to a window around today when bounds are missing', () => {
  const { gridStart, weekCount } = month.computeMonthSpan(undefined, undefined);
  assert.equal(gridStart.getDay(), 0);
  assert.ok(weekCount >= 9 && weekCount <= 12, `weekCount ${weekCount} in expected range`);
});

// ---- grid shape ----

test('the weekday header is Sunday-first and marks columns 0 and 6 as the weekend', () => {
  const root = render([]);
  const heads = [...root.querySelectorAll('.cal-month__weekday')];
  assert.deepEqual(heads.map((el) => el.textContent), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  const weekendColumns = heads
    .map((el, index) => (el.classList.contains('cal-month__weekday--weekend') ? index : null))
    .filter((index) => index !== null);
  assert.deepEqual(weekendColumns, [0, 6]);
  // Cells agree with the header: every row's first and last cell is a weekend.
  const firstRow = root.querySelector('[data-cal-month-week]');
  const cells = [...firstRow.querySelectorAll('[data-cal-month-day]')];
  assert.ok(cells[0].classList.contains('cal-month__cell--weekend'));
  assert.ok(cells[6].classList.contains('cal-month__cell--weekend'));
  assert.equal(cells[3].classList.contains('cal-month__cell--weekend'), false);
});

test('the month grid consumes grid.js computeWeekStart rather than a private copy', () => {
  // Regression for the DUPLICATED week-start decision: month.js used to keep
  // its own Monday-anchored copy, so a change to one anchor silently skewed the
  // other. Dates spanning a month boundary are where the two used to diverge.
  const grid = require('../renderer/features/renderer-dashboard-calendar-grid.js');
  const probes = [
    new Date(2026, 5, 11), new Date(2026, 5, 1), new Date(2026, 4, 31),
    new Date(2026, 6, 1), new Date(2026, 1, 28), new Date(2026, 2, 1),
    new Date(2025, 11, 31), new Date(2026, 0, 1),
  ];
  for (const probe of probes) {
    const { gridStart } = month.computeMonthSpan(
      `${probe.getFullYear()}-${String(probe.getMonth() + 1).padStart(2, '0')}-${String(probe.getDate()).padStart(2, '0')}T00:00`,
      undefined
    );
    const expected = grid.computeWeekStart(probe, 0);
    assert.equal(gridStart.getTime(), expected.getTime(), `week start disagrees for ${probe.toDateString()}`);
    assert.equal(gridStart.getDay(), 0, 'both anchors are Sunday');
  }
});

test('buildMonthMarkup renders weekCount rows of exactly 7 day cells each', () => {
  const root = render([instance()]);
  const rows = root.querySelectorAll('[data-cal-month-week]');
  assert.equal(rows.length, 11);
  for (const row of rows) {
    assert.equal(row.querySelectorAll('[data-cal-month-day]').length, 7);
  }
  assert.equal(root.querySelectorAll('.cal-month__weekday').length, 7);
  assert.ok(root.querySelector('[data-cal-scroll="1"]'), 'scroll container carries data-cal-scroll');
});

test('empty days still render as cells (every day is present, events or not)', () => {
  const root = render([]); // no events at all
  assert.equal(root.querySelectorAll('[data-cal-month-day]').length, 11 * 7);
  // a known event-free day is a real, clickable cell
  const empty = cell(root, '2026-06-17');
  assert.ok(empty, 'empty day cell exists');
  assert.equal(visibleChips(empty).length, 0);
});

test('today is flagged on both its week row and its day cell', () => {
  const root = render([instance()]);
  const todayRows = root.querySelectorAll('[data-cal-month-today]');
  assert.equal(todayRows.length, 1);
  assert.equal(todayRows[0].getAttribute('data-cal-month-week'), '2026-06-07');
  assert.equal(cell(root, '2026-06-11').getAttribute('data-today'), 'true');
  assert.equal(cell(root, '2026-06-10').hasAttribute('data-today'), false);
});

// ---- event chips ----

test('a timed local event renders a chip with the shared instance dataset + hue class', () => {
  const root = render([instance()]);
  const chip = cell(root, '2026-06-11').querySelector('.cal-month__event');
  assert.ok(chip);
  assert.equal(chip.getAttribute('data-cal-instance'), '1');
  assert.equal(chip.getAttribute('data-cal-instance-id'), 'evt:2026-06-11T09:00');
  assert.equal(chip.getAttribute('data-cal-event-id'), 'evt');
  assert.ok(chip.classList.contains('cal-event--work'));
  assert.equal(chip.hasAttribute('data-cal-readonly'), false);
});

test('a readonly feed event is marked readonly and omits the event id', () => {
  const root = render([instance({
    instanceId: 'feed:cal:1:2026-06-12T14:00',
    eventId: '',
    readonly: true,
    source: 'feed',
    title: 'Webinar',
    start: '2026-06-12T14:00',
    end: '2026-06-12T15:00',
    categoryId: 'personal',
  })]);
  const chip = cell(root, '2026-06-12').querySelector('.cal-month__event');
  assert.equal(chip.getAttribute('data-cal-readonly'), '1');
  assert.equal(chip.hasAttribute('data-cal-event-id'), false);
  assert.equal(chip.getAttribute('data-cal-instance-id'), 'feed:cal:1:2026-06-12T14:00');
});

test('a multi-day all-day event shows on each covered day but not the exclusive end', () => {
  const root = render([instance({
    instanceId: 'trip',
    eventId: 'trip',
    title: 'Conference',
    allDay: true,
    start: '2026-06-10T00:00',
    end: '2026-06-12T00:00', // half-open: covers Jun 10 + 11, NOT Jun 12
    categoryId: 'personal',
  })]);
  assert.ok(cell(root, '2026-06-10').querySelector('[data-cal-instance-id="trip"]'));
  assert.ok(cell(root, '2026-06-11').querySelector('[data-cal-instance-id="trip"]'));
  assert.equal(cell(root, '2026-06-12').querySelector('[data-cal-instance-id="trip"]'), null);
});

test('a day past the chip cap collapses extras into a "+N more" chip and a hidden popover', () => {
  const day = '2026-06-15';
  const many = [8, 9, 10, 11].map((hour, i) => instance({
    instanceId: `m${i}`,
    eventId: `m${i}`,
    title: `Mtg ${i}`,
    start: `${day}T${String(hour).padStart(2, '0')}:00`,
    end: `${day}T${String(hour + 1).padStart(2, '0')}:00`,
  }));
  const root = render(many);
  const target = cell(root, day);
  assert.equal(visibleChips(target).length, 3, 'caps visible chips at 3');
  const more = target.querySelector('.cal-month__more');
  assert.ok(more, '+N more chip present');
  assert.match(more.textContent, /\+1 more/);
  assert.equal(more.getAttribute('aria-controls'), `calMonthPop-${day}`);
  assert.equal(more.getAttribute('title'), more.getAttribute('aria-label'));
  const pop = target.querySelector(`#calMonthPop-${day}`);
  assert.ok(pop, 'popover present');
  assert.ok(pop.hasAttribute('hidden'), 'popover hidden by default');
  assert.ok(pop.classList.contains('inv-popover'));
  // popover lists the full day so the overflow item is reachable
  assert.ok(pop.querySelector('[data-cal-instance-id="m3"]'));
});

test('days strictly before today carry the past modifier', () => {
  const root = render([instance()]);
  assert.ok(cell(root, '2026-06-09').classList.contains('cal-month__cell--past'));
  assert.equal(cell(root, '2026-06-11').classList.contains('cal-month__cell--past'), false);
  assert.equal(cell(root, '2026-06-20').classList.contains('cal-month__cell--past'), false);
});

test('days outside the snapshot window are dimmed', () => {
  const root = render([instance()]);
  // gridStart is 2026-05-31 but the window starts 2026-06-04, so May 31-Jun 3 are outside
  assert.ok(cell(root, '2026-05-31').classList.contains('cal-month__cell--outside'));
  assert.ok(cell(root, '2026-06-01').classList.contains('cal-month__cell--outside'));
  assert.equal(cell(root, '2026-06-04').classList.contains('cal-month__cell--outside'), false);
});

test('within a cell, all-day events sort before timed events', () => {
  const day = '2026-06-18';
  const root = render([
    instance({ instanceId: 'timed', eventId: 'timed', title: 'Sync', start: `${day}T09:00`, end: `${day}T10:00` }),
    instance({ instanceId: 'allday', eventId: 'allday', title: 'Holiday', allDay: true, start: `${day}T00:00`, end: '2026-06-19T00:00' }),
  ]);
  const chips = visibleChips(cell(root, day));
  assert.equal(chips[0].getAttribute('data-cal-instance-id'), 'allday');
  assert.equal(chips[1].getAttribute('data-cal-instance-id'), 'timed');
});

// ---- imperative helpers (layout-free parts) ----

test('slotFromDay returns a 09:00 local date and rejects malformed/rolled days', () => {
  const slot = month.slotFromDay('2026-06-20');
  assert.equal(slot.getFullYear(), 2026);
  assert.equal(slot.getMonth(), 5);
  assert.equal(slot.getDate(), 20);
  assert.equal(slot.getHours(), 9);
  assert.equal(slot.getMinutes(), 0);
  assert.equal(month.slotFromDay('garbage'), null);
  assert.equal(month.slotFromDay('2026-02-30'), null, 'rejects a rolled date');
  assert.equal(month.slotFromDay(''), null);
});

test('formatRangeLabel renders a month + year label', () => {
  const label = month.formatRangeLabel(new Date(2026, 5, 11));
  assert.match(label, /2026/);
  assert.match(label, /Jun/i);
});

test('defaultScrollTop is 0 when there is no layout (jsdom) or no today row', () => {
  // jsdom reports offsetTop/offsetHeight as 0; the anchor degrades to the top.
  const root = render([instance()]);
  const scrollEl = root.querySelector('[data-cal-scroll]');
  assert.equal(month.defaultScrollTop(scrollEl), 0);
  assert.equal(month.defaultScrollTop(null), 0);
});

// ---- UIUX-030: navScroll must honor prefers-reduced-motion ----

function withOsReducedMotion(matches, fn) {
  const previous = global.matchMedia;
  global.matchMedia = () => ({ matches });
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete global.matchMedia;
    } else {
      global.matchMedia = previous;
    }
  }
}

test('navScroll("today") uses smooth when the OS does not prefer reduced motion', () => {
  withOsReducedMotion(false, () => {
    const root = render([instance()]);
    const scrollEl = root.querySelector('[data-cal-scroll]');
    let captured = null;
    scrollEl.scrollTo = (opts) => { captured = opts; };
    month.navScroll(scrollEl, 'today');
    assert.ok(captured, 'expected scrollTo to be called');
    assert.equal(captured.behavior, 'smooth');
  });
});

test('navScroll("today") falls back to instant (auto) scrolling under OS prefers-reduced-motion', () => {
  withOsReducedMotion(true, () => {
    const root = render([instance()]);
    const scrollEl = root.querySelector('[data-cal-scroll]');
    let captured = null;
    scrollEl.scrollTo = (opts) => { captured = opts; };
    month.navScroll(scrollEl, 'today');
    assert.ok(captured, 'expected scrollTo to be called');
    assert.equal(captured.behavior, 'auto', 'reduced motion must degrade the jump-to-today scroll to instant');
  });
});

test('navScroll("next"/"prev") week-paging also degrades to instant under OS prefers-reduced-motion', () => {
  withOsReducedMotion(true, () => {
    const root = render([instance()]);
    const scrollEl = root.querySelector('[data-cal-scroll]');
    let captured = null;
    scrollEl.scrollBy = (opts) => { captured = opts; };
    month.navScroll(scrollEl, 'next');
    assert.ok(captured, 'expected scrollBy to be called');
    assert.equal(captured.behavior, 'auto');
  });
});
