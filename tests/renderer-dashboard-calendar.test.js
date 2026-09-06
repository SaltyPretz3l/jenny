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
const inventoryChip = require('../renderer/inventory/chip.js');
const inventoryPopover = require('../renderer/inventory/popover.js');
const { createCalendarWidget } = require('../renderer/features/renderer-dashboard-calendar.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');
const inventoryTimeField = require('../renderer/inventory/time-field.js');
const inventoryDateField = require('../renderer/inventory/date-field.js');
const inventorySelectField = require('../renderer/inventory/select-field.js');
const inventoryToggleSwitch = require('../renderer/inventory/toggle-switch.js');
const inventoryUrlField = require('../renderer/inventory/url-field.js');
const inventoryStatusRow = require('../renderer/inventory/status-row.js');

// 2026-06-11 is a Thursday; its Sunday-anchored week starts 2026-06-07.
const NOW = new Date(2026, 5, 11, 10, 30);

const CATEGORIES = [
  { id: 'default', label: 'Default' },
  { id: 'work', label: 'Work' },
  { id: 'meeting', label: 'Meeting' },
];

function makeInstance(overrides = {}) {
  return {
    instanceId: 'evt_a:2026-06-11T09:00',
    eventId: 'evt_a',
    source: 'local',
    feedId: null,
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

function makeState(overrides = {}) {
  return {
    calendar: {
      generatedAt: '2026-06-11T10:00:00.000Z',
      windowStart: '2026-06-04T00:00',
      windowEnd: '2026-08-11T00:00',
      categories: CATEGORIES,
      instances: [makeInstance()],
      events: [{
        id: 'evt_a',
        title: 'Standup',
        start: '2026-06-11T09:00',
        end: '2026-06-11T09:30',
        allDay: false,
        categoryId: 'work',
        notes: 'bring updates',
        recurrence: 'weekly',
        createdAt: '',
        updatedAt: '',
      }],
      feeds: [],
      ...overrides,
    },
  };
}

function createHarness({ state = makeState(), shell, viewMode } = {}) {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  // Mirror inventory/index.js: the popover Escape/click-away close handlers are
  // installed once on the document (the "+N more" month popover relies on them).
  inventoryPopover.initPopoverHandlers(dom.window.document);
  if (viewMode) {
    state.homeConfig = state.homeConfig || {};
    state.homeConfig.calendar = { ...(state.homeConfig.calendar || {}), viewMode };
  }
  const applied = [];
  const appliedConfigs = [];
  const widget = createCalendarWidget({
    shell: shell || { calendar: {} },
    onSnapshot: (snapshot) => applied.push(snapshot),
    onHomeConfig: (config) => appliedConfigs.push(config),
    actionButton: inventoryActionButton,
    statusRow: inventoryStatusRow,
    gridModule,
    formModule,
    agendaModule,
    toolbarModule,
    monthModule,
    runtimeModule,
    railModule,
    chip: inventoryChip,
    popover: inventoryPopover,
    toggleSwitch: inventoryToggleSwitch,
    formPrimitives: {
      actionButton: inventoryActionButton,
      textField: inventoryTextField,
      timeField: inventoryTimeField,
      dateField: inventoryDateField,
      selectField: inventorySelectField,
      toggleSwitch: inventoryToggleSwitch,
      urlField: inventoryUrlField,
    },
    nowProvider: () => NOW,
    appendClientLog: () => {},
  });
  const ctx = { state, documentRef: dom.window.document };
  return { dom, body, widget, ctx, state, applied, appliedConfigs };
}

function click(dom, element) {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

function keydown(dom, element, key) {
  element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
}

function changeEvent(dom, element) {
  element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

function expandQuickAdd(dom, body) {
  click(dom, body.querySelector('[data-cal-quickadd-expand]'));
  return body.querySelector('[data-cal-quickadd-input]');
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('week grid renders 7 day columns with correct headers and today flag', () => {
  const { body, widget, ctx } = createHarness({ viewMode: 'week' });
  widget.render(body, ctx);

  const days = body.querySelectorAll('.cal-week__day');
  assert.equal(days.length, 7);
  assert.equal(days[0].dataset.calDay, '2026-06-07');
  assert.equal(days[6].dataset.calDay, '2026-06-13');
  assert.equal(body.querySelectorAll('.cal-week__head-cell').length, 7);
  assert.equal(body.querySelector('.cal-week__day[data-today="true"]').dataset.calDay, '2026-06-11');
  assert.match(body.querySelector('.cal-toolbar__range').textContent, /Jun 7 . 13/);
});

test('timed blocks get pixel geometry and overlapping events split lanes', () => {
  const state = makeState({
    instances: [
      makeInstance(),
      makeInstance({
        instanceId: 'evt_b:1', eventId: 'evt_b', title: 'Review',
        start: '2026-06-11T09:15', end: '2026-06-11T10:15',
      }),
    ],
  });
  const { body, widget, ctx } = createHarness({ state, viewMode: 'week' });
  widget.render(body, ctx);

  const slots = body.querySelectorAll('.cal-week__day[data-today="true"] .cal-event-slot');
  assert.equal(slots.length, 2);
  assert.match(slots[0].getAttribute('style'), /top:540px/);
  assert.match(slots[0].getAttribute('style'), /width:50/);
  assert.match(slots[1].getAttribute('style'), /left:50/);
});

test('all-day instances render as chips in the all-day band, not the canvas', () => {
  const state = makeState({
    instances: [makeInstance({
      allDay: true, start: '2026-06-11T00:00', end: '2026-06-12T00:00', title: 'Offsite',
    })],
  });
  const { body, widget, ctx } = createHarness({ state, viewMode: 'week' });
  widget.render(body, ctx);

  assert.equal(body.querySelectorAll('.cal-allday-chip').length, 1);
  assert.equal(body.querySelectorAll('.cal-event-slot').length, 0);
});

test('all-day overflow keeps events beyond the three-chip cap reachable', () => {
  const instances = Array.from({ length: 4 }, (_, index) => makeInstance({
    instanceId: `all-day-${index}`,
    eventId: `all-day-${index}`,
    title: `All day ${index + 1}`,
    allDay: true,
    start: '2026-06-11T00:00',
    end: '2026-06-12T00:00',
  }));
  const { dom, body, widget, ctx } = createHarness({ state: makeState({ instances }), viewMode: 'week' });
  widget.render(body, ctx);

  assert.equal(body.querySelectorAll('.cal-allday-chip').length, 4, 'three visible chips plus one overflow row');
  const more = body.querySelector('.cal-week__allday-more');
  assert.ok(more);
  assert.match(more.getAttribute('aria-label'), /1 more all-day event/);
  assert.equal(more.getAttribute('title'), more.getAttribute('aria-label'));
  const dialog = body.querySelector('#calAllDayPop-2026-06-11');
  assert.equal(dialog.hidden, true);
  click(dom, more);
  assert.equal(dialog.hidden, false);
  assert.match(dialog.textContent, /All day 4/);
  assert.equal(dom.window.document.activeElement.dataset.calEventId, 'all-day-3');
});

test('now-line renders only in the today column at the minute offset', () => {
  const { body, widget, ctx } = createHarness({ viewMode: 'week' });
  widget.render(body, ctx);

  const lines = body.querySelectorAll('.cal-week__now-line');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].parentElement.dataset.calDay, '2026-06-11');
  assert.match(lines[0].getAttribute('style'), /top:630px/); // 10:30
});

test('week navigation shifts the rendered week and Today returns home', () => {
  const { dom, body, widget, ctx } = createHarness({ viewMode: 'week' });
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-nav="next"]'));
  assert.equal(body.querySelector('.cal-week').dataset.weekStart, '2026-06-14');
  click(dom, body.querySelector('[data-cal-nav="today"]'));
  assert.equal(body.querySelector('.cal-week').dataset.weekStart, '2026-06-07');
});

test('New event opens the create form; day-column click prefills the date', () => {
  const { dom, body, widget, ctx } = createHarness({ viewMode: 'week' });
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-new-event]'));
  assert.ok(body.querySelector('[data-cal-form="1"]'));
  assert.equal(body.querySelector('#calFormDate').value, '2026-06-11');

  click(dom, body.querySelector('[data-cal-form-action="cancel"]'));
  assert.equal(body.querySelector('[data-cal-form="1"]'), null);

  click(dom, body.querySelector('.cal-week__day[data-cal-day="2026-06-12"]'));
  assert.equal(body.querySelector('#calFormDate').value, '2026-06-12');
});

test('clicking a local block opens the edit form seeded from the series event', () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-event-id="evt_a"]'));
  const form = body.querySelector('[data-cal-form="1"]');
  assert.ok(form);
  assert.equal(body.querySelector('#calFormTitle').value, 'Standup');
  assert.equal(body.querySelector('#calFormNotes').value, 'bring updates');
  assert.equal(body.querySelector('#calFormRecurrence').value, 'weekly');
  // Opened from an occurrence of a recurring series -> scope-aware note + delete.
  assert.match(form.textContent, /choose a scope/);
  assert.ok(body.querySelector('[data-cal-form-action="delete"]'));
});

