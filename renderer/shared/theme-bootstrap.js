(function bootstrapJennyAppearance(globalScope) {
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
      projected = rawProjection ? JSON.parse(rawProjection) : null;
      if (projected && storage && typeof appearanceUtils.saveAppearancePreferences === 'function') {
        appearanceUtils.saveAppearancePreferences(storage, projected);
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
