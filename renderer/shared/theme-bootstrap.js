(function bootstrapJennyAppearance(globalScope) {
  var APPEARANCE_STORAGE_KEY = 'jenny.appearance.v2';
  var PROJECTION_MARKER_KEY = 'jenny.appearance.appliedProjection.v1';
  // The startup_animation kill switch (env-only; main projects it into the
  // query) must be on the document before the boot curtain mounts its sky.
  try {
    var startupAnimationFlag = new URLSearchParams(globalScope.location.search).get('jennyStartupAnimation');
    if (startupAnimationFlag === 'off' && globalScope.document && globalScope.document.documentElement) {
      globalScope.document.documentElement.dataset.startupAnimationFlag = 'off';
    }
  } catch (flagError) {
    // Optional projection: the renderer re-reads the flag once it is fetched.
  }
  try {
    var appearanceUtils = globalScope && globalScope.appearanceUtils;
    if (!appearanceUtils || typeof appearanceUtils.applyAppearanceToDocument !== 'function') {
      return;
    }
    var doc = globalScope.document;
    if (!doc || !doc.documentElement) {
      return;
    }
    var storage = null;
    try {
      storage = globalScope.localStorage || null;
    } catch (storageError) {
      storage = null;
    }
    var projected = null;
    try {
      var rawProjection = new URLSearchParams(globalScope.location.search).get('jennyAppearance');
      // The window URL is fixed at launch, so a reload carries the launch-time
      // projection. Apply a given projection once: after that, localStorage
      // holds the newer in-session choices (the portable copy follows them).
      var appliedProjection = null;
      try {
        // Cleared storage (no saved record) takes the projection again.
        appliedProjection = storage && storage.getItem(APPEARANCE_STORAGE_KEY)
          ? storage.getItem(PROJECTION_MARKER_KEY)
          : null;
      } catch (markerError) {
        appliedProjection = null;
      }
      if (rawProjection && rawProjection !== appliedProjection) {
        projected = JSON.parse(rawProjection);
      }
      // The projection is a stored portable record, so it takes the same
      // type-scale migration as localStorage before it is saved.
      if (projected && typeof appearanceUtils.migrateStoredAppearancePreferences === 'function') {
        projected = appearanceUtils.migrateStoredAppearancePreferences(projected);
      }
      if (projected && storage && typeof appearanceUtils.saveAppearancePreferences === 'function') {
        appearanceUtils.saveAppearancePreferences(storage, projected);
        storage.setItem(PROJECTION_MARKER_KEY, rawProjection);
      }
    } catch (projectionError) {
      projected = null;
    }
    var preferences = projected || appearanceUtils.loadAppearancePreferences(storage);
    appearanceUtils.applyAppearanceToDocument(doc, preferences);
  } catch (error) {
    // Theme bootstrap should never block the shell from rendering.
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
