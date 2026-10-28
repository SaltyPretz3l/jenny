'use strict';

// Home tool date handling, delete scope, own-key dispatch and count
// semantics. Kept apart from home-tool.test.js (descriptor + happy paths).

const test = require('node:test');
const assert = require('node:assert/strict');

const homeTool = require('../services/tools/builtin/home-tool');
const {
  computeOverlaps,
  shapeCalendarMetadata,
  MAX_METADATA_INSTANCES,
  MAX_OVERLAPS_PER_INSTANCE,
  MAX_METADATA_TITLE_CHARS,
} = require('../services/tools/builtin/home-calendar-result-shape');
const { normalizeHomeResultMetadata } = require('../services/backend/home-calendar-result-metadata');

function service(overrides = {}) {
  const calls = [];
  return {
    calls,
    listCalendar(range) {
      calls.push(['listCalendar', range]);
      return {
        rangeStart: range.start || '2026-08-13T00:00',
        rangeEnd: range.end || '2026-10-21T00:00',
        instances: Array.from({ length: 65 }, (_, index) => ({
          instanceId: `evt_${index}`,
          eventId: `evt_${index}`,
          title: `Event ${index}`,
          start: `2026-08-${String(10 + (index % 20)).padStart(2, '0')}T10:00`,
          end: `2026-08-${String(10 + (index % 20)).padStart(2, '0')}T11:00`,
        })),
      };
    },
    readEvent(id) {
      calls.push(['readEvent', id]);
      const events = {
        evt_timed: { id: 'evt_timed', title: 'Standup', start: '2026-08-21T10:00', end: '2026-08-21T11:30' },
        evt_series: {
          id: 'evt_series', title: 'Gym', start: '2026-08-21T07:00', end: '2026-08-21T08:00', recurrence: 'weekly',
        },
      };
      return events[id] ? { ...events[id] } : null;
    },
    readReminder(id) {
      calls.push(['readReminder', id]);
      return id === 'rem_daily' ? { id, label: 'Stretch', scheduleType: 'daily_at', dailyAt: '09:30' } : null;
    },
    getProactive() {
      throw new Error('a single reminder read must not clone the whole list');
    },
    upsertEvent(input) {
      calls.push(['upsertEvent', input]);
      return { ok: true, op: input.id ? 'update' : 'create', entityId: input.id || 'evt_new', entityState: input };
    },
    now: () => new Date(2026, 7, 20, 9, 5),
    ...overrides,
  };
}

const ctx = (svc) => ({ homeAssistantService: svc, sessionId: 'sess', callId: 'call' });
const upserts = (svc) => svc.calls.filter(([name]) => name === 'upsertEvent').map(([, input]) => input);

test('moving an event start without an end keeps its duration', async () => {
  const svc = service();
  const result = await homeTool.execute({ action: 'event_upsert', id: 'evt_timed', start: '2026-08-22T14:00' }, ctx(svc));
  assert.equal(result.isError, false);
  assert.deepEqual(upserts(svc)[0], { id: 'evt_timed', start: '2026-08-22T14:00', end: '2026-08-22T15:30' });
});

test('an explicit end wins and toggling all_day does not inherit the old length', async () => {
  const svc = service();
  await homeTool.execute({ action: 'event_upsert', id: 'evt_timed', start: '2026-08-22T14:00', end: '2026-08-22T14:15' }, ctx(svc));
  await homeTool.execute({ action: 'event_upsert', id: 'evt_timed', start: '2026-08-22T00:00', all_day: true }, ctx(svc));
  const [explicit, toggled] = upserts(svc);
  assert.equal(explicit.end, '2026-08-22T14:15');
  assert.equal(toggled.end, undefined);
});

test('start, end and range bounds are validated with structured failures', async () => {
  const svc = service();
  const cases = [
    [{ action: 'event_upsert', id: 'evt_timed', start: '2026-02-30T10:00' }, 'invalid_start'],
    [{ action: 'event_upsert', id: 'evt_timed', end: 'tomorrow' }, 'invalid_end'],
    [{ action: 'event_upsert', start: '2026-08-22T10:00', end: '2026-08-22T09:00' }, 'invalid_range'],
    [{ action: 'event_upsert', id: 'evt_timed', start: { at: 'noon' } }, 'invalid_start'],
    [{ action: 'calendar_list', range_start: 'next week' }, 'invalid_range_start'],
    [{ action: 'calendar_list', range_start: '2026-09-02', range_end: '2026-09-01' }, 'invalid_range'],
  ];
  for (const [input, reason] of cases) {
    const result = await homeTool.execute(input, ctx(svc));
    assert.equal(result.isError, true, JSON.stringify(input));
    assert.equal(result.metadata.reason, reason, JSON.stringify(input));
  }
  assert.deepEqual(svc.calls.filter(([name]) => name !== 'readEvent'), [], 'nothing reached the facade');
});

