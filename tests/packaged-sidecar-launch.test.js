'use strict';

const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolvePackagedSidecarLaunch,
  resolvePackagedSidecarLaunchAsync,
  sha256File,
  sha256FileAsync,
  DEFAULT_VERSION_TIMEOUT_MS,
  MANIFEST_NAME,
} = require('../services/backend/packaged-sidecar-launch');

// The real API_VERSION used by the module under test — keep in sync with sidecar-client.js
const API_VERSION = '2026-08-17';

// sha256 of 0 bytes — matches what buildFakeFs produces via readSync returning 0
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// A 64-hex-char placeholder hash used in negative tests (deliberately wrong value)
const DUMMY_SHA256 = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Helpers: fake fs and fake spawn builders
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake fsImpl for use in all tests.
 * existsMap: { [path]: boolean }
 * readMap:   { [path]: string | Error }
 */
function buildFakeFs({ existsMap = {}, readMap = {} } = {}) {
  const calls = { openSync: [], readSync: [], closeSync: [], existsSync: [], readFileSync: [] };

  return {
    calls,
    existsSync(p) {
      calls.existsSync.push(p);
      return Boolean(existsMap[p]);
    },
    readFileSync(p, enc) {
      calls.readFileSync.push({ p, enc });
      const val = readMap[p];
      if (val instanceof Error) throw val;
      if (val === undefined) throw new Error(`readFileSync: no stub for ${p}`);
      return val;
    },
    // sha256File synchronous streaming stubs
    openSync(p, mode) {
      calls.openSync.push({ p, mode });
      return 42; // fake handle
    },
    readSync(handle, buf, offset, length, pos) {
      calls.readSync.push({ handle, offset, length, pos });
      // Return 0 immediately so sha256File hashes an "empty" file
      return 0;
    },
    closeSync(handle) {
      calls.closeSync.push(handle);
    },
    // sha256FileAsync stream stub — returns an EventEmitter-based stream
    createReadStream(p, opts) {
      const stream = new EventEmitter();
      // Emit 'end' on next tick so hash resolves cleanly
      setImmediate(() => stream.emit('end'));
      return stream;
    },
  };
}

/**
 * Build a valid manifest JSON string for the given apiVersion.
 */
function buildManifestJson({
  artifact_name = 'sidecar-binary',
  api_version = API_VERSION,
  // Default to EMPTY_SHA256 so a fake readSync returning 0 bytes passes hash check
  sha256 = EMPTY_SHA256,
  generated_at_utc = '2026-01-01T00:00:00Z',
} = {}) {
  return JSON.stringify({ artifact_name, api_version, sha256, generated_at_utc });
}

/**
 * Build a fake fsImpl that presents a valid sidecar directory structure.
 * The caller can override individual values.
 */
function buildValidFs({ resourcesPath, artifactName = 'sidecar-binary', overrides = {} } = {}) {
  const path = require('path');
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  const artifactPath = path.resolve(sidecarDir, artifactName);

  const existsMap = {
    [sidecarDir]: true,
    [manifestPath]: true,
    [artifactPath]: true,
    ...overrides.existsMap,
  };

  const readMap = {
    [manifestPath]: buildManifestJson({ artifact_name: artifactName }),
    ...overrides.readMap,
  };

  return { fs: buildFakeFs({ existsMap, readMap }), sidecarDir, manifestPath, artifactPath };
}

/**
 * Build a fake spawnSyncImpl that returns a successful version-probe result
 * containing the API_VERSION string in stdout.
 */
function buildFakeSpawnSync({ status = 0, stdout = `${API_VERSION}`, stderr = '', error } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    if (error) return { error };
    return { status, stdout, stderr };
  };
  impl.calls = calls;
  return impl;
}

/**
 * Build a fake async spawnImpl (for resolvePackagedSidecarLaunchAsync).
 * Returns a fake child process that emits stdout data then closes.
 */
