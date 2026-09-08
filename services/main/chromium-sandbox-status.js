'use strict';

const { resolveLinuxPackageKind } = require('../linux-package-kind');

// The static AppImage runtime adds --no-sandbox when Linux restricts
// unprivileged user namespaces, allowing Jenny to launch on those systems.
// Electron exposes that launch decision through its command-line switches.
// Missing or failed switch inspection is explicitly reported as unknown.
// The main process records the posture in the diagnostics log and in
// jenny_status.runtime.chromium_sandbox; the renderer raises the notice.

function resolveChromiumSandboxStatus({
  platform = process.platform,
  isPackaged = false,
  hasSwitch = null,
  env = process.env,
  execPath = process.execPath,
} = {}) {
  let sandboxed = null;
  let reason = 'inspection_unavailable';
  if (typeof hasSwitch === 'function') {
    try {
      const sandboxDisabled = hasSwitch('no-sandbox') === true;
      sandboxed = !sandboxDisabled;
      reason = sandboxDisabled ? 'no_sandbox_switch' : '';
    } catch (_error) {
      // Keep the unavailable state when Electron inspection fails.
    }
  }
  const packaged = isPackaged === true;
  const packageKind = !packaged
    ? 'development'
    : platform === 'linux'
      ? resolveLinuxPackageKind({ platform, env, execPath })
      : 'other';
  return {
    platform: String(platform),
    packaged,
    sandboxed,
    reason,
    package_kind: packageKind,
  };
}

module.exports = { resolveChromiumSandboxStatus };
