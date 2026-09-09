const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const gridModule = require('../renderer/features/renderer-dashboard-calendar-grid.js');
const agendaModule = require('../renderer/features/renderer-dashboard-calendar-agenda.js');
const toolbarModule = require('../renderer/features/renderer-dashboard-calendar-toolbar.js');
const monthModule = require('../renderer/features/renderer-dashboard-calendar-month.js');
const runtimeModule = require('../renderer/features/renderer-dashboard-calendar-runtime.js');
const railModule = require('../renderer/features/renderer-dashboard-calendar-rail.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryChip = require('../renderer/inventory/chip.js');
const inventoryPopover = require('../renderer/inventory/popover.js');
const { createCalendarWidget } = require('../renderer/features/renderer-dashboard-calendar.js');

const NOW = new Date(2026, 5, 11, 10, 30);

function makeState(viewMode, homeCalendarFocusDay = '') {
  return {
    ui: { homeCalendarFocusDay },
    homeConfig: { calendar: { viewMode } },
    calendar: {
      windowStart: '2026-05-01T00:00',
      windowEnd: '2026-08-01T00:00',
      categories: [],
      instances: [],
      events: [],
      feeds: [],
    },
  };
}

function createHarness({ viewMode = 'agenda', homeCalendarFocusDay = '' } = {}) {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  inventoryPopover.initPopoverHandlers(dom.window.document);
  const state = makeState(viewMode, homeCalendarFocusDay);
  const widget = createCalendarWidget({
    shell: { calendar: {} },
    actionButton: inventoryActionButton,
    gridModule,
    agendaModule,
    toolbarModule,
    monthModule,
    runtimeModule,
    railModule,
    chip: inventoryChip,
    popover: inventoryPopover,
    nowProvider: () => NOW,
  });
  const ctx = { state, documentRef: dom.window.document };
  return { dom, body, widget, ctx, state };
}

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

test('agenda consumes a next-week focus intent once and keeps the selection', async () => {
  const key = '2026-06-18';
  const { dom, body, widget, ctx, state } = createHarness({ homeCalendarFocusDay: key });

  widget.render(body, ctx);

  const focusedCell = body.querySelector(`[data-cal-day-cell="${key}"]`);
  const selectedCell = body.querySelector(`.cal-week-strip__day[data-cal-day-cell="${key}"]`);
  const selectedAgendaDay = body.querySelector(`[data-cal-agenda-day="${key}"] .cal-agenda__day--selected`);
  assert.ok(selectedCell.classList.contains('cal-week-strip__day--selected'));
  assert.ok(selectedAgendaDay);
  assert.equal(body.querySelector('.cal-week-strip__day').dataset.calDayCell, '2026-06-14');
  assert.equal(state.ui.homeCalendarFocusDay, '');

  await flush();
  assert.equal(dom.window.document.activeElement, focusedCell);
  assert.equal(body.querySelector('[data-cal-announce]').textContent, 'Week of Jun 14 – 20');

  widget.render(body, ctx);
  assert.ok(body.querySelector(`.cal-week-strip__day[data-cal-day-cell="${key}"]`)
    .classList.contains('cal-week-strip__day--selected'));
  assert.equal(body.querySelector('.cal-week-strip__day').dataset.calDayCell, '2026-06-14');
});

test('a malformed focus intent is cleared without changing the rendered state', () => {
  const { body, widget, ctx, state } = createHarness();
  widget.render(body, ctx);
  const firstCell = body.querySelector('[data-cal-day-cell]');
  const renderKey = body.dataset.calRenderKey;

  state.ui.homeCalendarFocusDay = 'nope';
  widget.render(body, ctx);

  assert.equal(state.ui.homeCalendarFocusDay, '');
  assert.equal(body.dataset.calRenderKey, renderKey);
  assert.equal(body.querySelector('[data-cal-day-cell]'), firstCell);
  assert.equal(body.querySelector('.cal-week-strip__day--selected'), null);
});

test('an impossible calendar date is cleared without re-anchoring the week', () => {
  const { body, widget, ctx, state } = createHarness();
  widget.render(body, ctx);
  const firstCell = body.querySelector('[data-cal-day-cell]');
  const renderKey = body.dataset.calRenderKey;

  // Matches the key shape but rolls over when parsed; must not select March 2.
  state.ui.homeCalendarFocusDay = '2026-02-30';
  widget.render(body, ctx);

  assert.equal(state.ui.homeCalendarFocusDay, '');
  assert.equal(body.dataset.calRenderKey, renderKey);
  assert.equal(body.querySelector('[data-cal-day-cell]'), firstCell);
  assert.equal(body.querySelector('.cal-week-strip__day--selected'), null);
});

test('month navigation scrolls and focuses a distant empty day once', async () => {
  const { dom, body, widget, ctx, state } = createHarness({
    viewMode: 'month',
  });
  widget.render(body, ctx);
  await flush();
  const calls = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) {
    calls.push({ day: this.dataset.calMonthDay, options });
  };
  const scroller = body.querySelector('[data-cal-scroll]');
  scroller.scrollTop = 100;
  state.ui.homeCalendarFocusDay = '2026-07-18';
  widget.render(body, ctx);
  await flush();
  const target = body.querySelector('[data-cal-month-day="2026-07-18"]');
  assert.equal(state.ui.homeCalendarFocusDay, '');
  assert.equal(dom.window.document.activeElement, target);
  assert.equal(target.getAttribute('tabindex'), '-1');
  assert.deepEqual(calls, [{ day: '2026-07-18', options: {
    block: 'center', inline: 'nearest', behavior: 'instant',
  } }]);
  widget.render(body, ctx);
  await flush();
  assert.equal(calls.length, 1);
  dom.window.close();
});
