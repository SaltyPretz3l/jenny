'use strict';

// new-test-file: covers the new services/hf-resumable-download.js surface (row 140 S2a).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadPinnedHfFile, REASONS } = require('../services/hf-resumable-download');

const CHUNK = 4096;
const BYTES = crypto.randomBytes(CHUNK * 12 + 123);
const URL_OK = 'https://huggingface.co/owner/repo/resolve/abc123/mtp-model.gguf';
const CDN_URL = 'https://us.aws.cdn.hf.co/x';
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const plentyOfSpace = async () => ({ bavail: 1e9, bsize: 4096 });

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function headers(values) {
  const lower = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => lower[String(name).toLowerCase()] ?? null };
}

// A body that yields CHUNK-sized pieces; onChunk(offset, signal) may block to simulate a stall.
function body(buffer, signal, onChunk) {
  return {
    async* [Symbol.asyncIterator]() {
      for (let offset = 0; offset < buffer.length; offset += CHUNK) {
        if (signal?.aborted) throw abortError();
        await onChunk?.(offset, signal);
        if (signal?.aborted) throw abortError();
        yield buffer.subarray(offset, offset + CHUNK);
      }
    },
    cancel: async () => {},
  };
}

function untilAbort(signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener('abort', resolve, { once: true });
  });
}

// data: bytes the server holds; total: size claimed in Content-Range; omitLength drops Content-Length;
// lengthOverride replaces it; rangeMode 'ignore' answers a Range request with 200 and 'bad-start' with a shifted start.
function fakeFetch({ data = BYTES, total = data.length, location = CDN_URL, firstStatus = 302, getStatus = 200,
  rangeMode = 'honour', omitLength = false, lengthOverride = null, onChunk = null, hang = null } = {}) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, headers: { ...(options.headers || {}) }, redirect: options.redirect, signal: options.signal });
    const manual = options.redirect === 'manual';
    if (hang === (manual ? 'first' : 'second')) {
      await untilAbort(options.signal);
      throw abortError();
    }
    if (manual) {
      if (firstStatus !== 302) return { status: firstStatus, headers: headers({}), body: { cancel: async () => {} } };
      return { status: 302, headers: headers({ location }), body: { cancel: async () => {} } };
    }
    if (getStatus !== 200) return { ok: false, status: getStatus, headers: headers({}), body: { cancel: async () => {} } };
    const range = options.headers?.Range;
    if (range && rangeMode !== 'ignore') {
      const start = Number(/^bytes=(\d+)-$/.exec(range)[1]);
      const claimed = rangeMode === 'bad-start' ? start + 1 : start;
      const slice = data.subarray(start);
      const length = lengthOverride ?? slice.length;
      return { ok: true, status: 206,
        headers: headers({ ...(omitLength ? {} : { 'content-length': length }),
          'content-range': `bytes ${claimed}-${total - 1}/${total}` }),
        body: body(slice, options.signal, onChunk) };
    }
    return { ok: true, status: 200,
      headers: headers(omitLength ? {} : { 'content-length': lengthOverride ?? data.length }),
      body: body(data, options.signal, onChunk) };
  };
  return { fetchImpl, requests, gets: () => requests.filter((r) => r.redirect !== 'manual') };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-resumable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, partialPath: path.join(dir, 'model.gguf.part') };
}

function run(ctx, fetch, extra = {}) {
  return downloadPinnedHfFile({ url: URL_OK, partialPath: ctx.partialPath, bytes: BYTES.length, sha256: sha256(BYTES),
    fetchImpl: fetch.fetchImpl, statfsImpl: plentyOfSpace, responseStartTimeoutMs: 5_000, inactivityMs: 5_000,
    ...extra });
}

function assertFailed(result, reason) {
  assert.deepEqual(result, { ok: false, reason });
  assert.ok(REASONS.includes(reason), `${reason} is exported in REASONS`);
  assert.match(reason, /^[a-z][a-z0-9_]{0,79}$/);
}

const sizeOf = (file) => fs.statSync(file).size;

test('a fresh download streams, verifies and leaves the partial for the caller', async (t) => {
  const ctx = setup(t);
  const fetch = fakeFetch();
  const result = await run(ctx, fetch);
  assert.deepEqual(result, { ok: true, partialPath: ctx.partialPath, resumed: false });
  assert.ok(fs.readFileSync(ctx.partialPath).equals(BYTES));
  const [first, ...rest] = fetch.requests;
  assert.equal(first.url, URL_OK);
  assert.equal(first.redirect, 'manual');
  assert.equal(rest.length, 1);
  assert.equal(rest[0].url, CDN_URL);
  assert.equal(rest[0].redirect, 'error');
  assert.equal(rest[0].headers.Range, undefined);
});