function buildFakeSpawn({ status = 0, stdoutData = `${API_VERSION}`, stderrData = '', throwOnSpawn = false } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    if (throwOnSpawn) throw new Error('spawn ENOENT');

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    setImmediate(() => {
      if (stdoutData) child.stdout.emit('data', stdoutData);
      child.emit('close', status);
    });

    return child;
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// sha256File — synchronous path
// ---------------------------------------------------------------------------

test('sha256File: hashes empty content via injected fsImpl (openSync/readSync/closeSync)', () => {
  const fakeFs = buildFakeFs();
  // readSync returns 0 bytes → empty file hash
  const result = sha256File('/fake/artifact', fakeFs);

  // sha256 of empty content
  const crypto = require('crypto');
  const expected = crypto.createHash('sha256').digest('hex');
  assert.equal(result, expected);
  assert.deepEqual(fakeFs.calls.openSync, [{ p: '/fake/artifact', mode: 'r' }]);
  assert.equal(fakeFs.calls.closeSync.length, 1);
  assert.equal(fakeFs.calls.closeSync[0], 42);
});

test('sha256File: closes handle even when readSync throws', () => {
  const calls = { openSync: [], readSync: [], closeSync: [] };
  const throwingFs = {
    openSync(p, mode) { calls.openSync.push(p); return 99; },
    readSync() { calls.readSync.push('called'); throw new Error('disk I/O error'); },
    closeSync(h) { calls.closeSync.push(h); },
  };

  assert.throws(() => sha256File('/fake/artifact', throwingFs), /disk I\/O error/);
  assert.equal(calls.closeSync.length, 1, 'closeSync must be called in finally');
  assert.equal(calls.closeSync[0], 99);
});

// ---------------------------------------------------------------------------
// sha256FileAsync — async streaming path
// ---------------------------------------------------------------------------

test('sha256FileAsync: resolves with hash of empty stream via injected createReadStream', async () => {
  const fakeFs = buildFakeFs();
  const result = await sha256FileAsync('/fake/artifact', fakeFs);

  const crypto = require('crypto');
  const expected = crypto.createHash('sha256').digest('hex');
  assert.equal(result, expected);
});

test('sha256FileAsync: rejects when stream emits error', async () => {
  const errFs = {
    createReadStream(p) {
      const stream = new EventEmitter();
      setImmediate(() => stream.emit('error', new Error('stream read failure')));
      return stream;
    },
  };

  await assert.rejects(() => sha256FileAsync('/fake/artifact', errFs), /stream read failure/);
});

// ---------------------------------------------------------------------------
// validatePackagedManifest via resolvePackagedSidecarLaunch — lines 114-205
// ---------------------------------------------------------------------------

test('resolvePackagedSidecarLaunch: fails when resourcesPath is empty (line 114-115)', () => {
  const fakeFs = buildFakeFs();
  const result = resolvePackagedSidecarLaunch({
    resourcesPath: '',
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /resources path is unavailable/i);
  assert.equal(result.launchCommand, '');
  assert.deepEqual(result.launchArgs, []);
  assert.equal(result.launchSource, 'packaged-binary');
  // existsSync must NOT be called — failure is before any fs access
  assert.equal(fakeFs.calls.existsSync.length, 0);
});

test('resolvePackagedSidecarLaunch: fails when sidecar directory is missing (lines 120-124)', () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const fakeFs = buildFakeFs({ existsMap: { [sidecarDir]: false } });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /sidecar directory is missing/i);
  assert.equal(result.sidecarDir, sidecarDir);
  // existsSync was called with the sidecar dir
  assert.ok(fakeFs.calls.existsSync.includes(sidecarDir));
});

test('resolvePackagedSidecarLaunch: fails when manifest file is missing (lines 126-130)', () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  const fakeFs = buildFakeFs({
    existsMap: {
      [sidecarDir]: true,
      [manifestPath]: false,
    },
  });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /manifest is missing/i);
  assert.equal(result.manifestPath, manifestPath);
});

test('resolvePackagedSidecarLaunch: fails when manifest JSON is invalid (lines 136-143)', () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  const fakeFs = buildFakeFs({
    existsMap: { [sidecarDir]: true, [manifestPath]: true },
    readMap: { [manifestPath]: '{ this is not json' },
  });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /manifest is invalid/i);
});

test('resolvePackagedSidecarLaunch: fails when manifest readFileSync throws (lines 136-143)', () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  const fakeFs = buildFakeFs({
    existsMap: { [sidecarDir]: true, [manifestPath]: true },
    readMap: { [manifestPath]: new Error('permission denied') },
  });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /manifest is invalid.*permission denied/i);
});

test('resolvePackagedSidecarLaunch: fails when manifest is an array (lines 145-149)', () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  const fakeFs = buildFakeFs({
    existsMap: { [sidecarDir]: true, [manifestPath]: true },
    readMap: { [manifestPath]: JSON.stringify([{ artifact_name: 'x' }]) },
  });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /manifest is invalid/i);
});

