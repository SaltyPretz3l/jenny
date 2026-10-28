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
  if (acquireLock(app, onSecondInstance)) return MAIN_BOOT_MODES.PRIMARY;
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
