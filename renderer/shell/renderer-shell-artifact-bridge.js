(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'), (function loadPanelV2() {
      try { return require('../features/renderer-artifact-panel-v2-render'); } catch (_error) { return null; }
    })(), (function loadFilePreview() {
      try { return require('../features/renderer-artifact-file-preview'); } catch (_error) { return null; }
    })(), (function loadTaskRail() {
      try { return require('../features/renderer-task-rail'); } catch (_error) { return null; }
    })(), (function loadSubagentRail() {
      try { return require('../features/renderer-subagent-rail'); } catch (_error) { return null; }
    })());
    return;
  }
  root.rendererShellArtifactBridgeUtils = factory(
    root.inventoryActionButton,
    root.rendererArtifactPanelV2 || null,
    root.rendererArtifactFilePreview || null,
    root.rendererTaskRail || null,
    root.rendererSubagentRail || null
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventoryActionButton, artifactPanelV2Module, artifactFilePreviewModule, taskRailModule, subagentRailModule) {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const jt = (globalRef.jennyI18n && globalRef.jennyI18n.t) || globalRef.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
      sidePanelOwner = globalRef.rendererSidePanelOwner || null,
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
      escapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml,
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

    // The prefs module owns the key; a test may pass its own.
    const artifactReviewPrefs = globalRef.rendererArtifactReviewPrefs
      || (typeof require === 'function' ? require('../features/renderer-artifact-review-prefs') : null);
    const ARTIFACT_REVIEW_STORAGE_KEY =
      String(constants.ARTIFACT_REVIEW_STORAGE_KEY || artifactReviewPrefs?.ARTIFACT_REVIEW_STORAGE_KEY || '');

    let artifactSurfaceController = null;
    let artifactSurfaceBound = false;
    // The manager is built lazily (often when a chat's first artifact
    // arrives), so the run's start is recorded here, at boot: auto-open
    // presents only artifacts produced since (owner decision 2026-09-29).
    const runStartedAt = Date.now();
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
    let subagentRailController = null;
    // Project Notes (renderer-project-notes-entry.js is always loaded; the rail loads lazily).
    let projectNotesRailController = null;
    let projectNotesEntry = null;
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
      const textWrap = source.textWrap && typeof source.textWrap === 'object' ? source.textWrap : {};
      const normalized = {
        // One closed state: a retired `collapsed: true` reads as closed.
        enabled: source.enabled === true && source.collapsed !== true,
        width: Math.max(320, Math.min(560, Math.round(Number(source.width || 420) || 420))),
        // Must stay in lockstep with the manager-side normalizer
        // (renderer-artifact-review-prefs.js, wired through
        // renderer-artifacts-utils.js): the two drifting is the named auto-open
        // desync failure mode. The lockstep covers widthBySession (Artifact
        // Panel V2), the per-chat dismissal (shell chrome area 3, D1) and the
        // per-kind wrap: stripping any here would make the next save lose it.
        // The retired global `userDismissed` is ignored, never carried.
        textWrap: { output: source.textWrap === false ? false : textWrap.output !== false, code: source.textWrap === false ? false : textWrap.code !== false },
      };
      const widthBySession = normalizeArtifactReviewWidthBySession(source.widthBySession);
      if (Object.keys(widthBySession).length > 0) {
        normalized.widthBySession = widthBySession;
      }
      const dismissedForSession = normalizeArtifactReviewMaximizedBySession(source.dismissedForSession);
      if (Object.keys(dismissedForSession).length > 0) normalized.dismissedForSession = dismissedForSession;
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
        && prefs.enabled === true;
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

    // Split view W3-2 (spec W3_SPEC_2026-09-26 §3): the one
    // side panel (artifact review, or the context panel sharing its column)
    // shows the session renderer-side-panel-owner.js resolves: with two panes
    // the chat that opened it, whichever pane has focus. With one pane every
    // answer here is exactly the pre-split one (the focused session), and the
    // owner line is never inserted.
    function isSplitLayout() {
      return Boolean(sidePanelOwner) && (Array.isArray(state.panes?.panes) ? state.panes.panes.length : 0) > 1;
    }
    function findSession(sessionId) {
      return (Array.isArray(state.sessions) ? state.sessions : []).find((session) => session?.id === sessionId) || null;
    }
    function getPanelSession() {
      return isSplitLayout() ? findSession(sidePanelOwner.resolvePanelSessionId(state)) : getActiveSession();
    }
    // The owner line names the chat the way its pane kicker does (the summary
    // title, else "New session"). Rebuilt only when the owner, its title or
    // the line's presence changes; `mode` is the artifact rail mode, or
    // 'context' for the context panel. Code review and file preview are
    // workspace-level, so they carry no line.
    const ownerLineKeys = new WeakMap();
    function syncOwnerLine(panelEl, mode) {
      if (!panelEl || typeof panelEl.querySelector !== 'function') return;
      // The Subagent Monitor's record ends with its mode, its panel or its session (renderer-subagent-rail.js).
      if (mode !== 'context') subagentRailController?.handleLayoutSync?.(mode, !panelEl.classList?.contains('hidden'));
      const sessionId = isSplitLayout() && (mode === 'artifact' || mode === 'context' || mode === 'subagents')
        ? sidePanelOwner.resolvePanelSessionId(state)
        : '';
      const title = sessionId
        ? String(findSession(sessionId)?.title || '').trim() || jt('chat.empty.newSession', 'New session')
        : '';
      const key = sessionId ? `${sessionId}\n${title}` : '';
      const previous = ownerLineKeys.get(panelEl) || '';
      if (!key && !previous) return; // nothing inserted, nothing to read (one pane lands here)
      let line = panelEl.querySelector(':scope > .side-panel-owner-line');
      if (key === previous && line) return;
      ownerLineKeys.set(panelEl, key);
      if (!key) {
        line?.remove();
        return;
      }
      const documentRef = panelEl.ownerDocument;
      if (!line) {
        line = documentRef.createElement('p');
        line.className = 'side-panel-owner-line';
        panelEl.prepend(line);
      }
      // The localized template is split around {title} so the title alone
      // sits in the ellipsizing span, wherever a language places it.
      const [before = '', after = ''] = String(jt('artifacts.panel.fromChat', 'From {title}')).split('{title}');
      const titleEl = documentRef.createElement('span');
      titleEl.className = 'side-panel-owner-title';
      titleEl.setAttribute('dir', 'auto'); // an English title keeps LTR inside RTL chrome
      titleEl.textContent = title;
      titleEl.title = title;
      line.replaceChildren(...[before.trim(), titleEl, after.trim()].filter(Boolean));
    }
    // An explicit open presents the panel for its chat, so auto-open must not
    // present it again on the next render and swap the artifact just chosen
    // for the newest (a second pane's chat was never auto-presented: the hook
    // only runs for the chat the panel shows). Same FIFO as the auto-open.
    function markPresented(sessionId) {
      const id = String(sessionId || '').trim();
      const presented = state.artifacts?.autoOpenedSessionIds;
      if (!id || !Array.isArray(presented) || presented.includes(id)) return;
      state.artifacts.autoOpenedSessionIds = presented.concat(id).slice(-50);
    }
    const sidePanel = {
      getSessionId: () => (isSplitLayout() ? sidePanelOwner.resolvePanelSessionId(state) : state.currentSessionId),
      // No argument: an explicit open from the focused pane (a pointerdown or
      // focusin in a pane focuses it before its click runs). With one: the
      // session an auto-open presented. A no-op with one pane.
      claim: (sessionId) => {
        if (!isSplitLayout()) return false;
        if (sessionId !== undefined) return sidePanelOwner.claimPanelOwner(state, sessionId);
        markPresented(state.currentSessionId);
        return sidePanelOwner.claimPanelOwner(state, state.currentSessionId);
      },
      getAutoOpenSessionId: (panelVisible) => (isSplitLayout()
        ? sidePanelOwner.resolveAutoOpenSessionId(state, panelVisible)
        : String((typeof getActiveSession === 'function' ? getActiveSession()?.id : '') || '').trim()),
      syncOwnerLine,
      // "Jump to chat" (artifact and code review) scrolls the pane showing the
      // panel's chat; null = pane 0's own timeline (always with one pane).
      getJumpTarget: () => (isSplitLayout()
        ? (windowRef?.rendererAppPaneComposition || globalRef.rendererAppPaneComposition)?.getPaneComposition?.()
          ?.getSessionPaneTarget?.(sidePanelOwner.resolvePanelSessionId(state)) || null
        : null),
    };

    // The owning pane closed (the layout reconcile's 'collapse'): collapse a
    // showing panel WITHOUT the sticky dismissal, so auto-open still works.
    function collapseSidePanel() {
      if (!artifactSurfaceController?.collapseArtifactReview || !isArtifactReviewVisible()) return false;
      artifactSurfaceController.collapseArtifactReview();
      return true;
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

    // Artifact panel chrome: when the sibling render module is available,
    // replace #artifactReviewPanel's CHILDREN with the Canvas chrome BEFORE
    // the getArtifactsDom() spread below so the lazy id-query naturally
    // resolves to the new nodes. A missing module is a strict no-op — the
    // static index.html shell and everything downstream stay byte-identical.
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
            getActiveSession: () => getPanelSession(),
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
            renderSubagentsSurface: (surface) => subagentRailController?.renderSubagentsSurface?.(surface) === true,
            renderNotesSurface: (surface) => ensureProjectNotesRail()?.renderRailContent?.(surface) === true,
            resetFilePreview: () => filePreviewController?.reset?.(),
            panelV2: panelV2Controller,
            sidePanel,
            getRunStartedAt: () => runStartedAt,
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
        ensureProjectNotesEntry();
        ensureSubagentRail();
        if (panelV2Controller) {
          panelV2Controller.bind();
          panelV2Controller.connect({
            selectArtifact: (artifactId) => artifactSurfaceController?.selectArtifact?.(artifactId),
            setArtifactDocumentViewMode: (surfaceKey, mode) => artifactSurfaceController?.setArtifactDocumentViewMode?.(surfaceKey, mode),
            getArtifactDocumentViewMode: (surfaceKey) => artifactSurfaceController?.getArtifactDocumentViewMode?.(surfaceKey),
            copySelectedArtifact: () => artifactSurfaceController?.copySelectedArtifactSource?.(),
            getSelectedArtifactSource: () => artifactSurfaceController?.getSelectedArtifactSource?.() ?? null,
            setArtifactViewMode: (kind, mode) => artifactSurfaceController?.setArtifactViewMode?.(kind, mode),
            getArtifactViewMode: (kind) => artifactSurfaceController?.getArtifactViewMode?.(kind),
            getArtifacts: () => {
              const session = getPanelSession();
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

    // One Changes undo controller for both hosts (row 34 S5): the IDE chat
    // dock and the side panel. Created once its lazily loaded script is ready.
    let changesUndoController = null;
    function getChangesUndoController() {
      const factory = globalRef.rendererChangesUndo?.createChangesUndo;
      if (changesUndoController || typeof factory !== 'function') return changesUndoController;
      const renderDiffHunks = codeReviewRailDeps.renderDiffHunks;
      changesUndoController = factory({
        getSessionId: () => String(state.currentSessionId || ''),
        showToast: (...args) => showToastMessage(...args),
        requestRender: () => renderAll(),
        renderDiffBody: typeof renderDiffHunks === 'function'
          ? (change) => renderDiffHunks(change.hunks, escapeHtml, { path: change.path })
          : null,
        escapeHtml,
        appendClientLog: (...args) => appendClientLog(...args),
      });
      registerCleanup(() => changesUndoController?.dispose?.());
      return changesUndoController;
    }

    function ensureCodeReviewRail() {
      if (codeReviewRailController || !artifactSurfaceController) {
        return codeReviewRailController;
      }
      const railFactory = codeReviewRailDeps.codeReviewRailFactory;
      const buildLedger = codeReviewRailDeps.buildJennyChangeLedgerFromTurnViewModels;
      const renderDiffHunks = codeReviewRailDeps.renderDiffHunks;
      if (typeof railFactory !== 'function') {
        return null;
      }
      // In split view the review belongs to the chat that owns the side panel.
      const getSessionId = () => String(sidePanel.getSessionId() || '');
      try {
        codeReviewRailController = railFactory({
          state,
          // Same undefined-eager-dep root cause as ensurePanelV2: pass the
          // getElementById-resolved container so the rail's bind() attaches its
          // keydown listener instead of early-returning on a null dep.
          dom: { artifactReviewPanel: resolveArtifactReviewPanelEl() },
          loadChangesView: codeReviewRailDeps.loadChangesView,
          buildJennyChangeLedgerFromTurnViewModels: typeof buildLedger === 'function' ? buildLedger : null,
          renderDiffBody: typeof renderDiffHunks === 'function'
            ? (change) => (change && Array.isArray(change.hunks) && change.hunks.length
              ? renderDiffHunks(change.hunks, escapeHtml, { path: change.path })
              : '')
            : null,
          getTurnViewModelsForActiveSession: () => codeReviewRailDeps.getTurnViewModelsForActiveSession?.(getSessionId()) || [],
          getActiveSessionId: getSessionId,
          getWorkspaceId: codeReviewRailDeps.getWorkspaceId || (() => 'default'),
          getSessionMessages: () => codeReviewRailDeps.getSessionMessages?.(getSessionId()) || [],
          openInWorkspace: codeReviewRailDeps.openChangeInWorkspace || null,
          getUndoController: getChangesUndoController,
          setArtifactRailMode: (mode) => artifactSurfaceController?.setArtifactRailMode?.(mode),
          renderArtifactReviewPanel: () => artifactSurfaceController?.renderArtifactReviewPanel?.(),
          syncArtifactReviewLayout: () => artifactSurfaceController?.syncArtifactReviewLayout?.(),
          appendClientLog: (...args) => appendClientLog(...args),
          showComposerActionError: codeReviewRailDeps.showComposerActionError || noop,
          escapeHtml,
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
          // The rail's project scope menu reuses the shared (lazy) project switcher.
          getProjectSwitcher: () => callbacks.getProjectSwitcher?.(),
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

    // The Subagent Monitor rail (renderer-subagent-rail.js): late-bound like the
    // task rail, published on windowRef.rendererSubagentRailHost for the pane
    // monitor controllers, which never see the surface controller directly.
    function ensureSubagentRail() {
      if (subagentRailController) return subagentRailController;
      if (typeof subagentRailModule?.createSubagentRail !== 'function') return null;
      try {
        subagentRailController = subagentRailModule.createSubagentRail({
          state,
          windowRef,
          dom: { artifactReviewPanel: resolveArtifactReviewPanelEl() },
          openArtifactRail: (mode) => ensureArtifactSurface()?.openArtifactRail?.(mode),
          renderArtifactReviewPanel: () => artifactSurfaceController?.renderArtifactReviewPanel?.(),
          restoreArtifactReviewPrefs: (patch) => artifactSurfaceController?.restoreArtifactReviewPrefs?.(patch),
          // Building the surface loads the persisted prefs the snapshot reads.
          getPrefs: () => { ensureArtifactSurface(); return state.ui?.artifactReview || {}; },
          getPanelSessionId: () => sidePanel.getSessionId(),
        });
        subagentRailController?.bind?.();
        registerCleanup(() => subagentRailController?.dispose?.());
      } catch (error) {
        subagentRailController = null;
        appendClientLog('ERROR', 'subagent_rail.surface_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return subagentRailController;
    }

    // The always-loaded Notes entry (toggle, chat rows). Built once the module is
    // present; an absent module stays null and the next ensure retries.
    function ensureProjectNotesEntry() {
      if (projectNotesEntry) return projectNotesEntry;
      if (typeof windowRef?.rendererProjectNotesEntry?.createProjectNotesEntry !== 'function') return null;
      try {
        const documentRef = windowRef?.document;
        projectNotesEntry = windowRef.rendererProjectNotesEntry.createProjectNotesEntry({
          state,
          windowRef,
          escapeHtml,
          dom: {
            utilityCluster: documentRef?.getElementById?.('chatTimelineUtilityCluster') || null,
            artifactReviewPanel: resolveArtifactReviewPanelEl(),
          },
          appendClientLog: (...args) => appendClientLog(...args),
          showToastMessage: (...args) => showToastMessage(...args),
          // The rail loads lazily: asking for the host builds it once its modules are present.
          getHost: () => { ensureProjectNotesRail(); return windowRef.rendererProjectNotesHost || null; },
        }) || null;
        projectNotesEntry?.bind?.();
        const built = projectNotesEntry;
        registerCleanup(() => built?.dispose?.());
      } catch (error) {
        projectNotesEntry = null;
        appendClientLog('ERROR', 'project_notes.entry_init_failed', { message: error?.message || String(error) });
        return null;
      }
      return projectNotesEntry;
    }

    // The Project Notes rail (renderer-project-notes-rail.js): resolved at CALL
    // time because the modules load on first open. Publishes the host the entry drives.
    function ensureProjectNotesRail() {
      if (projectNotesRailController) return projectNotesRailController;
      if (typeof windowRef?.rendererProjectNotesRail?.createProjectNotesRail !== 'function') return null;
      try {
        const controller = windowRef.rendererProjectNotesRail.createProjectNotesRail({
          state,
          windowRef,
          dom: { artifactReviewPanel: resolveArtifactReviewPanelEl() },
          escapeHtml,
          openArtifactRail: (mode) => ensureArtifactSurface()?.openArtifactRail?.(mode),
          renderArtifactReviewPanel: () => ensureArtifactSurface()?.renderArtifactReviewPanel?.(),
          toggleArtifactReview: () => ensureArtifactSurface()?.toggleArtifactReview?.(),
          getProjectSwitcher: () => callbacks.getProjectSwitcher?.(),
          getEntry: () => projectNotesEntry,
          appendClientLog: (...args) => appendClientLog(...args),
          showToastMessage: (...args) => showToastMessage(...args),
        });
        controller.bind?.();
        const host = {
          open: () => controller.open() === true,
          toggle: () => { controller.toggle(); return true; },
          isOpen: () => controller.isOpen() === true,
          refresh: () => controller.refresh(),
          markSeen: (...args) => projectNotesEntry?.markSeen?.(...args),
        };
        windowRef.rendererProjectNotesHost = host;
        registerCleanup(() => {
          controller.dispose?.();
          if (windowRef.rendererProjectNotesHost === host) delete windowRef.rendererProjectNotesHost;
        });
        projectNotesRailController = controller;
      } catch (error) {
        projectNotesRailController = null;
        appendClientLog('ERROR', 'project_notes.rail_init_failed', { message: error?.message || String(error) });
        return null;
      }
      return projectNotesRailController;
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
      if (codeReviewRailDeps.revealInDock?.(payload) === true) return true;
      sidePanel.claim();
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

    function jumpToArtifactSource(...args) {
      return ensureArtifactSurface()?.jumpToArtifactSource?.(...args);
    }

    // WS3: cheap pre-check for whether the auto-open hook could fire this
    // render. Without it, a dormant panel (prefs.enabled=false, controller
    // never built) short-circuits below and the per-render auto-open hook in
    // renderArtifactReviewPanel never runs for exactly the users auto-open
    // targets. Checks are ordered cheapest-first; the artifact projection is
    // cached per messages-array reference.
    function shouldConsiderArtifactAutoOpen() {
      if (state.ui?.appearance?.artifactAutoOpen !== true) return false;
      if (state.ui?.activeView !== 'chat') {
        return false;
      }
      // The panel is hidden here (a showing panel has built its controller).
      const sessionId = sidePanel.getAutoOpenSessionId(false);
      if (!sessionId) {
        return false;
      }
      const openedIds = state.artifacts?.autoOpenedSessionIds;
      if (Array.isArray(openedIds) && openedIds.includes(sessionId)) {
        return false;
      }
      // D1: a Close in this chat, never a global dismissal.
      if (getArtifactReviewPreferenceState().dismissedForSession?.[sessionId] === true) {
        return false;
      }
      // No width clause (W1-5): narrow stages auto-open into the overlay
      // drawer instead of being skipped (the studio fallback is gone).
      return getArtifactsForSession(sessionId).length > 0;
    }

    function renderArtifactReviewPanelSafe() {
      ensureTaskRailController();
      ensureProjectNotesEntry()?.checkSession?.(); // a chat switch re-aims the Notes accent dot
      ensureSubagentRail();
      if (!artifactSurfaceController) {
        if (!isArtifactReviewVisible() && !shouldConsiderArtifactAutoOpen()) {
          return null;
        }
      }
      return ensureArtifactSurface()?.renderArtifactReviewPanel?.(...arguments);
    }

    function syncArtifactReviewLayout() {
      if (!artifactSurfaceController) {
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

    // A monitor Open can arrive before anything built the artifact surface; the
    // pane controllers call this to build the rail instead of falling back to
    // the in-stage aside.
    if (windowRef && typeof windowRef === 'object') {
      const ensureRailHook = () => ensureSubagentRail();
      windowRef.rendererEnsureSubagentRail = ensureRailHook;
      registerCleanup(() => {
        if (windowRef.rendererEnsureSubagentRail === ensureRailHook) delete windowRef.rendererEnsureSubagentRail;
      });
    }

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
      jumpToArtifactSource,
      openCodeReviewTarget,
      openFilePreviewTarget,
      renderArtifactReviewPanelSafe,
      syncArtifactReviewLayout,
      selectArtifact,
      sidePanel,
      collapseSidePanel,
      getChangesUndoController,
    };
  }

  return {
    createShellArtifactBridge,
  };
});
