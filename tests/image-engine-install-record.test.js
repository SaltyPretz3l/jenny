'use strict';

// The install record published with the engine files: presence is decided by
// the record and the file sizes, not by state.json alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ImageEngineService, ENGINE_DIRECTORY } = require('../services/image-engine-service');
const { ACCEPT, BANNER, TEMPLATE, build, zip } = require('./helpers/image-engine-service-fixture');

const RECORD_NAME = '.jenny-engine-install.json';

function writeState(c, tag) {
  fs.mkdirSync(c.root, { recursive: true });
  fs.writeFileSync(path.join(c.root, 'state.json'),
    JSON.stringify({ version: 1, installed_tag: tag, custom_executable: null, updated_at: 1 }));
}

function seedGeneration(c, tag, { record = true, recordTag = tag } = {}) {
  const dir = path.join(c.root, tag);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sd-cli.exe'), 'old binary');
  if (record) {
    fs.writeFileSync(path.join(dir, RECORD_NAME),
      JSON.stringify({ version: 1, tag: recordTag, commit: 'deadbee', files: { 'sd-cli.exe': 10 } }));
  }
  return dir;
}

function forbidNetwork(c) {
  let network = 0;
  c.service.fetchImpl = () => { network += 1; throw new Error('network forbidden'); };
  return () => network;
}

test('an install record with the expected file sizes is published with the files', async (t) => {
  const c = build(t);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  const record = JSON.parse(fs.readFileSync(path.join(c.target, RECORD_NAME), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['commit', 'files', 'tag', 'version']);
  assert.equal(record.version, 1);
  assert.equal(record.tag, c.manifest.tag);
  assert.equal(record.commit, c.manifest.commit);
  assert.deepEqual(Object.keys(record.files).sort(), [...c.pin.expectedFiles].sort());
  for (const file of c.pin.expectedFiles) {
    assert.equal(record.files[file], fs.statSync(path.join(c.target, file)).size);
    assert.equal(record.files[file] > 0, true);
  }
});

test('zero-byte expected files under a current-tag state record are not installed and Install repairs them', async (t) => {
  const c = build(t);
  fs.mkdirSync(c.target, { recursive: true });
  for (const file of c.pin.expectedFiles) fs.writeFileSync(path.join(c.target, file), '');
  writeState(c, c.manifest.tag);
  assert.equal(c.service.start().status, 'not_installed');
  assert.equal(c.service.resolveExecutable().ok, false);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(c.calls.length, 4);
  assert.equal(c.service.getState().status, 'installed');
  for (const file of c.pin.expectedFiles) assert.equal(fs.statSync(path.join(c.target, file)).size > 0, true);
});

test('a recorded engine with one truncated file is not installed until Install repairs it', async (t) => {
  const c = build(t);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  fs.writeFileSync(path.join(c.target, 'ggml-cuda.dll'), 'x');
  assert.equal(c.service.getState().status, 'not_installed');
  assert.equal((await c.service.reconcileState()).status, 'not_installed');
  assert.deepEqual(c.service.resolveExecutable(), { ok: false, reason: 'image_engine_missing' });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(c.calls.length, 8);
  assert.equal(c.service.getState().status, 'installed');
  assert.equal(fs.statSync(path.join(c.target, 'ggml-cuda.dll')).size > 1, true);
});

test('a record for another commit is not installed, and an oversized record counts as no record', async (t) => {
  const c = build(t);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  const file = path.join(c.target, RECORD_NAME);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...record, commit: 'deadbee' }));
  assert.equal(c.service.getState().status, 'not_installed');
  fs.writeFileSync(file, 'x'.repeat(70_000));
  assert.equal(c.service.getState().status, 'installed');
});

test('an install from before the record keeps working through the state record', async (t) => {
  const c = build(t);
  fs.mkdirSync(c.target, { recursive: true });
  for (const file of c.pin.expectedFiles) fs.writeFileSync(path.join(c.target, file), `legacy ${file}`);
  writeState(c, c.manifest.tag);
  assert.equal(c.service.start().status, 'installed');
  assert.equal(c.service.resolveExecutable().source, 'managed');
  const network = forbidNetwork(c);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(network(), 0);
  assert.equal(c.probes.length, 1);
});

test('Install on a present healthy engine probes it without downloading or reporting installing', async (t) => {
  const c = build(t);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  const network = forbidNetwork(c);
  const before = c.states.length;
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(network(), 0);
  assert.equal(c.calls.length, 4);
  assert.equal(c.probes.length, 2);
  assert.equal(c.probes[1].file, path.join(c.target, 'sd-cli.exe'));
  assert.equal(c.states.slice(before).every((state) => state.status !== 'installing'), true);
  assert.equal(c.service.busy, false);
});

test('Install on a present engine whose probe fails reinstalls it', async (t) => {
  const c = build(t);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  const original = c.service.execFileImpl;
  let attempts = 0;
  c.service.execFileImpl = (file, args, settings, callback) => {
    attempts += 1;
    if (attempts === 1) { callback(null, '', 'garbage'); return { kill() {} }; }
    return original(file, args, settings, callback);
  };
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(attempts, 2);
  assert.equal(c.calls.length, 8);
  assert.equal(c.service.getState().status, 'installed');
  assert.equal(c.service.busy, false);
  c.service.execFileImpl = () => { throw new Error('spawn failed'); };
  assert.deepEqual(await c.service.install(ACCEPT), { ok: false, reason: 'image_engine_probe_failed' });
  assert.equal(c.service.busy, false);
});