test('readonly feed instances render dashed and ignore clicks', () => {
  const state = makeState({
    instances: [makeInstance({
      instanceId: 'feed:team:x:2026-06-11T13:00', eventId: '', source: 'feed',
      feedId: 'team', readonly: true, categoryId: 'meeting',
      start: '2026-06-11T13:00', end: '2026-06-11T14:00', title: 'Feed sync',
    })],
    events: [],
  });
  const { dom, body, widget, ctx } = createHarness({ state, viewMode: 'week' });
  widget.render(body, ctx);

  const block = body.querySelector('[data-cal-readonly="1"]');
  assert.ok(block);
  assert.match(block.className, /cal-event--readonly/);
  assert.match(block.className, /cal-event--meeting/);
  click(dom, block);
  assert.equal(body.querySelector('[data-cal-form="1"]'), null);
});

test('saving the create form calls calendar.createEvent and applies the snapshot', async () => {
  const calls = [];
  const nextSnapshot = makeState().calendar;
  const shell = {
    calendar: {
      createEvent: async (payload) => {
        calls.push(payload);
        return nextSnapshot;
      },
    },
  };
  const { dom, body, widget, ctx, applied } = createHarness({ shell });
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-new-event]'));
  body.querySelector('#calFormTitle').value = 'Dentist';
  body.querySelector('#calFormDate').value = '2026-06-12';
  body.querySelector('#calFormStart').value = '14:00';
  body.querySelector('#calFormEnd').value = '15:00';
  body.querySelector('#calFormCategory').value = 'meeting';
  click(dom, body.querySelector('[data-cal-form-action="save"]'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Dentist');
  assert.equal(calls[0].start, '2026-06-12T14:00');
  assert.equal(calls[0].end, '2026-06-12T15:00');
  assert.equal(calls[0].categoryId, 'meeting');
  assert.equal(applied.length, 1);
  assert.equal(body.querySelector('[data-cal-form="1"]'), null);
});

test('a failed save surfaces the error and keeps the form open', async () => {
  const shell = {
    calendar: {
      createEvent: async () => {
        throw new Error('calendar store is full (500 events)');
      },
    },
  };
  const { dom, body, widget, ctx } = createHarness({ shell });
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-new-event]'));
  click(dom, body.querySelector('[data-cal-form-action="save"]'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(body.querySelector('[data-cal-form="1"]'));
  assert.match(body.querySelector('.cal-form__error').textContent, /store is full/);
});

test('steady-state repaints skip the rebuild and preserve typed input', () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);
  click(dom, body.querySelector('[data-cal-new-event]'));

  const title = body.querySelector('#calFormTitle');
  title.value = 'half-typed thought';
  widget.render(body, ctx); // e.g. the 30s clock tick
  assert.equal(body.querySelector('#calFormTitle').value, 'half-typed thought');
  assert.equal(body.querySelector('#calFormTitle'), title, 'DOM not rebuilt');
});

