(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactsSurfaceController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function resolveRendererModule(globalName, modulePath) {
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) {
      return globalThis[globalName];
    }
    if (typeof require === 'function') {
      try { return require(modulePath); } catch (_error) { /* not available */ }
    }
    return null;
  }
  const rendererRegistryModule = resolveRendererModule('rendererArtifactsRendererRegistry', './renderer-artifacts-renderer-registry');
  const mermaidKindModule = resolveRendererModule('rendererArtifactsRenderMermaid', './renderer-artifacts-render-mermaid');
  const markdownKindModule = resolveRendererModule('rendererArtifactsRenderMarkdown', './renderer-artifacts-render-markdown');
  const codeKindModule = resolveRendererModule('rendererArtifactsRenderCode', './renderer-artifacts-render-code');
  const imageKindModule = resolveRendererModule('rendererArtifactsRenderImage', './renderer-artifacts-render-image');
  const textKindModule = resolveRendererModule('rendererArtifactsRenderText', './renderer-artifacts-render-text');
  const webKindModule = resolveRendererModule('rendererArtifactsRenderWeb', './renderer-artifacts-render-web');
  const chartKindModule = resolveRendererModule('rendererArtifactsRenderChart', './renderer-artifacts-render-chart');
  const operationTargetModule = resolveRendererModule('rendererArtifactOperationTarget', './renderer-artifact-operation-target');
  const draftStoreModule = resolveRendererModule('rendererArtifactDraftStore', './renderer-artifact-draft-store');
  const asyncOpsModule = resolveRendererModule('rendererArtifactAsyncOps', './renderer-artifact-async-ops');

  function createArtifactSurfaceController(deps = {}) {
    const noop = () => {};
    const {
      state: inputState,
      surfaces = {},
      artifactReviewScrollContainer = null,
      artifactRender = {},
      renderMermaidPreviewIntoHost = () => false,
      escapeHtml = (value) => String(value ?? ''),
      appendClientLog = null,
      showToastMessage = null,
      toErrorMessage = null,
      getSelectedArtifact = () => null,
      getArtifactByTarget = null,
      getArtifactReviewState = () => ({}),
      normalizeArtifactReviewMode = (value) => (String(value || '').trim().toLowerCase() === 'code_review' ? 'code_review' : 'artifact'),
      renderCodeReviewSurface = null,
      renderArtifactsPanel = noop,
      renderArtifactReviewPanel = noop,
      // UIUX-025: cheap per-keystroke chrome sync (footer meta, save/revert
      // visibility) — safe to call on every edit, unlike renderArtifactsPanel
      // / renderArtifactReviewPanel which rebuild the catalog + full detail.
      panelV2 = null,
      invalidateSessionArtifacts = noop,
      clearSelection = noop,
      isGeneratedFile = (artifact) => artifact?.artifactType === 'generated_file',
      isImageArtifact = (artifact) => artifact?.artifactType === 'image',
      isMarkdownGeneratedArtifact = () => false,
      isMermaidGeneratedArtifact = () => false,
      isHtmlGeneratedArtifact = () => false,
      isSvgGeneratedArtifact = () => false,
      isChartGeneratedArtifact = () => false,
      extractMermaidSourceFromToolArtifact = () => '',
      prettyPrintJson = (text) => String(text || ''),
      formatArtifactTimestamp = (value) => String(value || ''),
      formatArtifactStatus = (value) => String(value || ''),
      formatLanguageLabel = (value) => String(value || ''),
    } = deps || {};
    const state = inputState && typeof inputState === 'object' ? inputState : { artifacts: {} };
    if (!state.artifacts || typeof state.artifacts !== 'object') state.artifacts = {};
    const failedImageArtifactKeys = new Set();
    const loadedImageArtifactDataUrls = new Map();
    const loadingImageArtifactDataKeys = new Set();
    const MAX_IMAGE_ARTIFACT_DATA_URL_ENTRIES = 8;
    const MAX_IMAGE_ARTIFACT_DATA_URL_CHARS = 32 * 1024 * 1024;
    const artifactOperationTarget = operationTargetModule.createArtifactOperationTarget({ state });
    const artifactDraftStore = draftStoreModule.createArtifactDraftStore();
    const editorState = {
      full: { editor: null, dispose: null },
      split: { editor: null, dispose: null },
    };
    const documentViewModeBySurface = { full: 'read', split: 'read' };

    const renderDetailMeta = (items, stacked) => (artifactRender.renderDetailMeta || (() => ''))(items, stacked, escapeHtml);
    const renderProvenanceTimeline = (target, artifact) => (artifactRender.renderProvenanceTimeline || (() => {}))(target, artifact, {
      escapeHtml,
      formatArtifactTimestamp,
      isGeneratedFile,
      isImageArtifact,
      formatLanguageLabel,
    });
    const setDetailNote = (surface, text, isError) => (artifactRender.setDetailNote || (() => {}))(surface, text, isError);
    const renderMermaidGeneratedArtifact = (surface, artifact, file, editable) => (artifactRender.renderMermaidGeneratedArtifact || (() => {}))(surface, artifact, file, editable, {
      state,
      escapeHtml,
      ensureEditor,
      getPreferredEditorValue,
      renderMermaidPreviewIntoHost,
      setDetailNote,
    });
    const buildMarkdownArtifactDocumentHtml = (input) => (artifactRender.buildMarkdownArtifactDocumentHtml || (() => ''))(input, {
      escapeHtml,
      renderMarkdown: typeof window !== 'undefined' ? window.markdownUtils?.renderMarkdown : null,
      onRenderError: (error) => {
        appendClientLog?.('WARN', 'artifacts.markdown_render_failed', {
          message: String(error?.message || error || 'Markdown render failed.'),
        });
      },
    });
    const decorateMarkdownArtifactDocument = (container) => (artifactRender.decorateMarkdownArtifactDocument || (() => {}))(container, {
      documentRef: typeof document !== 'undefined' ? document : null,
    });
    const readArtifactDocumentCodeBlockText = (button) => (artifactRender.readArtifactDocumentCodeBlockText || (() => ''))(button);
    const buildMarkdownArtifactDocumentSignature = (input) => {
      if (typeof artifactRender.buildMarkdownArtifactDocumentSignature === 'function') {
        return artifactRender.buildMarkdownArtifactDocumentSignature(input);
      }
      return JSON.stringify(input || {});
    };
    const setArtifactDocumentActiveOutlineItem = (documentNode, activeId) => {
      if (typeof artifactRender.setActiveOutlineItem === 'function') {
        artifactRender.setActiveOutlineItem(documentNode, activeId);
      }
    };
    function getArtifactDocumentRevision() {
      const value = Number(state.artifacts.artifactDocumentRevision);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    }
    function bumpArtifactDocumentRevision() {
      const nextRevision = getArtifactDocumentRevision() + 1;
      state.artifacts.artifactDocumentRevision = nextRevision;
      return nextRevision;
    }
    function resetLoadedState() {
      state.artifacts.loadedArtifactId = '';
      state.artifacts.loadedArtifactContent = '';
      state.artifacts.dirtyContent = '';
      bumpArtifactDocumentRevision();
      state.artifacts.lastError = '';
      state.artifacts.mermaidViewMode = 'preview';
      state.artifacts.viewModeByKind = {};
      documentViewModeBySurface.full = 'read';
      documentViewModeBySurface.split = 'read';
    }
    // UIUX-025: a keystroke used to trigger renderArtifactsPanel() (full
    // catalog innerHTML rebuild, cost grows with artifact count) AND
    // renderArtifactReviewPanel()/renderSelectedArtifactDetail() (full
    // markdown/mermaid preview rebuild) on every character. Now a keystroke
    // only patches the dirty/save/revert chrome in place; the heavier detail
    // re-render (which the preview + editor.setDocument round trip needs) is
    // debounced so it runs once after typing pauses. The catalog is never
    // touched from here — it only re-renders on list/filter/selection change
    // (the other renderArtifactsPanel() call sites in this file).
    const PREVIEW_REFRESH_DEBOUNCE_MS = 220;
    let previewRefreshTimer = null;
    function cancelScheduledPreviewRefresh() {
      if (previewRefreshTimer) {
        clearTimeout(previewRefreshTimer);
        previewRefreshTimer = null;
      }
    }
    function computeArtifactDirtyChrome(artifact) {
      const isGenerated = isGeneratedFile(artifact);
      const file = artifact?.generatedFile || null;
      const editable = isGenerated && file?.editable === true && artifact?.status !== 'missing';
      const dirty = isGenerated
        && state.artifacts.loadedArtifactId === file?.artifactId
        && state.artifacts.dirtyContent !== state.artifacts.loadedArtifactContent;
      return { isGenerated, editable, dirty };
    }
    function patchArtifactDirtyChrome(surface, chrome) {
      if (!surface) return;
      const { isGenerated, editable, dirty } = chrome;
      if (surface.dirtyBadge) surface.dirtyBadge.classList.toggle('hidden', !dirty);
      if (surface.saveButton) surface.saveButton.disabled = !editable || !dirty || state.artifacts.loading || state.artifacts.savePending;
      if (surface.revertButton) surface.revertButton.disabled = !isGenerated || state.artifacts.loading || state.artifacts.savePending || (!dirty && !state.artifacts.lastError);
    }
    function patchDirtyStateInPlace() {
      const artifact = getSelectedArtifact();
      const chrome = computeArtifactDirtyChrome(artifact);
      patchArtifactDirtyChrome(surfaces.full, chrome);
      patchArtifactDirtyChrome(surfaces.split, chrome);
      panelV2?.afterRender?.(artifact);
    }
    function schedulePreviewRefresh() {
      cancelScheduledPreviewRefresh();
      previewRefreshTimer = setTimeout(() => {
        previewRefreshTimer = null;
        const artifact = getSelectedArtifact();
        renderSelectedArtifactDetail(surfaces.full, artifact);
        renderSelectedArtifactDetail(surfaces.split, artifact);
        panelV2?.afterRender?.(artifact);
      }, PREVIEW_REFRESH_DEBOUNCE_MS);
    }
    function getEditorState(key = 'full') { return editorState[String(key || 'full').trim()] || editorState.full; }
    function getEditorSurface(key = 'full') { return surfaces[String(key || 'full').trim()] || surfaces.full; }
    function getExistingEditor(key = 'full') { return getEditorState(key).editor || null; }
    function ensureEditor(key = 'full') {
      const slot = getEditorState(key);
      if (slot.editor) return slot.editor;
      const surface = getEditorSurface(key);
      if (!surface) return null; // W1-5: the 'full' (studio) surface is null now
      slot.editor = window.rendererMonacoEditorUtils?.createArtifactEditor?.({
        host: surface.editorHost,
        fallbackTextarea: surface.editorFallback,
        log: appendClientLog,
      }) || null;
      if (slot.editor && !slot.dispose) {
        slot.dispose = slot.editor.onDidChange((value) => {
          if (!isGeneratedFile(getSelectedArtifact())) return;
          const nextValue = String(value || '');
          if (state.artifacts.dirtyContent === nextValue) return;
          state.artifacts.dirtyContent = nextValue;
          bumpArtifactDocumentRevision();
          patchDirtyStateInPlace();
          schedulePreviewRefresh();
        });
      }
      return slot.editor;
    }
    function disposeEditors() {
      for (const slot of Object.values(editorState)) {
        try { slot.dispose?.(); } catch (_) { /* ignore */ }
        slot.dispose = null;
        slot.editor?.dispose?.();
        slot.editor = null;
      }
    }
    function getPreferredEditorValue() {
      if (state.artifacts.dirtyContent !== state.artifacts.loadedArtifactContent) return state.artifacts.dirtyContent || '';
      return getExistingEditor('split')?.getValue() || getExistingEditor('full')?.getValue() || state.artifacts.dirtyContent || '';
    }
    function normalizeArtifactDocumentViewMode(nextMode) {
      return String(nextMode || '').trim().toLowerCase() === 'source' ? 'source' : 'read';
    }
    function getArtifactDocumentViewMode(surfaceKey) {
      const key = String(surfaceKey || 'full').trim() === 'split' ? 'split' : 'full';
      return normalizeArtifactDocumentViewMode(documentViewModeBySurface[key]);
    }
    function setArtifactDocumentViewMode(surfaceKey, nextMode) {
      const artifact = getSelectedArtifact();
      if (!isMarkdownGeneratedArtifact(artifact)) return;
      const key = String(surfaceKey || 'full').trim() === 'split' ? 'split' : 'full';
      const normalized = normalizeArtifactDocumentViewMode(nextMode);
      if (documentViewModeBySurface[key] === normalized) return;
      documentViewModeBySurface[key] = normalized;
      renderArtifactsPanel();
      renderArtifactReviewPanel();
    }
    function escapeSelectorValue(value) {
      if (typeof window !== 'undefined' && window.CSS?.escape) return window.CSS.escape(String(value || ''));
      return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
    function getArtifactDocumentNode(surface) {
      return surface?.previewContent?.querySelector?.('.artifact-document') || null;
    }
    function getArtifactDocumentScrollContainer(surface) {
      if (!surface) return null;
      if (surface.key === 'split') {
        return artifactReviewScrollContainer
          || surface.previewContent?.closest?.('.artifact-review-scroll')
          || surface.previewContent
          || null;
      }
      return surface.detailPanel
        || surface.previewContent?.closest?.('.artifacts-detail-panel')
        || surface.previewContent
        || null;
    }
    function clampPercent(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return 0;
      return Math.max(0, Math.min(100, numeric));
    }
    function setScrollContainerTop(container, top) {
      if (!container) return;
      const nextTop = Math.max(Number(top) || 0, 0);
      if (typeof container.scrollTo === 'function') {
        try {
          container.scrollTo({ top: nextTop, behavior: 'auto' });
          return;
        } catch (_error) {
          /* fall through to direct assignment */
        }
      }
      container.scrollTop = nextTop;
    }
    function getHeadingScrollTop(container, heading) {
      const offsetTop = Number(heading?.offsetTop || 0);
      if (offsetTop > 0) return Math.max(offsetTop - 16, 0);
      const containerRect = container?.getBoundingClientRect?.();
      const headingRect = heading?.getBoundingClientRect?.();
      if (containerRect && headingRect) {
        return Math.max(Number(container.scrollTop || 0) + headingRect.top - containerRect.top - 16, 0);
      }
      return Number(container?.scrollTop || 0);
    }
    function findArtifactDocumentHeading(documentNode, targetId) {
      const normalized = String(targetId || '').trim();
      if (!documentNode || !normalized) return null;
      return Array.from(documentNode.querySelectorAll('[data-artifact-document-heading]'))
        .find((heading) => heading.id === normalized) || null;
    }
    function updateArtifactDocumentProgress(surface, activeId = '') {
      const documentNode = getArtifactDocumentNode(surface);
      const container = getArtifactDocumentScrollContainer(surface);
      if (!documentNode || !container) return;
      const progress = documentNode.querySelector('[data-artifact-document-progress]');
      const progressBar = documentNode.querySelector('[data-artifact-document-progress-bar]');
      const maxScroll = Math.max(Number(container.scrollHeight || 0) - Number(container.clientHeight || 0), 0);
      const percent = maxScroll > 0 ? clampPercent((Number(container.scrollTop || 0) / maxScroll) * 100) : 0;
      if (progress) {
        progress.setAttribute('aria-valuenow', String(Math.round(percent)));
        progress.dataset.artifactDocumentProgress = String(Math.round(percent));
      }
      if (progressBar) {
        progressBar.style.width = `${percent.toFixed(1)}%`;
      }
      if (activeId) {
        setArtifactDocumentActiveOutlineItem(documentNode, activeId);
      }
    }
    function updateArtifactDocumentActiveSection(surface) {
      const documentNode = getArtifactDocumentNode(surface);
      const container = getArtifactDocumentScrollContainer(surface);
      if (!documentNode || !container) return;
      const headings = Array.from(documentNode.querySelectorAll('[data-artifact-document-heading]'));
      if (!headings.length) return;
      const currentTop = Number(container.scrollTop || 0) + 24;
      let activeId = headings[0].id;
      for (const heading of headings) {
        const headingTop = Number(heading.offsetTop || 0);
        if (headingTop <= currentTop) {
          activeId = heading.id;
        }
      }
      updateArtifactDocumentProgress(surface, activeId);
    }
    function scrollArtifactDocumentToTarget(surface, targetId) {
      const documentNode = getArtifactDocumentNode(surface);
      const container = getArtifactDocumentScrollContainer(surface);
      const heading = findArtifactDocumentHeading(documentNode, targetId);
      if (!documentNode || !container || !heading) return false;
      setScrollContainerTop(container, getHeadingScrollTop(container, heading));
      updateArtifactDocumentProgress(surface, heading.id);
      return true;
    }
    function scrollArtifactDocumentToTop(surface) {
      const documentNode = getArtifactDocumentNode(surface);
      const container = getArtifactDocumentScrollContainer(surface);
      if (!documentNode || !container) return false;
      setScrollContainerTop(container, 0);
      const firstHeading = documentNode.querySelector('[data-artifact-document-heading]');
      updateArtifactDocumentProgress(surface, firstHeading?.id || '');
      return true;
    }
    function handleArtifactDocumentAction(event, surfaceKey) {
      const surface = getEditorSurface(surfaceKey);
      const outlineButton = event.target.closest?.('[data-artifact-document-outline-target]');
      if (outlineButton) {
        event.preventDefault();
        return scrollArtifactDocumentToTarget(surface, outlineButton.dataset.artifactDocumentOutlineTarget);
      }
      const backToTopButton = event.target.closest?.('[data-artifact-document-back-to-top]');
      if (backToTopButton) {
        event.preventDefault();
        return scrollArtifactDocumentToTop(surface);
      }
      return false;
    }
    function handleArtifactDocumentKeydown(event, surfaceKey) {
      const key = String(event.key || '');
      if (key !== 'Enter' && key !== ' ') return false;
      const target = event.target.closest?.('[data-artifact-document-outline-target], [data-artifact-document-back-to-top]');
      if (!target) return false;
      event.preventDefault();
      return handleArtifactDocumentAction(event, surfaceKey);
    }
    function handleArtifactDocumentScroll(event) {
      if (surfaces.full && event.currentTarget === surfaces.full.detailPanel) {
        updateArtifactDocumentActiveSection(surfaces.full);
        return;
      }
      if (event.currentTarget === artifactReviewScrollContainer) {
        updateArtifactDocumentActiveSection(surfaces.split);
      }
    }
    function isLocalArtifactAssetPath(raw) {
      const normalized = String(raw || '').trim();
      if (!normalized) return false;
      if (/^\\\\/.test(normalized)) return false;
      if (/^\/\//.test(normalized)) return false;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized) && !/^[a-zA-Z]:[\\/]/.test(normalized)) {
        return false;
      }
      if (/^[a-zA-Z]:[\\/]/.test(normalized)) return true;
      if (/^\//.test(normalized)) return true;
      return false;
    }
    function toFileAssetUrl(assetPath) {
      const normalized = String(assetPath || '').trim();
      if (!normalized) return '';
      if (!isLocalArtifactAssetPath(normalized)) return '';
      const absolutePath = normalized.replace(/\\/g, '/').replace(/^([^/])/, '/$1');
      const encodedPath = encodeURI(absolutePath)
        .replace(/#/g, '%23')
        .replace(/\?/g, '%3F')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
      return `file://${encodedPath}`;
    }
    function imageArtifactDataKey(artifact) {
      const sessionId = String(artifact?.sessionId || '').trim();
      const artifactId = String(artifact?.image?.artifactId || artifact?.id || '').trim();
      return sessionId && artifactId ? `${sessionId}:${artifactId}` : '';
    }
    function imageArtifactFailureKey(sessionId, artifactId) {
      const session = String(sessionId || '').trim();
      const artifact = String(artifactId || '').trim();
      return session && artifact ? `${session}:${artifact}` : '';
    }
    function isGeneratedImageArtifactReadRequired(artifact) {
      return isImageArtifact(artifact)
        && String(artifact?.sourceKind || '').trim() === 'generated_artifact'
        && (
          artifact?.image?.requiresArtifactRead === true
          || (
            !String(artifact?.image?.assetPath || '').trim()
            && String(artifact?.status || '').trim().toLowerCase() === 'available'
          )
        );
    }
    function resolveImagePreviewUrl(artifact) {
      const assetPath = String(artifact?.image?.assetPath || '').trim();
      if (assetPath) return toFileAssetUrl(assetPath);
      const dataKey = imageArtifactDataKey(artifact);
      return dataKey ? loadedImageArtifactDataUrls.get(dataKey) || '' : '';
    }
    function clearImageArtifactDataForSession(sessionId) {
      const key = String(sessionId || '').trim();
      if (!key) return;
      for (const dataKey of [...loadedImageArtifactDataUrls.keys()]) if (dataKey.startsWith(`${key}:`)) loadedImageArtifactDataUrls.delete(dataKey);
      for (const dataKey of [...loadingImageArtifactDataKeys]) if (dataKey.startsWith(`${key}:`)) loadingImageArtifactDataKeys.delete(dataKey);
      for (const failureKey of [...failedImageArtifactKeys]) if (failureKey.startsWith(`${key}:`)) failedImageArtifactKeys.delete(failureKey);
    }
    function pruneLoadedImageArtifactDataUrls() {
      let totalChars = 0;
      for (const value of loadedImageArtifactDataUrls.values()) totalChars += String(value || '').length;
      while (
        loadedImageArtifactDataUrls.size > MAX_IMAGE_ARTIFACT_DATA_URL_ENTRIES
        || totalChars > MAX_IMAGE_ARTIFACT_DATA_URL_CHARS
      ) {
        const oldest = loadedImageArtifactDataUrls.entries().next();
        if (oldest.done) break;
        const [key, value] = oldest.value;
        loadedImageArtifactDataUrls.delete(key);
        totalChars -= String(value || '').length;
      }
    }
    function formatError(error, fallback) {
      return typeof toErrorMessage === 'function'
        ? toErrorMessage(error)
        : String(error?.message || error || fallback || 'Unknown error.');
    }

    async function loadGeneratedImageArtifactAsset(artifact) {
      if (!isGeneratedImageArtifactReadRequired(artifact)) return;
      const dataKey = imageArtifactDataKey(artifact);
      const failureKey = imageArtifactFailureKey(artifact?.sessionId, artifact?.id);
      if (
        !dataKey
        || loadedImageArtifactDataUrls.has(dataKey)
        || loadingImageArtifactDataKeys.has(dataKey)
        || failedImageArtifactKeys.has(failureKey)
      ) return;
      const token = artifactOperationTarget.capture(artifact.sessionId, artifact.id);
      loadingImageArtifactDataKeys.add(dataKey);
      state.artifacts.loading = true;
      state.artifacts.lastError = '';
      renderArtifactsPanel();
      renderArtifactReviewPanel();
      try {
        const artifactId = String(artifact?.image?.artifactId || artifact?.id || '').trim();
        const payload = await window.jennyShell.artifacts.read(artifact.sessionId, artifactId);
        // isCurrent() is false for a disposed target, so it is the whole check.
        if (!artifactOperationTarget.isCurrent(token)) return;
        const dataUrl = String(payload?.asset_data_url || payload?.assetDataUrl || '').trim();
        if (/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/u.test(dataUrl)) {
          loadedImageArtifactDataUrls.set(dataKey, dataUrl);
          pruneLoadedImageArtifactDataUrls();
          failedImageArtifactKeys.delete(failureKey);
        } else {
          failedImageArtifactKeys.add(failureKey);
        }
      } catch (error) {
        if (!artifactOperationTarget.isCurrent(token)) return;
        failedImageArtifactKeys.add(failureKey);
        state.artifacts.lastError = formatError(error, 'Image artifact load failed.');
      } finally {
        loadingImageArtifactDataKeys.delete(dataKey);
        if (artifactOperationTarget.isCurrent(token)) {
          state.artifacts.loading = false;
          renderArtifactsPanel();
          renderArtifactReviewPanel();
        }
      }
    }
    // Markdown implementation relocated to renderer-artifacts-render-markdown.js
    // (WS2); this delegation keeps the legacy flag-off dispatch running the
    // identical code the registry path runs.
    function renderMarkdownGeneratedArtifact(surface, artifact, file, editable) {
      if (!markdownKindModule || typeof markdownKindModule.renderMarkdownGeneratedArtifact !== 'function') {
        return;
      }
      markdownKindModule.renderMarkdownGeneratedArtifact(surface, artifact, file, editable, rendererDeps);
    }
    // Tool-output mermaid (the legacy else-branch's mermaid case), kept
    // controller-local because it leans on renderMermaidPreviewIntoHost and
    // shared note/editor toggles; the registry mermaid kind receives it
    // through rendererDeps so both dispatch paths run this exact function.
    function renderMermaidToolOutputArtifact(surface, artifact) {
      setDetailNote(surface, 'Transcript-derived tool output. Read-only in the artifact panel.');
      surface.editorShell.classList.add('hidden');
      surface.previewContent.classList.remove('hidden');
      const mermaidSource = extractMermaidSourceFromToolArtifact(artifact);
      const hostId = `${surface.key}-artifact-mermaid-preview-${String(artifact.id || 'preview').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`;
      const sourceHtml = `<pre class="artifact-preview-pre artifact-preview-mermaid-source">${escapeHtml(mermaidSource)}</pre>`;
      if (getArtifactViewMode('mermaid') === 'edit') {
        surface.previewContent.innerHTML = sourceHtml;
        setDetailNote(surface, 'Viewing read-only Mermaid source.');
        return;
      }
      surface.previewContent.innerHTML = (
        `<div class="artifact-preview-mermaid-shell">`
        + `<div class="artifact-preview-mermaid-host" id="${escapeHtml(hostId)}">`
        + '<div class="artifacts-empty">Rendering Mermaid preview...</div>'
        + '</div>'
        + '</div>'
        + sourceHtml
      );
      const host = typeof document !== 'undefined' ? document.getElementById(hostId) : null;
      const previewStarted = renderMermaidPreviewIntoHost(
        host,
        mermaidSource,
        `artifact-mermaid-svg-${String(hostId || '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'preview'}`
      );
      if (!previewStarted) {
        surface.previewContent.innerHTML = (
          '<div class="artifacts-empty">Preview unavailable. Mermaid source is shown below.</div>'
          + sourceHtml
        );
      }
      setDetailNote(surface, 'Mermaid tool output with preview and source fallback.');
    }

    function writeDetailTitle(surface, value) {
      const liveTitle = surface?.root?.querySelector?.('#artifactReviewDetailTitle') || surface?.detailTitle || null;
      if (!liveTitle) return;
      surface.detailTitle = liveTitle;
      const textNode = liveTitle.querySelector?.('.artifact-panel-title-text') || liveTitle;
      textNode.textContent = String(value || '');
    }

    function renderSelectedArtifactDetail(surface, artifact) {
      // Any full detail render supersedes a pending debounced preview
      // refresh (UIUX-025) — firing it later would just redo this work.
      cancelScheduledPreviewRefresh();
      if (!surface) return;
      const prefs = getArtifactReviewState();
      const isCodeReviewSurface = surface.key === 'split' && normalizeArtifactReviewMode(prefs.mode) === 'code_review';
      if (isCodeReviewSurface && typeof renderCodeReviewSurface === 'function') {
        // Hide all artifact-mode chrome (action buttons stay rendered for tab
        // order stability — toggling .hidden via the same per-button loop the
        // artifact branch uses).
        surface.detailEmpty?.classList.add('hidden');
        surface.detailPanel?.classList.remove('hidden');
        if (surface.metaPane) surface.metaPane.classList.add('hidden');
        for (const btn of [surface.saveButton, surface.revertButton, surface.revealButton, surface.openExternalButton, surface.deleteButton]) {
          btn?.classList?.add('hidden');
        }
        if (surface.editorShell) surface.editorShell.classList.add('hidden');
        if (surface.previewContent) surface.previewContent.classList.add('hidden');
        if (surface.detailKicker) surface.detailKicker.textContent = '';
        writeDetailTitle(surface, '');
        if (surface.detailPath) surface.detailPath.textContent = '';
        if (surface.detailStatus) surface.detailStatus.textContent = '';
        if (surface.detailMeta) surface.detailMeta.innerHTML = '';
        if (surface.dirtyBadge) surface.dirtyBadge.classList.add('hidden');
        renderProvenanceTimeline(surface.provenanceTimeline, null);
        renderCodeReviewSurface(surface);
        return;
      }
      surface.detailEmpty?.classList.toggle('hidden', Boolean(artifact));
      surface.detailPanel?.classList.toggle('hidden', !artifact);
      if (surface.metaPane) surface.metaPane.classList.toggle('hidden', !artifact);
      if (!artifact) {
        if (surface.detailPanel?.dataset) {
          delete surface.detailPanel.dataset.artifactType;
          delete surface.detailPanel.dataset.detailMode;
        }
        renderProvenanceTimeline(surface.provenanceTimeline, null);
        return;
      }
      const isGenerated = isGeneratedFile(artifact);
      const isImage = isImageArtifact(artifact);
      const isMermaidGenerated = isGenerated && isMermaidGeneratedArtifact(artifact);
      const isMarkdownGenerated = isGenerated && isMarkdownGeneratedArtifact(artifact) && !isMermaidGenerated;
      const file = artifact.generatedFile || null;
      const editable = isGenerated && file?.editable === true && artifact.status !== 'missing';
      const dirty = isGenerated && state.artifacts.loadedArtifactId === file?.artifactId && state.artifacts.dirtyContent !== state.artifacts.loadedArtifactContent;
      if (surface.detailPanel?.dataset) {
        surface.detailPanel.dataset.artifactType = String(artifact.artifactType || 'artifact');
        surface.detailPanel.dataset.detailMode = isGenerated ? 'generated' : isImage ? 'image' : 'tool';
      }
      if (surface.dirtyBadge) surface.dirtyBadge.classList.toggle('hidden', !dirty);
      surface.detailKicker.textContent = isMermaidGenerated
        ? 'Mermaid Diagram'
        : isMarkdownGenerated
          ? 'Markdown Document'
          : isGenerated ? 'Generated File' : isImage ? 'Image' : 'Tool Output';
      writeDetailTitle(surface, artifact.title || 'Artifact');
      surface.detailPath.textContent = isGenerated ? String(file?.displayPath || file?.fileName || '').trim() : artifact.filePath || artifact.previewText || '';
      surface.detailStatus.textContent = formatArtifactStatus(artifact.status);
      const metaItems = isGenerated
        ? [
          { label: 'Created', value: formatArtifactTimestamp(artifact.timestamp) },
          { label: 'Kind', value: String(file?.artifactKind || 'document').replace(/_/g, ' ') },
          { label: 'Language', value: formatLanguageLabel(file?.language || 'plaintext') },
        ]
        : isImage
          ? [
            { label: 'Created', value: formatArtifactTimestamp(artifact.timestamp) },
            {
              label: 'Source',
              value: String(artifact?.image?.sourceKind || '').trim().toLowerCase() === 'capture'
                ? 'Screenshot'
                : String(artifact?.image?.sourceKind || '').trim().toLowerCase() === 'clipboard'
                  ? 'Clipboard'
                  : 'Attachment',
            },
            { label: 'Status', value: formatArtifactStatus(artifact.status) },
          ]
          : [
            { label: 'Created', value: formatArtifactTimestamp(artifact.timestamp) },
            { label: 'Tool', value: artifact.tool?.toolName || 'Tool' },
            { label: 'Status', value: formatArtifactStatus(artifact.status) },
          ];
      surface.detailMeta.innerHTML = renderDetailMeta(metaItems, surface.stackedMeta === true);
      surface.jumpButton.dataset.artifactJump = artifact.sourceMessageId || '';
      surface.jumpButton.disabled = !artifact.sourceMessageId;
      for (const btn of [surface.saveButton, surface.revertButton, surface.revealButton, surface.openExternalButton, surface.deleteButton]) {
        btn.classList.toggle('hidden', !isGenerated);
      }
      surface.saveButton.disabled = !editable || !dirty || state.artifacts.loading || state.artifacts.savePending;
      surface.revertButton.disabled = !isGenerated || state.artifacts.loading || state.artifacts.savePending || (!dirty && !state.artifacts.lastError);
      surface.revealButton.disabled = !isGenerated;
      surface.openExternalButton.disabled = !isGenerated;
      surface.deleteButton.disabled = !isGenerated || state.artifacts.loading || state.artifacts.savePending;
      // WS2 registry dispatch (artifact_renderer_registry ON): one resolver +
      // registry call replaces the legacy if/else below. Both paths call the
      // same per-kind implementations, so flag-off stays byte-identical.
      if (isRendererRegistryEnabled()) {
        const kind = rendererRegistryModule.resolveArtifactRenderKind(artifact, rendererKindPredicates);
        artifactRendererRegistry.render(kind, {
          surface,
          artifact,
          file,
          editable,
          deps: rendererDeps,
        });
        renderProvenanceTimeline(surface.provenanceTimeline, artifact);
        return;
      }
      if (isGenerated) {
        if (isMermaidGenerated) {
          renderMermaidGeneratedArtifact(surface, artifact, file, editable);
          renderProvenanceTimeline(surface.provenanceTimeline, artifact);
          return;
        }
        if (isMarkdownGenerated) {
          renderMarkdownGeneratedArtifact(surface, artifact, file, editable);
          renderProvenanceTimeline(surface.provenanceTimeline, artifact);
          return;
        }
        codeKindModule?.renderCodeArtifactKind?.({ surface, artifact, file, editable, deps: rendererDeps });
      } else if (isImage) {
        imageKindModule?.renderImageArtifactKind?.({ surface, artifact, deps: rendererDeps });
      } else {
        const mermaidSource = extractMermaidSourceFromToolArtifact(artifact);
        if (mermaidSource) {
          renderMermaidToolOutputArtifact(surface, artifact);
        } else {
          textKindModule?.renderTextArtifactKind?.({ surface, artifact, deps: rendererDeps });
        }
      }
      renderProvenanceTimeline(surface.provenanceTimeline, artifact);
    }
    // UIUX-007: read/save/revert/reveal/open-external/delete moved to
    // renderer-artifact-async-ops.js (generation-gated completion + delete's
    // explicit-target support). preloadSelectedArtifact stays here since it
    // dispatches to BOTH the moved file-load path and the image-load path
    // that stays local (image-state Maps live in this closure).
    const artifactAsyncOps = asyncOpsModule.createArtifactAsyncOps({
      state,
      surfaces,
      artifactOperationTarget,
      draftStore: artifactDraftStore,
      getSelectedArtifact,
      getArtifactByTarget,
      isGeneratedFile,
      isMermaidGeneratedArtifact,
      ensureEditor,
      getExistingEditor,
      getPreferredEditorValue,
      resetLoadedState,
      bumpArtifactDocumentRevision,
      renderArtifactsPanel,
      renderArtifactReviewPanel,
      invalidateSessionArtifacts,
      clearSelectionUi: clearSelection,
      showToastMessage,
      toErrorMessage,
    });
    const {
      stashDirtyArtifactIfNeeded,
      loadGeneratedArtifactContent,
      saveSelectedArtifact,
      revertSelectedArtifact,
      revealSelectedArtifact,
      openSelectedArtifactExternal,
      deleteSelectedArtifact,
    } = artifactAsyncOps;

    function preloadSelectedArtifact(artifact, eventName) {
      if (isGeneratedFile(artifact)) {
        const fileId = String(artifact?.generatedFile?.artifactId || '').trim();
        if (!fileId || state.artifacts.loadedArtifactId === fileId || state.artifacts.loading === true) {
          return;
        }
        loadGeneratedArtifactContent(artifact).catch((error) => appendClientLog('WARN', eventName || 'artifacts.autoload_failed', {
          message: String(error?.message || error || ''),
          artifactId: artifact.id,
        }));
      } else if (isGeneratedImageArtifactReadRequired(artifact)) {
        loadGeneratedImageArtifactAsset(artifact).catch((error) => appendClientLog('WARN', eventName || 'artifacts.image_autoload_failed', {
          message: String(error?.message || error || ''),
          artifactId: artifact.id,
        }));
      }
    }

    function handleImagePreviewError(event) {
      const preview = event?.target;
      if (!preview || !preview.classList?.contains('artifact-preview-image')) return;
      const artifact = getSelectedArtifact();
      const artifactId = String(artifact?.id || '').trim();
      const failureKey = imageArtifactFailureKey(artifact?.sessionId, artifactId);
      if (failureKey) failedImageArtifactKeys.add(failureKey);
      renderArtifactsPanel();
      renderArtifactReviewPanel();
    }

    async function writeArtifactTextToClipboard(text, successMessage) {
      if (!text) return;
      try {
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
        if (!clipboard?.writeText) {
          throw new Error('Clipboard is unavailable.');
        }
        await clipboard.writeText(text);
        showToastMessage?.(successMessage, { title: 'Artifact', tone: 'success' });
      } catch (error) {
        showToastMessage?.(formatError(error, 'Copy failed.'), { title: 'Copy Failed', tone: 'danger' });
      }
    }
    async function copyArtifactDocumentCodeBlock(copyButton) {
      const text = readArtifactDocumentCodeBlockText(copyButton);
      await writeArtifactTextToClipboard(text, 'Code copied.');
    }
    function getSelectedArtifactSource() {
      const artifact = getSelectedArtifact();
      if (!artifact || isImageArtifact(artifact)) return '';
      if (isGeneratedFile(artifact)) {
        const file = artifact.generatedFile || null;
        const isLoaded = Boolean(file) && state.artifacts.loadedArtifactId === file.artifactId;
        return isLoaded
          ? getPreferredEditorValue()
          : String(state.artifacts.loadedArtifactContent || artifact.previewText || '');
      }
      const mermaidSource = extractMermaidSourceFromToolArtifact(artifact);
      return mermaidSource || prettyPrintJson(artifact.outputText || artifact.previewText || '');
    }
    async function copySelectedArtifactSource() {
      const text = getSelectedArtifactSource();
      if (!text) return;
      await writeArtifactTextToClipboard(text, 'Artifact copied.');
    }
    // WS2 per-kind view-mode model: state.artifacts.viewModeByKind, with
    // state.artifacts.mermaidViewMode kept as the synced alias the mermaid
    // renderer (and older callers) still read.
    function normalizeArtifactViewModeToken(nextMode) {
      return String(nextMode || '').trim().toLowerCase() === 'edit' ? 'edit' : 'preview';
    }
    function getArtifactViewModeMap() {
      if (!state.artifacts.viewModeByKind || typeof state.artifacts.viewModeByKind !== 'object') {
        state.artifacts.viewModeByKind = {};
      }
      return state.artifacts.viewModeByKind;
    }
    function getArtifactViewMode(kind) {
      const token = String(kind || '').trim().toLowerCase();
      if (token === 'mermaid') {
        return normalizeArtifactViewModeToken(state.artifacts.mermaidViewMode);
      }
      return normalizeArtifactViewModeToken(getArtifactViewModeMap()[token]);
    }
    function setArtifactViewMode(kind, nextMode) {
      const token = String(kind || '').trim().toLowerCase();
      if (!token) return;
      const normalized = normalizeArtifactViewModeToken(nextMode);
      if (getArtifactViewMode(token) === normalized) return;
      getArtifactViewModeMap()[token] = normalized;
      if (token === 'mermaid') {
        state.artifacts.mermaidViewMode = normalized;
      }
      renderArtifactsPanel();
      renderArtifactReviewPanel();
    }
    function setArtifactMermaidViewMode(nextMode) {
      const artifact = getSelectedArtifact();
      if (!isMermaidGeneratedArtifact(artifact)) return;
      setArtifactViewMode('mermaid', nextMode);
    }
    // UIUX-007 single choke point for selection changes: bumps the
    // operation generation (invalidating any outstanding read/save/delete
    // token) AND resets the per-selection UI scalars in one call, so no
    // call site can flip selectedSessionId/selectedArtifactId without also
    // invalidating in-flight work — that omission is exactly how the
    // original "selection changes before dirty-discard handling" bug shipped.
    function applySelection(sessionId, artifactId) {
      failedImageArtifactKeys.delete(imageArtifactFailureKey(sessionId, artifactId));
      artifactOperationTarget.setSelection(sessionId, artifactId);
      resetLoadedState();
      state.artifacts.loading = false;
      state.artifacts.savePending = false;
    }
    function captureSelectedTarget() { return artifactOperationTarget.captureSelected(); }
    // Read<->source toggle only exists for markdown generated artifacts (see
    // setArtifactDocumentViewMode's early return above); panel chrome uses
    // this to know whether the Edit affordance can do anything.
    function isSelectedArtifactMarkdownGenerated() {
      const artifact = getSelectedArtifact();
      return isGeneratedFile(artifact) && isMarkdownGeneratedArtifact(artifact);
    }

    function clearEditorDocuments() {
      Object.keys(surfaces).forEach((key) => getExistingEditor(key)?.setDocument({
        value: '',
        language: 'plaintext',
        readOnly: true,
      }).catch(() => {}));
    }

    function resetImageArtifactState() {
      failedImageArtifactKeys.clear();
      loadedImageArtifactDataUrls.clear();
      loadingImageArtifactDataKeys.clear();
    }

    function pruneImageArtifactDataForSessions(validSessionIds) {
      const allowed = validSessionIds instanceof Set
        ? validSessionIds
        : new Set((Array.isArray(validSessionIds) ? validSessionIds : []).map((entry) => String(entry || '').trim()).filter(Boolean));
      for (const dataKey of [...loadedImageArtifactDataUrls.keys()]) {
        const sessionId = dataKey.split(':')[0] || '';
        if (!allowed.has(sessionId)) loadedImageArtifactDataUrls.delete(dataKey);
      }
      for (const dataKey of [...loadingImageArtifactDataKeys]) {
        const sessionId = dataKey.split(':')[0] || '';
        if (!allowed.has(sessionId)) loadingImageArtifactDataKeys.delete(dataKey);
      }
      for (const failureKey of [...failedImageArtifactKeys]) {
        const sessionId = failureKey.split(':')[0] || '';
        if (!allowed.has(sessionId)) failedImageArtifactKeys.delete(failureKey);
      }
    }

    // Draft-store half of the session prune: a deferred dirty draft whose
    // session no longer exists can never be taken back out, so drop it
    // alongside the image caches. Called from pruneSessionArtifacts
    // (renderer-artifacts-utils.js) AFTER its clearSelection() runs — that
    // call stashes a dirty leaving selection, which must not survive here.
    function pruneArtifactDraftsForSessions(validSessionIds) {
      artifactDraftStore.pruneToAllowedSessions(validSessionIds);
    }

    function clearArtifactDrafts() {
      artifactDraftStore.clear();
    }

    function dispose() {
      cancelScheduledPreviewRefresh();
      artifactAsyncOps.dispose();
      resetImageArtifactState();
      clearArtifactDrafts();
      disposeEditors();
    }

    // ── WS2 renderer registry wiring ──
    // One deps bundle shared by the registry ctx and the legacy delegations,
    // so both dispatch paths run identical per-kind implementations.
    const rendererDeps = {
      state,
      escapeHtml,
      prettyPrintJson,
      isGeneratedFile,
      setDetailNote,
      ensureEditor,
      getPreferredEditorValue,
      renderMermaidPreviewIntoHost,
      extractMermaidSourceFromToolArtifact,
      // mermaid kind (controller-wrapped implementations)
      renderMermaidGeneratedArtifact,
      renderMermaidToolOutputArtifact,
      // markdown kind
      getArtifactDocumentViewMode,
      getArtifactDocumentRevision,
      getArtifactDocumentNode,
      buildMarkdownArtifactDocumentSignature,
      buildMarkdownArtifactDocumentHtml,
      decorateMarkdownArtifactDocument,
      updateArtifactDocumentProgress,
      // image kind
      resolveImagePreviewUrl,
      isGeneratedImageArtifactReadRequired,
      hasImageArtifactLoadFailed: (artifact) => failedImageArtifactKeys.has(imageArtifactFailureKey(artifact?.sessionId, artifact?.id)),
      // web/chart kinds
      getArtifactViewMode,
      renderArtifactViewModeButton: artifactRender.renderArtifactViewModeButton,
    };
    const rendererKindPredicates = {
      isGeneratedFile,
      isImageArtifact,
      isMermaidGeneratedArtifact,
      isMarkdownGeneratedArtifact,
      isHtmlGeneratedArtifact,
      isSvgGeneratedArtifact,
      isChartGeneratedArtifact,
      extractMermaidSourceFromToolArtifact,
    };
    const artifactRendererRegistry = rendererRegistryModule
      && typeof rendererRegistryModule.createArtifactRendererRegistry === 'function'
      ? rendererRegistryModule.createArtifactRendererRegistry({
        mermaid: mermaidKindModule?.renderMermaidArtifactKind,
        markdown: markdownKindModule?.renderMarkdownArtifactKind,
        code: codeKindModule?.renderCodeArtifactKind,
        image: imageKindModule?.renderImageArtifactKind,
        text: textKindModule?.renderTextArtifactKind,
        html: webKindModule?.renderHtmlArtifactKind,
        svg: webKindModule?.renderSvgArtifactKind,
        chart: chartKindModule?.renderChartArtifactKind,
      })
      : null;
    function isRendererRegistryEnabled() {
      return state.features?.featureFlags?.artifact_renderer_registry === true
        && Boolean(artifactRendererRegistry)
        && typeof rendererRegistryModule?.resolveArtifactRenderKind === 'function';
    }

    return {
      applySelection,
      captureSelectedTarget,
      clearEditorDocuments,
      getExistingEditor,
      clearImageArtifactDataForSession,
      copyArtifactDocumentCodeBlock,
      copySelectedArtifactSource,
      getSelectedArtifactSource,
      deleteSelectedArtifact,
      stashDirtyArtifactIfNeeded,
      dispose,
      handleArtifactDocumentAction,
      handleArtifactDocumentKeydown,
      handleArtifactDocumentScroll,
      handleImagePreviewError,
      isGeneratedImageArtifactReadRequired,
      loadGeneratedArtifactContent,
      loadGeneratedImageArtifactAsset,
      openSelectedArtifactExternal,
      preloadSelectedArtifact,
      pruneArtifactDraftsForSessions,
      clearArtifactDrafts,
      pruneImageArtifactDataForSessions,
      renderSelectedArtifactDetail,
      resetImageArtifactState,
      resetLoadedState,
      revealSelectedArtifact,
      revertSelectedArtifact,
      saveSelectedArtifact,
      setArtifactDocumentViewMode,
      setArtifactMermaidViewMode,
      setArtifactViewMode,
      getArtifactViewMode,
      getArtifactDocumentViewMode,
      isSelectedArtifactMarkdownGenerated,
      toFileAssetUrl,
    };
  }

  return { createArtifactSurfaceController };
});
