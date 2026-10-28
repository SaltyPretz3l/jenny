'use strict';

// electron-builder afterPack hook.
//
// Ensures the packaged PyInstaller sidecar binary and the `jenny` CLI shim
// (resources/bin/jenny, copied from build/cli) are executable on macOS and
// Linux. A file copied in via extraResources can arrive without its +x bit,
// which makes the app's startup `--version` probe (or the `jenny` command)
// fail with EACCES. Linux fails closed; Windows is a no-op because sidecar.exe
// and jenny.cmd need no +x bit.

const fs = require('fs');
const path = require('path');

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
    chmodRequired(path.join(resources, 'bin', 'jenny'), 'CLI shim');
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
