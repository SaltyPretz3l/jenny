const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HOME_CALENDAR_CATEGORIES,
  HOME_CALENDAR_RECURRENCE_PRESETS,
  MAX_CALENDAR_EVENTS,
  MAX_CALENDAR_EVENT_SOURCE_ID_CHARS,
  addWallClockMinutes,
  buildLocalInstance,
  computeCalendarWindow,
  expandCalendarEvent,
  expandCalendarEvents,
  formatLocalDateTime,
  normalizeCalendarEvent,
  normalizeCalendarEventList,
  parseLocalDateTime,
  wallClockDurationMinutes,
} = require('../services/home-calendar-schema');

const WINDOW = {
  windowStart: new Date(2026, 5, 4), // 2026-06-04 local midnight
  windowEnd: new Date(2026, 7, 11), // 2026-08-11 local midnight
};

function makeEvent(overrides = {}) {
  return normalizeCalendarEvent({
    id: 'evt_1',
    title: 'Standup',
    start: '2026-06-08T09:00',
    end: '2026-06-08T09:30',
    categoryId: 'work',
    recurrence: 'none',
    ...overrides,
  });
}

test('parseLocalDateTime accepts naive local datetimes and rejects overflow', () => {
  const parsed = parseLocalDateTime('2026-06-11T09:30');
  assert.equal(formatLocalDateTime(parsed), '2026-06-11T09:30');
  assert.equal(parseLocalDateTime('2026-02-30T09:00'), null);
  assert.equal(parseLocalDateTime('2026-06-11T24:00'), null);
  assert.equal(parseLocalDateTime('2026-06-11'), null);
  assert.equal(parseLocalDateTime('2026-06-11T09:30:15') !== null, true);
  assert.equal(parseLocalDateTime(''), null);
});

test('normalizeCalendarEvent heals bad ends and clamps enums', () => {
  const healed = makeEvent({ end: '2026-06-08T08:00', categoryId: 'neon', recurrence: 'hourly' });
  assert.equal(healed.end, '2026-06-08T09:30');
  assert.equal(healed.categoryId, 'default');
  assert.equal(healed.recurrence, 'none');

  const allDay = makeEvent({ allDay: true, start: '2026-06-08T14:20', end: '2026-06-08T15:00' });
  assert.equal(allDay.start, '2026-06-08T00:00');
  assert.equal(allDay.end, '2026-06-09T00:00');

  assert.equal(normalizeCalendarEvent({ id: 'x', start: 'not-a-date' }), null);
  assert.equal(normalizeCalendarEvent({ title: 'no id', start: '2026-06-08T09:00' }), null);
});

test('normalizeCalendarEvent bounds title and preserves notes newlines', () => {
  const event = makeEvent({
    title: `  multi\nline ${'x'.repeat(300)}`,
    notes: 'step one\nstep two\n',
  });
  assert.equal(event.title.length <= 200, true);
  assert.equal(event.title.includes('\n'), false);
  assert.equal(event.notes, 'step one\nstep two\n');
});

test('normalizeCalendarEventList dedupes ids and caps the store', () => {
  const events = normalizeCalendarEventList([
    { id: 'a', start: '2026-06-08T09:00' },
    { id: 'a', start: '2026-06-09T09:00' },
    { id: 'b', start: 'garbage' },
    { id: 'c', start: '2026-06-10T09:00' },
  ]);
  assert.deepEqual(events.map((e) => e.id), ['a', 'c']);

  const many = Array.from({ length: MAX_CALENDAR_EVENTS + 20 }, (_, i) => ({
    id: `evt_${i}`,
    start: '2026-06-08T09:00',
  }));
  assert.equal(normalizeCalendarEventList(many).length, MAX_CALENDAR_EVENTS);
});

test('category list mirrors the config color enum', () => {
  assert.deepEqual(
    HOME_CALENDAR_CATEGORIES.map((c) => c.id),
    ['default', 'work', 'personal', 'focus', 'meeting', 'errand']
  );
  assert.equal(HOME_CALENDAR_CATEGORIES[1].label, 'Work');
  assert.deepEqual(
    [...HOME_CALENDAR_RECURRENCE_PRESETS],
    ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly']
  );
});

test('computeCalendarWindow spans -7d..+60d full local days', () => {
  const { windowStart, windowEnd } = computeCalendarWindow(new Date(2026, 5, 11, 14, 30));
  assert.equal(formatLocalDateTime(windowStart), '2026-06-04T00:00');
  assert.equal(formatLocalDateTime(windowEnd), '2026-08-11T00:00');
});

test('non-recurring events expand to a single windowed instance', () => {
  const instances = expandCalendarEvent(makeEvent(), WINDOW);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].instanceId, 'evt_1:2026-06-08T09:00');
  assert.equal(instances[0].source, 'local');
  assert.equal(instances[0].readonly, false);
  assert.equal(instances[0].recurring, false);

  const outside = expandCalendarEvent(makeEvent({ start: '2026-01-05T09:00', end: '2026-01-05T10:00' }), WINDOW);
  assert.equal(outside.length, 0);
});

