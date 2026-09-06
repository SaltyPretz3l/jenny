'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSettingsAdapter,
} = require('../renderer/shell/renderer-settings-persistence-adapters.js');

test('successful persistence is not rejected or rolled back when reconciliation apply throws', async () => {
  const calls = [];
  const logs = [];
  let persisted = null;
  const adapter = createSettingsAdapter({
    id: 'reconcile-fault',
    read: () => 1,
    write: (value) => {
      persisted = value;
      return 1000 + value;
    },
    getDefault: () => 0,
    apply: (value) => {
      calls.push(value);
      if (value === 1005) throw new Error('reconciliation paint failed');
    },
    log: (message) => logs.push(message),
  });

  const result = await adapter.write(5);

  assert.equal(result, 1005);
  assert.equal(persisted, 5);
  assert.deepEqual(calls, [5, 1005]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /reconciliation apply failed/);
  assert.doesNotMatch(logs[0], /write failed/);
});
