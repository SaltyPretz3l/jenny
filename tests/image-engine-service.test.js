'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ImageEngineService, resolveReleaseAssetUrl, isSdCliRuntimePath, parseSdCliBanner, ENGINE_DIRECTORY,
} = require('../services/image-engine-service');
const {
  ACCEPT, ASSET_HOST, BANNER, TEMPLATE, assertUnpublished, build, zip,
} = require('./helpers/image-engine-service-fixture');

test('install and remove require explicit opt-in before fetching or deleting', async (t) => {
  const c = build(t);
  for (const payload of [undefined, null, {}, { confirmed: 'true' }, { confirmed: false }]) {
    assert.deepEqual(await c.service.install(payload), { ok: false, reason: 'opt_in_required' });
    assert.deepEqual(await c.service.remove(payload), { ok: false, reason: 'opt_in_required' });
  }
  assert.equal(c.calls.length, 0);
  assert.equal(c.service.getState().status, 'not_installed');
});

test('both pinned assets redirect once, publish atomically, and survive restart', async (t) => {
  const c = build(t, { editManifest: (m) => {
    m.platforms['win32-x64'].assets[0].sha256 = m.platforms['win32-x64'].assets[0].sha256.toUpperCase();
  } });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(c.service.getState().status, 'installed');
  assert.equal(c.service.getState().source, 'managed');
  assert.equal(c.service.getState().executable_path_present, true);
  assert.deepEqual(c.service.getState().license, { name: 'MIT', url: TEMPLATE.licenseUrl });
  assert.equal(c.service.getState().extracted_size_bytes, 1024);
  assert.equal(JSON.stringify(c.service.getState()).includes(c.userDataPath.replaceAll('\\', '\\\\')), false);
  assert.deepEqual(fs.readdirSync(c.root).sort(), [c.manifest.tag, 'state.json'].sort());
  for (const file of c.pin.expectedFiles) assert.equal(fs.statSync(path.join(c.target, file)).isFile(), true);
  const record = JSON.parse(fs.readFileSync(path.join(c.root, 'state.json'), 'utf8'));
  assert.deepEqual(record, { version: 1, installed_tag: c.manifest.tag, custom_executable: null,
    updated_at: record.updated_at });
  assert.equal(Number.isFinite(record.updated_at), true);
  assert.equal(c.calls.length, 4);
  assert.deepEqual(c.calls.map((call) => call.request.method), ['GET', 'GET', 'GET', 'GET']);
  assert.equal(c.discarded(), 2);
  assert.equal(c.probes.length, 1);
  assert.deepEqual(c.probes[0].args, ['--version']);
  assert.equal(c.probes[0].settings.timeout, 10_000);
  assert.equal(c.probes[0].settings.maxBuffer, 4 * 1024 * 1024);
  assert.equal(c.probes[0].settings.windowsHide, true);
  assert.equal(c.probes[0].settings.cwd, path.dirname(c.probes[0].file));
  const progress = c.states.filter((state) => state.install).map((state) => state.install.downloaded_bytes);
  assert.equal(progress.length > 0, true);
  assert.equal(progress.every((bytes, index) => !index || bytes >= progress[index - 1]), true);
  assert.equal(progress.at(-1), c.archives.reduce((sum, bytes) => sum + bytes.length, 0));
  assert.equal(c.states.at(-1).status, 'installed');
  const reopened = new ImageEngineService({ userDataPath: c.userDataPath, manifestPath: c.manifestPath,
    platform: 'win32', arch: 'x64', fetchImpl: () => { throw new Error('network forbidden'); } });
  t.after(() => reopened.dispose());
  let events = 0;
  reopened.on('changed', () => { events += 1; });
  reopened.start();
  assert.equal(events, 0);
  assert.deepEqual(reopened.resolveExecutable(), { ok: true, path: path.join(c.target, 'sd-cli.exe'),
    source: 'managed', tag: c.manifest.tag });
});

test('a second redirect fails through the downloader and leaves no published directory', async (t) => {
  const requests = [];
  const c = build(t, { serviceOptions: { fetchImpl: async (_url, request) => {
    requests.push(request.redirect);
    if (request.redirect === 'error') throw new TypeError('redirect count exceeded');
    return { status: 302, headers: { get: () => `https://${ASSET_HOST}/second.zip` } };
  } } });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'download_failed' });
  assert.deepEqual(requests, ['manual', 'error']);
  assertUnpublished(c);
});

