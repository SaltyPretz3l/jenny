'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  retryTransientRename,
} = require('../../../services/plugins/store/node-fs-facade');

test('retries bounded transient Windows rename failures before succeeding', async () => {
  const waits = [];
  const retries = [];
  let attempts = 0;
  const result = await retryTransientRename(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
      }
      return 'renamed';
    },
    {
      platform: 'win32',
      sleep: async (ms) => waits.push(ms),
      onRetry: (error, attempt, waitMs) => retries.push([error.code, attempt, waitMs]),
    }
  );

  assert.equal(result, 'renamed');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [25, 50]);
  assert.deepEqual(retries, [['EPERM', 1, 25], ['EPERM', 2, 50]]);
});

test('does not retry non-Windows or non-transient rename failures', async () => {
  let attempts = 0;
  const operation = async () => {
    attempts += 1;
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  };

  await assert.rejects(() => retryTransientRename(operation, { platform: 'win32' }), { code: 'ENOSPC' });
  assert.equal(attempts, 1);
});

test('propagates the final transient failure after the bounded retry window', async () => {
  let attempts = 0;
  const waits = [];
  const operation = async () => {
    attempts += 1;
    throw Object.assign(new Error(`locked-${attempts}`), { code: 'EBUSY' });
  };

  await assert.rejects(
    () => retryTransientRename(operation, {
      platform: 'win32',
      sleep: async (ms) => waits.push(ms),
    }),
    (error) => error?.code === 'EBUSY' && error.message === 'locked-5'
  );
  assert.equal(attempts, 5);
  assert.deepEqual(waits, [25, 50, 100, 200]);
});