test('resolvePackagedSidecarLaunch: fails when manifest has no artifact_name (lines 153-157)', () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  const fakeFs = buildFakeFs({
    existsMap: { [sidecarDir]: true, [manifestPath]: true },
    readMap: { [manifestPath]: JSON.stringify({ api_version: API_VERSION, sha256: DUMMY_SHA256 }) },
  });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /missing artifact_name/i);
});

test('resolvePackagedSidecarLaunch: fails when manifest sha256 is invalid (lines 178-182)', () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  const fakeFs = buildFakeFs({
    existsMap: { [sidecarDir]: true, [manifestPath]: true },
    readMap: {
      [manifestPath]: JSON.stringify({
        artifact_name: 'sidecar-binary',
        api_version: API_VERSION,
        sha256: 'not-a-valid-sha256-value',
      }),
    },
  });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /sha256 is invalid/i);
});

test('resolvePackagedSidecarLaunch: fails when artifact_name escapes sidecar dir (lines 187-195)', () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  const fakeFs = buildFakeFs({
    existsMap: { [sidecarDir]: true, [manifestPath]: true },
    readMap: {
      [manifestPath]: JSON.stringify({
        artifact_name: '../escape',
        api_version: API_VERSION,
        sha256: DUMMY_SHA256,
      }),
    },
  });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  // Line 158-162 catches ../escape via basename check; line 187-195 catches resolved path
  // The basename guard fires first with "must be a filename" message
  assert.match(result.failureReason, /must be a filename/i);
});

test('resolvePackagedSidecarLaunch: fails when artifact file is missing (lines 197-205)', () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  const artifactPath = path.resolve(sidecarDir, 'sidecar-binary');
  const fakeFs = buildFakeFs({
    existsMap: {
      [sidecarDir]: true,
      [manifestPath]: true,
      [artifactPath]: false,
    },
    readMap: { [manifestPath]: buildManifestJson() },
  });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /artifact is missing/i);
  assert.equal(result.artifactPath, artifactPath);
});

// ---------------------------------------------------------------------------
// resolvePackagedSidecarLaunch — sync hash + version probe branches
// ---------------------------------------------------------------------------

test('resolvePackagedSidecarLaunch: fails when sha256File throws (lines 283-287)', () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const { fs: fakeFs } = buildValidFs({ resourcesPath });

  // Override openSync to throw
  fakeFs.openSync = (p) => { throw new Error('cannot open artifact'); };

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /unable to hash/i);
  assert.match(result.failureReason, /cannot open artifact/i);
});

test('resolvePackagedSidecarLaunch: fails when artifact sha256 does not match manifest', () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const { fs: fakeFs, artifactPath } = buildValidFs({ resourcesPath });

  // readSync returns some content so hash is non-empty and differs from DUMMY_SHA256
  let firstRead = true;
  fakeFs.readSync = (handle, buf, offset, length, pos) => {
    if (firstRead) {
      firstRead = false;
      buf[0] = 0xff;
      return 1;
    }
    return 0;
  };

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: buildFakeSpawnSync(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /sha256 does not match manifest/i);
  assert.equal(result.artifactPath, artifactPath);
});

test('resolvePackagedSidecarLaunch: records exact spawn args for version probe', () => {
  const resourcesPath = '/app/resources';
  const { fs: fakeFs, artifactPath } = buildValidFs({ resourcesPath });
  const fakeSpawnSync = buildFakeSpawnSync({ status: 0, stdout: `${API_VERSION}\n` });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: fakeSpawnSync,
  });

  assert.equal(result.ok, true);
  assert.equal(result.launchCommand, artifactPath);
  assert.deepEqual(result.launchArgs, []);
  assert.equal(result.launchSource, 'packaged-binary');
  assert.equal(fakeSpawnSync.calls.length, 1);
  assert.equal(fakeSpawnSync.calls[0].cmd, artifactPath);
  assert.deepEqual(fakeSpawnSync.calls[0].args, ['--version']);
  assert.equal(fakeSpawnSync.calls[0].opts.windowsHide, true);
  assert.equal(fakeSpawnSync.calls[0].opts.encoding, 'utf8');
});