test('daily and weekdays presets expand correct weekday sets', () => {
  const daily = expandCalendarEvent(makeEvent({ recurrence: 'daily' }), {
    ...WINDOW,
    windowEnd: new Date(2026, 5, 15),
  });
  // Jun 8..14 inclusive = 7 instances
  assert.equal(daily.length, 7);
  assert.equal(daily[0].start, '2026-06-08T09:00');
  assert.equal(daily[0].recurring, true);

  const weekdays = expandCalendarEvent(makeEvent({ recurrence: 'weekdays' }), {
    ...WINDOW,
    windowEnd: new Date(2026, 5, 15),
  });
  // Jun 8 (Mon)..Jun 12 (Fri) — Sat 13 / Sun 14 skipped
  assert.deepEqual(
    weekdays.map((i) => i.start),
    ['2026-06-08T09:00', '2026-06-09T09:00', '2026-06-10T09:00', '2026-06-11T09:00', '2026-06-12T09:00']
  );
});

test('weekly and biweekly presets keep wall-clock time from years back', () => {
  const weekly = expandCalendarEvent(
    makeEvent({ start: '2024-01-01T09:00', end: '2024-01-01T09:30', recurrence: 'weekly' }),
    { ...WINDOW, windowEnd: new Date(2026, 5, 20) }
  );
  // 2024-01-01 is a Monday: Mondays in window = Jun 8, Jun 15
  assert.deepEqual(weekly.map((i) => i.start), ['2026-06-08T09:00', '2026-06-15T09:00']);
  assert.equal(weekly.every((i) => i.start.endsWith('T09:00')), true);

  const biweekly = expandCalendarEvent(
    makeEvent({ start: '2026-06-01T10:00', end: '2026-06-01T11:00', recurrence: 'biweekly' }),
    { ...WINDOW, windowEnd: new Date(2026, 6, 1) }
  );
  assert.deepEqual(biweekly.map((i) => i.start), ['2026-06-15T10:00', '2026-06-29T10:00']);
});

test('monthly preset skips months without the anchor day', () => {
  const instances = expandCalendarEvent(
    makeEvent({ start: '2026-01-31T12:00', end: '2026-01-31T13:00', recurrence: 'monthly' }),
    {
      windowStart: new Date(2026, 0, 1),
      windowEnd: new Date(2026, 6, 1),
    }
  );
  // Jan, Mar, May have a 31st; Feb, Apr, Jun do not.
  assert.deepEqual(
    instances.map((i) => i.start),
    ['2026-01-31T12:00', '2026-03-31T12:00', '2026-05-31T12:00']
  );
});

test('yearly preset steps by calendar year and keeps wall-clock time', () => {
  const instances = expandCalendarEvent(
    makeEvent({ start: '2020-03-15T08:00', end: '2020-03-15T09:00', recurrence: 'yearly' }),
    { windowStart: new Date(2026, 0, 1), windowEnd: new Date(2027, 0, 1) }
  );
  assert.deepEqual(instances.map((i) => i.start), ['2026-03-15T08:00']);
  assert.equal(instances[0].recurring, true);
});

test('yearly preset skips Feb 29 in non-leap years', () => {
  // 2027 is not a leap year, so a Feb 29 anchor produces no 2027 occurrence.
  const instances = expandCalendarEvent(
    makeEvent({ start: '2024-02-29T08:00', end: '2024-02-29T09:00', recurrence: 'yearly' }),
    { windowStart: new Date(2027, 0, 1), windowEnd: new Date(2028, 0, 1) }
  );
  assert.deepEqual(instances.map((i) => i.start), []);
});

test('expandCalendarEvents merges and sorts instances across events', () => {
  const instances = expandCalendarEvents(
    [
      makeEvent({ id: 'b', start: '2026-06-09T08:00', end: '2026-06-09T08:30' }),
      makeEvent({ id: 'a', start: '2026-06-08T09:00', end: '2026-06-08T09:30' }),
    ],
    WINDOW
  );
  assert.deepEqual(instances.map((i) => i.eventId), ['a', 'b']);
});

test('wall-clock duration helpers measure and re-apply in calendar components', () => {
  // Component math (never a millisecond delta) is what keeps a recurrence's
  // local end stable across a 23h/25h DST day.
  assert.equal(
    wallClockDurationMinutes(new Date(2026, 5, 11, 9, 0), new Date(2026, 5, 11, 10, 30)),
    90
  );
  // Crossing midnight: the day component carries the extra 24h.
  assert.equal(
    wallClockDurationMinutes(new Date(2026, 5, 11, 23, 0), new Date(2026, 5, 12, 0, 30)),
    90
  );
  const end = addWallClockMinutes(new Date(2026, 5, 11, 9, 0), 90);
  assert.equal(end.getHours(), 10);
  assert.equal(end.getMinutes(), 30);
  // Overflow rolls to the next day by calendar arithmetic (local-time safe).
  const rolled = addWallClockMinutes(new Date(2026, 5, 11, 23, 30), 60);
  assert.equal(formatLocalDateTime(rolled), '2026-06-12T00:30');
});

