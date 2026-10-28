/* renderer/features/renderer-ide-pdf-reading-context.js - what the reader is
 * looking at in a Workspace IDE PDF tab, for "ask about this page or
 * selection" (row 65 W2). The chat's active-file context reads it
 * synchronously at send time, so page text is extracted ahead of time and
 * reported as pending until pdf.js has it. Also owns the floating
 * "Ask Jenny" button shown over a text selection. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePdfReadingContext = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  // Matches the backend's ACTIVE_SLICE_MAX_CHARS so nothing is cut twice.
  const MAX_TEXT_CHARS = 6000;
  const MAX_CACHED_PAGES = 8;
  // Page changes settle before text is extracted and the chat is told, so
  // holding PageDown does not extract every page crossed.
  const PAGE_SETTLE_MS = 150;
  const CHANGED_EVENT = 'ide:pdf-reading-context-changed';
  const SPARK = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" fill="currentColor"/></svg>';

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

  function pageOfNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const page = Number(element?.closest?.('.page[data-page-number]')?.dataset.pageNumber);
    return Number.isInteger(page) && page >= 1 ? page : null;
  }

  async function extractPageText(pdfDocument, page) {
    const pdfPage = await pdfDocument.getPage(page);
    const content = await pdfPage.getTextContent();
    let text = '';
    for (const item of content?.items || []) {
      text += String(item?.str || '') + (item?.hasEOL ? '\n' : '');
      if (text.length >= MAX_TEXT_CHARS) break;
    }
    return text.slice(0, MAX_TEXT_CHARS);
  }

  function createPdfReadingContext(deps = {}) {
    const documentRef = deps.documentRef;
    const hostEl = deps.hostEl;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const onAsk = typeof deps.onAsk === 'function' ? deps.onAsk : () => {};
    // Only offered when the chat can take it (the active-file context is on).
    const canAsk = typeof deps.canAsk === 'function' ? deps.canAsk : () => true;
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const docs = new Map();
    let current = null;
    let disposed = false;
    let pageTimer = null;

    const askEl = documentRef.createElement('div');
    askEl.className = 'ide-pdf-ask';
    askEl.hidden = true;
    askEl.innerHTML = typeof actionButton === 'function' ? actionButton({
      plain: true,
      className: 'ide-pdf-ask-button',
      ariaLabel: jt('ide.pdf.askAboutSelection', 'Ask Jenny about the selected text'),
      title: jt('ide.pdf.askAboutSelection', 'Ask Jenny about the selected text'),
      dataset: { 'ide-pdf-ask': 'true' },
      trustedHtml: `${SPARK}<span>${actionButton.escapeHtml(jt('ide.pdf.askJenny', 'Ask Jenny'))}</span>`,
    }) : '';
    hostEl.appendChild(askEl);

    function announce(key) {
      const view = documentRef.defaultView;
      if (!view || typeof view.CustomEvent !== 'function') return;
      view.dispatchEvent(new view.CustomEvent(CHANGED_EVENT, { detail: { path: key } }));
    }

    // Text is extracted only for documents the chat has asked about.
    function prefetch(entry, page) {
      if (!entry.wanted || entry.pages.has(page) || !entry.pdfDocument) return;
      const slot = { state: 'pending', text: '' };
      entry.pages.set(page, slot);
      while (entry.pages.size > MAX_CACHED_PAGES) entry.pages.delete(entry.pages.keys().next().value);
      extractPageText(entry.pdfDocument, page).then((text) => {
        slot.text = text;
        slot.state = text.trim() ? 'ready' : 'empty';
      }, (error) => {
        slot.state = 'empty';
        log('warn', 'ide.pdf.page_text_failed', { page, message: String(error?.message || error) });
      }).finally(() => {
        if (docs.get(entry.key) === entry && entry.page === page) announce(entry.key);
      });
    }

    function hideAsk() {
      askEl.hidden = true;
    }

    // Above the end of the selection, inside the pane's document area.
    function showAsk(range) {
      if (!canAsk()) return;
      const rects = range.getClientRects?.() || [];
      const last = rects[rects.length - 1] || range.getBoundingClientRect?.();
      const host = hostEl.getBoundingClientRect?.();
      if (!last || !host) return;
      askEl.hidden = false;
      const top = Math.max(4, last.top - host.top - askEl.offsetHeight - 6);
      const left = Math.min(Math.max(4, last.right - host.left - askEl.offsetWidth / 2), Math.max(4, host.width - askEl.offsetWidth - 4));
      askEl.style.top = `${top}px`;
      askEl.style.left = `${left}px`;
    }

    // The selection is kept once made: clicking into the composer moves the
    // browser selection away, but the reader still means the passage. A
    // collapsed selection back on the pages clears it.
    // `onPages`: the gesture ended on the pages, so the button comes back
    // for an unchanged selection too (after Esc, say).
    function readSelection(showButton, onPages) {
      const entry = current;
      const selection = documentRef.getSelection?.();
      if (!entry || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!entry.viewerEl?.contains(range.commonAncestorContainer)) return;
      const text = selection.isCollapsed ? '' : String(selection.toString() || '').trim();
      if (!text) {
        if (entry.selection) {
          entry.selection = null;
          announce(entry.key);
        }
        hideAsk();
        return;
      }
      const pages = [pageOfNode(range.startContainer), pageOfNode(range.endContainer)].filter(Boolean);
      const startPage = pages.length ? Math.min(...pages) : entry.page;
      const endPage = pages.length ? Math.max(...pages) : entry.page;
      const next = { text: text.slice(0, MAX_TEXT_CHARS), startPage, endPage };
      const was = entry.selection;
      // A gesture that leaves the selection as it was tells the chat nothing new.
      const changed = !was || was.text !== next.text || was.startPage !== startPage || was.endPage !== endPage;
      if (changed) {
        entry.selection = next;
        announce(entry.key);
      }
      if (showButton && (changed || onPages)) showAsk(range);
    }

    const onSelectionChange = () => {
      const selection = documentRef.getSelection?.();
      if (!selection || selection.isCollapsed) hideAsk();
    };
    // Any gesture end reads it (a drag released over the toolbar, Shift+Arrow
    // with focus on the scroller); readSelection keeps to ranges on the pages.
    const onGestureEnd = (event) => readSelection(true, Boolean(current?.viewerEl?.contains(event.target)));
    const onScroll = () => hideAsk();
    documentRef.addEventListener('selectionchange', onSelectionChange);
    documentRef.addEventListener('pointerup', onGestureEnd, true);
    documentRef.addEventListener('keyup', onGestureEnd, true);
    hostEl.addEventListener('scroll', onScroll, true);
    askEl.addEventListener('click', (event) => {
      if (!event.target.closest?.('[data-ide-pdf-ask]') || !current) return;
      hideAsk();
      onAsk(current.key);
    });
    // Esc on the pages or the button dismisses it.
    const onKeydown = (event) => {
      if (event.key === 'Escape') hideAsk();
    };
    hostEl.addEventListener('keydown', onKeydown);

    return {
      element: askEl,
      CHANGED_EVENT,
      attach(key, doc) {
        if (disposed) return;
        let entry = docs.get(key);
        if (!entry) {
          entry = { key, pages: new Map(), selection: null, page: 1, pageCount: 0, wanted: false };
          docs.set(key, entry);
        }
        Object.assign(entry, { pdfDocument: doc.pdfDocument, viewerEl: doc.viewerEl, pageCount: doc.pageCount, page: doc.pageNumber || entry.page });
        current = entry;
        prefetch(entry, entry.page);
      },
      setPage(key, page) {
        const entry = docs.get(key);
        if (!entry || !Number.isInteger(page) || entry.page === page) return;
        entry.page = page;
        // Scrolled away from the selection: the page being read is the subject again.
        const selection = entry.selection;
        if (selection && (page < selection.startPage || page > selection.endPage)) entry.selection = null;
        if (entry !== current) return;
        globalRef.clearTimeout(pageTimer);
        pageTimer = globalRef.setTimeout(() => {
          pageTimer = null;
          if (disposed || current !== entry) return;
          prefetch(entry, entry.page);
          announce(key);
        }, PAGE_SETTLE_MS);
      },
      // A reload replaces the parsed document: cached text is stale.
      reset(key) {
        const entry = docs.get(key);
        if (!entry) return;
        entry.pages.clear();
        entry.selection = null;
        announce(key);
      },
      detach() {
        globalRef.clearTimeout(pageTimer);
        pageTimer = null;
        current = null;
        hideAsk();
      },
      forget(key) {
        if (current?.key === key) this.detach();
        docs.delete(key);
      },
      // Sync snapshot for the chat: the selection when there is one, else
      // the current page; text is '' while pending and for a scanned page.
      // `want` (the chat is sending or armed) extracts page text from here
      // on; without it the call only peeks.
      getContext(key, { want = false } = {}) {
        const entry = docs.get(key);
        if (!entry || !entry.pdfDocument) return null;
        entry.wanted = want === true;
        const base = { page: entry.page, pageCount: entry.pageCount };
        if (entry.selection) {
          return { ...base, selection: { ...entry.selection }, text: entry.selection.text, textState: 'ready' };
        }
        prefetch(entry, entry.page);
        const slot = entry.pages.get(entry.page);
        return { ...base, selection: null, text: slot?.state === 'ready' ? slot.text : '', textState: slot?.state || 'pending' };
      },
      dispose() {
        disposed = true;
        globalRef.clearTimeout(pageTimer);
        documentRef.removeEventListener('selectionchange', onSelectionChange);
        documentRef.removeEventListener('pointerup', onGestureEnd, true);
        documentRef.removeEventListener('keyup', onGestureEnd, true);
        hostEl.removeEventListener('scroll', onScroll, true);
        hostEl.removeEventListener('keydown', onKeydown);
        docs.clear();
        current = null;
        askEl.remove();
      },
    };
  }

  return { CHANGED_EVENT, MAX_TEXT_CHARS, createPdfReadingContext, extractPageText };
});
