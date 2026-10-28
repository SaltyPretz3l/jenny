'use strict';

// Unpackaged launches that start electron.exe on main.js directly
// (launch-jenny.cmd, jenny-launch.vbs, harnesses) get the preload-bundle stamp
// check here, in-process: no extra Node start on every launch. Only a stale or
// missing bundle pays for a rebuild, in a child running this Electron binary as
// Node, so Node on PATH is not required. start.js already checked and marks the
// child env. A packaged app ships a prebuilt bundle and never reaches the script.

const path = require('path');
const { spawnSync } = require('child_process');

const PRELOAD_CHECKED_ENV = 'JENNY_PRELOAD_BUNDLE_CHECKED';
const REBUILD_TIMEOUT_MS = 120_000;

function preloadScriptPath(rootDir) {
  return path.join(rootDir, 'scripts', 'build', 'build-preload.js');
}

// A computed path keeps the dev-only script (and its esbuild dependency) out of
// the packaged main-process require graph.
function defaultIsCurrent(rootDir) {
  return require(preloadScriptPath(rootDir)).isPreloadBundleCurrent({ root: rootDir });
}

function rebuildPreloadBundleInChild({ rootDir, env, execPath, spawnSyncImpl = spawnSync }) {
  return spawnSyncImpl(execPath, [preloadScriptPath(rootDir)], {
    cwd: rootDir,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    timeout: REBUILD_TIMEOUT_MS,
    encoding: 'utf8',
  });
}

function ensureDevPreloadBundle({
  isPackaged,
  rootDir,
  env = process.env,
  execPath = process.execPath,
  isCurrent = defaultIsCurrent,
  rebuild = rebuildPreloadBundleInChild,
} = {}) {
  if (isPackaged) return { status: 'packaged' };
  if (String(env[PRELOAD_CHECKED_ENV] || '').trim() === '1') return { status: 'launcher-checked' };
  try {
    if (isCurrent(rootDir)) return { status: 'current' };
  } catch (_error) {
    // An unreadable stamp or missing esbuild falls through to the rebuild,
    // which reports an actionable failure.
  }
  const result = rebuild({ rootDir, env, execPath }) || {};
  if (result.error || result.status !== 0) {
    const detail = String(result.error?.message || result.stderr || `exit ${result.status}`).trim();
    return { status: 'failed', detail: detail.slice(-600) };
  }
  return { status: 'rebuilt' };
}

module.exports = {
  PRELOAD_CHECKED_ENV,
  ensureDevPreloadBundle,
  rebuildPreloadBundleInChild,
};
