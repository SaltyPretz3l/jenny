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
