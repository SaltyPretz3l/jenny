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
