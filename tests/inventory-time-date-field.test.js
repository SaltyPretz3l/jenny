const assert = require('node:assert/strict');
const test = require('node:test');

const timeField = require('../renderer/inventory/time-field');
const dateField = require('../renderer/inventory/date-field');

test('timeField renders a labeled time input with sanitized value', () => {
  const html = timeField({
    id: 'calStart',
    label: 'Start',
    value: '09:30',
    step: '300',
    hint: 'Local time',
    dataset: { 'calendar-field': 'start' },
  });
  assert.match(html, /<label class="inv-time-field" for="calStart">/);
  assert.match(html, /<span class="inv-time-field-label">Start<\/span>/);
  assert.match(html, /type="time"/);
  assert.match(html, /value="09:30"/);
  assert.match(html, /step="300"/);
  assert.match(html, /data-calendar-field="start"/);
  assert.match(html, /<span class="inv-time-field-hint">Local time<\/span>/);
});

test('timeField drops malformed values, steps, ids, and dataset keys', () => {
  const html = timeField({
    id: 'bad id',
    value: '25:99',
    step: '5m',
    dataset: { 'Bad_Key': 'x' },
  });
  assert.doesNotMatch(html, /value=/);
  assert.doesNotMatch(html, /step=/);
  assert.doesNotMatch(html, /for=/);
  assert.doesNotMatch(html, /data-/);
});

test('timeField escapes label/hint/aria text', () => {
  const html = timeField({ id: 't', label: '<b>"x"</b>', hint: '<i>tip</i>', ariaLabel: "a'b" });
  assert.match(html, /&lt;b&gt;&quot;x&quot;&lt;\/b&gt;/);
  // The hint span is conditional, so omitting `hint` skipped its escaping branch.
  assert.match(html, /&lt;i&gt;tip&lt;\/i&gt;/);
  assert.match(html, /aria-label="a&#39;b"/);
  assert.doesNotMatch(html, /<b>/);
  assert.doesNotMatch(html, /<i>/);
});

test('dateField renders value/min/max only when well-formed', () => {
  const html = dateField({
    id: 'calDate',
    label: 'Date',
    value: '2026-06-11',
    min: '2026-06-04',
    max: 'someday',
    disabled: true,
  });
  assert.match(html, /type="date"/);
  assert.match(html, /value="2026-06-11"/);
  assert.match(html, /min="2026-06-04"/);
  assert.doesNotMatch(html, /max=/);
  assert.match(html, / disabled/);
});

test('dateField tolerates empty options', () => {
  const html = dateField();
  assert.match(html, /<label class="inv-date-field">/);
  assert.match(html, /aria-label="Date input"/);
  assert.doesNotMatch(html, /value=/);
});
