'use strict';

// new-test-file: row 142 S3 runtime download surface
// (services/llama-server-runtime-download.js and its zip extractor). The
// download runs against a fake fetch that serves zips built here, a fake
// statfs and probe, and a temp userData folder.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');

const { createLlamaServerRuntimeDownload } = require('../services/llama-server-runtime-download');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const PREFIX = 'https://github.com/ggml-org/llama.cpp/releases/download/b12098/';
const FOLDER = 'b12098-win-x64-cpu';

// ---- a small zip writer: stored or deflated entries, optional unix mode ----
function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; }
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data ?? '');
    const body = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const crc = zlib.crc32(raw);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(33), u32(crc), u32(body.length), u32(raw.length),
      u16(name.length), u16(0), name, body,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(entry.madeBy ?? 20), u16(20), u16(0), u16(method), u16(0), u16(33), u32(crc),
      u32(body.length), u32(raw.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(entry.attrs ?? 0), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals, directory,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(directory.length), u32(offset), u16(0),
  ]);
}
const goodZip = (extra = []) => makeZip([
  { name: 'llama-server.exe', data: Buffer.alloc(2048, 7) },
  { name: 'llama.dll', data: Buffer.alloc(4096, 9), deflate: true },
  { name: 'bin/', data: '' },
  { name: 'bin/ggml.dll', data: 'ggml' },
  ...extra,
]);
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// ---- fake network: serves buffers by URL, honours Range, records requests ----
function fakeNetwork(files) {
  const calls = [];
  const state = { stallAfter: null, redirect: null };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, headers: { ...(options.headers || {}) }, redirect: options.redirect });
    if (state.redirect && url.startsWith(PREFIX)) {
      const target = state.redirect;
      return { status: 302, headers: { get: (name) => (name === 'location' ? target : null) }, body: null };
    }
    const name = url.slice(url.lastIndexOf('/') + 1);
    const buffer = files.get(name) || (url === state.redirect ? files.values().next().value : null);
    if (!buffer) return { status: 404, headers: { get: () => null }, body: null };
    const range = /^bytes=(\d+)-$/.exec(options.headers?.Range || '');
    const start = range ? Number(range[1]) : 0;
    const slice = buffer.subarray(start);
    const headers = {
      'content-length': String(slice.length),
      ...(range ? { 'content-range': `bytes ${start}-${buffer.length - 1}/${buffer.length}` } : {}),
    };
    const stall = state.stallAfter;
    state.stallAfter = null;
    async function* body() {
      if (stall !== null) {
        yield slice.subarray(0, stall);
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
        return;
      }
      for (let at = 0; at < slice.length; at += 1024) yield slice.subarray(at, at + 1024);
    }
    const fixed = stall !== null ? { ...headers, 'content-length': String(slice.length) } : headers;
    return { status: range ? 206 : 200, headers: { get: (key) => fixed[key.toLowerCase()] ?? null }, body: body() };
  };
  return { fetchImpl, calls, state };
}

function catalogFor(zips, { release = 'b12098', build = 12098, architectures = ['lfm2', 'lfm3'] } = {}) {
  const asset = ([name, buffer]) => ({ name, size: buffer.length, sha256: sha(buffer) });
  const entries = [...zips.entries()];
  return {
    schema_version: 1,
    release,
    build,
    checkedOn: '2026-11-13',
    architectures,
    variants: {
      'win-x64-cuda-13.4': { platform: 'win32', arch: 'x64', gpu: 'nvidia', assets: entries.map(asset) },
      'win-x64-cpu': { platform: 'win32', arch: 'x64', gpu: 'none', assets: entries.slice(0, 1).map(asset) },
    },
  };
}

