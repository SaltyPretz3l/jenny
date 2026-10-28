/* renderer/features/renderer-ide-pdf-host.js - PDF.js viewer and annotation
 * pane for Workspace IDE document tabs. The editor host owns file IO; this
 * module owns per-path PDF.js resources and exports saved bytes on request;
 * renderer-ide-pdf-runtime.js loads pdf.js and encodes the bytes. */
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
  const EDITOR_MODE_BY_ACTION = Object.freeze({ select: 'none', highlight: 'highlight', text: 'freetext', draw: 'ink' });
  const FIT_SCALE_BY_ACTION = Object.freeze({ 'fit-width': 'page-width', 'fit-page': 'page-fit' });
  const FIT_SCALES = new Set(Object.values(FIT_SCALE_BY_ACTION));
  // Trailing delay for re-fitting while a splitter drags: every refit at a
  // new width re-rasterizes the visible pages.
  const REFIT_DELAY_MS = 120;

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  const { createPdfjsLoader, createViewerParts, decodeBase64, encodeBase64, repoUrl } = resolveModule(
    'rendererIdePdfRuntime', './renderer-ide-pdf-runtime');
  const loadDefaultPdfjs = createPdfjsLoader();
  const { FIND_OPTIONS, buildToolbarMarkup, keyAction } = resolveModule(
    'rendererIdePdfToolbar', './renderer-ide-pdf-toolbar');
  const { createPdfSaveState } = resolveModule('rendererIdePdfSaveState', './renderer-ide-pdf-save-state');
  const { createPdfSidebar } = resolveModule('rendererIdePdfSidebar', './renderer-ide-pdf-sidebar');
  const { createPdfReadingContext } = resolveModule('rendererIdePdfReadingContext', './renderer-ide-pdf-reading-context');
  const { closePasswordPrompt, focusPasswordPrompt, openPasswordPrompt } = resolveModule(
    'rendererIdePdfPassword', './renderer-ide-pdf-password');
  // Resolves load()'s parse race when pdf.js asks for a password.
  const LOCKED = Symbol('locked');

  function createIdePdfPane(deps) {
    const getHost = typeof deps?.getHost === 'function' ? deps.getHost : () => null;
    const onDirtyChange = typeof deps?.onDirtyChange === 'function' ? deps.onDirtyChange : () => {};
    const onSaveRequest = typeof deps?.onSaveRequest === 'function' ? deps.onSaveRequest : () => {};
    const onEdit = typeof deps?.onEdit === 'function' ? deps.onEdit : () => {};
    const log = typeof deps?.log === 'function' ? deps.log : () => {};
    const loadPdfjs = typeof deps?.loadPdfjs === 'function' ? deps.loadPdfjs : loadDefaultPdfjs;
    // "Ask Jenny" on a selection arms the chat's active-file context for this tab.
    const onAsk = typeof deps?.onAsk === 'function' ? deps.onAsk
      : () => globalRef.rendererIdeActiveFileContext?.askAboutActiveFile?.();
    const canAsk = typeof deps?.canAsk === 'function' ? deps.canAsk
      : () => globalRef.rendererIdeActiveFileContext?.canAsk?.() === true;
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const textField = resolveModule('inventoryTextField', '../inventory/text-field');
    const documents = new Map();
    const generations = new Map();
    let generationCounter = 0;
    // Candidate records: parsed but not yet committed over the live record.
    const pending = new Map();
    // Restored page/zoom not yet applied: show() applies it (a hidden
    // scroller cannot keep an offset) and getViewPosition reports it meanwhile.
    const pendingViews = new Map();

    let paneEl = null;
    let docsEl = null;
    let errorEl = null;
    let pageFieldEl = null;
    let pageReadoutEl = null;
    let findFieldEl = null;
    let findReadoutEl = null;
    let resizeObserver = null;
    let sidebar = null;
    let reading = null;
    let refitTimer = null;
    let currentPath = null;
    let disposed = false;
    let api = null;

    function ensurePane() {
      if (paneEl) return paneEl;
      const host = getHost();
      const documentRef = host?.ownerDocument || null;
      if (!host || !documentRef || disposed) return null;
      paneEl = documentRef.createElement('div');
      paneEl.className = 'ide-pdf-pane hidden';
      // Ctrl+S saves in the bubble phase so a focused pdf.js FreeText editor
      // commits first; the #ideView capture handler defers to this marker.
      paneEl.dataset.ideSaveShortcut = 'pane';
      paneEl.innerHTML = buildToolbarMarkup({ actionButton, textField })
        + '<div class="ide-pdf-error hidden" role="status"></div>'
        + '<div class="ide-pdf-body"><div class="ide-pdf-documents"></div></div>';
      docsEl = paneEl.querySelector('.ide-pdf-documents');
      sidebar = createPdfSidebar({
        documentRef,
        log: safeLog,
        onPage: (page) => { const record = activeRecord(); if (record) changePage(record, page); },
        onDestination: (dest) => activeRecord()?.linkService.goToDestination(dest)?.catch?.((error) => {
          safeLog('warn', 'ide.pdf.destination_failed', { message: String(error?.message || error) });
        }),
      });
      docsEl.before(sidebar.element);
      reading = createPdfReadingContext({ documentRef, hostEl: docsEl, log: safeLog, canAsk, onAsk: (path) => onAsk(path) });
      errorEl = paneEl.querySelector('.ide-pdf-error');
      pageFieldEl = paneEl.querySelector('[data-ide-pdf-page]');
      pageReadoutEl = paneEl.querySelector('.ide-pdf-page-readout');
      findFieldEl = paneEl.querySelector('[data-ide-pdf-find]');
      findReadoutEl = paneEl.querySelector('.ide-pdf-find-readout');
      paneEl.addEventListener('click', handleClick);
      paneEl.addEventListener('keydown', handleKeydown);
      paneEl.addEventListener('focusout', handleEditorInteraction);
      // Document-level: pdf.js editing listens on window/document, so the
      // pane must see focus and pointer moves that happen outside it.
      documentRef.addEventListener('pointerdown', handleDocumentFocusMove, true);
      documentRef.addEventListener('focusin', handleDocumentFocusMove, true);
      documentRef.addEventListener('pointerup', handleEditorInteraction, true);
      documentRef.addEventListener('keyup', handleEditorInteraction, true);
      const ResizeObserverRef = documentRef.defaultView?.ResizeObserver;
      if (typeof ResizeObserverRef === 'function') {
        resizeObserver = new ResizeObserverRef(scheduleRefit);
        resizeObserver.observe(docsEl);
      }
      host.appendChild(paneEl);
      refreshToolbar();
      return paneEl;
    }

    function nextGeneration(path) {
      const generation = ++generationCounter;
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
      if (!record || record.dirty === dirty) return;
      record.dirty = dirty;
      onDirtyChange(path, dirty);
    }

    const saveState = createPdfSaveState({
      isLive: (record) => documents.get(record.path) === record,
      onEdit,
      setDirty,
      log: safeLog,
    });
    const scheduleStorageCheck = saveState.schedule;

    function isPaneVisible() {
      return Boolean(paneEl && !paneEl.classList.contains('hidden'));
    }

    // While a pdf.js editor mode is on, its window keydown and document
    // copy/cut/paste listeners swallow Backspace, Delete, Ctrl+A/Z/Y and the
    // clipboard in every textarea of the app (its checker only exempts text
    // and number input elements). So the mode is suspended whenever the user
    // works outside this pane, and resumed on return.
    function applyEditorMode(record, modeName) {
      try {
        record.pdfViewer.annotationEditorMode = { mode: record.modeValues[modeName] };
        return true;
      } catch (error) {
        safeLog('warn', 'ide.pdf.editor_mode_failed', { path: record.path, message: String(error?.message || error) });
        return false;
      }
    }

    function suspendEditing(record) {
      if (!record || record.editorSuspended || record.state.editorMode === 'none') return;
      record.editorSuspended = true;
      applyEditorMode(record, 'none');
      // Leaving the mode commits the active editor.
      scheduleStorageCheck(record);
    }

    function resumeEditing(record) {
      if (!record.editorSuspended) return;
      record.editorSuspended = false;
      applyEditorMode(record, record.state.editorMode);
    }

    function isDocumentRoot(target) {
      const documentRef = paneEl.ownerDocument;
      return target === documentRef.body || target === documentRef.documentElement;
    }

    function handleDocumentFocusMove(event) {
      const record = activeRecord();
      const target = event.target;
      if (!record || !paneEl || typeof target?.nodeType !== 'number') return;
      if (docsEl.contains(target)) {
        if (isPaneVisible()) resumeEditing(record);
      } else if (!paneEl.contains(target) && !isDocumentRoot(target)) {
        suspendEditing(record);
      }
    }

    // Gestures on the pages can change annotations; pdf.js shortcuts (undo,
    // delete) also act with focus on the body. Toolbar typing cannot.
    function handleEditorInteraction(event) {
      const record = activeRecord();
      if (record && isPaneVisible() && (docsEl.contains(event.target) || isDocumentRoot(event.target))) {
        saveState.scheduleAfterGesture(record);
      }
    }

    function detachHelpers() {
      sidebar?.detach();
      reading?.detach();
    }

    function showError(message) {
      ensurePane();
      detachHelpers();
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
      if (errorEl) errorEl.textContent = '';
    }

    function makeLoadFailure(code) {
      const messages = {
        document_stale: jt('ide.pdf.staleReload', 'The document changed before the reload could be applied.'),
        document_corrupt: jt('ide.pdf.corrupt', 'Could not open this PDF because it is corrupted or incomplete.'),
        document_unsupported: jt('ide.pdf.passwordFailed', 'This PDF needs a password that did not work.'),
        document_too_large: jt('ide.pdf.tooLarge', 'This PDF is too large to open.'),
        document_engine_unavailable: jt('ide.pdf.engineUnavailable', 'The PDF viewer is unavailable.'),
      };
      return { ok: false, code, message: messages[code] };
    }

    function classifyDocumentError(error) {
      return makeLoadFailure(error?.name === 'PasswordException' ? 'document_unsupported' : 'document_corrupt');
    }

    function addBusListener(record, name, listener) {
      record.eventBus.on(name, listener);
      record.busListeners.push([name, listener]);
    }

    function refreshIfCurrent(record) {
      if (record.path === currentPath) refreshToolbar();
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
      refreshIfCurrent(record);
    }

    function bindViewerEvents(record) {
      addBusListener(record, 'pagechanging', (detail) => {
        record.state.pageNumber = Number(detail?.pageNumber) || record.pdfViewer.currentPageNumber || 1;
        sidebar?.setPage(record.path, record.state.pageNumber);
        reading?.setPage(record.path, record.state.pageNumber);
        refreshIfCurrent(record);
      });
      addBusListener(record, 'scalechanging', (detail) => {
        record.state.scale = detail?.presetValue || detail?.scale || record.pdfViewer.currentScaleValue;
        refreshIfCurrent(record);
      });
      // Counts arrive while pages are searched; the control state carries the
      // selected match after next/previous and the reset for a query with no
      // hits, which never emits a count.
      addBusListener(record, 'updatefindmatchescount', (detail) => updateFindMatch(record, detail));
      addBusListener(record, 'updatefindcontrolstate', (detail) => updateFindMatch(record, detail));
      addBusListener(record, 'annotationeditormodechanged', (detail) => {
        // A suspension is not the user's choice; the toolbar keeps the mode.
        // pdf.js defers entering a mode until annotated pages render, so a
        // suspension can land first: undo the late entry.
        if (record.editorSuspended) {
          if (detail?.mode !== record.modeValues.none) applyEditorMode(record, 'none');
          return;
        }
        record.state.editorMode = record.modeNames.get(detail?.mode) || record.state.editorMode;
        refreshIfCurrent(record);
      });
      addBusListener(record, 'annotationeditorstateschanged', () => scheduleStorageCheck(record));
    }

    function destroyRecord(record) {
      if (!record || record.destroyed) return;
      record.destroyed = true;
      record.resolvePagesInit?.();
      if (record.pdfDocument?.annotationStorage) {
        record.pdfDocument.annotationStorage.onSetModified = null;
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
      // Only a document that was on screen and is now gone (a failed reload
      // after commit) shows the error in place. A failed first open closes
      // its tab and toasts, so it must not cover whatever is active now; a
      // failed reload before commit keeps the live document.
      if (!documents.has(record.path) && currentPath === record.path) showError(failure.message);
      safeLog('warn', 'ide.pdf.load_failed', { path: record.path, code: failure.code });
      return failure;
    }

    function discardPending(record, failure) {
      if (pending.get(record.path) === record) pending.delete(record.path);
      // A vetoed first open leaves no token behind; a newer load keeps its own.
      if (generations.get(record.path) === record.generation && !documents.has(record.path)) generations.delete(record.path);
      destroyRecord(record);
      return failure;
    }

    // A record that lost its turn while awaiting is discarded as stale; a
    // current one fails with `failure`.
    function failOrStale(record, failure) {
      return isCurrent(record)
        ? removeFailedRecord(record, failure)
        : discardPending(record, makeLoadFailure('document_stale'));
    }

    function createRecord(path, generation) {
      const documentRef = paneEl.ownerDocument;
      const container = documentRef.createElement('div');
      container.className = 'ide-pdf-doc hidden';
      container.innerHTML = '<div class="ide-pdf-viewer-scroll" tabindex="0"><div class="pdfViewer"></div></div>';
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
        editorSuspended: false,
        savedHash: null,
        seenHash: null,
        exportedHash: null,
        storageCheckQueued: false,
        scroll: null,
        // In memory for this tab only; reused by a reload, never persisted or logged.
        password: null,
        passwordRefused: false,
        isLocked: false,
        state: {
          pageNumber: 1,
          pageCount: 0,
          scale: 'page-width',
          editorMode: 'none',
          findQuery: '',
          findMatch: null,
          findOptions: { caseSensitive: false, entireWord: false, matchDiacritics: false },
        },
      };
    }

    async function load(path, source) {
      if (!ensurePane()) {
        return makeLoadFailure('document_engine_unavailable');
      }
      const generation = nextGeneration(path);
      const existing = documents.get(path);
      // The live record (and its dirty state) survives until the candidate
      // has parsed, passed the page budget, and the caller's commit fence.
      const staleCandidate = pending.get(path);
      if (staleCandidate) discardPending(staleCandidate, null);
      const record = createRecord(path, generation);
      record.password = existing?.password || null;
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
        return failOrStale(record, makeLoadFailure('document_engine_unavailable'));
      }
      if (!isCurrent(record)) {
        return discardPending(record, makeLoadFailure('document_stale'));
      }

      const { pdfjs } = modules;
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
        const lockSignal = new Promise((resolve) => {
          record.loadingTask.onPassword = (updatePassword, reason) => handlePassword(record, existing, modules, updatePassword, reason, resolve);
        });
        const parsed = await Promise.race([record.loadingTask.promise, lockSignal]);
        if (parsed === LOCKED) return commitLocked(record, existing, source, modules);
        record.pdfDocument = parsed;
        const refused = await checkParsed(record);
        if (refused) return refused;
      } catch (error) {
        return failOrStale(record, record.passwordRefused ? makeLoadFailure('document_unsupported') : classifyDocumentError(error));
      }
      if (typeof source?.shouldCommit === 'function' && source.shouldCommit() !== true) {
        return discardPending(record, makeLoadFailure('document_stale'));
      }
      return mountViewer(record, modules, commitRecord(record, existing));
    }

    // The candidate replaces the live record from here on. A reload keeps the
    // reader's place and zoom: returns the scale to re-apply, or null.
    function commitRecord(record, existing) {
      pending.delete(record.path);
      let reloadScale = null;
      if (existing) {
        leaveRecord(existing);
        record.scroll = existing.scroll;
        if (!existing.isLocked) {
          reloadScale = existing.state.scale;
          // Reported by getViewPosition until show() restores the scroll.
          if (record.pdfDocument) record.state.pageNumber = Math.min(existing.state.pageNumber, record.pdfDocument.numPages);
        }
        setDirty(record.path, false);
        destroyRecord(existing);
      }
      documents.set(record.path, record);
      clearError();
      reading?.reset(record.path);
      sidebar?.forget(record.path);
      return reloadScale;
    }

    // PDFViewer.setDocument only logs a broken first page and never
    // dispatches pagesinit; refusing it here keeps a live reload intact.
    // Returns a failure result, or null when the parsed document is usable.
    async function checkParsed(record) {
      if (isCurrent(record)) await record.pdfDocument.getPage(1);
      if (!isCurrent(record)) return discardPending(record, makeLoadFailure('document_stale'));
      if ((Number(record.pdfDocument.numPages) || 0) > MAX_PDF_PAGES) {
        return removeFailedRecord(record, makeLoadFailure('document_too_large'));
      }
      return null;
    }

    // pdf.js asks again (INCORRECT_PASSWORD) after a wrong entry. A reload
    // first reuses the tab's password; a reload whose password stopped
    // working fails and keeps the live document (its prompt would be hidden).
    function handlePassword(record, existing, modules, updatePassword, reason, lock) {
      if (record.destroyed) return;
      const incorrect = reason === (modules.pdfjs.PasswordResponses?.INCORRECT_PASSWORD ?? 2);
      if (record.password && !incorrect) {
        updatePassword(record.password);
        return;
      }
      record.password = null;
      if (existing && !existing.isLocked) {
        record.passwordRefused = true;
        record.loadingTask.destroy();
        return;
      }
      lock(LOCKED);
      openPasswordPrompt(record.container, { actionButton, textField, incorrect }).then((password) => {
        if (record.destroyed) return;
        record.password = password;
        updatePassword(password);
      });
      if (record.path === currentPath && isPaneVisible()) focusPasswordPrompt(record.container);
    }

    // An encrypted first open commits a locked record so its tab opens and
    // shows the prompt in place (never over another tab); the viewer mounts
    // once pdf.js accepts a password.
    async function commitLocked(record, existing, source, modules) {
      if (!isCurrent(record)) return discardPending(record, makeLoadFailure('document_stale'));
      if (typeof source?.shouldCommit === 'function' && source.shouldCommit() !== true) {
        return discardPending(record, makeLoadFailure('document_stale'));
      }
      commitRecord(record, existing);
      record.isLocked = true;
      if (currentPath === record.path && isPaneVisible()) show(record.path);
      const isLive = () => !record.destroyed && documents.get(record.path) === record;
      record.loadingTask.promise.then(async (pdfDocument) => {
        if (!isLive()) return;
        // A reload that failed or was vetoed while the prompt was up leaves
        // this record live with a stale token: the accepted password wins.
        record.generation = nextGeneration(record.path);
        record.pdfDocument = pdfDocument;
        if (await checkParsed(record)) return;
        record.isLocked = false;
        closePasswordPrompt(record.container);
        await mountViewer(record, modules, null);
      }).catch((error) => {
        if (isLive()) removeFailedRecord(record, classifyDocumentError(error));
      });
      return { ok: true, pageCount: 0, locked: true };
    }

    async function mountViewer(record, modules, reloadScale) {
      const { path } = record;
      try {
        Object.assign(record, createViewerParts(modules, {
          container: scrollerOf(record),
          viewerElement: record.container.querySelector('.pdfViewer'),
        }));
        record.modeNames = new Map(Object.entries(record.modeValues).map(([name, value]) => [value, name]));
        record.state.pageCount = record.pdfDocument.numPages;
        saveState.track(record);
        bindViewerEvents(record);
        const pagesInit = new Promise((resolve) => {
          record.resolvePagesInit = resolve;
          addBusListener(record, 'pagesinit', resolve);
        });
        record.pdfViewer.setDocument(record.pdfDocument);
        record.linkService.setDocument(record.pdfDocument, null);
        // pagesPromise rejects when setDocument fails after the first page,
        // which would otherwise leave pagesinit pending forever.
        await Promise.race([pagesInit, Promise.resolve(record.pdfViewer.pagesPromise).then(() => pagesInit)]);
        if (!isCurrent(record)) return makeLoadFailure('document_stale');
        // Defer scale measurement until show(): this candidate is still hidden.
        record.state.scale = reloadScale || 'page-width';
      } catch (error) {
        safeLog('warn', 'ide.pdf.viewer_init_failed', { message: String(error?.message || error) });
        if (!isCurrent(record)) return makeLoadFailure('document_stale');
        return removeFailedRecord(record, makeLoadFailure('document_engine_unavailable'));
      }

      // Re-show only if this path is still the visible document now: the
      // user may have switched tabs while the reload parsed.
      if (currentPath === path && isPaneVisible()) {
        show(path);
      }
      return { ok: true, pageCount: record.state.pageCount };
    }

    // The visible document once its viewer is mounted (not while locked).
    function activeRecord() {
      const record = currentPath ? documents.get(currentPath) : null;
      return record?.pdfViewer ? record : null;
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
      if (findReadoutEl) {
        findReadoutEl.textContent = jt('ide.pdf.findReadout', '{current} of {total}', {
          current: state?.findMatch?.current || 0,
          total: state?.findMatch?.total || 0,
        });
      }
      for (const element of paneEl?.querySelectorAll('.ide-pdf-mode-button') || []) {
        const mode = EDITOR_MODE_BY_ACTION[element.dataset.idePdfAction];
        element.setAttribute('aria-pressed', String(Boolean(state && state.editorMode === mode)));
      }
      paneEl?.querySelector('[data-ide-pdf-action="sidebar"]')?.setAttribute('aria-pressed', String(Boolean(sidebar?.isOpen())));
      for (const [action, key] of Object.entries(FIND_OPTIONS)) {
        paneEl?.querySelector(`[data-ide-pdf-action="${action}"]`)
          ?.setAttribute('aria-pressed', String(Boolean(state?.findOptions[key])));
      }
    }

    function scrollerOf(record) {
      return record.container.querySelector('.ide-pdf-viewer-scroll');
    }

    // A display:none scroller loses its offset, so a hidden document
    // remembers where the reader was and show() puts it back.
    function leaveRecord(record) {
      if (!record) return;
      suspendEditing(record);
      if (isPaneVisible()) {
        const scroller = scrollerOf(record);
        record.scroll = { top: scroller.scrollTop, left: scroller.scrollLeft };
      }
    }

    function show(path) {
      const record = documents.get(path);
      if (!record || record.destroyed || !(record.pdfViewer || record.isLocked) || !ensurePane()) {
        return false;
      }
      if (currentPath !== path) {
        leaveRecord(activeRecord());
        // The find field shows the visible document's query; a refresh while
        // the user types must not overwrite it.
        if (findFieldEl) findFieldEl.value = record.state.findQuery;
      }
      currentPath = path;
      clearError();
      for (const candidate of documents.values()) {
        candidate.container.classList.toggle('hidden', candidate !== record);
      }
      paneEl.classList.remove('hidden');
      if (record.isLocked) {
        detachHelpers();
        refreshToolbar();
        focusPasswordPrompt(record.container);
        return true;
      }
      sidebar?.attach(path, { pdfDocument: record.pdfDocument, pageCount: record.state.pageCount, pageNumber: record.state.pageNumber });
      reading?.attach(path, {
        pdfDocument: record.pdfDocument, viewerEl: record.container.querySelector('.pdfViewer'),
        pageCount: record.state.pageCount, pageNumber: record.state.pageNumber,
      });
      const view = pendingViews.get(path);
      pendingViews.delete(path);
      if (view?.zoom) record.state.scale = view.zoom;
      record.pdfViewer.currentScaleValue = record.state.scale;
      record.pdfViewer.update();
      const restorePage = view?.page;
      if (restorePage) {
        record.scroll = null;
        changePage(record, restorePage);
      }
      // Restored once: re-activating the visible document keeps where the
      // reader has scrolled since.
      if (record.scroll) {
        const scroller = scrollerOf(record);
        scroller.scrollTop = record.scroll.top;
        scroller.scrollLeft = record.scroll.left;
        record.scroll = null;
      }
      // Activation alone (a tab click, Quick Open) leaves focus elsewhere;
      // the mode resumes on the first interaction with the pages.
      if (docsEl.contains(paneEl.ownerDocument.activeElement)) resumeEditing(record);
      refreshToolbar();
      return true;
    }

    function hide() {
      leaveRecord(activeRecord());
      detachHelpers();
      paneEl?.classList.add('hidden');
    }

    // Fit presets are measured against the scroller, so they are re-applied
    // when the editor column resizes (chat dock, splitters, window).
    function refitActiveRecord() {
      const record = activeRecord();
      if (!record || !isPaneVisible() || !FIT_SCALES.has(record.state.scale)) return;
      record.pdfViewer.currentScaleValue = record.state.scale;
    }

    function scheduleRefit() {
      globalRef.clearTimeout(refitTimer);
      refitTimer = globalRef.setTimeout(() => {
        refitTimer = null;
        refitActiveRecord();
      }, REFIT_DELAY_MS);
    }

    function close(path) {
      generations.delete(path);
      pendingViews.delete(path);
      // A pending candidate is not in `documents`: cancel its parse here too.
      const candidate = pending.get(path);
      if (candidate) discardPending(candidate, null);
      const record = documents.get(path);
      if (!record) return;
      setDirty(path, false);
      documents.delete(path);
      sidebar?.forget(path);
      reading?.forget(path);
      destroyRecord(record);
      if (currentPath === path) {
        currentPath = null;
        paneEl?.classList.add('hidden');
        refreshToolbar();
      }
    }

    function changePage(record, value) {
      const requested = Math.round(Number(value));
      if (String(value ?? '').trim() === '' || !Number.isFinite(requested)) {
        refreshToolbar();
        return;
      }
      const pageNumber = Math.max(1, Math.min(record.state.pageCount, requested));
      record.pdfViewer.currentPageNumber = pageNumber;
      record.state.pageNumber = pageNumber;
      refreshToolbar();
    }

    function setScale(record, scale) {
      record.pdfViewer.currentScaleValue = scale;
      record.state.scale = scale;
      refreshToolbar();
    }

    function changeZoom(record, direction) {
      const current = Number(record.pdfViewer.currentScaleValue) || Number(record.pdfViewer.currentScale) || 1;
      setScale(record, Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, direction === 'in' ? current * ZOOM_STEP : current / ZOOM_STEP)));
    }

    function dispatchFind(record, findPrevious, type) {
      const query = findFieldEl?.value || '';
      if (query !== record.state.findQuery) {
        record.state.findMatch = null;
        refreshToolbar();
      }
      record.state.findQuery = query;
      record.eventBus.dispatch('find', {
        source: api,
        type,
        query,
        ...record.state.findOptions,
        highlightAll: true,
        findPrevious,
      });
    }

    function toggleFindOption(record, action) {
      const key = FIND_OPTIONS[action];
      record.state.findOptions = { ...record.state.findOptions, [key]: !record.state.findOptions[key] };
      refreshToolbar();
      if (record.state.findQuery || findFieldEl?.value) dispatchFind(record, false, '');
    }

    // Esc in the find field: pdf.js clears its highlights on findbarclose.
    function closeFind(record) {
      record.eventBus.dispatch('findbarclose', { source: api });
      record.state.findMatch = null;
      refreshToolbar();
      scrollerOf(record).focus?.({ preventScroll: true });
    }

    function setEditorMode(record, modeName) {
      record.editorSuspended = false;
      if (!applyEditorMode(record, modeName)) return;
      record.state.editorMode = modeName;
      refreshToolbar();
    }

    function runAction(record, action, event) {
      const pageCount = record.state.pageCount;
      if (action === 'prev' || action === 'page-prev') changePage(record, record.state.pageNumber - 1);
      else if (action === 'next' || action === 'page-next') changePage(record, record.state.pageNumber + 1);
      else if (action === 'page-first') changePage(record, 1);
      else if (action === 'page-last') changePage(record, pageCount);
      else if (action === 'zoom-out') changeZoom(record, 'out');
      else if (action === 'zoom-in') changeZoom(record, 'in');
      else if (FIT_SCALE_BY_ACTION[action]) setScale(record, FIT_SCALE_BY_ACTION[action]);
      else if (action === 'find-prev' || action === 'find-next') {
        if (!(findFieldEl?.value || '')) {
          findFieldEl?.focus();
          return true;
        }
        dispatchFind(record, action === 'find-prev', record.state.findQuery === findFieldEl.value ? 'again' : '');
      } else if (FIND_OPTIONS[action]) toggleFindOption(record, action);
      else if (action === 'find-close') closeFind(record);
      else if (action === 'sidebar') {
        sidebar?.toggle();
        refreshToolbar();
      }
      else if (EDITOR_MODE_BY_ACTION[action]) setEditorMode(record, EDITOR_MODE_BY_ACTION[action]);
      else return false;
      event?.preventDefault?.();
      return true;
    }

    function handleClick(event) {
      const action = event.target?.closest?.('[data-ide-pdf-action]')?.dataset.idePdfAction;
      const record = activeRecord();
      if (action && record) runAction(record, action);
    }

    function handleKeydown(event) {
      const action = keyAction(event);
      if (action === 'save') {
        event.preventDefault();
        event.stopPropagation();
        onSaveRequest();
        return;
      }
      if (action === 'find-focus') {
        event.preventDefault();
        event.stopPropagation();
        findFieldEl?.focus();
        findFieldEl?.select();
        return;
      }
      const record = activeRecord();
      if (!record) return;
      if (action) {
        runAction(record, action, event);
        return;
      }
      if (event.key !== 'Enter' || event.isComposing) return;
      if (event.target?.matches?.('[data-ide-pdf-page]')) {
        changePage(record, event.target.value);
      } else if (event.target?.matches?.('[data-ide-pdf-find]')) {
        dispatchFind(record, event.shiftKey, record.state.findQuery ? 'again' : '');
      }
    }

    function hasDocument(path) {
      const record = documents.get(path);
      return Boolean(record && !record.destroyed && (record.pdfDocument || record.isLocked));
    }

    // What the reader is looking at, for the chat's active-file context.
    function getReadingContext(path, options) {
      const record = documents.get(path);
      return record?.pdfViewer && !record.destroyed ? reading?.getContext(path, options) || null : null;
    }

    function isDirty(path) {
      return Boolean(documents.get(path)?.dirty);
    }

    function markSaved(path) {
      const record = documents.get(path);
      if (record?.pdfViewer) saveState.markSaved(record);
    }

    async function exportBytes(path) {
      const record = documents.get(path);
      if (!record?.pdfViewer || record.destroyed) return null;
      return encodeBase64(await saveState.exportData(record));
    }

    function isZoomValue(zoom) {
      return FIT_SCALES.has(zoom) || zoom === 'auto' || zoom === 'page-actual'
        || (Number.isFinite(zoom) && zoom >= ZOOM_MIN && zoom <= ZOOM_MAX);
    }

    // A restored view not yet shown is still the tab's position.
    function getViewPosition(path) {
      const record = documents.get(path);
      if (!record?.pdfDocument || record.destroyed) return null;
      const view = pendingViews.get(path);
      const scale = view?.zoom ?? record.state.scale;
      const zoom = typeof scale === 'string' ? scale : Number(scale);
      return { page: view?.page || record.state.pageNumber, zoom: isZoomValue(zoom) ? zoom : 'page-width' };
    }

    function restoreViewPosition(path, position) {
      const page = Number.isSafeInteger(position?.page) && position.page >= 1 ? position.page : null;
      const zoom = isZoomValue(position?.zoom) ? position.zoom : null;
      if (!page && !zoom) return false;
      pendingViews.set(path, { page, zoom });
      if (path === currentPath && isPaneVisible()) show(path);
      return true;
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
      for (const candidate of [...pending.values()]) discardPending(candidate, null);
      for (const path of [...documents.keys()]) close(path);
      generations.clear();
      pendingViews.clear();
      resizeObserver?.disconnect();
      resizeObserver = null;
      globalRef.clearTimeout(refitTimer);
      refitTimer = null;
      sidebar?.dispose();
      reading?.dispose();
      sidebar = null;
      reading = null;
      if (paneEl) {
        const documentRef = paneEl.ownerDocument;
        documentRef.removeEventListener('pointerdown', handleDocumentFocusMove, true);
        documentRef.removeEventListener('focusin', handleDocumentFocusMove, true);
        documentRef.removeEventListener('pointerup', handleEditorInteraction, true);
        documentRef.removeEventListener('keyup', handleEditorInteraction, true);
        paneEl.removeEventListener('click', handleClick);
        paneEl.removeEventListener('keydown', handleKeydown);
        paneEl.removeEventListener('focusout', handleEditorInteraction);
        paneEl.remove();
      }
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
      getReadingContext,
      getViewPosition,
      restoreViewPosition,
      dispose,
    };
    return api;
  }

  return { createIdePdfPane };
});