test('recurring expansion keeps the wall-clock end time of day on every occurrence', () => {
  const instances = expandCalendarEvent(
    makeEvent({ start: '2026-06-08T09:00', end: '2026-06-08T10:00', recurrence: 'weekly' }),
    { ...WINDOW, windowEnd: new Date(2026, 7, 1) }
  );
  assert.ok(instances.length >= 6);
  // Component-derived ends mean every occurrence is 09:00–10:00, never drifted.
  assert.equal(instances.every((i) => i.start.endsWith('T09:00') && i.end.endsWith('T10:00')), true);
});

test('exceptions remove the matching occurrences from a recurring series', () => {
  const event = makeEvent({
    start: '2026-06-08T09:00',
    end: '2026-06-08T09:30',
    recurrence: 'daily',
    exceptions: ['2026-06-09T09:00', '2026-06-11T09:00'],
  });
  assert.deepEqual(event.exceptions, ['2026-06-09T09:00', '2026-06-11T09:00']);
  const instances = expandCalendarEvent(event, { ...WINDOW, windowEnd: new Date(2026, 5, 13) });
  const starts = instances.map((i) => i.start);
  // Jun 8..12 daily, minus the two excepted days.
  assert.deepEqual(starts, ['2026-06-08T09:00', '2026-06-10T09:00', '2026-06-12T09:00']);
});

test('normalizeCalendarEvent drops unparseable exception keys and dedupes', () => {
  const event = makeEvent({ exceptions: ['2026-06-09T09:00', 'garbage', '2026-06-09T09:00'] });
  assert.deepEqual(event.exceptions, ['2026-06-09T09:00']);
  assert.deepEqual(makeEvent({ exceptions: 'nope' }).exceptions, []);
});

test('expansion respects the per-event instance cap', () => {
  const instances = expandCalendarEvent(
    makeEvent({ recurrence: 'daily', start: '2020-01-01T09:00', end: '2020-01-01T09:30' }),
    {
      windowStart: new Date(2020, 0, 1),
      windowEnd: new Date(2030, 0, 1),
      maxInstances: 10,
    }
  );
  assert.equal(instances.length, 10);
});

test('event attribution normalizes sourceKind to the closed enum and bounds sourceId', () => {
  assert.equal(makeEvent({ sourceKind: 'assistant' }).sourceKind, 'assistant');
  assert.equal(makeEvent({ sourceKind: 'ASSISTANT' }).sourceKind, 'assistant');
  // Anything outside the enum is unattributed rather than event-dropping.
  // 'user' is deliberately NOT a member: nothing writes it, and every reader
  // asks only whether the assistant created the record.
  assert.equal(makeEvent({ sourceKind: 'user' }).sourceKind, '');
  assert.equal(makeEvent({ sourceKind: 'agent_task' }).sourceKind, '');
  assert.equal(makeEvent({ sourceKind: 42 }).sourceKind, '');
  assert.equal(makeEvent({ sourceKind: null }).sourceKind, '');
  assert.equal(makeEvent({}).sourceKind, '');

  assert.equal(makeEvent({ sourceId: 'msg_42' }).sourceId, 'msg_42');
  assert.equal(makeEvent({}).sourceId, '');
  assert.equal(makeEvent({ sourceId: 'x'.repeat(400) }).sourceId.length, MAX_CALENDAR_EVENT_SOURCE_ID_CHARS);
});

test('attribution is idempotent and survives a normalize round-trip', () => {
  const once = makeEvent({ sourceKind: 'assistant', sourceId: 'msg_42' });
  const twice = normalizeCalendarEvent(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});

test('buildLocalInstance carries attribution onto every expanded occurrence', () => {
  const event = makeEvent({
    sourceKind: 'assistant',
    sourceId: 'msg_42',
    recurrence: 'weekly',
    start: '2026-06-08T09:00',
    end: '2026-06-08T09:30',
  });
  const instances = expandCalendarEvent(event, WINDOW);
  assert.ok(instances.length > 1);
  for (const instance of instances) {
    assert.equal(instance.sourceKind, 'assistant');
    assert.equal(instance.sourceId, 'msg_42');
  }

  const direct = buildLocalInstance(event, new Date(2026, 5, 8, 9, 0), new Date(2026, 5, 8, 9, 30));
  assert.equal(direct.sourceKind, 'assistant');
  assert.equal(direct.sourceId, 'msg_42');
});

test('buildLocalInstance re-coerces a hand-built event with a bogus sourceKind', () => {
  // Instances can be built from an event object that never passed through
  // normalizeCalendarEvent (feed adapters, tests), so the enum is re-applied.
  const raw = { ...makeEvent({}), sourceKind: 'agent_task', sourceId: 'y'.repeat(400) };
  const instance = buildLocalInstance(raw, new Date(2026, 5, 8, 9, 0), new Date(2026, 5, 8, 9, 30));
  assert.equal(instance.sourceKind, '');
  assert.equal(instance.sourceId.length, MAX_CALENDAR_EVENT_SOURCE_ID_CHARS);
});
