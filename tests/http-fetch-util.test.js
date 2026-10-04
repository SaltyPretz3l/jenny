const test = require('node:test');
const assert = require('node:assert/strict');
const { requestWithTimeout, readBoundedResponseText } = require('../services/http-fetch-util');

test('HOM-09/MDL-13 request deadline covers stalled body reads and cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let cancelled = false;
  const pending = requestWithTimeout('https://example.test/body', {
    timeoutMs: 100,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { body: { getReader: () => ({ read: () => new Promise(() => {}),
        cancel: () => { cancelled = true; return new Promise(() => {}); }, releaseLock() {} }) } };
    },
    consumeResponse: (response, bodySignal) => readBoundedResponseText(response, { maxBytes: 10, signal: bodySignal }),
  });
  const rejection = assert.rejects(pending, /timed out/i);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(100);
  await rejection;
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test('HOM-09 bounded reader stops an oversized stream before reading its remainder', async () => {
  let reads = 0;
  let cancelled = false;
  const response = { body: { getReader: () => ({
    read: async () => { reads += 1; return { value: Buffer.from('123456'), done: false }; },
    cancel: async () => { cancelled = true; }, releaseLock() {},
  }) } };
  await assert.rejects(() => readBoundedResponseText(response, { maxBytes: 10 }), /size limit/i);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
});

test('HOM-09 bounded reader refuses a response that cannot be streamed', async () => {
  let readText = false;
  await assert.rejects(() => readBoundedResponseText({ text: async () => { readText = true; return 'unbounded'; } },
    { maxBytes: 10 }), /not readable/i);
  assert.equal(readText, false);
});
