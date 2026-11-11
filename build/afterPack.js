'use strict';

// electron-builder afterPack hook.
//
// Ensures the packaged PyInstaller sidecar binary, the team bridge binary
// (resources/sidecar/jenny-team-bridge) and the `jenny` CLI shim
// (resources/bin/jenny, copied from build/cli) are executable on macOS and
// Linux. A file copied in via extraResources can arrive without its +x bit,
// which makes the app's startup `--version` probe (or the `jenny` command)
// fail with EACCES. Linux fails closed. sidecar.exe and jenny.cmd need no +x
// bit on Windows.
//
// On Windows it instead re-records the packaged sidecar's sha256. A signed
// build signs every extraResources .exe while copying it, before this hook
// runs, which changes sidecar.exe's bytes after build_sidecar_artifact.py
// hashed them; packaged-sidecar-launch.js refuses to start a sidecar whose
// hash differs from resources/sidecar/manifest.json. The build-time hash is
// kept as `unsigned_sha256` so the SBOM still traces to it. An unsigned build
// hashes the same and the manifest is left untouched.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function refreshWindowsSidecarHash(appOutDir) {
  const sidecarDir = path.join(appOutDir, 'resources', 'sidecar');
  const manifestPath = path.join(sidecarDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`afterPack: packaged sidecar manifest missing at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const artifactName = path.basename(String(manifest.artifact_name || ''));
  const artifactPath = path.join(sidecarDir, artifactName);
  if (!artifactName || !fs.existsSync(artifactPath)) {
    throw new Error(`afterPack: packaged sidecar artifact missing at ${artifactPath}`);
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
  if (digest === String(manifest.sha256 || '').toLowerCase()) {
    return false;
  }
  manifest.unsigned_sha256 = manifest.unsigned_sha256 || manifest.sha256;
  manifest.sha256 = digest;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return true;
}

function chmodRequired(target, label) {
  if (!fs.existsSync(target)) {
    throw new Error(`afterPack: packaged ${label} missing at ${target}`);
  }
  try {
    fs.chmodSync(target, 0o755);
  } catch (error) {
    throw new Error(
      `afterPack: could not make the packaged ${label} executable (${(error && error.message) || error})`,
      { cause: error }
    );
  }
}

function chmodIfPresent(target, label) {
  try {
    if (fs.existsSync(target)) {
      fs.chmodSync(target, 0o755);
    }
  } catch (error) {
    // Non-fatal: a signed build also re-signs nested binaries, and the launch
    // path verifies the binary independently.
    process.stderr.write(`afterPack: could not chmod ${label} (${(error && error.message) || error})\n`);
  }
}

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName
    || (context.packager && context.packager.platform && context.packager.platform.nodeName);
  if (platform === 'linux') {
    const resources = path.join(context.appOutDir, 'resources');
    chmodRequired(path.join(resources, 'sidecar', 'sidecar'), 'sidecar');
    chmodRequired(path.join(resources, 'sidecar', 'jenny-team-bridge'), 'team bridge');
    chmodRequired(path.join(resources, 'bin', 'jenny'), 'CLI shim');
    return;
  }
  if (platform === 'win32') {
    refreshWindowsSidecarHash(context.appOutDir);
    return;
  }
  if (platform !== 'darwin') {
    return;
  }
  const productFilename = context.packager
    && context.packager.appInfo
    && context.packager.appInfo.productFilename;
  const appBundle = `${productFilename || 'Jenny'}.app`;
  const resources = path.join(context.appOutDir, appBundle, 'Contents', 'Resources');
  chmodIfPresent(path.join(resources, 'sidecar', 'sidecar'), 'sidecar');
  chmodIfPresent(path.join(resources, 'sidecar', 'jenny-team-bridge'), 'team bridge');
  chmodIfPresent(path.join(resources, 'bin', 'jenny'), 'CLI shim');
  try {
    fs.chmodSync(path.resolve(__dirname, '..', 'uninstall.command'), 0o755);
  } catch (error) {
    throw new Error(
      `afterPack: could not make uninstall helper executable (${(error && error.message) || error})`,
      { cause: error }
    );
  }
};
