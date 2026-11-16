/**
 * renderer/features/renderer-sketch-export.js: "Copy source" and "Export" under a drawn sketch block
 * (the project board plan section 5.6; slice S6).
 *
 * One action module of the sketch frame host (see the header of renderer-sketch-frame-host.js).
 * `attach(host)` is called once after the host has loaded; it adds two buttons to the row under each
 * drawing the host reports (orders 20 and 30) and returns `detach()`, which takes everything back.
 *
 *   Copy source  puts the block's sketch source on the clipboard and says so on the button.
 *   Export       a menu of SVG, PNG and Excalidraw. Choosing one asks the frame for that file; the
 *                answer opens the save dialog (`jennyShell.dialog.saveFile`) and the file is written
 *                only where the person chose.
 *
 * The exported text and picture are model output: they are only ever handed to the save dialog, never
 * parsed, inserted into the page or used as an image source. The name comes from the host already
 * cleaned (letters, digits, - and _) and is passed on unchanged.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSketchExport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const COPY_ORDER = 20;
  const EXPORT_ORDER = 30;
  const EXPORT_WAIT_MS = 15000;
  const COPY_RESET_MS = 1500;
  const MAX_ERROR_CHARS = 200;
  const ICON_ATTRS = 'class="markdown-sketch-share-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const ICONS = Object.freeze({
    copy: '<svg ' + ICON_ATTRS + '><rect x="5" y="3" width="8" height="10" rx="2"/><path d="M3 11V5a2 2 0 0 1 2-2"/></svg>',
    export: '<svg ' + ICON_ATTRS + '><path d="M8 2.5v7M5 6.8 8 9.8l3-3M3 12.5h10"/></svg>',
  });

  function actionButtonApi() {
    return globalThis.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
  }

  function contextMenuApi() {
    return globalThis.inventoryContextMenu || (typeof require === 'function' ? require('../inventory/context-menu') : null);
  }

  /** A ghost, small inventory button with an icon and a text label (the label span is what changes). */
  function makeButton(ownerDocument, options) {
    const make = actionButtonApi();
    if (typeof make !== 'function') return null;
    const template = ownerDocument.createElement('template');
    // The title is the tooltip a narrow dock relies on once the label is hidden (markdown-sketch.css).
    template.innerHTML = make(Object.assign({ variant: 'ghost', size: 'sm', title: options.label }, options, {
      trustedHtml: ICONS[options.icon] + '<span class="markdown-sketch-action-label">' + make.escapeHtml(options.label) + '</span>',
    }));
    return template.content.firstElementChild;
  }

  function setLabel(button, text) {
    const label = button.querySelector('.markdown-sketch-action-label');
    if (label) label.textContent = text;
  }

  /** The save dialog's file type for a kind of export. */
  function fileTypeOf(kind) {
    if (kind === 'png') return { name: jt('markdown.sketch.export.filterPng', 'PNG image'), extension: 'png' };
    if (kind === 'excalidraw') return { name: jt('markdown.sketch.export.filterExcalidraw', 'Excalidraw drawing'), extension: 'excalidraw' };
    return { name: jt('markdown.sketch.export.filterSvg', 'SVG image'), extension: 'svg' };
  }

  function toast(windowRef, message, tone) {
    const toaster = (windowRef && windowRef.rendererSuggestedChangesHost) || globalThis.rendererSuggestedChangesHost;
    const show = toaster && toaster.showToastMessage;
    if (typeof show !== 'function') return;
    try { show(message, { tone, title: jt('markdown.sketch.export.toastTitle', 'Export') }); } catch (_error) { /* a toast is best-effort */ }
  }

  function errorText(error) {
    const raw = String((error && error.message) || error || '');
    // Electron prefixes an error thrown by a handler with the channel it came through.
    return raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '').slice(0, MAX_ERROR_CHARS);
  }

  /** Puts text on the clipboard the way a code block's Copy does: the clipboard API, else a hidden textarea. */
  function writeClipboard(windowRef, text) {
    const clipboard = windowRef.navigator && windowRef.navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') return Promise.resolve().then(function () { return clipboard.writeText(text); });
    return new Promise(function (resolve, reject) {
      const ownerDocument = windowRef.document;
      let area = null;
      try {
        area = ownerDocument.createElement('textarea');
        area.value = text;
        area.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        ownerDocument.body.appendChild(area);
        area.select();
        if (typeof ownerDocument.execCommand === 'function' && ownerDocument.execCommand('copy')) resolve();
        else reject(new Error('copy refused'));
      } catch (error) {
        reject(error);
      } finally {
        if (area && area.parentNode) area.parentNode.removeChild(area);
      }
    });
  }

  /**
   * Adds the two actions to every drawing `host` reports. Returns detach(), which removes the handler,
   * the buttons with their listeners, a pending wait and an open menu. Nothing runs before this call.
   */
  function attach(host) {
    const entries = new Set();
    const entryOf = new WeakMap();
    let openEntry = null;
    let disposed = false;

    function setBusy(entry, busy) {
      if (busy) entry.exportButton.setAttribute('aria-busy', 'true');
      else entry.exportButton.removeAttribute('aria-busy');
      setLabel(entry.exportButton, busy ? jt('markdown.sketch.exporting', 'Exporting…') : jt('markdown.sketch.export', 'Export'));
    }

    function endWait(entry) {
      if (!entry.pending) return;
      entry.windowRef.clearTimeout(entry.pending.timer);
      entry.pending = null;
      setBusy(entry, false);
    }

    function removeEntry(entry) {
      entry.live = false;
      if (entry.pending) {
        entry.windowRef.clearTimeout(entry.pending.timer);
        entry.pending = null;
      }
      if (entry.copyTimer) entry.windowRef.clearTimeout(entry.copyTimer);
      entry.copyTimer = 0;
      for (const [button, listener] of entry.listeners) button.removeEventListener('click', listener);
      entry.listeners = [];
      entry.copyButton.remove();
      entry.exportButton.remove();
      entries.delete(entry);
      entryOf.delete(entry.block);
    }

    function prune() {
      for (const entry of Array.from(entries)) {
        if (!entry.block.isConnected) removeEntry(entry);
      }
    }

    /* ── Copy source ── */

    function showCopyState(entry, copied) {
      if (!entry.live) return;
      if (entry.copyTimer) entry.windowRef.clearTimeout(entry.copyTimer);
      setLabel(entry.copyButton, copied ? jt('markdown.sketch.copySourceDone', 'Copied') : jt('markdown.sketch.copySourceFailed', 'Copy failed'));
      entry.copyButton.setAttribute('data-copy-status', copied ? 'copied' : 'failed');
      entry.copyTimer = entry.windowRef.setTimeout(function () {
        entry.copyTimer = 0;
        if (!entry.live) return;
        setLabel(entry.copyButton, jt('markdown.sketch.copySource', 'Copy source'));
        entry.copyButton.removeAttribute('data-copy-status');
      }, COPY_RESET_MS);
    }

    function copySource(entry) {
      if (disposed || !entry.live) return;
      const source = host.sourceOf(entry.block);
      const attempt = source ? writeClipboard(entry.windowRef, source) : Promise.reject(new Error('no source'));
      attempt.then(function () { showCopyState(entry, true); }, function () { showCopyState(entry, false); });
    }

    /* ── Export ── */

    function save(entry, message) {
      const dialog = entry.windowRef.jennyShell && entry.windowRef.jennyShell.dialog;
      if (!dialog || typeof dialog.saveFile !== 'function') {
        toast(entry.windowRef, jt('markdown.sketch.export.failed', 'Could not export this drawing.'), 'danger');
        return;
      }
      const type = fileTypeOf(message.kind);
      const payload = {
        defaultName: message.name,
        title: jt('markdown.sketch.export.dialogTitle', 'Export drawing'),
        format: 'plain',
        filters: [{ name: type.name, extensions: [type.extension] }],
        content: message.kind === 'png' ? message.base64 : message.text,
      };
      if (message.kind === 'png') payload.encoding = 'base64';
      Promise.resolve().then(function () { return dialog.saveFile(payload); }).then(function (result) {
        if (disposed || !result || result.canceled !== false || typeof result.path !== 'string' || !result.path) return;
        toast(entry.windowRef, jt('markdown.sketch.export.saved', 'Saved to {path}', { path: result.path }), 'success');
      }, function (error) {
        if (disposed) return;
        toast(entry.windowRef, jt('markdown.sketch.export.saveFailed', 'Could not save the file: {error}', { error: errorText(error) }), 'danger');
      });
    }

    function choose(entry, kind) {
      if (disposed || !entry.live || entry.pending) return;
      const timer = entry.windowRef.setTimeout(function () {
        if (!entry.live || !entry.pending || entry.pending.timer !== timer) return;
        endWait(entry);
        toast(entry.windowRef, jt('markdown.sketch.export.failed', 'Could not export this drawing.'), 'danger');
      }, EXPORT_WAIT_MS);
      entry.pending = { kind, timer };
      setBusy(entry, true);
      if (!host.post(entry.block, { type: 'export', kind })) {
        endWait(entry);
        toast(entry.windowRef, jt('markdown.sketch.export.notReady', 'This drawing is not ready to export yet.'), 'info');
      }
    }

    function toggleMenu(entry) {
      const menu = contextMenuApi();
      if (disposed || !entry.live || entry.pending || !menu) return;
      if (openEntry === entry) {
        menu.hide();
        return;
      }
      openEntry = entry;
      entry.exportButton.setAttribute('aria-expanded', 'true');
      menu.show({
        rootEl: entry.block,
        anchorEl: entry.exportButton,
        placement: 'above',
        ariaLabel: jt('markdown.sketch.export.menuLabel', 'Export as'),
        restoreFocusTo: entry.exportButton,
        onHide: function () {
          if (openEntry === entry) openEntry = null;
          entry.exportButton.setAttribute('aria-expanded', 'false');
        },
        items: [
          { label: jt('markdown.sketch.export.svg', 'SVG'), value: 'svg', action: function () { choose(entry, 'svg'); } },
          { label: jt('markdown.sketch.export.png', 'PNG'), value: 'png', action: function () { choose(entry, 'png'); } },
          { label: jt('markdown.sketch.export.excalidraw', 'Excalidraw'), value: 'excalidraw', action: function () { choose(entry, 'excalidraw'); } },
        ],
      });
    }

    const stopMessages = host.onMessage('export', function (block, message) {
      const entry = entryOf.get(block);
      // An answer nobody asked for, or for another kind than the one asked, is dropped.
      if (disposed || !entry || !entry.pending || entry.pending.kind !== message.kind) return;
      endWait(entry);
      if (message.ok !== true) {
        toast(entry.windowRef, jt('markdown.sketch.export.failed', 'Could not export this drawing.'), 'danger');
        return;
      }
      save(entry, message);
    });

    /* ── Each drawing ── */

    const stopDrawn = host.onDrawn(function (drawn) {
      if (disposed) return;
      prune();
      const block = drawn.block;
      const previous = entryOf.get(block);
      if (previous) removeEntry(previous);
      const ownerDocument = block.ownerDocument;
      const windowRef = ownerDocument && ownerDocument.defaultView;
      if (!windowRef) return;
      const copyButton = makeButton(ownerDocument, { icon: 'copy', label: jt('markdown.sketch.copySource', 'Copy source') });
      const exportButton = makeButton(ownerDocument, {
        icon: 'export', label: jt('markdown.sketch.export', 'Export'), ariaHaspopup: 'menu', ariaExpanded: false,
      });
      if (!copyButton || !exportButton) return;
      const entry = { block, windowRef, copyButton, exportButton, pending: null, copyTimer: 0, live: true, listeners: [] };
      const onCopy = function () { copySource(entry); };
      const onExport = function () { toggleMenu(entry); };
      copyButton.addEventListener('click', onCopy);
      exportButton.addEventListener('click', onExport);
      entry.listeners = [[copyButton, onCopy], [exportButton, onExport]];
      entries.add(entry);
      entryOf.set(block, entry);
      if (!host.addAction(block, copyButton, COPY_ORDER) || !host.addAction(block, exportButton, EXPORT_ORDER)) removeEntry(entry);
    });

    return function detach() {
      if (disposed) return;
      disposed = true;
      stopDrawn();
      stopMessages();
      const menu = contextMenuApi();
      if (openEntry && menu) menu.hide({ restoreFocus: false });
      for (const entry of Array.from(entries)) removeEntry(entry);
    };
  }

  return { attach };
});
