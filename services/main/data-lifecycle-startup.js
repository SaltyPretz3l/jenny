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
  // Restored chat coordination (row 59 cp5b-3): ids and reason tokens only, never record content.
  const coordination = result.ok ? result.coordination : null;
  if (coordination && (coordination.quarantined?.length || coordination.ignored?.length || coordination.unavailable_links?.length)) {
    log('WARN', 'data_lifecycle.restore_coordination_partial', {
      applied: coordination.applied, quarantined: coordination.quarantined, ignored: coordination.ignored,
      unavailableLinks: coordination.unavailable_links,
    });
  }
  // A derived index left behind is stale for the restored profile; the sidecar replaces it.
  const retained = result.derivedIndexes?.retained || [];
  if (retained.length) log('WARN', 'data_lifecycle.derived_index_retained', { retained });
  return result;
}

async function finalizeSuccessfulRestoredBoot(app, log = () => {}) {
  try {
    return await finalizeRestoredBoot(app.getPath('userData'), { runtimePath: runtimePath() });
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