test('delete confirmation names the scope of what would be removed', async () => {
  const svc = service();
  const series = await homeTool.execute({ action: 'event_delete', id: 'evt_series' }, ctx(svc));
  assert.equal(series.metadata.status, 'confirmation_required');
  assert.equal(series.metadata.target_scope, 'series');
  assert.match(series.content, /weekly recurring event/);
  assert.match(series.content, /EVERY occurrence/);
  const single = await homeTool.execute({ action: 'event_delete', id: 'evt_timed' }, ctx(svc));
  assert.equal(single.metadata.target_scope, 'single');
  assert.match(single.content, /single event at 2026-08-21T10:00/);
  const daily = await homeTool.execute({ action: 'reminder_delete', id: 'rem_daily' }, ctx(svc));
  assert.equal(daily.metadata.target_scope, 'series');
  assert.match(daily.content, /daily reminder at 09:30/);
});

test('reminder upsert says when it fires instead of claiming nothing fires', async () => {
  const svc = service({
    upsertReminder: (input) => ({ ok: true, op: 'create', entityId: 'rem_new', entityState: { label: 'Tea', ...input } }),
  });
  const result = await homeTool.execute({ action: 'reminder_upsert', label: 'Tea', remind_at: '16:00' }, ctx(svc));
  assert.doesNotMatch(result.content, /nothing fires/);
  assert.match(result.content, /notification while she is running/);
});

test('prototype keys are not actions', async () => {
  const svc = service();
  for (const action of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const result = await homeTool.execute({ action }, ctx(svc));
    assert.equal(result.metadata.reason, 'unsupported_action', action);
    assert.equal(homeTool.summarize({ action }), 'Home: action');
  }
  assert.equal(homeTool.summarize({ action: 'calendar_list' }), 'Home: calendar_list');
});

test('calendar_list counts mean the same thing at both levels and use the facade clock', async () => {
  const result = await homeTool.execute({ action: 'calendar_list' }, ctx(service()));
  assert.equal(result.metadata.instance_count, 65);
  assert.equal(result.metadata.listed_count, 60);
  assert.equal(result.metadata.calendar.instance_count, 65);
  assert.equal(result.metadata.calendar.generated_at, '2026-08-20T09:05');
});

test('the sweep finds the same overlaps as a pairwise scan', () => {
  const instances = [];
  for (let index = 0; index < 40; index += 1) {
    const hour = 8 + (index % 7);
    const length = 1 + (index % 3);
    instances.push({
      instanceId: `i${index}`,
      title: `T${index}`,
      start: `2026-08-21T${String(hour).padStart(2, '0')}:${index % 2 ? '30' : '00'}`,
      end: `2026-08-21T${String(hour + length).padStart(2, '0')}:00`,
    });
  }
  const sorted = [...instances].sort((a, b) => a.start.localeCompare(b.start) || a.instanceId.localeCompare(b.instanceId));
  const expected = new Map();
  sorted.forEach((later, laterIndex) => {
    for (const earlier of sorted.slice(0, laterIndex)) {
      if (!(earlier.start < later.end && later.start < earlier.end)) continue;
      const list = expected.get(later.instanceId) || [];
      if (list.length < MAX_OVERLAPS_PER_INSTANCE) list.push(earlier.instanceId);
      expected.set(later.instanceId, list);
    }
  });
  const actual = computeOverlaps(instances);
  assert.deepEqual(
    [...actual].map(([id, list]) => [id, list.map((entry) => entry.instance_id)]),
    [...expected]
  );
});

test('tool-side caps match the persisted metadata normalizer (no second truncation)', () => {
  const long = 'x'.repeat(MAX_METADATA_TITLE_CHARS + 50);
  const instances = Array.from({ length: MAX_METADATA_INSTANCES + 5 }, (_, index) => ({
    instanceId: `i${index}`, eventId: `e${index}`, title: long,
    start: '2026-08-21T10:00', end: '2026-08-21T11:00',
  }));
  const shaped = shapeCalendarMetadata({
    listing: { rangeStart: '2026-08-21T00:00', rangeEnd: '2026-08-22T00:00', instances },
    journalEntries: [],
    sessionId: 's',
    now: new Date(2026, 7, 21, 9, 0),
  });
  assert.equal(shaped.instances.length, MAX_METADATA_INSTANCES);
  assert.equal(shaped.instances.at(-1).overlaps.length, MAX_OVERLAPS_PER_INSTANCE);
  const persisted = normalizeHomeResultMetadata({
    result_kind: 'home', action: 'calendar_list', status: 'ok', calendar: shaped,
  }).calendar;
  assert.equal(persisted.instances.length, shaped.instances.length);
  assert.equal(persisted.instances.at(-1).overlaps.length, shaped.instances.at(-1).overlaps.length);
  assert.equal(persisted.instances[0].title, shaped.instances[0].title);
  assert.equal(persisted.instance_count, shaped.instance_count);
});

