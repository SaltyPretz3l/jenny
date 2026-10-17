'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  NinferArtifactDownloadService,
  resolveHuggingFaceAssetUrl,
} = require('../services/ninfer-artifact-download');

const CHUNK = 4096;
const BYTES = crypto.randomBytes(CHUNK * 12 + 123);
const CDN_URL = 'https://us.aws.cdn.hf.co/x';
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function pinFor(bytes, overrides = {}) {
  return Object.freeze({
    id: 'test-model', display_name: 'Test model', repo: 'owner/repo', revision: 'main',
    file: 'test_model.ninfer', size_bytes: bytes.length, sha256: sha256(bytes), model_id: 'test-model',
    format_version: 3, supports_mtp: false, context_windows: [4096], default_context_window: 4096,
    url: 'https://huggingface.co/owner/repo/resolve/main/test_model.ninfer', ...overrides,
  });
}

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function headers(values) {
  const lower = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => lower[String(name).toLowerCase()] ?? null };
}

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

// rangeMode: 'honour' answers 206, 'ignore' answers 200, 'bad-start' answers 206 with a wrong start.
function fakeFetch({ data = BYTES, location = CDN_URL, rangeMode = 'honour', onChunk = null } = {}) {
  const requests = [];
  let probeBodiesCancelled = 0;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, headers: { ...(options.headers || {}) }, redirect: options.redirect, signal: options.signal });
    if (options.redirect === 'manual') {
      return { status: 302, headers: headers({ location, 'x-linked-size': data.length }),
        body: { cancel: async () => { probeBodiesCancelled += 1; } } };
    }
    const range = options.headers?.Range;
    if (range && rangeMode !== 'ignore') {
      const start = Number(/^bytes=(\d+)-$/.exec(range)[1]);
      const claimed = rangeMode === 'bad-start' ? start + 1 : start;
      return { ok: true, status: 206, headers: headers({ 'content-length': data.length - start,
        'content-range': `bytes ${claimed}-${data.length - 1}/${data.length}`, 'accept-ranges': 'bytes' }),
      body: body(data.subarray(start), options.signal, null) };
    }
    return { ok: true, status: 200, headers: headers({ 'content-length': data.length }),
      body: body(data, options.signal, onChunk) };
  };
  return { fetchImpl, requests, probes: () => requests.filter((r) => r.redirect === 'manual'),
    gets: () => requests.filter((r) => r.redirect !== 'manual'), cancelledProbes: () => probeBodiesCancelled };
}

function setup(t, { artifacts = [pinFor(BYTES)], fetch = fakeFetch(), statfsImpl, platform } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ninfer-artifact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 0;
  const service = new NinferArtifactDownloadService({ userDataPath: dir, artifacts, fetchImpl: fetch.fetchImpl,
    statfsImpl: statfsImpl || (async () => ({ bavail: 1e9, bsize: 4096 })), now: () => (clock += 100),
    responseStartTimeoutMs: 5_000, inactivityMs: 5_000, ...(platform ? { platform } : {}) });
  t.after(() => service.dispose());
  const states = [];
  service.on('changed', (state) => states.push(state));
  const models = path.join(dir, 'engines', 'ninfer', 'models');
  const finalPath = path.join(models, 'test_model.ninfer');
  return { dir, service, fetch, states, models, finalPath, partialPath: `${finalPath}.part` };
}

test('a full download verifies, publishes and removes the partial', async (t) => {
  const ctx = setup(t);
  const result = await ctx.service.download({ id: 'test-model', confirmed: true });
  assert.deepEqual(result, { ok: true });
  assert.ok(fs.readFileSync(ctx.finalPath).equals(BYTES));
  assert.equal(fs.existsSync(ctx.partialPath), false);
  assert.equal(ctx.fetch.probes().length, 1);
  assert.equal(ctx.fetch.probes()[0].url, pinFor(BYTES).url);
  assert.equal(ctx.fetch.cancelledProbes(), 1);
  const [get] = ctx.fetch.gets();
  assert.equal(ctx.fetch.gets().length, 1);
  assert.equal(get.url, CDN_URL);
  assert.equal(get.redirect, 'error');
  assert.equal(get.headers.Range, undefined);
  assert.ok(get.signal instanceof AbortSignal);
  assert.equal(ctx.service.getState().status, 'idle');
  assert.deepEqual(await ctx.service.download({ id: 'test-model', confirmed: true }), { ok: true, already: true });
  assert.equal(ctx.fetch.requests.length, 2);
});

