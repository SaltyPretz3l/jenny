/* renderer/features/renderer-ide-preview-controller.js - Markdown/Mermaid
 * preview orchestration for the Workspace IDE (W8). Owns: which paths are
 * previewable, building sanitized preview HTML through the chat's existing
 * markdown pipeline (marked + DOMPurify + lazy mermaid runtime - never a
 * second mermaid load), the preview:// tab open flow, and debounced live
 * re-renders from the EDITOR BUFFER (not disk) while the source is edited.
 * Kept out of renderer-ide-controller for the 1015-line file ceiling. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePreviewController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  const PREVIEW_EXTENSIONS = new Set(['md', 'markdown', 'mmd', 'mermaid']);
  const LIVE_UPDATE_DEBOUNCE_MS = 200;

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
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const getWorkspaceFsApi = typeof deps?.getWorkspaceFsApi === 'function'
      ? deps.getWorkspaceFsApi
      : () => null;
    const callbacks = deps?.callbacks || {};
    const getFileOperations = typeof deps?.getFileOperations === 'function'
      ? deps.getFileOperations
      : typeof callbacks.getFileOperations === 'function'
        ? callbacks.getFileOperations
        : () => null;
    const {
      hasDocument = () => false,
      getValue = () => '',
      openPreviewDocument = noop,
      updatePreview = noop,
      activateDocument = noop,
      renderTabs = noop,
      showShellErrorToast = noop,
      appendClientLog = noop,
      // Unified Preview stage (workspace_preview_surface): when the flag is on
      // and the stage module is wired, openPreview() targets the stage surface
      // instead of opening a legacy preview:// tab, and HTML/HTM files become
      // previewable too (the stage renders them in the sandboxed iframe).
      // Flag-off (env rollback) keeps the W8 tab flow byte-identical.
      openPreviewStage = null,
      isPreviewStageEnabled = () => false,
    } = callbacks;
    const ideStateUtils = resolveModule('rendererIdeState', './renderer-ide-state');
    const markdownUtils = resolveModule('markdownUtils', '../shared/markdown-utils');

    const HTML_PREVIEW_EXTENSIONS = new Set(['html', 'htm']);

    let liveUpdateTimer = null;
    let requestEpoch = 0;
    let disposed = false;

    function stageActive() {
      return typeof openPreviewStage === 'function' && isPreviewStageEnabled() === true;
    }

    function isPreviewablePath(path) {
      if (ideStateUtils.isDiffTabId?.(path) || ideStateUtils.isPreviewTabId?.(path)) {
        return false;
      }
      const extension = ideStateUtils.fileExtensionOf?.(path) || '';
      if (PREVIEW_EXTENSIONS.has(extension)) {
        return true;
      }
      return stageActive() && HTML_PREVIEW_EXTENSIONS.has(extension);
    }

    function previewIdFor(sourcePath) {
      return `${ideStateUtils.PREVIEW_TAB_PREFIX || 'preview://'}${sourcePath}`;
    }

    // .mmd/.mermaid sources wrap as a mermaid fence so the SAME sanitize +
    // lazy-mermaid path renders both file kinds.
    function buildPreviewHtml(sourcePath, text) {
      const extension = ideStateUtils.fileExtensionOf?.(sourcePath) || '';
      const source = extension === 'mmd' || extension === 'mermaid'
        ? `\`\`\`mermaid\n${String(text || '')}\n\`\`\``
        : String(text || '');
      if (typeof markdownUtils.renderMarkdown !== 'function') {
        return '';
      }
      const options = extension === 'md' || extension === 'markdown'
        ? { frontmatter: 'metadata' }
        : undefined;
      return markdownUtils.renderMarkdown(source, options) || '';
    }

    // Runs after the pane injects sanitized HTML: the chat's lazy mermaid
    // pass (single shared ~3.2MB runtime, IntersectionObserver-gated).
    function handlePreviewDomInjected(containerEl) {
      markdownUtils.renderInlineMermaidBlocks?.(containerEl, { isStreaming: false });
    }

    function validVersionedPreview(payload, requestedPath) {
      return Boolean(payload
        && payload.ok === true
        && typeof payload.content === 'string'
        && typeof payload.path === 'string'
        && payload.path
        && typeof payload.pathKey === 'string'
        && payload.pathKey
        && typeof payload.requestedPathKey === 'string'
        && payload.requestedPathKey
        && typeof payload.rootId === 'string'
        && payload.rootId
        && Number.isSafeInteger(payload.generation)
        && typeof payload.fileVersion === 'string'
        && payload.fileVersion
        && String(payload.requestedPath || requestedPath));
    }

    async function readDiskPreview(path, epoch) {
      const operations = getFileOperations();
      if (operations?.beginPreview && operations?.readForPreview) {
        const intent = operations.beginPreview(path);
        const read = await operations.readForPreview(intent, { maxBytes: 1_500_000 });
        if (disposed || epoch !== requestEpoch || read.stale || !read.payload) return null;
        return read.payload;
      }
      // Compatibility until controller composition supplies the shared owner:
      // still versioned/bounded and latest-request guarded; raw readFile is
      // intentionally never used.
      const api = getWorkspaceFsApi();
      if (typeof api?.readText !== 'function') return null;
      const payload = await api.readText({ path, intent: 'preview', maxBytes: 1_500_000 });
      if (disposed || epoch !== requestEpoch || !validVersionedPreview(payload, path)) return null;
      return payload;
    }

    async function refreshUnopenedPreview(normalized, { surfaceError = false } = {}) {
      requestEpoch += 1;
      const epoch = requestEpoch;
      try {
        const payload = await readDiskPreview(normalized, epoch);
        if (!payload || disposed || epoch !== requestEpoch) return false;
        const id = previewIdFor(normalized);
        if (!hasDocument(id)) return false;
        updatePreview(id, buildPreviewHtml(normalized, payload.content));
        return true;
      } catch (error) {
        if (surfaceError && !disposed && epoch === requestEpoch) {
          showShellErrorToast(`Could not read ${normalized} for preview.`, {
            title: 'Open Preview',
            dedupeKey: `ide:preview:${normalized}`,
          });
        }
        appendClientLog('WARN', 'ide.preview_read_failed', {
          message: String(error?.message || error || ''),
        });
        return false;
      }
    }

    async function openPreview(sourcePath) {
      const normalized = ideStateUtils.normalizeIdeRelativePath?.(sourcePath) || '';
      if (!normalized || !isPreviewablePath(normalized)) {
        return false;
      }
      // Stage-surface path: pin the target on the Preview stage and let it own
      // reading/rendering (incl. its bounded missing/binary/too-large states).
      if (stageActive()) {
        openPreviewStage(normalized);
        return true;
      }
      // Prefer the live buffer; fall back to disk for tree-only opens.
      let text;
      if (hasDocument(normalized)) {
        requestEpoch += 1;
        text = getValue(normalized);
      } else {
        requestEpoch += 1;
        const epoch = requestEpoch;
        try {
          const payload = await readDiskPreview(normalized, epoch);
          if (!payload || disposed || epoch !== requestEpoch) return false;
          text = payload.content;
        } catch (error) {
          showShellErrorToast(`Could not read ${normalized} for preview.`, {
            title: 'Open Preview',
            dedupeKey: `ide:preview:${normalized}`,
          });
          appendClientLog('WARN', 'ide.preview_read_failed', {
            message: String(error?.message || error || ''),
          });
          return false;
        }
      }
      const id = previewIdFor(normalized);
      const label = `${ideStateUtils.fileNameOf?.(normalized) || normalized} (preview)`;
      openPreviewDocument({ id, label, sourcePath: normalized });
      updatePreview(id, buildPreviewHtml(normalized, text));
      ideStateUtils.openPreviewTab?.(getIde(), { id, label });
      activateDocument(id);
      renderTabs();
      return true;
    }

    // Editor-host model change hook: debounce, then re-render the preview of
    // the edited source from its CURRENT buffer (not disk).
    function handleModelChange(path) {
      const id = previewIdFor(path);
      if (!isPreviewablePath(path) || !hasDocument(id)) {
        return;
      }
      if (liveUpdateTimer) {
        clearTimeout(liveUpdateTimer);
      }
      liveUpdateTimer = setTimeout(() => {
        liveUpdateTimer = null;
        if (hasDocument(id)) {
          updatePreview(id, buildPreviewHtml(path, getValue(path)));
        }
      }, LIVE_UPDATE_DEBOUNCE_MS);
    }

    function handleExternalChange(change) {
      const normalized = ideStateUtils.normalizeIdeRelativePath?.(change?.relPath) || '';
      if (!normalized || hasDocument(normalized) || !hasDocument(previewIdFor(normalized))) return;
      if (change?.kind === 'deleted') {
        requestEpoch += 1;
        return;
      }
      refreshUnopenedPreview(normalized);
    }

    function handleWorkspaceRootCommitted() {
      requestEpoch += 1;
      getFileOperations()?.cancelPreviewIntents?.();
    }

    function buildPreviewMenuItems(path) {
      if (!isPreviewablePath(path)) {
        return [];
      }
      return [
        { separator: true },
        { label: 'Open Preview', action: () => openPreview(path) },
      ];
    }

    function dispose() {
      disposed = true;
      requestEpoch += 1;
      getFileOperations()?.cancelPreviewIntents?.();
      if (liveUpdateTimer) {
        clearTimeout(liveUpdateTimer);
        liveUpdateTimer = null;
      }
    }

    return {
      buildPreviewHtml,
      buildPreviewMenuItems,
      dispose,
      handleModelChange,
      handleExternalChange,
      handlePreviewDomInjected,
      handleWorkspaceRootCommitted,
      isPreviewablePath,
      openPreview,
    };
  }

  return {
    createIdePreviewController,
  };
});
