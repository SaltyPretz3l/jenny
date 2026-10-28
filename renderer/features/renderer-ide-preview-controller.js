/* renderer/features/renderer-ide-preview-controller.js - the Workspace IDE's
 * Open Preview entry (W8). Owns which paths are previewable and the context
 * menu item that pins the target on the unified Preview stage
 * (renderer-ide-preview-stage.js owns reading, rendering and live updates).
 * Kept out of renderer-ide-controller for the 1015-line file ceiling. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePreviewController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  function createIdePreviewController(deps) {
    const callbacks = deps?.callbacks || {};
    const openPreviewStage = typeof callbacks.openPreviewStage === 'function'
      ? callbacks.openPreviewStage
      : () => {};
    const ideStateUtils = resolveModule('rendererIdeState', './renderer-ide-state');
    // Exactly what the stage renders (markdown/mermaid + sandboxed HTML); read at
    // construction because the stage script loads after this one.
    const stageUtils = resolveModule('rendererIdePreviewStage', './renderer-ide-preview-stage');
    const PREVIEW_EXTENSIONS = new Set([...(stageUtils.MARKDOWN_EXTENSIONS || []), ...(stageUtils.HTML_EXTENSIONS || [])]);

    function isPreviewablePath(path) {
      if (ideStateUtils.isDiffTabId?.(path) || ideStateUtils.isPreviewTabId?.(path)) {
        return false;
      }
      return PREVIEW_EXTENSIONS.has(ideStateUtils.fileExtensionOf?.(path) || '');
    }

    // Pins the target on the Preview stage, which owns reading/rendering
    // (incl. its bounded missing/binary/too-large states).
    function openPreview(sourcePath) {
      const normalized = ideStateUtils.normalizeIdeRelativePath?.(sourcePath) || '';
      if (!normalized || !isPreviewablePath(normalized)) {
        return false;
      }
      openPreviewStage(normalized);
      return true;
    }

    function buildPreviewMenuItems(path) {
      if (!isPreviewablePath(path)) {
        return [];
      }
      return [
        { separator: true },
        { label: jt('ide.preview.open', 'Open Preview'), action: () => openPreview(path) },
      ];
    }

    return {
      buildPreviewMenuItems,
      isPreviewablePath,
      openPreview,
    };
  }

  return {
    createIdePreviewController,
  };
});