test('a cancelled download keeps its partial and the next call resumes with a Range request', async (t) => {
  const ctx = setup(t);
  const controller = new AbortController();
  const stall = fakeFetch({ onChunk: (offset, signal) => {
    if (offset < CHUNK * 3) return null;
    controller.abort();
    return untilAbort(signal);
  } });
  assertFailed(await run(ctx, stall, { signal: controller.signal }), 'cancelled');
  assert.equal(sizeOf(ctx.partialPath), CHUNK * 3);
  assert.ok(fs.readFileSync(ctx.partialPath).equals(BYTES.subarray(0, CHUNK * 3)));

  const resume = fakeFetch();
  const progress = [];
  const result = await run(ctx, resume, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(result, { ok: true, partialPath: ctx.partialPath, resumed: true });
  assert.equal(resume.gets()[0].headers.Range, `bytes=${CHUNK * 3}-`);
  assert.ok(fs.readFileSync(ctx.partialPath).equals(BYTES));
  assert.ok(progress[0].receivedBytes > CHUNK * 3, 'progress counts the bytes already on disk');
});

test('a signal that is already aborted cancels before any request', async (t) => {
  const ctx = setup(t);
  const fetch = fakeFetch();
  assertFailed(await run(ctx, fetch, { signal: AbortSignal.abort() }), 'cancelled');
  assert.equal(fetch.requests.length, 0);
  assert.equal(fs.existsSync(ctx.partialPath), false);
});

test('a 200 answer to a Range request truncates the partial and starts over', async (t) => {
  const ctx = setup(t);
  fs.writeFileSync(ctx.partialPath, crypto.randomBytes(5000));
  const fetch = fakeFetch({ rangeMode: 'ignore' });
  const result = await run(ctx, fetch);
  assert.deepEqual(result, { ok: true, partialPath: ctx.partialPath, resumed: false });
  assert.equal(fetch.gets()[0].headers.Range, 'bytes=5000-');
  assert.ok(fs.readFileSync(ctx.partialPath).equals(BYTES));
});

test('a Content-Range that does not match the request is refused and the partial is kept', async (t) => {
  const ctx = setup(t);
  fs.writeFileSync(ctx.partialPath, BYTES.subarray(0, CHUNK));
  assertFailed(await run(ctx, fakeFetch({ rangeMode: 'bad-start' })), 'content_range_mismatch');
  assert.ok(fs.readFileSync(ctx.partialPath).equals(BYTES.subarray(0, CHUNK)));
  const wrongTotal = fakeFetch({ total: BYTES.length + 1 });
  assertFailed(await run(ctx, wrongTotal), 'content_range_mismatch');
  assert.equal(sizeOf(ctx.partialPath), CHUNK);
});

test('a Content-Length that differs from the remaining bytes fails before anything is written', async (t) => {
  const ctx = setup(t);
  assertFailed(await run(ctx, fakeFetch({ lengthOverride: BYTES.length + 1 })), 'size_mismatch');
  assert.equal(fs.existsSync(ctx.partialPath), false);
  fs.writeFileSync(ctx.partialPath, BYTES.subarray(0, CHUNK));
  assertFailed(await run(ctx, fakeFetch({ lengthOverride: 10 })), 'size_mismatch');
  assert.equal(sizeOf(ctx.partialPath), CHUNK);
});

test('a body longer than the pin aborts and the partial goes back to its earlier size', async (t) => {
  const ctx = setup(t);
  fs.writeFileSync(ctx.partialPath, BYTES.subarray(0, CHUNK));
  const longer = Buffer.concat([BYTES, crypto.randomBytes(CHUNK)]);
  const fetch = fakeFetch({ data: longer, total: BYTES.length, omitLength: true });
  assertFailed(await run(ctx, fetch), 'byte_overflow');
  assert.ok(fs.readFileSync(ctx.partialPath).equals(BYTES.subarray(0, CHUNK)));
  assert.equal(fetch.gets()[0].signal.aborted, true);
});

test('a body shorter than the pin is a size mismatch and the partial is kept', async (t) => {
  const ctx = setup(t);
  const short = BYTES.subarray(0, BYTES.length - 100);
  assertFailed(await run(ctx, fakeFetch({ data: short, omitLength: true })), 'size_mismatch');
  assert.equal(sizeOf(ctx.partialPath), short.length);
});

test('a wrong digest deletes the partial', async (t) => {
  const ctx = setup(t);
  assertFailed(await run(ctx, fakeFetch(), { sha256: sha256(Buffer.from('other')) }), 'sha256_mismatch');
  assert.equal(fs.existsSync(ctx.partialPath), false);
});

test('a complete, correct partial is verified without any request', async (t) => {
  const ctx = setup(t);
  fs.writeFileSync(ctx.partialPath, BYTES);
  const fetch = fakeFetch();
  const calls = [];
  const result = await run(ctx, fetch, { onProgress: (p) => calls.push(p) });
  assert.deepEqual(result, { ok: true, partialPath: ctx.partialPath, resumed: true });
  assert.equal(fetch.requests.length, 0);
  assert.deepEqual(calls.at(-1), { receivedBytes: BYTES.length, totalBytes: BYTES.length });
  fs.writeFileSync(ctx.partialPath, Buffer.alloc(BYTES.length));
  assertFailed(await run(ctx, fetch), 'sha256_mismatch');
  assert.equal(fetch.requests.length, 0);
  assert.equal(fs.existsSync(ctx.partialPath), false);
});

test('a partial larger than the pin is truncated and the download starts over', async (t) => {
  const ctx = setup(t);
  fs.writeFileSync(ctx.partialPath, Buffer.concat([BYTES, Buffer.from('extra')]));
  const fetch = fakeFetch();
  const result = await run(ctx, fetch);
  assert.deepEqual(result, { ok: true, partialPath: ctx.partialPath, resumed: false });
  assert.equal(fetch.gets()[0].headers.Range, undefined);
  assert.ok(fs.readFileSync(ctx.partialPath).equals(BYTES));
});

test('a partial path that is a directory or a symlink is rejected and nothing is written', async (t) => {
  const ctx = setup(t);
  const fetch = fakeFetch();
  fs.mkdirSync(ctx.partialPath);
  assertFailed(await run(ctx, fetch), 'partial_rejected');
  assert.deepEqual(fs.readdirSync(ctx.partialPath), []);
  fs.rmdirSync(ctx.partialPath);

  const target = path.join(ctx.dir, 'target.bin');
  fs.writeFileSync(target, 'keep');
  try {
    fs.symlinkSync(target, ctx.partialPath);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    t.diagnostic('symlink creation not permitted here; directory case covered above');
    assert.equal(fetch.requests.length, 0);
    return;
  }
  assertFailed(await run(ctx, fetch), 'partial_rejected');
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  assert.equal(fetch.requests.length, 0);
});

test('a redirect to a foreign host or to http is refused', async (t) => {
  const ctx = setup(t);
  const foreign = fakeFetch({ location: 'https://evil.example.com/x' });
  assertFailed(await run(ctx, foreign), 'redirect_host_rejected');
  const plain = fakeFetch({ location: 'http://us.aws.cdn.hf.co/x' });
  assertFailed(await run(ctx, plain), 'redirect_scheme_rejected');
  const credentials = fakeFetch({ location: 'https://user:pw@us.aws.cdn.hf.co/x' });
  assertFailed(await run(ctx, credentials), 'redirect_host_rejected');
  for (const fetch of [foreign, plain, credentials]) assert.equal(fetch.gets().length, 0);
  assert.equal(fs.existsSync(ctx.partialPath), false);
});

test('gated and missing files map to hf_gated and not_found on either hop', async (t) => {
  const ctx = setup(t);
  for (const [status, reason] of [[401, 'hf_gated'], [403, 'hf_gated'], [404, 'not_found'], [500, 'download_failed']]) {
    assertFailed(await run(ctx, fakeFetch({ firstStatus: status })), reason);
    assertFailed(await run(ctx, fakeFetch({ getStatus: status })), reason);
  }
  assert.equal(fs.existsSync(ctx.partialPath), false);
});

test('too little free space fails before any request', async (t) => {
  const ctx = setup(t);
  const fetch = fakeFetch();
  const needed = BYTES.length + 1000;
  const result = await run(ctx, fetch, { headroomBytes: 1000, statfsImpl: async () => ({ bavail: needed - 1, bsize: 1 }) });
  assertFailed(result, 'insufficient_space');
  assert.equal(fetch.requests.length, 0);
  fs.writeFileSync(ctx.partialPath, BYTES.subarray(0, CHUNK));
  const resumed = await run(ctx, fetch, { headroomBytes: 1000,
    statfsImpl: async () => ({ bavail: needed - CHUNK, bsize: 1 }) });
  assert.equal(resumed.ok, true, 'a resume only needs the remaining bytes');
});

test('a server that never answers hits the response-start timeout on either hop', async (t) => {
  const ctx = setup(t);
  for (const hang of ['first', 'second']) {
    const fetch = fakeFetch({ hang });
    assertFailed(await run(ctx, fetch, { responseStartTimeoutMs: 20 }), 'response_timeout');
    assert.equal(fetch.requests.at(-1).signal.aborted, true);
  }
});

test('a stalled body hits the inactivity timeout and the partial is kept', async (t) => {
  const ctx = setup(t);
  const fetch = fakeFetch({ onChunk: (offset, signal) => (offset < CHUNK * 2 ? null : untilAbort(signal)) });
  assertFailed(await run(ctx, fetch, { inactivityMs: 30 }), 'download_inactivity');
  assert.equal(sizeOf(ctx.partialPath), CHUNK * 2);
});

test('a body that ignores the abort still stops on cancel', async (t) => {
  const ctx = setup(t);
  const controller = new AbortController();
  const fetch = fakeFetch({ onChunk: (offset) => {
    if (offset < CHUNK) return null;
    controller.abort();
    return new Promise(() => {});
  } });
  assertFailed(await run(ctx, fetch, { signal: controller.signal }), 'cancelled');
  assert.equal(sizeOf(ctx.partialPath), CHUNK);
});

test('a url off huggingface.co, or a bad pin, is rejected before touching disk or network', async (t) => {
  const ctx = setup(t);
  const fetch = fakeFetch();
  const urls = ['https://example.com/owner/repo/resolve/main/f.gguf', 'http://huggingface.co/o/r/resolve/main/f.gguf',
    'https://user:pw@huggingface.co/o/r/resolve/main/f.gguf', 'https://huggingface.co:8443/o/r/resolve/main/f.gguf',
    'https://huggingface.co/o/r/blob/main/f.gguf', 'https://cdn.huggingface.co/o/r/resolve/main/f.gguf', 'not a url', ''];
  for (const url of urls) assertFailed(await run(ctx, fetch, { url }), 'url_rejected');
  for (const pin of [{ bytes: 0 }, { bytes: 1.5 }, { bytes: '10' }, { sha256: 'ABC' }, { sha256: sha256(BYTES).toUpperCase() }]) {
    assertFailed(await run(ctx, fetch, pin), 'invalid_pin');
  }
  assert.equal(fetch.requests.length, 0);
  assert.equal(fs.existsSync(ctx.partialPath), false);
});

test('progress is throttled by the clock and reported once more at the end', async (t) => {
  const ctx = setup(t);
  let clock = 0;
  const calls = [];
  const result = await run(ctx, fakeFetch(), { now: () => (clock += 100), progressIntervalMs: 250,
    onProgress: (p) => calls.push(p) });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((p) => p.receivedBytes), [CHUNK, CHUNK * 4, CHUNK * 7, CHUNK * 10, BYTES.length]);
  for (const call of calls) assert.equal(call.totalBytes, BYTES.length);
});

test('a throwing progress callback does not fail the download', async (t) => {
  const ctx = setup(t);
  const result = await run(ctx, fakeFetch(), { onProgress: () => { throw new Error('ui gone'); } });
  assert.equal(result.ok, true);
});

test('the caller\'s last folder check runs once the reply starts, before the partial opens', async (t) => {
  const ctx = setup(t);
  const fetch = fakeFetch();
  let checks = 0;
  const refused = await run(ctx, fetch, {
    beforeOpen: () => { checks += 1; throw Object.assign(new Error('swapped'), { reason: 'folder_rejected' }); },
  });
  assert.deepEqual(refused, { ok: false, reason: 'folder_rejected' }, 'the caller\'s reason code passes through');
  assert.equal(checks, 1);
  assert.equal(fetch.gets().length, 1, 'checked after the request answered');
  assert.equal(fs.existsSync(ctx.partialPath), false, 'nothing opened');
  assert.deepEqual(await run(ctx, fetch, { beforeOpen: () => { throw new Error('no code'); } }),
    { ok: false, reason: 'partial_rejected' });
  assert.equal((await run(ctx, fetch, { beforeOpen: () => {} })).ok, true);
});
