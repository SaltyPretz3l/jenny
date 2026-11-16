/**
 * renderer/features/renderer-sketch-pin.js: "Pin" under a drawn sketch block (row 150 slice C5;
 * the project board plan section 7.7).
 *
 * One action module of the sketch frame host (see the header of renderer-sketch-frame-host.js).
 * `attach(host)` is called once after the host has loaded; it adds one button to the row under each drawing the host
 * reports (order 40) and returns `detach()`, which takes everything back. The button is added only while the
 * `project_boards` flag is on (read through the chat's pin entry, renderer-chat-message-action-bindings.js, when each
 * drawing is drawn). Clicking it opens the board picker for a diagram card holding the block's sketch source and its
 * title (the source's `title` line, or none). The chat is the one the block sits in: its pane's session, never "the
 * active chat"; a block outside a pane leaves it to the entry. The source is model output: it is only handed to the
 * picker, which hands it to the main process, which checks it against the model's own limits.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSketchPin = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const PIN_ORDER = 40;
  const TITLE_MAX = 120; // the main process cuts to the same length
  const TITLE_LINE_RE = /^[ \t]*title[ \t]+(.+)$/m;
  const ICON = '<svg class="markdown-sketch-share-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.5h4l-.7 3.2L11.5 8v1.5h-7V8l2.2-2.3z"/><path d="M8 9.5v4"/></svg>';

  function actionButtonApi() {
    return globalThis.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
  }

  function entryApi() {
    return globalThis.rendererChatMessageActionBindings || null;
  }

  function makeButton(ownerDocument) {
    const make = actionButtonApi();
    if (typeof make !== 'function') return null;
    const template = ownerDocument.createElement('template');
    template.innerHTML = make({
      variant: 'ghost', size: 'sm', title: jt('markdown.sketch.pinHint', 'Pin this drawing to a board'), dataset: { 'sketch-action': 'pin' },
      trustedHtml: ICON + '<span class="markdown-sketch-action-label">' + make.escapeHtml(jt('markdown.sketch.pin', 'Pin')) + '</span>',
    });
    return template.content.firstElementChild;
  }

  /** The session of the chat pane a block sits in, or undefined (docked beside the Workspace or a board, a preview). */
  function paneSessionOf(block) {
    const pane = block && typeof block.closest === 'function' ? block.closest('.chat-pane[data-pane-id]') : null;
    const paneId = pane ? Number(pane.getAttribute('data-pane-id')) : NaN;
    const owner = globalThis.rendererAppPaneComposition;
    const panes = owner && typeof owner.getPaneComposition === 'function' ? owner.getPaneComposition() : null;
    const id = panes && typeof panes.getPaneSessionId === 'function' && Number.isInteger(paneId) ? panes.getPaneSessionId(paneId) : '';
    return typeof id === 'string' && id ? id : undefined;
  }

  function titleOf(source) {
    const found = TITLE_LINE_RE.exec(source);
    return found ? found[1].replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) : '';
  }

  /** Adds the action to every drawing `host` reports. Returns detach(). Nothing runs before this call. */
  function attach(host) {
    const entries = new Set();
    const entryOf = new WeakMap();
    let disposed = false;

    function removeEntry(entry) {
      entry.button.removeEventListener('click', entry.listener);
      entry.button.remove();
      entries.delete(entry);
      entryOf.delete(entry.block);
    }

    function pin(entry) {
      if (disposed || !entries.has(entry)) return;
      const source = host.sourceOf(entry.block);
      const pinEntry = entryApi();
      if (!source || !pinEntry || typeof pinEntry.openPinMenu !== 'function') return;
      pinEntry.openPinMenu({
        windowRef: entry.block.ownerDocument.defaultView, anchorEl: entry.button, rootEl: entry.block,
        item: { kind: 'diagram', scene: source, title: titleOf(source) }, sessionId: paneSessionOf(entry.block),
      });
    }

    const stopDrawn = host.onDrawn(function (drawn) {
      if (disposed) return;
      for (const entry of Array.from(entries)) { if (!entry.block.isConnected) removeEntry(entry); }
      const block = drawn.block;
      const previous = entryOf.get(block);
      if (previous) removeEntry(previous);
      const pinEntry = entryApi();
      if (!pinEntry || typeof pinEntry.pinEnabled !== 'function' || pinEntry.pinEnabled() !== true) return;
      const button = makeButton(block.ownerDocument);
      if (!button) return;
      const entry = { block, button, listener: null };
      entry.listener = function () { pin(entry); };
      button.addEventListener('click', entry.listener);
      entries.add(entry);
      entryOf.set(block, entry);
      if (!host.addAction(block, button, PIN_ORDER)) removeEntry(entry);
    });

    return function detach() {
      if (disposed) return;
      disposed = true;
      stopDrawn();
      for (const entry of Array.from(entries)) removeEntry(entry);
    };
  }

  return { attach };
});
