(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
      onFailure: () => { host.innerHTML = '<div class="artifacts-empty">Preview unavailable. Mermaid source is shown below.</div>'; },
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
            host.innerHTML = '<div class="artifacts-empty">Preview unavailable. Mermaid source is shown below.</div>';
          }
        },
      })).catch(() => {
        if (!startIframeMermaidPreview(host, mermaidSource, renderId)) {
          host.innerHTML = '<div class="artifacts-empty">Preview unavailable. Mermaid source is shown below.</div>';
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
    const ARTIFACT_REVIEW_STORAGE_KEY = 'jenny.artifactReview.v1';
    const ARTIFACT_REVIEW_MIN_STAGE_WIDTH = 1080;
    const ARTIFACT_REVIEW_KEYBOARD_STEP = 24;
    let highlightedMessageId = '';
    let highlightTimer = null;
    let bound = false;
    let artifactReviewStateLoaded = false;
    let artifactReviewAutoOpenController = null;
    // Preference helpers + width constants (incl. the V2 widthBySession logic and the WS3 lockstep normalizer) live in renderer-artifact-review-prefs.js.
    const { ARTIFACT_REVIEW_DEFAULT_WIDTH, ARTIFACT_REVIEW_MIN_WIDTH, clampArtifactReviewWidth, normalizeArtifactReviewMode, normalizeArtifactReviewPreferences, resolveArtifactReviewMaxWidth, resolveEffectiveArtifactReviewWidth, recordArtifactReviewWidth, resolveArtifactReviewMaximized, recordArtifactReviewMaximized, pruneArtifactReviewSessionPreferences } = artifactReviewPrefs;
    const artifactReviewRuntime = { pointerId: null, startX: 0, startWidth: ARTIFACT_REVIEW_DEFAULT_WIDTH };

    const {
      workspace, sidebar, sidebarResizer, chatView,
      artifactSplitViewToggle, artifactReviewResizer, artifactReviewPanel, artifactReviewStatus,
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
      updateComposerSafeOffset,
      renderAll,
      getChatTimelineRowModelEnabled = function noopGetChatTimelineRowModelEnabled() { return false; },
      recordChatTimelineRolloutSignal = function noopRecordChatTimelineRolloutSignal() { return { logged: false, count: 0 }; },
      rollbackChatTimelineRowModel = function noopRollbackChatTimelineRowModel() { return false; },
      renderCodeReviewSurface = null,
      renderFilePreviewSurface = null,
      renderTasksSurface = null,
      resetFilePreview = null,
      panelV2 = null,
    } = callbacks;
    // Session id last seen by renderArtifactReviewPanel — a switch invalidates
    // the file-preview rail (it was opened from another conversation).
    let lastRenderedArtifactSessionId = '';
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
      return targetSessionId;
    }
    function clearSourceHighlight() {
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = null;
      if (highlightedMessageId && chatTimeline) {
        resolveVisibleMessageDomTarget(chatTimeline, highlightedMessageId)?.classList.remove('artifact-source-highlight');
      }
      highlightedMessageId = '';
    }
    function applySourceHighlight(messageId) {
      const targetId = String(messageId || '').trim();
      if (!targetId || !chatTimeline) return false;
      clearSourceHighlight();
      const articleMessageId = resolveTurnArticleMessageId(targetId, getProjectionContext());
      const targetNode = resolveVisibleMessageDomTarget(chatTimeline, articleMessageId);
      if (!targetNode) return false;
      targetNode.classList.add('artifact-source-highlight');
      highlightedMessageId = articleMessageId;
      highlightTimer = setTimeout(clearSourceHighlight, HIGHLIGHT_DURATION_MS);
      return true;
    }
    function jumpToArtifactSource(messageId, attempt = 0) {
      const targetId = String(messageId || '').trim();
      if (!targetId) return;
      setActiveView('chat');
      window.requestAnimationFrame(() => {
        if (scrollMessageIntoView(targetId, { block: 'center', followLatest: false }) && applySourceHighlight(targetId)) {
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
      const prefs = ensureArtifactReviewState();
      pruneArtifactReviewSessionPreferences?.(prefs, [...allowed]);
      saveArtifactReviewPreferences();
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
    function getArtifactReviewState() { return ensureArtifactReviewState(); }
    function getWorkspaceWidth() {
      // Measure the chat stage because workspace width includes the sidebar and
      // can select the wrong layout.
      const workspaceWidth = Math.max(Number(workspace?.getBoundingClientRect?.().width || 0), 0);
      const sidebarWidth = Number(sidebar?.getBoundingClientRect?.().width || 0);
      const resizerWidth = sidebarResizer && !sidebarResizer.hidden ? Number(sidebarResizer.getBoundingClientRect?.().width || 0) : 0;
      return Math.max(workspaceWidth - sidebarWidth - resizerWidth, 0);
    }
    function isArtifactReviewEligible() {
      // No artifacts>0 clause (owner call 2026-07-05): an enabled panel with
      // zero artifacts shows its empty state instead of silently hiding —
      // auto-open keeps its own artifact-count gate.
      // No width clause (W1-5): with the studio fallback removed, a narrow
      // stage renders the panel as an overlay drawer (syncArtifactReviewLayout
      // stamps .artifact-review-overlay) instead of losing artifact access.
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      return state.ui?.activeView === 'chat' && Boolean(activeSession);
    }
    function isArtifactReviewVisible() {
      const prefs = getArtifactReviewState();
      return prefs.enabled === true && prefs.collapsed !== true && isArtifactReviewEligible();
    }
    function updateArtifactReviewStatusText() {
      if (!artifactReviewStatus) return;
      const prefs = getArtifactReviewState();
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      const artifactCount = activeSession ? getArtifactsForSession(activeSession.id).length : 0;
      artifactReviewStatus.textContent = !prefs.enabled
        ? 'Split view is off. Toggle it on to keep artifacts beside chat.'
        : prefs.collapsed
          ? 'Artifact review is collapsed.'
          : !activeSession || artifactCount === 0
            ? 'Split view keeps artifact details beside chat.'
            : getWorkspaceWidth() < ARTIFACT_REVIEW_MIN_STAGE_WIDTH
              ? `${artifactCount} artifact${artifactCount === 1 ? '' : 's'} in the overlay drawer (window is narrow).`
              : `${artifactCount} artifact${artifactCount === 1 ? '' : 's'} available beside chat.`;
    }
    function syncArtifactReviewLayout(options = {}) {
      const prefs = getArtifactReviewState();
      const width = getEffectiveArtifactReviewWidth(prefs);
      const visible = isArtifactReviewVisible();
      const mode = normalizeArtifactReviewMode(prefs.mode);
      workspace?.style?.setProperty('--artifact-review-width', `${width}px`);
      artifactReviewPanel?.style?.setProperty('width', `${width}px`);
      artifactReviewPanel?.classList.toggle('hidden', !visible);
      // W1-5 narrow-stage fallback (studio removed): below the side-by-side
      // width threshold the panel overlays chat as a drawer instead of
      // becoming ineligible — same DOM, one modifier class. In overlay mode
      // chat keeps its full width (no artifact-review-open layout shift) and
      // the resizer is parked (drawer width is fixed by CSS).
      const overlay = visible && getWorkspaceWidth() < ARTIFACT_REVIEW_MIN_STAGE_WIDTH;
      const maximized = visible && !overlay && isArtifactReviewMaximized();
      artifactReviewPanel?.classList.toggle('artifact-review-overlay', overlay);
      artifactReviewPanel?.classList.toggle('is-narrow', width < 360);
      artifactReviewPanel?.classList.toggle('code-review-mode', mode === 'code_review');
      if (artifactReviewPanel?.dataset) {
        artifactReviewPanel.dataset.artifactReviewMode = mode;
      }
      artifactReviewResizer?.classList.toggle('hidden', !visible || overlay || maximized);
      if (artifactReviewResizer) {
        artifactReviewResizer.tabIndex = (visible && !overlay && !maximized) ? 0 : -1;
        // role="separator" value range: the max is the RESOLVED 90% bound, so
        // assistive tech reports the same ceiling the End key lands on.
        artifactReviewResizer.setAttribute('aria-valuemin', String(ARTIFACT_REVIEW_MIN_WIDTH));
        artifactReviewResizer.setAttribute('aria-valuemax', String(getResolvedArtifactReviewMaxWidth()));
        artifactReviewResizer.setAttribute('aria-valuenow', String(width));
      }
      if (artifactSplitViewToggle) {
        artifactSplitViewToggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
        artifactSplitViewToggle.classList.toggle('active', visible);
      }
      chatView?.classList.toggle('artifact-review-open', visible && !overlay);
      chatView?.classList.toggle('artifact-review-mode', visible);
      chatView?.classList.toggle('code-review-open', visible && mode === 'code_review');
      chatView?.classList.toggle('artifact-review-maximized', maximized);
      updateArtifactReviewStatusText();
      updateComposerSafeOffset?.();
      if (options.refreshChatChrome) renderAll?.();
    }


    function isArtifactPanelV2Enabled() { return state?.features?.featureFlags?.artifact_panel_v2 === true; }
    function isArtifactPanelV3Enabled() { return state?.features?.featureFlags?.artifact_panel_v3 === true; }
    function getActiveSessionIdForReview() { return String((typeof getActiveSession === 'function' ? getActiveSession()?.id : '') || '').trim(); }
    function getArtifactReviewWindowWidth() { return typeof window !== 'undefined' ? window.innerWidth : 0; }
    // The APPLIED maximum (90% of the window) — the same bound in both flag
    // states, so drag/keyboard writes and the resolved layout width agree.
    function getResolvedArtifactReviewMaxWidth() { return resolveArtifactReviewMaxWidth(getArtifactReviewWindowWidth()); }
    function getEffectiveArtifactReviewWidth(prefs) {
      return resolveEffectiveArtifactReviewWidth(prefs, getActiveSessionIdForReview(), { flagOn: isArtifactPanelV2Enabled(), windowWidth: getArtifactReviewWindowWidth() });
    }
    // V2 (artifact_panel_v2): width writes go to widthBySession[activeSession]; the legacy global `width` stays the fallback seed. Flag-off writes the global width (byte-identical).
    // Drag-time clamp: bound the WRITE by the resolved 90% max so persistence
    // never drifts above what the window can actually show (the static clamp
    // inside recordArtifactReviewWidth is only the sanity ceiling now).
    function applyArtifactReviewWidth(prefs, nextWidth) {
      const numeric = Number(nextWidth);
      const bounded = Number.isFinite(numeric)
        ? Math.max(ARTIFACT_REVIEW_MIN_WIDTH, Math.min(getResolvedArtifactReviewMaxWidth(), Math.round(numeric)))
        : nextWidth;
      recordArtifactReviewWidth(prefs, getActiveSessionIdForReview(), bounded, { flagOn: isArtifactPanelV2Enabled() });
    }
    function isArtifactReviewMaximized() {
      return resolveArtifactReviewMaximized?.(getArtifactReviewState(), getActiveSessionIdForReview(), { flagOn: isArtifactPanelV3Enabled() }) === true;
    }
    function toggleArtifactReviewMaximized(nextValue) {
      if (!isArtifactPanelV3Enabled() || !getActiveSessionIdForReview()) return false;
      const prefs = getArtifactReviewState();
      const next = typeof nextValue === 'boolean' ? nextValue : !isArtifactReviewMaximized();
      recordArtifactReviewMaximized?.(prefs, getActiveSessionIdForReview(), next, { flagOn: isArtifactPanelV3Enabled() });
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout();
      panelV2?.afterRender?.(getSelectedArtifact());
      return isArtifactReviewMaximized();
    }

    function setArtifactRailMode(nextMode) {
      const prefs = ensureArtifactReviewState();
      prefs.mode = normalizeArtifactReviewMode(nextMode);
      return prefs.mode;
    }

    function loadArtifactReviewPreferences() {
      return artifactReviewPrefs.loadArtifactReviewPreferences(typeof window !== 'undefined' ? window : null, ARTIFACT_REVIEW_STORAGE_KEY);
    }

    function ensureArtifactReviewState() {
      const existing = state.ui?.artifactReview && typeof state.ui.artifactReview === 'object'
        ? state.ui.artifactReview
        : {};
      if (!artifactReviewStateLoaded) {
        state.ui.artifactReview = normalizeArtifactReviewPreferences({
          width: existing.width,
          ...existing,
          ...loadArtifactReviewPreferences(),
        });
        artifactReviewStateLoaded = true;
        return state.ui.artifactReview;
      }
      state.ui.artifactReview = normalizeArtifactReviewPreferences(existing);
      return state.ui.artifactReview;
    }

    function saveArtifactReviewPreferences() {
      artifactReviewPrefs.saveArtifactReviewPreferences(typeof window !== 'undefined' ? window : null, ARTIFACT_REVIEW_STORAGE_KEY, ensureArtifactReviewState());
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
        const prefs = getArtifactReviewState();
        prefs.collapsed = true;
        // WS3 sticky dismiss: collapsing the panel counts as a dismissal so
        // auto-open never re-pops it (collapse-then-generate stays collapsed).
        prefs.userDismissed = true;
        saveArtifactReviewPreferences();
        syncArtifactReviewLayout({ refreshChatChrome: true });
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


    function selectNewestArtifactForAutoOpen() {
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      if (!activeSession) return '';
      const artifacts = getArtifactsForSession(activeSession.id);
      if (!artifacts.length) return '';
      const newest = sortArtifactsNewestFirst(artifacts)[0];
      if (!newest) return '';
      if (state.artifacts.selectedArtifactId !== newest.id || state.artifacts.selectedSessionId !== activeSession.id) {
        applyArtifactSelection(newest);
      }
      return newest.id;
    }

    function ensureArtifactReviewAutoOpen() {
      if (artifactReviewAutoOpenController || typeof artifactReviewAutoopenModule?.createArtifactReviewAutoOpen !== 'function') {
        return artifactReviewAutoOpenController;
      }
      artifactReviewAutoOpenController = artifactReviewAutoopenModule.createArtifactReviewAutoOpen({
        getActiveSessionId: () => String((typeof getActiveSession === 'function' ? getActiveSession()?.id : '') || ''),
        getArtifactReviewState,
        saveArtifactReviewPreferences,
        isArtifactReviewEligible,
        getArtifactCount: () => {
          const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
          return activeSession ? getArtifactsForSession(activeSession.id).length : 0;
        },
        getAutoOpenedSessionIds: () => (Array.isArray(state.artifacts.autoOpenedSessionIds) ? state.artifacts.autoOpenedSessionIds : []),
        setAutoOpenedSessionIds: (ids) => { state.artifacts.autoOpenedSessionIds = Array.isArray(ids) ? ids : []; },
        selectNewestArtifact: selectNewestArtifactForAutoOpen,
        appendClientLog: (...args) => appendClientLog?.(...args),
      });
      return artifactReviewAutoOpenController;
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
      renderSelectedArtifactDetail(surfaces.split, artifact);
      panelV2?.afterRender?.(artifact);
    }

    function renderArtifactReviewPanel() {
      // A session switch closes the file-preview rail: the preview belongs to
      // the conversation it was opened from, and surviving into an unrelated
      // session reads as a stuck panel (owner report 2026-08-20). First render
      // (no prior session) never resets; code_review keeps its own semantics.
      const renderSessionId = String(state.currentSessionId || '').trim();
      if (renderSessionId !== lastRenderedArtifactSessionId) {
        const hadSession = lastRenderedArtifactSessionId !== '';
        lastRenderedArtifactSessionId = renderSessionId;
        if (hadSession && normalizeArtifactReviewMode(getArtifactReviewState().mode) === 'file_preview') {
          getArtifactReviewState().mode = 'artifact';
          if (typeof resetFilePreview === 'function') resetFilePreview();
        }
      }
      // WS3 auto-open hook: artifacts are render-time-derived (no stream
      // artifact event), so the per-render pass is the only trigger point.
      // Runs BEFORE layout sync so an auto-open takes effect this pass.
      ensureArtifactReviewAutoOpen()?.maybeAutoOpen();
      syncArtifactReviewLayout();
      if (!artifactReviewPanel || !isArtifactReviewVisible()) return;
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      if (!activeSession) {
        renderSplitDetail(null);
        return;
      }
      const artifacts = getArtifactsForSession(activeSession.id);
      if (!artifacts.length) {
        clearSelection();
        renderSplitDetail(null);
        updateArtifactReviewStatusText();
        return;
      }
      ensureSelectionForArtifacts(artifacts);
      renderSplitDetail(getSelectedArtifact());
      updateArtifactReviewStatusText();
    }

    async function openArtifactTarget(artifactId, options) {
      const normalizedArtifactId = String(artifactId || '').trim();
      // `source` tags where the open came from ('transcript-studio' — legacy
      // alias, 'inline-open-panel', …) for observability. Manual opens never
      // trigger the auto-open blink.
      const source = String(options?.source || '').trim();
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      if (!activeSession) return false;
      if (source) {
        appendClientLog?.('INFO', 'artifacts.open_target', { source, artifactId: normalizedArtifactId });
      }
      const artifacts = getArtifactsForSession(activeSession.id);
      if (normalizedArtifactId) {
        selectArtifact(normalizedArtifactId);
      } else if (artifacts.length) {
        ensureSelectionForArtifacts(artifacts);
      }
      const prefs = getArtifactReviewState();
      // Flip rail back to artifact mode if it was in code_review mode — keeps
      // the acceptance "artifact review and code review do not overwrite each
      // other's state unexpectedly" honest. codeReviewState persists in
      // state.ui.codeReview so the user can re-open it later.
      // Any non-artifact rail mode (code_review, file_preview) yields to an
      // explicit artifact open; each mode keeps its own renderer-local state
      // (state.ui.codeReview / state.ui.filePreview) for a later re-open.
      if (prefs.mode !== 'artifact') {
        prefs.mode = 'artifact';
      }
      // Studio removed (cohesiveness QoL W1-5): the review panel is the only
      // in-app artifact surface, so every explicit open is an explicit
      // re-enable (the WS3 'inline-open-panel' re-entry semantics, now for
      // every verb). Eligibility requires the chat view, so opens from other
      // views switch to chat first; narrow stages get the overlay drawer via
      // syncArtifactReviewLayout instead of losing artifact access.
      prefs.enabled = true;
      prefs.collapsed = false;
      prefs.userDismissed = false;
      if (state.ui?.activeView !== 'chat') {
        setActiveView('chat');
      }
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout();
      renderArtifactReviewPanel();
      return true;
    }

    // Shared open path for the non-artifact rail modes: everything
    // openArtifactTarget does EXCEPT selecting an artifact. Callers (the file
    // preview owner today) hand it a mode; eligibility still requires the chat
    // view, and narrow stages get the overlay drawer via the layout sync.
    function openArtifactRail(mode) {
      const prefs = getArtifactReviewState();
      prefs.mode = normalizeArtifactReviewMode(mode);
      prefs.enabled = true;
      prefs.collapsed = false;
      prefs.userDismissed = false;
      if (state.ui?.activeView !== 'chat') {
        setActiveView('chat');
      }
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout();
      return prefs.mode;
    }

    function toggleArtifactReview() {
      const prefs = getArtifactReviewState();
      if (prefs.enabled && prefs.collapsed) {
        prefs.collapsed = false;
        prefs.userDismissed = false;
      } else if (prefs.enabled) {
        prefs.enabled = false;
        prefs.collapsed = false;
        prefs.userDismissed = true;
      } else {
        prefs.enabled = true;
        prefs.collapsed = false;
        prefs.userDismissed = false;
        const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
        if (activeSession) {
          const artifacts = getArtifactsForSession(activeSession.id);
          if (artifacts.length) ensureSelectionForArtifacts(artifacts);
        }
      }
      prefs.width = clampArtifactReviewWidth(prefs.width);
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout({ refreshChatChrome: true });
      renderArtifactReviewPanel();
    }

    function finishArtifactReviewResize(event) {
      if (artifactReviewRuntime.pointerId !== event.pointerId) return;
      artifactReviewResizer.classList.remove('dragging');
      artifactReviewResizer.releasePointerCapture(event.pointerId);
      artifactReviewRuntime.pointerId = null;
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout({ refreshChatChrome: true });
    }

    function handleArtifactReviewResizeMove(event) {
      if (artifactReviewRuntime.pointerId !== event.pointerId) return;
      const delta = artifactReviewRuntime.startX - event.clientX;
      applyArtifactReviewWidth(getArtifactReviewState(), artifactReviewRuntime.startWidth + delta);
      syncArtifactReviewLayout();
    }

    function handleArtifactReviewResizeStart(event) {
      if (!isArtifactReviewVisible()) return;
      event.preventDefault();
      artifactReviewRuntime.pointerId = event.pointerId;
      artifactReviewRuntime.startX = event.clientX;
      artifactReviewRuntime.startWidth = getEffectiveArtifactReviewWidth(getArtifactReviewState());
      artifactReviewResizer.classList.add('dragging');
      artifactReviewResizer.setPointerCapture(event.pointerId);
    }

    function handleArtifactReviewResizeKeydown(event) {
      if (!isArtifactReviewVisible()) return;
      const prefs = getArtifactReviewState();
      // Keyboard steps use the V2-aware helpers: flag-on steps the effective per-session width; Home lands on the default width and End on the resolved 90%-of-window max (both flag states).
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        applyArtifactReviewWidth(prefs, getEffectiveArtifactReviewWidth(prefs) + ARTIFACT_REVIEW_KEYBOARD_STEP);
        syncArtifactReviewLayout();
        saveArtifactReviewPreferences();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        applyArtifactReviewWidth(prefs, getEffectiveArtifactReviewWidth(prefs) - ARTIFACT_REVIEW_KEYBOARD_STEP);
        syncArtifactReviewLayout();
        saveArtifactReviewPreferences();
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        applyArtifactReviewWidth(prefs, ARTIFACT_REVIEW_DEFAULT_WIDTH);
        syncArtifactReviewLayout();
        saveArtifactReviewPreferences();
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        applyArtifactReviewWidth(prefs, getResolvedArtifactReviewMaxWidth());
        syncArtifactReviewLayout();
        saveArtifactReviewPreferences();
      }
    }

    function bind() {
      // W1-5: no artifactsView gate — the studio DOM is gone and the split
      // review panel's listeners must attach regardless.
      if (bound) return;
      bound = true;
      syncArtifactReviewLayout();
      artifactReviewPanel?.addEventListener('error', handleImagePreviewError, true);
      artifactReviewPanel?.addEventListener('keydown', handleArtifactPanelKeydown);
      artifactReviewScrollContainer?.addEventListener('scroll', handleArtifactDocumentScroll);
      artifactReviewCollapseButton?.addEventListener('click', handleArtifactReviewClick);
      artifactReviewSaveButton?.addEventListener('click', handleArtifactReviewClick);
      artifactReviewRevertButton?.addEventListener('click', handleArtifactReviewClick);
      artifactReviewRevealButton?.addEventListener('click', handleArtifactReviewClick);
      artifactReviewOpenExternalButton?.addEventListener('click', handleArtifactReviewClick);
      artifactReviewJumpButton?.addEventListener('click', handleArtifactReviewClick);
      artifactReviewDeleteButton?.addEventListener('click', handleArtifactReviewClick);
      artifactReviewPreviewContent?.addEventListener('click', handleArtifactReviewClick);
      artifactReviewPreviewContent?.addEventListener('keydown', handleArtifactReviewKeydown);
      artifactSplitViewToggle?.addEventListener('click', toggleArtifactReview);
      artifactReviewResizer?.addEventListener('pointerdown', handleArtifactReviewResizeStart);
      artifactReviewResizer?.addEventListener('pointermove', handleArtifactReviewResizeMove);
      artifactReviewResizer?.addEventListener('pointerup', finishArtifactReviewResize);
      artifactReviewResizer?.addEventListener('pointercancel', finishArtifactReviewResize);
      artifactReviewResizer?.addEventListener('keydown', handleArtifactReviewResizeKeydown);
      deleteConfirmController?.bind?.();
    }

    function handleArtifactReviewKeydown(event) {
      handleArtifactDocumentKeydown(event, 'split');
    }
    function handleArtifactPanelKeydown(event) {
      if (event.key !== 'Escape' || !isArtifactReviewMaximized()) return;
      event.preventDefault();
      toggleArtifactReviewMaximized(false);
    }

    function dispose() {
      clearSourceHighlight();
      if (!bound) return;
      bound = false;
      artifactReviewPanel?.removeEventListener('error', handleImagePreviewError, true);
      artifactReviewPanel?.removeEventListener('keydown', handleArtifactPanelKeydown);
      artifactReviewScrollContainer?.removeEventListener('scroll', handleArtifactDocumentScroll);
      artifactReviewCollapseButton?.removeEventListener('click', handleArtifactReviewClick);
      artifactReviewSaveButton?.removeEventListener('click', handleArtifactReviewClick);
      artifactReviewRevertButton?.removeEventListener('click', handleArtifactReviewClick);
      artifactReviewRevealButton?.removeEventListener('click', handleArtifactReviewClick);
      artifactReviewOpenExternalButton?.removeEventListener('click', handleArtifactReviewClick);
      artifactReviewJumpButton?.removeEventListener('click', handleArtifactReviewClick);
      artifactReviewDeleteButton?.removeEventListener('click', handleArtifactReviewClick);
      artifactReviewPreviewContent?.removeEventListener('click', handleArtifactReviewClick);
      artifactReviewPreviewContent?.removeEventListener('keydown', handleArtifactReviewKeydown);
      artifactSplitViewToggle?.removeEventListener('click', toggleArtifactReview);
      artifactReviewResizer?.removeEventListener('pointerdown', handleArtifactReviewResizeStart);
      artifactReviewResizer?.removeEventListener('pointermove', handleArtifactReviewResizeMove);
      artifactReviewResizer?.removeEventListener('pointerup', finishArtifactReviewResize);
      artifactReviewResizer?.removeEventListener('pointercancel', finishArtifactReviewResize);
      artifactReviewResizer?.removeEventListener('keydown', handleArtifactReviewResizeKeydown);
      artifactReviewAutoOpenController?.dispose?.();
      artifactReviewAutoOpenController = null;
      deleteConfirmController?.dispose?.();
      disposeSurfaceController();
    }

    return { bind, dispose, buildArtifactsFromMessages: (messages, options) => buildArtifactsFromMessages(messages, options), clearSourceHighlight, filterArtifacts: (artifacts, filterValue) => filterArtifacts(artifacts, filterValue), getArtifactsForSession, getSelectedArtifactSource, invalidateSessionArtifacts, isArtifactReviewVisible, isArtifactReviewMaximized, jumpToArtifactSource, normalizeArtifactFilter, openArtifactTarget, openArtifactRail, pruneSessionArtifacts, rekeySessionArtifacts, renderArtifactReviewPanel, resetArtifactsState, selectArtifact, syncArtifactReviewLayout, setArtifactRailMode, toggleArtifactReview, toggleArtifactReviewMaximized, setArtifactDocumentViewMode, getArtifactDocumentViewMode, setArtifactViewMode, getArtifactViewMode, copyArtifactDocumentCodeBlock, copySelectedArtifactSource };
  }

  return { GENERATED_FILE_FILTER, IMAGE_FILTER, TOOL_OUTPUT_FILTER, buildArtifactsFromMessages, clipPreviewText, createArtifactManager, filterArtifacts, normalizeArtifactFilter, sortArtifactsNewestFirst };
});
