const test = require('node:test');
const assert = require('node:assert/strict');

const { makeService } = require('./helpers/model-catalog-fixtures');

test('MDL-13 catalog refresh cancels a stalled body at its request deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let finish;
  let cancelled = false;
  const svc = makeService({ fetchImpl: async (_url, options) => {
    signal = options.signal;
    return { ok: true, body: { getReader: () => ({ read: () => new Promise((resolve) => { finish = resolve; }),
      cancel: async () => { cancelled = true; finish?.({ done: true }); }, releaseLock() {} }) } };
  } });
  const pending = svc.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(8000);
  await new Promise((resolve) => setImmediate(resolve));
  finish?.({ done: true });
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(svc.getCatalog().catalogVersion, 1);
});
