/* renderer/features/renderer-display-media-picker.js
 *
 * In-app screen / window capture-source picker for the composer "capture
 * screen" attachment. Bridges the main-process display-media source handler
 * (services/main/display-media-source-handler.js) to a modal:
 *
 *   1. The user clicks "capture screen" -> the renderer calls
 *      navigator.mediaDevices.getDisplayMedia() (renderer-attachment-event-utils.js).
 *   2. main's setDisplayMediaRequestHandler fires, enumerates sources, and
 *      PUSHES `displayMediaPicker.onRequest` { requestId, sources }.
 *   3. This module shows a thumbnail grid; the user's choice is echoed back via
 *      `displayMediaPicker.respond(requestId, sourceId | null)`.
 *   4. main grants that source, getDisplayMedia resolves, and the existing
 *      canvas capture path produces the attachment.
 *
 * Reuses the inventory help-overlay primitive for the a11y chrome (scrim, focus
 * trap, Esc, focus restore) and replicates the confirm-dialog lifecycle
 * (singleton overlay + one capturing document-click listener + a `settled`
 * guard). SECURITY: DesktopCapturerSource.name is a foreign window title fully
 * controlled by whatever else is running on the machine, and it is interpolated
 * into innerHTML by the help-overlay body -- every name/id is escaped and every
 * thumbnail data URL is validated before it touches the DOM.
 *
 * Cancel coordination: the picker knows when the user deliberately cancels
 * (Esc / scrim / close / Cancel button), so it records the outcome on the shared
 * `state.displayMediaCapture` object. The capture flow reads that to distinguish
 * a user cancel (quiet) from a real failure (danger toast) -- the getDisplayMedia
 * rejection name is NOT reliable for this (a genuine OS denial rejects the same
 * way as a user cancel).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDisplayMediaPicker = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  // Resolve the inventory action-button primitive the same way the Exploded View
  // modules do: prefer the browser global, fall back to require() under Node.
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

  const inventoryButton = resolveModule('inventoryActionButton', '../inventory/action-button');
  const resolvedActionButton = typeof inventoryButton === 'function'
    ? inventoryButton
    : inventoryButton.actionButton || inventoryButton.default || null;

  // Only PNG/JPEG base64 data URLs from our own main process are allowed into
  // an <img src>; anything else falls back to a placeholder tile.
  const THUMBNAIL_DATA_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/;

  function defaultEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createDisplayMediaPicker(deps) {
    const options = deps || {};
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const bridge = options.bridge || null; // window.jennyShell.displayMediaPicker
    const helpOverlayFactory = typeof options.helpOverlayFactory === 'function'
      ? options.helpOverlayFactory
      : null;
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : defaultEscape;
    const state = options.state || {};
    // The tiles and the Cancel control are rendered through the inventory
    // action-button primitive (no raw button/input/select markup — enforced by
    // check_no_raw_html_primitives). A deps override keeps it stubbable.
    const actionButton = typeof options.actionButton === 'function'
      ? options.actionButton
      : resolvedActionButton;

    let overlay = null;
    let activeRequestId = null;
    let settled = true; // true when no request is open
    let docClickHandler = null;
    let bound = false;
    const cleanupFns = [];

    // Shared handshake object read by the capture flow's catch
    // (renderer-attachment-event-utils.js) to tell "user cancelled" from a real
    // failure. Lazily initialized so either module can create it first.
    function captureState() {
      if (!state.displayMediaCapture) {
        state.displayMediaCapture = { inFlight: false, lastOutcome: null };
      }
      return state.displayMediaCapture;
    }

    function ensureOverlay() {
      if (overlay || !helpOverlayFactory || !doc) {
        return overlay;
      }
      overlay = helpOverlayFactory({ document: doc, hostId: 'displayMediaPickerOverlay' });
      return overlay;
    }

    function isValidThumbnail(url) {
      return typeof url === 'string' && THUMBNAIL_DATA_URL.test(url);
    }

    function buildTile(source) {
      const id = String((source && source.id) || '');
      const name = String((source && source.name) || 'Untitled');
      const thumb = isValidThumbnail(source && source.thumbnailDataUrl) ? source.thumbnailDataUrl : '';
      const media = thumb
        ? `<img class="capture-source-thumb" src="${escapeHtml(thumb)}" alt="" />`
        : '<div class="capture-source-thumb capture-source-thumb--empty" aria-hidden="true"></div>';
      // media + name are already escaped, so they ride in as trustedHtml; the
      // source id is escaped again by the primitive as it lands in the dataset.
      const tileContent = media
        + `<span class="capture-source-name">${escapeHtml(name)}</span>`;
      return actionButton({
        plain: true,
        className: 'capture-source-tile',
        title: name,
        trustedHtml: tileContent,
        dataset: { 'capture-source-id': id },
      });
    }

    function buildSection(label, items) {
      if (!items.length) {
        return '';
      }
      return '<div class="capture-source-section">'
        + `<div class="capture-source-section-label">${escapeHtml(label)}</div>`
        + `<div class="capture-source-grid">${items.map(buildTile).join('')}</div>`
        + '</div>';
    }

    function buildBodyHtml(sources) {
      const screens = [];
      const windows = [];
      (Array.isArray(sources) ? sources : []).forEach((source) => {
        if (source && source.kind === 'window') {
          windows.push(source);
        } else if (source) {
          screens.push(source);
        }
      });
      let body = buildSection('Screens', screens) + buildSection('Windows', windows);
      if (!body) {
        body = '<p class="capture-source-empty">No screens or windows are available to capture.</p>';
      }
      return `${body}<div class="capture-source-actions">`
        + actionButton({
          plain: true,
          className: 'capture-source-cancel',
          label: 'Cancel',
          dataset: { 'capture-source-cancel': 'true' },
        })
        + '</div>';
    }

    function respond(requestId, sourceId) {
      if (bridge && typeof bridge.respond === 'function') {
        try {
          const result = bridge.respond(requestId, sourceId);
          if (result && typeof result.then === 'function') {
            result.catch(() => {
              /* an IPC-layer failure falls back to main's backstop timeout */
            });
          }
        } catch (_error) {
          /* best-effort: a failed respond falls back to main's backstop timeout */
        }
      }
    }

    function closeOverlaySilently() {
      if (overlay && typeof overlay.isOpen === 'function' && overlay.isOpen()) {
        try {
          overlay.close();
        } catch (_error) {
          /* best-effort */
        }
      }
    }

    function detachDocClick() {
      if (docClickHandler && doc) {
        doc.removeEventListener('click', docClickHandler, true);
      }
      docClickHandler = null;
    }

    // Resolve the currently-open request exactly once: record the outcome, close
    // the modal, and echo the choice back to main. `sourceId` null => cancel.
    // Idempotent via `settled` so overlay.close()'s onClose re-entry is a no-op.
    function finishPick(sourceId) {
      if (settled) {
        return;
      }
      settled = true;
      const requestId = activeRequestId;
      activeRequestId = null;
      detachDocClick();
      captureState().lastOutcome = sourceId ? 'picked' : 'cancelled';
      closeOverlaySilently();
      respond(requestId, sourceId || null);
    }

    function handleRequest(payload) {
      const requestId = payload && payload.requestId;
      if (requestId == null) {
        return;
      }
      const inst = ensureOverlay();
      if (!inst) {
        // No overlay chrome available (restricted shell) -- cancel so
        // getDisplayMedia rejects cleanly rather than hanging on main's backstop.
        respond(requestId, null);
        return;
      }
      // Supersede any modal still open for a prior request (cancels it first).
      if (activeRequestId != null && !settled) {
        finishPick(null);
      }
      settled = false;
      activeRequestId = requestId;
      // Pending default: any resolution other than an explicit pick (user
      // cancel, main-side backstop timeout, or dispose) leaves this 'cancelled',
      // so the capture flow's catch stays quiet even if a timeout's
      // getDisplayMedia rejection races ahead of the onCancel push.
      captureState().lastOutcome = 'cancelled';
      docClickHandler = (event) => {
        const target = event.target;
        if (!target || typeof target.closest !== 'function') {
          return;
        }
        if (target.closest('[data-capture-source-cancel]')) {
          event.preventDefault();
          finishPick(null);
          return;
        }
        const tile = target.closest('[data-capture-source-id]');
        if (tile) {
          event.preventDefault();
          finishPick(tile.getAttribute('data-capture-source-id') || null);
        }
      };
      doc.addEventListener('click', docClickHandler, true);
      inst.open({
        title: 'Choose what to capture',
        titleId: 'displayMediaPickerTitle',
        bodyHtml: buildBodyHtml(payload && payload.sources),
        closeLabel: 'Cancel screen capture',
        onClose: () => finishPick(null), // Esc / scrim / close button => cancel
      });
    }

    // Main's backstop timer (or dispose) fired for a request -- dismiss the stale
    // modal WITHOUT responding again (main has already resolved that request).
    function handleCancel(payload) {
      const requestId = payload && payload.requestId;
      if (requestId == null || requestId !== activeRequestId || settled) {
        return;
      }
      settled = true;
      activeRequestId = null;
      detachDocClick();
      captureState().lastOutcome = 'cancelled';
      closeOverlaySilently();
    }

    function bind() {
      if (bound) {
        return;
      }
      bound = true;
      if (bridge && typeof bridge.onRequest === 'function') {
        cleanupFns.push(bridge.onRequest(handleRequest));
      }
      if (bridge && typeof bridge.onCancel === 'function') {
        cleanupFns.push(bridge.onCancel(handleCancel));
      }
    }

    function dispose() {
      while (cleanupFns.length) {
        const cleanup = cleanupFns.pop();
        try {
          if (typeof cleanup === 'function') {
            cleanup();
          }
        } catch (_error) {
          /* best-effort teardown */
        }
      }
      // Release any in-flight getDisplayMedia so it doesn't hang on renderer
      // teardown, and mark it a cancel so its rejection stays quiet.
      if (activeRequestId != null && !settled) {
        captureState().lastOutcome = 'cancelled';
        respond(activeRequestId, null);
      }
      settled = true;
      activeRequestId = null;
      detachDocClick();
      closeOverlaySilently();
      if (overlay && typeof overlay.destroy === 'function') {
        try {
          overlay.destroy();
        } catch (_error) {
          /* best-effort */
        }
      }
      overlay = null;
      bound = false;
    }

    return { bind, dispose };
  }

  return { createDisplayMediaPicker };
});
