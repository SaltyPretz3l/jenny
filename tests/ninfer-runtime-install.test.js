'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assembleZip } = require('./helpers/hostile-archive-builder');
const { loadNinferRuntimeManifest } = require('../services/ninfer-manifests');
const { NinferRuntimeInstallService } = require('../services/ninfer-runtime-install');

const ACCEPT = { confirmed: true };
const ASSET_HOST = 'release-assets.githubusercontent.com';
const TOP = 'ninfer-windows-0.9.1-win64-cuda131/';
const PIN = loadNinferRuntimeManifest();
const PAYLOAD = [...PIN.expected_files.filter((name) => name !== PIN.sums_file), 'models/README.txt', 'launch.bat'];

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// A release-shaped zip: payload files, a SHA256SUMS over them, optional shared top folder.
function makeZip({ flat = false, omit = [], editSums = (lines) => lines, sums = true } = {}) {
  const files = PAYLOAD.filter((name) => !omit.includes(name))
    .map((name) => ({ name, data: Buffer.from(`contents of ${name}\n`.repeat(8)) }));
  const lines = editSums(files.map((file) => `${sha(file.data)} *${file.name}`));
  if (sums) files.push({ name: PIN.sums_file, data: Buffer.from(`${lines.join('\n')}\n`) });
  const prefix = flat ? '' : TOP;
  const entries = flat ? [{ name: 'models/' }] : [{ name: TOP }, { name: `${TOP}models/` }];
  for (const file of files) entries.push({ name: `${prefix}${file.name}`, data: file.data });
  return assembleZip(entries).bytes;
}