test('cancel keeps the partial and the next download resumes with a Range request', async (t) => {
  let reached;
  const reachedPromise = new Promise((resolve) => { reached = resolve; });
  const fetch = fakeFetch({ onChunk: (offset, signal) => {
    if (offset < CHUNK * 3) return null;
    reached();
    return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  } });
  const ctx = setup(t, { fetch });
  const logs = [];
  ctx.service.logger = (...entry) => logs.push(entry);
  const pending = ctx.service.download({ id: 'test-model', confirmed: true });
  await reachedPromise;
  assert.equal(ctx.service.getState().status, 'downloading');
  assert.deepEqual(await ctx.service.cancel(), { ok: true });
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' });
  // Gate 2026-10-14: a cancel logged a WARN download_failed that Diagnostics flagged.
  assert.deepEqual(logs.filter(([level]) => level === 'warn'), []);
  assert.ok(logs.some(([level, event]) => level === 'info' && event === 'ninfer_artifact.download_cancelled'));
  assert.equal(fs.statSync(ctx.partialPath).size, CHUNK * 3);
  assert.equal(fs.existsSync(ctx.finalPath), false);
  const cancelledState = ctx.service.getState();
  assert.equal(cancelledState.status, 'idle');
  assert.equal(cancelledState.last_error, 'cancelled');
  assert.equal(cancelledState.download.done, CHUNK * 3);
  assert.deepEqual(await ctx.service.cancel(), { ok: false, reason: 'idle' });

  const result = await ctx.service.download({ id: 'test-model', confirmed: true });
  assert.deepEqual(result, { ok: true });
  assert.equal(ctx.fetch.probes().length, 2, 'each (re)start re-resolves the signed URL');
  const resumed = ctx.fetch.gets()[1];
  assert.equal(resumed.headers.Range, `bytes=${CHUNK * 3}-`);
  assert.equal(sha256(fs.readFileSync(ctx.finalPath)), pinFor(BYTES).sha256);
  assert.equal(fs.existsSync(ctx.partialPath), false);
  const resumeStart = ctx.states.find((state) => state.download?.resumed_from === CHUNK * 3);
  assert.ok(resumeStart, 'the resumed download reports where it resumed from');
  const dones = ctx.states.filter((state) => state.download && state.download.resumed_from === CHUNK * 3)
    .map((state) => state.download.done);
  assert.deepEqual(dones, [...dones].sort((a, b) => a - b), 'progress is monotonic');
  for (const state of [...ctx.states, ctx.service.getState()]) {
    const text = JSON.stringify(state);
    assert.equal(text.includes(ctx.dir), false);
    assert.equal(text.includes(JSON.stringify(ctx.dir).slice(1, -1)), false);
  }
});

test('a 200 reply to a Range request restarts the partial from zero', async (t) => {
  const ctx = setup(t, { fetch: fakeFetch({ rangeMode: 'ignore' }) });
  fs.mkdirSync(ctx.models, { recursive: true });
  fs.writeFileSync(ctx.partialPath, crypto.randomBytes(5000));
  const result = await ctx.service.download({ id: 'test-model', confirmed: true });
  assert.deepEqual(result, { ok: true });
  assert.equal(ctx.fetch.gets()[0].headers.Range, 'bytes=5000-');
  assert.ok(fs.readFileSync(ctx.finalPath).equals(BYTES));
});

test('a 206 whose Content-Range start disagrees fails and keeps the partial', async (t) => {
  const ctx = setup(t, { fetch: fakeFetch({ rangeMode: 'bad-start' }) });
  fs.mkdirSync(ctx.models, { recursive: true });
  fs.writeFileSync(ctx.partialPath, BYTES.subarray(0, 5000));
  const result = await ctx.service.download({ id: 'test-model', confirmed: true });
  assert.deepEqual(result, { ok: false, reason: 'download_failed' });
  assert.equal(fs.statSync(ctx.partialPath).size, 5000);
  assert.equal(fs.existsSync(ctx.finalPath), false);
  assert.equal(ctx.service.getState().last_error, 'download_failed');
});

