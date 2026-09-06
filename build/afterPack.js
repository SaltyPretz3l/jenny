'use strict';

// electron-builder afterPack hook.
//
// Ensures the packaged PyInstaller sidecar binary is executable on macOS. A
// `--onefile` binary copied in via extraResources can arrive without its +x
// bit, which makes the app's startup `--version` probe fail with EACCES. No-op
// on Windows (the sidecar is `sidecar.exe`, which needs no execute bit).

const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName
    || (context.packager && context.packager.platform && context.packager.platform.nodeName);
  if (platform !== 'darwin') {
    return;
  }
  const productFilename = context.packager
    && context.packager.appInfo
    && context.packager.appInfo.productFilename;
  const appBundle = `${productFilename || 'Jenny Shell'}.app`;
  const sidecar = path.join(
    context.appOutDir,
    appBundle,
    'Contents',
    'Resources',
    'sidecar',
    'sidecar'
  );
  const restrictedHost = path.join(
    context.appOutDir,
    appBundle,
    'Contents',
    'Resources',
    'restricted-host',
    'jenny-plugin-host'
  );
  try {
    if (fs.existsSync(sidecar)) {
      fs.chmodSync(sidecar, 0o755);
    }
  } catch (error) {
    // Non-fatal: a signed build also re-signs nested binaries, and the launch
    // path verifies the binary independently.
    process.stderr.write(`afterPack: could not chmod sidecar (${(error && error.message) || error})\n`);
  }
  try {
    if (fs.existsSync(restrictedHost)) {
      fs.chmodSync(restrictedHost, 0o755);
    }
  } catch (error) {
    process.stderr.write(`afterPack: could not chmod restricted host (${(error && error.message) || error})\n`);
  }
  try {
    fs.chmodSync(path.resolve(__dirname, '..', 'uninstall.command'), 0o755);
  } catch (error) {
    throw new Error(
      `afterPack: could not make uninstall helper executable (${(error && error.message) || error})`,
      { cause: error }
    );
  }
};
