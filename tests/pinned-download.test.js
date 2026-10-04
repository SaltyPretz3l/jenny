'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { getEventListeners } = require('node:events');
const { Writable } = require('node:stream');
const { downloadPinnedFile } = require('../services/pinned-download');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, { chunks = [Buffer.from('x')], stall = 'drain', inactivityMs = 5000 } = {}) {
  const blocked = deferred();
  const counts = [];
  let release;
  let cancelled = false;
  const controller = new AbortController();
  const out = new Writable({
    highWaterMark: stall === 'finish' ? 1024 : 1,
    write(_chunk, _encoding, callback) {
      if (stall === 'drain') {
        release = callback;
        setImmediate(blocked.resolve);
      } else {
        setImmediate(() => {
          counts.push(out.listenerCount('error'));
          callback();
        });
      }
    },
    final(callback) {
      if (stall === 'finish') {
        release = callback;
        setImmediate(blocked.resolve);
      } else callback();
    },
  });
  // Keep a stream-owned error handler to check that downloader cleanup preserves it.
  out.on('error', () => {});
  const baseline = Object.fromEntries(['drain', 'finish', 'error', 'close'].map(
    (event) => [event, out.listenerCount(event)]
  ));
  const bytes = Buffer.concat(chunks);
  const operation = downloadPinnedFile({
    url: 'https://example.invalid/artifact',
    destPath: 'unused-artifact',
    expectedBytes: bytes.length,
    fetchImpl: async (_url, options) => {
      assert.equal(options.signal, controller.signal);
      return {
        ok: true,
        headers: { get: () => String(bytes.length) },
        body: (async function* () { yield* chunks; })(),
      };
    },
    fsImpl: { createWriteStream: (_path, options) => {
      assert.equal(options.flags, 'wx');
      return out;
    } },
    abortController: controller,
    responseStartTimeoutMs: 5000,
    inactivityMs,
    isCancelled: () => cancelled,
  });
  const outcome = operation.then(
    (digest) => ({ status: 'completed', digest }),
    (error) => ({ status: 'rejected', error })
  );
  t.after(async () => {
    // Release an unfixed wait after a red assertion so the test leaves no pending work.
    if (release) release(new Error('test cleanup'));
    out.emit('error', new Error('test cleanup'));
    out.destroy();
    await outcome;
  });
  return {
    out, counts, baseline, controller, blocked: blocked.promise, outcome, bytes,
    cancel() { cancelled = true; controller.abort(); },
    release(error) { release(error); },
  };
}

async function promptly(outcome) {
  let timer;
  try {
    const result = await Promise.race([
      outcome,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'pending' }), 1000); }),
    ]);
    assert.notEqual(result.status, 'pending', 'download must settle within 1 s');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function assertClean(c) {
  // Let stream destruction/close finish before checking stream-owned listeners.
  await new Promise((resolve) => setImmediate(resolve));
  for (const [event, count] of Object.entries(c.baseline)) {
    assert.equal(c.out.listenerCount(event), count, `${event} listeners must return to baseline`);
  }
  assert.equal(getEventListeners(c.controller.signal, 'abort').length, 0);
}

test('50 drain cycles keep error listeners constant and restore the baseline', async (t) => {
  const c = fixture(t, { stall: null, chunks: Array.from({ length: 50 }, () => Buffer.from('x')) });
  const result = await promptly(c.outcome);
  assert.equal(result.status, 'completed');
  assert.equal(result.digest, crypto.createHash('sha256').update(c.bytes).digest('hex'));
  assert.equal(c.counts.length, 50);
  assert.ok(c.counts.every((count) => count === c.counts[0]),
    `error listeners must stay constant across drain cycles: ${c.counts.join(',')}`);
  await assertClean(c);
});

for (const stall of ['drain', 'finish']) {
  test(`user cancellation interrupts a stalled ${stall}`, async (t) => {
    const c = fixture(t, { stall });
    await c.blocked;
    c.cancel();
    const result = await promptly(c.outcome);
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'cancelled');
    assert.equal(result.error.message, 'The download stopped.');
    assert.equal(c.out.destroyed, true);
    await assertClean(c);
  });

  test(`inactivity timeout interrupts a stalled ${stall}`, async (t) => {
    const c = fixture(t, { stall, inactivityMs: 30 });
    await c.blocked;
    const result = await promptly(c.outcome);
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'download_inactivity');
    assert.equal(result.error.message, 'The download stalled.');
    assert.equal(c.out.destroyed, true);
    await assertClean(c);
  });

  test(`close interrupts a stalled ${stall}`, async (t) => {
    const c = fixture(t, { stall });
    await c.blocked;
    c.out.destroy();
    const result = await promptly(c.outcome);
    assert.equal(result.status, 'rejected');
    assert.equal(c.out.destroyed, true);
    await assertClean(c);
  });
}

test('write error interrupts drain and restores listeners', async (t) => {
  const c = fixture(t);
  await c.blocked;
  const error = new Error('disk failure');
  c.release(error);
  const result = await promptly(c.outcome);
  assert.equal(result.status, 'rejected');
  assert.equal(result.error, error);
  assert.equal(c.out.destroyed, true);
  await assertClean(c);
});

for (const order of [
  ['error', 'abort', 'finish'],
  ['abort', 'finish', 'error'],
  ['finish', 'error', 'abort'],
]) {
  test(`final settlement is idempotent across ${order.join(', ')}`, async (t) => {
    const c = fixture(t, { stall: 'finish' });
    await c.blocked;
    const error = new Error('racing disk failure');
    for (const event of order) {
      if (event === 'abort') c.cancel();
      else c.out.emit(event, event === 'error' ? error : undefined);
    }
    const result = await promptly(c.outcome);
    if (order[0] === 'finish') assert.equal(result.status, 'completed');
    else {
      assert.equal(result.status, 'rejected');
      if (order[0] === 'error') assert.equal(result.error, error);
      else assert.equal(result.error.code, 'cancelled');
      assert.equal(c.out.destroyed, true);
    }
    await assertClean(c);
  });
}