test('feeds panel lists configured feeds with status and supports add/remove', async () => {
  const updateCalls = [];
  const nextConfig = { links: [], calendar: { feeds: [] } };
  const shell = {
    calendar: {},
    home: {
      updateConfig: async (patch) => {
        updateCalls.push(patch);
        return nextConfig;
      },
    },
  };
  const state = makeState({
    feeds: [{ id: 'team', name: 'Team', colorId: 'meeting', ok: false, warning: 'socket hangup', lastFetchedAt: '', skippedCount: 0 }],
  });
  state.homeConfig = {
    calendar: {
      feeds: [{ id: 'team', name: 'Team', url: 'https://cal.example/team.ics', colorId: 'meeting' }],
    },
  };
  const { dom, body, widget, ctx, appliedConfigs } = createHarness({ state, shell });
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-feeds-toggle]'));
  const panel = body.querySelector('[data-cal-feeds="1"]');
  assert.ok(panel);
  assert.match(panel.textContent, /Team/);
  assert.match(panel.textContent, /socket hangup/);
  assert.equal(body.querySelector('[data-cal-feed-remove="team"]').getAttribute('title'), 'Remove feed Team');

  body.querySelector('#calFeedName').value = 'Personal';
  body.querySelector('#calFeedUrl').value = 'https://cal.example/personal.ics';
  body.querySelector('#calFeedColor').value = 'work';
  click(dom, body.querySelector('[data-cal-feed-add]'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].calendar.feeds.length, 2);
  assert.deepEqual(updateCalls[0].calendar.feeds[1], {
    name: 'Personal', url: 'https://cal.example/personal.ics', colorId: 'work',
  });
  assert.equal(appliedConfigs.length, 1);

  click(dom, body.querySelector('[data-cal-feed-remove="team"]'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updateCalls.length, 2);
  assert.deepEqual(updateCalls[1].calendar.feeds, []);
});