function build(t, { zip = makeZip(), pin = {}, fetchImpl, now, chunkSize = 64, pauseFirst = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ninfer-runtime-'));
  const userDataPath = path.join(temp, 'profile');
  fs.mkdirSync(userDataPath);
  const runtime = { ...PIN, size_bytes: zip.length, sha256: sha(zip), ...pin };
  const calls = [];
  const gate = {};
  gate.started = new Promise((resolve) => { gate.markStarted = resolve; });
  gate.paused = new Promise((resolve) => { gate.resume = resolve; });
  let downloads = 0;
  const defaultFetch = async (url, request) => {
    calls.push({ url, redirect: request.redirect });
    if (request.redirect === 'manual') {
      assert.equal(url, PIN.url);
      return { status: 302, headers: { get: () => `https://${ASSET_HOST}/asset/${PIN.asset}?sig=secret` },
        body: { cancel: async () => {} } };
    }
    assert.equal(request.redirect, 'error');
    downloads += 1;
    const pause = pauseFirst && downloads === 1;
    return { ok: true, status: 200, headers: { get: (name) => (name === 'content-length' ? String(zip.length) : null) },
      body: (async function* () {
        for (let offset = 0; offset < zip.length; offset += chunkSize) {
          yield zip.subarray(offset, offset + chunkSize);
          if (pause && offset === 0) { gate.markStarted(); await gate.paused; }
        }
      })() };
  };
  let time = 0;
  const logs = [];
  const service = new NinferRuntimeInstallService({ userDataPath, runtime, fetchImpl: fetchImpl || defaultFetch,
    now: now || (() => (time += 300)), logger: (level, event, fields) => logs.push({ level, event, fields }) });
  t.after(() => { service.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const states = [];
  service.on('changed', (state) => states.push(state));
  service.start();
  const root = path.join(userDataPath, 'engines', 'ninfer');
  return { service, temp, userDataPath, runtime, root, target: path.join(root, PIN.install_dirname),
    stateFile: path.join(root, 'runtime-state.json'), calls, states, logs, gate, zip };
}

function assertUnpublished(c) {
  assert.equal(fs.existsSync(c.target), false);
  assert.equal(fs.existsSync(`${c.target}.part`), false);
  const names = fs.existsSync(c.root) ? fs.readdirSync(c.root) : [];
  assert.equal(names.some((name) => name.startsWith('staging-')), false);
  assert.equal(fs.existsSync(c.stateFile), false);
  assert.equal(c.service.getState().status, 'not_installed');
  assert.deepEqual(c.service.resolveExecutable(), { ok: false, reason: 'not_installed' });
}

function assertPublished(c) {
  assert.equal(c.service.getState().status, 'installed');
  assert.equal(c.service.getState().executable_present, true);
  assert.deepEqual(fs.readdirSync(c.root).sort(), [PIN.install_dirname, 'runtime-state.json'].sort());
  for (const name of [...PAYLOAD, PIN.sums_file]) {
    assert.equal(fs.statSync(path.join(c.target, ...name.split('/'))).isFile(), true, name);
  }
  const record = JSON.parse(fs.readFileSync(c.stateFile, 'utf8'));
  assert.deepEqual(record, { version: 1, installed_dirname: PIN.install_dirname, updated_at: record.updated_at });
  assert.equal(Number.isFinite(record.updated_at), true);
  assert.deepEqual(c.service.resolveExecutable(), { ok: true, path: path.join(c.target, PIN.executable),
    version: PIN.version });
}

for (const flat of [false, true]) {
  test(`a ${flat ? 'flat' : 'single-folder'} release zip publishes once and survives restart`, async (t) => {
    const c = build(t, { zip: makeZip({ flat }) });
    assert.deepEqual(c.service.getState(), { status: 'not_installed', version: PIN.version, download_size_bytes: c.service.runtime.size_bytes,
      install: null, last_error: null, executable_present: false });
    assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
    assertPublished(c);
    assert.deepEqual(c.calls.map((call) => call.redirect), ['manual', 'error']);
    assert.equal(c.calls[1].url, `https://${ASSET_HOST}/asset/${PIN.asset}?sig=secret`);
    assert.deepEqual(await c.service.install(ACCEPT), { ok: true, already: true });
    assert.equal(c.calls.length, 2);
    assert.deepEqual(c.service.cancel(), { ok: false, reason: 'idle' });
    const phases = [...new Set(c.states.filter((state) => state.install).map((state) => state.install.phase))];
    assert.deepEqual(phases, ['downloading', 'verifying', 'extracting', 'publishing']);
    assert.equal(c.states.at(-1).status, 'installed');
    for (const entry of c.logs) {
      const text = JSON.stringify(entry);
      assert.equal(text.includes('sig=secret') || text.includes(ASSET_HOST) || text.includes(os.tmpdir().slice(3)), false);
    }
    const reopened = new NinferRuntimeInstallService({ userDataPath: c.userDataPath, runtime: c.runtime,
      fetchImpl: () => { throw new Error('network forbidden'); } });
    t.after(() => reopened.dispose());
    let events = 0;
    reopened.on('changed', () => { events += 1; });
    assert.equal(reopened.start().status, 'installed');
    assert.equal(events, 0);
    assert.deepEqual(reopened.resolveExecutable(), c.service.resolveExecutable());
  });
}

test('start sweeps staging directories and stale partials without emitting', async (t) => {
  const c = build(t);
  fs.mkdirSync(path.join(c.root, 'staging-abc', 'extract'), { recursive: true });
  fs.writeFileSync(path.join(c.root, `${PIN.install_dirname}.part`), 'partial');
  fs.mkdirSync(path.join(c.root, 'models'));
  fs.writeFileSync(path.join(c.root, 'models', 'keep.ninfer'), 'weights');
  const fresh = new NinferRuntimeInstallService({ userDataPath: c.userDataPath, runtime: c.runtime });
  t.after(() => fresh.dispose());
  let events = 0;
  fresh.on('changed', () => { events += 1; });
  assert.equal(fresh.start().status, 'not_installed');
  assert.equal(events, 0);
  assert.deepEqual(fs.readdirSync(c.root), ['models']);
  assert.equal(fs.existsSync(path.join(c.root, 'models', 'keep.ninfer')), true);
});

test('install and remove require explicit opt-in before fetching or deleting', async (t) => {
  const c = build(t);
  for (const payload of [undefined, null, {}, { confirmed: 'true' }, { confirmed: false }]) {
    assert.deepEqual(await c.service.install(payload), { ok: false, reason: 'opt_in_required' });
    assert.deepEqual(await c.service.remove(payload), { ok: false, reason: 'opt_in_required' });
  }
  assert.equal(c.calls.length, 0);
  assert.equal(c.states.length, 0);
});

test('a zip digest mismatch deletes the partial and leaves no install directory', async (t) => {
  const c = build(t, { pin: { sha256: '0'.repeat(64) } });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'digest_mismatch' });
  assertUnpublished(c);
  assert.equal(c.service.getState().last_error, 'digest_mismatch');
});

test('SHA256SUMS problems refuse the install', async (t) => {
  const cases = [
    ['one wrong line', { editSums: (lines) => lines.map((line, index) => (index === 1 ? `${'f'.repeat(64)}${line.slice(64)}` : line)) }, 'sums_mismatch'],
    ['a listed file absent', { editSums: (lines) => [...lines, `${'a'.repeat(64)} *missing.dll`] }, 'sums_mismatch'],
    ['an escaping path', { editSums: (lines) => [...lines, `${'a'.repeat(64)} *../outside.dll`] }, 'sums_mismatch'],
    ['a malformed line', { editSums: (lines) => [...lines, 'not a checksum line'] }, 'sums_mismatch'],
    ['no SHA256SUMS', { sums: false }, 'sums_missing'],
    ['an expected DLL absent', { omit: ['z.dll'] }, 'expected_file_missing'],
  ];
  for (const [label, options, reason] of cases) {
    const c = build(t, { zip: makeZip(options) });
    assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason }, label);
    assertUnpublished(c);
  }
});

test('an unextractable archive fails as extract_failed', async (t) => {
  const c = build(t, { zip: Buffer.from('not a zip archive at all') });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'extract_failed' });
  assertUnpublished(c);
});

test('download failures map to their reason codes and clean up', async (t) => {
  const c = build(t, { pin: { size_bytes: 10 } });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'byte_overflow' });
  assertUnpublished(c);
  const d = build(t, { fetchImpl: async (_url, request) => (request.redirect === 'manual'
    ? { status: 302, headers: { get: () => `https://${ASSET_HOST}/asset` } }
    : { ok: false, status: 500 }) });
  assert.deepEqual(await d.service.install(ACCEPT), { ok: false, reason: 'download_failed' });
  assertUnpublished(d);
});

