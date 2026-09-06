/* renderer/features/renderer-ide-qol-wiring.js - a thin composition collector
 * for the Workspace IDE quality-of-life chrome modules (breadcrumb navigation,
 * the Ctrl+Tab MRU tab switcher, and save-time hygiene). The IDE controller sits
 * at the 1015-line file ceiling, so rather than each new QoL feature adding its
 * own construct/bind/dispose trio to the controller, the controller builds ONE
 * collector and calls bindAll()/disposeAll(); each feature plugs its module in
 * here instead. The collector owns no behavior of its own — it only resolves the
 * sibling modules (degrading to null when one isn't present) and fans the
 * lifecycle calls out to them, so adding it is a no-op until the modules exist. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeQolWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

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

  function createIdeQolWiring(deps) {
    const d = deps || {};
    const getDom = typeof d.getDom === 'function' ? d.getDom : () => ({});
    const getIde = typeof d.getIde === 'function' ? d.getIde : () => ({});
    const editorHost = d.editorHost || null;
    const windowRef = d.windowRef || globalRef.window || globalRef;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : (v) => String(v == null ? '' : v);
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const getWorkspaceFsApi = typeof d.getWorkspaceFsApi === 'function' ? d.getWorkspaceFsApi : () => null;
    const getFileOperations = typeof d.getFileOperations === 'function' ? d.getFileOperations : () => null;
    const onOpenFile = typeof d.onOpenFile === 'function' ? d.onOpenFile : noop;
    const chooseWorkspaceRoot = typeof d.chooseWorkspaceRoot === 'function' ? d.chooseWorkspaceRoot : null;
    const onRevealInExplorer = typeof d.onRevealInExplorer === 'function' ? d.onRevealInExplorer : noop;
    const onOpenSymbolPicker = typeof d.onOpenSymbolPicker === 'function' ? d.onOpenSymbolPicker : noop;
    const sendToJenny = typeof d.sendToJenny === 'function' ? d.sendToJenny : null;
    const getGitDecoration = typeof d.getGitDecoration === 'function' ? d.getGitDecoration : null;
    const subscribeGitChange = typeof d.subscribeGitChange === 'function' ? d.subscribeGitChange : null;
    const activateTab = typeof d.activateTab === 'function' ? d.activateTab : noop;
    const getRecentFiles = typeof d.getRecentFiles === 'function' ? d.getRecentFiles : () => [];
    const getOpenTabs = typeof d.getOpenTabs === 'function' ? d.getOpenTabs : () => (getIde().openTabs || []);
    const getActiveView = typeof d.getActiveView === 'function' ? d.getActiveView : () => 'ide';
    const getWorkspaceId = typeof d.getWorkspaceId === 'function' ? d.getWorkspaceId : () => '';
    // Canonical workspace-root identity (WIDE-030): { rootId, generation }
    // from state.workspaceRoot. The File Map keys persistence and scan
    // bindings off THIS — never the legacy session-workspace id above.
    const getWorkspaceRootContext = typeof d.getWorkspaceRootContext === 'function'
      ? d.getWorkspaceRootContext
      : null;
    const getFeatureFlags = typeof d.getFeatureFlags === 'function' ? d.getFeatureFlags : () => ({});
    const ideStateUtils = d.ideStateUtils || {};
    const requestRender = typeof d.requestRender === 'function' ? d.requestRender : noop;
    // Living Atlas seam (W3): the ONE shared activity bus (constructed at the
    // app layer, alongside handlePresenceStreamEvent) and the active chat
    // session id accessor, both handed straight to the map controller's
    // presenter below.
    const activityBus = d.activityBus || null;
    const getActiveSessionId = typeof d.getActiveSessionId === 'function' ? d.getActiveSessionId : () => '';
    const getChangeLedger = typeof d.getChangeLedger === 'function' ? d.getChangeLedger : () => ({ changes: [] });
    const openChangeDiff = typeof d.openChangeDiff === 'function' ? d.openChangeDiff : null;
    const openChangesPanel = typeof d.openChangesPanel === 'function' ? d.openChangesPanel : noop;
    const showShellErrorToast = typeof d.showShellErrorToast === 'function' ? d.showShellErrorToast : noop;

    // Breadcrumb v2: folder-crumb dropdown navigation + leaf-crumb symbol picker.
    const breadcrumbs = resolveModule('rendererIdeBreadcrumbs', './renderer-ide-breadcrumbs')
      .createIdeBreadcrumbs?.({
        getDom, getIde, getWorkspaceFsApi, escapeHtml, appendClientLog,
        onOpenFile, onRevealInExplorer, onOpenSymbolPicker,
      }) || null;

    // Ctrl+Tab most-recently-used tab switcher overlay.
    const mruSwitcher = resolveModule('rendererIdeMruSwitcher', './renderer-ide-mru-switcher')
      .createIdeMruSwitcher?.({
        getDom, windowRef, escapeHtml, appendClientLog,
        getRecentFiles, getOpenTabs, activateTab, getActiveView,
      }) || null;

    // Save-time hygiene (format-on-save / trim trailing whitespace / final
    // newline). The controller threads its applySaveHygiene into the file
    // lifecycle's saveFile; the collector just owns construction + disposal.
    const saveHygiene = resolveModule('rendererIdeSaveHygiene', './renderer-ide-save-hygiene')
      .createIdeSaveHygiene?.({ editorHost, getIde, appendClientLog }) || null;

    // Workspace File Map (P1): renders in a stage sibling of the editor, not
    // an editor document, so it plugs into this collector like its siblings.
    // activateStage is a lazy thunk — the stage-surface controller is built
    // AFTER the surfaces it coordinates (it takes direct refs to them).
    const mapController = resolveModule('rendererIdeMapController', './renderer-ide-map-controller')
      .createIdeMapController?.({
        getDom, getIde, windowRef, escapeHtml, appendClientLog, onOpenFile, chooseWorkspaceRoot,
        activateStage: (surface) => stageSurface?.activate(surface),
        // WIDE-030: the map takes the CANONICAL root context, not the legacy
        // getWorkspaceId (whose production value was activeWorkspaceId ||
        // 'default' — a shared key for every root).
        getWorkspaceRootContext, getFeatureFlags, sendToJenny, getGitDecoration, subscribeGitChange,
        activityBus, getActiveSessionId,
      }) || null;

    // Exploded View: a code<->exploded toggle on a TS/JS file tab, rendered in a
    // stage sibling of the editor (#ideExplodedHost). Per-file, so it needs the
    // state reducers (viewMode) + a re-render hook. A viewMode flip also moves
    // the stage machine so toggling from the palette exits Preview/File Map.
    const explodeController = resolveModule('rendererIdeExplodeController', './renderer-ide-explode-controller')
      .createIdeExplodeController?.({
        getDom, getIde, editorHost, windowRef, escapeHtml,
        getWorkspaceId, getFeatureFlags, ideStateUtils, requestRender,
        onViewModeApplied: (mode) => stageSurface?.activate(mode === 'exploded' ? 'exploded' : 'editor'),
      }) || null;

    // Stage-surface state machine (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md):
    // the single owner of editor-stage visibility (editor | preview | file_map
    // | exploded). renderIde() calls stageSurface.sync() instead of fanning
    // syncVisibility out to each surface itself. The preview stage module is
    // resolved lazily (it ships in a later wave / may be absent in a build).
    const stageSurface = resolveModule('rendererIdeStageSurfaceController', './renderer-ide-stage-surface-controller')
      .createIdeStageSurfaceController?.({
        getDom, getIde, ideStateUtils, getFeatureFlags, windowRef, appendClientLog,
        schedulePersist: typeof d.schedulePersist === 'function' ? d.schedulePersist : noop,
        requestRender,
        mapController,
        explodeController,
        getPreviewStage: () => previewStage,
      }) || null;
    // Unified Preview stage (workspace_preview_surface): content owner for
    // #idePreviewHost. Constructed AFTER the stage controller (it activates
    // through it), resolved by the controller lazily via getPreviewStage.
    let previewStage = null;
    previewStage = resolveModule('rendererIdePreviewStage', './renderer-ide-preview-stage')
      .createIdePreviewStage?.({
        getDom, getIde, ideStateUtils, editorHost, getWorkspaceFsApi, getFileOperations,
        escapeHtml, appendClientLog, windowRef,
        activateStage: (surface) => stageSurface?.activate(surface),
        schedulePersist: typeof d.schedulePersist === 'function' ? d.schedulePersist : noop,
      }) || null;

    // Model-initiated presentation policy (workspace_present tool, Phase 7):
    // coalesces one-shot workspacePresentation.onRequest pushes and either
    // applies them (safe) or raises the non-stealing "Jenny wants to show…"
    // chip. Routes into the preview stage + map controller above.
    const presentation = resolveModule('rendererWorkspacePresentationController', './renderer-workspace-presentation-controller')
      .createWorkspacePresentationController?.({
        getDom, windowRef, escapeHtml, appendClientLog, getActiveView,
        openPreview: (path) => previewStage?.open(path),
        openFileMap: () => mapController?.openFileMap(),
        revealInMap: (path) => mapController?.revealInMap?.(path),
        getSessionId: getActiveSessionId,
        getWorkspaceId: () => String(getWorkspaceRootContext?.()?.rootId || '').toLowerCase(),
        getChangeLedger,
        openChangeDiff,
        openChangesPanel,
        showShellErrorToast,
        isSurfaceEnabled: (view) => {
          const flags = getFeatureFlags() || {};
          return view === 'preview'
            ? flags.workspace_preview_surface === true
            : view === 'file_map'
              ? flags.workspace_file_map === true
              : view === 'change_diff' && flags.tools_workspace_present_enabled === true;
        },
      }) || null;

    // Palette-facing nav helpers: both act on the ACTIVE FILE tab (review
    // surfaces like map://, diff://, preview:// have no node in the graph).
    function activeFilePath() {
      const path = (getIde() || {}).activeTabPath;
      return path && !String(path).includes('://') ? path : null;
    }

    function revealActiveFileInMap() {
      const path = activeFilePath();
      if (path) mapController?.revealInMap?.(path);
    }

    // Blast radius needs the map open and the node framed first —
    // revealInMap handles both, then the dependents light up.
    function blastActiveFileInMap() {
      const path = activeFilePath();
      if (!path) return;
      Promise.resolve(mapController?.revealInMap?.(path))
        .then(() => mapController?.showBlastRadius?.(path))
        .catch(() => {});
    }

    function bindAll() {
      breadcrumbs?.bindEvents();
      mruSwitcher?.bindEvents();
      mapController?.bindEvents();
      stageSurface?.bindEvents();
      presentation?.bindEvents();
    }

    function disposeAll() {
      breadcrumbs?.dispose();
      mruSwitcher?.dispose();
      saveHygiene?.dispose();
      mapController?.dispose();
      explodeController?.dispose();
      stageSurface?.dispose();
      previewStage?.dispose?.();
      presentation?.dispose();
    }

    // payload carries the transition's committed { context } (WIDE-030): the
    // map adopts the new rootId/generation from it before rescanning.
    function handleWorkspaceRootCommitted(payload) {
      mapController?.handleWorkspaceRootCommitted?.(payload);
      // Living Atlas seam: heat/trail rel paths are root-relative — a root
      // switch invalidates every one of them (see activity-bus clearAll doc).
      activityBus?.clearAll?.();
      previewStage?.handleWorkspaceRootCommitted?.();
      // UIUX-013: the exploded-view graph cache is keyed only by
      // path@altVersion, which a new root can collide with at the identical
      // key; drop it on every root commit (see explode-controller.resetForRoot).
      explodeController?.resetForRoot?.();
    }

    return { breadcrumbs, mruSwitcher, saveHygiene, mapController, explodeController, stageSurface, previewStage, presentation, revealActiveFileInMap, blastActiveFileInMap, bindAll, disposeAll, handleWorkspaceRootCommitted };
  }

  return { createIdeQolWiring };
});
