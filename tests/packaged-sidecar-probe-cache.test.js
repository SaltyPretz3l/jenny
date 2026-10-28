'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { API_VERSION } = require('../services/backend/sidecar-client');
const {
  PROBE_CACHE_FILENAME,
  resolvePackagedSidecarLaunchAsync,
} = require('../services/backend/packaged-sidecar-launch');
const {
  invalidateProbeCacheOnStartupFailure,
  readProbeCacheHit,
} = require('../services/backend/packaged-sidecar-probe-cache');
const { createBackendServiceWithDeps } = require('../services/main/backend-service-wiring');
const { ShellConfigService } = require('../services/shell-config-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// A real resources tree: sidecar/manifest.json + an artifact whose sha256 the
// manifest pins. The probe itself is a fake spawn, so nothing executes.
function buildResources({ artifactBytes = 'sidecar-bytes-v1' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-probe-cache-'));
  trackDirectory(root);
  const resourcesPath = path.join(root, 'resources');
  const sidecarDir = path.join(resourcesPath, 'sidecar');
  fs.mkdirSync(sidecarDir, { recursive: true });
  const artifactPath = path.join(sidecarDir, 'sidecar-binary');
  const writeArtifact = (bytes) => {
    fs.writeFileSync(artifactPath, bytes);
    fs.writeFileSync(path.join(sidecarDir, 'manifest.json'), JSON.stringify({
      artifact_name: 'sidecar-binary',
      api_version: API_VERSION,
      build_platform: process.platform,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      generated_at_utc: '2026-10-19T00:00:00Z',
    }));
  };
  writeArtifact(artifactBytes);
  const userDataPath = path.join(root, 'userData');
  return { root, resourcesPath, sidecarDir, artifactPath, userDataPath, writeArtifact,
    cachePath: path.join(userDataPath, PROBE_CACHE_FILENAME) };
}

function buildFakeSpawn({ status = 0, output = `${API_VERSION}\n` } = {}) {
  const calls = [];
  const impl = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stderr.emit('data', output);
      child.emit('close', status);
    });
    return child;
  };
  impl.calls = calls;
  return impl;
}

function resolveWith(fixture, spawnImpl, overrides = {}) {
  return resolvePackagedSidecarLaunchAsync({
    resourcesPath: fixture.resourcesPath,
    spawnImpl,
    probeCachePath: fixture.cachePath,
    appVersion: '1.5.0',
    ...overrides,
  });
}

test('probe cache: a miss probes and records; the next launch skips the probe', async () => {
  const fixture = buildResources();
  const spawnImpl = buildFakeSpawn();

  const first = await resolveWith(fixture, spawnImpl);
  assert.equal(first.ok, true);
  assert.equal(spawnImpl.calls.length, 1);
  assert.equal(first.validationTimings.probeCached, false);
  assert.ok(Number.isFinite(first.validationTimings.probeMs));
  assert.equal(fs.existsSync(fixture.cachePath), true);

  const second = await resolveWith(fixture, spawnImpl);
  assert.equal(second.ok, true);
  assert.equal(spawnImpl.calls.length, 1, 'a cache hit must not spawn the --version probe');
  assert.equal(second.validationTimings.probeCached, true);
  assert.equal(second.validationTimings.probeMs, null);
  assert.ok(Number.isFinite(second.validationTimings.hashMs));
  assert.equal(second.probeCachePath, fixture.cachePath);
  assert.match(second.packagedLaunchDetail, /cached version probe/);
});

test('probe cache: an app-version or api-version change re-probes', async () => {
  const fixture = buildResources();
  const spawnImpl = buildFakeSpawn();
  await resolveWith(fixture, spawnImpl);
  await resolveWith(fixture, spawnImpl, { appVersion: '1.5.1' });
  assert.equal(spawnImpl.calls.length, 2);
  // The 1.5.1 probe replaced the entry, so 1.5.1 now hits and 1.5.0 misses.
  await resolveWith(fixture, spawnImpl, { appVersion: '1.5.1' });
  assert.equal(spawnImpl.calls.length, 2);
  const otherApi = await resolveWith(fixture, buildFakeSpawn({ output: '2099-01-01\n' }), { apiVersion: '2099-01-01' });
  // The manifest pins API_VERSION, so a different expected api version fails
  // at the manifest check before the cache is consulted.
  assert.equal(otherApi.ok, false);
});

test('probe cache: a replaced artifact is hash-checked every launch and re-probed', async () => {
  const fixture = buildResources();
  const spawnImpl = buildFakeSpawn();
  await resolveWith(fixture, spawnImpl);

  // Same manifest, different bytes: the hash check fails although a cache entry exists.
  fs.writeFileSync(fixture.artifactPath, 'tampered-bytes');
  const tampered = await resolveWith(fixture, spawnImpl);
  assert.equal(tampered.ok, false);
  assert.match(tampered.failureReason, /sha256 does not match/);
  assert.equal(spawnImpl.calls.length, 1);

  // A legitimate update (new bytes + manifest) misses the cache and probes.
  fixture.writeArtifact('sidecar-bytes-v2');
  const updated = await resolveWith(fixture, spawnImpl);
  assert.equal(updated.ok, true);
  assert.equal(updated.validationTimings.probeCached, false);
  assert.equal(spawnImpl.calls.length, 2);
});

