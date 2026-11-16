'use strict';

// The first decision main.js makes, before its ~740-module graph loads: is this
// process the app, the standalone uninstall assistant, a second launch, or a
// plain require (tests, tooling)? A second launch takes the single-instance
// lock here, which wakes the running app's 'second-instance' handler at once,
// and exits without loading anything else. Keep this module's own requires
// light: everything it pulls in is paid by every launch before the lock.

const { applySingleInstance } = require('../apply-single-instance');
const { shouldBypassSingleInstanceForPackagedSmoke } = require('./packaged-smoke');
const { shouldAutoStartMainProcess } = require('./main-process-policy');
const { buildSecondLaunchData } = require('./outside-files/outside-file-args');

const MAIN_BOOT_MODES = Object.freeze({
  INERT: 'inert',
  UNINSTALL: 'uninstall',
  PRIMARY: 'primary',
  SECOND_INSTANCE: 'second-instance',
});

function isUninstallAssistantMode(argv = process.argv) {
  return Array.isArray(argv) && argv.includes('--uninstall-assistant');
}

function resolveMainBootMode({
  app,
  argv = process.argv,
  packagedSmokeConfig = {},
  onSecondInstance = () => {},
  shouldAutoStart = shouldAutoStartMainProcess,
  acquireLock = applySingleInstance,
} = {}) {
  if (!shouldAutoStart()) return MAIN_BOOT_MODES.INERT;
  // The uninstall assistant runs beside a live app by design; it never locks.
  if (isUninstallAssistantMode(argv)) return MAIN_BOOT_MODES.UNINSTALL;
  if (shouldBypassSingleInstanceForPackagedSmoke(packagedSmokeConfig)) return MAIN_BOOT_MODES.PRIMARY;
  // A second launch hands its "Open with Jenny" files to the running app as
  // lock data (row 137); the primary ignores its own copy.
  const additionalData = buildSecondLaunchData(argv, { isPackaged: Boolean(app && app.isPackaged), platform: process.platform, cwd: process.cwd() });
  if (acquireLock(app, onSecondInstance, { additionalData })) return MAIN_BOOT_MODES.PRIMARY;
  // applySingleInstance already asked to quit; app.exit before the message loop
  // runs ends the process now instead of after the rest of main.js loads.
  app.exit(0);
  return MAIN_BOOT_MODES.SECOND_INSTANCE;
}

module.exports = {
  MAIN_BOOT_MODES,
  isUninstallAssistantMode,
  resolveMainBootMode,
};
