/* renderer/features/renderer-ide-pdf-host.js - PDF.js viewer and annotation
 * pane for Workspace IDE document tabs. The editor host owns file IO; this
 * module owns per-path PDF.js resources and exports saved bytes on request. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePdfHost = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const MAX_PDF_BYTES = 32 * 1024 * 1024;
  // pdf.js builds one page-view object per page up front, so the byte cap
  // alone does not bound renderer memory: a tiny PDF can declare 10^6 pages.
  const MAX_PDF_PAGES = 5000;
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 8;
  const ZOOM_STEP = 1.25;
  // pdf.js reads highlight colors only from this option; without it every
  // new highlight throws in getNonHCMColorName (highlightColorNames is null).
  // Same palette as the Firefox viewer's annotationEditorHighlightColors.
  const PDF_HIGHLIGHT_COLORS = 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F';
  const loadDefaultPdfjs = createPdfjsLoader();

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

  function repoUrl(relativePath, documentRef = globalRef.document) {
    return new URL(relativePath, documentRef.baseURI).href;
  }

  function createPdfjsLoader({ importModule = (url) => import(url), resolveUrl = repoUrl } = {}) {
    let pending = null;
    return function loadPdfjs() {
      if (!pending) {
        // The viewer destructures globalThis.pdfjsLib at module evaluation;
        // it cannot be imported concurrently with the core that creates it.
        pending = importModule(resolveUrl('node_modules/pdfjs-dist/build/pdf.mjs'))
          .then(async (pdfjs) => {
            pdfjs.GlobalWorkerOptions.workerSrc = resolveUrl('node_modules/pdfjs-dist/build/pdf.worker.mjs');
            const viewer = await importModule(resolveUrl('node_modules/pdfjs-dist/web/pdf_viewer.mjs'));
            return { pdfjs, viewer };
          }).catch((error) => { pending = null; throw error; });
      }
      return pending;
    };
  }

  function decodeBase64(base64) {
    const binary = globalRef.atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function encodeBase64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return globalRef.btoa(chunks.join(''));
  }

  function createQuietL10n() {
    return {
      getLanguage: () => 'en-us',
      getDirection: () => 'ltr',
      get: async (id, _args, fallback) => fallback || id,
      translate: async () => {},
      translateOnce: async () => {},
      pause: () => {},
      resume: () => {},
      destroy: async () => {},
    };
  }

  function createIdePdfPane(deps) {
    const getHost = typeof deps?.getHost === 'function' ? deps.getHost : () => null;
    const onDirtyChange = typeof deps?.onDirtyChange === 'function' ? deps.onDirtyChange : () => {};
    const onSaveRequest = typeof deps?.onSaveRequest === 'function' ? deps.onSaveRequest : () => {};
    const onEdit = typeof deps?.onEdit === 'function' ? deps.onEdit : () => {};
    const log = typeof deps?.log === 'function' ? deps.log : () => {};
    const loadPdfjs = typeof deps?.loadPdfjs === 'function' ? deps.loadPdfjs : loadDefaultPdfjs;
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const textField = resolveModule('inventoryTextField', '../inventory/text-field');
    const documents = new Map();
    const generations = new Map();
    // Candidate records: parsed but not yet committed over the live record.
    const pending = new Map();

    let paneEl = null;
    let docsEl = null;
    let errorEl = null;
    let pageFieldEl = null;
    let pageReadoutEl = null;
    let findFieldEl = null;
    let findReadoutEl = null;
    let currentPath = null;
    let disposed = false;
    let api = null;

    function button(action, label, options = {}) {
      return actionButton({
        plain: true,
        className: `ide-pdf-button${options.mode ? ' ide-pdf-mode-button' : ''}`,
        label,
        title: options.title || label,
        ariaLabel: options.title || label,
        ariaPressed: options.mode ? options.pressed === true : undefined,
        dataset: { 'ide-pdf-action': action },
      });
    }

    function buildToolbarMarkup() {
      if (typeof actionButton !== 'function' || typeof textField !== 'function') {
        return '';
      }
      const pageField = textField({
        id: 'idePdfPage',
        value: '1',
        ariaLabel: jt('ide.pdf.pageNumber', 'Page number'),
        className: 'ide-pdf-page-field',
        dataset: { 'ide-pdf-page': 'true' },
      });
      const findField = textField({
        id: 'idePdfFind',
        value: '',
        placeholder: jt('ide.pdf.searchPlaceholder', 'Find in document'),
        ariaLabel: jt('ide.pdf.search', 'Search PDF'),
        className: 'ide-pdf-find-field',
        dataset: { 'ide-pdf-find': 'true' },
      });
      return '<div class="ide-pdf-toolbar">'
        + '<div class="ide-pdf-toolbar-row">'
        + button('prev', jt('ide.pdf.previousPage', 'Previous'))
        + button('next', jt('ide.pdf.nextPage', 'Next'))
        + pageField
        + '<span class="ide-pdf-page-readout"></span>'
        + '<span class="ide-pdf-separator" aria-hidden="true"></span>'
        + button('zoom-out', jt('ide.pdf.zoomOut', 'Zoom out'))
        + button('zoom-in', jt('ide.pdf.zoomIn', 'Zoom in'))
        + button('fit-width', jt('ide.pdf.fitWidth', 'Fit width'))
        + button('fit-page', jt('ide.pdf.fitPage', 'Fit page'))
        + '<span class="ide-pdf-separator" aria-hidden="true"></span>'
        + findField
        + button('find-prev', jt('ide.pdf.previousMatch', 'Previous match'))
        + button('find-next', jt('ide.pdf.nextMatch', 'Next match'))
        + '<span class="ide-pdf-find-readout"></span>'
        + '</div>'
        + '<div class="ide-pdf-toolbar-row ide-pdf-toolbar-row--edit">'
        + button('select', jt('ide.pdf.selectMode', 'Select'), { mode: true, pressed: true })
        + button('highlight', jt('ide.pdf.highlightMode', 'Highlight'), { mode: true })
        + button('text', jt('ide.pdf.textMode', 'Text'), { mode: true })
        + button('draw', jt('ide.pdf.drawMode', 'Draw'), { mode: true })
        + '<span class="ide-pdf-note">'
        + actionButton.escapeHtml(jt('ide.pdf.editScope', 'Annotations and form fields are saved into the PDF. Existing text and layout cannot be edited here.'))
        + '</span></div></div>';
    }

    function ensurePane() {
      if (paneEl) {
        return paneEl;
      }
      const host = getHost();
      const documentRef = host?.ownerDocument || null;
      if (!host || !documentRef || disposed) {
        return null;
      }
      paneEl = documentRef.createElement('div');
      paneEl.className = 'ide-pdf-pane hidden';
      // Ctrl+S saves in the bubble phase so a focused pdf.js FreeText editor
      // commits first; the #ideView capture handler defers to this marker.
      paneEl.dataset.ideSaveShortcut = 'pane';
      paneEl.innerHTML = buildToolbarMarkup()
        + '<div class="ide-pdf-error hidden" role="status"></div>'
        + '<div class="ide-pdf-documents"></div>';
      docsEl = paneEl.querySelector('.ide-pdf-documents');
      errorEl = paneEl.querySelector('.ide-pdf-error');
      pageFieldEl = paneEl.querySelector('[data-ide-pdf-page]');
      pageReadoutEl = paneEl.querySelector('.ide-pdf-page-readout');
      findFieldEl = paneEl.querySelector('[data-ide-pdf-find]');
      findReadoutEl = paneEl.querySelector('.ide-pdf-find-readout');
      paneEl.addEventListener('click', handleClick);
      paneEl.addEventListener('keydown', handleKeydown);
      host.appendChild(paneEl);
      refreshToolbar();
      return paneEl;
    }

    function nextGeneration(path) {
      const generation = (generations.get(path) || 0) + 1;
      generations.set(path, generation);
      return generation;
    }

    function isCurrent(record) {
      return !disposed
        && (documents.get(record.path) === record || pending.get(record.path) === record)
        && generations.get(record.path) === record.generation
        && !record.destroyed;
    }

    function safeLog(level, event, fields) {
      try {
        log(level, event, fields);
      } catch (_error) {
        /* logging is non-fatal */
      }
    }

    function setDirty(path, dirty) {
      const record = documents.get(path);
      if (!record || record.dirty === dirty) {
        return;
      }
      record.dirty = dirty;
      onDirtyChange(path, dirty);
    }

    function showError(message) {
      ensurePane();
      for (const record of documents.values()) {
        record.container?.classList.add('hidden');
      }
      currentPath = null;
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
      }
      paneEl?.classList.remove('hidden');
      refreshToolbar();
    }

    function clearError() {
      errorEl?.classList.add('hidden');
      if (errorEl) {
        errorEl.textContent = '';
      }
    }

    function makeLoadFailure(code) {
      if (code === 'document_stale') {
        return { ok: false, code, message: jt('ide.pdf.staleReload', 'The document changed before the reload could be applied.') };
      }
      const messages = {
        document_corrupt: jt('ide.pdf.corrupt', 'Could not open this PDF because it is corrupted or incomplete.'),
        document_unsupported: jt('ide.pdf.passwordProtected', 'Password-protected PDFs are not supported.'),
        document_too_large: jt('ide.pdf.tooLarge', 'This PDF is too large to open.'),
        document_engine_unavailable: jt('ide.pdf.engineUnavailable', 'The PDF viewer is unavailable.'),
      };
      return { ok: false, code, message: messages[code] };
    }

    function classifyDocumentError(error) {
      if (error?.name === 'PasswordException') {
        return makeLoadFailure('document_unsupported');
      }
      return makeLoadFailure('document_corrupt');
    }

    function addBusListener(record, name, listener) {
      record.eventBus.on(name, listener);
      record.busListeners.push([name, listener]);
    }

    function updateFindMatch(record, detail) {
      const count = detail?.matchesCount;
      if (!count) {
        return;
      }
      record.state.findMatch = {
        current: Number(count.current) || 0,
        total: Number(count.total) || 0,
      };
      if (record.path === currentPath) {
        refreshToolbar();
      }
    }

    function bindViewerEvents(record) {
      addBusListener(record, 'pagechanging', (detail) => {
        record.state.pageNumber = Number(detail?.pageNumber) || record.pdfViewer.currentPageNumber || 1;
        if (record.path === currentPath) refreshToolbar();
      });
      addBusListener(record, 'scalechanging', (detail) => {
        record.state.scale = detail?.presetValue || detail?.scale || record.pdfViewer.currentScaleValue;
        if (record.path === currentPath) refreshToolbar();
      });
      addBusListener(record, 'updatefindmatchescount', (detail) => updateFindMatch(record, detail));
      addBusListener(record, 'updatefindcontrol', (detail) => updateFindMatch(record, detail));
      addBusListener(record, 'annotationeditormodechanged', (detail) => {
        const modeNames = record.modeNames;
        record.state.editorMode = modeNames.get(detail?.mode) || record.state.editorMode;
        if (record.path === currentPath) refreshToolbar();
      });
    }

    function destroyRecord(record) {
      if (!record || record.destroyed) {
        return;
      }
      record.destroyed = true;
      record.resolvePagesInit?.();
      if (record.pdfDocument?.annotationStorage) {
        record.pdfDocument.annotationStorage.onSetModified = null;
        record.pdfDocument.annotationStorage.onResetModified = null;
      }
      for (const [name, listener] of record.busListeners || []) {
        record.eventBus?.off(name, listener);
      }
      try {
        record.pdfViewer?.cleanup();
        record.pdfViewer?.setDocument(null);
        record.linkService?.setDocument(null, null);
      } catch (error) {
        safeLog('warn', 'ide.pdf.cleanup_failed', { path: record.path, message: String(error?.message || error) });
      }
      try {
        let destroyResult;
        if (record.loadingTask) {
          destroyResult = record.loadingTask.destroy();
        } else {
          destroyResult = record.pdfDocument?.destroy?.();
        }
        destroyResult?.catch?.((error) => {
          safeLog('warn', 'ide.pdf.destroy_failed', { path: record.path, message: String(error?.message || error) });
        });
      } catch (error) {
        safeLog('warn', 'ide.pdf.destroy_failed', { path: record.path, message: String(error?.message || error) });
      }
      record.container?.remove();
    }

    function removeFailedRecord(record, failure) {
      if (documents.get(record.path) === record) {
        documents.delete(record.path);
      }
      if (pending.get(record.path) === record) {
        pending.delete(record.path);
      }
      destroyRecord(record);
      // A failed RELOAD keeps the live document on screen; only a failed
      // first open reveals the error state.
      if (!documents.has(record.path)) showError(failure.message);
      safeLog('warn', 'ide.pdf.load_failed', { path: record.path, code: failure.code });
      return failure;
    }

    function discardPending(record, failure) {
      if (pending.get(record.path) === record) pending.delete(record.path);
      destroyRecord(record);
      return failure;
    }

    function createRecord(path, generation) {
      const documentRef = paneEl.ownerDocument;
      const container = documentRef.createElement('div');
      container.className = 'ide-pdf-doc hidden';
      container.innerHTML = '<div class="ide-pdf-viewer-scroll"><div class="pdfViewer"></div></div>';
      docsEl.appendChild(container);
      return {
        path,
        generation,
        container,
        dirty: false,
        destroyed: false,
        loadingTask: null,
        pdfDocument: null,
        pdfViewer: null,
        linkService: null,
        eventBus: null,
        busListeners: [],
        resolvePagesInit: null,
        modeValues: null,
        modeNames: null,
        state: {
          pageNumber: 1,
          pageCount: 0,
          scale: 'page-width',
          editorMode: 'none',
          findQuery: '',
          findMatch: null,
        },
      };
    }

    async function load(path, source) {
      if (!ensurePane()) {
        return makeLoadFailure('document_engine_unavailable');
      }
      const generation = nextGeneration(path);
      const existing = documents.get(path);
      const wasVisible = currentPath === path && !paneEl.classList.contains('hidden');
      // The live record (and its dirty state) survives until the candidate
      // has parsed, passed the page budget, and the caller's commit fence.
      const staleCandidate = pending.get(path);
      if (staleCandidate) discardPending(staleCandidate, null);
      const record = createRecord(path, generation);
      pending.set(path, record);
      if (!existing) clearError();

      if ((Number(source?.size) || 0) > MAX_PDF_BYTES) {
        return removeFailedRecord(record, makeLoadFailure('document_too_large'));
      }

      let bytes;
      try {
        bytes = decodeBase64(source?.base64);
      } catch (_error) {
        return removeFailedRecord(record, makeLoadFailure('document_corrupt'));
      }
      if (bytes.byteLength > MAX_PDF_BYTES) {
        return removeFailedRecord(record, makeLoadFailure('document_too_large'));
      }

      let modules;
      try {
        modules = await loadPdfjs();
      } catch (error) {
        safeLog('warn', 'ide.pdf.engine_load_failed', { message: String(error?.message || error) });
        if (!isCurrent(record)) return discardPending(record, makeLoadFailure('document_engine_unavailable'));
        return removeFailedRecord(record, makeLoadFailure('document_engine_unavailable'));
      }
      if (!isCurrent(record)) {
        return discardPending(record, makeLoadFailure('document_engine_unavailable'));
      }

      const { pdfjs, viewer } = modules;
      try {
        record.loadingTask = pdfjs.getDocument({
          data: bytes,
          isEvalSupported: false,
          cMapUrl: repoUrl('node_modules/pdfjs-dist/cmaps/', paneEl.ownerDocument),
          cMapPacked: true,
          standardFontDataUrl: repoUrl('node_modules/pdfjs-dist/standard_fonts/', paneEl.ownerDocument),
          wasmUrl: repoUrl('node_modules/pdfjs-dist/wasm/', paneEl.ownerDocument),
          disableAutoFetch: true,
          enableXfa: false,
        });
        record.pdfDocument = await record.loadingTask.promise;
      } catch (error) {
        if (!isCurrent(record)) return discardPending(record, makeLoadFailure('document_engine_unavailable'));
        return removeFailedRecord(record, classifyDocumentError(error));
      }
      if (!isCurrent(record)) {
        return discardPending(record, makeLoadFailure('document_engine_unavailable'));
      }
      if ((Number(record.pdfDocument.numPages) || 0) > MAX_PDF_PAGES) {
        return removeFailedRecord(record, makeLoadFailure('document_too_large'));
      }
      if (typeof source?.shouldCommit === 'function' && source.shouldCommit() !== true) {
        return discardPending(record, makeLoadFailure('document_stale'));
      }
      // Commit: the candidate replaces the live record from here on.
      pending.delete(path);
      if (existing) {
        setDirty(path, false);
        destroyRecord(existing);
      }
      documents.set(path, record);
      clearError();

      try {
        record.eventBus = new viewer.EventBus();
        record.linkService = new viewer.PDFLinkService({
          eventBus: record.eventBus,
          externalLinkTarget: 0,
        });
        // Not a constructor option in pdf.js 6.x: it is a public field that
        // defaults to true, so it must be assigned after construction or URI
        // annotations become live document-controlled links.
        record.linkService.externalLinkEnabled = false;
        record.linkService.externalLinkTarget = 0;
        const findController = new viewer.PDFFindController({
          eventBus: record.eventBus,
          linkService: record.linkService,
        });
        const scrollContainer = record.container.querySelector('.ide-pdf-viewer-scroll');
        const viewerElement = record.container.querySelector('.pdfViewer');
        record.pdfViewer = new viewer.PDFViewer({
          container: scrollContainer,
          viewer: viewerElement,
          eventBus: record.eventBus,
          linkService: record.linkService,
          findController,
          textLayerMode: 1,
          annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
          annotationEditorMode: pdfjs.AnnotationEditorType.NONE,
          annotationEditorHighlightColors: PDF_HIGHLIGHT_COLORS,
          removePageBorders: false,
          l10n: createQuietL10n(),
        });
        record.linkService.setViewer?.(record.pdfViewer);
        record.modeValues = {
          none: pdfjs.AnnotationEditorType.NONE,
          highlight: pdfjs.AnnotationEditorType.HIGHLIGHT,
          freetext: pdfjs.AnnotationEditorType.FREETEXT,
          ink: pdfjs.AnnotationEditorType.INK,
        };
        record.modeNames = new Map(Object.entries(record.modeValues).map(([name, value]) => [value, name]));
        record.state.pageCount = record.pdfDocument.numPages;
        // Dirty is owned here, never by pdf.js: saveDocument() calls
        // resetModified() in its finally, long before main has landed the
        // bytes, so onResetModified must NOT clear the pane's dirty state.
        // markSaved (after a landed write) is the only path that clears it.
        record.pdfDocument.annotationStorage.onSetModified = () => {
          // pdf.js emits only on the clean -> modified transition. Re-arm its
          // notification latch synchronously so edits during export/write also
          // advance Jenny's save fence. This does not remove stored annotations.
          record.pdfDocument.annotationStorage.resetModified();
          onEdit(path);
          setDirty(path, true);
        };
        record.pdfDocument.annotationStorage.onResetModified = null;
        bindViewerEvents(record);
        const pagesInit = new Promise((resolve) => {
          record.resolvePagesInit = resolve;
          addBusListener(record, 'pagesinit', resolve);
        });
        record.pdfViewer.setDocument(record.pdfDocument);
        record.linkService.setDocument(record.pdfDocument, null);
        await pagesInit;
        if (!isCurrent(record)) return makeLoadFailure('document_engine_unavailable');
        // Defer scale measurement until show(): this candidate is still hidden.
        record.state.scale = 'page-width';
      } catch (error) {
        safeLog('warn', 'ide.pdf.viewer_init_failed', { message: String(error?.message || error) });
        if (!isCurrent(record)) return makeLoadFailure('document_engine_unavailable');
        return removeFailedRecord(record, makeLoadFailure('document_engine_unavailable'));
      }

      if (wasVisible) {
        show(path);
      }
      return { ok: true, pageCount: record.state.pageCount };
    }

    function activeRecord() {
      return currentPath ? documents.get(currentPath) || null : null;
    }

    function refreshToolbar() {
      const record = activeRecord();
      const state = record?.state;
      if (pageFieldEl) pageFieldEl.value = String(state?.pageNumber || 1);
      if (pageReadoutEl) {
        pageReadoutEl.textContent = jt('ide.pdf.pageReadout', '{current} / {total}', {
          current: state?.pageNumber || 0,
          total: state?.pageCount || 0,
        });
      }
      if (findFieldEl && record && findFieldEl.value !== state.findQuery) {
        findFieldEl.value = state.findQuery;
      }
      if (findReadoutEl) {
        findReadoutEl.textContent = jt('ide.pdf.findReadout', '{current} of {total}', {
          current: state?.findMatch?.current || 0,
          total: state?.findMatch?.total || 0,
        });
      }
      for (const element of paneEl?.querySelectorAll('.ide-pdf-mode-button') || []) {
        const action = element.dataset.idePdfAction;
        const mode = action === 'select' ? 'none' : action === 'text' ? 'freetext' : action === 'draw' ? 'ink' : action;
        element.setAttribute('aria-pressed', String(Boolean(state && state.editorMode === mode)));
      }
    }

    function show(path) {
      const record = documents.get(path);
      if (!record || record.destroyed || !record.pdfDocument || !ensurePane()) {
        return false;
      }
      currentPath = path;
      clearError();
      for (const candidate of documents.values()) {
        candidate.container.classList.toggle('hidden', candidate !== record);
      }
      paneEl.classList.remove('hidden');
      record.pdfViewer.currentScaleValue = record.state.scale;
      record.pdfViewer.update?.();
      refreshToolbar();
      return true;
    }

    function hide() {
      paneEl?.classList.add('hidden');
    }

    function close(path) {
      nextGeneration(path);
      const record = documents.get(path);
      if (!record) {
        return;
      }
      setDirty(path, false);
      documents.delete(path);
      destroyRecord(record);
      if (currentPath === path) {
        currentPath = null;
        paneEl?.classList.add('hidden');
        refreshToolbar();
      }
    }

    function changePage(record, value) {
      const pageNumber = Math.max(1, Math.min(record.state.pageCount, Math.round(Number(value) || 1)));
      record.pdfViewer.currentPageNumber = pageNumber;
      record.state.pageNumber = pageNumber;
      refreshToolbar();
    }

    function changeZoom(record, direction) {
      const current = Number(record.pdfViewer.currentScaleValue) || Number(record.pdfViewer.currentScale) || 1;
      const scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, direction === 'in' ? current * ZOOM_STEP : current / ZOOM_STEP));
      record.pdfViewer.currentScaleValue = scale;
      record.state.scale = scale;
      refreshToolbar();
    }

    function dispatchFind(record, findPrevious, type) {
      const query = findFieldEl?.value || '';
      record.state.findQuery = query;
      record.eventBus.dispatch('find', {
        source: api,
        type,
        query,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious,
      });
    }

    function setEditorMode(record, modeName) {
      const mode = record.modeValues[modeName];
      try {
        record.pdfViewer.annotationEditorMode = { mode };
        record.state.editorMode = modeName;
        refreshToolbar();
      } catch (error) {
        safeLog('warn', 'ide.pdf.editor_mode_failed', { path: record.path, message: String(error?.message || error) });
      }
    }

    function handleClick(event) {
      const action = event.target?.closest?.('[data-ide-pdf-action]')?.dataset.idePdfAction;
      const record = activeRecord();
      if (!action || !record) return;
      if (action === 'prev') changePage(record, record.state.pageNumber - 1);
      else if (action === 'next') changePage(record, record.state.pageNumber + 1);
      else if (action === 'zoom-out') changeZoom(record, 'out');
      else if (action === 'zoom-in') changeZoom(record, 'in');
      else if (action === 'fit-width' || action === 'fit-page') {
        const scale = action === 'fit-width' ? 'page-width' : 'page-fit';
        record.pdfViewer.currentScaleValue = scale;
        record.state.scale = scale;
        refreshToolbar();
      } else if (action === 'find-prev' || action === 'find-next') {
        dispatchFind(record, action === 'find-prev', 'again');
      } else {
        const mode = action === 'select' ? 'none' : action === 'text' ? 'freetext' : action === 'draw' ? 'ink' : action;
        if (Object.prototype.hasOwnProperty.call(record.modeValues, mode)) setEditorMode(record, mode);
      }
    }

    function handleKeydown(event) {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && String(event.key).toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        onSaveRequest();
        return;
      }
      if (modifier && String(event.key).toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        findFieldEl?.focus();
        return;
      }
      if (event.key !== 'Enter') return;
      const record = activeRecord();
      if (!record) return;
      if (event.target?.matches?.('[data-ide-pdf-page]')) {
        changePage(record, event.target.value);
      } else if (event.target?.matches?.('[data-ide-pdf-find]')) {
        dispatchFind(record, event.shiftKey, record.state.findQuery ? 'again' : '');
      }
    }

    function hasDocument(path) {
      const record = documents.get(path);
      return Boolean(record && !record.destroyed && record.pdfDocument);
    }

    function isDirty(path) {
      return Boolean(documents.get(path)?.dirty);
    }

    function markSaved(path) {
      const record = documents.get(path);
      if (!record?.pdfDocument) return;
      record.pdfDocument.annotationStorage.resetModified();
      setDirty(path, false);
    }

    async function exportBytes(path) {
      const record = documents.get(path);
      if (!record?.pdfDocument || record.destroyed) return null;
      return encodeBase64(await record.pdfDocument.saveDocument());
    }

    function getState(path) {
      const state = documents.get(path)?.state;
      return state ? {
        pageNumber: state.pageNumber,
        pageCount: state.pageCount,
        scale: state.scale,
        editorMode: state.editorMode,
        findQuery: state.findQuery,
        findMatch: state.findMatch ? { ...state.findMatch } : null,
      } : null;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const path of [...documents.keys()]) {
        close(path);
      }
      paneEl?.removeEventListener('click', handleClick);
      paneEl?.removeEventListener('keydown', handleKeydown);
      paneEl?.remove();
      paneEl = null;
      docsEl = null;
      errorEl = null;
      currentPath = null;
    }

    api = {
      load,
      show,
      hide,
      close,
      hasDocument,
      isDirty,
      markSaved,
      exportBytes,
      getState,
      dispose,
    };
    return api;
  }

  return { createIdePdfPane, createPdfjsLoader };
});