test('a published directory with its record starts installed without state.json or with another tag', async (t) => {
  const c = build(t);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  for (const state of [null, 'master-older']) {
    fs.rmSync(path.join(c.root, 'state.json'), { force: true });
    if (state) writeState(c, state);
    const reopened = new ImageEngineService({ userDataPath: c.userDataPath, manifestPath: c.manifestPath,
      platform: 'win32', arch: 'x64', fetchImpl: () => { throw new Error('network forbidden'); } });
    t.after(() => reopened.dispose());
    assert.equal(reopened.start().status, 'installed');
    assert.equal(reopened.installedTag, c.manifest.tag);
    assert.equal(reopened.resolveExecutable().source, 'managed');
    assert.deepEqual(await reopened.cancel(), { ok: false, reason: 'install_already_published' });
  }
});

test('a state-write failure after publication still installs and a fresh instance adopts the files', async (t) => {
  const logs = [];
  const c = build(t, { serviceOptions: { logger: (...args) => logs.push(args), fsImpl: { ...fs, promises: { ...fs.promises,
    async writeFile(file, ...args) {
      if (path.basename(file).startsWith('state.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.promises.writeFile(file, ...args);
    } } } } });
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(c.service.getState().status, 'installed');
  assert.equal(c.service.getState().last_error, null);
  assert.equal(fs.existsSync(path.join(c.root, 'state.json')), false);
  assert.equal(logs.some((entry) => entry[1] === 'image_engine.state_write_failed'), true);
  const reopened = new ImageEngineService({ userDataPath: c.userDataPath, manifestPath: c.manifestPath,
    platform: 'win32', arch: 'x64', fetchImpl: () => { throw new Error('network forbidden'); } });
  t.after(() => reopened.dispose());
  assert.equal(reopened.start().status, 'installed');
});

test('install removes superseded recorded generations and leaves everything else in the engine root', async (t) => {
  const c = build(t);
  const outside = path.join(c.temp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, RECORD_NAME),
    JSON.stringify({ version: 1, tag: 'master-linked', commit: 'deadbee', files: {} }));
  const recorded = seedGeneration(c, 'master-recorded');
  const named = seedGeneration(c, 'master-named', { record: false });
  const unrecorded = seedGeneration(c, 'master-unrecorded', { record: false });
  const mismatched = seedGeneration(c, 'master-mismatched', { recordTag: 'master-other' });
  fs.mkdirSync(path.join(c.root, 'unrelated'));
  fs.symlinkSync(outside, path.join(c.root, 'master-linked'), 'junction');
  writeState(c, 'master-named');
  c.service.start();
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(fs.existsSync(recorded), false);
  assert.equal(fs.existsSync(named), false);
  assert.equal(fs.existsSync(unrecorded), true);
  assert.equal(fs.existsSync(mismatched), true);
  assert.equal(fs.existsSync(path.join(c.root, 'unrelated')), true);
  assert.deepEqual(fs.readdirSync(outside), [RECORD_NAME]);
  assert.equal(fs.existsSync(path.join(c.root, 'state.json')), true);
  assert.equal(c.service.getState().status, 'installed');
});

test('remove deletes superseded recorded generations and the current directory but keeps unrelated entries', async (t) => {
  const c = build(t);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  const recorded = seedGeneration(c, 'master-recorded');
  const unrecorded = seedGeneration(c, 'master-unrecorded', { record: false });
  fs.mkdirSync(path.join(c.root, 'unrelated'));
  assert.deepEqual(await c.service.remove(ACCEPT), { ok: true });
  assert.equal(fs.existsSync(c.target), false);
  assert.equal(fs.existsSync(recorded), false);
  assert.equal(fs.existsSync(unrecorded), true);
  assert.equal(fs.existsSync(path.join(c.root, 'unrelated')), true);
  assert.equal(fs.existsSync(path.join(c.root, 'state.json')), true);
  assert.equal(c.service.getState().status, 'not_installed');
});

test('a healthy Install clears the error left by an earlier failed repair', async (t) => {
  const options = {};
  const c = build(t, options);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  options.banner = 'not a banner';
  const fetchImpl = c.service.fetchImpl;
  c.service.fetchImpl = () => { throw new Error('offline'); };
  assert.equal((await c.service.install(ACCEPT)).ok, false);
  assert.equal(c.service.getState().status, 'error');
  options.banner = undefined;
  c.service.fetchImpl = fetchImpl;
  c.states.length = 0;
  const requests = c.calls.length;
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(c.calls.length, requests);
  assert.equal(c.service.getState().status, 'installed');
  assert.equal(c.service.getState().last_error, null);
  assert.equal(c.states.at(-1)?.status, 'installed');
});

test('a superseded generation that holds the custom executable is kept', async (t) => {
  const c = build(t);
  const kept = seedGeneration(c, 'master-custom');
  const gone = seedGeneration(c, 'master-recorded');
  assert.equal((await c.service.setCustomExecutable(path.join(kept, 'sd-cli.exe'))).ok, true);
  assert.deepEqual(await c.service.install(ACCEPT), { ok: true });
  assert.equal(fs.existsSync(path.join(kept, 'sd-cli.exe')), true);
  assert.equal(fs.existsSync(gone), false);
  assert.deepEqual(await c.service.remove(ACCEPT), { ok: true });
  assert.equal(fs.existsSync(path.join(kept, 'sd-cli.exe')), true);
});