test('a redirect to a foreign host is refused without a download request', async (t) => {
  const calls = [];
  const c = build(t, { fetchImpl: async (_url, request) => {
    calls.push(request.redirect);
    return { status: 302, headers: { get: () => 'https://evil.example/ninfer.zip' } };
  } });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'redirect_host_rejected' });
  assert.deepEqual(calls, ['manual']);
  assertUnpublished(c);
});

test('cancel mid-download removes partial and staging, and a second install succeeds', async (t) => {
  const c = build(t, { pauseFirst: true });
  const logs = [];
  c.service.logger = (...entry) => logs.push(entry);
  const installing = c.service.install(ACCEPT);
  await c.gate.started;
  assert.equal(c.service.getState().status, 'installing');
  assert.equal(c.service.getState().install.phase, 'downloading');
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'busy' });
  assert.deepEqual(await c.service.remove(ACCEPT), { ok: false, reason: 'busy' });
  assert.deepEqual(c.service.cancel(), { ok: true });
  c.gate.resume();
  assert.deepEqual(await installing, { ok: false, reason: 'cancelled' });
  // Gate 2026-10-14: a cancel logged a WARN install_failed that Diagnostics flagged.
  assert.equal(logs.some(([, event]) => event === 'ninfer_runtime.install_failed'), false);
  assert.ok(logs.some(([level, event]) => level === 'INFO' && event === 'ninfer_runtime.install_cancelled'));
  assertUnpublished(c);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assertPublished(c);
});

test('cancel during extraction discards the staged output', async (t) => {
  const c = build(t);
  let cancelResult;
  c.service.extractImpl = async (args) => {
    cancelResult = c.service.cancel();
    const { extractWheel } = require('../services/pdf-addon-wheel');
    return extractWheel(args);
  };
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'cancelled' });
  assert.deepEqual(cancelResult, { ok: true });
  assertUnpublished(c);
});

test('cancel is refused once publishing begins', async (t) => {
  const c = build(t);
  let publishingCancel;
  c.service.on('changed', (state) => {
    if (state.install?.phase === 'publishing') publishingCancel = c.service.cancel();
  });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.deepEqual(publishingCancel, { ok: false, reason: 'publishing' });
  assertPublished(c);
});

test('remove deletes the install directory but preserves the models sibling', async (t) => {
  const c = build(t);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  fs.mkdirSync(path.join(c.root, 'models'));
  fs.writeFileSync(path.join(c.root, 'models', 'keep.ninfer'), 'weights');
  fs.mkdirSync(path.join(c.root, 'staging-dead'));
  assert.deepEqual(await c.service.remove(ACCEPT), { ok: true });
  assert.deepEqual(fs.readdirSync(c.root), ['models']);
  assert.equal(fs.readFileSync(path.join(c.root, 'models', 'keep.ninfer'), 'utf8'), 'weights');
  assert.equal(c.service.getState().status, 'not_installed');
  assert.equal(c.service.getState().executable_present, false);
  assert.deepEqual(c.service.resolveExecutable(), { ok: false, reason: 'not_installed' });
});

test('download progress is monotonic, sized, and throttled to one emit per 250 ms', async (t) => {
  const zip = makeZip();
  const frozen = build(t, { zip, chunkSize: 16, now: () => 1000 });
  assert.deepEqual(await frozen.service.install(ACCEPT), { ok: true });
  const frozenDownloads = frozen.states.filter((state) => state.install?.phase === 'downloading');
  assert.equal(frozenDownloads.length, 2);
  let time = 0;
  const stepped = build(t, { zip, chunkSize: 16, now: () => (time += 100) });
  assert.deepEqual(await stepped.service.install(ACCEPT), { ok: true });
  const chunks = Math.ceil(zip.length / 16);
  const downloads = stepped.states.filter((state) => state.install?.phase === 'downloading');
  assert.equal(downloads.length > 2, true);
  assert.equal(downloads.length <= Math.ceil(chunks / 3) + 2, true);
  const done = stepped.states.filter((state) => state.install).map((state) => state.install.done);
  assert.equal(done.every((bytes, index) => !index || bytes >= done[index - 1]), true);
  assert.equal(downloads.every((state) => state.install.total === zip.length), true);
  assert.equal(stepped.states.find((state) => state.install?.phase === 'verifying').install.done, zip.length);
});

test('state never carries an absolute path', async (t) => {
  const c = build(t);
  await c.service.install(ACCEPT);
  await c.service.remove(ACCEPT);
  const escaped = (value) => [value, value.replaceAll('\\', '\\\\'), value.replaceAll('\\', '/')];
  for (const state of [...c.states, c.service.getState()]) {
    const text = JSON.stringify(state);
    for (const needle of [...escaped(c.temp), ...escaped(c.userDataPath)]) assert.equal(text.includes(needle), false);
    assert.equal(/[A-Za-z]:[\\/]/.test(text), false);
  }
});
