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
    Object.freeze(['renderer/features/renderer-changes-view-actions.js', 'rendererChangesViewActions']),
    Object.freeze(['renderer/features/renderer-changes-suggested-actions.js', 'rendererChangesSuggestedActions']),
    Object.freeze(['renderer/features/renderer-changes-view.js', 'rendererChangesView']),
    Object.freeze(['renderer/features/renderer-changes-undo-plan.js', 'rendererChangesUndoPlan']),
    Object.freeze(['renderer/features/renderer-changes-undo-sheet.js', 'rendererChangesUndoSheet']),
    Object.freeze(['renderer/features/renderer-changes-undo.js', 'rendererChangesUndo']),
  ]);

  // The Working tree page (row 59 checkpoint 2) loads lazily with the Changes view; the IDE never uses it.
  const WORKING_TREE_SCRIPTS = Object.freeze([
    Object.freeze(['renderer/chat/renderer-unified-diff-parse.js', 'rendererUnifiedDiffParse']),
    Object.freeze(['renderer/features/renderer-changes-scope-data.js', 'rendererChangesScopeData']),
    Object.freeze(['renderer/features/renderer-changes-working-tree-render.js', 'rendererChangesWorkingTreeRender']),
    Object.freeze(['renderer/features/renderer-changes-working-tree.js', 'rendererChangesWorkingTree']),
  ]);

  // Before and after pictures (row 122) load lazily too: with the Changes view, and from the
  // transcript the first time a chat shows a change. The IDE dock shows none.
  const CHANGE_PICTURES_SCRIPTS = Object.freeze([
    Object.freeze(['renderer/inventory/compare-slider.js', 'inventoryCompareSlider']),
    Object.freeze(['renderer/features/renderer-change-pictures-model.js', 'rendererChangePicturesModel']),
    Object.freeze(['renderer/features/renderer-change-pictures.js', 'rendererChangePictures']),
  ]);

  const SCOPES = new Set(['change', 'turn', 'file', 'session', 'suggested']);

  // Loads [src, global] pairs in order; false at the first script that did not arrive.
  async function loadScriptList(list, { ensureScript, windowRef, log } = {}) {
    const globalRef = windowRef || globalThis;
    for (const [src, globalName] of list) {
      const isReady = () => Boolean(globalRef[globalName]);
      if (isReady()) continue;
      const ok = typeof ensureScript === 'function' ? await ensureScript({ src, isReady, log }) : false;
      if (!ok) return false;
    }
    return true;
  }

  /** Resolves to the pictures module, or null when a script failed (the caller shows no pictures). */
  async function loadChangePictures(options = {}) {
    const globalRef = options.windowRef || globalThis;
    const ensureScript = options.ensureScript || globalRef.scriptLoaderUtils?.ensureScript;
    const ok = await loadScriptList(CHANGE_PICTURES_SCRIPTS, { ensureScript, windowRef: globalRef, log: options.log });
    return ok ? globalRef.rendererChangePictures || null : null;
  }

  // One load per window for the transcript: a failed load is not retried on every chat render.
  const chatPicturesLoads = new WeakMap();

  /**
   * The transcript's pictures, called after every chat render. `root` is the timeline or one article.
   * The modules load the first time a chat shows a change; until then this only looks for one.
   */
  function decorateChatPictures({ root, timeline, getSessionId, getTurns, isEnabled, windowRef, log } = {}) {
    const globalRef = windowRef || globalThis;
    const enabled = () => typeof isEnabled !== 'function' || isEnabled() !== false;
    const decorate = (module, target) => {
      const sessionId = normalizeId(getSessionId());
      module.decorateChat({ root: target, sessionId, getTurns: () => getTurns(sessionId) || [], enabled: enabled() });
    };
    const ready = globalRef.rendererChangePictures;
    if (ready && typeof ready.decorateChat === 'function') {
      if (root) decorate(ready, root);
      return;
    }
    if (chatPicturesLoads.has(globalRef) || !enabled() || !root || typeof root.querySelector !== 'function' || !root.querySelector('[data-jenny-code-review]')) return;
    chatPicturesLoads.set(globalRef, loadChangePictures({ windowRef: globalRef, log }).then((module) => {
      const target = timeline || root;
      if (module && typeof module.decorateChat === 'function' && target.isConnected) decorate(module, target);
    }).catch(() => {}));
  }

  /**
   * Loads the Changes view modules in order. Resolves to the view module, or
   * null when a script failed (the caller shows an error instead of a blank panel).
   */
  async function loadChangesViewModules(options = {}) {
    if (!await loadScriptList(CHANGES_VIEW_SCRIPTS, options)) return null;
    // Best effort: without the Working tree page the panel keeps the ledger view only,
    // and without the pictures modules it shows the text diff only.
    await loadScriptList(WORKING_TREE_SCRIPTS, options);
    await loadChangePictures(options);
    return (options.windowRef || globalThis).rendererChangesView || null;
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
      // The rail's shared open path (mode, open, chat view, saved); without it
      // a closed side panel only changed mode and the review never showed.
      openArtifactRail = null,
      renderArtifactReviewPanel = function noopRenderArtifactReviewPanel() {},
      syncArtifactReviewLayout = function noopSyncArtifactReviewLayout() {},
      appendClientLog = function noopAppendClientLog() {},
      showComposerActionError = function noopShowComposerActionError() {},
      escapeHtml,
      // Working tree page (row 59 checkpoint 2): the explicit owner claim, the bridge, and the two hand-offs.
      claimOwner = null,
      getChatWorkspace = function defaultChatWorkspace() { return (globalThis.jennyShell && globalThis.jennyShell.chatWorkspace) || null; },
      getWorkingTreeModule = function defaultWorkingTreeModule() { return globalThis.rendererChangesWorkingTree || null; },
      openWorkingTreeFile = function defaultOpenFile(path) { return globalThis.rendererChatWorkspaceDetail?.openInWorkspace?.(path); },
      openInGit = function defaultOpenInGit() { return globalThis.rendererChatWorkspaceDetail?.openInGit?.(); },
      // Text actions and find on the page (row 99): code copy, Ask Jenny, body menu, `[` / `]`.
      getPageActionsModule = function defaultPageActionsModule() { return globalThis.rendererChangesViewActions || null; },
      // The suggested-changes client and model: a suggestion this chat applied is a change it made too.
      getSuggestedClient = function defaultSuggestedClient() { return globalThis.rendererSuggestedChangesClient?.getSharedClient?.() || null; },
      getSuggestedModel = function defaultSuggestedModel() { return globalThis.rendererSuggestedChangesModel || null; },
      // Before and after pictures (row 122): the module fills the page's picture slots.
      getChangePicturesModule = function defaultChangePicturesModule() { return globalThis.rendererChangePictures || null; },
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
    // 'working_tree' (or 'branch' once picked) only when opened from the session rail; a transcript "Review changes" keeps the ledger.
    let pageScope = 'this_chat';
    let ownerSessionId = '';
    let workingTree = null;
    let pageEl = null;
    let workingTreeEl = null;
    let pageActions = null;
    let pictures = null;
    let pendingFocus = false;
    // A chat findings list's Show in diff (row 64): handed to the Working tree page on the next render.
    let pendingFindings = null;
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
      pageScope = 'this_chat';
      ownerSessionId = '';
      pendingFindings = null;
      pendingReveal = {
        scope,
        toolCallId: normalizeId(payload?.toolCallId),
        turnId: scope === 'session' ? '' : normalizeId(payload?.turnId),
        fileKey: scope === 'change' || scope === 'file' ? normalizeId(payload?.fileKey) : '',
      };
      if (typeof openArtifactRail === 'function') {
        openArtifactRail('code_review');
      } else {
        setMode('code_review');
        syncArtifactReviewLayout();
      }
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

    /**
     * The session rail's Changes row: the read-only working-tree page for `ownerSessionId` (the panel
     * owner, never the active session). `opener` gets focus back when the panel closes.
     */
    function openWorkingTree({ ownerSessionId: owner, opener, reviewFindings } = {}) {
      const id = normalizeId(owner);
      // The page module loads lazily through ensureView() below; a load failure falls back to the ledger (applyScope).
      if (!id) return false;
      if (typeof claimOwner === 'function') claimOwner(id);
      ownerSessionId = id;
      pageScope = 'working_tree';
      pendingReveal = null;
      const withFindings = Boolean(reviewFindings && typeof reviewFindings === 'object');
      // A plain open clears comments left by an earlier Show in diff (their lines may have moved since).
      pendingFindings = withFindings ? reviewFindings : {};
      // The page scrolls to the focused finding's comment instead of focusing the scope switch.
      pendingFocus = !withFindings;
      if (opener && opener.isConnected && typeof opener.focus === 'function') previousFocusEl = opener;
      else capturePreviousFocus();
      if (typeof openArtifactRail === 'function') {
        openArtifactRail('code_review');
      } else {
        setMode('code_review');
        syncArtifactReviewLayout();
      }
      ensureView().then((ready) => {
        if (disposed) return;
        if (!ready) {
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
      // Findings not applied before the rail closed belong to that Show in diff only.
      pendingFindings = null;
      setMode('artifact');
      syncArtifactReviewLayout();
      renderArtifactReviewPanel();
      restorePreviousFocus();
    }

    // The page sits beside the artifact body, never in place of it: the shared surface holds the preview,
    // editor and detail nodes by reference, so clearing the panel left the file preview and artifact
    // renders writing into detached nodes. `.code-review-mode` on the panel picks which one shows.
    function ensureHost(surface) {
      const panel = surface && surface.detailPanel;
      if (!panel) return null;
      if (!hostEl || !panel.contains(hostEl)) {
        const doc = panel.ownerDocument;
        if (workingTree) workingTree.unmount();
        pageActions?.dispose();
        pictures?.dispose();
        pictures = null;
        pageEl?.remove();
        pageEl = doc.createElement('div');
        pageEl.className = 'changes-detail-page';
        workingTreeEl = doc.createElement('div');
        hostEl = doc.createElement('div');
        hostEl.className = 'changes-view-host';
        pageEl.append(workingTreeEl, hostEl);
        panel.appendChild(pageEl);
        pageActions = getPageActionsModule()?.createChangesPageActions({
          getLedgerDetail: () => view?.getDetail() || null,
          getWorkingTreeHunks: (path) => workingTree?.getFileHunks(path) || null,
          openWorkingTreeFile: (path) => openWorkingTreeFile(path),
          openLedgerChange: (changeId) => openInWorkspace?.(changeId),
          log: appendClientLog,
        }) || null;
        pageActions?.attach(pageEl);
      }
      panel.classList.remove('hidden');
      if (surface.detailEmpty) surface.detailEmpty.classList.add('hidden');
      return hostEl;
    }

    // The paths this chat changed, from the ledger the "This chat" page reads plus the suggestions it applied.
    // null while any part is unknown (no turns loaded, suggestions still loading, notices that omitted paths):
    // the Working tree page then says nothing instead of guessing which files are not this chat's.
    function collectChatChangedPaths() {
      const sessionId = normalizeId(getActiveSessionId()) || ownerSessionId;
      const client = getSuggestedClient();
      const model = getSuggestedModel();
      if (!sessionId || typeof buildJennyChangeLedgerFromTurnViewModels !== 'function' || !client || !model || typeof model.buildAppliedHistory !== 'function') return null;
      const turns = getTurnViewModelsForActiveSession(sessionId) || [];
      const list = client.get(sessionId); // starts the one load when the list is not there yet
      if (!turns.length || !list) return null;
      const workspaceId = normalizeId(getWorkspaceId()) || 'default';
      const ledger = buildJennyChangeLedgerFromTurnViewModels(turns, { sessionId, workspaceId });
      const skipped = Array.isArray(ledger && ledger.skipped) ? ledger.skipped : [];
      const notices = Array.isArray(ledger && ledger.notices) ? ledger.notices : [];
      if (skipped.some((skip) => skip.reason === 'invalid_path' || skip.reason === 'invalid_turn')) return null;
      if (notices.some((notice) => notice.omittedCount > 0 || notice.state === 'unavailable' || notice.reason)) return null;
      const paths = new Set();
      for (const change of Array.isArray(ledger.changes) ? ledger.changes : []) if (change && change.path) paths.add(change.path);
      for (const change of model.buildAppliedHistory(list, { workspaceId }).changes || []) if (change && change.path) paths.add(change.path);
      return paths;
    }

    function ensureWorkingTree() {
      if (workingTree) return workingTree;
      const module = getWorkingTreeModule();
      if (!module || typeof module.createChangesWorkingTree !== 'function') return null;
      workingTree = module.createChangesWorkingTree({
        // The page follows the panel's session (the claimed owner in split view, so a focus change never
        // retargets it), which is also the session the owner line names; the opener's owner is the fallback.
        getSessionId: () => normalizeId(getActiveSessionId()) || ownerSessionId,
        getBridge: getChatWorkspace,
        openInWorkspace: (path) => openWorkingTreeFile(path),
        openInGit: () => openInGit(),
        onScopeChange: (next) => { pageScope = next === 'working_tree' || next === 'branch' ? next : 'this_chat'; applyScope(); },
        getChatChangedPaths: collectChatChangedPaths,
        subscribeChatChanges: (callback) => getSuggestedClient()?.subscribe?.((changedSessionId) => {
          if (normalizeId(changedSessionId) === (normalizeId(getActiveSessionId()) || ownerSessionId)) callback();
        }) || null,
        log: appendClientLog,
        escapeHtml,
      });
      return workingTree;
    }

    // The switch's two pages share one host: the working tree page or the ledger view.
    function applyScope() {
      if (!pageEl || !hostEl || !workingTreeEl) return;
      const page = ensureWorkingTree();
      // Working tree and Whole branch share the git page; only This chat shows the ledger.
      const gitPage = pageScope === 'working_tree' || pageScope === 'branch';
      pageEl.dataset.changesScope = page ? pageScope : 'this_chat';
      if (!page) {
        workingTreeEl.hidden = true;
        hostEl.hidden = false;
        view?.mount(hostEl);
        return;
      }
      workingTreeEl.hidden = false;
      page.mount(workingTreeEl);
      page.setScope(pageScope);
      if (pendingFindings && pageScope === 'working_tree') {
        const findings = pendingFindings;
        pendingFindings = null;
        page.setReviewFindings(findings);
      }
      hostEl.hidden = gitPage;
      if (gitPage) view?.unmount();
      else view?.mount(hostEl);
      if (pendingFocus && pageScope === 'working_tree') {
        pendingFocus = false;
        workingTreeEl.querySelector('.inv-segmented-option[aria-checked="true"]')?.focus?.({ preventScroll: true });
      }
    }

    // Watches the page for the picture slots both pages emit and fills them. The module arrives with the
    // view's scripts, so this attaches on the first render that has a view, before either page mounts.
    function ensurePictures() {
      if (pictures || !pageEl) return;
      const module = getChangePicturesModule();
      if (!module || typeof module.attachPanel !== 'function') return;
      try {
        pictures = module.attachPanel(pageEl, {
          getSessionId: () => normalizeId(getActiveSessionId()) || ownerSessionId,
          getTurnViewModels: (sessionId) => getTurnViewModelsForActiveSession(sessionId) || [],
          getWorkspaceId: () => normalizeId(getWorkspaceId()) || 'default',
          isEnabled: () => state.features?.featureFlags?.change_pictures !== false,
        }) || null;
      } catch (error) {
        appendClientLog('WARN', 'code_review.change_pictures_attach_failed', { message: String(error && error.message || error) });
      }
    }

    function renderRailContent(surface) {
      const host = ensureHost(surface);
      if (!host) return;
      if (!view) {
        ensureView().then((ready) => { if (ready && !disposed) renderArtifactReviewPanel(); });
        return;
      }
      ensurePictures();
      applyScope();
      if (pageScope !== 'this_chat') return;
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
      if (workingTree) workingTree.dispose();
      workingTree = null;
      pageActions?.dispose();
      pageActions = null;
      pictures?.dispose();
      pictures = null;
      hostEl = null;
      pageEl = null;
      workingTreeEl = null;
      if (!bound || !artifactReviewPanel) return;
      bound = false;
      artifactReviewPanel.removeEventListener('keydown', handleRailKeydown);
    }

    return {
      bind,
      dispose,
      openCodeReviewTarget,
      openWorkingTree,
      closeCodeReview,
      renderRailContent,
      handleRailKeydown,
      getView: () => view,
      getWorkingTree: () => workingTree,
    };
  }

  return {
    CHANGES_VIEW_SCRIPTS, WORKING_TREE_SCRIPTS, CHANGE_PICTURES_SCRIPTS,
    createCodeReviewRail, loadChangesViewModules, loadChangePictures, decorateChatPictures,
  };
});