test('a digest mismatch deletes the partial and publishes nothing', async (t) => {
  const ctx = setup(t, { artifacts: [pinFor(BYTES, { sha256: sha256(Buffer.from('other')) })] });
  const result = await ctx.service.download({ id: 'test-model', confirmed: true });
  assert.deepEqual(result, { ok: false, reason: 'digest_mismatch' });
  assert.equal(fs.existsSync(ctx.partialPath), false);
  assert.equal(fs.existsSync(ctx.finalPath), false);
});

test('the free-disk precheck refuses before anything is requested or written', async (t) => {
  const ctx = setup(t, { statfsImpl: async () => ({ bavail: 1, bsize: 4096 }) });
  const result = await ctx.service.download({ id: 'test-model', confirmed: true });
  assert.deepEqual(result, { ok: false, reason: 'ninfer_disk_space',
    needed_bytes: BYTES.length + 64 * 1024 * 1024, free_bytes: 4096 });
  assert.equal(ctx.fetch.requests.length, 0);
  assert.equal(fs.existsSync(ctx.partialPath), false);
  assert.equal(fs.existsSync(ctx.finalPath), false);
});

test('a statfs failure does not refuse the download', async (t) => {
  const ctx = setup(t, { statfsImpl: async () => { throw Object.assign(new Error('nope'), { code: 'ENOSYS' }); } });
  assert.deepEqual(await ctx.service.download({ id: 'test-model', confirmed: true }), { ok: true });
  assert.ok(fs.readFileSync(ctx.finalPath).equals(BYTES));
});

test('redirects off Hugging Face or off https are refused without a download request', async (t) => {
  for (const [location, reason] of [['https://evil-hf.co/x', 'redirect_host_rejected'],
    ['http://cdn-lfs.hf.co/x', 'redirect_scheme_rejected'],
    ['https://user:pw@cdn-lfs.hf.co/x', 'redirect_host_rejected']]) {
    const ctx = setup(t, { fetch: fakeFetch({ location }) });
    assert.deepEqual(await ctx.service.download({ id: 'test-model', confirmed: true }), { ok: false, reason });
    assert.equal(ctx.fetch.gets().length, 0);
    assert.equal(ctx.fetch.cancelledProbes(), 1);
    assert.equal(fs.existsSync(ctx.partialPath), false);
  }
  const fetch = fakeFetch();
  assert.deepEqual(await resolveHuggingFaceAssetUrl(pinFor(BYTES).url, { fetchImpl: fetch.fetchImpl }),
    { ok: true, url: CDN_URL });
});

test('opt-in, unknown ids and busy are refused; remove deletes only that artifact', async (t) => {
  const ctx = setup(t);
  assert.deepEqual(await ctx.service.download({ id: 'test-model' }), { ok: false, reason: 'opt_in_required' });
  assert.deepEqual(await ctx.service.remove({ id: 'test-model' }), { ok: false, reason: 'opt_in_required' });
  assert.deepEqual(await ctx.service.download({ id: 'nope', confirmed: true }), { ok: false, reason: 'unknown_artifact' });
  assert.equal(ctx.fetch.requests.length, 0);
  const pending = ctx.service.download({ id: 'test-model', confirmed: true });
  assert.deepEqual(await ctx.service.download({ id: 'test-model', confirmed: true }), { ok: false, reason: 'busy' });
  assert.deepEqual(await pending, { ok: true });
  const other = path.join(ctx.models, 'keep.ninfer');
  fs.writeFileSync(other, 'x');
  fs.writeFileSync(ctx.partialPath, 'x');
  assert.deepEqual(await ctx.service.remove({ id: 'test-model', confirmed: true }), { ok: true });
  assert.equal(fs.existsSync(ctx.finalPath), false);
  assert.equal(fs.existsSync(ctx.partialPath), false);
  assert.equal(fs.existsSync(other), true);
});