test('redirects reject foreign hosts, insecure schemes, credentials, and relative locations', async () => {
  for (const [location, reason] of [
    ['https://evil.example/asset.zip', 'redirect_host_rejected'],
    [`http://${ASSET_HOST}/asset.zip`, 'redirect_scheme_rejected'],
    [`https://user:password@${ASSET_HOST}/asset.zip`, 'redirect_host_rejected'],
    ['/relative.zip', 'download_failed'],
  ]) {
    let cancelled = 0;
    const result = await resolveReleaseAssetUrl('https://github.com/asset.zip', {
      allowedHosts: [ASSET_HOST], abortController: new AbortController(),
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, 'manual');
        return { status: 302, headers: { get: () => location }, body: { cancel: async () => { cancelled += 1; } } };
      },
    });
    assert.deepEqual(result, { ok: false, reason });
    assert.equal(cancelled, 1);
  }
});

test('release URL resolution accepts 200 and the four supported redirect statuses only', async () => {
  for (const status of [200, 301, 302, 307, 308, 201, 303, 404]) {
    const original = 'https://github.com/asset.zip';
    const redirected = `https://${ASSET_HOST}/asset.zip?signature=private`;
    const result = await resolveReleaseAssetUrl(original, { allowedHosts: [ASSET_HOST],
      fetchImpl: async () => ({ status, headers: { get: () => redirected } }) });
    assert.deepEqual(result, status === 200 ? { ok: true, url: original }
      : [301, 302, 307, 308].includes(status) ? { ok: true, url: redirected }
        : { ok: false, reason: 'download_failed' });
  }
});

test('digest mismatch removes the download and leaves no installed marker', async (t) => {
  const c = build(t, { editManifest: (m) => { m.platforms['win32-x64'].assets[0].sha256 = '0'.repeat(64); } });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'hash_mismatch' });
  assert.equal(c.probes.length, 0);
  assertUnpublished(c);
});

test('zip-slip entries are rejected without writes outside staging', async (t) => {
  for (const name of ['../x', 'C:/x', '/x', 'a\\b']) {
    const c = build(t, { archives: [zip([name]), zip(['runtime.dll'])] });
    const sentinel = path.join(c.temp, 'x');
    assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'image_engine_archive_invalid' });
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(fs.existsSync(path.join(c.root, 'x')), false);
    assert.equal(c.probes.length, 0);
    assertUnpublished(c);
  }
});

test('missing or non-regular expected files prevent publishing', async (t) => {
  const c = build(t, { archives: [zip(['sd-cli.exe']), zip(['cudart64_12.dll'])] });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'image_engine_files_missing' });
  assert.equal(c.probes.length, 0);
  assertUnpublished(c);
});

test('wrong commit and failed probes prevent publishing', async (t) => {
  for (const banner of ['stable-diffusion.cpp version unknown, commit deadbee', 'garbage']) {
    const c = build(t, { banner });
    assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'image_engine_probe_failed' });
    assertUnpublished(c);
  }
  const c = build(t, { serviceOptions: { execFileImpl: (_file, _args, _options, callback) => {
    callback(new Error('exec failed'), BANNER, '');
  } } });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'image_engine_probe_failed' });
  assertUnpublished(c);
});

test('cancel during a download stops installation, and concurrent mutations are refused', async (t) => {
  let firstChunk;
  const started = new Promise((resolve) => { firstChunk = resolve; });
  let resume;
  const paused = new Promise((resolve) => { resume = resolve; });
  const c = build(t);
  c.service.fetchImpl = async (_url, request) => request.redirect === 'manual'
    ? { status: 200 } : { ok: true, status: 200, body: (async function* () {
      yield c.archives[0].subarray(0, 16);
      firstChunk();
      await paused;
      yield c.archives[0].subarray(16);
    })() };
  const installing = c.service.install(ACCEPT);
  await started;
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'install_in_progress' });
  assert.deepEqual(await c.service.remove(ACCEPT), { ok: false, reason: 'install_in_progress' });
  assert.deepEqual(await c.service.cancel(), { ok: true });
  resume();
  assert.deepEqual(await installing, { ok: false, reason: 'cancelled' });
  assertUnpublished(c);
});

test('cancel is refused once publishing begins, including after a completed install', async (t) => {
  const c = build(t);
  let publishedCancel;
  c.service.on('changed', (state) => {
    if (state.install?.phase === 'publishing') publishedCancel = c.service.cancel();
  });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.deepEqual(await publishedCancel, { ok: false, reason: 'install_already_published' });
  assert.deepEqual(await c.service.cancel(), { ok: false, reason: 'install_already_published' });
});

