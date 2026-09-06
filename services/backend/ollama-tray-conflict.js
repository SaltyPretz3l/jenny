// Detects the Ollama tray app ("ollama app.exe") and its Windows Startup
// shortcut. Root cause: the tray runs its own server on 11434 and its
// monitor/restart logic taskkills Jenny's managed `ollama serve` (the updater
// can silently re-add the tray to Startup). Detection + legible surfacing only:
// the manager never auto-kills the tray or deletes the shortcut; the owner decides.
//
// Kept as a pure sibling module (injectable process lister / readdir) so it is
// unit-testable and stays out of the already-large ollama-process-manager.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const {
  WINDOWS_OLLAMA_PROCESS_QUERY_SCRIPT,
  listLocalOllamaProcessesSync,
  parseWindowsProcessQueryOutput,
} = require('./ollama-shutdown');

// Tray-app image names start with "ollama app" (e.g. "ollama app.exe",
// versioned "Ollama App 0.x.exe" variants) — same prefix rule as
// isKnownWindowsOllamaName in ollama-shutdown.
const TRAY_PROCESS_NAME_PREFIX = 'ollama app';

const TRAY_CONFLICT_REMEDIATION =
  'Quit the Ollama tray app (system tray icon > Quit Ollama) and remove the '
  + 'Ollama shortcut from the Windows Startup folder, then restart the engine. '
  + 'Note: Ollama auto-updates may re-add the Startup shortcut.';

const TRAY_CONFLICT_SYMPTOM =
  'The Ollama tray app runs its own server on port 11434 and its monitor logic '
  + 'can silently kill the app-managed "ollama serve" (ollama.exited code 1 with '
  + 'no error lines) shortly after start.';

function getWindowsStartupFolderPath(env = process.env) {
  const appData = String((env && env.APPDATA) || '').trim();
  if (!appData) {
    return '';
  }
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

// Basenames (not full paths, to keep log payloads free of raw local paths) of
// Startup-folder .lnk entries that reference Ollama.
function findOllamaStartupShortcutsSync({
  env = process.env,
  readdirSyncImpl = fs.readdirSync,
} = {}) {
  const startupDir = getWindowsStartupFolderPath(env);
  if (!startupDir) {
    return [];
  }
  let entries;
  try {
    entries = readdirSyncImpl(startupDir);
  } catch (_error) {
    // Missing/unreadable Startup folder: nothing to report.
    return [];
  }
  return (Array.isArray(entries) ? entries : [])
    .map((name) => String(name || '').trim())
    .filter((name) => /ollama/i.test(name) && /\.lnk$/i.test(name));
}

function isTrayProcessName(name) {
  return String(name || '').trim().toLowerCase().startsWith(TRAY_PROCESS_NAME_PREFIX);
}

// Detect whether the Ollama tray app is running and/or registered in the
// user's Startup folder. No-ops (detected: false) off win32. Best-effort: a
// failing process lister or unreadable Startup folder degrades to "not found"
// for that half rather than throwing.
function detectOllamaTrayConflictSync({
  platform = process.platform,
  env = process.env,
  listProcessesImpl,
  readdirSyncImpl = fs.readdirSync,
  logger,
} = {}) {
  const empty = { detected: false, trayProcesses: [], startupShortcuts: [] };
  if (platform !== 'win32') {
    return empty;
  }
  const listProcesses = typeof listProcessesImpl === 'function'
    ? listProcessesImpl
    : (options = {}) => listLocalOllamaProcessesSync(options);
  let trayProcesses = [];
  try {
    trayProcesses = (listProcesses({ platform, logger }) || [])
      .filter((entry) => entry && isTrayProcessName(entry.name))
      .map((entry) => ({ pid: entry.pid, name: entry.name }));
  } catch (_error) {
    // best effort — the Startup-shortcut check below still applies
  }
  const startupShortcuts = findOllamaStartupShortcutsSync({ env, readdirSyncImpl });
  return {
    detected: trayProcesses.length > 0 || startupShortcuts.length > 0,
    trayProcesses,
    startupShortcuts,
  };
}

// Async (execFile) sibling of ollama-shutdown's PowerShell process lister, for
// the start()-time tray check: the WMI query can take seconds (5s timeout), and
// running it via execFileSync blocked the whole main-process event loop — and
// with it the sidecar spawn that engine start deliberately overlaps. Detection
// stays best-effort: any spawn/parse failure resolves to "no processes found".
function listLocalOllamaProcessesViaPowerShellAsync({ execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_OLLAMA_PROCESS_QUERY_SCRIPT],
      {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        try {
          resolve(parseWindowsProcessQueryOutput(stdout));
        } catch (_parseError) {
          resolve([]);
        }
      },
    );
  });
}

// Non-blocking variant of detectOllamaTrayConflictSync for the start() path.
// Same result shape and best-effort degradation; only the process listing goes
// async (the Startup-folder readdir is one small directory and stays sync).
async function detectOllamaTrayConflictAsync({
  platform = process.platform,
  env = process.env,
  listProcessesImpl,
  readdirSyncImpl = fs.readdirSync,
  logger,
} = {}) {
  const empty = { detected: false, trayProcesses: [], startupShortcuts: [] };
  if (platform !== 'win32') {
    return empty;
  }
  const listProcesses = typeof listProcessesImpl === 'function'
    ? listProcessesImpl
    : (options = {}) => listLocalOllamaProcessesViaPowerShellAsync(options);
  let trayProcesses = [];
  try {
    trayProcesses = ((await listProcesses({ platform, logger })) || [])
      .filter((entry) => entry && isTrayProcessName(entry.name))
      .map((entry) => ({ pid: entry.pid, name: entry.name }));
  } catch (_error) {
    // best effort — the Startup-shortcut check below still applies
  }
  const startupShortcuts = findOllamaStartupShortcutsSync({ env, readdirSyncImpl });
  return {
    detected: trayProcesses.length > 0 || startupShortcuts.length > 0,
    trayProcesses,
    startupShortcuts,
  };
}

// Shared payload for the 'ollama.tray_app_conflict_detected' WARN, used by both
// the start()-time check and the exit-time re-detection in the process manager
// so the two surfaces can never drift.
function buildTrayConflictWarnDetails(conflict) {
  const trayPids = (conflict.trayProcesses || []).map((entry) => entry.pid);
  return {
    trayPids,
    startupShortcuts: conflict.startupShortcuts || [],
    message: `${trayPids.length
      ? 'The Ollama tray app ("ollama app.exe") is running'
      : 'An Ollama shortcut is registered in the Windows Startup folder'}. ${TRAY_CONFLICT_SYMPTOM}`,
    remediation: TRAY_CONFLICT_REMEDIATION,
  };
}

// The silent external-kill signature from the 2026-07-02 incident: exit code 1,
// no terminating signal, and a stderr tail with no structured level=ERROR line
// (a genuine crash almost always leaves one). An empty/absent tail counts as
// silent.
function isSilentExternalKillSignature({ code, signal, stderrTail } = {}) {
  if (Number(code) !== 1 || signal) {
    return false;
  }
  return !/\blevel=ERROR\b/i.test(String(stderrTail || ''));
}

module.exports = {
  TRAY_CONFLICT_REMEDIATION,
  TRAY_CONFLICT_SYMPTOM,
  buildTrayConflictWarnDetails,
  detectOllamaTrayConflictAsync,
  detectOllamaTrayConflictSync,
  listLocalOllamaProcessesViaPowerShellAsync,
  findOllamaStartupShortcutsSync,
  getWindowsStartupFolderPath,
  isSilentExternalKillSignature,
};