function harness({ zips = null, catalog = null, probeBuild = 12098, free = 1e12, enabled = true, localOnly = false,
  nvidia = false, platform = 'win32' } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-dl-'));
  trackDirectory(userData);
  const files = zips || new Map([
    ['llama-b12098-bin-win-cpu-x64.zip', goodZip()],
    ['cudart-llama-bin-win-cuda-13.4-x64.zip', makeZip([{ name: 'cudart64_13.dll', data: Buffer.alloc(512, 3) }])],
  ]);
  const network = fakeNetwork(files);
  const flags = { enabled, localOnly, free, probeBuild };
  const probed = [];
  const logs = [];
  let readyCalls = 0;
  const service = createLlamaServerRuntimeDownload({
    catalog: catalog || catalogFor(files),
    userDataPath: () => userData,
    platform,
    arch: 'x64',
    fetchImpl: network.fetchImpl,
    statfsImpl: async () => ({ bavail: flags.free, bsize: 1 }),
    detectNvidia: async () => nvidia,
    validateImpl: async (binary) => {
      probed.push({ binary, exists: fs.existsSync(binary) });
      return { ok: true, build: flags.probeBuild };
    },
    bundledReads: () => 'no',
    hasReader: () => false,
    isLocalOnly: () => flags.localOnly,
    isEnabled: () => flags.enabled,
    onReady: async () => { readyCalls += 1; },
    log: (level, event, fields) => logs.push({ level, event, fields }),
  });
  const runtimes = path.join(userData, 'runtimes');
  const run = async (architecture = 'lfm3') => {
    await service.warm();
    const started = await service.start({ architecture });
    await service.settled();
    return { started, status: service.status() };
  };
  return { service, network, userData, runtimes, flags, probed, logs, files, run, readyCalls: () => readyCalls };
}

const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

