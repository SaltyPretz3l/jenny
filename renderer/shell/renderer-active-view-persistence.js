(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererActiveViewPersistence = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Last-active top-level view persistence (across app launches).
     New profiles have no persisted value and fall through to the existing
     'chat' boot default; first-run setup completion routes to (and persists)
     'home'. Stored in localStorage so it survives restarts without a
     CONFIG_VERSION bump; written by setActiveView, read at bootstrap. */
  var ACTIVE_VIEW_STORAGE_KEY = 'jenny.ui.activeView';
  // Removed top-level surfaces fall through to chat, except Memory: its
  // persisted view migrates to the restored Settings > Memory section.
  var PERSISTABLE_VIEW_IDS = ['home', 'chat', 'ide', 'logs', 'settings'];

  function resolveActiveViewStorage() {
    try {
      var win = (typeof window !== 'undefined' && window)
        || (typeof globalThis !== 'undefined' && globalThis.window)
        || null;
      return win && win.localStorage ? win.localStorage : null;
    } catch (_error) {
      return null;
    }
  }

  function readPersistedActiveView() {
    var storage = resolveActiveViewStorage();
    if (!storage) return '';
    try {
      var raw = String(storage.getItem(ACTIVE_VIEW_STORAGE_KEY) || '').trim();
      if (raw === 'memory') {
        storage.setItem('jenny.settings.activeSection', 'memories');
        return 'settings';
      }
      return PERSISTABLE_VIEW_IDS.indexOf(raw) >= 0 ? raw : '';
    } catch (_error) {
      return '';
    }
  }

  function persistActiveView(viewId) {
    var storage = resolveActiveViewStorage();
    if (!storage) return;
    var id = String(viewId || '').trim();
    if (PERSISTABLE_VIEW_IDS.indexOf(id) < 0) return;
    try {
      storage.setItem(ACTIVE_VIEW_STORAGE_KEY, id);
    } catch (_error) {
      /* storage full / blocked — view persistence is best-effort */
    }
  }

  return {
    ACTIVE_VIEW_STORAGE_KEY: ACTIVE_VIEW_STORAGE_KEY,
    PERSISTABLE_VIEW_IDS: PERSISTABLE_VIEW_IDS,
    readPersistedActiveView: readPersistedActiveView,
    persistActiveView: persistActiveView,
  };
});
