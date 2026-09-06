'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellLogStore } = require('../services/shell-log-store');

test('shell log store default retention follows the shared Logs V2 contract', () => {
  const store = new ShellLogStore();

  for (let index = 0; index < 405; index += 1) {
    store.append({ event: `event.${index}` });
  }

  const entries = store.list();
  assert.equal(entries.length, 400);
  assert.equal(entries[0].event, 'event.5');
  assert.equal(entries.at(-1).event, 'event.404');
});

test('shell log store does not expose mutable internal entries from append or list', () => {
  const store = new ShellLogStore({ limit: 50 });

  const appended = store.append({
    level: 'WARN',
    event: 'shell.warning',
    details: { code: 'A1', nested: { code: 'N1' } },
    data: { payload: { code: 'D1' } },
  });
  appended.level = 'ERROR';
  appended.details.code = 'MUTATED';
  appended.details.nested.code = 'MUTATED_NESTED';
  appended.data.payload.code = 'MUTATED_DATA';

  const listed = store.list();
  listed[0].event = 'shell.changed';
  listed[0].details.code = 'CHANGED';
  listed[0].details.nested.code = 'CHANGED_NESTED';
  listed[0].data.payload.code = 'CHANGED_DATA';

  const fresh = store.list()[0];
  assert.equal(fresh.entry_id, 'log_1');
  assert.equal(fresh.level, 'WARN');
  assert.equal(fresh.event, 'shell.warning');
  assert.deepEqual(fresh.details, { code: 'A1', nested: { code: 'N1' } });
  assert.deepEqual(fresh.data, { payload: { code: 'D1' } });
});

test('shell log store clones caller-owned nested values before byte accounting', () => {
  const store = new ShellLogStore({ limit: 50, maxBytes: 10_000 });
  const details = { value: 'a' };
  const data = { nested: { value: 'b' } };
  store.append({ details, data });
  const bytesBefore = store.getStats().retained_bytes;

  details.value = 'x'.repeat(1_000);
  data.nested.value = 'y'.repeat(1_000);

  const stored = store.list()[0];
  assert.equal(stored.details.value, 'a');
  assert.equal(stored.data.nested.value, 'b');
  assert.equal(store.getStats().retained_bytes, bytesBefore);
});

test('shell log store evicts oldest entries when limit is exceeded', () => {
  const store = new ShellLogStore({ limit: 50 });

  for (let index = 0; index < 55; index += 1) {
    store.append({ event: `event.${index}` });
  }

  const entries = store.list();
  assert.equal(entries.length, 50);
  assert.equal(entries[0].event, 'event.5');
  assert.equal(entries[0].entry_id, 'log_6');
  assert.equal(entries.at(-1).event, 'event.54');
  assert.equal(entries.at(-1).entry_id, 'log_55');
  assert.equal(new Set(entries.map((entry) => entry.entry_id)).size, 50);
});

test('shell log store preserves WARN and ERROR evidence before DEBUG and INFO', () => {
  const store = new ShellLogStore({ limit: 50 });
  store.append({ level: 'ERROR', event: 'critical.first' });
  for (let index = 0; index < 49; index += 1) store.append({ level: 'INFO', event: `info.${index}` });
  store.append({ level: 'DEBUG', event: 'debug.latest' });
  const entries = store.list();
  assert.ok(entries.some((entry) => entry.event === 'critical.first'));
  assert.ok(!entries.some((entry) => entry.event === 'debug.latest'));
});
