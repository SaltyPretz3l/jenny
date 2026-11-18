/* renderer/features/renderer-ide-docx-views.js - the DOCX pane's mode bar and
 * its two read-only views. Read draws the document with docx-preview inside a
 * shadow root; Pages shows a PDF the main process made with Word or
 * LibreOffice, in the PDF pane's pdf.js viewer stack. Edit is the patch
 * editor in renderer-ide-docx-host.js, which owns the documents and hands this
 * module their bytes and state version. Nothing here ever writes a document. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeDocxViews = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const MODES = Object.freeze(['read', 'edit', 'pages']);
  const ENGINE_NAMES = Object.freeze({ word: 'Word', libreoffice: 'LibreOffice' });
  // Same trailing delay as the PDF pane: a refit re-rasterizes the visible pages.
  const REFIT_DELAY_MS = 120;
  // A render that finds the document edited meanwhile starts over, a bounded number of times.
  const MAX_STALE_RESTARTS = 2;
  // The document is untrusted: no embedded fonts (the CSP forbids them), no
  // altChunk iframes, no comments, and blob URLs for images (revoked on release).
  const READ_OPTIONS = Object.freeze({
    className: 'docx',
    inWrapper: true,
    ignoreWidth: false,
    ignoreHeight: false,
    ignoreFonts: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderComments: false,
    renderAltChunks: false,
    renderChanges: true,
    useBase64URL: false,
    experimental: false,
    trimXmlDeclaration: true,
  });

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  const unavailableMessage = () => jt('ide.docx.pagesUnavailable', 'Pages needs Microsoft Word or LibreOffice installed.');

  function pagesFailureMessage(reason) {
    if (reason === 'busy') return jt('ide.docx.pagesBusy', 'Another document is being converted. Try again in a moment.');
    if (reason === 'timeout') return jt('ide.docx.pagesTimeout', 'Making pages took too long.');
    if (reason === 'too_large') return jt('ide.docx.pagesTooLarge', 'This document is too large to convert.');
    return jt('ide.docx.pagesFailed', 'Pages could not be made from this document.');
  }

  function createDocxViews(deps) {
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const readSafety = resolveModule('rendererIdeDocxReadSafety', './renderer-ide-docx-read-safety');
    const { decodeBase64, encodeBase64 } = resolveModule('rendererBytesBase64', '../shared/bytes-base64') || {};
    const getPane = typeof deps?.getPane === 'function' ? deps.getPane : () => null;
    const getCurrentPath = typeof deps?.getCurrentPath === 'function' ? deps.getCurrentPath : () => null;
    // The host's record for an open path: { model, sourceBytes, sourceVersion }.
    const getRecord = typeof deps?.getRecord === 'function' ? deps.getRecord : () => null;
    const exportBytes = typeof deps?.exportBytes === 'function' ? deps.exportBytes : async () => null;
    const getApi = typeof deps?.getWorkspaceFsApi === 'function' ? deps.getWorkspaceFsApi : () => globalRef.jennyShell?.workspaceFs || null;
    const scriptLoader = deps?.scriptLoader || globalRef.scriptLoaderUtils || null;
    // The PDF pane's pdf.js runtime and stylesheet, loaded on the first Pages
    // view (bytes-base64.js, its one dependency, is already in the DOCX runtime).
    // Lives here, not in the eagerly loaded editor-host-panes, to cost startup nothing.
    const loadPdfViewer = typeof deps?.loadPdfViewer === 'function' ? deps.loadPdfViewer : async () => {
      const ready = () => Boolean(globalRef.rendererIdePdfRuntime);
      const src = 'renderer/features/renderer-ide-pdf-runtime.js';
      if (!ready() && !(await scriptLoader?.ensureScript?.({ src, isReady: ready, log }))) return null;
      const documentRef = paneEl?.ownerDocument;
      const href = 'styles/ide-pdf-pane.css';
      if (documentRef?.head && !documentRef.head.querySelector(`link[data-ide-document-style="${href}"]`)) {
        const link = documentRef.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.setAttribute('data-ide-document-style', href);
        documentRef.head.appendChild(link);
      }
      return disposed ? null : globalRef.rendererIdePdfRuntime || null;
    };
    const onSaveRequest = typeof deps?.onSaveRequest === 'function' ? deps.onSaveRequest : () => {};
    const log = typeof deps?.log === 'function' ? deps.log : () => {};
    const states = new Map();

    let docxPreview = deps?.docxPreview || null;
    let mode = 'read';
    let paneEl = null;
    let barEl = null;
    let viewsEl = null;
    let engines;
    let enginesPromise = null;
    let loadPdfjs = null;
    let resizeObserver = null;
    let refitTimer = null;
    let disposed = false;

    // The state version of an open document (null: not open). Edits, undo and redo all move it.
    const getVersion = (path) => getRecord(path)?.model.getStateVersion() ?? null;

    // The document's bytes as a Uint8Array or base64: what it was loaded from
    // while unedited, otherwise what the editor would save.
    async function getSource(path, form) {
      const record = getRecord(path);
      if (!record) return null;
      if (record.model.getStateVersion() === record.sourceVersion) {
        return form === 'base64' ? encodeBase64(record.sourceBytes) : record.sourceBytes;
      }
      const base64 = await exportBytes(path);
      return form === 'base64' || !base64 ? base64 : decodeBase64(base64);
    }

    function safeLog(level, event, fields) {
      try {
        log(level, event, fields);
      } catch (_error) {
        /* logging is non-fatal */
      }
    }

    // ── Mode bar ──

    function modeButton(name, label) {
      return actionButton({
        plain: true,
        className: 'ide-docx-action ide-docx-mode-button',
        label,
        ariaPressed: name === 'read',
        dataset: { 'ide-docx-mode': name },
      });
    }

    function barMarkup() {
      return '<div class="ide-docx-modebar" role="group" aria-label="' + actionButton.escapeHtml(jt('ide.docx.modeBar', 'Document view')) + '">'
        + modeButton('read', jt('ide.docx.mode.read', 'Read'))
        + modeButton('edit', jt('ide.docx.mode.edit', 'Edit'))
        + modeButton('pages', jt('ide.docx.mode.pages', 'Pages'))
        + '<span class="ide-docx-modebar-spacer"></span>'
        + actionButton({
          plain: true,
          className: 'ide-docx-action ide-docx-open-default',
          label: jt('ide.docx.openDefault', 'Open in default app'),
          dataset: { 'ide-docx-open-default': 'true' },
        })
        + '</div>';
    }

    function refreshBar() {
      if (!barEl) return;
      for (const button of barEl.querySelectorAll('[data-ide-docx-mode]')) {
        button.setAttribute('aria-pressed', String(button.dataset.ideDocxMode === mode));
      }
      const pages = barEl.querySelector('[data-ide-docx-mode="pages"]');
      pages.disabled = !engines;
      if (engines === null) pages.title = unavailableMessage();
      else pages.removeAttribute('title');
      barEl.querySelector('[data-ide-docx-open-default]').disabled = typeof getApi()?.openInDefaultApp !== 'function';
    }

    // Asked once per pane, on its first show. A missing method, a rejection, a
    // switched-off feature and an empty list all mean "no engine".
    function ensureEngines() {
      if (enginesPromise) return enginesPromise;
      const api = getApi();
      if (typeof api?.getDocumentPageEngines !== 'function') {
        engines = null;
        enginesPromise = Promise.resolve(null);
        refreshBar();
        return enginesPromise;
      }
      enginesPromise = (async () => {
        try {
          const result = await api.getDocumentPageEngines();
          const list = Array.isArray(result?.engines) ? result.engines.filter((name) => Object.hasOwn(ENGINE_NAMES, name)) : [];
          engines = result?.enabled === true && list.length ? list : null;
        } catch (_error) {
          engines = null;
        }
        if (!disposed) refreshBar();
        return engines;
      })();
      return enginesPromise;
    }

    function setMode(next) {
      if (!MODES.includes(next) || next === mode || (next === 'pages' && !engines)) return;
      mode = next;
      if (paneEl) paneEl.dataset.mode = mode;
      show(getCurrentPath());
    }

    function openDefault() {
      const path = getCurrentPath();
      const api = getApi();
      if (!path || typeof api?.openInDefaultApp !== 'function') return;
      Promise.resolve().then(() => api.openInDefaultApp({ path }))
        .catch((error) => safeLog('WARN', 'ide.docx_open_default_failed', { message: String(error?.message || error) }));
    }

    function handleClick(event) {
      const target = event.target;
      const modeTarget = target?.closest?.('[data-ide-docx-mode]');
      if (modeTarget) {
        if (!modeTarget.disabled) setMode(modeTarget.dataset.ideDocxMode);
      } else if (target?.closest?.('[data-ide-docx-open-default]')) {
        if (!target.closest('[data-ide-docx-open-default]').disabled) openDefault();
      } else if (target?.closest?.('[data-ide-docx-pages-retry]')) {
        const path = getCurrentPath();
        if (path) renderPages(path, 0, true);
      }
    }

    // Save works in every mode; the keymap defers to the pane (data-ide-save-shortcut).
    function handleKeydown(event) {
      if ((event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        onSaveRequest();
      }
    }

    function mount() {
      paneEl = getPane();
      if (!paneEl || viewsEl) return;
      barEl = paneEl.querySelector('.ide-docx-modebar');
      viewsEl = paneEl.ownerDocument.createElement('div');
      viewsEl.className = 'ide-docx-views hidden';
      paneEl.dataset.mode = mode;
      paneEl.dataset.ideSaveShortcut = 'pane';
      paneEl.appendChild(viewsEl);
      paneEl.addEventListener('click', handleClick);
      paneEl.addEventListener('keydown', handleKeydown);
      const ResizeObserverRef = paneEl.ownerDocument.defaultView?.ResizeObserver;
      if (typeof ResizeObserverRef === 'function') {
        resizeObserver = new ResizeObserverRef(scheduleRefit);
        resizeObserver.observe(viewsEl);
      }
      refreshBar();
    }

    // ── Per-document containers ──

    function stateFor(path) {
      let state = states.get(path);
      if (!state) {
        state = {
          path, readEl: null, shadow: null, readVersion: null, readRendering: null, readToken: 0,
          pagesEl: null, pdf: null, pagesRendering: null, pagesToken: 0,
        };
        states.set(path, state);
      }
      return state;
    }

    // A view container: the status line (message and optional Retry) above the content.
    function createViewEl(className, path) {
      const documentRef = paneEl.ownerDocument;
      const element = documentRef.createElement('div');
      element.className = className + ' hidden';
      element.dataset.path = path;
      const status = documentRef.createElement('div');
      status.className = 'ide-docx-view-status hidden';
      status.setAttribute('role', 'status');
      status.appendChild(documentRef.createElement('span'));
      element.appendChild(status);
      viewsEl.appendChild(element);
      return element;
    }

    function setStatus(element, message, withRetry = false) {
      const status = element?.querySelector('.ide-docx-view-status');
      if (!status) return;
      status.firstChild.textContent = message;
      status.classList.toggle('hidden', !message);
      status.querySelector('[data-ide-docx-pages-retry]')?.remove();
      if (message && withRetry) {
        status.insertAdjacentHTML('beforeend', actionButton({
          plain: true,
          className: 'ide-docx-action ide-docx-pages-retry',
          label: jt('ide.docx.pagesRetry', 'Retry'),
          dataset: { 'ide-docx-pages-retry': 'true' },
        }));
      }
    }

    function release(path) {
      const state = states.get(path);
      if (!state) return;
      states.delete(path);
      state.readToken += 1;
      state.pagesToken += 1;
      clearShadow(state);
      state.readEl?.remove();
      destroyPdf(state.pdf);
      state.pdf = null;
      state.pagesEl?.remove();
    }

    function dispose() {
      if (disposed) return;
      for (const path of [...states.keys()]) release(path);
      disposed = true;
      globalRef.clearTimeout(refitTimer);
      resizeObserver?.disconnect();
      paneEl?.removeEventListener('click', handleClick);
      paneEl?.removeEventListener('keydown', handleKeydown);
      viewsEl?.remove();
      paneEl = null;
      barEl = null;
      viewsEl = null;
    }

    // ── Read ──

    function revokeUrl(url) {
      try {
        (paneEl?.ownerDocument.defaultView?.URL || globalRef.URL)?.revokeObjectURL?.(url);
      } catch (_error) {
        /* already gone */
      }
    }

    function discardNode(node) {
      readSafety.collectBlobUrls(node).forEach(revokeUrl);
      node.remove();
    }

    function clearShadow(state) {
      for (const child of [...(state.shadow?.childNodes || [])]) discardNode(child);
    }

    function readElementFor(state) {
      if (state.readEl) return state.readEl;
      state.readEl = createViewEl('ide-docx-read', state.path);
      state.readEl.tabIndex = 0;
      const body = paneEl.ownerDocument.createElement('div');
      body.className = 'ide-docx-read-body';
      state.readEl.appendChild(body);
      state.shadow = body.attachShadow({ mode: 'open' });
      state.shadow.addEventListener('click', readSafety.handleReadLink);
      state.shadow.addEventListener('auxclick', readSafety.handleReadLink);
      return state.readEl;
    }

    // The sandboxed renderer has no require: JSZip, then docx-preview, load as scripts on the first Read. Monaco's
    // loader marks define.amd, which turns their UMD wrappers into AMD modules, so the marker is hidden for these
    // two loads only (Monaco's modules still call define) and the wrappers set window.JSZip and window.docx.
    async function loadDocxRuntime() {
      const define = typeof globalRef.define === 'function' ? globalRef.define : null;
      const amd = define?.amd;
      if (amd) define.amd = undefined;
      try {
        for (const [src, ready] of [['node_modules/jszip/dist/jszip.min.js', () => Boolean(globalRef.JSZip)],
          ['node_modules/docx-preview/dist/docx-preview.min.js', () => typeof globalRef.docx?.renderAsync === 'function']]) {
          if (!ready() && !(await scriptLoader.ensureScript({ src, isReady: ready, log }))) return null;
        }
        return globalRef.docx;
      } finally { if (amd && define.amd === undefined) define.amd = amd; }
    }

    async function resolveDocxPreview() {
      if (!docxPreview && typeof scriptLoader?.ensureScript === 'function') docxPreview = await loadDocxRuntime();
      docxPreview = docxPreview || resolveModule('docx', 'docx-preview');
      if (typeof docxPreview?.renderAsync !== 'function') throw new Error('docx-preview is unavailable');
      return docxPreview;
    }

    async function renderRead(path, restarts = 0) {
      const state = states.get(path);
      const version = getVersion(path);
      if (!state || version === null || state.readVersion === version || state.readRendering === version) return;
      const readEl = readElementFor(state);
      const token = ++state.readToken;
      state.readRendering = version;
      const active = () => !disposed && states.get(path) === state && state.readToken === token;
      let stage = null;
      try {
        const bytes = await getSource(path, 'bytes');
        if (!active()) return;
        if (!bytes) throw new Error('document bytes are unavailable');
        const docx = await resolveDocxPreview();
        if (!active()) return;
        const documentRef = paneEl.ownerDocument;
        stage = documentRef.createElement('div');
        stage.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;inset-inline-start:0;inset-block-start:0';
        const styleEl = documentRef.createElement('div');
        const bodyEl = documentRef.createElement('div');
        stage.append(styleEl, bodyEl);
        state.shadow.appendChild(stage);
        await docx.renderAsync(bytes, bodyEl, styleEl, READ_OPTIONS);
        if (!active() || getVersion(path) !== version) {
          discardNode(stage);
          stage = null;
          if (active() && restarts < MAX_STALE_RESTARTS && mode === 'read') {
            state.readRendering = null;
            renderRead(path, restarts + 1);
          }
          return;
        }
        readSafety.neutralizeExternalResources(stage);
        for (const child of [...state.shadow.childNodes]) if (child !== stage) discardNode(child);
        stage.removeAttribute('style');
        state.readVersion = version;
        setStatus(readEl, '');
      } catch (error) {
        if (stage) discardNode(stage);
        if (!active()) return;
        state.readVersion = null;
        clearShadow(state);
        setStatus(readEl, jt('ide.docx.readFailed', 'This document could not be shown in the reading view. Switch to Edit to work on it.'));
        safeLog('WARN', 'ide.docx_read_failed', { path, message: String(error?.message || error) });
      } finally {
        if (states.get(path) === state && state.readToken === token) state.readRendering = null;
      }
    }

    // ── Pages ──

    function destroyPdf(pdf) {
      if (!pdf) return;
      try {
        pdf.parts?.pdfViewer.cleanup();
        pdf.parts?.pdfViewer.setDocument(null);
        pdf.parts?.linkService.setDocument(null, null);
      } catch (error) {
        safeLog('WARN', 'ide.docx_pages_cleanup_failed', { message: String(error?.message || error) });
      }
      try {
        const destroyed = pdf.pdfDocument ? pdf.pdfDocument.destroy() : pdf.task?.destroy();
        destroyed?.catch?.(() => {});
      } catch (_error) {
        /* already destroyed */
      }
      pdf.scroller.remove();
    }

    function fitPages(state) {
      const viewer = state?.pdf?.parts?.pdfViewer;
      if (!viewer || state.pagesEl.classList.contains('hidden')) return;
      try {
        viewer.currentScaleValue = 'page-width';
        viewer.update();
      } catch (error) {
        safeLog('WARN', 'ide.docx_pages_fit_failed', { message: String(error?.message || error) });
      }
    }

    function scheduleRefit() {
      globalRef.clearTimeout(refitTimer);
      refitTimer = globalRef.setTimeout(() => {
        refitTimer = null;
        if (mode === 'pages') fitPages(states.get(getCurrentPath()));
      }, REFIT_DELAY_MS);
    }

    function pagesElementFor(state) {
      if (!state.pagesEl) state.pagesEl = createViewEl('ide-docx-pages', state.path);
      return state.pagesEl;
    }

    // Builds the pdf.js viewer for converted bytes; null when the view went stale meanwhile.
    async function buildPdf(state, runtime, base64, version, isActive) {
      const documentRef = paneEl.ownerDocument;
      const modules = await (loadPdfjs ||= runtime.createPdfjsLoader())();
      if (!isActive()) return null;
      const scroller = documentRef.createElement('div');
      scroller.className = 'ide-pdf-viewer-scroll ide-docx-pages-scroll';
      scroller.tabIndex = 0;
      const viewer = documentRef.createElement('div');
      viewer.className = 'pdfViewer';
      scroller.appendChild(viewer);
      const candidate = { version, scroller, parts: null, pdfDocument: null, task: null };
      state.pagesEl.appendChild(scroller);
      try {
        candidate.task = modules.pdfjs.getDocument({
          data: runtime.decodeBase64(base64),
          isEvalSupported: false,
          cMapUrl: runtime.repoUrl('node_modules/pdfjs-dist/cmaps/', documentRef),
          cMapPacked: true,
          standardFontDataUrl: runtime.repoUrl('node_modules/pdfjs-dist/standard_fonts/', documentRef),
          wasmUrl: runtime.repoUrl('node_modules/pdfjs-dist/wasm/', documentRef),
          disableAutoFetch: true,
          enableXfa: false,
        });
        candidate.pdfDocument = await candidate.task.promise;
        if (isActive()) {
          candidate.parts = runtime.createViewerParts(modules, { container: scroller, viewerElement: viewer });
          const { pdfViewer, linkService, eventBus } = candidate.parts;
          const pagesInit = new Promise((resolve) => eventBus.on('pagesinit', resolve));
          pdfViewer.setDocument(candidate.pdfDocument);
          linkService.setDocument(candidate.pdfDocument, null);
          await Promise.race([pagesInit, Promise.resolve(pdfViewer.pagesPromise).then(() => pagesInit)]);
        }
      } catch (error) {
        destroyPdf(candidate);
        throw error;
      }
      if (isActive()) return candidate;
      destroyPdf(candidate);
      return null;
    }

    // `path` is handed back to a newer render when the document was edited
    // meanwhile; a render for a left mode or a closed document just stops.
    async function renderPages(path, restarts = 0, force = false) {
      const state = states.get(path);
      const version = getVersion(path);
      if (!state || version === null || !engines) return;
      const pagesEl = pagesElementFor(state);
      if (!force && state.pdf?.version === version) {
        fitPages(state);
        return;
      }
      if (!force && state.pagesRendering === version) return;
      const token = ++state.pagesToken;
      state.pagesRendering = version;
      const active = () => !disposed && states.get(path) === state && state.pagesToken === token && mode === 'pages';
      const fresh = () => active() && getVersion(path) === version;
      state.pdf?.scroller.classList.add('hidden');
      setStatus(pagesEl, jt('ide.docx.pagesWorking', 'Making pages with {engine}...', { engine: ENGINE_NAMES[engines[0]] }));
      try {
        const base64 = await getSource(path, 'base64');
        const result = fresh() ? await Promise.resolve().then(() => getApi().renderDocumentPages({ base64 }))
          .catch(() => ({ ok: false, reason: 'failed' })) : null;
        if (result && fresh() && result.ok !== true) {
          setStatus(pagesEl, pagesFailureMessage(result.reason), true);
          return;
        }
        const runtime = result && fresh() ? await loadPdfViewer() : null;
        if (result && fresh() && !runtime) throw new Error('the PDF viewer is unavailable');
        const candidate = runtime && fresh() ? await buildPdf(state, runtime, String(result.base64 || ''), version, fresh) : null;
        if (candidate) {
          destroyPdf(state.pdf);
          state.pdf = candidate;
          setStatus(pagesEl, '');
          fitPages(state);
        } else if (active() && states.get(path) === state && restarts < MAX_STALE_RESTARTS) {
          state.pagesRendering = null;
          renderPages(path, restarts + 1);
        }
      } catch (error) {
        if (!active()) return;
        setStatus(pagesEl, pagesFailureMessage('failed'), true);
        safeLog('WARN', 'ide.docx_pages_failed', { path, message: String(error?.message || error) });
      } finally {
        if (states.get(path) === state && state.pagesToken === token) state.pagesRendering = null;
      }
    }

    // ── Showing ──

    function show(path) {
      if (!paneEl) return;
      refreshBar();
      ensureEngines();
      viewsEl.classList.toggle('hidden', mode === 'edit');
      for (const [statePath, state] of states) {
        state.readEl?.classList.toggle('hidden', !(mode === 'read' && statePath === path));
        state.pagesEl?.classList.toggle('hidden', !(mode === 'pages' && statePath === path));
        if (statePath !== path && state.pdf) {
          state.pagesToken += 1;
          destroyPdf(state.pdf);
          state.pdf = null;
        }
      }
      if (mode === 'edit' || !path || getVersion(path) === null) return;
      const state = stateFor(path);
      if (mode === 'read') {
        readElementFor(state).classList.remove('hidden');
        renderRead(path);
        return;
      }
      ensureEngines().then(() => {
        if (disposed || mode !== 'pages' || getCurrentPath() !== path || states.get(path) !== state) return;
        pagesElementFor(state).classList.remove('hidden');
        renderPages(path);
      });
    }

    return {
      barMarkup, mount, show, release, dispose, getMode: () => mode,
    };
  }

  return { createDocxViews, READ_OPTIONS };
});