test('a clicked download verifies, extracts, probes and moves the build into place', async () => {
  const h = harness();
  // A staging folder a quit left behind mid-extract is swept by the next job.
  fs.mkdirSync(path.join(h.runtimes, '.staging-b11000-win-x64-cpu', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(h.runtimes, '.staging-b11000-win-x64-cpu', 'bin', 'left.dll'), 'x');
  await h.service.warm();
  const offer = h.service.offerFor({ architecture: 'lfm3', bundledReads: 'no', hasReader: false });
  assert.deepEqual(offer, { build: 12098, sizeBytes: h.files.get('llama-b12098-bin-win-cpu-x64.zip').length });
  const { started, status } = await h.run();
  assert.deepEqual(started, { ok: true, build: 12098 });
  assert.equal(status.state, 'ready');
  assert.equal(status.receivedBytes, status.totalBytes);
  assert.equal(h.network.calls[0].url, `${PREFIX}llama-b12098-bin-win-cpu-x64.zip`);
  const folder = path.join(h.runtimes, FOLDER);
  assert.equal(fs.statSync(path.join(folder, 'llama-server.exe')).size, 2048);
  assert.equal(fs.statSync(path.join(folder, 'bin', 'ggml.dll')).size, 4);
  assert.deepEqual(listing(h.runtimes), [FOLDER]);
  assert.equal(h.readyCalls(), 1);
  // The probe ran on the staged copy, before the move.
  assert.deepEqual(h.probed.map((entry) => entry.exists), [true]);
  assert.match(h.probed[0].binary, /\.staging-/);
  // Installed now: no second offer, and the log carries codes only.
  assert.equal(h.service.offerFor({ architecture: 'lfm3', bundledReads: 'no', hasReader: false }), null);
  assert.deepEqual(h.logs.map((entry) => entry.event), [
    'llama.server.runtime_download_started', 'llama.server.runtime_download_ready',
  ]);
  assert.deepEqual(h.logs[1].fields, { build: 12098, variant: 'win-x64-cpu' });
});

test('an NVIDIA GPU picks the CUDA variant: both zips download and land in one folder', async () => {
  const h = harness({ nvidia: true });
  await h.service.warm();
  const offer = h.service.offerFor({ architecture: 'lfm3', bundledReads: 'no', hasReader: false });
  const total = [...h.files.values()].reduce((sum, buffer) => sum + buffer.length, 0);
  assert.equal(offer.sizeBytes, total);
  const { status } = await h.run();
  assert.equal(status.state, 'ready');
  const folder = path.join(h.runtimes, 'b12098-win-x64-cuda-13.4');
  assert.equal(fs.existsSync(path.join(folder, 'llama-server.exe')), true);
  assert.equal(fs.existsSync(path.join(folder, 'cudart64_13.dll')), true);
  assert.deepEqual(h.network.calls.map((call) => call.url.slice(PREFIX.length)), [
    'llama-b12098-bin-win-cpu-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip',
  ]);
});

test('a wrong sha256 deletes the part file, installs nothing and never calls onReady', async () => {
  const good = goodZip();
  const files = new Map([['llama-b12098-bin-win-cpu-x64.zip', good]]);
  const catalog = catalogFor(files);
  catalog.variants['win-x64-cpu'].assets[0].sha256 = 'a'.repeat(64);
  const h = harness({ zips: files, catalog });
  const { status } = await h.run();
  assert.equal(status.state, 'failed');
  assert.equal(status.reason, 'sha_mismatch');
  assert.deepEqual(listing(path.join(h.runtimes, '.downloads')), []);
  assert.equal(fs.existsSync(path.join(h.runtimes, FOLDER)), false);
  assert.equal(h.readyCalls(), 0);
  assert.equal(h.logs.at(-1).event, 'llama.server.runtime_download_failed');
  assert.deepEqual(h.logs.at(-1).fields, { build: 12098, variant: 'win-x64-cpu', reason: 'sha_mismatch' });
  // A larger body than the catalog says is refused by size, also without an install.
  const lie = catalogFor(new Map([['llama-b12098-bin-win-cpu-x64.zip', good]]));
  const lying = harness({ zips: new Map([['llama-b12098-bin-win-cpu-x64.zip', Buffer.concat([good, Buffer.alloc(10)])]]), catalog: lie });
  const result = await lying.run();
  assert.equal(result.status.reason, 'size_mismatch');
  assert.equal(fs.existsSync(path.join(lying.runtimes, FOLDER)), false);
});

test('cancel keeps the part bytes and the next start resumes with a Range request', async () => {
  const h = harness();
  const zip = h.files.get('llama-b12098-bin-win-cpu-x64.zip');
  const cut = 1000;
  h.network.state.stallAfter = cut;
  await h.service.warm();
  assert.equal((await h.service.start({ architecture: 'lfm3' })).ok, true);
  await until(() => h.service.status().receivedBytes >= cut);
  assert.deepEqual(await h.service.start({ architecture: 'lfm3' }), { ok: false, reason: 'busy' });
  assert.deepEqual(h.service.cancel(), { ok: true });
  await h.service.settled();
  assert.equal(h.service.status().state, 'cancelled');
  // The part file is keyed by the asset's checksum, so an older catalog's same-named part never resumes here.
  const parts = listing(path.join(h.runtimes, '.downloads'));
  assert.equal(parts.length, 1);
  assert.match(parts[0], /^[0-9a-f]{16}-llama-b12098-bin-win-cpu-x64\.zip\.part$/);
  assert.equal(fs.statSync(path.join(h.runtimes, '.downloads', parts[0])).size, cut);
  assert.equal(h.logs.at(-1).event, 'llama.server.runtime_download_cancelled');

  const { status } = await h.run();
  assert.equal(status.state, 'ready');
  assert.equal(h.network.calls.length, 2);
  assert.equal(h.network.calls[1].headers.Range, `bytes=${cut}-`);
  assert.equal(h.network.calls[0].headers.Range, undefined);
  assert.equal(fs.statSync(path.join(h.runtimes, FOLDER, 'llama-server.exe')).size, 2048);
  assert.equal(zip.length > cut, true);
  assert.equal(fs.existsSync(path.join(h.runtimes, '.downloads')), false);
});

test('an entry that escapes, an absolute name or a link is refused and everything is cleaned up', async () => {
  const unixLink = (0o120777 << 16) >>> 0;
  const cases = {
    dotdot: [{ name: '../evil.dll', data: 'x' }],
    absolute: [{ name: '/evil.dll', data: 'x' }],
    drive: [{ name: 'C:/evil.dll', data: 'x' }],
    backslash: [{ name: 'a\\..\\evil.dll', data: 'x' }],
    link: [{ name: 'link', data: 'target', madeBy: (3 << 8) | 20, attrs: unixLink }],
  };
  for (const [label, entries] of Object.entries(cases)) {
    const zip = makeZip([{ name: 'llama-server.exe', data: 'MZ' }, ...entries]);
    const h = harness({ zips: new Map([['llama-b12098-bin-win-cpu-x64.zip', zip]]) });
    const { status } = await h.run();
    assert.equal(status.state, 'failed', label);
    assert.equal(status.reason, 'unsafe_entry', label);
    assert.deepEqual(listing(h.runtimes).filter((name) => name.startsWith('.staging') || name === FOLDER), [], label);
    assert.equal(fs.existsSync(path.join(h.userData, 'evil.dll')), false, label);
    assert.equal(fs.existsSync(path.join(h.runtimes, 'evil.dll')), false, label);
    assert.equal(fs.existsSync(path.join(path.dirname(h.userData), 'evil.dll')), false, label);
    assert.equal(h.readyCalls(), 0, label);
    // The verified zip would fail the same way again, so it is deleted (the UI says so).
    assert.deepEqual(listing(path.join(h.runtimes, '.downloads')).filter((name) => name.endsWith('.zip.part')), [], label);
  }
});

test('a zip that expands past four times its catalog size stops with too_large', async () => {
  const bomb = makeZip([
    { name: 'llama-server.exe', data: 'MZ' },
    { name: 'huge.bin', data: Buffer.alloc(2 * 1024 * 1024), deflate: true },
  ]);
  assert.equal(bomb.length * 4 < 2 * 1024 * 1024, true);
  const h = harness({ zips: new Map([['llama-b12098-bin-win-cpu-x64.zip', bomb]]) });
  const { status } = await h.run();
  assert.equal(status.state, 'failed');
  assert.equal(status.reason, 'too_large');
  assert.deepEqual(listing(h.runtimes).filter((name) => name.startsWith('.staging') || name === FOLDER), []);
});

test('too little free space refuses before any request, naming the numbers', async () => {
  const h = harness({ free: 1000 });
  await h.service.warm();
  const total = h.files.get('llama-b12098-bin-win-cpu-x64.zip').length;
  assert.deepEqual(await h.service.start({ architecture: 'lfm3' }), {
    ok: false, reason: 'no_space', needBytes: Math.ceil(total * 2.5), freeBytes: 1000,
  });
  assert.equal(h.network.calls.length, 0);
  assert.equal(h.service.status().state, 'idle');
});

test('the flag and Local only mode refuse a start; nothing is offered with the flag off', async () => {
  const off = harness({ enabled: false });
  await off.service.warm();
  assert.deepEqual(await off.service.start({ architecture: 'lfm3' }), { ok: false, reason: 'flag_off' });
  assert.equal(off.service.offerFor({ architecture: 'lfm3', bundledReads: 'no', hasReader: false }), null);
  assert.equal(off.network.calls.length, 0);
  const local = harness({ localOnly: true });
  await local.service.warm();
  assert.deepEqual(await local.service.start({ architecture: 'lfm3' }), { ok: false, reason: 'local_only' });
  assert.equal(local.network.calls.length, 0);
});

test('a build is offered only when the bundled build cannot read it, nothing else can and the catalog lists it', async () => {
  const h = harness();
  await h.service.warm();
  const ask = (patch) => h.service.offerFor({ architecture: 'lfm3', bundledReads: 'no', hasReader: false, ...patch });
  assert.notEqual(ask({}), null);
  assert.equal(ask({ hasReader: true }), null);
  assert.equal(ask({ bundledReads: 'yes' }), null);
  assert.equal(ask({ bundledReads: 'unknown' }), null);
  assert.equal(ask({ architecture: 'brand-new' }), null);
  for (const bad of ['', 'LFM3', '../lfm3', 'lfm3\0', 'a'.repeat(41), 7, null]) assert.equal(ask({ architecture: bad }), null);
  assert.deepEqual(await h.service.start({ architecture: 'brand-new' }), { ok: false, reason: 'not_offered' });

  const linux = harness({ platform: 'linux' });
  await linux.service.warm();
  assert.equal(linux.service.offerFor({ architecture: 'lfm3', bundledReads: 'no', hasReader: false }), null);

  fs.mkdirSync(path.join(h.runtimes, FOLDER), { recursive: true });
  assert.notEqual(ask({}), null, 'an empty folder is not an install');
  fs.writeFileSync(path.join(h.runtimes, FOLDER, 'llama-server.exe'), 'MZ');
  assert.equal(ask({}), null, 'a finished install is not offered again');
});

test('a probe that reports another build number installs nothing', async () => {
  const h = harness({ probeBuild: 11513 });
  const { status } = await h.run();
  assert.equal(status.state, 'failed');
  assert.equal(status.reason, 'probe_failed');
  assert.deepEqual(listing(h.runtimes).filter((name) => name.startsWith('.staging') || name === FOLDER), []);
  assert.equal(h.readyCalls(), 0);
});

test('an invalid catalog offers nothing and is logged once, by code', async () => {
  const files = new Map([['llama-b12098-bin-win-cpu-x64.zip', goodZip()]]);
  const mutate = (change) => {
    const catalog = catalogFor(files);
    change(catalog);
    return catalog;
  };
  const broken = [
    mutate((c) => { c.variants['win-x64-cpu'].assets[0].sha256 = 'XYZ'; }),
    mutate((c) => { c.variants['win-x64-cpu'].assets[0].name = 'sub/llama.zip'; }),
    mutate((c) => { c.variants['win-x64-cpu'].assets[0].name = '..\\llama.zip'; }),
    mutate((c) => { c.variants['win-x64-cpu'].assets[0].size = 0; }),
    mutate((c) => { c.build = 12099; }),
    mutate((c) => { c.release = 'main'; }),
    mutate((c) => { c.architectures = ['lfm3', 'Bad Name']; }),
    { schema_version: 2 },
  ];
  for (const catalog of broken) {
    const h = harness({ zips: files, catalog });
    await h.service.warm();
    assert.equal(h.service.offerFor({ architecture: 'lfm3', bundledReads: 'no', hasReader: false }), null);
    assert.equal(h.service.offerFor({ architecture: 'lfm3', bundledReads: 'no', hasReader: false }), null);
    assert.deepEqual(await h.service.start({ architecture: 'lfm3' }), { ok: false, reason: 'not_offered' });
    assert.equal(h.logs.filter((entry) => entry.event === 'llama.server.runtime_download_catalog_invalid').length, 1);
    assert.equal(h.network.calls.length, 0);
  }
});

test('redirects stay on GitHub hosts: an asset host is followed, anything else fails the job', async () => {
  const allowed = harness();
  allowed.network.state.redirect = 'https://release-assets.githubusercontent.com/asset/1';
  const ok = await allowed.run();
  assert.equal(ok.status.state, 'ready');
  assert.equal(allowed.network.calls[1].url, 'https://release-assets.githubusercontent.com/asset/1');

  const foreign = harness();
  foreign.network.state.redirect = 'https://evil.example/asset';
  const refused = await foreign.run();
  assert.equal(refused.status.state, 'failed');
  assert.equal(refused.status.reason, 'network');
  assert.equal(foreign.network.calls.length, 1);
  assert.equal(fs.existsSync(path.join(foreign.runtimes, FOLDER)), false);
});

test('the shipped catalog is valid, pins a release and lists lfm3', async () => {
  const { DEFAULT_CATALOG_PATH } = require('../services/llama-server-runtime-download');
  const shipped = harness();
  const service = createLlamaServerRuntimeDownload({
    catalog: DEFAULT_CATALOG_PATH, userDataPath: () => shipped.userData, platform: 'win32', arch: 'x64',
    detectNvidia: async () => true, isEnabled: () => true, log: (level, event) => shipped.logs.push({ event }),
  });
  await service.warm();
  const offer = service.offerFor({ architecture: 'lfm3', bundledReads: 'no', hasReader: false });
  assert.equal(Number.isSafeInteger(offer.build) && offer.build > 11513, true);
  assert.equal(offer.sizeBytes > 500 * 1024 * 1024, true, 'the CUDA variant is both zips');
  assert.equal(service.offerFor({ architecture: 'not-an-architecture', bundledReads: 'no', hasReader: false }), null);
  assert.equal(shipped.logs.length, 0, 'no invalid-catalog log');
});
