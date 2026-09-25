/* renderer/features/renderer-ide-editor-host-panes.js - the non-Monaco
 * document kinds of the Workspace IDE editor host: image previews (W7),
 * rendered-markdown previews (W8) and binary documents (PDF / DOCX panes,
 * docs/plans/WORKSPACE_DOCUMENT_EDITING.md). Extracted from
 * renderer-ide-editor-host.js, which sits at the file-size ceiling. The host
 * keeps the shared `docs` map and dispatches on `doc.kind`; this module owns
 * opening, activating, closing and disposing those kinds plus the lazily
 * created per-format document panes. Every document pane implements one
 * interface: load / show / hide / close / hasDocument / isDirty / markSaved /
 * exportBytes / dispose (see renderer-ide-pdf-host.js). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorHostPanes = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  // Error code the lifecycle maps to "could not be opened as a document"; the
  // main lane raises the same code for unsupported / corrupt bytes.
  const DOCUMENT_UNSUPPORTED_CODE = 'CMP-WORKSPACEFS-0015';
  const DOCUMENT_FORMATS = Object.freeze(['pdf', 'docx']);
  // Per-format runtimes, loaded on the FIRST open of that format (like Monaco
  // and mermaid) so no document code or stylesheet costs app startup. Scripts
  // load in order through scriptLoaderUtils.ensureScript; each is ready once
  // its UMD global exists. Under Node tests the modules resolve via require.
  const DOCUMENT_RUNTIMES = Object.freeze({
    pdf: {
      global: 'rendererIdePdfHost',
      factory: 'createIdePdfPane',
      scripts: [
        { src: 'renderer/features/renderer-ide-pdf-host.js', global: 'rendererIdePdfHost' },
      ],
      stylesheets: ['styles/ide-pdf-pane.css'], // @imports pdf.js's own pdf_viewer.css
    },
    docx: {
      global: 'rendererIdeDocxHost',
      factory: 'createIdeDocxPane',
      scripts: [
        { src: 'renderer/inventory/file-input.js', global: 'inventoryFileInput' },
        { src: 'renderer/features/renderer-ide-docx-zip.js', global: 'rendererIdeDocxZip' },
        { src: 'renderer/features/renderer-ide-docx-image-model.js', global: 'rendererIdeDocxImageModel' },
        { src: 'renderer/features/renderer-ide-docx-model.js', global: 'rendererIdeDocxModel' },
        { src: 'renderer/features/renderer-ide-docx-rich.js', global: 'rendererIdeDocxRich' },
        { src: 'renderer/features/renderer-ide-docx-render.js', global: 'rendererIdeDocxRender' },
        { src: 'renderer/features/renderer-ide-docx-host.js', global: 'rendererIdeDocxHost' },
      ],
      stylesheets: ['styles/ide-docx-pane.css'],
    },
  });

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
    return null;
  }

  function documentError(code, message) {
    const error = new Error(String(message || 'The document could not be opened.'));
    error.code = code || DOCUMENT_UNSUPPORTED_CODE;
    return error;
  }

  function createEditorHostPanes(deps) {
    const docs = deps?.docs instanceof Map ? deps.docs : new Map();
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const onDirtyChange = typeof deps?.onDirtyChange === 'function' ? deps.onDirtyChange : () => {};
    const onDocumentEdit = typeof deps?.onDocumentEdit === 'function' ? deps.onDocumentEdit : () => {};
    const onSaveRequest = typeof deps?.onSaveRequest === 'function' ? deps.onSaveRequest : () => {};
    const onPreviewDomInjected = typeof deps?.onPreviewDomInjected === 'function' ? deps.onPreviewDomInjected : () => {};
    // Hides the Monaco/diff/fallback surfaces so a pane can overlay #ideEditorHost.
    const hideEditorSurfaces = typeof deps?.hideEditorSurfaces === 'function' ? deps.hideEditorSurfaces : () => {};
    const log = typeof deps?.log === 'function' ? deps.log : null;
    const getHost = () => getDom().ideEditorHost || null;

    const imageHostUtils = deps?.imageHostUtils || resolveModule('rendererIdeImageHost', './renderer-ide-image-host') || {};
    const previewHostUtils = deps?.previewHostUtils || resolveModule('rendererIdePreviewHost', './renderer-ide-preview-host') || {};
    const imageMemoryUtils = deps?.imageMemoryUtils || resolveModule('rendererIdeImageMemory', './renderer-ide-image-memory') || {};
    // UIUX-034: decoded-image budget + blob URL ownership for image docs.
    const imageMemory = imageMemoryUtils.createImageMemory?.({
      getWindow: () => getHost()?.ownerDocument?.defaultView || null,
      ...deps?.imageMemoryOptions,
    }) || null;
    const imagePane = imageHostUtils.createIdeImagePane?.({ getHost }) || null;
    const previewPane = previewHostUtils.createIdePreviewPane?.({
      getHost,
      postRender: (containerEl) => onPreviewDomInjected(containerEl),
    }) || null;

    // Per-format document panes, created on first use so the PDF/DOCX
    // modules (and pdf.js) only load when such a file opens. A factory
    // returns (possibly asynchronously) the pane constructor or null.
    const scriptLoader = deps?.scriptLoader || resolveModule('scriptLoaderUtils', '../shared/script-loader-utils');
    // Test seam: forces the lazy script path by returning null for every module.
    const resolveRuntimeModule = typeof deps?.resolveRuntimeModule === 'function' ? deps.resolveRuntimeModule : resolveModule;
    const documentPaneFactories = deps?.documentPaneFactories || {
      pdf: () => loadDocumentRuntime('pdf'),
      docx: () => loadDocumentRuntime('docx'),
    };
    const documentPanes = new Map();
    const stylesheetsInjected = new Set();

    function injectStylesheets(hrefs) {
      const documentRef = getHost()?.ownerDocument || null;
      const head = documentRef?.head || documentRef?.documentElement || null;
      if (!head) return;
      for (const href of hrefs) {
        if (stylesheetsInjected.has(href) || head.querySelector?.(`link[data-ide-document-style="${href}"]`)) continue;
        const link = documentRef.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.setAttribute('data-ide-document-style', href);
        head.appendChild(link);
        stylesheetsInjected.add(href);
      }
    }

    // Resolves a format's pane constructor: already-present global or
    // require() first (tests, preloaded), else lazy script injection.
    async function loadDocumentRuntime(format) {
      const runtime = DOCUMENT_RUNTIMES[format];
      if (!runtime) return null;
      const requirePath = runtime.scripts[runtime.scripts.length - 1].src.replace(/^renderer\/features\//, './').replace(/\.js$/, '');
      let module = resolveRuntimeModule(runtime.global, requirePath);
      if (!module && typeof scriptLoader?.ensureScript === 'function') {
        for (const script of runtime.scripts) {
          const ok = await scriptLoader.ensureScript({
            src: script.src, isReady: () => Boolean(globalRef[script.global]), log,
          });
          if (!ok) {
            log?.('WARN', 'ide.document_runtime_load_failed', { format, src: script.src });
            return null;
          }
        }
        module = globalRef[runtime.global] || null;
      }
      if (!module) return null;
      injectStylesheets(runtime.stylesheets);
      return typeof module[runtime.factory] === 'function' ? module[runtime.factory] : null;
    }

    function getDoc(path) {
      return docs.get(String(path || '')) || null;
    }

    function noteDocumentDirty(path, dirty) {
      const doc = getDoc(path);
      if (doc && doc.kind === 'document') {
        doc.dirty = dirty === true;
      }
      onDirtyChange(String(path || ''), dirty === true);
    }

    // Every pane mutation (not only dirty transitions) reaches the lifecycle's
    // edit counter so a save can never mark newer, unexported edits clean.
    function noteDocumentEdit(path) {
      onDocumentEdit(String(path || ''));
    }

    async function documentPaneFor(format) {
      const key = String(format || '').toLowerCase();
      if (documentPanes.has(key)) {
        return documentPanes.get(key);
      }
      if (!DOCUMENT_FORMATS.includes(key)) {
        return null;
      }
      const factory = documentPaneFactories[key];
      const create = typeof factory === 'function' ? await factory() : null;
      if (documentPanes.has(key)) return documentPanes.get(key); // a parallel open won
      const pane = typeof create === 'function'
        ? create({ getHost, onDirtyChange: noteDocumentDirty, onEdit: noteDocumentEdit, onSaveRequest, log })
        : null;
      documentPanes.set(key, pane || null);
      return pane || null;
    }

    function hideDocumentPanes() {
      for (const pane of documentPanes.values()) {
        pane?.hide?.();
      }
    }

    // Hides every overlay pane; the host calls this before showing Monaco,
    // the diff editor or the fallback textarea.
    function hideAll() {
      imagePane?.hide();
      previewPane?.hide();
      hideDocumentPanes();
    }

    // ── Image documents (W7) ──

    // Loads (or refreshes after an external change) an image document from a
    // versioned readImage payload. Never touches Monaco models.
    function openImageDocument({ path, base64, mime, size, mtimeMs } = {}, closeDocument) {
      const normalizedPath = String(path || '');
      if (!normalizedPath) {
        return null;
      }
      let doc = getDoc(normalizedPath);
      if (!doc) {
        doc = { kind: 'image', model: null, viewState: null, dirty: false };
        docs.set(normalizedPath, doc);
      }
      imageMemory?.applyPayload(doc, { base64, mime });
      imageMemory?.registerOpen(normalizedPath, closeDocument);
      doc.size = Number(size) || 0;
      doc.mtimeMs = Number(mtimeMs) || 0;
      doc.naturalWidth = 0;
      doc.naturalHeight = 0;
      return doc;
    }

    function activateImageDocument(normalizedPath, doc) {
      imageMemory?.touch(normalizedPath);
      hideEditorSurfaces();
      previewPane?.hide();
      hideDocumentPanes();
      imagePane?.show(doc);
      return true;
    }

    // ── Markdown/Mermaid preview documents (W8) ──

    function openPreviewDocument({ id, label = '', sourcePath = '' } = {}) {
      const normalizedId = String(id || '');
      if (!normalizedId) {
        return null;
      }
      let doc = getDoc(normalizedId);
      if (!doc) {
        doc = { kind: 'preview', model: null, viewState: null, dirty: false, html: '' };
        docs.set(normalizedId, doc);
      }
      doc.id = normalizedId;
      doc.label = String(label || doc.label || 'Preview');
      doc.sourcePath = String(sourcePath || doc.sourcePath || '');
      return doc;
    }

    // Stores sanitized HTML; re-injects live when this preview is visible.
    function updatePreview(id, html) {
      const doc = getDoc(id);
      if (!doc || doc.kind !== 'preview') {
        return false;
      }
      doc.html = String(html || '');
      previewPane?.update(doc);
      return true;
    }

    function activatePreviewDocument(normalizedId, doc) {
      hideEditorSurfaces();
      imagePane?.hide();
      hideDocumentPanes();
      previewPane?.show(doc);
      return true;
    }

    // ── Binary documents (PDF / DOCX) ──

    // Loads (or reloads after an external change) a document through its
    // format pane. Resolves to the doc, or null when `shouldApply` vetoed the
    // result after the async parse (the pane's copy is closed again). Throws
    // a coded error when the format has no pane or the bytes are refused.
    async function openBinaryDocument({
      path, base64, format, size, mtimeMs, shouldApply = null, onApplied = null,
    } = {}) {
      const normalizedPath = String(path || '');
      const normalizedFormat = String(format || '').toLowerCase();
      if (!normalizedPath) {
        return null;
      }
      const pane = await documentPaneFor(normalizedFormat);
      if (!pane) {
        throw documentError(DOCUMENT_UNSUPPORTED_CODE, 'No viewer is available for this document format.');
      }
      const existing = getDoc(normalizedPath);
      const wasDirty = existing?.dirty === true;
      // `shouldCommit` runs inside the pane after the async parse and before
      // the live record is replaced, so a veto (edits during a reload, a
      // stale token) keeps the previous record and its dirty state intact.
      const shouldCommit = typeof shouldApply === 'function' ? () => shouldApply() === true : null;
      const result = await pane.load(normalizedPath, { base64, size, mtimeMs, shouldCommit });
      if (result?.ok !== true && result?.code === 'document_stale') {
        return null;
      }
      if (!result || result.ok !== true) {
        if (!existing) pane.close(normalizedPath);
        throw documentError(DOCUMENT_UNSUPPORTED_CODE, result?.message || 'The document could not be opened.');
      }
      if (typeof shouldApply === 'function' && shouldApply() !== true) {
        if (!existing) pane.close(normalizedPath);
        return null;
      }
      let doc = existing;
      if (!doc || doc.kind !== 'document') {
        doc = { kind: 'document', model: null, viewState: null, dirty: false };
        docs.set(normalizedPath, doc);
      }
      doc.format = normalizedFormat;
      doc.pane = pane;
      doc.size = Number(size) || 0;
      doc.mtimeMs = Number(mtimeMs) || 0;
      doc.dirty = false;
      if (wasDirty) onDirtyChange(normalizedPath, false);
      if (typeof onApplied === 'function') onApplied();
      return doc;
    }

    function activateBinaryDocument(normalizedPath, doc) {
      hideEditorSurfaces();
      imagePane?.hide();
      previewPane?.hide();
      for (const pane of documentPanes.values()) {
        if (pane && pane !== doc.pane) pane.hide?.();
      }
      return doc.pane?.show?.(normalizedPath) === true;
    }

    function getDocumentFormat(path) {
      const doc = getDoc(path);
      return doc?.kind === 'document' ? String(doc.format || '') : '';
    }

    // Base64 of the document as the pane would save it, or null.
    async function getDocumentBytes(path) {
      const doc = getDoc(path);
      if (!doc || doc.kind !== 'document' || !doc.pane) {
        return null;
      }
      const bytes = await doc.pane.exportBytes(String(path || ''));
      return typeof bytes === 'string' && bytes ? bytes : null;
    }

    function markDocumentSaved(path, { mtimeMs } = {}) {
      const doc = getDoc(path);
      if (!doc || doc.kind !== 'document') {
        return false;
      }
      doc.mtimeMs = Number(mtimeMs) || doc.mtimeMs;
      doc.pane?.markSaved?.(String(path || ''));
      if (doc.dirty) {
        doc.dirty = false;
        onDirtyChange(String(path || ''), false);
      }
      return true;
    }

    // ── Shared teardown ──

    // Hides whichever overlay the closing document was showing.
    function hideForClose(doc) {
      if (doc?.kind === 'image') imagePane?.hide();
      else if (doc?.kind === 'preview') previewPane?.hide();
      else if (doc?.kind === 'document') doc.pane?.hide?.();
    }

    // Releases a document's pane-side resources (the host deletes the map entry).
    function release(normalizedPath, doc) {
      if (doc?.kind === 'image') imageMemory?.discard(normalizedPath, doc);
      else if (doc?.kind === 'document') doc.pane?.close?.(normalizedPath);
    }

    function dispose() {
      for (const doc of docs.values()) {
        if (doc?.kind === 'image') imageMemory?.release(doc);
      }
      imagePane?.dispose();
      previewPane?.dispose();
      for (const pane of documentPanes.values()) {
        pane?.dispose?.();
      }
      documentPanes.clear();
    }

    return {
      activateBinaryDocument,
      activateImageDocument,
      activatePreviewDocument,
      dispose,
      getDocumentBytes,
      getDocumentFormat,
      hideAll,
      hideForClose,
      markDocumentSaved,
      openBinaryDocument,
      openImageDocument,
      openPreviewDocument,
      release,
      updatePreview,
    };
  }

  return {
    DOCUMENT_FORMATS,
    DOCUMENT_RUNTIMES,
    DOCUMENT_UNSUPPORTED_CODE,
    createEditorHostPanes,
  };
});
