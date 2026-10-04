const fs = require('fs');
const path = require('path');

const WINDOWS_SHORTCUT_NAME = 'Jenny.lnk';
const DEV_WINDOWS_SHORTCUT_NAME = 'Jenny (Dev).lnk';
// Shortcut name written by every build before the product was renamed from
// "Jenny Shell" to "Jenny" (1.0.0). Removed once the new shortcut is in place.
const LEGACY_WINDOWS_SHORTCUT_NAME = 'Jenny Shell.lnk';
const APP_USER_MODEL_ID = 'com.jenny.shell';
// Unpackaged runs (dev launcher, agent mode, every worktree) get their own
// identity so they never claim the installed app's Start Menu entry, taskbar
// group or toast activator.
const DEV_APP_USER_MODEL_ID = 'com.jenny.shell.dev';
// Electron 43 writes Start Menu\Programs\<exe ProductName>.lnk for toast
// activation (electron.exe's ProductName is "Electron") with the exe's icon and
// a per-run random CLSID unless one is set. Owning that link with a fixed CLSID
// and Jenny's icon keeps Electron from rewriting it with the atom icon.
const DEV_TOAST_ACTIVATOR_CLSID = '{6B1E2A4C-9D3F-4E7A-B8C5-2F0D1A3E5C71}';
const DEV_START_MENU_SHORTCUT_NAME = 'Electron.lnk';
const DEV_LAUNCHER_NAME = path.join('scripts', 'dev', 'launch-jenny-dev.bat');

function getDevLauncherPath(appRoot = path.resolve(__dirname, '..')) {
  return path.join(appRoot, DEV_LAUNCHER_NAME);
}

function resolveAppUserModelId({ isPackaged = false } = {}) {
  return isPackaged ? APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID;
}

function buildDesktopShortcutOptions({
  appRoot = path.resolve(__dirname, '..'),
  execPath = process.execPath,
  isPackaged = false,
  appUserModelId = resolveAppUserModelId({ isPackaged }),
} = {}) {
  const cwd = isPackaged ? path.dirname(execPath) : appRoot;
  const target = isPackaged ? execPath : getDevLauncherPath(appRoot);
  const icon = isPackaged ? execPath : path.join(appRoot, 'build', 'icon.ico');
  return {
    details: {
      target,
      args: '',
      cwd,
      description: isPackaged ? 'Launch Jenny' : 'Launch Jenny (Dev) from current source',
      icon,
      iconIndex: 0,
      appUserModelId,
    },
  };
}

function shortcutDetailsMatch(actual, expected) {
  return actual
    && actual.target === expected.target
    && String(actual.args || '') === String(expected.args || '')
    && actual.cwd === expected.cwd
    && actual.icon === expected.icon
    && Number(actual.iconIndex || 0) === Number(expected.iconIndex || 0)
    && actual.appUserModelId === expected.appUserModelId
    && (!expected.toastActivatorClsid
      || String(actual.toastActivatorClsid || '').toUpperCase() === expected.toastActivatorClsid.toUpperCase());
}

// Read-compare-skip, write, then read back. Returns { ok, shortcutPath, ... };
// failures are logged under `${eventPrefix}_*` and never thrown.
function writeVerifiedShortcut({ shell, shortcutPath, details, logger, eventPrefix }) {
  // #11: skip the disk rewrite when an existing shortcut already matches -- the
  // common case on every relaunch. Only the fields we set are compared.
  if (typeof shell.readShortcutLink === 'function') {
    try {
      const existing = shell.readShortcutLink(shortcutPath);
      if (shortcutDetailsMatch(existing, details)) {
        logger('INFO', `${eventPrefix}_unchanged`, { shortcutPath });
        return { ok: true, shortcutPath, unchanged: true };
      }
    } catch (_readError) {
      // No existing shortcut (or unreadable) -> fall through to write it.
    }
  }
  // Electron's "replace" operation fails when no shortcut exists. "create"
  // is idempotent here: it creates a missing link and overwrites an existing
  // one after the exact-match fast path above.
  const created = shell.writeShortcutLink(shortcutPath, 'create', details);

  if (!created) {
    logger('WARN', `${eventPrefix}_create_failed`, { shortcutPath });
    return { ok: false, shortcutPath, reason: 'write-failed' };
  }
  if (typeof shell.readShortcutLink === 'function') {
    try {
      const verified = shell.readShortcutLink(shortcutPath);
      if (!shortcutDetailsMatch(verified, details)) {
        logger('WARN', `${eventPrefix}_verify_failed`, { shortcutPath });
        return { ok: false, shortcutPath, reason: 'verify-failed' };
      }
    } catch (error) {
      logger('WARN', `${eventPrefix}_verify_failed`, {
        shortcutPath,
        message: String(error && error.message ? error.message : error),
      });
      return { ok: false, shortcutPath, reason: 'verify-failed' };
    }
  }

  logger('INFO', `${eventPrefix}_ready`, {
    shortcutPath,
    target: details.target,
    args: details.args,
  });
  return { ok: true, shortcutPath };
}