test('cancellation during real ZIP extraction destroys the staged output stream', async (t) => {
  let c;
  let cancelResult;
  c = build(t, { serviceOptions: { fsImpl: { ...fs, createWriteStream(file, options) {
    const stream = fs.createWriteStream(file, options);
    if (path.basename(path.dirname(file)) === 'extract') {
      stream.once('pipe', () => { cancelResult = c.service.cancel(); });
    }
    return stream;
  } } } });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'cancelled' });
  assert.deepEqual(await cancelResult, { ok: true });
  assert.equal(c.probes.length, 0);
  assertUnpublished(c);
});

test('start sweeps old staging without emitting or deleting the pinned directory', (t) => {
  const c = build(t);
  fs.mkdirSync(path.join(c.root, 'staging-old'), { recursive: true });
  fs.writeFileSync(path.join(c.root, 'staging-old', 'leftover'), 'partial');
  fs.mkdirSync(c.target);
  c.service.start();
  assert.equal(fs.existsSync(path.join(c.root, 'staging-old')), false);
  assert.equal(fs.existsSync(c.target), true);
  assert.equal(c.states.length, 0);
});

test('remove deletes only the pin and staging, preserving siblings and custom files', async (t) => {
  const c = build(t);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  const sibling = path.join(c.userDataPath, 'engines', 'other', 'keep');
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  fs.writeFileSync(sibling, 'other engine');
  const custom = path.join(c.temp, 'sd-cli.exe');
  fs.writeFileSync(custom, 'custom');
  const mtimes = [sibling, custom].map((file) => fs.statSync(file).mtimeMs);
  assert.equal((await c.service.setCustomExecutable(custom)).ok, true);
  fs.mkdirSync(path.join(c.root, 'staging-old'));
  assert.deepEqual(await c.service.remove(ACCEPT), { ok: true });
  assert.equal(fs.existsSync(c.target), false);
  assert.equal(fs.existsSync(path.join(c.root, 'staging-old')), false);
  assert.deepEqual([sibling, custom].map((file) => fs.statSync(file).mtimeMs), mtimes);
  assert.equal(c.service.getState().status, 'custom');
  assert.equal(c.service.resolveExecutable().path, custom);
});

test('custom path rejection precedes stat, and a custom probe must parse a banner', async (t) => {
  let stats = 0;
  const c = build(t, { serviceOptions: { fsImpl: { ...fs, statSync() { stats += 1; throw new Error('unexpected stat'); } } } });
  for (const file of ['\\\\server\\share\\sd-cli.exe', '\\\\?\\C:\\x\\sd-cli.exe', 'C:\\x\\notsd.exe',
    'relative\\sd-cli.exe', 'C:\\x\\..\\sd-cli.exe', 'C:\\x:stream\\sd-cli.exe', 'C:\\x\\sd-cli.exe\\']) {
    assert.deepEqual(await c.service.setCustomExecutable(file), { ok: false, reason: 'image_engine_path_rejected' });
  }
  assert.equal(stats, 0);
  const good = build(t);
  const custom = path.join(good.temp, 'sd-cli.exe');
  fs.writeFileSync(custom, 'binary');
  good.service.execFileImpl = (_file, _args, _options, callback) => callback(null, 'bad banner', '');
  assert.deepEqual(await good.service.setCustomExecutable(custom), { ok: false, reason: 'image_engine_probe_failed' });
  assert.equal(good.service.getState().custom_executable, null);
  good.service.execFileImpl = (_file, _args, _options, callback) => callback(null, BANNER, '');
  assert.deepEqual(await good.service.setCustomExecutable(custom), { ok: true, banner: BANNER.trim() });
  assert.equal(good.service.resolveExecutable().source, 'custom');
  assert.equal(good.service.getState().custom_executable, custom);
  assert.deepEqual(await good.service.clearCustomExecutable(), { ok: true });
  assert.deepEqual(good.service.resolveExecutable(), { ok: false, reason: 'image_engine_missing' });
  assert.deepEqual(await good.service.setCustomExecutable(custom + '.missing'), { ok: false, reason: 'image_engine_path_rejected' });
});

test('local runtime path shapes and the sd-cli banner parser match the contract', () => {
  assert.deepEqual(parseSdCliBanner(BANNER), { commit: '3f8527a' });
  assert.equal(parseSdCliBanner('garbage'), null);
  assert.equal(parseSdCliBanner(null), null);
  assert.equal(isSdCliRuntimePath('C:\\x\\sd-cli.exe', { platform: 'win32' }), true);
  assert.equal(isSdCliRuntimePath('/opt/sd-cli', { platform: 'linux' }), true);
  for (const value of ['/opt/../sd-cli', '/opt/sd-cli/', '/opt/sd-cli.exe', '/opt/\nsd-cli', '/'.repeat(1025)]) {
    assert.equal(isSdCliRuntimePath(value, { platform: 'linux' }), false);
  }
});

