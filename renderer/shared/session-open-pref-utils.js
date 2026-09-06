/* renderer/shared/session-open-pref-utils.js
 *
 * Tiny renderer-only sticky preference: when the user clicks an EXISTING session
 * (sidebar history / command palette), should it open in a NEW tab or REPLACE the
 * active tab? Default (off / absent) = replace; on = always new tab.
 *
 * Backed by localStorage and read synchronously at click time. (The
 * `jenny.composer.planMode` sticky pref this originally mirrored was retired
 * with the P4 composer run-mode work; run_mode is store-owned now.) No IPC, no
 * config schema, no CONFIG_VERSION bump. The + new-chat button is unaffected
 * (it pins mode:new-tab).
 */
(function exposeSessionOpenPrefUtils(globalScope, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  if (globalScope && typeof globalScope === 'object') {
    globalScope.sessionOpenPrefUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function sessionOpenPrefUtilsFactory() {
  var STORAGE_KEY = 'jenny.sessions.openInNewTab';

  function getOpenSessionsInNewTab() {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
    } catch (_storageErr) {
      return false;
    }
  }

  function setOpenSessionsInNewTab(value) {
    try {
      if (value) {
        globalThis.localStorage?.setItem(STORAGE_KEY, '1');
      } else {
        globalThis.localStorage?.removeItem(STORAGE_KEY);
      }
      return true;
    } catch (storageError) {
      throw new Error('Could not save the session-opening preference.', { cause: storageError });
    }
  }

  return { STORAGE_KEY, getOpenSessionsInNewTab, setOpenSessionsInNewTab };
});
