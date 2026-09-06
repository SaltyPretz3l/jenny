const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const gridModule = require('../renderer/features/renderer-dashboard-calendar-grid.js');
const formModule = require('../renderer/features/renderer-dashboard-calendar-form.js');
const agendaModule = require('../renderer/features/renderer-dashboard-calendar-agenda.js');
const toolbarModule = require('../renderer/features/renderer-dashboard-calendar-toolbar.js');
const monthModule = require('../renderer/features/renderer-dashboard-calendar-month.js');
const runtimeModule = require('../renderer/features/renderer-dashboard-calendar-runtime.js');
const railModule = require('../renderer/features/renderer-dashboard-calendar-rail.js');
const { createCalendarWidget } = require('../renderer/features/renderer-dashboard-calendar.js');
const actionButton = require('../renderer/inventory/action-button.js');
const textField = require('../renderer/inventory/text-field.js');
const timeField = require('../renderer/inventory/time-field.js');
const dateField = require('../renderer/inventory/date-field.js');
const selectField = require('../renderer/inventory/select-field.js');
const toggleSwitch = require('../renderer/inventory/toggle-switch.js');
const urlField = require('../renderer/inventory/url-field.js');
const statusRow = require('../renderer/inventory/status-row.js');
const chip = require('../renderer/inventory/chip.js');
const popover = require('../renderer/inventory/popover.js');

const NOW = new Date(2026, 5, 11, 10, 30);

function calendarState(overrides = {}) {
  return {
    calendar: {
      generatedAt: '2026-06-11T10:00:00.000Z',
      windowStart: '2026-06-04T00:00',
      windowEnd: '2026-08-11T00:00',
      categories: [{ id: 'default', label: 'Default' }],
      instances: [], events: [], feeds: [],
      ...overrides,
    },
    homeConfig: { calendar: { viewMode: 'agenda', feeds: [] } },
  };
}

function harness({ state = calendarState(), shell = { calendar: {} } } = {}) {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  const widget = createCalendarWidget({
    shell,
    actionButton, statusRow, gridModule, formModule, agendaModule, toolbarModule,
    monthModule, runtimeModule, railModule, chip, popover, toggleSwitch,
    formPrimitives: { actionButton, textField, timeField, dateField, selectField, toggleSwitch, urlField },
    nowProvider: () => NOW,
  });
  const ctx = { state, documentRef: dom.window.document };
  widget.render(body, ctx);
  const click = (element) => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return { dom, body, widget, ctx, click };
}

test('rapid duplicate save activation issues only one create request', () => {
  let createCalls = 0;
  const shell = {
    calendar: {
      createEvent() {
        createCalls += 1;
        return new Promise(() => {});
      },
    },
  };
  const { body, click } = harness({ shell });
  click(body.querySelector('[data-cal-new-event]'));
  const save = body.querySelector('[data-cal-form-action="save"]');

  click(save);
  click(save);

  assert.equal(createCalls, 1);
});

test('rapid feed removals fold onto the latest pending feed list', () => {
  const patches = [];
  const state = calendarState({
    feeds: [
      { id: 'alpha', name: 'Alpha', ok: true },
      { id: 'beta', name: 'Beta', ok: true },
    ],
  });
  state.homeConfig.calendar.feeds = [
    { id: 'alpha', name: 'Alpha', url: 'https://example.test/a.ics', colorId: 'default' },
    { id: 'beta', name: 'Beta', url: 'https://example.test/b.ics', colorId: 'default' },
  ];
  const shell = {
    calendar: {},
    home: {
      updateConfig(patch) {
        patches.push(patch);
        return new Promise(() => {});
      },
    },
  };
  const { body, click } = harness({ state, shell });
  click(body.querySelector('[data-cal-feeds-toggle]'));

  click(body.querySelector('[data-cal-feed-remove="alpha"]'));
  click(body.querySelector('[data-cal-feed-remove="beta"]'));

  assert.deepEqual(patches.map((patch) => patch.calendar.feeds.map((feed) => feed.id)), [
    ['beta'],
    [],
  ]);
});

test('an event ending at the opening midnight does not overlap the next week', () => {
  const state = calendarState({
    instances: [{
      instanceId: 'boundary', eventId: 'boundary', title: 'Late deploy',
      start: '2026-06-13T23:00', end: '2026-06-14T00:00',
      allDay: false, readonly: false, categoryId: 'default',
    }],
  });
  state.homeConfig.calendar.viewMode = 'week';
  const { body, click } = harness({ state });

  click(body.querySelector('[data-cal-nav="next"]'));

  assert.match(body.querySelector('.cal-week__empty')?.textContent || '', /No events this week/);
  assert.equal(body.querySelector('.cal-week__scroll'), null);
});