test('resolvePackagedSidecarLaunch: skips version probe when probeVersion=false', () => {
  const resourcesPath = '/app/resources';
  const { fs: fakeFs } = buildValidFs({ resourcesPath });
  const fakeSpawnSync = buildFakeSpawnSync();

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: fakeSpawnSync,
    probeVersion: false,
  });

  assert.equal(result.ok, true);
  assert.equal(fakeSpawnSync.calls.length, 0, 'spawn must not be called when probeVersion=false');
});

test('resolvePackagedSidecarLaunch: fails when version probe returns error (lines 244-248)', () => {
  const resourcesPath = '/app/resources';
  const { fs: fakeFs } = buildValidFs({ resourcesPath });
  const fakeSpawnSync = buildFakeSpawnSync({ error: new Error('ENOENT probe failed') });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: fakeSpawnSync,
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /--version probe failed.*ENOENT probe failed/i);
  assert.equal(fakeSpawnSync.calls.length, 1);
});

test('resolvePackagedSidecarLaunch: fails when version probe exits non-zero', () => {
  const resourcesPath = '/app/resources';
  const { fs: fakeFs } = buildValidFs({ resourcesPath });
  const fakeSpawnSync = buildFakeSpawnSync({ status: 1, stdout: '', stderr: 'bad exit' });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: fakeSpawnSync,
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /--version probe failed with exit code 1/i);
});

test('resolvePackagedSidecarLaunch: fails when version output missing apiVersion (lines 257-261)', () => {
  const resourcesPath = '/app/resources';
  const { fs: fakeFs } = buildValidFs({ resourcesPath });
  const fakeSpawnSync = buildFakeSpawnSync({ status: 0, stdout: 'version 1999-01-01', stderr: '' });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: fakeSpawnSync,
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /missing expected api version/i);
  assert.ok(result.failureReason.includes(API_VERSION));
});

test('resolvePackagedSidecarLaunch: success spec shape has all required fields', () => {
  const resourcesPath = '/app/resources';
  const path = require('path');
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  const artifactPath = path.resolve(sidecarDir, 'sidecar-binary');
  const { fs: fakeFs } = buildValidFs({ resourcesPath });
  const fakeSpawnSync = buildFakeSpawnSync({ status: 0, stdout: `${API_VERSION}\n` });

  const result = resolvePackagedSidecarLaunch({
    resourcesPath,
    fsImpl: fakeFs,
    spawnSyncImpl: fakeSpawnSync,
  });

  assert.equal(result.ok, true);
  assert.equal(result.launchCommand, artifactPath);
  assert.deepEqual(result.launchArgs, []);
  assert.equal(result.launchSource, 'packaged-binary');
  assert.equal(result.manifestPath, manifestPath);
  assert.equal(result.sidecarDir, sidecarDir);
  assert.equal(result.artifactPath, artifactPath);
  assert.equal(result.artifactName, 'sidecar-binary');
  // Pin the exact hashes rather than asserting "is a string": the fake fs reads
  // 0 bytes so the artifact hash MUST equal the empty-content sha256, and the
  // manifest hash MUST match (otherwise we'd never reach the success spec).
  assert.equal(result.manifestSha256, EMPTY_SHA256);
  assert.equal(result.artifactSha256, EMPTY_SHA256);
  assert.match(result.packagedLaunchDetail, /validated via manifest/i);
});

// ---------------------------------------------------------------------------
// resolvePackagedSidecarLaunchAsync — async path (lines 315-357)
// ---------------------------------------------------------------------------

