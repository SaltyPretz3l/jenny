'use strict';

// The electron-builder afterPack hook (build/afterPack.js): executable bits on
// macOS and Linux, and the re-recorded sidecar hash on signed Windows builds.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

test('macOS packaging fails closed when the uninstall helper cannot be made executable', async () => {
  const afterPack = require('../build/afterPack');
  const originalChmodSync = fs.chmodSync;
  fs.chmodSync = () => { throw new Error('chmod denied'); };
  try {
    await assert.rejects(afterPack({
      electronPlatformName: 'darwin',
      appOutDir: path.join(ROOT, 'missing-app-output'),
      packager: { appInfo: { productFilename: 'Jenny' } },
    }), /could not make uninstall helper executable/);
  } finally {
    fs.chmodSync = originalChmodSync;
  }
});

function writeEmptyFile(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '');
}

test('Linux packaging makes the packaged sidecar, team bridge and CLI shim executable', async () => {
  const afterPack = require('../build/afterPack');
  const appOutDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-linux-afterpack-'));
  const sidecar = path.join(appOutDir, 'resources', 'sidecar', 'sidecar');
  const bridge = path.join(appOutDir, 'resources', 'sidecar', 'jenny-team-bridge');
  const shim = path.join(appOutDir, 'resources', 'bin', 'jenny');
  writeEmptyFile(sidecar);
  writeEmptyFile(bridge);
  writeEmptyFile(shim);
  const originalChmodSync = fs.chmodSync;
  const chmodCalls = [];
  fs.chmodSync = (target, mode) => { chmodCalls.push([target, mode]); };
  try {
    await afterPack({
      electronPlatformName: 'linux',
      appOutDir,
    });
    assert.deepEqual(chmodCalls, [[sidecar, 0o755], [bridge, 0o755], [shim, 0o755]]);
  } finally {
    fs.chmodSync = originalChmodSync;
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

test('Linux packaging fails closed when the packaged team bridge is missing', async () => {
  const afterPack = require('../build/afterPack');
  const appOutDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-linux-afterpack-'));
  writeEmptyFile(path.join(appOutDir, 'resources', 'sidecar', 'sidecar'));
  writeEmptyFile(path.join(appOutDir, 'resources', 'bin', 'jenny'));
  const originalChmodSync = fs.chmodSync;
  fs.chmodSync = () => {};
  try {
    await assert.rejects(afterPack({
      electronPlatformName: 'linux',
      appOutDir,
    }), /packaged team bridge missing at .*sidecar[\\/]jenny-team-bridge/);
  } finally {
    fs.chmodSync = originalChmodSync;
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

test('Linux packaging fails closed when the packaged CLI shim is missing', async () => {
  const afterPack = require('../build/afterPack');
  const appOutDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-linux-afterpack-'));
  writeEmptyFile(path.join(appOutDir, 'resources', 'sidecar', 'sidecar'));
  writeEmptyFile(path.join(appOutDir, 'resources', 'sidecar', 'jenny-team-bridge'));
  const originalChmodSync = fs.chmodSync;
  fs.chmodSync = () => {};
  try {
    await assert.rejects(afterPack({
      electronPlatformName: 'linux',
      appOutDir,
    }), /packaged CLI shim missing at .*bin[\\/]jenny/);
  } finally {
    fs.chmodSync = originalChmodSync;
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

function writeWindowsSidecar(appOutDir, artifactBytes, manifestSha256) {
  const sidecarDir = path.join(appOutDir, 'resources', 'sidecar');
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(path.join(sidecarDir, 'sidecar.exe'), artifactBytes);
  const manifestPath = path.join(sidecarDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({ artifact_name: 'sidecar.exe', sha256: manifestSha256 }, null, 2)}\n`);
  return manifestPath;
}

const sha256Hex = (bytes) => require('node:crypto').createHash('sha256').update(bytes).digest('hex');

test('Windows packaging re-records the sidecar hash after signing changed the bytes', async () => {
  const afterPack = require('../build/afterPack');
  const appOutDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-win-afterpack-'));
  try {
    const unsigned = sha256Hex('unsigned');
    const manifestPath = writeWindowsSidecar(appOutDir, 'signed bytes', unsigned);
    await afterPack({ electronPlatformName: 'win32', appOutDir });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.sha256, sha256Hex('signed bytes'));
    assert.equal(manifest.unsigned_sha256, unsigned);
    assert.equal(manifest.artifact_name, 'sidecar.exe');
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

test('Windows packaging leaves an unsigned sidecar manifest byte for byte', async () => {
  const afterPack = require('../build/afterPack');
  const appOutDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-win-afterpack-'));
  try {
    const manifestPath = writeWindowsSidecar(appOutDir, 'same bytes', sha256Hex('same bytes'));
    const before = fs.readFileSync(manifestPath, 'utf8');
    await afterPack({ electronPlatformName: 'win32', appOutDir });
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

test('Windows packaging fails closed when the packaged sidecar manifest is missing', async () => {
  const afterPack = require('../build/afterPack');
  const appOutDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-win-afterpack-'));
  try {
    await assert.rejects(afterPack({ electronPlatformName: 'win32', appOutDir }), /packaged sidecar manifest missing/);
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

test('macOS packaging makes the bundled team bridge and CLI shim executable when present', async () => {
  const afterPack = require('../build/afterPack');
  const appOutDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-darwin-afterpack-'));
  const resources = path.join(appOutDir, 'Jenny.app', 'Contents', 'Resources');
  const bridge = path.join(resources, 'sidecar', 'jenny-team-bridge');
  const shim = path.join(resources, 'bin', 'jenny');
  writeEmptyFile(bridge);
  writeEmptyFile(shim);
  const originalChmodSync = fs.chmodSync;
  const chmodCalls = [];
  fs.chmodSync = (target, mode) => { chmodCalls.push([target, mode]); };
  try {
    await afterPack({
      electronPlatformName: 'darwin',
      appOutDir,
      packager: { appInfo: { productFilename: 'Jenny' } },
    });
    // The sidecar is absent here, so only the bridge, the shim and the uninstall helper are touched.
    assert.deepEqual(chmodCalls, [
      [bridge, 0o755],
      [shim, 0o755],
      [path.join(ROOT, 'uninstall.command'), 0o755],
    ]);
  } finally {
    fs.chmodSync = originalChmodSync;
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

test('Linux packaging fails closed when the packaged sidecar is missing', async () => {
  const afterPack = require('../build/afterPack');
  const appOutDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-linux-afterpack-'));
  const originalChmodSync = fs.chmodSync;
  fs.chmodSync = () => {};
  try {
    await assert.rejects(afterPack({
      electronPlatformName: 'linux',
      appOutDir,
    }), /packaged sidecar missing/);
  } finally {
    fs.chmodSync = originalChmodSync;
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

test('Linux packaging fails closed when the packaged sidecar chmod fails', async () => {
  const afterPack = require('../build/afterPack');
  const appOutDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-linux-afterpack-'));
  const sidecar = path.join(appOutDir, 'resources', 'sidecar', 'sidecar');
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, '');
  const originalChmodSync = fs.chmodSync;
  fs.chmodSync = () => { throw new Error('chmod denied'); };
  try {
    await assert.rejects(afterPack({
      electronPlatformName: 'linux',
      appOutDir,
    }), /could not make the packaged sidecar executable/);
  } finally {
    fs.chmodSync = originalChmodSync;
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});

test('afterPack changes no file modes on Windows', async () => {
  const afterPack = require('../build/afterPack');
  const appOutDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-win-afterpack-'));
  writeWindowsSidecar(appOutDir, 'bytes', sha256Hex('bytes'));
  const originalChmodSync = fs.chmodSync;
  let chmodCalls = 0;
  fs.chmodSync = () => { chmodCalls += 1; };
  try {
    await afterPack({ electronPlatformName: 'win32', appOutDir });
    assert.equal(chmodCalls, 0);
  } finally {
    fs.chmodSync = originalChmodSync;
    fs.rmSync(appOutDir, { recursive: true, force: true });
  }
});
