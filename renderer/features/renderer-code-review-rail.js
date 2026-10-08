/* renderer/features/renderer-code-review-rail.js
 * Side panel host for the Changes view (row 34 S5; spec §3.2 "Chat view").
 *
 * Owns the side panel's `code_review` mode: the transcript's "Review changes"
 * affordance calls openCodeReviewTarget({ scope, turnId, changeId, fileKey }),
 * which switches the shared artifact rail to code_review and reveals that
 * turn (and file) in the Changes view. The artifact manager calls
 * renderRailContent(surface) whenever the rail renders in this mode.
 *
 * The Changes view modules load lazily on first open (CHANGES_VIEW_SCRIPTS;
 * the Workspace loads the same files through the IDE script manifest), so the
 * chat startup script budget does not grow. The view itself is the same
 * component the IDE chat dock mounts; only `host: 'panel'` differs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererCodeReviewRail = factory(root.stringUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const normalizeId = typeof stringUtils.normalizeId === 'function'
    ? stringUtils.normalizeId
    : function fallbackNormalizeId(value) { return String(value || '').trim(); };

  // Ordered [src, global] pairs; renderer-ide-script-manifest.js lists the same files.
  const CHANGES_VIEW_SCRIPTS = Object.freeze([
    Object.freeze(['renderer/features/renderer-suggested-changes-model.js', 'rendererSuggestedChangesModel']),
    Object.freeze(['renderer/features/renderer-suggested-changes-client.js', 'rendererSuggestedChangesClient']),
    Object.freeze(['renderer/features/renderer-suggestion-bar-render.js', 'rendererSuggestionBarRender']),
    Object.freeze(['renderer/features/renderer-suggestion-bar-controller.js', 'rendererSuggestionBarController']),
    Object.freeze(['renderer/features/renderer-changes-history-model.js', 'rendererChangesHistoryModel']),
    Object.freeze(['renderer/features/renderer-changes-view-render.js', 'rendererChangesViewRender']),
    Object.freeze(['renderer/features/renderer-changes-suggested-actions.js', 'rendererChangesSuggestedActions']),
    Object.freeze(['renderer/features/renderer-changes-view.js', 'rendererChangesView']),
    Object.freeze(['renderer/features/renderer-changes-undo-plan.js', 'rendererChangesUndoPlan']),
    Object.freeze(['renderer/features/renderer-changes-undo-sheet.js', 'rendererChangesUndoSheet']),
    Object.freeze(['renderer/features/renderer-changes-undo.js', 'rendererChangesUndo']),
  ]);

  const SCOPES = new Set(['change', 'turn', 'file', 'session', 'suggested']);

  /**
   * Loads the Changes view modules in order. Resolves to the view module, or
   * null when a script failed (the caller shows an error instead of a blank panel).
   */
  async function loadChangesViewModules({ ensureScript, windowRef, log } = {}) {
    const globalRef = windowRef || globalThis;
    for (const [src, globalName] of CHANGES_VIEW_SCRIPTS) {
      const isReady = () => Boolean(globalRef[globalName]);
      if (isReady()) continue;
      const ok = typeof ensureScript === 'function' ? await ensureScript({ src, isReady, log }) : false;
      if (!ok) return null;
    }
    return globalRef.rendererChangesView || null;
  }

  function createCodeReviewRail(deps) {
    const {
      state,
      dom = {},
      loadChangesView = async function noLoader() { return null; },
      buildJennyChangeLedgerFromTurnViewModels = null,
      renderDiffBody = null,
      getTurnViewModelsForActiveSession = function noopGetTurnViewModels() { return []; },
      getActiveSessionId = function noopGetActiveSessionId() { return ''; },
      getWorkspaceId = function noopGetWorkspaceId() { return 'default'; },
      getSessionMessages = null,
      openInWorkspace = null,
      getUndoController = function noUndo() { return null; },
      setArtifactRailMode = function noopSetArtifactRailMode() {},
      renderArtifactReviewPanel = function noopRenderArtifactReviewPanel() {},
      syncArtifactReviewLayout = function noopSyncArtifactReviewLayout() {},
      appendClientLog = function noopAppendClientLog() {},
      showComposerActionError = function noopShowComposerActionError() {},
      escapeHtml,
    } = deps || {};

    if (!state) {
      throw new Error('renderer-code-review-rail: state dep is required');
    }

    const { artifactReviewPanel } = dom;
    let bound = false;
    let disposed = false;
    let view = null;
    let viewLoad = null;
    let hostEl = null;
    let pendingReveal = null;
    // Closure-scope so the opener cannot leak into serializable UI state.
    let previousFocusEl = null;

    function setMode(modeFlag) {
      try {
        setArtifactRailMode(modeFlag);
      } catch (_error) {
        /* artifact manager not bound yet — sync on next render */
      }
    }

    function getRailDocument() {
      if (artifactReviewPanel && artifactReviewPanel.ownerDocument) return artifactReviewPanel.ownerDocument;
      return typeof document !== 'undefined' ? document : null;
    }

    function capturePreviousFocus() {
      const doc = getRailDocument();
      const candidate = doc ? doc.activeElement : null;
      if (!candidate || typeof candidate.focus !== 'function') return;
      // A re-open from inside the rail must not clobber the original opener.
      if (artifactReviewPanel && artifactReviewPanel.contains(candidate)) return;
      previousFocusEl = candidate;
    }

    function restorePreviousFocus() {
      const doc = getRailDocument();
      const previous = previousFocusEl;
      previousFocusEl = null;
      if (previous && previous.isConnected && typeof previous.focus === 'function') {
        try { previous.focus({ preventScroll: false }); return; } catch (_) { /* fall through */ }
      }
      const fallback = doc && (doc.querySelector('.chat-entry[tabindex="0"]') || doc.querySelector('.chat-entry'));
      if (fallback && typeof fallback.focus === 'function') {
        try { fallback.focus({ preventScroll: false }); } catch (_) { /* best-effort */ }
      }
    }

    function createView(module) {
      if (!module || typeof module.createChangesView !== 'function') return null;
      const getTurnTime = typeof module.createTurnTimeLookup === 'function' && typeof getSessionMessages === 'function'
        ? module.createTurnTimeLookup(getSessionMessages)
        : null;
      return module.createChangesView({
        host: 'panel',
        getTurnViewModels: () => getTurnViewModelsForActiveSession() || [],
        getSessionId: () => normalizeId(getActiveSessionId()),
        getWorkspaceId: () => normalizeId(getWorkspaceId()) || 'default',
        buildLedger: buildJennyChangeLedgerFromTurnViewModels,
        getTurnTime,
        renderDiffBody,
        openInWorkspace,
        getUndoController,
        onBackToChat: () => closeCodeReview(),
        escapeHtml,
        appendClientLog,
      });
    }

    function ensureView() {
      if (view) return Promise.resolve(view);
      if (!viewLoad) {
        viewLoad = Promise.resolve()
          .then(() => loadChangesView())
          .then((module) => {
            if (disposed) return null;
            view = createView(module);
            if (!view) viewLoad = null;
            return view;
          })
          .catch((error) => {
            viewLoad = null;
            appendClientLog('ERROR', 'code_review.changes_view_load_failed', { message: String(error && error.message || error) });
            return null;
          });
      }
      return viewLoad;
    }

    function openCodeReviewTarget(payload) {
      const scope = normalizeId(payload?.scope).toLowerCase();
      if (!SCOPES.has(scope)) {
        appendClientLog('WARN', 'code_review.open_invalid_scope', { scope: String(payload?.scope || '') });
        return false;
      }
      capturePreviousFocus();
      pendingReveal = {
        scope,
        toolCallId: normalizeId(payload?.toolCallId),
        turnId: scope === 'session' ? '' : normalizeId(payload?.turnId),
        fileKey: scope === 'change' || scope === 'file' ? normalizeId(payload?.fileKey) : '',
      };
      setMode('code_review');
      syncArtifactReviewLayout();
      ensureView().then((ready) => {
        if (disposed) return;
        if (!ready) {
          pendingReveal = null;
          showComposerActionError(
            new Error(jt('changes.view.loadFailed', 'The Changes view could not be loaded.')),
            jt('codeReview.unavailableTitle', 'Code Review Unavailable')
          );
          return;
        }
        renderArtifactReviewPanel();
      });
      return true;
    }

    function closeCodeReview() {
      setMode('artifact');
      syncArtifactReviewLayout();
      renderArtifactReviewPanel();
      restorePreviousFocus();
    }

    function ensureHost(surface) {
      const panel = surface && surface.detailPanel;
      if (!panel) return null;
      if (!hostEl || !panel.contains(hostEl)) {
        const doc = panel.ownerDocument;
        panel.innerHTML = '';
        hostEl = doc.createElement('div');
        hostEl.className = 'changes-view-host';
        panel.appendChild(hostEl);
      }
      panel.classList.remove('hidden');
      if (surface.detailEmpty) surface.detailEmpty.classList.add('hidden');
      return hostEl;
    }

    function renderRailContent(surface) {
      const host = ensureHost(surface);
      if (!host) return;
      if (!view) {
        ensureView().then((ready) => { if (ready && !disposed) renderArtifactReviewPanel(); });
        return;
      }
      view.mount(host);
      if (pendingReveal) {
        const reveal = pendingReveal;
        pendingReveal = null;
        if (reveal.scope === 'suggested') view.revealSuggested({ toolCallId: reveal.toolCallId });
        else view.reveal(reveal);
      }
    }

    function handleRailKeydown(event) {
      if (state.ui?.artifactReview?.mode !== 'code_review' || !artifactReviewPanel) return;
      // The view handles Escape first (popover, detail page) and marks it.
      if (String(event?.key || '') !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      closeCodeReview();
    }

    function bind() {
      if (bound || !artifactReviewPanel) return;
      bound = true;
      artifactReviewPanel.addEventListener('keydown', handleRailKeydown);
    }

    function dispose() {
      disposed = true;
      if (view) view.dispose();
      view = null;
      hostEl = null;
      if (!bound || !artifactReviewPanel) return;
      bound = false;
      artifactReviewPanel.removeEventListener('keydown', handleRailKeydown);
    }

    return {
      bind,
      dispose,
      openCodeReviewTarget,
      closeCodeReview,
      renderRailContent,
      handleRailKeydown,
      getView: () => view,
    };
  }

  return { CHANGES_VIEW_SCRIPTS, createCodeReviewRail, loadChangesViewModules };
});