test('offline entrypoints never fetch, and reconciliation detects deleted managed files', async (t) => {
  const c = build(t);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  let network = 0;
  c.service.fetchImpl = () => { network += 1; throw new Error('network forbidden'); };
  c.service.start();
  assert.equal(c.service.getState().status, 'installed');
  assert.equal(c.service.resolveExecutable().source, 'managed');
  assert.equal((await c.service.reconcileState()).status, 'installed');
  const custom = path.join(c.temp, 'sd-cli.exe');
  assert.deepEqual(await c.service.setCustomExecutable(custom), { ok: false, reason: 'image_engine_path_missing' });
  fs.writeFileSync(custom, 'custom');
  assert.equal((await c.service.setCustomExecutable(custom)).ok, true);
  assert.deepEqual(await c.service.clearCustomExecutable(), { ok: true });
  fs.unlinkSync(path.join(c.target, 'stable-diffusion.dll'));
  assert.equal((await c.service.reconcileState()).status, 'not_installed');
  assert.deepEqual(c.service.resolveExecutable(), { ok: false, reason: 'image_engine_missing' });
  assert.deepEqual(await c.service.remove(ACCEPT), { ok: true });
  c.service.dispose();
  assert.equal(network, 0);
});

test('unsupported platforms and malformed pins fail without network', async (t) => {
  const unsupported = build(t, { serviceOptions: { platform: 'linux', arch: 'x64' } });
  assert.equal(unsupported.service.getState().status, 'error');
  assert.equal(unsupported.service.getState().last_error, 'platform_unsupported');
  assert.deepEqual(await unsupported.service.install(ACCEPT), { ok: false, reason: 'platform_unsupported' });
  for (const change of [{ url: 'http://github.com/file.zip' }, { url: 'https://evil.example/file.zip' },
    { url: 'https://user:secret@github.com/file.zip' }, { sizeBytes: 0 }, { sizeBytes: 1.5 },
    { sha256: 'bad' }, { filename: '../file.zip' }, { filename: 'file.exe' }, { url: 'https://github.com/wrong.zip' }]) {
    const c = build(t, { editManifest: (m) => Object.assign(m.platforms['win32-x64'].assets[0], change) });
    assert.equal(c.service.getState().status, 'error');
    assert.equal((await c.service.install(ACCEPT)).ok, false);
    assert.equal(c.calls.length, 0);
  }
  assert.equal(unsupported.calls.length, 0);
});

test('managed directory junctions cannot redirect writes or deletions outside the service root', async (t) => {
  const c = build(t);
  const outside = path.join(c.temp, 'outside');
  fs.mkdirSync(outside);
  const sentinel = path.join(outside, 'keep');
  fs.writeFileSync(sentinel, 'untouched');
  fs.mkdirSync(path.dirname(c.root), { recursive: true });
  fs.symlinkSync(outside, c.root, 'junction');
  c.service.start();
  assert.equal((await c.service.install(ACCEPT)).ok, false);
  assert.equal((await c.service.remove(ACCEPT)).ok, false);
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
  assert.equal(c.calls.length, 0);
});

test('cancellation during redirect resolution makes no subsequent download request', async (t) => {
  let begin;
  const begun = new Promise((resolve) => { begin = resolve; });
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  let requests = 0;
  const c = build(t, { serviceOptions: { fetchImpl: async () => {
    requests += 1;
    begin();
    await waiting;
    return { status: 200 };
  } } });
  const installing = c.service.install(ACCEPT);
  await begun;
  assert.deepEqual(await c.service.cancel(), { ok: true });
  finish();
  assert.deepEqual(await installing, { ok: false, reason: 'cancelled' });
  assert.equal(requests, 1);
  assertUnpublished(c);
});

test('cancellation at the probe transition prevents starting the executable', async (t) => {
  const c = build(t);
  c.service.on('changed', (state) => {
    if (state.install?.phase === 'probing') void c.service.cancel();
  });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'cancelled' });
  assert.equal(c.probes.length, 0);
  assertUnpublished(c);
});

test('remove unlinks managed and staging junctions but preserves other root entries', async (t) => {
  const c = build(t);
  const outside = path.join(c.temp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'untouched');
  fs.mkdirSync(c.root, { recursive: true });
  fs.symlinkSync(outside, c.target, 'junction');
  fs.symlinkSync(outside, path.join(c.root, 'staging-link'), 'junction');
  fs.writeFileSync(path.join(c.root, 'staging-file'), 'keep this file');
  fs.mkdirSync(path.join(c.root, 'unrelated'));
  assert.deepEqual(await c.service.remove(ACCEPT), { ok: true });
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'untouched');
  assert.deepEqual(fs.readdirSync(c.root).sort(), ['staging-file', 'state.json', 'unrelated']);
  assert.equal(c.calls.length, 0);
});