test('probe cache: a failed probe is never cached and drops a stale entry', async () => {
  const fixture = buildResources();
  await resolveWith(fixture, buildFakeSpawn(), { appVersion: '1.4.0' });
  assert.equal(fs.existsSync(fixture.cachePath), true);

  const failing = buildFakeSpawn({ status: 1, output: '' });
  const result = await resolveWith(fixture, failing);
  assert.equal(result.ok, false);
  assert.match(result.failureReason, /--version probe failed/);
  assert.equal(fs.existsSync(fixture.cachePath), false);

  const again = await resolveWith(fixture, failing);
  assert.equal(again.ok, false);
  assert.equal(failing.calls.length, 2, 'a failure must keep probing');
});

test('probe cache: a corrupt or foreign cache file is a miss, and no path means always probe', async () => {
  const fixture = buildResources();
  fs.mkdirSync(fixture.userDataPath, { recursive: true });
  fs.writeFileSync(fixture.cachePath, '{not json');
  const spawnImpl = buildFakeSpawn();
  const corrupt = await resolveWith(fixture, spawnImpl);
  assert.equal(corrupt.ok, true);
  assert.equal(spawnImpl.calls.length, 1);

  const noCache = buildFakeSpawn();
  for (let index = 0; index < 2; index += 1) {
    const result = await resolveWith(fixture, noCache, { probeCachePath: '' });
    assert.equal(result.ok, true);
    assert.equal(result.validationTimings.probeCached, false);
    assert.equal(result.probeCachePath, undefined);
  }
  assert.equal(noCache.calls.length, 2);
  assert.equal(readProbeCacheHit('', { artifactPath: 'x' }), false);
});

test('startup-failure watch: an exit before ready drops the entry; after ready it is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-probe-watch-'));
  trackDirectory(dir);
  const cachePath = path.join(dir, PROBE_CACHE_FILENAME);
  const logs = [];
  const log = (level, event, details) => logs.push({ level, event, details });

  fs.writeFileSync(cachePath, '{}');
  const failing = new EventEmitter();
  invalidateProbeCacheOnStartupFailure(failing, cachePath, { log });
  failing.emit('status', { phase: 'starting', startupStage: 'spawned' });
  assert.equal(fs.existsSync(cachePath), true);
  failing.emit('status', { phase: 'failed', startupStage: 'spawn_exit' });
  assert.equal(fs.existsSync(cachePath), false);
  assert.deepEqual(logs.map((entry) => entry.event), ['sidecar.packaged_probe_cache_invalidated']);
  assert.equal(failing.listenerCount('status'), 0);

  fs.writeFileSync(cachePath, '{}');
  const healthy = new EventEmitter();
  invalidateProbeCacheOnStartupFailure(healthy, cachePath, { log });
  healthy.emit('status', { phase: 'ready', startupStage: 'spawned' });
  assert.equal(healthy.listenerCount('status'), 0);
  healthy.emit('status', { phase: 'failed', startupStage: 'spawn_exit' });
  assert.equal(fs.existsSync(cachePath), true, 'a runtime crash after ready keeps the entry');
});

test('backend wiring: packaged launch uses the userData probe cache and logs validationTimings', async () => {
  const fixture = buildResources();
  fs.mkdirSync(fixture.userDataPath, { recursive: true });
  const logs = [];
  const created = createBackendServiceWithDeps({
    app: { getVersion: () => '0.0.0-test', getPath: () => fixture.userDataPath, isReady: () => true, isPackaged: true },
    processRef: { env: {}, argv: [], platform: process.platform, resourcesPath: fixture.resourcesPath, cwd: () => fixture.root },
    safeStorage: createFakeSafeStorage(),
    dialog: {},
    shellConfigService: new ShellConfigService({ userDataPath: fixture.userDataPath, env: {} }),
    personalityWorkspace: {},
    worktreeService: { describeStatus: () => ({ ok: true }) },
    skillsService: { getBundledRoot: () => '', on: () => {} },
    mcpDiscoveryService: { setBackendService: () => {} },
    getMainWindow: () => undefined,
    log: (level, event, details) => logs.push({ level, event, details }),
    shouldUsePackagedSidecarRuntime: () => true,
  });
  const manager = created.backendService.sidecarManager;
  try {
    // Seed the entry a previous launch's successful probe would have written.
    const stat = fs.statSync(fixture.artifactPath);
    fs.writeFileSync(fixture.cachePath, JSON.stringify({
      schemaVersion: 1,
      artifactPath: fixture.artifactPath,
      artifactSha256: crypto.createHash('sha256').update(fs.readFileSync(fixture.artifactPath)).digest('hex'),
      artifactSize: stat.size,
      artifactMtimeMs: stat.mtimeMs,
      apiVersion: API_VERSION,
      appVersion: '0.0.0-test',
    }));

    const spec = await manager._resolvePackagedLaunch();
    assert.equal(spec.ok, true, spec.failureReason);
    assert.equal(spec.validationTimings.probeCached, true);
    const resolved = logs.find((entry) => entry.event === 'sidecar.packaged_launch_resolved');
    assert.equal(resolved.details.validationTimings.probeCached, true);
    assert.equal(resolved.details.validationTimings.probeMs, null);
    assert.ok(Number.isFinite(resolved.details.validationTimings.hashMs));

    manager.emit('status', { phase: 'failed', startupStage: 'spawn_error' });
    assert.equal(fs.existsSync(fixture.cachePath), false, 'a start failure after a cache hit invalidates it');
  } finally {
    created.backendService.dispose?.();
  }
});