test('feeds panel rejects non-http urls without calling updateConfig', () => {
  const updateCalls = [];
  const shell = {
    calendar: {},
    home: { updateConfig: async (patch) => { updateCalls.push(patch); return {}; } },
  };
  const { dom, body, widget, ctx } = createHarness({ shell });
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-feeds-toggle]'));
  body.querySelector('#calFeedUrl').value = 'ftp://nope';
  click(dom, body.querySelector('[data-cal-feed-add]'));

  assert.equal(updateCalls.length, 0);
  assert.match(body.querySelector('.cal-form__error').textContent, /http\(s\)/);
});

test('opening the feeds panel closes the event form and vice versa', () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-new-event]'));
  assert.ok(body.querySelector('[data-cal-form="1"]'));
  click(dom, body.querySelector('[data-cal-feeds-toggle]'));
  assert.ok(body.querySelector('[data-cal-feeds="1"]'));
  assert.equal(body.querySelector('[data-cal-form="1"]'), null);

  click(dom, body.querySelector('[data-cal-new-event]'));
  assert.ok(body.querySelector('[data-cal-form="1"]'));
  assert.equal(body.querySelector('[data-cal-feeds="1"]'), null);
});

test('feed warnings mark the overflow control and unsupported recurrence gets a marker', () => {
  const state = makeState({
    instances: [makeInstance({ recurring: true, recurrenceUnsupported: true })],
    feeds: [{ id: 'team', name: 'Team', colorId: 'meeting', ok: false, warning: 'socket hangup', lastFetchedAt: '', skippedCount: 0 }],
  });
  const { body, widget, ctx } = createHarness({ state, viewMode: 'week' });
  widget.render(body, ctx);

  const overflow = body.querySelector('[data-cal-overflow-toggle]');
  assert.ok(overflow.classList.contains('cal-toolbar__overflow-trigger--warning'));
  click(body.ownerDocument.defaultView, overflow);
  assert.match(body.querySelector('[data-cal-feeds-toggle]').getAttribute('aria-label'), /1 warning/);
  assert.ok(body.querySelector('.cal-event__marker'));
});

test('the create form rejects an end at/before start without calling createEvent', async () => {
  const calls = [];
  const shell = { calendar: { createEvent: async (p) => { calls.push(p); return makeState().calendar; } } };
  const { dom, body, widget, ctx } = createHarness({ shell });
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-new-event]'));
  body.querySelector('#calFormStart').value = '15:00';
  body.querySelector('#calFormEnd').value = '14:00';
  click(dom, body.querySelector('[data-cal-form-action="save"]'));
  await flush();

  assert.equal(calls.length, 0);
  assert.ok(body.querySelector('[data-cal-form="1"]'));
  assert.match(body.querySelector('.cal-form__error').textContent, /after start time/);
});

test('moving start past end slides the end field forward in place', () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-new-event]'));
  const startEl = body.querySelector('#calFormStart');
  const endEl = body.querySelector('#calFormEnd');
  // Default create slot is 11:00–11:30 (NOW is 10:30); push start past end.
  startEl.value = '13:00';
  changeEvent(dom, startEl);
  assert.equal(endEl.value, '13:30');
  assert.equal(body.querySelector('#calFormStart'), startEl, 'no rebuild on the change');
});

test('a week with no events shows the empty state instead of a bare grid', () => {
  const state = makeState({ instances: [], events: [] });
  const { dom, body, widget, ctx } = createHarness({ state, viewMode: 'week' });
  widget.render(body, ctx);

  const empty = body.querySelector('.cal-week__empty');
  assert.ok(empty);
  assert.match(empty.textContent, /No events this week/);
  assert.equal(body.querySelector('.cal-week__scroll'), null, 'tall canvas is replaced');

  assert.equal(empty.querySelector('[data-cal-new-event]'), null);
  // Header New remains the single creation action.
  click(dom, body.querySelector('[data-cal-new-event]'));
  assert.ok(body.querySelector('[data-cal-form="1"]'));
});

test('week navigation announces the new range to the live region', async () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-nav="next"]'));
  await flush();
  const live = body.querySelector('[data-cal-announce]');
  assert.ok(live);
  assert.match(live.textContent, /Week of/);
});

test('opening the create form moves focus to the title field', async () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-new-event]'));
  await flush();
  assert.equal(dom.window.document.activeElement, body.querySelector('#calFormTitle'));
});