test('discover lists managed and library .ninfer files without following links', async (t) => {
  const ctx = setup(t);
  fs.mkdirSync(ctx.models, { recursive: true });
  fs.writeFileSync(ctx.finalPath, BYTES);
  fs.writeFileSync(`${ctx.finalPath}.part`, 'partial');
  const library = path.join(ctx.dir, 'library');
  const nested = path.join(library, 'nested');
  const deep = path.join(nested, 'deeper');
  const outside = path.join(ctx.dir, 'outside');
  fs.mkdirSync(deep, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(library, 'test_model.ninfer'), Buffer.alloc(100));
  fs.writeFileSync(path.join(nested, 'foo.NINFER'), 'foo');
  fs.writeFileSync(path.join(nested, 'bar.ninfer.part'), 'bar');
  fs.writeFileSync(path.join(deep, 'too-deep.ninfer'), 'deep');
  fs.writeFileSync(path.join(outside, 'linked.ninfer'), 'linked');
  fs.symlinkSync(outside, path.join(library, 'link'), 'junction');

  const { entries } = await ctx.service.discover({ libraryRoots: [library, library] });
  const byFile = Object.fromEntries(entries.map((entry) => [`${entry.source}:${entry.file}`, entry]));
  assert.deepEqual(Object.keys(byFile).sort(),
    ['library:foo.NINFER', 'library:test_model.ninfer', 'managed:test_model.ninfer']);
  assert.deepEqual(byFile['managed:test_model.ninfer'], { id: 'test-model', file: 'test_model.ninfer',
    size_bytes: BYTES.length, path: ctx.finalPath, source: 'managed', recognised: true, complete: true });
  assert.equal(byFile['library:test_model.ninfer'].recognised, false);
  assert.equal(byFile['library:test_model.ninfer'].complete, false);
  assert.equal(byFile['library:test_model.ninfer'].id, null);
  assert.equal(byFile['library:foo.NINFER'].id, null);
  assert.equal(byFile['library:foo.NINFER'].recognised, false);
});

test('a cancel that lands after the last hashed chunk publishes nothing', async (t) => {
  const ctx = setup(t);
  const original = ctx.service._hashFile.bind(ctx.service);
  ctx.service._hashFile = async (file, op) => {
    const digest = await original(file, op);
    op.cancelled = true;
    return digest;
  };
  assert.deepEqual(await ctx.service.download({ id: 'test-model', confirmed: true }), { ok: false, reason: 'cancelled' });
  assert.equal(fs.existsSync(ctx.finalPath), false);
  assert.equal(fs.statSync(ctx.partialPath).size, BYTES.length);
});

test('remove holds the operation lock so a download cannot start beside it', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fsImpl = { ...fs, promises: { ...fs.promises, rm: async (...args) => { await gate; return fs.promises.rm(...args); } } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ninfer-artifact-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = new NinferArtifactDownloadService({ userDataPath: dir, artifacts: [pinFor(BYTES)],
    fetchImpl: fakeFetch().fetchImpl, fsImpl, statfsImpl: async () => ({ bavail: 1e9, bsize: 4096 }) });
  t.after(() => service.dispose());
  const removal = service.remove({ id: 'test-model', confirmed: true });
  assert.deepEqual(await service.download({ id: 'test-model', confirmed: true }), { ok: false, reason: 'busy' });
  assert.deepEqual(await service.remove({ id: 'test-model', confirmed: true }), { ok: false, reason: 'busy' });
  release();
  assert.deepEqual(await removal, { ok: true });
  assert.deepEqual(await service.download({ id: 'test-model', confirmed: true }), { ok: true });
});

test('discover skips a library root that is itself a link or junction', async (t) => {
  const logs = [];
  const ctx = setup(t);
  ctx.service.logger = (level, event, fields) => logs.push({ level, event, fields });
  const outside = path.join(ctx.dir, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'linked.ninfer'), 'linked');
  const linkRoot = path.join(ctx.dir, 'link-root');
  fs.symlinkSync(outside, linkRoot, 'junction');
  const { entries } = await ctx.service.discover({ libraryRoots: [linkRoot, path.join(ctx.dir, 'missing')] });
  assert.deepEqual(entries, []);
  const skipped = logs.filter((entry) => entry.event === 'ninfer_artifact.discover_root_skipped');
  assert.deepEqual(skipped.map((entry) => entry.fields.reason), ['root_not_plain_directory', 'root_not_plain_directory']);
});

test('discover skips a UNC library root on win32', async (t) => {
  const logs = [];
  const ctx = setup(t, { platform: 'win32' });
  ctx.service.logger = (level, event, fields) => logs.push({ level, event, fields });
  const { entries } = await ctx.service.discover({ libraryRoots: ['\\\\host\\share', '//host/share'] });
  assert.deepEqual(entries, []);
  assert.equal(logs.filter((entry) => entry.event === 'ninfer_artifact.discover_root_skipped').length, 2);
  assert.equal(JSON.stringify(logs).includes('host'), false);
});
