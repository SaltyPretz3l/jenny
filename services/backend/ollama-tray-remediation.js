// Owner-triggered remediation actions for the Ollama tray-app conflict
// (see ollama-tray-conflict.js for the detection layer this module reuses).
// Explicit-click actions ONLY — nothing here runs automatically. Quitting the
// tray app and disabling its Startup shortcut are both best-effort and
// per-item isolated: one failure must never abort the rest of a batch.
//
// Kept as a pure sibling module (injectable detect/kill/fs impls) so it is
// unit-testable, mirroring the style of ollama-shutdown.js.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { detectOllamaTrayConflictSync, findOllamaStartupShortcutsSync, getWindowsStartupFolderPath } =
  require('./ollama-tray-conflict');
const { forceKillByPidSync } = require('./ollama-shutdown');

// Quit every detected Ollama tray-app process by pid. No-op off win32. Each
// kill attempt is isolated (try/catch) so one throwing pid does not stop the
// rest from being attempted.
function quitOllamaTrayAppSync({
  platform = process.platform,
  env = process.env,
  detectImpl,
  forceKillByPidImpl,
  // The real taskkill/kill seam. forceKillByPidSync has no spawnSyncImpl
  // default of its own, so passing `undefined` here would make it call
  // undefined(...) and throw — default to the real spawnSync so the quit
  // action actually kills in production, and keep it injectable for tests.
  spawnSyncImpl = spawnSync,
  logger,
} = {}) {
  if (platform !== 'win32') {
    return { ok: true, killedPids: [], reason: 'unsupported_platform' };
  }

  const detect = detectImpl || detectOllamaTrayConflictSync;
  let trayProcesses;
  try {
    const result = detect({ platform, env, logger }) || {};
    trayProcesses = Array.isArray(result.trayProcesses) ? result.trayProcesses : [];
  } catch (_error) {
    // best effort — treat as no detected tray processes
    trayProcesses = [];
  }

  if (trayProcesses.length === 0) {
    return { ok: true, killedPids: [], reason: 'no_tray_process' };
  }

  const kill = forceKillByPidImpl || forceKillByPidSync;
  const killedPids = [];
  let failureCount = 0;

  for (const entry of trayProcesses) {
    const pid = entry && entry.pid;
    try {
      const result = kill(pid, { platform, spawnSyncImpl });
      if (result?.error || (typeof result?.status === 'number' && result.status !== 0)) {
        failureCount += 1;
        continue;
      }
      killedPids.push(pid);
    } catch (_error) {
      failureCount += 1;
      // per-item isolation — keep attempting the remaining pids
    }
  }

  if (killedPids.length === 0 && failureCount > 0) {
    return { ok: false, killedPids: [], reason: 'kill_failed' };
  }
  if (failureCount > 0) {
    return { ok: true, killedPids, reason: 'partial_failure' };
  }

  return { ok: true, killedPids };
}

// Move every discovered Ollama*.lnk OUT of the Windows Startup folder into a
// quarantine directory (%APPDATA%\jenny\disabled-startup-shortcuts\, as
// "<name>.disabled") so the shortcut no longer launches at login while
// staying recoverable (not deleted). It must leave the Startup folder
// entirely: Windows attempts to open every file there at login regardless of
// extension, so a renamed-in-place ".disabled" file triggers an
// "open with" picker prompt on every login. No-op off win32. Per-item
// isolated: an already-quarantined target is skipped (never clobbered), a
// missing source (ENOENT — already gone) is treated as benign, and any other
// per-item error is isolated rather than aborting the batch.
function safeExistsSync(existsImpl, targetPath) {
  try {
    return Boolean(existsImpl(targetPath));
  } catch (_error) {
    return false;
  }
}

function getQuarantineDirPath(env = process.env) {
  return path.join(String(env.APPDATA || ''), 'jenny', 'disabled-startup-shortcuts');
}

// First free "<name>.disabled[-N]" path inside the quarantine dir, so a
// leftover from an earlier disable never blocks moving a re-added shortcut
// out of the Startup folder (skipping would leave it active at login).
function pickQuarantineTargetPath(exists, quarantineDir, basename) {
  const base = path.join(quarantineDir, `${basename}.disabled`);
  if (!safeExistsSync(exists, base)) {
    return base;
  }
  for (let n = 2; n <= 99; n += 1) {
    const candidate = `${base}-${n}`;
    if (!safeExistsSync(exists, candidate)) {
      return candidate;
    }
  }
  return null;
}

function disableOllamaStartupShortcutsSync({
  platform = process.platform,
  env = process.env,
  readdirSyncImpl,
  renameSyncImpl,
  existsSyncImpl,
  mkdirSyncImpl,
  logger,
} = {}) {
  if (platform !== 'win32') {
    return { ok: true, disabled: [], skipped: [], reason: 'unsupported_platform' };
  }

  const shortcuts = findOllamaStartupShortcutsSync({ env, readdirSyncImpl });
  const startupDir = getWindowsStartupFolderPath(env);
  const quarantineDir = getQuarantineDirPath(env);

  if (shortcuts.length === 0) {
    return { ok: true, disabled: [], skipped: [] };
  }

  const exists = existsSyncImpl || fs.existsSync;
  const rename = renameSyncImpl || fs.renameSync;
  const mkdir = mkdirSyncImpl || fs.mkdirSync;

  try {
    mkdir(quarantineDir, { recursive: true });
  } catch (_error) {
    // best effort — per-item renames below will fail and report disable_failed
  }

  const disabled = [];
  const skipped = [];
  let failureCount = 0;

  for (const basename of shortcuts) {
    const sourcePath = path.join(startupDir, basename);
    const targetPath = pickQuarantineTargetPath(exists, quarantineDir, basename);

    if (!targetPath) {
      skipped.push(basename);
      continue;
    }

    try {
      rename(sourcePath, targetPath);
      disabled.push(basename);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // Source already gone — benign, not an error.
        skipped.push(basename);
        continue;
      }
      failureCount += 1;
      // per-item isolation — keep attempting the remaining shortcuts
    }
  }

  if (disabled.length === 0 && skipped.length === 0 && failureCount > 0) {
    return { ok: false, disabled: [], skipped: [], reason: 'disable_failed' };
  }

  return { ok: true, disabled, skipped };
}

module.exports = {
  quitOllamaTrayAppSync,
  disableOllamaStartupShortcutsSync,
  getQuarantineDirPath,
};