test('the n shortcut opens create and Escape closes it', () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  keydown(dom, body, 'n');
  assert.ok(body.querySelector('[data-cal-form="1"]'));
  keydown(dom, body, 'Escape');
  assert.equal(body.querySelector('[data-cal-form="1"]'), null);
});

test('quick-add expands by click, Escape collapses it, and n still opens the full form', async () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  const input = expandQuickAdd(dom, body);
  assert.ok(input);
  input.value = 'Keep this draft';
  keydown(dom, input, 'Escape');
  await flush();
  assert.equal(body.querySelector('[data-cal-quickadd-input]'), null);
  assert.ok(body.querySelector('[data-cal-quickadd-expand]'));

  keydown(dom, body.querySelector('[data-cal-quickadd-expand]'), 'n');
  await flush();
  assert.ok(body.querySelector('[data-cal-form="1"]'));
});

test('toolbar overflow uses the inventory popover and Escape restores trigger focus', () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);
  const trigger = body.querySelector('[data-cal-overflow-toggle]');
  click(dom, trigger);
  const dialog = body.querySelector('#calToolbarOverflow');
  assert.equal(dialog.hidden, false);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  keydown(dom, dialog.querySelector('[data-cal-feeds-toggle]'), 'Escape');
  assert.equal(dialog.hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.window.document.activeElement, trigger);
});

test('feeds panel focuses its close control and restores the rail opener on Escape', async () => {
  const state = makeState({
    feeds: [{ id: 'team', name: 'Team', ok: true, warning: '' }],
  });
  state.homeConfig = {
    calendar: {
      feeds: [{ id: 'team', name: 'Team', url: 'https://cal.example/team.ics', colorId: 'meeting' }],
    },
  };
  const { dom, body, widget, ctx } = createHarness({ state });
  widget.render(body, ctx);
  const opener = body.querySelector('[data-cal-feed-focus="feed-0"]');
  opener.focus();
  click(dom, opener);
  await new Promise((resolve) => queueMicrotask(resolve));

  const close = body.querySelector('[data-cal-feeds-close]');
  assert.equal(dom.window.document.activeElement, close);
  keydown(dom, close, 'Escape');
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(body.querySelector('[data-cal-feeds="1"]'), null);
  assert.equal(dom.window.document.activeElement, body.querySelector('[data-cal-feed-focus="feed-0"]'));
});

test('a missing calendar slice renders the loading state, and Retry refetches', async () => {
  const calls = [];
  const shell = { calendar: { getState: async () => { calls.push(1); return makeState().calendar; } } };
  const { dom, body, widget, applied } = createHarness({ shell });
  widget.render(body, { state: {}, documentRef: dom.window.document });

  assert.ok(body.querySelector('.cal-status'));
  assert.match(body.textContent, /Loading calendar/);
  click(dom, body.querySelector('[data-cal-retry]'));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(applied.length, 1);
});

test('no calendar IPC renders an error state, not a blank or loading widget', () => {
  const { dom, body, widget } = createHarness({ shell: { calendar: {} } });
  widget.render(body, { state: {}, documentRef: dom.window.document });

  assert.match(body.textContent, /Calendar unavailable/);
});

test('the week grid exposes ARIA grid roles with full-date labels', () => {
  const { body, widget, ctx } = createHarness({ viewMode: 'week' });
  widget.render(body, ctx);

  assert.equal(body.querySelector('.cal-week').getAttribute('role'), 'grid');
  const head = body.querySelector('.cal-week__head-cell');
  assert.equal(head.getAttribute('role'), 'columnheader');
  assert.match(head.getAttribute('aria-label'), /Sunday/);
  assert.equal(body.querySelector('.cal-week__day').getAttribute('role'), 'gridcell');
});

test('the recurrence select offers a yearly option', () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);
  click(dom, body.querySelector('[data-cal-new-event]'));

  const values = [...body.querySelectorAll('#calFormRecurrence option')].map((o) => o.value);
  assert.ok(values.includes('yearly'));
});

// ---- agenda-first view + quick-add (Phase 1) ----

