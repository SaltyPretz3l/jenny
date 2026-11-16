'use strict';

// How the desktop starts its team host (slice 1f-2): Electron's
// `utilityProcess.fork` of host-entry.js, with a minimal environment and no
// secret in it. Electron is required lazily, on the first Deploy, so nothing
// here loads at app start and the tests run without Electron.
//
// Electron 45 facts this relies on (Electron's utilityProcess API docs and
// lib/utility/init.ts at v45.0.0): `fork(modulePath, args, options)` may only
// run after the app is ready; `options.env` defaults to process.env (passed
// here explicitly); `stdio` takes 'pipe' | 'ignore' | 'inherit' per stream, stdin
// must be 'ignore', and `child.stdout` is a readable stream only when stdio[1] is
// 'pipe' (null otherwise, and null after `exit`): the supervisor passes
// ['ignore', 'pipe', 'ignore'] (electron.d.ts 45.0.0, UtilityProcess `stdout` and
// ForkOptions `stdio`); the child's `process.parentPort` has
// `postMessage` and `message` events (`{ data }`) and no close event; the entry
// is loaded through Node's ESM loader, so `require.main === module` is not
// relied on; `kill()` returns a boolean; `exit` carries the exit code and `pid`
// is undefined before spawn and after exit. A real utility-process run has not
// been exercised (owner-gated, see TEAM_MEMBERSHIP_SPEC "1f-2 as built").

const path = require('node:path');

const { sanitizeSpawnEnv } = require('../../backend/sanitize-spawn-env');

const HOST_ENTRY = path.join(__dirname, 'host-entry.js');

// The system baseline sanitizeSpawnEnv always keeps (PATH, SystemRoot, TEMP, ...) plus
// the feature-flag overrides; no PYTHON*, no credentials, nothing else of the parent's.
function hostEnvironment(env = process.env) {
  return sanitizeSpawnEnv(env, { allowOnly: true, allow: [/^JENNY_ENABLE_[A-Z0-9_]+$/u] });
}

// `utilityProcess.fork`, resolved when first called.
function electronFork(modulePath, args, options) {
  const { utilityProcess } = require('electron');
  return utilityProcess.fork(modulePath, args, options);
}

// Fails closed: when Electron cannot answer, the app is treated as packaged (the stricter platform rule).
function electronIsPackaged() {
  try {
    const { app } = require('electron');
    return app ? app.isPackaged !== false : true;
  } catch {
    return true;
  }
}

// The desktop sidecar's interpreter, asked only from a source checkout (any platform, slice 4a-5): the
// hosted sidecar runs on it, and on Linux the profile lock too. Deploy writes it only when the file exists.
function desktopPythonExecutable(backendService) {
  const value = backendService?.sidecarManager?.pythonExecutable;
  return typeof value === 'string' && path.isAbsolute(value) ? value : null;
}

// Slice 5-6: the export folder and the backup file are picked here, in main, so the renderer never names a path.
async function showOpen(properties, filters) {
  const { BrowserWindow, dialog } = require('electron');
  const owner = BrowserWindow.getFocusedWindow();
  const options = { properties, ...(filters ? { filters } : {}) };
  const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return picked && !picked.canceled && typeof picked.filePaths?.[0] === 'string' ? picked.filePaths[0] : null;
}

const electronPickFolder = () => showOpen(['openDirectory', 'createDirectory']);
const electronPickBackup = () => showOpen(['openFile'], [{ name: 'Jenny team backup', extensions: ['jennyteam'] }]);

// An old team's project folder in the file manager; false when the shell could not open it.
async function electronOpenFolder(folder) {
  const { shell } = require('electron');
  return (await shell.openPath(folder)) === '';
}

module.exports = {
  HOST_ENTRY, desktopPythonExecutable, electronFork, electronIsPackaged, electronOpenFolder, electronPickBackup, electronPickFolder,
  hostEnvironment,
};
