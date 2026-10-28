'use strict';

// Where the CLI's sidecar, flock helper and interpreters live (Jenny CLI plan,
// decision 13). Two layouts only:
// - source: the CLI runs from the repository (`node cli/main.js`, npm link);
//   the sidecar is `python -m sidecar` on the repository venv.
// - packaged: the installed shim (resources/bin/jenny[.cmd]) runs the Jenny
//   executable as Node on resources/app.asar/cli/main.js; the sidecar is the
//   PyInstaller binary described by resources/sidecar/manifest.json, resolved
//   and verified by the desktop's own resolver.
// The root's basename alone decides, so this stays testable under plain Node;
// a packaged layout never falls back to hunting a venv inside the asar.

const fs = require('node:fs');
const path = require('node:path');

const PACKAGED_ROOT_NAME = 'app.asar';
const LOCK_HELPER = ['services', 'host', 'profile_lock.py'];

function venvPython(root, platform = process.platform) {
  return path.join(root, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

function explicitPython(env) {
  return String(env?.JENNY_BACKEND_PYTHON || '').trim();
}

function sourceRuntime(root, env, platform, fsImpl) {
  // The desktop's own candidate order: JENNY_BACKEND_PYTHON, then the
  // repository venv. Nothing else is guessed.
  const venv = venvPython(root, platform);
  const pythonExecutable = explicitPython(env) || (fsImpl.existsSync(venv) ? venv : '');
  return {
    mode: 'source',
    root,
    resourcesPath: '',
    pythonExecutable,
    lockPythonExecutable: platform === 'win32' ? '' : pythonExecutable,
    lockHelperPath: path.join(root, ...LOCK_HELPER),
    sidecarCwd: root,
    pythonRuntimeBundleRoot: path.join(root, 'vendor'),
    resolvePackagedLaunch: null,
    packagedManifestPresent: false,
  };
}

function packagedRuntime(root, env, platform, fsImpl) {
  const resourcesPath = path.dirname(root);
  // The flock helper needs some interpreter: an operator's explicit choice
  // (macOS ships none), else the embedded runtime Linux packages carry.
  const embedded = path.join(resourcesPath, 'python-embed', 'bin', 'python3.13');
  let lockPythonExecutable = '';
  if (platform !== 'win32') lockPythonExecutable = explicitPython(env) || (fsImpl.existsSync(embedded) ? embedded : '');
  return {
    mode: 'packaged',
    root,
    resourcesPath,
    // The sidecar is a binary; JENNY_BACKEND_PYTHON never redirects it, as on
    // the packaged desktop.
    pythonExecutable: '',
    lockPythonExecutable,
    // An external interpreter cannot read inside the asar; packaging unpacks
    // the helper beside it.
    lockHelperPath: path.join(resourcesPath, `${PACKAGED_ROOT_NAME}.unpacked`, ...LOCK_HELPER),
    sidecarCwd: resourcesPath,
    pythonRuntimeBundleRoot: resourcesPath,
    // Required lazily so the source route never loads the packaged resolver.
    // The `--version` probe stays on: a bad binary is refused before chat.
    resolvePackagedLaunch: async () => require('../backend/packaged-sidecar-launch')
      .resolvePackagedSidecarLaunchAsync({ resourcesPath, platform }),
    packagedManifestPresent: fsImpl.existsSync(path.join(resourcesPath, 'sidecar', 'manifest.json')),
  };
}

/**
 * Resolve the CLI's runtime layout from the directory holding cli/ (the
 * repository root, or resources/app.asar when installed). Pure and
 * synchronous; returns a frozen description.
 */
function resolveCliRuntime({ root, env = process.env, platform = process.platform, fsImpl = fs } = {}) {
  const resolved = path.resolve(String(root || ''));
  const layout = path.basename(resolved) === PACKAGED_ROOT_NAME
    ? packagedRuntime(resolved, env, platform, fsImpl)
    : sourceRuntime(resolved, env, platform, fsImpl);
  return Object.freeze(layout);
}

// The createCliHost launch options for a runtime. Commands that never start
// the sidecar (sessions, mcp before its first ask) still need a path in the
// source route, so `placeholderPython` supplies the venv path there. The
// source route passes no bundle root: the backend derives <repoRoot>/vendor
// itself, exactly as before the packaged route existed.
function hostLaunchOptions(runtime, { placeholderPython = false } = {}) {
  if (runtime.mode === 'packaged') {
    return { repoRoot: runtime.sidecarCwd, pythonExecutable: '', resolvePackagedLaunch: runtime.resolvePackagedLaunch,
      pythonRuntimeBundleRoot: runtime.pythonRuntimeBundleRoot };
  }
  const pythonExecutable = runtime.pythonExecutable || (placeholderPython ? venvPython(runtime.root) : '');
  return { repoRoot: runtime.sidecarCwd, pythonExecutable };
}

// The acquireCliProfile options for a runtime.
function lockOptions(runtime) {
  return { pythonExecutable: runtime.lockPythonExecutable, lockHelperPath: runtime.lockHelperPath };
}

module.exports = { hostLaunchOptions, lockOptions, resolveCliRuntime, venvPython };