test('the widget defaults to the agenda console with a collapsed quick-add and mini-month rail', () => {
  const { body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  assert.ok(body.querySelector('.cal-agenda'), 'agenda renders by default');
  assert.equal(body.querySelector('.cal-week'), null, 'no week grid in agenda mode');
  assert.ok(body.querySelector('[data-cal-quickadd-expand]'), 'collapsed quick-add affordance present');
  assert.equal(body.querySelector('[data-cal-quickadd-input]'), null);
  assert.ok(body.querySelectorAll('.cal-rail-month__day').length >= 35, 'mini-month rail present');
  // The Agenda toggle reads as pressed.
  assert.equal(body.querySelector('[data-cal-view="agenda"]').getAttribute('aria-pressed'), 'true');
});

test('week mode swaps the mini-month for the week summary', () => {
  const { body, widget, ctx } = createHarness({ viewMode: 'week' });
  widget.render(body, ctx);

  assert.ok(body.querySelector('.cal-week'), 'week grid renders');
  assert.equal(body.querySelectorAll('.cal-rail-month__day').length, 0, 'no mini-month in week mode');
  assert.ok(body.querySelector('.cal-rail__week-summary'));
  assert.equal(body.querySelectorAll('.cal-week__head-cell').length, 7, 'grid keeps its own day header');
});

test('the view toggle switches to the week grid and persists the choice', async () => {
  const calls = [];
  const nextConfig = { calendar: { feeds: [], viewMode: 'week' } };
  const shell = {
    calendar: {},
    home: { updateConfig: async (patch) => { calls.push(patch); return nextConfig; } },
  };
  const { dom, body, widget, ctx, appliedConfigs } = createHarness({ shell });
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-view="week"]'));
  // Optimistic swap: the week grid renders immediately, before the persist.
  assert.ok(body.querySelector('.cal-week'));
  assert.equal(body.querySelector('.cal-agenda'), null);
  assert.equal(body.querySelector('[data-cal-view="week"]').getAttribute('aria-pressed'), 'true');

  await flush();
  assert.equal(calls.length, 1);
  // The full calendar object is written so feeds can't be dropped by a partial write.
  assert.deepEqual(calls[0].calendar, { feeds: [], viewMode: 'week' });
  assert.equal(appliedConfigs.length, 1);
});

test('month mode renders the continuous-scroll grid with empty cells and no agenda chrome', () => {
  const { body, widget, ctx } = createHarness({ viewMode: 'month' });
  widget.render(body, ctx);

  assert.ok(body.querySelector('.cal-month'), 'month grid renders');
  assert.ok(body.querySelector('[data-cal-scroll]'), 'scroll container present');
  assert.equal(body.querySelector('.cal-week'), null);
  assert.equal(body.querySelector('.cal-agenda'), null);
  assert.equal(body.querySelectorAll('.cal-mini__cell').length, 0, 'no mini-strip in month mode');
  assert.equal(body.querySelector('[data-cal-quickadd-input]'), null, 'no quick-add bar in month mode');
  // "even with empty slots": a day with no events is still a real cell.
  const empty = body.querySelector('[data-cal-month-day="2026-06-20"]');
  assert.ok(empty);
  assert.equal(empty.querySelectorAll('.cal-month__event').length, 0);
  assert.equal(body.querySelector('[data-cal-view="month"]').getAttribute('aria-pressed'), 'true');
});

test('the view toggle switches to the month grid and persists the choice', async () => {
  const calls = [];
  const nextConfig = { calendar: { feeds: [], viewMode: 'month' } };
  const shell = {
    calendar: {},
    home: { updateConfig: async (patch) => { calls.push(patch); return nextConfig; } },
  };
  const { dom, body, widget, ctx, appliedConfigs } = createHarness({ shell });
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-view="month"]'));
  assert.ok(body.querySelector('.cal-month'), 'month grid renders optimistically');
  assert.equal(body.querySelector('.cal-agenda'), null);
  assert.equal(body.querySelector('[data-cal-view="month"]').getAttribute('aria-pressed'), 'true');

  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].calendar, { feeds: [], viewMode: 'month' });
  assert.equal(appliedConfigs.length, 1);
});

test('clicking a month event chip opens the edit form via the shared handler', () => {
  const { dom, body, widget, ctx } = createHarness({ viewMode: 'month' });
  widget.render(body, ctx);

  const chip = body.querySelector('[data-cal-month-day="2026-06-11"] .cal-month__event');
  assert.ok(chip, 'the Standup chip renders on its day');
  click(dom, chip);
  assert.equal(body.querySelector('#calFormTitle').value, 'Standup', 'edit form opens seeded from the event');
});

test('clicking an empty month cell opens the create form prefilled to that day at 09:00', () => {
  const { dom, body, widget, ctx } = createHarness({ viewMode: 'month' });
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-month-day="2026-06-20"]'));
  assert.ok(body.querySelector('#calFormTitle'), 'create form opens');
  assert.equal(body.querySelector('#calFormDate').value, '2026-06-20');
  assert.equal(body.querySelector('#calFormStart').value, '09:00');
});

