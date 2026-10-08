(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const HIGHLIGHT_DURATION_MS = 2200;
  const MAX_JUMP_ATTEMPTS = 3;
  const JUMP_RETRY_DELAY_MS = 40;
  const turnShellUtils = typeof globalThis !== 'undefined' && globalThis.rendererTurnShell
    ? globalThis.rendererTurnShell
    : typeof require === 'function'
      ? require('../chat/renderer-turn-shell')
      : null;
  const mermaidUtils = typeof globalThis !== 'undefined' && globalThis.rendererMermaidUtils
    ? globalThis.rendererMermaidUtils
    : typeof require === 'function'
      ? require('./renderer-mermaid-utils')
      : null;
  const artifactRender = typeof globalThis !== 'undefined' && globalThis.rendererArtifactsRender
    ? globalThis.rendererArtifactsRender
    : typeof require === 'function'
      ? require('./renderer-artifacts-render')
      : {};
  const projection = typeof globalThis !== 'undefined' && globalThis.rendererArtifactsProjection
    ? globalThis.rendererArtifactsProjection
    : typeof require === 'function'
      ? require('./renderer-artifacts-projection')
      : {};
  const artifactSurfaceController = typeof globalThis !== 'undefined' && globalThis.rendererArtifactsSurfaceController
    ? globalThis.rendererArtifactsSurfaceController
    : typeof require === 'function'
      ? require('./renderer-artifacts-surface-controller')
      : {};
  const artifactReviewAutoopenModule = typeof globalThis !== 'undefined' && globalThis.rendererArtifactReviewAutoopen
    ? globalThis.rendererArtifactReviewAutoopen
    : typeof require === 'function'
      ? require('./renderer-artifact-review-autoopen')
      : null;
  const artifactReviewPrefs = typeof globalThis !== 'undefined' && globalThis.rendererArtifactReviewPrefs
    ? globalThis.rendererArtifactReviewPrefs
    : typeof require === 'function'
      ? require('./renderer-artifact-review-prefs')
      : {};
  // The rail state machine (prefs, layout, open/close, maximize, wrap, resizer, auto-open wiring).
  const artifactReviewRailModule = (typeof globalThis !== 'undefined' && globalThis.rendererArtifactReviewRail)
    || (typeof require === 'function' ? require('./renderer-artifact-review-rail') : null);
  const artifactDeleteConfirmModule = (typeof globalThis !== 'undefined' && globalThis.rendererArtifactDeleteConfirm)
    || (typeof require === 'function' ? require('./renderer-artifact-delete-confirm') : null);
  const {
    IMAGE_FILTER = 'image',
    TOOL_OUTPUT_FILTER = 'tool_output',
    GENERATED_FILE_FILTER = 'generated_file',
    isGeneratedFile = function fallbackIsGeneratedFile(artifact) { return artifact?.artifactType === 'generated_file'; },
    isImageArtifact = function fallbackIsImageArtifact(artifact) { return artifact?.artifactType === 'image'; },
    normalizeArtifactFilter = function fallbackNormalizeArtifactFilter() { return 'all'; },
    prettyPrintJson = function fallbackPrettyPrintJson(text) { return String(text || ''); },
    isMarkdownGeneratedArtifact = function fallbackIsMarkdownGeneratedArtifact() { return false; },
    isMermaidGeneratedArtifact = function fallbackIsMermaidGeneratedArtifact() { return false; },
    isHtmlGeneratedArtifact = function fallbackIsHtmlGeneratedArtifact() { return false; },
    isSvgGeneratedArtifact = function fallbackIsSvgGeneratedArtifact() { return false; },
    isChartGeneratedArtifact = function fallbackIsChartGeneratedArtifact() { return false; },
    extractMermaidSourceFromToolArtifact = function fallbackExtractMermaidSourceFromToolArtifact() { return ''; },
    clipPreviewText = function fallbackClipPreviewText(value) { return String(value || ''); },
    formatArtifactTimestamp = function fallbackFormatArtifactTimestamp(value) { return String(value || ''); },
    formatArtifactStatus = function fallbackFormatArtifactStatus(value) { return String(value || ''); },
    formatLanguageLabel = function fallbackFormatLanguageLabel(value) { return String(value || ''); },
    countByType = function fallbackCountByType() { return { generated_file: 0, image: 0, tool_output: 0 }; },
    filterArtifacts = function fallbackFilterArtifacts(artifacts) { return Array.isArray(artifacts) ? [...artifacts] : []; },
    filterDeletedArtifacts = function fallbackFilterDeletedArtifacts(artifacts) { return Array.isArray(artifacts) ? artifacts : []; },
    buildArtifactsFromMessages = function fallbackBuildArtifactsFromMessages() { return []; },
    sortArtifactsNewestFirst = function fallbackSortArtifactsNewestFirst(artifacts) { return Array.isArray(artifacts) ? [...artifacts] : []; },
  } = projection;
  const resolveVisibleMessageDomTarget = typeof turnShellUtils?.resolveVisibleMessageDomTarget === 'function'
    ? turnShellUtils.resolveVisibleMessageDomTarget
    : function fallbackResolveVisibleMessageDomTarget(container, messageId) {
      const normalizedMessageId = String(messageId || '').trim();
      if (!container || !normalizedMessageId || typeof container.querySelector !== 'function') {
        return null;
      }
      const escapeSelectorValue = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape
        : function fallbackEscapeSelectorValue(value) {
          return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        };
      return container.querySelector(`[data-message-id="${escapeSelectorValue(normalizedMessageId)}"]`);
    };
  const resolveTurnArticleMessageId = typeof turnShellUtils?.resolveTurnArticleMessageId === 'function'
    ? turnShellUtils.resolveTurnArticleMessageId
    : function fallbackResolveTurnArticleMessageId(messageId) {
      return String(messageId || '').trim();
    };

  function startIframeMermaidPreview(host, mermaidSource, renderId) {
    if (!host || typeof host.innerHTML !== 'string') return false;
    if (!mermaidUtils || typeof mermaidUtils.createMermaidFrame !== 'function') return false;
    mermaidUtils.createMermaidFrame(host, mermaidSource, {
      requestKey: renderId,
      onFailure: () => { host.innerHTML = '<div class="artifacts-empty">' + jt('artifacts.mermaid.previewUnavailable', 'Preview unavailable. Mermaid source is shown below.') + '</div>'; },
    });
    return true;
  }
  function renderMermaidPreviewIntoHost(host, mermaidSource, renderId) {
    if (!host || typeof host.innerHTML !== 'string') return false;
    if (typeof host.setAttribute === 'function') {
      // The mermaid theme bridge re-renders [data-mermaid-source] hosts on
      // palette switches (renderer-mermaid-theme-bridge.js).
      host.setAttribute('data-mermaid-source', String(mermaidSource || ''));
    }
    if (mermaidUtils && typeof mermaidUtils.renderMermaidDirect === 'function') {
      // Panels un-hide and render in the same tick; the layout-deferred entry waits for reflow first.
      const renderDirect = mermaidUtils.renderMermaidDirectWhenLaidOut || mermaidUtils.renderMermaidDirect;
      Promise.resolve(renderDirect(host, mermaidSource, {
        onSuccess: () => {
          if (typeof mermaidUtils.attachMermaidControls === 'function') {
            mermaidUtils.attachMermaidControls(host);
          }
        },
        onFailure: () => {
          if (!startIframeMermaidPreview(host, mermaidSource, renderId)) {
            host.innerHTML = '<div class="artifacts-empty">' + jt('artifacts.mermaid.previewUnavailable', 'Preview unavailable. Mermaid source is shown below.') + '</div>';
          }
        },
      })).catch(() => {
        if (!startIframeMermaidPreview(host, mermaidSource, renderId)) {
          host.innerHTML = '<div class="artifacts-empty">' + jt('artifacts.mermaid.previewUnavailable', 'Preview unavailable. Mermaid source is shown below.') + '</div>';
        }
      });
      return true;
    }
    return startIframeMermaidPreview(host, mermaidSource, renderId);
  }

  function createArtifactManager(deps) {
    const { state } = deps;
    const dom = deps.dom || {};
    const callbacks = deps.callbacks || {};
    const artifactCache = new Map();
    let highlightedMessageId = '';
    let highlightedTimeline = null;
    let highlightTimer = null;
    let bound = false;
    const { normalizeArtifactReviewMode } = artifactReviewPrefs;

    const {
      artifactReviewPanel,
      artifactReviewCollapseButton, artifactReviewDetailEmpty, artifactReviewDetailPanel, artifactReviewDetailKicker,
      artifactReviewDetailTitle, artifactReviewDetailPath, artifactReviewDetailStatus, artifactReviewDetailMeta,
      artifactReviewDetailNote, artifactReviewPreviewContent, artifactReviewEditorShell, artifactReviewEditorHost,
      artifactReviewEditorFallback, artifactReviewSaveButton, artifactReviewRevertButton, artifactReviewRevealButton,
      artifactReviewOpenExternalButton, artifactReviewJumpButton, artifactReviewDeleteButton, artifactReviewProvenanceTimeline,
      chatTimeline,
    } = dom;
    const {
      escapeHtml,
      getActiveSession,
      setActiveView,
      scrollMessageIntoView,
      appendClientLog,
      showToastMessage,
      toErrorMessage,
      getProjectionContext = function noopGetProjectionContext() { return null; },
      getChatTimelineRowModelEnabled = function noopGetChatTimelineRowModelEnabled() { return false; },
      recordChatTimelineRolloutSignal = function noopRecordChatTimelineRolloutSignal() { return { logged: false, count: 0 }; },
      rollbackChatTimelineRowModel = function noopRollbackChatTimelineRowModel() { return false; },
      renderCodeReviewSurface = null,
      renderFilePreviewSurface = null,
      renderTasksSurface = null,
      renderSubagentsSurface = null,
      renderNotesSurface = null,
      panelV2 = null,
      sidePanel = null, // split view W3-2 panel owner (shell artifact bridge); absent: the focused session
    } = callbacks;
    // The rail state machine owns prefs, layout, open/close and focus hand-off;
    // the manager keeps selection and rendering and lends it these hooks.
    const rail = artifactReviewRailModule.createArtifactReviewRail({
      state,
      dom,
      callbacks,
      manager: {
        getArtifactsForSession: (sessionId) => getArtifactsForSession(sessionId),
        ensureSelectionForArtifacts: (artifacts) => ensureSelectionForArtifacts(artifacts),
        getSelectedArtifact: () => getSelectedArtifact(),
        selectNewestArtifact: (sessionId) => selectNewestArtifactForAutoOpen(sessionId),
        renderArtifactReviewPanel: () => renderArtifactReviewPanel(),
        getExistingEditor: (surfaceKey) => surfaceController.getExistingEditor?.(surfaceKey),
      },
    });
    const {
      getArtifactReviewState, isArtifactReviewVisible, syncArtifactReviewLayout,
      closeArtifactReview, rememberReviewFocus, focusReview, restoreReviewFocus,
    } = rail;
    const surfaces = {
      // The studio ('full') surface is gone. Keep the key as an explicit null
      // so surface-controller consumers hit their !surface guards.
      full: null,
      split: {
        key: 'split',
        root: artifactReviewPanel,
        detailEmpty: artifactReviewDetailEmpty,
        detailPanel: artifactReviewDetailPanel,
        detailKicker: artifactReviewDetailKicker,
        detailTitle: artifactReviewDetailTitle,
        detailPath: artifactReviewDetailPath,
        detailStatus: artifactReviewDetailStatus,
        detailMeta: artifactReviewDetailMeta,
        detailNote: artifactReviewDetailNote,
        previewContent: artifactReviewPreviewContent,
        editorShell: artifactReviewEditorShell,
        editorHost: artifactReviewEditorHost,
        editorFallback: artifactReviewEditorFallback,
        saveButton: artifactReviewSaveButton,
        revertButton: artifactReviewRevertButton,
        revealButton: artifactReviewRevealButton,
        openExternalButton: artifactReviewOpenExternalButton,
        jumpButton: artifactReviewJumpButton,
        deleteButton: artifactReviewDeleteButton,
        provenanceTimeline: artifactReviewProvenanceTimeline,
        metaPane: null,
        dirtyBadge: typeof document !== 'undefined' ? document.getElementById('artifactReviewDirtyBadge') : null,
        stackedMeta: true,
      },
    };
    const artifactReviewScrollContainer = artifactReviewPanel?.querySelector?.('.artifact-review-scroll') || null;
    const createSurfaceController = typeof artifactSurfaceController.createArtifactSurfaceController === 'function'
      ? artifactSurfaceController.createArtifactSurfaceController
      : () => ({});
    const surfaceController = createSurfaceController({
      state,
      surfaces,
      artifactReviewScrollContainer,
      artifactRender,
      renderMermaidPreviewIntoHost,
      escapeHtml,
      appendClientLog,
      showToastMessage,
      toErrorMessage,
      getSelectedArtifact,
      getArtifactByTarget: (sessionId, artifactId) => getArtifactsForSession(sessionId).find((artifact) => artifact.id === String(artifactId || '').trim()) || null,
      getArtifactReviewState,
      normalizeArtifactReviewMode,
      renderCodeReviewSurface,
      renderArtifactReviewPanel: () => renderArtifactReviewPanel(),
      panelV2,
      invalidateSessionArtifacts: (...args) => invalidateSessionArtifacts(...args),
      clearSelection: () => clearSelection(),
      isGeneratedFile,
      isImageArtifact,
      isMarkdownGeneratedArtifact,
      isMermaidGeneratedArtifact,
      isHtmlGeneratedArtifact,
      isSvgGeneratedArtifact,
      isChartGeneratedArtifact,
      extractMermaidSourceFromToolArtifact,
      prettyPrintJson,
      formatArtifactTimestamp,
      formatArtifactStatus,
      formatLanguageLabel,
    });
    const {
      applySelection = () => {},
      captureSelectedTarget = () => null,
      clearEditorDocuments = () => {},
      clearImageArtifactDataForSession = () => {},
      copyArtifactDocumentCodeBlock = async () => {},
      copySelectedArtifactSource = async () => {},
      getSelectedArtifactSource = () => '',
      deleteSelectedArtifact = async () => {},
      stashDirtyArtifactIfNeeded = () => {},
      dispose: disposeSurfaceController = () => {},
      handleArtifactDocumentAction = () => false,
      handleArtifactDocumentKeydown = () => false,
      handleArtifactDocumentScroll = () => {},
      handleImagePreviewError = () => {},
      isGeneratedImageArtifactReadRequired = () => false,
      openSelectedArtifactExternal = async () => {},
      preloadSelectedArtifact = () => {},
      pruneArtifactDraftsForSessions = () => {},
      clearArtifactDrafts = () => {},
      pruneImageArtifactDataForSessions = () => {},
      renderSelectedArtifactDetail = () => {},
      resetImageArtifactState = () => {},
      resetLoadedState = () => {},
      revealSelectedArtifact = async () => {},
      revertSelectedArtifact = () => {},
      saveSelectedArtifact = async () => {},
      setArtifactDocumentViewMode = () => {},
      setArtifactMermaidViewMode = () => {},
      setArtifactViewMode = () => {},
      getArtifactViewMode = () => 'preview',
      getArtifactDocumentViewMode = () => 'read',
      toFileAssetUrl = () => '',
    } = surfaceController;
    const deleteConfirmController = artifactDeleteConfirmModule?.createArtifactDeleteConfirm?.({
      documentRef: typeof document !== 'undefined' ? document : null,
      getSelectedArtifact,
      captureTarget: () => captureSelectedTarget(),
      performDelete: (token) => deleteSelectedArtifact(token),
    }) || null;
    const renderArtifactCard = (artifact, selected) => (artifactRender.renderArtifactCard || (() => ''))(artifact, {
      escapeHtml,
      formatArtifactTimestamp,
      formatArtifactStatus,
      formatLanguageLabel,
      isGeneratedFile,
      isMermaidGeneratedArtifact,
      isImageArtifact,
      extractMermaidSourceFromToolArtifact,
      clipPreviewText,
      prettyPrintJson,
      toFileAssetUrl,
      selected,
    });

    function getArtifactsForSession(sessionId) {
      const key = String(sessionId || '').trim();
      if (!key) return [];
      const messages = state.messagesBySession.get(key) || [];
      const cached = artifactCache.get(key);
      if (cached && cached.messagesRef === messages) return filterDeletedArtifacts(cached.artifacts, state.artifacts.deletedArtifactIds, key);
      const artifacts = buildArtifactsFromMessages(messages, { sessionId: key });
      artifactCache.set(key, { messagesRef: messages, artifacts });
      return filterDeletedArtifacts(artifacts, state.artifacts.deletedArtifactIds, key);
    }
    function getSelectedArtifact() {
      const sessionId = String(state.artifacts.selectedSessionId || '').trim();
      const artifactId = String(state.artifacts.selectedArtifactId || '').trim();
      return sessionId && artifactId ? getArtifactsForSession(sessionId).find((artifact) => artifact.id === artifactId) || null : null;
    }
    function clearSelection() {
      // UIUX-007: defer (not discard) a dirty selection's in-progress edit
      // before wiping it — a filter change that empties the visible list,
      // a session reset, or a full artifacts reset must not lose work.
      stashDirtyArtifactIfNeeded();
      applySelection('', '');
      clearEditorDocuments();
    }
    function invalidateSessionArtifacts(sessionId, { preserveLoaded = false } = {}) {
      const key = String(sessionId || '').trim();
      if (!key) return;
      artifactCache.delete(key);
      state.artifacts.filter = 'all';
      if (state.artifacts.selectedSessionId === key && !preserveLoaded) resetLoadedState();
      clearImageArtifactDataForSession(key);
    }
    function rekeySessionArtifacts(oldSessionId, newSessionId) {
      const sourceSessionId = String(oldSessionId || '').trim();
      const targetSessionId = String(newSessionId || '').trim();
      if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) return targetSessionId || sourceSessionId;
      artifactCache.delete(sourceSessionId);
      artifactCache.delete(targetSessionId);
      clearImageArtifactDataForSession(sourceSessionId);
      clearImageArtifactDataForSession(targetSessionId);
      if (state.artifacts.selectedSessionId === sourceSessionId) state.artifacts.selectedSessionId = targetSessionId;
      rail.rekeySession(sourceSessionId, targetSessionId);
      return targetSessionId;
    }
    function clearSourceHighlight() {
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = null;
      if (highlightedMessageId && highlightedTimeline) {
        resolveVisibleMessageDomTarget(highlightedTimeline, highlightedMessageId)?.classList.remove('artifact-source-highlight');
      }
      highlightedMessageId = '';
    }
    function applySourceHighlight(messageId, target = null) {
      const targetId = String(messageId || '').trim();
      const timeline = target?.chatTimeline || chatTimeline;
      if (!targetId || !timeline) return false;
      clearSourceHighlight();
      const articleMessageId = resolveTurnArticleMessageId(targetId, (target?.getProjectionContext || getProjectionContext)());
      const targetNode = resolveVisibleMessageDomTarget(timeline, articleMessageId);
      if (!targetNode) return false;
      targetNode.classList.add('artifact-source-highlight');
      highlightedMessageId = articleMessageId;
      highlightedTimeline = timeline;
      highlightTimer = setTimeout(clearSourceHighlight, HIGHLIGHT_DURATION_MS);
      return true;
    }
    function jumpToArtifactSource(messageId, attempt = 0) {
      const targetId = String(messageId || '').trim();
      if (!targetId) return;
      setActiveView('chat');
      window.requestAnimationFrame(() => {
        const target = sidePanel?.getJumpTarget?.() || null; // split view: the pane showing the panel's chat
        if ((target?.scrollMessageIntoView || scrollMessageIntoView)(targetId, { block: 'center', followLatest: false }) && applySourceHighlight(targetId, target)) {
          appendClientLog('INFO', 'artifacts.jump_to_chat', { messageId: targetId });
          return;
        }
        if (attempt >= MAX_JUMP_ATTEMPTS) {
          appendClientLog('WARN', 'artifacts.jump_to_chat_failed', { messageId: targetId, attempts: attempt + 1 });
          const sessionId = String(state.currentSessionId || '').trim();
          if (sessionId && getChatTimelineRowModelEnabled(sessionId) === true) {
            recordChatTimelineRolloutSignal(sessionId, 'artifact_anchor_miss', {
              messageId: targetId,
              attempts: attempt + 1,
            });
            rollbackChatTimelineRowModel(sessionId, 'artifact_anchor_miss', {
              messageId: targetId,
              attempts: attempt + 1,
            });
          }
          return;
        }
        window.setTimeout(() => jumpToArtifactSource(targetId, attempt + 1), JUMP_RETRY_DELAY_MS);
      });
    }
    function resetArtifactsState() {
      artifactCache.clear();
      resetImageArtifactState();
      state.artifacts.filter = 'all';
      state.artifacts.autoOpenedSessionIds = [];
      state.artifacts.deletedArtifactIds = [];
      clearSelection();
      // Full reset: drop deferred dirty drafts too — including the one the
      // clearSelection() above may have just stashed for a dirty selection.
      clearArtifactDrafts();
      clearSourceHighlight();
    }
    function pruneSessionArtifacts(validSessionIds) {
      const allowed = new Set((Array.isArray(validSessionIds) ? validSessionIds : []).map((entry) => String(entry || '').trim()).filter(Boolean));
      if (Array.isArray(state.artifacts.autoOpenedSessionIds)) {
        state.artifacts.autoOpenedSessionIds = state.artifacts.autoOpenedSessionIds.filter((id) => allowed.has(id));
      }
      if (Array.isArray(state.artifacts.deletedArtifactIds)) {
        state.artifacts.deletedArtifactIds = state.artifacts.deletedArtifactIds.filter((entry) => allowed.has(String(entry || '').split('::')[0]));
      }
      for (const key of [...artifactCache.keys()]) if (!allowed.has(key)) artifactCache.delete(key);
      pruneImageArtifactDataForSessions(allowed);
      if (state.artifacts.selectedSessionId && !allowed.has(state.artifacts.selectedSessionId)) clearSelection();
      // After clearSelection(): it stashes a dirty leaving selection, and a
      // draft stashed for a removed session must not survive the prune.
      pruneArtifactDraftsForSessions(allowed);
      rail.pruneSessionPreferences([...allowed]);
      if (highlightedMessageId && !allowed.size) clearSourceHighlight();
    }
    // UIUX-007 shared navigation path for every selection-changing call site
    // (manual select, filter/session-driven re-selection, auto-open): defers
    // the LEAVING target's dirty content (stashDirtyArtifactIfNeeded reads
    // the CURRENT selection, so it must run before applySelection changes
    // it), applies the new target through the one generation-bumping choke
    // point, then preloads/clears the editor for the arriving target.
    function applyArtifactSelection(nextArtifact) {
      stashDirtyArtifactIfNeeded();
      applySelection(nextArtifact.sessionId, nextArtifact.id);
      preloadSelectedArtifact(nextArtifact);
      if (!isGeneratedFile(nextArtifact) && !isGeneratedImageArtifactReadRequired(nextArtifact)) {
        clearEditorDocuments();
      }
    }
    function ensureSelectionForArtifacts(artifacts) {
      const list = Array.isArray(artifacts) ? artifacts : [];
      if (!list.length) return clearSelection(), null;
      const currentSelection = getSelectedArtifact();
      if (currentSelection && list.some((artifact) => artifact.id === currentSelection.id)) {
        preloadSelectedArtifact(currentSelection);
        return currentSelection;
      }
      const nextArtifact = list[0];
      applyArtifactSelection(nextArtifact);
      return nextArtifact;
    }

    function selectArtifact(artifactId) {
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      if (!activeSession) return;
      const nextArtifact = getArtifactsForSession(activeSession.id).find((artifact) => artifact.id === String(artifactId || '').trim()) || null;
      if (!nextArtifact) return;
      if (state.artifacts.selectedArtifactId === nextArtifact.id && state.artifacts.selectedSessionId === activeSession.id) return;
      applyArtifactSelection(nextArtifact);
      renderArtifactReviewPanel();
    }

    function handleArtifactReviewClick(event) {
      if (handleArtifactDocumentAction(event, 'split')) return;
      if (event.target.closest('#artifactReviewCollapseButton')) {
        // D1 Close: hide now and remember it for this chat only.
        closeArtifactReview({ dismiss: true });
        restoreReviewFocus();
        return;
      }
      const mermaidModeButton = event.target.closest('[data-artifact-mermaid-mode]');
      if (mermaidModeButton) return setArtifactMermaidViewMode(mermaidModeButton.dataset.artifactMermaidMode);
      const viewModeButton = event.target.closest('[data-artifact-view-kind][data-artifact-view-mode]');
      if (viewModeButton) return setArtifactViewMode(viewModeButton.dataset.artifactViewKind, viewModeButton.dataset.artifactViewMode);
      const documentModeButton = event.target.closest('[data-artifact-document-view]');
      if (documentModeButton) return setArtifactDocumentViewMode('split', documentModeButton.dataset.artifactDocumentView);
      const documentCopyButton = event.target.closest('[data-artifact-document-copy-code]');
      if (documentCopyButton) return copyArtifactDocumentCodeBlock(documentCopyButton).catch(() => {});
      const selectButton = event.target.closest('[data-artifact-select]');
      if (selectButton) return selectArtifact(selectButton.dataset.artifactSelect);
      if (event.target.closest('#artifactReviewSaveButton')) return saveSelectedArtifact().catch(() => {}); /* fire-and-forget */
      if (event.target.closest('#artifactReviewRevertButton')) return revertSelectedArtifact();
      if (event.target.closest('#artifactReviewRevealButton')) return revealSelectedArtifact().catch(() => {}); /* fire-and-forget */
      if (event.target.closest('#artifactReviewOpenExternalButton')) return openSelectedArtifactExternal().catch(() => {}); /* fire-and-forget */
      if (event.target.closest('#artifactReviewDeleteButton')) return deleteConfirmController?.open?.();
      if (event.target.closest('#artifactReviewJumpButton')) return jumpToArtifactSource(artifactReviewJumpButton.dataset.artifactJump);
    }

    // Auto-open selects the newest artifact of the chat it presents.
    function selectNewestArtifactForAutoOpen(sessionId) {
      const newest = sessionId ? sortArtifactsNewestFirst(getArtifactsForSession(sessionId))[0] : null;
      if (!newest) return '';
      if (state.artifacts.selectedArtifactId !== newest.id || state.artifacts.selectedSessionId !== sessionId) applyArtifactSelection(newest);
      return newest.id;
    }

    // Artifact Panel V2 chrome sync: every split-surface detail render also
    // syncs the V2-only chrome (footer meta, save/revert visibility, version
    // stepper, edit/copy state) from current state. No-op when V2 isn't
    // installed (flag-off or module unavailable).
    // Panel-header "Open in IDE" (V3 chrome, renderer-artifact-panel-chrome-render.js).
    // It is a FILE-PREVIEW affordance only: an artifact's displayPath points
    // inside the internal .jenny/artifacts/<session>/ sandbox rather than at a
    // user source file, so artifact mode has no dependable IDE target and the
    // button stays hidden there. The click itself is routed by the file
    // preview controller's existing [data-file-preview-open-ide] delegation.
    function syncArtifactPanelOpenIdeButton(mode) {
      const button = artifactReviewPanel?.querySelector?.('.artifact-panel-open-ide');
      if (!button) return;
      const enabled = mode === 'file_preview' && Boolean(String(state.ui?.filePreview?.path || '').trim());
      button.classList.toggle('hidden', !enabled);
      button.disabled = !enabled;
      button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    }

    function renderSplitDetail(artifact) {
      // file_preview is a rail MODE, not an artifact: no synthetic artifact id
      // is created (that would corrupt getPreferredEditorValue()), so the
      // preview owner paints the surface and the V2 chrome syncs against null.
      const mode = normalizeArtifactReviewMode(getArtifactReviewState().mode);
      syncArtifactPanelOpenIdeButton(mode);
      if (mode === 'file_preview' && typeof renderFilePreviewSurface === 'function') {
        renderFilePreviewSurface(surfaces.split);
        panelV2?.afterRender?.(null);
        return;
      }
      if (mode === 'tasks' && typeof renderTasksSurface === 'function') {
        renderTasksSurface(surfaces.split);
        panelV2?.afterRender?.(null);
        return;
      }
      if (mode === 'notes') {
        // Pull: the lazily loaded Notes rail paints the surface; with its module absent the mode resets (like subagents).
        if (renderNotesSurface?.(surfaces.split) === true) { panelV2?.afterRender?.(null); return; }
        getArtifactReviewState().mode = 'artifact';
        syncArtifactReviewLayout();
      }
      if (mode === 'subagents') {
        // Pull: the Subagent Monitor paints only for its live record; with none the mode resets (safety net).
        if (renderSubagentsSurface?.(surfaces.split) === true) { panelV2?.afterRender?.(null); return; }
        getArtifactReviewState().mode = 'artifact';
        syncArtifactReviewLayout();
      }
      renderSelectedArtifactDetail(surfaces.split, artifact);
      panelV2?.afterRender?.(artifact);
    }

    function renderArtifactReviewPanel() {
      // The rail applies its session-switch rules and the auto-open, then syncs layout.
      if (!rail.beginRender() || !artifactReviewPanel) return;
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      if (!activeSession) {
        renderSplitDetail(null);
        return;
      }
      const artifacts = getArtifactsForSession(activeSession.id);
      if (!artifacts.length) {
        clearSelection();
        renderSplitDetail(null);
        return;
      }
      ensureSelectionForArtifacts(artifacts);
      renderSplitDetail(getSelectedArtifact());
    }

    async function openArtifactTarget(artifactId, options) {
      const normalizedArtifactId = String(artifactId || '').trim();
      // `source` tags where the open came from ('transcript-studio' — legacy
      // alias, 'inline-open-panel', …) for observability. Manual opens never
      // trigger the auto-open blink.
      const source = String(options?.source || '').trim();
      if (!source.startsWith('context-panel')) sidePanel?.claim(); // W3-2: an explicit open claims the panel (the panel's own list never does)
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      if (!activeSession) return false;
      rememberReviewFocus();
      if (source) {
        appendClientLog?.('INFO', 'artifacts.open_target', { source, artifactId: normalizedArtifactId });
      }
      const artifacts = getArtifactsForSession(activeSession.id);
      if (normalizedArtifactId) {
        selectArtifact(normalizedArtifactId);
      } else if (artifacts.length) {
        ensureSelectionForArtifacts(artifacts);
      }
      // Any non-artifact rail mode (code_review, file_preview) yields to an
      // explicit artifact open; each mode keeps its own renderer-local state
      // (state.ui.codeReview / state.ui.filePreview) for a later re-open.
      rail.enableForArtifactOpen(activeSession.id);
      renderArtifactReviewPanel();
      focusReview();
      return true;
    }

    // One table so bind and dispose cannot drift: [target, type, handler, capture].
    function listenerTable() {
      const clickTargets = [artifactReviewCollapseButton, artifactReviewSaveButton, artifactReviewRevertButton, artifactReviewRevealButton,
        artifactReviewOpenExternalButton, artifactReviewJumpButton, artifactReviewDeleteButton, artifactReviewPreviewContent];
      return [
        [artifactReviewPanel, 'error', handleImagePreviewError, true],
        [artifactReviewScrollContainer, 'scroll', handleArtifactDocumentScroll],
        ...clickTargets.map((target) => [target, 'click', handleArtifactReviewClick]),
        [artifactReviewPreviewContent, 'keydown', handleArtifactReviewKeydown],
      ];
    }

    function bind() {
      // W1-5: no artifactsView gate — the studio DOM is gone and the split
      // review panel's listeners must attach regardless.
      if (bound) return;
      bound = true;
      rail.bind(); // syncs the layout and binds the resizer, the strip toggle and Escape
      for (const [target, type, handler, capture] of listenerTable()) target?.addEventListener(type, handler, capture === true);
      deleteConfirmController?.bind?.();
    }

    function handleArtifactReviewKeydown(event) {
      handleArtifactDocumentKeydown(event, 'split');
    }

    function dispose() {
      clearSourceHighlight();
      if (!bound) return;
      bound = false;
      for (const [target, type, handler, capture] of listenerTable()) target?.removeEventListener(type, handler, capture === true);
      rail.dispose();
      deleteConfirmController?.dispose?.();
      disposeSurfaceController();
    }

    return { bind, dispose, buildArtifactsFromMessages: (messages, options) => buildArtifactsFromMessages(messages, options), clearSourceHighlight, collapseArtifactReview: rail.collapseArtifactReview, filterArtifacts: (artifacts, filterValue) => filterArtifacts(artifacts, filterValue), getArtifactsForSession, getSelectedArtifactSource, invalidateSessionArtifacts, isArtifactReviewVisible, isArtifactReviewMaximized: rail.isArtifactReviewMaximized, jumpToArtifactSource, normalizeArtifactFilter, openArtifactTarget, openArtifactRail: rail.openArtifactRail, restoreArtifactReviewPrefs: rail.restoreArtifactReviewPrefs, pruneSessionArtifacts, rekeySessionArtifacts, renderArtifactReviewPanel, resetArtifactsState, selectArtifact, syncArtifactReviewLayout, setArtifactRailMode: rail.setArtifactRailMode, toggleArtifactReview: rail.toggleArtifactReview, toggleArtifactReviewMaximized: rail.toggleArtifactReviewMaximized, setArtifactDocumentViewMode, getArtifactDocumentViewMode, setArtifactViewMode, getArtifactViewMode, copyArtifactDocumentCodeBlock, copySelectedArtifactSource };
  }

  return { GENERATED_FILE_FILTER, IMAGE_FILTER, TOOL_OUTPUT_FILTER, buildArtifactsFromMessages, clipPreviewText, createArtifactManager, filterArtifacts, normalizeArtifactFilter, sortArtifactsNewestFirst };
});
