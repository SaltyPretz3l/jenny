/* renderer/features/renderer-ide-stage-surface-controller.js — the single
 * owner of editor-stage-surface visibility for the Workspace IDE
 * (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md). Exactly one of
 * editor | preview | file_map | exploded is visible inside #ideEditorStage at
 * a time; the persisted enum lives at ide.activeStageSurface
 * (renderer-ide-state.js STAGE_SURFACES) and THIS module is the only writer.
 *
 * Feature flags are applied at render time because they hydrate late. Exploded
 * state derives from the active file tab's viewMode. Bootstrap suppresses one
 * activation reset so a restored preview or file_map surface survives.
 *
 * sync() is called from renderIde() and is the ONLY place the three overlay
 * hosts (#ideMapHost / #ideExplodedHost / #idePreviewHost) are shown/hidden;
 * the editor host stays mounted beneath them (keep-alive, Monaco layout). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeStageSurfaceController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  // Mirrors renderer-ide-explode-controller.js TSJS_RE (kept in sync by
  // convention; the explode controller re-gates on its own copy anyway).
  const TSJS_RE = /\.(tsx|ts|jsx|js|mjs|cjs)$/i;

  function createIdeStageSurfaceController(deps) {
    const d = deps || {};
    const getDom = typeof d.getDom === 'function' ? d.getDom : () => ({});
    const getIde = typeof d.getIde === 'function' ? d.getIde : () => ({});
    const ideStateUtils = d.ideStateUtils || {};
    const getFeatureFlags = typeof d.getFeatureFlags === 'function' ? d.getFeatureFlags : () => ({});
    const schedulePersist = typeof d.schedulePersist === 'function' ? d.schedulePersist : noop;
    const requestRender = typeof d.requestRender === 'function' ? d.requestRender : noop;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const windowRef = d.windowRef || globalRef.window || globalRef;
    // Stage siblings. Each is optional (absent in a partial build/test); sync()
    // degrades to plain host hiding for any missing controller.
    const mapController = d.mapController || null;
    const explodeController = d.explodeController || null;
    // Resolve the Preview stage lazily so composition order and partial test builds remain safe.
    const getPreviewStage = typeof d.getPreviewStage === 'function' ? d.getPreviewStage : () => null;

    let bound = false;
    let disposed = false;
    let suppressOnce = false;

    function flags() {
      return getFeatureFlags() || {};
    }
    function isPreviewEnabled() {
      return flags().workspace_preview_surface === true;
    }
    function isMapEnabled() {
      return flags().workspace_file_map === true;
    }
    function isExplodedEnabled() {
      return flags().workspace_exploded_view === true;
    }

    function coerce(value) {
      return typeof ideStateUtils.coerceStageSurface === 'function'
        ? ideStateUtils.coerceStageSurface(value)
        : 'editor';
    }

    // Editor-cluster derivation: a TS/JS FILE tab whose per-file viewMode is
    // 'exploded'. Synthetic ids (diff://, legacy preview://) never qualify.
    function explodedEligible(ide) {
      const path = (ide && ide.activeTabPath) || '';
      if (!path || String(path).includes('://') || !TSJS_RE.test(path)) {
        return false;
      }
      return typeof ideStateUtils.getTabViewMode === 'function'
        && ideStateUtils.getTabViewMode(ide, path) === 'exploded';
    }

    // The surface actually shown this render: flag-gated view of the stored
    // enum, with the editor cluster split by the active tab's viewMode.
    function getEffectiveSurface() {
      const ide = getIde() || {};
      const stored = coerce(ide.activeStageSurface);
      if (stored === 'preview' && isPreviewEnabled()) {
        return 'preview';
      }
      if (stored === 'file_map' && isMapEnabled()) {
        return 'file_map';
      }
      return isExplodedEnabled() && explodedEligible(ide) ? 'exploded' : 'editor';
    }

    // User/model-initiated switch. Flag-off targets are rejected (returns the
    // surface still in effect) rather than stored, so a hidden feature can
    // never be persisted into view.
    function activate(surface) {
      if (disposed) {
        return getEffectiveSurface();
      }
      const allowed = surface === 'editor'
        || (surface === 'preview' && isPreviewEnabled())
        || (surface === 'file_map' && isMapEnabled())
        || (surface === 'exploded' && isExplodedEnabled());
      if (!allowed) {
        appendClientLog('WARN', 'ide_stage.activate_rejected', { surface: String(surface || '') });
        return getEffectiveSurface();
      }
      const ide = getIde();
      const before = coerce(ide.activeStageSurface);
      if (typeof ideStateUtils.setStageSurface === 'function') {
        ideStateUtils.setStageSurface(ide, surface);
      }
      if (before !== surface) {
        schedulePersist();
      }
      requestRender();
      return getEffectiveSurface();
    }

    // Rail stage buttons are genuine toggles (they already carry aria-pressed):
    // re-activating the surface already in effect returns to the editor cluster.
    // activate() stays idempotent for open()/openFileMap()/viewMode callers.
    function toggle(surface) {
      if (disposed) return getEffectiveSurface();
      return activate(getEffectiveSurface() === surface ? 'editor' : surface);
    }

    // Handoff §C.2: activating any editor document pulls the stage back to the
    // editor cluster (which itself derives editor vs exploded per tab). The
    // one-shot suppression covers the bootstrap's hydrate-time
    // openFile(activeTabPath), which must not clobber a restored surface.
    function noteEditorActivation() {
      if (disposed) {
        return;
      }
      if (suppressOnce) {
        suppressOnce = false;
        return;
      }
      const ide = getIde();
      const stored = coerce(ide.activeStageSurface);
      if (stored === 'preview' || stored === 'file_map') {
        if (typeof ideStateUtils.setStageSurface === 'function') {
          ideStateUtils.setStageSurface(ide, 'editor');
        }
        schedulePersist();
        requestRender();
      }
    }

    function suppressNextActivationReset() {
      suppressOnce = true;
    }

    // Belt-and-braces channel for document activations that do not flow
    // through the file lifecycle (diff review tabs, ghost-edit auto-opens):
    // the editor host dispatches 'ide:active-file-changed' on the global.
    function handleActiveFileChanged() {
      noteEditorActivation();
    }

    function bindEvents() {
      if (bound || disposed || typeof windowRef.addEventListener !== 'function') {
        return;
      }
      bound = true;
      windowRef.addEventListener('ide:active-file-changed', handleActiveFileChanged);
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (bound && typeof windowRef.removeEventListener === 'function') {
        windowRef.removeEventListener('ide:active-file-changed', handleActiveFileChanged);
      }
      bound = false;
    }

    // The single write-through visibility point, called from renderIde().
    // Order matters only in that every host is driven every pass — a surface
    // can never linger visible after a switch (the stacking bug the machine
    // exists to prevent).
    function sync() {
      if (disposed) {
        return;
      }
      const surface = getEffectiveSurface();
      const ide = getIde() || {};
      const dom = getDom() || {};
      // Stamp the effective (flag-gated) surface on the common parent so CSS
      // can make the mounted Monaco layer genuinely exclusive with Preview /
      // File Map / Exploded View. Keeping Monaco mounted preserves models,
      // undo history, and scroll state; visibility + inertness prevent its
      // descendants (notably the minimap) from painting or retaining focus
      // above an overlay stage.
      if (dom.ideMain?.dataset && dom.ideMain.dataset.stageSurface !== surface) {
        dom.ideMain.dataset.stageSurface = surface;
      }
      const editorVisible = surface === 'editor';
      const editorLayers = [dom.ideEditorHost, dom.ideEditorFallback, dom.ideEmptyState];
      for (const layer of editorLayers) {
        if (!layer || typeof layer.toggleAttribute !== 'function') continue;
        layer.toggleAttribute('inert', !editorVisible);
        layer.setAttribute('aria-hidden', editorVisible ? 'false' : 'true');
      }
      if (!editorVisible) {
        const activeElement = dom.ideMain?.ownerDocument?.activeElement;
        if (activeElement && editorLayers.some((layer) => layer?.contains?.(activeElement))) {
          activeElement.blur?.();
        }
      }
      // Preview host: hidden-class toggle here; the preview-stage module owns
      // the host's CONTENT and re-renders on its own sync hook.
      const previewHost = dom.idePreviewHost;
      if (previewHost && previewHost.classList) {
        previewHost.classList.toggle('hidden', surface !== 'preview');
      }
      getPreviewStage()?.sync?.(surface === 'preview');
      // File Map keeps its keep-alive mount + first-show scan behavior; it is
      // keyed by the synthetic map id, so feed it the id exactly when active.
      const mapActiveKey = surface === 'file_map'
        ? (ideStateUtils.MAP_TAB_ID || 'map://workspace')
        : '';
      mapController?.syncVisibility?.(mapActiveKey);
      // Exploded: within the editor cluster the controller derives show/hide
      // from the active tab's viewMode (and renders its Code|Exploded bar);
      // outside the cluster it gets '' → bar and host both hide.
      const clusterPath = surface === 'editor' || surface === 'exploded'
        ? (ide.activeTabPath || '')
        : '';
      explodeController?.syncVisibility?.(clusterPath);
      return surface;
    }

    return {
      activate,
      bindEvents,
      dispose,
      getEffectiveSurface,
      isMapEnabled,
      isPreviewEnabled,
      noteEditorActivation,
      suppressNextActivationReset,
      sync,
      toggle,
    };
  }

  return { createIdeStageSurfaceController };
});