test('clicking a readonly (feed) month chip does nothing', () => {
  const state = makeState({
    instances: [makeInstance({
      instanceId: 'feed:cal:1:2026-06-13T10:00',
      eventId: '',
      readonly: true,
      source: 'feed',
      title: 'Webinar',
      start: '2026-06-13T10:00',
      end: '2026-06-13T11:00',
    })],
  });
  const { dom, body, widget, ctx } = createHarness({ state, viewMode: 'month' });
  widget.render(body, ctx);

  const chip = body.querySelector('[data-cal-month-day="2026-06-13"] .cal-month__event');
  assert.ok(chip);
  assert.equal(chip.getAttribute('data-cal-readonly'), '1');
  click(dom, chip);
  assert.equal(body.querySelector('#calFormTitle'), null, 'no form for a read-only feed event');
});

test('clicking "+N more" opens the day overflow popover', () => {
  const day = '2026-06-22';
  const instances = [8, 9, 10, 11].map((hour, i) => makeInstance({
    instanceId: `m${i}`,
    eventId: `m${i}`,
    title: `Mtg ${i}`,
    start: `${day}T${String(hour).padStart(2, '0')}:00`,
    end: `${day}T${String(hour + 1).padStart(2, '0')}:00`,
  }));
  const { dom, body, widget, ctx } = createHarness({ state: makeState({ instances }), viewMode: 'month' });
  widget.render(body, ctx);

  const more = body.querySelector(`[data-cal-month-day="${day}"] .cal-month__more`);
  assert.ok(more, '+N more chip present');
  const pop = body.querySelector(`#calMonthPop-${day}`);
  assert.ok(pop.hasAttribute('hidden'), 'popover starts hidden');
  click(dom, more);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(pop.hasAttribute('hidden'), false, 'popover opened');
});

test('month nav scrolls without changing the render key (no rebuild)', () => {
  const { dom, body, widget, ctx } = createHarness({ viewMode: 'month' });
  widget.render(body, ctx);
  const keyBefore = body.dataset.calRenderKey;

  click(dom, body.querySelector('[data-cal-nav="next"]'));
  assert.equal(body.dataset.calRenderKey, keyBefore, 'nav in month mode scrolls only — no innerHTML rebuild');
  assert.ok(body.querySelector('.cal-month'), 'month grid still present');
});

test('quick-add creates an event directly when the slot is free', async () => {
  const calls = [];
  const shell = { calendar: { createEvent: async (p) => { calls.push(p); return makeState().calendar; } } };
  const { dom, body, widget, ctx, applied } = createHarness({ shell });
  widget.render(body, ctx);

  expandQuickAdd(dom, body).value = 'Dentist tomorrow 2pm';
  click(dom, body.querySelector('[data-cal-quickadd-add]'));
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Dentist');
  assert.equal(calls[0].start, '2026-06-12T14:00');
  assert.equal(calls[0].end, '2026-06-12T15:00');
  assert.equal(calls[0].allDay, false);
  assert.equal(applied.length, 1);
  // Successful add returns to the collapsed affordance.
  assert.ok(body.querySelector('[data-cal-quickadd-expand]'));
  assert.equal(body.querySelector('[data-cal-quickadd-input]'), null);
});

test('quick-add surfaces a conflict chip and only creates on confirm', async () => {
  const calls = [];
  const shell = { calendar: { createEvent: async (p) => { calls.push(p); return makeState().calendar; } } };
  // The default state has Standup 09:00–09:30 today; "9:15am" overlaps it.
  const { dom, body, widget, ctx } = createHarness({ shell });
  widget.render(body, ctx);

  expandQuickAdd(dom, body).value = 'Sync 9:15am';
  click(dom, body.querySelector('[data-cal-quickadd-add]'));
  await flush();

  assert.equal(calls.length, 0, 'no create until confirmed');
  const chip = body.querySelector('.cal-quickadd__suggest');
  assert.ok(chip);
  assert.match(chip.textContent, /Overlaps Standup/);

  click(dom, body.querySelector('[data-cal-quickadd-confirm]'));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].start, '2026-06-11T09:15');
});

test('quick-add opens the prefilled form for an ambiguous phrase', () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  expandQuickAdd(dom, body).value = 'Dentist tomorrow';
  click(dom, body.querySelector('[data-cal-quickadd-add]'));

  assert.ok(body.querySelector('[data-cal-form="1"]'));
  assert.equal(body.querySelector('#calFormTitle').value, 'Dentist');
  assert.equal(body.querySelector('#calFormDate').value, '2026-06-12');
});

