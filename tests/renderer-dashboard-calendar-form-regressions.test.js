const test = require('node:test');
const assert = require('node:assert/strict');

const form = require('../renderer/features/renderer-dashboard-calendar-form.js');

test('late-night default create values remain valid on their single date', () => {
  const values = form.buildDefaultCreateValues(new Date(2026, 5, 11, 23, 10));

  assert.equal(values.date, '2026-06-11');
  assert.equal(values.start, '23:30');
  assert.equal(values.end, '23:59');
  assert.equal(form.buildEventPayload(values).error, undefined);
});

test('HOM-06 title edits and date moves preserve multi-day event spans; typed times win', () => {
  for (const allDay of [true, false]) {
    const event = { id: 'span', title: 'Trip', start: '2026-06-11T09:00', end: '2026-06-14T10:00', allDay };
    if (allDay) { event.start = '2026-06-11T00:00'; event.end = '2026-06-14T00:00'; }
    const values = form.buildEditValues(event);
    values.title = 'Renamed';
    assert.equal(form.buildEventPayload(values).payload.end, event.end);
    values.date = '2026-06-12';
    if (!allDay) values.start = '11:00';
    assert.equal(form.buildEventPayload(values).payload.end, allDay ? '2026-06-15T00:00' : '2026-06-15T10:00');
  }
});

test('HOM-06 saved times are the times the form shows', () => {
  const edit = (changes, event = { id: 'e', title: 'Call', start: '2026-06-11T10:00', end: '2026-06-11T11:00' }) => {
    const values = Object.assign(form.buildEditValues(event), changes);
    const { payload } = form.buildEventPayload(values);
    return `${payload.start}/${payload.end}`;
  };
  assert.equal(edit({ start: '14:00', end: '15:00' }), '2026-06-11T14:00/2026-06-11T15:00');
  assert.equal(edit({ start: '10:30', end: '11:30' }), '2026-06-11T10:30/2026-06-11T11:30');
  assert.equal(edit({ start: '10:30' }), '2026-06-11T10:30/2026-06-11T11:00');
  const allDay = { id: 'd', title: 'Off', start: '2026-06-11T00:00', end: '2026-06-11T00:00', allDay: true };
  assert.equal(edit({ allDay: false, start: '10:00', end: '11:00' }, allDay), '2026-06-11T10:00/2026-06-11T11:00');
});

test('HOM-06 single-date forms accept overnight events and preserve them on edit', () => {
  const values = { date: '2026-06-11', start: '23:00', end: '01:00' };
  const result = form.buildEventPayload(values);
  assert.equal(result.error, undefined);
  assert.equal(result.payload.end, '2026-06-12T01:00');
  const edit = form.buildEditValues({ id: 'night', ...result.payload });
  assert.equal(form.buildEventPayload(edit).payload.end, result.payload.end);
  assert.ok(form.buildEventPayload({ ...values, end: '23:00' }).error);
});

test('shortening an overnight event keeps it same-day; a 24h event keeps its span', () => {
  const overnight = form.buildEditValues({ id: 'o', title: 'Shift', start: '2026-06-11T22:00', end: '2026-06-12T02:00' });
  assert.equal(form.endDayOffset(overnight), 0);
  assert.equal(form.buildEventPayload(overnight).payload.end, '2026-06-12T02:00');
  overnight.end = '23:30';
  assert.equal(form.buildEventPayload(overnight).payload.end, '2026-06-11T23:30');

  const fullDay = form.buildEditValues({ id: 'f', title: 'Watch', start: '2026-06-11T08:00', end: '2026-06-12T08:00' });
  assert.equal(form.endDayOffset(fullDay), 1);
  assert.equal(form.buildEventPayload(fullDay).payload.end, '2026-06-12T08:00');
});

test('"Save all events" from an occurrence moves the series anchor by the same day delta', () => {
  const values = form.buildEditValues({ id: 's', title: 'Standup', start: '2026-06-01T09:00', end: '2026-06-01T09:30', recurrence: 'daily' });
  // Opened from the Jun 22 occurrence: the form shows that date.
  Object.assign(values, { occurrenceStart: '2026-06-22T09:00', date: '2026-06-22', start: '09:00', end: '09:30' });
  values.title = 'Daily standup';
  const unchanged = form.rebaseSeriesPayload(form.buildEventPayload(values).payload, values);
  assert.equal(unchanged.start, '2026-06-01T09:00');
  assert.equal(unchanged.end, '2026-06-01T09:30');

  values.date = '2026-06-23';
  values.start = '10:00';
  values.end = '10:30';
  const moved = form.rebaseSeriesPayload(form.buildEventPayload(values).payload, values);
  assert.equal(moved.start, '2026-06-02T10:00');
  assert.equal(moved.end, '2026-06-02T10:30');
});