// Delete the pre-rename desktop shortcut, but only when it is provably ours
// (same AppUserModelId or same target); a foreign link with that name stays.
function removeLegacyDesktopShortcut({ desktopPath, shell, details, logger }) {
  const legacyPath = path.join(desktopPath, LEGACY_WINDOWS_SHORTCUT_NAME);
  try {
    if (!fs.existsSync(legacyPath) || typeof shell.readShortcutLink !== 'function') return;
    const existing = shell.readShortcutLink(legacyPath);
    const ours = existing
      && (existing.appUserModelId === details.appUserModelId || existing.target === details.target);
    if (!ours) return;
    fs.unlinkSync(legacyPath);
    logger('INFO', 'shortcut.desktop_legacy_removed', { shortcutPath: legacyPath });
  } catch (error) {
    logger('WARN', 'shortcut.desktop_legacy_remove_failed', {
      shortcutPath: legacyPath,
      message: String(error && error.message ? error.message : error),
    });
  }
}

function ensureDesktopShortcut({
  app,
  shell,
  logger = () => {},
  platform = process.platform,
  execPath = process.execPath,
  appRoot = path.resolve(__dirname, '..'),
} = {}) {
  if (platform !== 'win32') {
    return { skipped: true, reason: 'unsupported-platform' };
  }

  try {
    const desktopPath = app.getPath('desktop');
    const appUserModelId =
      typeof app.getAppUserModelId === 'function' && app.getAppUserModelId()
        ? app.getAppUserModelId()
        : resolveAppUserModelId({ isPackaged: Boolean(app.isPackaged) });
    const { details } = buildDesktopShortcutOptions({
      appRoot,
      execPath,
      isPackaged: Boolean(app.isPackaged),
      appUserModelId,
    });
    const shortcutPath = path.join(
      desktopPath, app.isPackaged ? WINDOWS_SHORTCUT_NAME : DEV_WINDOWS_SHORTCUT_NAME
    );
    const result = writeVerifiedShortcut({
      shell, shortcutPath, details, logger, eventPrefix: 'shortcut.desktop',
    });
    if (result.ok && app.isPackaged) removeLegacyDesktopShortcut({ desktopPath, shell, details, logger });
    return result;
  } catch (error) {
    logger('WARN', 'shortcut.desktop_create_failed', {
      message: String(error && error.message ? error.message : error),
    });
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function buildDevStartMenuShortcutDetails({
  appRoot = path.resolve(__dirname, '..'),
  execPath = process.execPath,
  appUserModelId = DEV_APP_USER_MODEL_ID,
} = {}) {
  // target/cwd/AUMID/CLSID are exactly what Electron's ExistingShortcutValid
  // checks; it ignores the icon, so Jenny's icon survives.
  return {
    target: execPath,
    args: '',
    cwd: path.dirname(execPath),
    description: 'Jenny (Dev)',
    icon: path.join(appRoot, 'build', 'icon.ico'),
    iconIndex: 0,
    appUserModelId,
    toastActivatorClsid: DEV_TOAST_ACTIVATOR_CLSID,
  };
}

// Must run after app.setAppUserModelId and before the first Notification:
// Electron creates its toast shortcut when the notification presenter starts.
function ensureDevStartMenuShortcut({
  app,
  shell,
  logger = () => {},
  platform = process.platform,
  execPath = process.execPath,
  appRoot = path.resolve(__dirname, '..'),
} = {}) {
  if (platform !== 'win32') return { skipped: true, reason: 'unsupported-platform' };
  if (app.isPackaged) return { skipped: true, reason: 'packaged' };
  try {
    if (typeof app.setToastActivatorCLSID === 'function') {
      app.setToastActivatorCLSID(DEV_TOAST_ACTIVATOR_CLSID);
    }
    const appUserModelId =
      typeof app.getAppUserModelId === 'function' && app.getAppUserModelId()
        ? app.getAppUserModelId()
        : DEV_APP_USER_MODEL_ID;
    const shortcutPath = path.join(
      app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', DEV_START_MENU_SHORTCUT_NAME
    );
    return writeVerifiedShortcut({
      shell,
      shortcutPath,
      details: buildDevStartMenuShortcutDetails({ appRoot, execPath, appUserModelId }),
      logger,
      eventPrefix: 'shortcut.start_menu',
    });
  } catch (error) {
    logger('WARN', 'shortcut.start_menu_create_failed', {
      message: String(error && error.message ? error.message : error),
    });
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

module.exports = {
  APP_USER_MODEL_ID,
  DEV_APP_USER_MODEL_ID,
  DEV_START_MENU_SHORTCUT_NAME,
  DEV_TOAST_ACTIVATOR_CLSID,
  DEV_LAUNCHER_NAME,
  DEV_WINDOWS_SHORTCUT_NAME,
  LEGACY_WINDOWS_SHORTCUT_NAME,
  WINDOWS_SHORTCUT_NAME,
  buildDesktopShortcutOptions,
  buildDevStartMenuShortcutDetails,
  ensureDesktopShortcut,
  ensureDevStartMenuShortcut,
  getDevLauncherPath,
  resolveAppUserModelId,
};