test('quick-add rejects a phrase with no title and shows an inline error', () => {
  const calls = [];
  const shell = { calendar: { createEvent: async (p) => { calls.push(p); return makeState().calendar; } } };
  const { dom, body, widget, ctx } = createHarness({ shell });
  widget.render(body, ctx);

  expandQuickAdd(dom, body).value = '3pm';
  click(dom, body.querySelector('[data-cal-quickadd-add]'));

  assert.equal(calls.length, 0);
  assert.ok(body.querySelector('.cal-quickadd__error'));
});

test('Enter in the quick-add field submits the phrase', async () => {
  const calls = [];
  const shell = { calendar: { createEvent: async (p) => { calls.push(p); return makeState().calendar; } } };
  const { dom, body, widget, ctx } = createHarness({ shell });
  widget.render(body, ctx);

  const input = expandQuickAdd(dom, body);
  input.value = 'Walk tomorrow 5pm';
  keydown(dom, input, 'Enter');
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Walk');
});

test('the mini-month rail selects the clicked day', () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-day-cell="2026-06-10"]'));
  const selected = body.querySelector('[data-cal-day-cell][aria-pressed="true"]');
  assert.ok(selected);
  assert.equal(selected.dataset.calDayCell, '2026-06-10');
});

test('rail month navigation derives the next visible week without separate month state', async () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-rail-nav="next"]'));
  await flush();
  assert.match(body.querySelector('.cal-rail-month__heading').textContent, /July 2026/);
  assert.match(body.querySelector('.cal-toolbar__range').textContent, /Jun 28 . Jul 4/);

  click(dom, body.querySelector('[data-cal-day-cell="2026-07-15"]'));
  await flush();
  assert.match(body.querySelector('.cal-toolbar__range').textContent, /Jul 12 . 18/);
  assert.equal(body.querySelector('[data-cal-day-cell="2026-07-15"]').getAttribute('aria-pressed'), 'true');
});

// ---- per-occurrence editing + tz badge (Phase 2) ----

test('editing a recurring occurrence offers a scope choice and seeds from the occurrence', () => {
  const { dom, body, widget, ctx } = createHarness();
  widget.render(body, ctx);

  click(dom, body.querySelector('[data-cal-event-id="evt_a"]'));
  assert.ok(body.querySelector('[data-cal-form="1"]'));
  // Recurring + opened from an instance -> two scoped save buttons.
  assert.ok(body.querySelector('[data-cal-form-action="save-occurrence"]'));
  assert.ok(body.querySelector('[data-cal-form-action="save"]'));
  assert.match(body.querySelector('.cal-form__series-note').textContent, /choose a scope/);
});

test('"Save this event" sends occurrenceStart; "Save all events" does not', async () => {
  const calls = [];
  const shell = { calendar: { updateEvent: async (id, patch) => { calls.push([id, patch]); return makeState().calendar; } } };
  const occHarness = createHarness({ shell });
  occHarness.widget.render(occHarness.body, occHarness.ctx);
  click(occHarness.dom, occHarness.body.querySelector('[data-cal-event-id="evt_a"]'));
  click(occHarness.dom, occHarness.body.querySelector('[data-cal-form-action="save-occurrence"]'));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'evt_a');
  assert.equal(calls[0][1].occurrenceStart, '2026-06-11T09:00');

  const allCalls = [];
  const shell2 = { calendar: { updateEvent: async (id, patch) => { allCalls.push([id, patch]); return makeState().calendar; } } };
  const allHarness = createHarness({ shell: shell2 });
  allHarness.widget.render(allHarness.body, allHarness.ctx);
  click(allHarness.dom, allHarness.body.querySelector('[data-cal-event-id="evt_a"]'));
  click(allHarness.dom, allHarness.body.querySelector('[data-cal-form-action="save"]'));
  await flush();
  assert.equal(allCalls.length, 1);
  assert.equal('occurrenceStart' in allCalls[0][1], false);
});

test('a tz-approximate feed instance shows an approximate-time badge in the agenda', () => {
  const state = makeState({
    instances: [makeInstance({
      instanceId: 'feed:t:x:2026-06-11T13:00', eventId: '', source: 'feed', feedId: 't',
      readonly: true, tzApprox: true, title: 'Remote sync',
      start: '2026-06-11T13:00', end: '2026-06-11T14:00',
    })],
    events: [],
  });
  const { body, widget, ctx } = createHarness({ state });
  widget.render(body, ctx);

  const row = body.querySelector('[data-cal-instance-id="feed:t:x:2026-06-11T13:00"]');
  assert.ok(row);
  assert.match(row.textContent, /~tz/);
  assert.match(row.getAttribute('aria-label'), /approximate time/);
});
