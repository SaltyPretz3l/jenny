const fs = require('fs');
const path = require('path');

const WINDOWS_SHORTCUT_NAME = 'Jenny.lnk';
// Shortcut name written by every build before the product was renamed from
// "Jenny Shell" to "Jenny" (1.0.0). Removed once the new shortcut is in place.
const LEGACY_WINDOWS_SHORTCUT_NAME = 'Jenny Shell.lnk';
const APP_USER_MODEL_ID = 'com.jenny.shell';
const DEV_LAUNCHER_NAME = 'launch-jenny.cmd';

function getDevLauncherPath(appRoot = path.resolve(__dirname, '..')) {
  return path.join(appRoot, DEV_LAUNCHER_NAME);
}

function buildDesktopShortcutOptions({
  appRoot = path.resolve(__dirname, '..'),
  execPath = process.execPath,
  isPackaged = false,
  appUserModelId = APP_USER_MODEL_ID,
} = {}) {
  const cwd = isPackaged ? path.dirname(execPath) : appRoot;
  const target = isPackaged ? execPath : getDevLauncherPath(appRoot);
  const icon = isPackaged ? execPath : path.join(appRoot, 'build', 'icon.ico');
  return {
    details: {
      target,
      args: '',
      cwd,
      description: 'Launch Jenny',
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
    && actual.appUserModelId === expected.appUserModelId;
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
        : APP_USER_MODEL_ID;
    const { details } = buildDesktopShortcutOptions({
      appRoot,
      execPath,
      isPackaged: Boolean(app.isPackaged),
      appUserModelId,
    });
    const shortcutPath = path.join(desktopPath, WINDOWS_SHORTCUT_NAME);
    // #11: skip the disk rewrite when an existing shortcut already matches -- the
    // common case on every relaunch. Only the fields we set are compared.
    if (typeof shell.readShortcutLink === 'function') {
      try {
        const existing = shell.readShortcutLink(shortcutPath);
        if (shortcutDetailsMatch(existing, details)) {
          logger('INFO', 'shortcut.desktop_unchanged', { shortcutPath });
          removeLegacyDesktopShortcut({ desktopPath, shell, details, logger });
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
      logger('WARN', 'shortcut.desktop_create_failed', { shortcutPath });
      return { ok: false, shortcutPath, reason: 'write-failed' };
    }
    if (typeof shell.readShortcutLink === 'function') {
      try {
        const verified = shell.readShortcutLink(shortcutPath);
        if (!shortcutDetailsMatch(verified, details)) {
          logger('WARN', 'shortcut.desktop_verify_failed', { shortcutPath });
          return { ok: false, shortcutPath, reason: 'verify-failed' };
        }
      } catch (error) {
        logger('WARN', 'shortcut.desktop_verify_failed', {
          shortcutPath,
          message: String(error && error.message ? error.message : error),
        });
        return { ok: false, shortcutPath, reason: 'verify-failed' };
      }
    }

    logger('INFO', 'shortcut.desktop_ready', {
      shortcutPath,
      target: details.target,
      args: details.args,
    });
    removeLegacyDesktopShortcut({ desktopPath, shell, details, logger });
    return { ok: true, shortcutPath };
  } catch (error) {
    logger('WARN', 'shortcut.desktop_create_failed', {
      message: String(error && error.message ? error.message : error),
    });
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

module.exports = {
  APP_USER_MODEL_ID,
  DEV_LAUNCHER_NAME,
  LEGACY_WINDOWS_SHORTCUT_NAME,
  WINDOWS_SHORTCUT_NAME,
  buildDesktopShortcutOptions,
  ensureDesktopShortcut,
  getDevLauncherPath,
};