test('progress notifications are throttled while byte counts remain monotonic', async (t) => {
  let time = 0;
  const c = build(t, { serviceOptions: { now: () => time } });
  const downloadEvents = [];
  c.service.on('changed', (state) => {
    if (state.install?.phase === 'downloading' && state.install.downloaded_bytes > 0) {
      downloadEvents.push({ time, bytes: state.install.downloaded_bytes });
    }
  });
  c.service.fetchImpl = async (url, request) => {
    if (request.redirect === 'manual') return { status: 200 };
    const index = c.pin.assets.findIndex((asset) => url.endsWith(`/${asset.filename}`));
    return { ok: true, status: 200, body: (async function* () {
      for (let offset = 0; offset < c.archives[index].length; offset += 16) {
        time += 100;
        yield c.archives[index].subarray(offset, offset + 16);
      }
    })() };
  };
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(downloadEvents.length > 1, true);
  assert.equal(downloadEvents.every((event, index) => !index || event.time - downloadEvents[index - 1].time >= 250), true);
  assert.equal(downloadEvents.every((event, index) => !index || event.bytes >= downloadEvents[index - 1].bytes), true);
  assert.equal(c.states.filter((state) => state.install).at(-1).install.downloaded_bytes,
    c.pin.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0));
});

test('managed publish rename retries transient locks and atomically renames state', async (t) => {
  let publishAttempts = 0;
  const renames = [];
  const c = build(t, { serviceOptions: { fsImpl: { ...fs, promises: { ...fs.promises,
    async rename(from, to) {
      renames.push({ from, to });
      if (path.basename(from) === 'extract' && ++publishAttempts === 1) {
        throw Object.assign(new Error('locked'), { code: 'EPERM' });
      }
      return fs.promises.rename(from, to);
    },
  } } } });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(publishAttempts, 2);
  const stateRenames = renames.filter((rename) => path.basename(rename.to) === 'state.json');
  assert.equal(stateRenames.length, 1);
  assert.equal(stateRenames[0].from.endsWith('.tmp'), true);
  assert.equal(fs.readdirSync(c.root).some((name) => name.endsWith('.tmp')), false);
});

test('download caps, extraction limits, and first-hop response timeouts leave no publication', async (t) => {
  const oversized = build(t, { editManifest: (m) => { m.platforms['win32-x64'].assets[0].sizeBytes -= 1; } });
  assert.deepEqual(await oversized.service.install(ACCEPT), { ok: false, reason: 'byte_overflow' });
  assertUnpublished(oversized);
  const truncated = build(t, { editManifest: (m) => { m.platforms['win32-x64'].assets[0].sizeBytes += 1; } });
  assert.deepEqual(await truncated.service.install(ACCEPT), { ok: false, reason: 'size_mismatch' });
  assertUnpublished(truncated);
  const bomb = build(t, { editManifest: (m) => { m.platforms['win32-x64'].extractLimits.maxEntries = 1; } });
  assert.deepEqual(await bomb.service.install(ACCEPT), { ok: false, reason: 'image_engine_archive_invalid' });
  assertUnpublished(bomb);
  const stalled = build(t, { serviceOptions: { responseStartTimeoutMs: 10,
    fetchImpl: async (_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  } });
  const keepAlive = setInterval(() => {}, 100);
  try {
    assert.deepEqual(await stalled.service.install(ACCEPT), { ok: false, reason: 'response_timeout' });
    assertUnpublished(stalled);
  } finally { clearInterval(keepAlive); }
});

test('probe environment and log fields omit credentials, managed paths, and signed URLs', async (t) => {
  const logs = [];
  const key = 'JENNY_IMAGE_TEST_API_KEY';
  const previous = process.env[key];
  process.env[key] = 'private-test-value';
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const c = build(t, { serviceOptions: { logger: (...args) => logs.push(args) } });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(c.probes[0].settings.env[key], undefined);
  assert.equal(logs.length > 0, true);
  assert.equal(logs.every((entry) => entry[1].startsWith('image_engine.')), true);
  const fields = JSON.stringify(logs.map((entry) => entry[2]));
  assert.equal(fields.includes(c.root.replaceAll('\\', '\\\\')), false);
  assert.equal(fields.includes('https:'), false);
  assert.equal(fields.includes('private-test-value'), false);
});
