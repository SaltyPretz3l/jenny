(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'), (function loadPanelV2() {
      try { return require('../features/renderer-artifact-panel-v2-render'); } catch (_error) { return null; }
    })(), (function loadFilePreview() {
      try { return require('../features/renderer-artifact-file-preview'); } catch (_error) { return null; }
    })(), (function loadTaskRail() {
      try { return require('../features/renderer-task-rail'); } catch (_error) { return null; }
    })());
    return;
  }
  root.rendererShellArtifactBridgeUtils = factory(
    root.inventoryActionButton,
    root.rendererArtifactPanelV2 || null,
    root.rendererArtifactFilePreview || null,
    root.rendererTaskRail || null
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventoryActionButton, artifactPanelV2Module, artifactFilePreviewModule, taskRailModule) {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}
  function noopNull() { return null; }
  function noopArr() { return []; }

  function createShellArtifactBridge(deps) {
    const {
      state,
      windowRef = globalRef.window || globalRef,
      dom = {},
      lazyDom = {},
      constants = {},
      buildArtifactsFromMessages = noopArr,
      artifactsUtils = {},
      registerCleanup = noop,
      callbacks = {},
      codeReview = {},
    } = deps || {};

    const {
      workspace = null,
      sidebar = null,
      sidebarResizer = null,
      chatView = null,
      chatTimeline = null,
      artifactReviewPanel = null,
    } = dom;
    const codeReviewRailDeps = codeReview && typeof codeReview === 'object' ? codeReview : {};
    const {
      getArtifactsDom = noopArr,
    } = lazyDom;
    const {
      escapeHtml = function fallbackEscapeHtml(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      },
      getActiveSession = noopNull,
      getSessionMonogram = noop,
      setActiveView = noop,
      scrollMessageIntoView = noop,
      renderAll = noop,
      updateComposerSafeOffset = noop,
      appendClientLog = noop,
      showToastMessage = noop,
      getProjectionContext = noopNull,
      getChatTimelineRowModelEnabled = function noopGetChatTimelineRowModelEnabled() { return false; },
      recordChatTimelineRolloutSignal = function noopRecordChatTimelineRolloutSignal() { return { logged: false, count: 0 }; },
      rollbackChatTimelineRowModel = function noopRollbackChatTimelineRowModel() { return false; },
      toErrorMessage = function fallbackToErrorMessage(error) {
        return String(error && error.message || error || '');
      },
    } = callbacks;

    const ARTIFACT_REVIEW_STORAGE_KEY =
      String(constants.ARTIFACT_REVIEW_STORAGE_KEY || 'jenny.artifactReview.v1');

    let artifactSurfaceController = null;
    let artifactSurfaceBound = false;
    let panelV2Controller = null;
    // Cache the parsed review prefs keyed by the raw stored string. renderAll (per
    // streaming frame, while the surface controller is still null) re-reads this;
    // keying on the literal stored value means a write here or in another window
    // is picked up on the next read, so the cache only ever skips re-parsing an
    // unchanged blob -- it cannot go stale.
    let cachedReviewPrefsRaw = null;
    let cachedReviewPrefs = null;
    const artifactSessionCache = new Map();
    let codeReviewRailController = null;
    let codeReviewRailBound = false;
    let filePreviewController = null;
    let filePreviewBound = false;
    let taskRailController = null;
    // Artifact Panel V2: per-entry validation for the per-session width map —
    // non-empty string key, finite positive number, clamped to the static
    // 320..560 range; malformed entries dropped; oversized maps trimmed to the
    // newest 40 (matching the prefs module's oldest-first eviction).
    function normalizeArtifactReviewWidthBySession(value) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const normalized = {};
      for (const key of Object.keys(source)) {
        const sessionId = String(key || '').trim();
        const numeric = Number(source[key]);
        if (!sessionId || !Number.isFinite(numeric) || numeric <= 0) continue;
        normalized[sessionId] = Math.max(320, Math.min(560, Math.round(numeric)));
      }
      const keys = Object.keys(normalized);
      for (let i = 0; i < keys.length - 40; i += 1) {
        delete normalized[keys[i]];
      }
      return normalized;
    }

    function normalizeArtifactReviewMaximizedBySession(value) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const normalized = {};
      for (const key of Object.keys(source)) {
        const sessionId = String(key || '').trim();
        if (sessionId && source[key] === true) normalized[sessionId] = true;
      }
      const keys = Object.keys(normalized);
      for (let i = 0; i < keys.length - 40; i += 1) delete normalized[keys[i]];
      return normalized;
    }

    function normalizeArtifactReviewPreferences(value) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const normalized = {
        enabled: source.enabled === true,
        collapsed: source.collapsed === true,
        width: Math.max(320, Math.min(560, Math.round(Number(source.width || 420) || 420))),
        // WS3: sticky auto-open dismissal. Must stay in lockstep with the
        // manager-side normalizer (renderer-artifact-review-prefs.js, wired
        // through renderer-artifacts-utils.js) — the two normalizers drifting
        // is the named auto-open desync failure mode. The lockstep now also
        // covers widthBySession (Artifact Panel V2): stripping it here would
        // make the next save silently lose all per-session widths.
        userDismissed: source.userDismissed === true,
      };
      const widthBySession = normalizeArtifactReviewWidthBySession(source.widthBySession);
      if (Object.keys(widthBySession).length > 0) {
        normalized.widthBySession = widthBySession;
      }
      const maximizedBySession = normalizeArtifactReviewMaximizedBySession(source.maximizedBySession);
      if (Object.keys(maximizedBySession).length > 0) normalized.maximizedBySession = maximizedBySession;
      return normalized;
    }

    function loadArtifactReviewPreferences() {
      try {
        const raw = windowRef?.localStorage?.getItem?.(ARTIFACT_REVIEW_STORAGE_KEY) ?? null;
        if (raw === cachedReviewPrefsRaw && cachedReviewPrefs) {
          return cachedReviewPrefs;
        }
        cachedReviewPrefsRaw = raw;
        cachedReviewPrefs = normalizeArtifactReviewPreferences(raw ? JSON.parse(raw) : {});
        return cachedReviewPrefs;
      } catch (_error) {
        cachedReviewPrefsRaw = null;
        cachedReviewPrefs = null;
        return normalizeArtifactReviewPreferences({});
      }
    }

    function getArtifactReviewPreferenceState() {
      const existing = state.ui?.artifactReview && typeof state.ui.artifactReview === 'object'
        ? state.ui.artifactReview
        : {};
      state.ui.artifactReview = normalizeArtifactReviewPreferences({
        ...existing,
        ...loadArtifactReviewPreferences(),
      });
      return state.ui.artifactReview;
    }

    function isArtifactReviewVisible() {
      if (artifactSurfaceController?.isArtifactReviewVisible) {
        return artifactSurfaceController.isArtifactReviewVisible();
      }
      // No width clause (W1-5): stage width only picks split-vs-overlay inside
      // the surface (syncArtifactReviewLayout); gating lazy-init on it would
      // leave narrow windows with no artifact surface at all now that the
      // studio fallback is gone.
      const prefs = getArtifactReviewPreferenceState();
      return state.ui?.activeView === 'chat'
        && prefs.enabled === true
        && prefs.collapsed !== true;
    }

    function getArtifactsForSession(sessionId) {
      const key = String(sessionId || '').trim();
      if (!key) {
        return [];
      }
      const messages = state.messagesBySession.get(key) || [];
      const cached = artifactSessionCache.get(key);
      if (cached && cached.messagesRef === messages) {
        return cached.artifacts;
      }
      const artifacts = buildArtifactsFromMessages(messages, { sessionId: key });
      artifactSessionCache.set(key, { messagesRef: messages, artifacts });
      return artifacts;
    }

    function invalidateSessionArtifacts(sessionId, messages) {
      const key = String(sessionId || '').trim();
      if (!key) {
        return;
      }
      if (Array.isArray(messages)) {
        artifactSessionCache.set(key, {
          messagesRef: messages,
          artifacts: buildArtifactsFromMessages(messages, { sessionId: key }),
        });
      } else {
        artifactSessionCache.delete(key);
      }
      artifactSurfaceController?.invalidateSessionArtifacts?.(key);
    }

    function rekeySessionArtifacts(oldSessionId, newSessionId) {
      const sourceSessionId = String(oldSessionId || '').trim();
      const targetSessionId = String(newSessionId || '').trim();
      if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) {
        return targetSessionId || sourceSessionId;
      }
      artifactSessionCache.delete(sourceSessionId);
      artifactSessionCache.delete(targetSessionId);
      artifactSurfaceController?.rekeySessionArtifacts?.(sourceSessionId, targetSessionId);
      return targetSessionId;
    }

    function pruneSessionArtifacts(validSessionIds) {
      const allowed = new Set(
        (Array.isArray(validSessionIds) ? validSessionIds : [])
          .map((entry) => String(entry || '').trim())
          .filter(Boolean)
      );
      for (const key of [...artifactSessionCache.keys()]) {
        if (!allowed.has(key)) {
          artifactSessionCache.delete(key);
        }
      }
      artifactSurfaceController?.pruneSessionArtifacts?.(validSessionIds);
    }

    function resetArtifactsState() {
      artifactSessionCache.clear();
      if (state.artifacts && typeof state.artifacts === 'object') {
        // WS3 auto-open once-per-session FIFO (never persisted).
        state.artifacts.autoOpenedSessionIds = [];
      }
      if (artifactSurfaceController?.resetArtifactsState) {
        artifactSurfaceController.resetArtifactsState();
        return;
      }
      state.artifacts.filter = 'all';
      state.artifacts.selectedArtifactId = '';
      state.artifacts.selectedSessionId = '';
      state.artifacts.loadedArtifactId = '';
      state.artifacts.loadedArtifactContent = '';
      state.artifacts.dirtyContent = '';
      state.artifacts.lastError = '';
      state.artifacts.loading = false;
      state.artifacts.savePending = false;
      state.artifacts.mermaidViewMode = 'preview';
    }

    // Resolve the static #artifactReviewPanel CONTAINER for the artifact-review
    // surfaces (V2 chrome install + code-review rail bind). The bridge's
    // `artifactReviewPanel` dom dep is undefined in practice: the id lives only
    // in the lazy getArtifactDom resolver, never in the eager dom registry
    // app.js destructures, so it threads through as undefined. That left BOTH
    // consumers broken on the real boot path: ensurePanelV2() early-returned
    // (V2 never installed -> panel stayed legacy regardless of the flag), and
    // the code-review rail's bind() early-returns on !artifactReviewPanel (its
    // click/keydown listeners never attached -> rail dead-on-arrival). Fall back
    // to a direct getElementById of the container. Scoped to these two
    // consumers ONLY (NOT added to the eager registry) because making the eager
    // dep non-null flips unrelated eager consumers' behavior -- it regressed the
    // chat-zoom Ctrl+0 shortcut. getElementById resolves just the container, so
    // it does NOT trigger the lazy child id-query: the V2 install still runs
    // BEFORE getArtifactsDom() resolves the children, and the rail delegates off
    // the stable container (surviving V2's innerHTML swap).
    function resolveArtifactReviewPanelEl() {
      return artifactReviewPanel
        || windowRef?.document?.getElementById?.('artifactReviewPanel')
        || null;
    }

    // Artifact Panel V2 (artifact_panel_v2): when the flag is on and the
    // sibling render module is available, replace #artifactReviewPanel's
    // CHILDREN with V2 markup BEFORE the getArtifactsDom() spread below so the
    // lazy id-query naturally resolves to the V2 nodes. Flag-off (or the
    // module missing) is a strict no-op — the static index.html shell and
    // everything downstream stay byte-identical (test-pinned).
    function ensurePanelV2() {
      const panelEl = resolveArtifactReviewPanelEl();
      if (panelV2Controller || !panelEl || !artifactPanelV2Module?.createArtifactPanelV2) {
        return panelV2Controller;
      }
      const controller = artifactPanelV2Module.createArtifactPanelV2({
        panelEl,
        state,
        windowRef,
        escapeHtml,
        appendClientLog: (...args) => appendClientLog(...args),
        showToastMessage: (...args) => showToastMessage(...args),
      });
      if (controller?.installed?.()) {
        panelV2Controller = controller;
      }
      return panelV2Controller;
    }

    function ensureArtifactSurface() {
      if (artifactSurfaceController) {
        return artifactSurfaceController;
      }
      try {
        ensurePanelV2();
        artifactSurfaceController = artifactsUtils.createArtifactManager?.({
          state,
          dom: {
            workspace,
            sidebar,
            sidebarResizer,
            chatView,
            chatTimeline,
            ...getArtifactsDom(),
          },
          callbacks: {
            escapeHtml,
            getActiveSession: (...args) => getActiveSession(...args),
            getSessionMonogram: (...args) => getSessionMonogram(...args),
            setActiveView: (...args) => setActiveView(...args),
            scrollMessageIntoView: (...args) => scrollMessageIntoView(...args),
            renderAll: (...args) => renderAll(...args),
            updateComposerSafeOffset: (...args) => updateComposerSafeOffset(...args),
            appendClientLog: (...args) => appendClientLog(...args),
            showToastMessage: (...args) => showToastMessage(...args),
            getProjectionContext: (...args) => getProjectionContext(...args),
            getChatTimelineRowModelEnabled: (...args) => getChatTimelineRowModelEnabled(...args),
            recordChatTimelineRolloutSignal: (...args) => recordChatTimelineRolloutSignal(...args),
            rollbackChatTimelineRowModel: (...args) => rollbackChatTimelineRowModel(...args),
            toErrorMessage: (...args) => toErrorMessage(...args),
            renderCodeReviewSurface: (surface) => codeReviewRailController?.renderRailContent?.(surface),
            // Late-bound like the code-review rail: the preview controller is
            // built after the surface (it needs the surface's rail helpers).
            renderFilePreviewSurface: (surface) => filePreviewController?.renderRailContent?.(surface),
            renderTasksSurface: (surface) => taskRailController?.renderRailContent?.(surface),
            resetFilePreview: () => filePreviewController?.reset?.(),
            panelV2: panelV2Controller,
          },
        }) || null;
        if (artifactSurfaceController && !artifactSurfaceBound) {
          artifactSurfaceController.bind?.();
          artifactSurfaceBound = true;
          registerCleanup(() => artifactSurfaceController?.dispose?.());
        }
        ensureCodeReviewRail();
        ensureFilePreviewController();
        ensureTaskRailController();
        if (panelV2Controller) {
          panelV2Controller.bind();
          panelV2Controller.connect({
            selectArtifact: (artifactId) => artifactSurfaceController?.selectArtifact?.(artifactId),
            toggleTextWrap: () => toggleArtifactTextWrap(),
            syncTextWrap: () => applyArtifactTextWrap(),
            setArtifactDocumentViewMode: (surfaceKey, mode) => artifactSurfaceController?.setArtifactDocumentViewMode?.(surfaceKey, mode),
            getArtifactDocumentViewMode: (surfaceKey) => artifactSurfaceController?.getArtifactDocumentViewMode?.(surfaceKey),
            copySelectedArtifact: () => artifactSurfaceController?.copySelectedArtifactSource?.(),
            getSelectedArtifactSource: () => artifactSurfaceController?.getSelectedArtifactSource?.() || '',
            setArtifactViewMode: (kind, mode) => artifactSurfaceController?.setArtifactViewMode?.(kind, mode),
            getArtifactViewMode: (kind) => artifactSurfaceController?.getArtifactViewMode?.(kind),
            getArtifacts: () => {
              const session = getActiveSession();
              return session ? artifactSurfaceController?.getArtifactsForSession?.(session.id) || [] : [];
            },
            toggleMaximize: () => artifactSurfaceController?.toggleArtifactReviewMaximized?.(),
            isMaximized: () => artifactSurfaceController?.isArtifactReviewMaximized?.() === true,
            isSelectedArtifactMarkdownGenerated: () => artifactSurfaceController?.isSelectedArtifactMarkdownGenerated?.() === true,
          });
          registerCleanup(() => panelV2Controller?.dispose?.());
        }
      } catch (error) {
        artifactSurfaceController?.dispose?.();
        artifactSurfaceController = null;
        artifactSurfaceBound = false;
        appendClientLog('ERROR', 'artifacts.surface_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return artifactSurfaceController;
    }

    function ensureCodeReviewRail() {
      if (codeReviewRailController || !artifactSurfaceController) {
        return codeReviewRailController;
      }
      const renderFactory = codeReviewRailDeps.codeReviewRenderFactory;
      const railFactory = codeReviewRailDeps.codeReviewRailFactory;
      const buildLedger = codeReviewRailDeps.buildJennyChangeLedgerFromTurnViewModels;
      const buildSessionModel = codeReviewRailDeps.buildSessionDiffReviewModel;
      const resolveScope = codeReviewRailDeps.resolveReviewScope;
      if (
        typeof renderFactory !== 'function'
        || typeof railFactory !== 'function'
        || typeof buildSessionModel !== 'function'
        || typeof resolveScope !== 'function'
      ) {
        return null;
      }
      try {
        const codeReviewRenderer = renderFactory({
          escapeHtml,
          renderDiffHunks: codeReviewRailDeps.renderDiffHunks,
        });
        codeReviewRailController = railFactory({
          state,
          // Same undefined-eager-dep root cause as ensurePanelV2: pass the
          // getElementById-resolved container so the rail's bind() attaches its
          // click/keydown listeners instead of early-returning on a null dep.
          dom: { artifactReviewPanel: resolveArtifactReviewPanelEl() },
          codeReviewRenderer,
          buildJennyChangeLedgerFromTurnViewModels: typeof buildLedger === 'function' ? buildLedger : null,
          buildSessionDiffReviewModel: buildSessionModel,
          resolveReviewScope: resolveScope,
          getTurnViewModelsForActiveSession: codeReviewRailDeps.getTurnViewModelsForActiveSession || noopArr,
          getActiveSessionId: () => String((typeof getActiveSession === 'function' ? getActiveSession()?.id : '') || ''),
          getWorkspaceId: codeReviewRailDeps.getWorkspaceId || (() => 'default'),
          setArtifactRailMode: (mode) => artifactSurfaceController?.setArtifactRailMode?.(mode),
          renderArtifactReviewPanel: () => artifactSurfaceController?.renderArtifactReviewPanel?.(),
          syncArtifactReviewLayout: () => artifactSurfaceController?.syncArtifactReviewLayout?.(),
          jumpToArtifactSource: (...args) => artifactSurfaceController?.jumpToArtifactSource?.(...args),
          appendClientLog: (...args) => appendClientLog(...args),
          showComposerActionError: codeReviewRailDeps.showComposerActionError || noop,
        });
        if (codeReviewRailController && !codeReviewRailBound) {
          codeReviewRailController.bind?.();
          codeReviewRailBound = true;
          registerCleanup(() => codeReviewRailController?.dispose?.());
        }
      } catch (error) {
        codeReviewRailController = null;
        codeReviewRailBound = false;
        appendClientLog('ERROR', 'code_review.surface_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return codeReviewRailController;
    }

    // Text-wrap toggle (owner request 2026-08-20): one control for every
    // text-like artifact body. Renderer-local on state.ui.artifactReview
    // (never persisted — the prefs saver whitelists its keys). Default is
    // wrapped, matching the tool-output viewer and the editor's wordWrap:'on'.
    // Non-editor bodies flip through the panel-level class; Monaco flips
    // through its own setWordWrap API (a CSS class cannot reach it).
    function applyArtifactTextWrap() {
      const review = state?.ui?.artifactReview;
      const wrap = !review || review.textWrap !== false;
      resolveArtifactReviewPanelEl()?.classList.toggle('artifact-panel-nowrap', !wrap);
      artifactSurfaceController?.getExistingEditor?.('split')?.setWordWrap?.(wrap);
      return wrap;
    }

    function toggleArtifactTextWrap() {
      const review = state?.ui?.artifactReview;
      if (review && typeof review === 'object') {
        review.textWrap = review.textWrap === false;
      }
      return applyArtifactTextWrap();
    }

    // Read-only chat-rail file preview (file_preview rail mode). Same lazy
    // shape as ensureCodeReviewRail: built once, after the surface controller
    // exists, bound to the stable #artifactReviewPanel container, and torn
    // down through registerCleanup. A construction failure is logged and
    // degrades to "no preview owner", which makes openFilePreviewTarget
    // resolve false so the chat click falls back to the IDE ladder.
    function ensureFilePreviewController() {
      if (filePreviewController || !artifactSurfaceController) {
        return filePreviewController;
      }
      if (typeof artifactFilePreviewModule?.createArtifactFilePreview !== 'function') {
        return null;
      }
      try {
        filePreviewController = artifactFilePreviewModule.createArtifactFilePreview({
          state,
          windowRef,
          dom: { artifactReviewPanel: resolveArtifactReviewPanelEl() },
          escapeHtml,
          getWorkspaceFsApi: () => (windowRef?.jennyShell?.workspaceFs) || null,
          markdownUtils: windowRef?.markdownUtils || globalRef.markdownUtils || null,
          codeHighlight: windowRef?.rendererCodeHighlight || globalRef.rendererCodeHighlight || null,
          frameUtils: windowRef?.rendererHtmlArtifactFrameUtils || globalRef.rendererHtmlArtifactFrameUtils || null,
          openArtifactRail: (mode) => artifactSurfaceController?.openArtifactRail?.(mode),
          renderArtifactReviewPanel: () => artifactSurfaceController?.renderArtifactReviewPanel?.(),
          syncArtifactReviewLayout: () => artifactSurfaceController?.syncArtifactReviewLayout?.(),
          appendClientLog: (...args) => appendClientLog(...args),
        });
        if (filePreviewController && !filePreviewBound) {
          filePreviewController.bind?.();
          filePreviewBound = true;
          registerCleanup(() => filePreviewController?.dispose?.());
          // A committed workspace-root switch invalidates the preview: its
          // bytes belong to the OLD root while its path now resolves in the
          // new one. Event dispatched by refreshWorkspaceRootDependents.
          const onRootCommitted = () => filePreviewController?.handleWorkspaceRootCommitted?.();
          if (typeof windowRef?.addEventListener === 'function') {
            windowRef.addEventListener('workspace:root-committed', onRootCommitted);
            registerCleanup(() => windowRef.removeEventListener('workspace:root-committed', onRootCommitted));
          }
        }
      } catch (error) {
        filePreviewController = null;
        filePreviewBound = false;
        appendClientLog('ERROR', 'artifact_file_preview.surface_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return filePreviewController;
    }

    function ensureTaskRailController() {
      if (taskRailController) {
        taskRailController.bind?.();
        return taskRailController;
      }
      if (typeof taskRailModule?.createTaskRail !== 'function') return null;
      try {
        const documentRef = windowRef?.document;
        const chatInput = documentRef?.getElementById?.('chatInput') || null;
        taskRailController = taskRailModule.createTaskRail({
          state,
          windowRef,
          dom: {
            artifactReviewPanel: resolveArtifactReviewPanelEl(),
            utilityCluster: documentRef?.getElementById?.('chatTimelineUtilityCluster') || null,
            chatInput,
          },
          escapeHtml,
          openArtifactRail: (mode) => ensureArtifactSurface()?.openArtifactRail?.(mode),
          renderArtifactReviewPanel: () => ensureArtifactSurface()?.renderArtifactReviewPanel?.(),
          toggleArtifactReview: () => ensureArtifactSurface()?.toggleArtifactReview?.(),
          activateWorkspaceSession: (sessionId) => callbacks.activateWorkspaceSession?.(sessionId),
          setActiveView: (...args) => setActiveView(...args),
          // The composer's own input listener resizes the textarea.
          syncComposerInputHeight: () => chatInput?.dispatchEvent?.(new windowRef.Event('input', { bubbles: true })),
          renderAll: (...args) => renderAll(...args),
          appendClientLog: (...args) => appendClientLog(...args),
          showToastMessage: (...args) => showToastMessage(...args),
        });
        taskRailController?.bind?.();
        registerCleanup(() => taskRailController?.dispose?.());
      } catch (error) {
        taskRailController = null;
        appendClientLog('ERROR', 'task_rail.surface_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return taskRailController;
    }

    async function openFilePreviewTarget(payload) {
      ensureArtifactSurface();
      const controller = ensureFilePreviewController();
      if (!controller) {
        return false;
      }
      return (await controller.openFilePreviewTarget(payload)) === true;
    }

    function openCodeReviewTarget(payload) {
      ensureArtifactSurface();
      const rail = ensureCodeReviewRail();
      if (!rail) {
        return false;
      }
      return rail.openCodeReviewTarget(payload);
    }

    function openArtifactTarget() {
      return ensureArtifactSurface()?.openArtifactTarget?.(...arguments);
    }

    // Artifact Panel V2 (artifact_panel_v2): the surface controller is built
    // exactly once, and that build is the ONLY moment ensurePanelV2() runs and
    // reads artifact_panel_v2 to decide V2-vs-legacy chrome. The renderer boot
    // seed omits that flag, so it is absent (undefined) until the async feature
    // payload lands partway through boot. A user with the review panel enabled
    // from a prior session makes the panel "visible" at the FIRST bootstrap
    // renderAll(), which runs before hydration -- building the surface then
    // bakes in the legacy chrome for the whole session (the cached controller
    // never rebuilds). Defer the FIRST passive/auto build until the flag value
    // is actually known; renderAll re-fires after hydration, so this only
    // delays the first panel paint. Explicit user actions (open/select) are
    // inherently post-hydration and are not gated.
    //
    // The signal is the PRESENCE of the artifact_panel_v2 key, not `loaded`:
    // features.loaded is flipped true by multiple partial-payload paths (e.g.
    // normalizeFeatureState with the seed) before the real flags arrive, so it
    // reads hydrated while the flag is still unknown. The key is present iff a
    // real feature payload has been merged (buildEffectiveFeatureFlags always
    // emits it, default-ON or env-rolled-back), which is exactly when the flag
    // value can be trusted -- and it stays correct for rollback (key present +
    // false -> build proceeds and installs the legacy chrome).
    function artifactPanelFlagResolved() {
      const flags = state?.features?.featureFlags;
      return Boolean(flags) && Object.prototype.hasOwnProperty.call(flags, 'artifact_panel_v2');
    }

    // WS3: cheap pre-check for whether the auto-open hook could fire this
    // render. Without it, a dormant panel (prefs.enabled=false, controller
    // never built) short-circuits below and the per-render auto-open hook in
    // renderArtifactReviewPanel never runs for exactly the users auto-open
    // targets. Checks are ordered cheapest-first; the artifact projection is
    // cached per messages-array reference.
    function shouldConsiderArtifactAutoOpen() {
      if (state.ui?.activeView !== 'chat') {
        return false;
      }
      const sessionId = String((typeof getActiveSession === 'function' ? getActiveSession()?.id : '') || '').trim();
      if (!sessionId) {
        return false;
      }
      const openedIds = state.artifacts?.autoOpenedSessionIds;
      if (Array.isArray(openedIds) && openedIds.includes(sessionId)) {
        return false;
      }
      if (getArtifactReviewPreferenceState().userDismissed === true) {
        return false;
      }
      // No width clause (W1-5): narrow stages auto-open into the overlay
      // drawer instead of being skipped (the studio fallback is gone).
      return getArtifactsForSession(sessionId).length > 0;
    }

    function renderArtifactReviewPanelSafe() {
      ensureTaskRailController();
      if (!artifactSurfaceController) {
        if (!artifactPanelFlagResolved()) {
          return null;
        }
        if (!isArtifactReviewVisible() && !shouldConsiderArtifactAutoOpen()) {
          return null;
        }
      }
      return ensureArtifactSurface()?.renderArtifactReviewPanel?.(...arguments);
    }

    function syncArtifactReviewLayout() {
      if (!artifactSurfaceController) {
        if (!artifactPanelFlagResolved()) {
          return null;
        }
        if (!isArtifactReviewVisible()) {
          return null;
        }
      }
      return ensureArtifactSurface()?.syncArtifactReviewLayout?.(...arguments);
    }

    function selectArtifact() {
      return ensureArtifactSurface()?.selectArtifact?.(...arguments);
    }

    // Always-functional split-view toggle (owner report 2026-07-05): the
    // surface controller's bind() owns the toggle's click listener, but every
    // passive builder above defers until the panel is already visible or
    // auto-open eligible — so in any state where the panel never showed, the
    // surface never built and #artifactSplitViewToggle was a dead button.
    // This boot-time priming listener handles ONLY the never-built case: it
    // builds the surface on demand and forwards the click once. The surface's
    // own listener attaches during this same dispatch and (per DOM dispatch
    // semantics) does not receive the in-flight event, so the click is handled
    // exactly once; every later click no-ops here and is owned by the surface.
    (function bindSplitViewTogglePrimer() {
      const toggleEl = windowRef?.document?.getElementById?.('artifactSplitViewToggle');
      if (!toggleEl?.addEventListener) {
        return;
      }
      const primeFromToggle = () => {
        if (artifactSurfaceController) {
          return;
        }
        ensureArtifactSurface()?.toggleArtifactReview?.();
      };
      toggleEl.addEventListener('click', primeFromToggle);
      registerCleanup(() => toggleEl.removeEventListener('click', primeFromToggle));
    })();

    return {
      getArtifactReviewPreferenceState,
      isArtifactReviewVisible,
      getArtifactsForSession,
      invalidateSessionArtifacts,
      rekeySessionArtifacts,
      pruneSessionArtifacts,
      resetArtifactsState,
      ensureArtifactSurface,
      openArtifactTarget,
      openCodeReviewTarget,
      openFilePreviewTarget,
      renderArtifactReviewPanelSafe,
      syncArtifactReviewLayout,
      selectArtifact,
    };
  }

  return {
    createShellArtifactBridge,
  };
});
