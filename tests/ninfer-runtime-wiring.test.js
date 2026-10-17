'use strict';

// backendService.ninferRuntime (row 54 Step 6): flag-off builds an inert stub
// (no probe, no disk); flag-on bundles installer, downloader and the memoized
// eligibility probe and forwards their change events as one snapshot.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createNinferRuntime } = require('../services/main/ninfer-runtime-wiring');

class FakeInstall extends EventEmitter {
  constructor(options) { super(); this.options = options; this.started = 0; this.disposed = 0; }
  start() { this.started += 1; }
  getState() { return { status: 'not_installed' }; }
  dispose() { this.disposed += 1; }
}
class FakeArtifacts extends EventEmitter {
  constructor(options) { super(); this.options = options; this.disposed = 0; }
  getState() { return { status: 'idle' }; }
  dispose() { this.disposed += 1; }
}

test('flag off: an inert stub that refuses eligibility without probing', async () => {
  const runtime = createNinferRuntime({ userDataPath: 'C:/u', flags: { ninfer: false }, InstallService: FakeInstall, ArtifactService: FakeArtifacts });
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.install, null);
  assert.equal(runtime.artifacts, null);
  assert.deepEqual(await runtime.eligibility(), { eligible: false, reason: 'ninfer_flag_off', device: null, probed: false });
  assert.deepEqual(runtime.getState(), { enabled: false });
});

test('flag on: services share the userData root, start once, and changes emit one snapshot', () => {
  const runtime = createNinferRuntime({ userDataPath: 'C:/u', flags: { ninfer: true }, platform: 'linux', InstallService: FakeInstall, ArtifactService: FakeArtifacts });
  assert.equal(runtime.enabled, true);
  assert.equal(runtime.install.options.userDataPath, 'C:/u');
  assert.equal(runtime.artifacts.options.userDataPath, 'C:/u');
  assert.equal(runtime.install.started, 1);
  const snapshots = [];
  runtime.on('changed', (state) => snapshots.push(state));
  runtime.install.emit('changed');
  runtime.artifacts.emit('changed');
  assert.deepEqual(snapshots, [
    { enabled: true, install: { status: 'not_installed' }, artifacts: { status: 'idle' } },
    { enabled: true, install: { status: 'not_installed' }, artifacts: { status: 'idle' } },
  ]);
  runtime.dispose();
  assert.equal(runtime.install.disposed, 1);
  assert.equal(runtime.artifacts.disposed, 1);
});

test('flag on, off-platform: the eligibility probe refuses without nvidia-smi', async () => {
  const runtime = createNinferRuntime({ userDataPath: 'C:/u', flags: { ninfer: true }, platform: 'linux', InstallService: FakeInstall, ArtifactService: FakeArtifacts });
  assert.deepEqual(await runtime.eligibility(), { eligible: false, reason: 'ninfer_platform_unsupported', device: null, probed: false });
});
