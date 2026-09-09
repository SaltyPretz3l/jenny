(function bootstrapJennyI18n(globalScope) {
  try {
    var i18n = globalScope && globalScope.jennyI18n;
    var doc = globalScope && globalScope.document;
    if (!i18n || typeof i18n.normalizeTag !== 'function' || !doc || !doc.documentElement) {
      return;
    }

    var storage = null;
    try {
      storage = globalScope.localStorage || null;
    } catch (storageError) {
      storage = null;
    }

    var storageKey = 'jenny.ui.language';
    var projectedTag = null;
    try {
      var searchParams = new globalScope.URLSearchParams(globalScope.location.search);
      if (searchParams.has('jennyUiLanguage')) {
        projectedTag = i18n.normalizeTag(searchParams.get('jennyUiLanguage'));
      }
    } catch (projectionError) {
      projectedTag = null;
    }

    if (projectedTag !== null && storage) {
      try {
        if (typeof storage.setItem === 'function') {
          storage.setItem(storageKey, projectedTag);
        } else {
          storage[storageKey] = projectedTag;
        }
      } catch (persistError) {
        // The normalized projection still applies for this window.
      }
    }

    var storedTag = null;
    if (projectedTag === null && storage) {
      try {
        storedTag = typeof storage.getItem === 'function' ? storage.getItem(storageKey) : storage[storageKey];
      } catch (readError) {
        storedTag = null;
      }
    }
    var tag = i18n.normalizeTag(projectedTag !== null ? projectedTag : (storedTag || 'en'));

    try {
      doc.documentElement.lang = tag;
    } catch (languageError) {
      // Language metadata is best-effort and must not block shell startup.
    }
    try {
      doc.documentElement.dir = i18n.dirForTag(tag);
    } catch (directionError) {
      // Direction metadata is best-effort and must not block shell startup.
    }

    if (tag === 'en') {
      return;
    }
    if (doc.readyState === 'loading') {
      try {
        doc.write('<script src="locales/' + tag + '.catalog.js"></scr' + 'ipt>');
      } catch (catalogError) {
        // A missing or invalid catalog leaves the English source strings intact.
      }
    }
    try {
      doc.addEventListener('DOMContentLoaded', function applyLocalizedStaticNodes() {
        try {
          i18n.applyStaticNodes(doc);
        } catch (applyError) {
          // Static localization is best-effort and must not block shell startup.
        }
      });
    } catch (listenerError) {
      // The shell remains usable with its English source strings.
    }
  } catch (error) {
    // Localization bootstrap should never block the shell from rendering.
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
