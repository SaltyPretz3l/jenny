/* renderer/features/renderer-ide-pdf-sidebar.js - the Workspace IDE PDF
 * pane's navigation sidebar: the document outline and page thumbnails
 * (row 65 W3). One sidebar per pane serves the visible document; each
 * document keeps its resolved outline, thumbnail list and image cache until
 * it closes. The host (renderer-ide-pdf-host.js) moves pages and resolves
 * destinations; this module only renders and reports clicks. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePdfSidebar = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const PREFS_KEY = 'jenny.idePdfSidebar.v1';
  // Bounds a hostile outline the same way MAX_PDF_PAGES bounds page views.
  const MAX_OUTLINE_NODES = 2000;
  const CHEVRON = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

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

  function readPrefs(storage) {
    try {
      const parsed = JSON.parse(storage?.getItem(PREFS_KEY) || 'null');
      return { open: parsed?.open === true, tab: parsed?.tab === 'pages' ? 'pages' : 'outline' };
    } catch (_error) {
      return { open: false, tab: 'outline' };
    }
  }

  // Outline entries point at a named or explicit destination; the page index
  // is resolved once so the current section can follow scrolling.
  async function resolveOutline(pdfDocument) {
    const raw = await pdfDocument.getOutline();
    let count = 0;
    async function pageOf(dest) {
      try {
        const explicit = typeof dest === 'string' ? await pdfDocument.getDestination(dest) : dest;
        const target = Array.isArray(explicit) ? explicit[0] : null;
        if (Number.isInteger(target)) return target + 1;
        if (target && typeof target === 'object') return (await pdfDocument.getPageIndex(target)) + 1;
      } catch (_error) {
        /* an unresolvable destination is listed without a page */
      }
      return null;
    }
    async function walk(items, depth, parent) {
      const nodes = [];
      for (const item of items || []) {
        if (count >= MAX_OUTLINE_NODES) break;
        count += 1;
        nodes.push({ id: String(count), title: String(item?.title || '').trim(), dest: item?.dest || null, depth, parent, item });
      }
      await Promise.all(nodes.map(async (node) => {
        node.page = node.dest ? await pageOf(node.dest) : null;
        node.children = await walk(node.item?.items, depth + 1, node);
        delete node.item;
      }));
      return nodes;
    }
    return Array.isArray(raw) && raw.length ? walk(raw, 0, null) : [];
  }

  function flatten(nodes, out = []) {
    for (const node of nodes) {
      out.push(node);
      flatten(node.children, out);
    }
    return out;
  }

  function createPdfSidebar(deps = {}) {
    const documentRef = deps.documentRef;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const onPage = typeof deps.onPage === 'function' ? deps.onPage : () => {};
    const onDestination = typeof deps.onDestination === 'function' ? deps.onDestination : () => {};
    const storage = 'storage' in deps ? deps.storage : (() => { try { return globalRef.localStorage; } catch (_error) { return null; } })();
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const segmentedControl = resolveModule('inventorySegmentedControl', '../inventory/segmented-control');
    const { createPdfThumbnailRenderer } = resolveModule('rendererIdePdfThumbnails', './renderer-ide-pdf-thumbnails');
    const escapeHtml = actionButton.escapeHtml;
    const prefs = readPrefs(storage);
    const docs = new Map();
    let current = null;
    let disposed = false;

    const element = documentRef.createElement('nav');
    element.className = 'ide-pdf-sidebar';
    element.hidden = !prefs.open;
    element.setAttribute('aria-label', jt('ide.pdf.navigationLabel', 'Document navigation'));
    element.innerHTML = '<div class="ide-pdf-sidebar-head"></div><div class="ide-pdf-sidebar-body"></div>';
    const headEl = element.querySelector('.ide-pdf-sidebar-head');
    const bodyEl = element.querySelector('.ide-pdf-sidebar-body');
    segmentedControl.initSegmentedHandlers?.(element);

    function savePrefs() {
      try {
        storage?.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch (_error) {
        /* a blocked store keeps the in-memory preference */
      }
    }

    function labelOf(entry, page) {
      return entry.labels?.[page - 1] || String(page);
    }

    function entryFor(key, doc) {
      let entry = docs.get(key);
      if (!entry) {
        entry = { key, pdfDocument: doc.pdfDocument, pageCount: doc.pageCount, page: doc.pageNumber || 1,
          outline: null, labels: null, expanded: new Set(), outlineEl: null, thumbsEl: null, thumbs: null, revealed: false, loading: false };
        docs.set(key, entry);
      }
      return entry;
    }

    // Outline and page labels resolve the first time the sidebar shows this
    // document; a closed sidebar costs nothing.
    function ensureLoaded(entry) {
      if (entry.loading) return;
      entry.loading = true;
      const key = entry.key;
      // Labels are optional: a failure falls back to page numbers, never
      // costs the outline.
      const labels = Promise.resolve(entry.pdfDocument.getPageLabels?.() || null).catch((error) => {
        log('warn', 'ide.pdf.page_labels_failed', { message: String(error?.message || error) });
        return null;
      });
      Promise.all([resolveOutline(entry.pdfDocument), labels])
        .then(([outline, labels]) => {
          entry.outline = outline;
          entry.labels = Array.isArray(labels) ? labels : null;
        })
        .catch((error) => {
          entry.outline = [];
          log('warn', 'ide.pdf.outline_failed', { message: String(error?.message || error) });
        })
        .finally(() => {
          if (docs.get(key) === entry) {
            entry.outlineEl = null;
            entry.thumbsEl = null;
            if (current === entry) render();
          }
        });
    }

    // The current section: the last entry in document order that starts at
    // or before the current page, shown on its nearest expanded ancestor.
    function currentNode(entry) {
      let found = null;
      for (const node of flatten(entry.outline || [])) {
        if (node.page && node.page <= entry.page) found = node;
      }
      return found;
    }

    function visibleNode(entry, node) {
      let shown = node;
      for (let parent = node?.parent; parent; parent = parent.parent) {
        if (!entry.expanded.has(parent.id)) shown = parent;
      }
      return shown;
    }

    function outlineRows(entry, nodes) {
      return nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const open = hasChildren && entry.expanded.has(node.id);
        const title = node.title || jt('ide.pdf.untitledSection', 'Untitled section');
        const row = actionButton({
          plain: true,
          className: 'ide-pdf-outline-row',
          label: title,
          title,
          role: 'treeitem',
          ariaExpanded: hasChildren ? open : undefined,
          // A heading without a destination still opens and closes its children.
          disabled: !node.dest && !hasChildren,
          dataset: { 'ide-pdf-outline': node.id },
          trustedHtml: `<span class="ide-pdf-outline-twisty${open ? ' ide-pdf-outline-twisty--open' : ''}" data-ide-pdf-twisty="${node.id}">${hasChildren ? CHEVRON : ''}</span>`
            + `<span class="ide-pdf-outline-title">${escapeHtml(title)}</span>`
            + `<span class="ide-pdf-outline-page">${node.page ? escapeHtml(labelOf(entry, node.page)) : ''}</span>`,
        });
        return `<li role="none" style="--ide-pdf-outline-depth:${node.depth}">${row}`
          + (open ? `<ul role="group">${outlineRows(entry, node.children)}</ul>` : '') + '</li>';
      }).join('');
    }

    function buildOutline(entry) {
      if (!entry.revealed) {
        entry.revealed = true;
        for (let parent = currentNode(entry)?.parent; parent; parent = parent.parent) entry.expanded.add(parent.id);
      }
      const list = documentRef.createElement('ul');
      list.className = 'ide-pdf-outline';
      list.setAttribute('role', 'tree');
      list.setAttribute('aria-label', jt('ide.pdf.outline', 'Outline'));
      list.innerHTML = outlineRows(entry, entry.outline);
      for (const row of list.querySelectorAll('[data-ide-pdf-outline]')) {
        row.setAttribute('aria-level', String(Number(row.parentElement.style.getPropertyValue('--ide-pdf-outline-depth')) + 1));
      }
      return list;
    }

    function buildThumbs(entry) {
      const list = documentRef.createElement('div');
      list.className = 'ide-pdf-thumbs';
      let markup = '';
      for (let page = 1; page <= entry.pageCount; page += 1) {
        const label = labelOf(entry, page);
        const name = jt('ide.pdf.thumbnailLabel', 'Page {page}', { page: label });
        markup += actionButton({
          plain: true,
          className: 'ide-pdf-thumb',
          ariaLabel: name,
          title: name,
          dataset: { 'ide-pdf-thumb': String(page) },
          trustedHtml: '<span class="ide-pdf-thumb-paper"><img class="ide-pdf-thumb-image" alt="" hidden></span>'
            + `<span class="ide-pdf-thumb-label">${escapeHtml(label)}</span>`,
        });
      }
      list.innerHTML = markup;
      entry.thumbs?.dispose();
      entry.thumbs = typeof createPdfThumbnailRenderer === 'function'
        ? createPdfThumbnailRenderer({ pdfDocument: entry.pdfDocument, documentRef, scrollRoot: bodyEl, log })
        : null;
      for (const button of list.querySelectorAll('[data-ide-pdf-thumb]')) {
        const image = button.querySelector('img');
        entry.thumbs?.observe(button.querySelector('.ide-pdf-thumb-paper'), Number(button.dataset.idePdfThumb), (result) => {
          image.hidden = !result;
          if (result) image.src = result.url;
          else image.removeAttribute('src');
        });
      }
      return list;
    }

    function tabOf(entry) {
      return entry.outline?.length ? prefs.tab : 'pages';
    }

    function markCurrent(entry, scroll) {
      if (tabOf(entry) === 'outline' && entry.outlineEl) {
        const shown = visibleNode(entry, currentNode(entry));
        for (const row of entry.outlineEl.querySelectorAll('[data-ide-pdf-outline]')) {
          const isCurrent = row.dataset.idePdfOutline === shown?.id;
          row.classList.toggle('ide-pdf-outline-row--current', isCurrent);
          if (isCurrent) row.setAttribute('aria-current', 'location');
          else row.removeAttribute('aria-current');
          if (isCurrent && scroll) row.scrollIntoView?.({ block: 'nearest' });
        }
      } else if (entry.thumbsEl) {
        for (const thumb of entry.thumbsEl.querySelectorAll('.ide-pdf-thumb--current')) {
          thumb.classList.remove('ide-pdf-thumb--current');
          thumb.removeAttribute('aria-current');
        }
        const thumb = entry.thumbsEl.querySelector(`[data-ide-pdf-thumb="${entry.page}"]`);
        thumb?.classList.add('ide-pdf-thumb--current');
        thumb?.setAttribute('aria-current', 'page');
        if (scroll) thumb?.scrollIntoView?.({ block: 'nearest' });
      }
    }

    function render() {
      if (disposed || !current || element.hidden) return;
      const entry = current;
      ensureLoaded(entry);
      if (entry.outline === null) {
        // Still resolving: render once, with the right tab, when it lands.
        headEl.replaceChildren();
        bodyEl.replaceChildren();
        return;
      }
      const tab = tabOf(entry);
      headEl.innerHTML = entry.outline?.length
        ? segmentedControl({
          id: 'ide-pdf-sidebar-view',
          className: 'inv-segmented--compact ide-pdf-sidebar-switch',
          ariaLabel: jt('ide.pdf.sidebarView', 'Sidebar view'),
          value: tab,
          options: [
            { value: 'outline', label: jt('ide.pdf.outline', 'Outline') },
            { value: 'pages', label: jt('ide.pdf.pages', 'Pages') },
          ],
        })
        : `<span class="ide-pdf-sidebar-title">${escapeHtml(jt('ide.pdf.pages', 'Pages'))}</span>`;
      if (tab === 'outline') entry.outlineEl ||= buildOutline(entry);
      else entry.thumbsEl ||= buildThumbs(entry);
      bodyEl.replaceChildren(tab === 'outline' ? entry.outlineEl : entry.thumbsEl);
      markCurrent(entry, true);
    }

    // A navigation in the narrow overlay closes the sidebar so the page shows.
    function closeIfOverlay() {
      const view = documentRef.defaultView;
      if (view?.getComputedStyle?.(element).position === 'absolute') setOpen(false);
    }

    function nodeById(entry, id) {
      return flatten(entry.outline || []).find((node) => node.id === id) || null;
    }

    function toggleNode(entry, node) {
      if (!node?.children.length) return;
      if (entry.expanded.has(node.id)) entry.expanded.delete(node.id);
      else entry.expanded.add(node.id);
      entry.outlineEl = null;
      render();
      bodyEl.querySelector(`[data-ide-pdf-outline="${node.id}"]`)?.focus?.();
    }

    element.addEventListener('click', (event) => {
      const entry = current;
      if (!entry) return;
      const twisty = event.target.closest?.('[data-ide-pdf-twisty]');
      const row = event.target.closest?.('[data-ide-pdf-outline]');
      const thumb = event.target.closest?.('[data-ide-pdf-thumb]');
      if (twisty && twisty.firstChild) {
        toggleNode(entry, nodeById(entry, twisty.dataset.idePdfTwisty));
      } else if (row) {
        const node = nodeById(entry, row.dataset.idePdfOutline);
        if (!node?.dest) {
          toggleNode(entry, node);
          return;
        }
        onDestination(node.dest, node.page);
        closeIfOverlay();
      } else if (thumb) {
        onPage(Number(thumb.dataset.idePdfThumb));
        closeIfOverlay();
      }
    });

    element.addEventListener('inv-segmented-change', (event) => {
      prefs.tab = event.detail?.value === 'pages' ? 'pages' : 'outline';
      savePrefs();
      render();
    });

    // A document off screen keeps its resolved outline and labels, not its
    // rows, thumbnails or rendered bitmaps; they rebuild when it returns.
    function release(entry) {
      if (!entry) return;
      entry.thumbs?.dispose();
      entry.thumbs = null;
      entry.thumbsEl = null;
      entry.outlineEl = null;
    }

    // Tree keys: Up/Down (Home/End) move between visible rows, Right/Left expand or
    // collapse (or step to the parent); Enter and Space are the button's own.
    element.addEventListener('keydown', (event) => {
      const row = event.target.closest?.('[data-ide-pdf-outline]');
      const entry = current;
      if (!row || !entry || event.altKey || event.ctrlKey || event.metaKey) return;
      const rows = [...bodyEl.querySelectorAll('[data-ide-pdf-outline]')];
      const index = rows.indexOf(row);
      const node = nodeById(entry, row.dataset.idePdfOutline);
      let handled = true;
      if (event.key === 'ArrowDown') rows[index + 1]?.focus();
      else if (event.key === 'ArrowUp') rows[index - 1]?.focus();
      else if (event.key === 'Home') rows[0]?.focus();
      else if (event.key === 'End') rows[rows.length - 1]?.focus();
      else if (event.key === 'ArrowRight' && node?.children.length && !entry.expanded.has(node.id)) toggleNode(entry, node);
      else if (event.key === 'ArrowLeft' && node && entry.expanded.has(node.id)) toggleNode(entry, node);
      else if (event.key === 'ArrowLeft' && node?.parent) bodyEl.querySelector(`[data-ide-pdf-outline="${node.parent.id}"]`)?.focus();
      else handled = false;
      if (handled) event.preventDefault();
    });

    function setOpen(open) {
      prefs.open = open === true;
      element.hidden = !prefs.open;
      savePrefs();
      if (prefs.open) render();
      else current?.thumbs?.cancelPending();
      return prefs.open;
    }

    return {
      element,
      isOpen: () => prefs.open,
      toggle: () => setOpen(!prefs.open),
      setOpen,
      attach(key, doc) {
        if (disposed || !doc?.pdfDocument) return;
        const next = entryFor(key, doc);
        if (current !== next) release(current);
        current = next;
        current.page = doc.pageNumber || current.page;
        render();
      },
      setPage(key, page) {
        const entry = docs.get(key);
        if (!entry || !Number.isInteger(page)) return;
        entry.page = page;
        if (entry === current && !element.hidden) markCurrent(entry, true);
      },
      detach() {
        release(current);
        current = null;
        bodyEl.replaceChildren();
        headEl.replaceChildren();
      },
      forget(key) {
        const entry = docs.get(key);
        if (!entry) return;
        entry.thumbs?.dispose();
        docs.delete(key);
        if (current === entry) {
          current = null;
          bodyEl.replaceChildren();
          headEl.replaceChildren();
        }
      },
      dispose() {
        disposed = true;
        for (const entry of docs.values()) entry.thumbs?.dispose();
        docs.clear();
        current = null;
        element.remove();
      },
    };
  }

  return { createPdfSidebar, resolveOutline };
});