test('resolvePackagedSidecarLaunchAsync: returns failure when validation fails (lines 325-326)', async () => {
  const fakeFs = buildFakeFs(); // no existsMap entries → sidecar dir missing
  const resourcesPath = '/app/resources';

  // Patch existsSync to always return false for sidecar dir
  const path = require('path');
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  fakeFs.existsSync = (p) => false;

  const result = await resolvePackagedSidecarLaunchAsync({
    resourcesPath,
    fsImpl: fakeFs,
    spawnImpl: buildFakeSpawn(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /sidecar directory is missing/i);
});

test('resolvePackagedSidecarLaunchAsync: fails when sha256FileAsync throws (lines 333-337)', async () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const { fs: fakeFs, artifactPath } = buildValidFs({ resourcesPath });

  // Override createReadStream to emit an error
  fakeFs.createReadStream = (p) => {
    const stream = new EventEmitter();
    setImmediate(() => stream.emit('error', new Error('async read failed')));
    return stream;
  };

  const result = await resolvePackagedSidecarLaunchAsync({
    resourcesPath,
    fsImpl: fakeFs,
    spawnImpl: buildFakeSpawn(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /unable to hash/i);
  assert.match(result.failureReason, /async read failed/i);
  assert.equal(result.artifactPath, artifactPath);
});

test('resolvePackagedSidecarLaunchAsync: fails when async hash does not match manifest (async counterpart)', async () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const { fs: fakeFs, artifactPath } = buildValidFs({ resourcesPath });

  // Emit a data chunk so hash is non-empty and differs from DUMMY_SHA256
  fakeFs.createReadStream = (p) => {
    const stream = new EventEmitter();
    setImmediate(() => {
      stream.emit('data', Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      stream.emit('end');
    });
    return stream;
  };

  const result = await resolvePackagedSidecarLaunchAsync({
    resourcesPath,
    fsImpl: fakeFs,
    spawnImpl: buildFakeSpawn(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /sha256 does not match manifest/i);
  assert.equal(result.artifactPath, artifactPath);
});

test('resolvePackagedSidecarLaunchAsync: fails when async version probe has error (lines 353-354)', async () => {
  const resourcesPath = '/app/resources';
  const { fs: fakeFs } = buildValidFs({ resourcesPath });

  // spawnImpl throws so spawnVersionProbeAsync catches and returns {error}
  const fakeSpawn = buildFakeSpawn({ throwOnSpawn: true });

  const result = await resolvePackagedSidecarLaunchAsync({
    resourcesPath,
    fsImpl: fakeFs,
    spawnImpl: fakeSpawn,
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /--version probe failed/i);
});

test('resolvePackagedSidecarLaunchAsync: records exact spawn args for version probe', async () => {
  const resourcesPath = '/app/resources';
  const { fs: fakeFs, artifactPath } = buildValidFs({ resourcesPath });
  const fakeSpawn = buildFakeSpawn({ status: 0, stdoutData: `${API_VERSION}\n` });

  const result = await resolvePackagedSidecarLaunchAsync({
    resourcesPath,
    fsImpl: fakeFs,
    spawnImpl: fakeSpawn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.launchCommand, artifactPath);
  assert.equal(fakeSpawn.calls.length, 1);
  assert.equal(fakeSpawn.calls[0].cmd, artifactPath);
  assert.deepEqual(fakeSpawn.calls[0].args, ['--version']);
  assert.equal(fakeSpawn.calls[0].opts.windowsHide, true);
});

test('resolvePackagedSidecarLaunchAsync: skips version probe when probeVersion=false', async () => {
  const resourcesPath = '/app/resources';
  const { fs: fakeFs } = buildValidFs({ resourcesPath });
  const fakeSpawn = buildFakeSpawn();

  const result = await resolvePackagedSidecarLaunchAsync({
    resourcesPath,
    fsImpl: fakeFs,
    spawnImpl: fakeSpawn,
    probeVersion: false,
  });

  assert.equal(result.ok, true);
  assert.equal(fakeSpawn.calls.length, 0, 'spawn must not fire when probeVersion=false');
});

test('resolvePackagedSidecarLaunchAsync: success spec has all required fields', async () => {
  const path = require('path');
  const resourcesPath = '/app/resources';
  const sidecarDir = path.resolve(resourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  const artifactPath = path.resolve(sidecarDir, 'sidecar-binary');
  const { fs: fakeFs } = buildValidFs({ resourcesPath });
  const fakeSpawn = buildFakeSpawn({ status: 0, stdoutData: `${API_VERSION}\n` });

  const result = await resolvePackagedSidecarLaunchAsync({
    resourcesPath,
    fsImpl: fakeFs,
    spawnImpl: fakeSpawn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.launchCommand, artifactPath);
  assert.deepEqual(result.launchArgs, []);
  assert.equal(result.launchSource, 'packaged-binary');
  assert.equal(result.manifestPath, manifestPath);
  assert.equal(result.sidecarDir, sidecarDir);
  assert.equal(result.artifactPath, artifactPath);
  assert.equal(result.artifactName, 'sidecar-binary');
  // Async path streams an empty file (fake createReadStream emits only 'end'),
  // so the hashed artifact MUST equal the empty-content sha256.
  assert.equal(result.artifactSha256, EMPTY_SHA256);
  assert.match(result.packagedLaunchDetail, /built 2026-01-01/i);
  // Cold-start audit input: the async path reports how long integrity
  // validation cost (probeMs stays null when probeVersion=false).
  assert.ok(Number.isFinite(result.validationTimings.hashMs) && result.validationTimings.hashMs >= 0);
  assert.ok(Number.isFinite(result.validationTimings.probeMs) && result.validationTimings.probeMs >= 0);
});

test('resolvePackagedSidecarLaunchAsync: validationTimings carries a null probeMs when the probe is skipped', async () => {
  const resourcesPath = '/app/resources';
  const { fs: fakeFs } = buildValidFs({ resourcesPath });

  const result = await resolvePackagedSidecarLaunchAsync({
    resourcesPath,
    fsImpl: fakeFs,
    spawnImpl: buildFakeSpawn(),
    probeVersion: false,
  });

  assert.equal(result.ok, true);
  assert.ok(Number.isFinite(result.validationTimings.hashMs));
  assert.equal(result.validationTimings.probeMs, null);
});

// ---------------------------------------------------------------------------
// spawnVersionProbeAsync — internal edge cases via resolvePackagedSidecarLaunchAsync
// ---------------------------------------------------------------------------

test('spawnVersionProbeAsync: timeout branch fires after versionTimeoutMs (lines 84-89)', async () => {
  const resourcesPath = '/app/resources';
  const { fs: fakeFs } = buildValidFs({ resourcesPath });

  // spawnImpl returns a child that never emits close, so the timeout fires
  const stallCalls = [];
  const stalledSpawn = (cmd, args, opts) => {
    stallCalls.push({ cmd, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {}; // best-effort kill; does nothing in fake
    // Deliberately never emit 'close' so the timeout wins
    return child;
  };

  const result = await resolvePackagedSidecarLaunchAsync({
    resourcesPath,
    fsImpl: fakeFs,
    spawnImpl: stalledSpawn,
    versionTimeoutMs: 20, // tiny timeout so the test is fast
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason, /--version probe failed/i);
  assert.equal(stallCalls.length, 1);
  assert.deepEqual(stallCalls[0].args, ['--version']);
});

test('spawnVersionProbeAsync: settled guard prevents double-resolution (lines 77-78)', async () => {
  // Drive two concurrent resolution paths: close fires first, then a synthetic
  // error fires. The second event must be silently dropped.
  const resourcesPath = '/app/resources';
  const { fs: fakeFs } = buildValidFs({ resourcesPath });

  let childRef = null;
  const doubleFireSpawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    childRef = child;
    // Emit close (success) on next tick
    setImmediate(() => {
      if (child.stdout) child.stdout.emit('data', `${API_VERSION}`);
      child.emit('close', 0);
      // Then fire an error — the settled guard must ignore it
      setImmediate(() => child.emit('error', new Error('late error')));
    });
    return child;
  };

  const result = await resolvePackagedSidecarLaunchAsync({
    resourcesPath,
    fsImpl: fakeFs,
    spawnImpl: doubleFireSpawn,
  });

  // The FIRST settlement (close, status=0, API_VERSION in stdout) must win and
  // produce the full success spec — the late 'error' must be silently dropped.
  // If the late error had leaked through it would have produced a failure spec
  // with failureReason /--version probe failed.*late error/, so pin the
  // success-only fields to prove the close path is the one that settled.
  // NOTE: the `if (settled) return` guard itself is an EQUIVALENT MUTANT w.r.t.
  // the resolved value — a Promise ignores a second resolve() regardless — so
  // this oracle pins the observable contract (close wins, error dropped) rather
  // than the unobservable double-resolve mechanics.
  assert.equal(result.ok, true);
  assert.equal(result.launchSource, 'packaged-binary');
  assert.equal(result.artifactSha256, EMPTY_SHA256);
  assert.match(result.packagedLaunchDetail, /validated via manifest/i);
  assert.equal(result.failureReason, undefined);
});

// ---------------------------------------------------------------------------
// Exports shape
// ---------------------------------------------------------------------------

test('module exports expected names and types', () => {
  assert.equal(typeof resolvePackagedSidecarLaunch, 'function');
  assert.equal(typeof resolvePackagedSidecarLaunchAsync, 'function');
  assert.equal(typeof sha256File, 'function');
  assert.equal(typeof sha256FileAsync, 'function');
  assert.equal(typeof DEFAULT_VERSION_TIMEOUT_MS, 'number');
  assert.ok(DEFAULT_VERSION_TIMEOUT_MS > 0);
  assert.equal(typeof MANIFEST_NAME, 'string');
  assert.equal(MANIFEST_NAME, 'manifest.json');
});