// ---- bare-date range_end covers its whole day (real calendar + facade) ----

function realHome() {
  const { EventEmitter } = require('node:events');
  const { CalendarService } = require('../services/calendar-service');
  const { HomeAssistantService } = require('../services/home-assistant-service');
  const memoryStore = (seed) => ({ value: seed, read(fallback) { return this.value ?? fallback; }, writeImmediate(value) { this.value = value; } });
  const configService = Object.assign(new EventEmitter(), { getHomeConfig: () => ({}) });
  const nowProvider = () => new Date(2026, 9, 24, 10, 0);
  const calendarService = new CalendarService({ configService, store: memoryStore({ events: [
    { id: 'today', title: 'Today noon', start: '2026-10-24T12:00', end: '2026-10-24T13:00' },
    { id: 'yday', title: 'Yesterday', start: '2026-10-23T12:00', end: '2026-10-23T13:00' },
    { id: 'tomorrow', title: 'Tomorrow', start: '2026-10-25T12:00', end: '2026-10-25T13:00' },
  ] }), nowProvider });
  return new HomeAssistantService({ calendarService, configService, store: memoryStore({}), nowProvider });
}

test('calendar_list with a bare-date range_end includes that whole day', async () => {
  const svc = realHome();
  const same = await homeTool.execute({ action: 'calendar_list', range_start: '2026-10-24', range_end: '2026-10-24' }, ctx(svc));
  assert.equal(same.isError, false, same.content);
  assert.match(same.content, /Today noon/);
  assert.doesNotMatch(same.content, /Yesterday|Tomorrow/);
  assert.equal(same.metadata.range_end, '2026-10-25T00:00');
  const span = await homeTool.execute({ action: 'calendar_list', range_start: '2026-10-23', range_end: '2026-10-24' }, ctx(svc));
  assert.match(span.content, /Yesterday/);
  assert.match(span.content, /Today noon/);
  assert.doesNotMatch(span.content, /Tomorrow/);
});

test('a date-time range_end stays exclusive and start equal to end is still refused', async () => {
  const svc = realHome();
  const exclusive = await homeTool.execute({ action: 'calendar_list', range_start: '2026-10-23', range_end: '2026-10-24T00:00' }, ctx(svc));
  assert.equal(exclusive.isError, false);
  assert.match(exclusive.content, /Yesterday/);
  assert.doesNotMatch(exclusive.content, /Today noon/);
  const equal = await homeTool.execute({ action: 'calendar_list', range_start: '2026-10-24T09:00', range_end: '2026-10-24T09:00' }, ctx(svc));
  assert.equal(equal.isError, true);
  assert.equal(equal.metadata.reason, 'invalid_range');
});

test('home argument failures are classified bad_arguments with no effects; missing records are not_found', async () => {
  const svc = service({ upsertReminder: () => ({ ok: false, reason: 'not_found' }) });
  const cases = [
    { action: 'calendar_list', range_start: '2026-09-02', range_end: '2026-09-01' },
    { action: 'calendar_list', range_start: 'next week' },
    { action: 'event_upsert', id: 'evt_timed', start: '2026-02-30T10:00' },
    { action: 'event_delete' },
    { action: 'reminder_upsert', label: 'Tea' },
  ];
  for (const input of cases) {
    const result = await homeTool.execute(input, ctx(svc));
    assert.equal(result.isError, true, JSON.stringify(input));
    assert.equal(result.metadata.failure_class, 'bad_arguments', JSON.stringify(input));
    assert.equal(result.metadata.effects, 'none', JSON.stringify(input));
    assert.equal(result.metadata.status, 'failed');
  }
  const missing = await homeTool.execute({ action: 'event_delete', id: 'evt_nope' }, ctx(svc));
  assert.equal(missing.metadata.reason, 'not_found');
  assert.equal(missing.metadata.failure_class, 'not_found');
  assert.equal(missing.metadata.effects, 'none');
  const refused = await homeTool.execute({ action: 'reminder_upsert', id: 'rem_x', label: 'Tea' }, ctx(svc));
  assert.equal(refused.metadata.failure_class, 'not_found');
  const unsupported = await homeTool.execute({ action: 'nope' }, ctx(svc));
  assert.equal(unsupported.metadata.failure_class, undefined);
});
