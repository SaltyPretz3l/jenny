'use strict';

const os = require('os');
const path = require('path');

const { PortablePreferencesStore } = require('../data-lifecycle/portable-preferences-store');
const { attemptPendingRestore, finalizeRestoredBoot } = require('../data-lifecycle/restore-service');
const { UNINSTALL_EXIT_CODES } = require('../data-lifecycle/uninstall-contract');
const { isUninstallAssistantMode, runStandaloneUninstallAssistant } = require('./uninstall-assistant-main');

function runtimePath() {
  return path.join(os.homedir(), '.companion');
}

function readPortableAppearance(app) {
  return new PortablePreferencesStore(app.getPath('userData')).read()?.appearance || null;
}

async function promotePendingRestore(app, nativeImage, log = () => {}) {
  const result = await attemptPendingRestore({
    userDataPath: app.getPath('userData'),
    runtimePath: runtimePath(),
    nativeImage,
  });
  if (!result.ok) log('WARN', 'data_lifecycle.restore_promotion_failed', result.error);
  return result;
}

async function finalizeSuccessfulRestoredBoot(app, log = () => {}) {
  try {
    return await finalizeRestoredBoot(app.getPath('userData'));
  } catch (error) {
    log('WARN', 'data_lifecycle.restore_finalize_failed', {
      reason: String(error?.reason || 'finalize_failed'),
    });
    return false;
  }
}

function startUninstallAssistant(argv, rootDir, { electronLike = null, runAssistant = runStandaloneUninstallAssistant } = {}) {
  if (!isUninstallAssistantMode(argv)) return false;
  const { app, BrowserWindow, dialog, ipcMain, nativeImage } = electronLike || require('electron');
  void Promise.resolve()
    .then(() => runAssistant({ app, BrowserWindow, ipcMain, dialog, nativeImage, rootDir }))
    .catch(() => app.exit(UNINSTALL_EXIT_CODES.HELPER_FAILURE));
  return true;
}

module.exports = {
  finalizeSuccessfulRestoredBoot,
  promotePendingRestore,
  readPortableAppearance,
  startUninstallAssistant,
};
