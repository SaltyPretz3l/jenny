const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { API_VERSION } = require('../services/backend/sidecar-client');
const {
  resolvePackagedSidecarLaunch,
  resolvePackagedSidecarLaunchAsync,
} = require('../services/backend/packaged-sidecar-launch');
const { EventEmitter } = require('events');
const { resolvePackagedLaunchProbe } = require('../scripts/packaging/packaging-launch-probe');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function sha256Text(value) {
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function withTempPackagedSidecar(options, fn) {
  const {
    artifactName = 'jenny-sidecar.exe',
    artifactContents = 'sidecar-binary',
    manifestOverrides = {},
    writeArtifact = true,
  } = options || {};
  const tmpDir = createTrackedTempDir('probe-test-');
  const sidecarDir = path.join(tmpDir, 'sidecar');
  const artifactPath = path.join(sidecarDir, artifactName);
  const artifactSha = sha256Text(artifactContents);
  fs.mkdirSync(sidecarDir, { recursive: true });
  if (writeArtifact) {
    fs.writeFileSync(artifactPath, artifactContents, 'utf8');
  }
  fs.writeFileSync(
    path.join(sidecarDir, 'manifest.json'),
    JSON.stringify({
      artifact_name: artifactName,
      api_version: API_VERSION,
      sha256: artifactSha,
      ...manifestOverrides,
    }),
    'utf8',
  );
  return fn({
    resourcesPath: tmpDir,
    sidecarDir,
    artifactPath,
  });
}

test('resolvePackagedLaunchProbe returns command for a valid packaged manifest', () => {
  withTempPackagedSidecar({}, ({ resourcesPath, sidecarDir }) => {
    const result = resolvePackagedLaunchProbe(resourcesPath);

    assert.equal(path.basename(result.command), 'jenny-sidecar.exe');
    assert.equal(result.source, 'packaged-binary');
    assert.deepEqual(result.args, []);
    assert.equal(path.dirname(result.command), path.resolve(sidecarDir));
  });
});

test('resolvePackagedSidecarLaunch resolves a valid packaged sidecar and probes --version', () => {
  withTempPackagedSidecar({}, ({ resourcesPath, artifactPath }) => {
    const spawnCalls = [];
    const spec = resolvePackagedSidecarLaunch({
      resourcesPath,
      spawnSyncImpl: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return {
          status: 0,
          stdout: `${API_VERSION}\n`,
          stderr: '',
        };
      },
    });

    assert.equal(spec.ok, true);
    assert.equal(spec.launchSource, 'packaged-binary');
    assert.equal(spec.launchCommand, path.resolve(artifactPath));
    assert.deepEqual(spec.launchArgs, []);
    assert.match(spec.packagedLaunchDetail, /validated/i);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, path.resolve(artifactPath));
    assert.deepEqual(spawnCalls[0].args, ['--version']);
  });
});

test('resolvePackagedSidecarLaunchAsync streams the hash and probes --version asynchronously', async () => {
  await withTempPackagedSidecar({}, async ({ resourcesPath, artifactPath }) => {
    const spawnCalls = [];
    const spec = await resolvePackagedSidecarLaunchAsync({
      resourcesPath,
      spawnImpl: (command, args) => {
        spawnCalls.push({ command, args });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
          child.stdout.emit('data', `${API_VERSION}\n`);
          child.emit('close', 0);
        });
        return child;
      },
    });

    assert.equal(spec.ok, true);
    assert.equal(spec.launchSource, 'packaged-binary');
    assert.equal(spec.launchCommand, path.resolve(artifactPath));
    assert.deepEqual(spec.launchArgs, []);
    assert.match(spec.packagedLaunchDetail, /validated/i);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, path.resolve(artifactPath));
    assert.deepEqual(spawnCalls[0].args, ['--version']);
  });
});

test('resolvePackagedSidecarLaunchAsync rejects checksum mismatch without spawning a probe', async () => {
  await withTempPackagedSidecar({
    manifestOverrides: { sha256: 'f'.repeat(64) },
  }, async ({ resourcesPath }) => {
    let spawned = false;
    const spec = await resolvePackagedSidecarLaunchAsync({
      resourcesPath,
      spawnImpl: () => {
        spawned = true;
        throw new Error('probe should not run on checksum mismatch');
      },
    });

    assert.equal(spec.ok, false);
    assert.equal(spawned, false);
    assert.match(spec.failureReason, /sha256 does not match manifest/i);
  });
});

test('resolvePackagedSidecarLaunch exposes packaged manifest build metadata', () => {
  withTempPackagedSidecar({
    manifestOverrides: {
      generated_at_utc: '2026-04-24T12:34:56Z',
    },
  }, ({ resourcesPath }) => {
    const spec = resolvePackagedSidecarLaunch({
      resourcesPath,
      probeVersion: false,
    });

    assert.equal(spec.ok, true);
    assert.equal(spec.manifestGeneratedAtUtc, '2026-04-24T12:34:56Z');
    assert.equal(spec.manifestSha256.length, 64);
    assert.equal(spec.artifactSha256, spec.manifestSha256);
    assert.match(spec.packagedLaunchDetail, /built 2026-04-24T12:34:56Z/i);
  });
});

test('resolvePackagedSidecarLaunch rejects manifest path escape attempts', () => {
  withTempPackagedSidecar({
    artifactName: '../evil.exe',
    manifestOverrides: { sha256: 'a'.repeat(64) },
    writeArtifact: false,
  }, ({ resourcesPath }) => {
    const spec = resolvePackagedSidecarLaunch({
      resourcesPath,
      probeVersion: false,
    });

    assert.equal(spec.ok, false);
    assert.match(spec.failureReason, /artifact_name must be a filename/i);
  });
});

test('resolvePackagedSidecarLaunch rejects api version mismatch', () => {
  withTempPackagedSidecar({
    manifestOverrides: { api_version: '1999-01-01' },
  }, ({ resourcesPath }) => {
    const spec = resolvePackagedSidecarLaunch({
      resourcesPath,
      probeVersion: false,
    });

    assert.equal(spec.ok, false);
    assert.match(spec.failureReason, /api_version mismatch/i);
  });
});

test('resolvePackagedSidecarLaunch rejects checksum mismatch', () => {
  withTempPackagedSidecar({
    manifestOverrides: { sha256: 'f'.repeat(64) },
  }, ({ resourcesPath }) => {
    const spec = resolvePackagedSidecarLaunch({
      resourcesPath,
      probeVersion: false,
    });

    assert.equal(spec.ok, false);
    assert.match(spec.failureReason, /sha256 does not match manifest/i);
  });
});

test('resolvePackagedSidecarLaunch rejects --version probe failure', () => {
  withTempPackagedSidecar({}, ({ resourcesPath }) => {
    const spec = resolvePackagedSidecarLaunch({
      resourcesPath,
      spawnSyncImpl: () => ({
        status: 23,
        stdout: '',
        stderr: 'probe failed',
      }),
    });

    assert.equal(spec.ok, false);
    assert.match(spec.failureReason, /--version probe failed/i);
  });
});
