/* renderer/features/renderer-ide-active-file-context.js
 * Tier-3 explicit active-file context — renderer half.
 *
 * Offers the file the user is currently looking at (its path + a cursor-region
 * slice) only after an explicit one-send composer opt-in, shown via a
 * transparent, removable chip ("Jenny can see editor.js — ✕"). The send path
 * (renderer-send-utils.js) calls readActiveFileContextForTurn() right before
 * chat.startStream and rides the result on the per-turn payload; the backend
 * (chat-stream-context-assembly.js) splices it in only when the default-ON
 * workspace_active_file_context flag is enabled.
 *
 * Fully decoupled from the IDE controller (mirrors renderer-chat-codebase-cite-
 * utils.js): the editor host stashes a live read-only accessor on
 * window.rendererIdeActiveEditorReader and fires `ide:active-file-changed` on
 * activation; this module listens for that event to refresh its chip and reads
 * the accessor at send time to compute a FRESH cursor-region slice. No
 * controller wire, no new IPC. Gated on the flag read once at boot; when the
 * flag is OFF nothing is attached and the chip never renders.
 *
 * Dedupe authority lives here: readActiveFileContextForTurn returns null when
 * the active file is already arriving via an @-mention or a composer
 * attachment, so a file is never sent twice.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  var api = factory();
  root.rendererIdeActiveFileContext = api;
  if (api && typeof api.installSelf === 'function') {
    api.installSelf(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_SLICE_RADIUS = 60; // lines kept on each side of the cursor
  var MAX_SLICE_CHARS = 8000; // renderer-side guard before the backend re-caps

  var EYE_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">'
    + '<path d="M8 3.5C4.5 3.5 1.8 6 1 8c.8 2 3.5 4.5 7 4.5S14.2 10 15 8c-.8-2-3.5-4.5-7-4.5z" '
    + 'fill="none" stroke="currentColor" stroke-width="1.2"/>'
    + '<circle cx="8" cy="8" r="2" fill="currentColor"/></svg>';
  var DISMISS_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
    + '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" fill="none" '
    + 'stroke-linecap="round"/></svg>';

  function normalizePath(value) {
    return String(value || '').trim().replace(/\\/g, '/');
  }

  function basename(relPath) {
    var normalized = normalizePath(relPath);
    var parts = normalized.split('/');
    return parts[parts.length - 1] || normalized;
  }

  function clampInt(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  }

  // Approx token cost of a slice (~4 chars/token, matching the backend
  // estimate), formatted compactly for the chip ("1.2k" / "850").
  function approxTokenLabel(text) {
    var tokens = Math.ceil(String(text || '').length / 4);
    return tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : String(tokens);
  }

  // Compute a fresh cursor-region slice from the editor host's live accessor.
  // Returns the structured context object or null when there is no file-kind
  // active document (image/preview/diff tabs, or no editor yet).
  function computeActiveSlice(reader, radius) {
    if (!reader || typeof reader.getActivePath !== 'function') {
      return null;
    }
    var path = normalizePath(reader.getActivePath());
    if (!path) {
      return null;
    }
    // Only real text files carry a cursor-region slice; image/preview/diff
    // documents report a non-'file' kind (and getCursorInfo() returns null).
    if (typeof reader.getDocumentKind === 'function' && reader.getDocumentKind(path) !== 'file') {
      return null;
    }
    // Large/minified files are excluded from auto-context: the editor host
    // flags them and getValue() would be a full multi-MB string copy. This is
    // the "too large to auto-context" guard that feeds the budget trimmer.
    if (typeof reader.isLargeFile === 'function' && reader.isLargeFile()) {
      return null;
    }
    var cursor = typeof reader.getCursorInfo === 'function' ? reader.getCursorInfo() : null;
    if (!cursor) {
      return null;
    }
    var all = typeof reader.getValue === 'function' ? String(reader.getValue(path) || '') : '';
    var lines = all.split('\n');
    var totalLines = lines.length;
    var cursorLine = Math.max(1, clampInt(cursor.lineNumber, 1));
    var cursorColumn = Math.max(1, clampInt(cursor.column, 1));
    var r = Number.isFinite(radius) ? radius : DEFAULT_SLICE_RADIUS;
    var startIndex = Math.max(0, cursorLine - 1 - r);
    var endIndex = Math.min(totalLines, cursorLine + r);
    var slice = lines.slice(startIndex, endIndex).join('\n');
    if (slice.length > MAX_SLICE_CHARS) {
      var cursorIndex = Math.min(totalLines - 1, cursorLine - 1);
      var beforeCursor = lines.slice(startIndex, cursorIndex).join('\n');
      var cursorOffset = beforeCursor.length + (cursorIndex > startIndex ? 1 : 0)
        + Math.min(cursorColumn - 1, lines[cursorIndex].length);
      var windowStart = Math.max(0, Math.min(slice.length - MAX_SLICE_CHARS,
        cursorOffset - Math.floor(MAX_SLICE_CHARS / 2)));
      startIndex += (slice.slice(0, windowStart).match(/\n/g) || []).length;
      slice = slice.slice(windowStart, windowStart + MAX_SLICE_CHARS);
      endIndex = startIndex + (slice.match(/\n/g) || []).length + (slice.endsWith('\n') ? 0 : 1);
    }
    if (!slice.trim()) {
      return null; // empty buffer — nothing useful to send
    }
    return {
      path: path,
      languageId: typeof reader.getActiveLanguageId === 'function'
        ? String(reader.getActiveLanguageId() || '') : '',
      cursor: { lineNumber: cursorLine, column: cursorColumn },
      startLine: startIndex + 1,
      endLine: endIndex,
      totalLines: totalLines,
      slice: slice,
    };
  }

  function createActiveFileContextController(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var win = options.window || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    var getComposerWrap = typeof options.getComposerWrap === 'function'
      ? options.getComposerWrap
      : function defaultGetComposerWrap() { return doc ? doc.getElementById('composerWrap') : null; };
    var getReader = typeof options.getReader === 'function'
      ? options.getReader
      : function defaultGetReader() { return win ? win.rendererIdeActiveEditorReader : null; };
    var getActionHost = typeof options.getActionHost === 'function'
      ? options.getActionHost
      : function defaultGetActionHost() { return doc ? doc.getElementById('composerActiveFileActionHost') : null; };
    var actionButton = typeof options.actionButton === 'function'
      ? options.actionButton
      : (win && typeof win.inventoryActionButton === 'function' ? win.inventoryActionButton : null);
    var isEnabled = typeof options.isEnabled === 'function'
      ? options.isEnabled
      : function defaultIsEnabled() { return true; };
    var radius = Number.isFinite(options.sliceRadius) ? options.sliceRadius : DEFAULT_SLICE_RADIUS;
    var appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};

    var disposed = false;
    var chipEl = null;
    var labelEl = null;
    var budgetEl = null;
    // Session-only consent: switching files/sessions or clicking ✕ clears it;
    // only an accepted live/queued send consumes a successfully captured slice.
    var armedPath = null;
    var attached = false;
    var onChangeBound = null;
    var onChipClickBound = null;
    var onActionClickBound = null;
    var onComposerFocusBound = null;
    var onRootCommittedBound = null;

    function currentActivePath() {
      var reader = getReader();
      if (!reader || typeof reader.getActivePath !== 'function') {
        return '';
      }
      var path = normalizePath(reader.getActivePath());
      if (!path) {
        return '';
      }
      if (typeof reader.getDocumentKind === 'function' && reader.getDocumentKind(path) !== 'file') {
        return '';
      }
      return path;
    }

    function ensureChip() {
      if (chipEl || !doc || !actionButton) {
        return chipEl;
      }
      var wrap = getComposerWrap();
      if (!wrap) {
        return null;
      }
      chipEl = doc.createElement('div');
      chipEl.className = 'active-file-context-chip hidden';
      chipEl.id = 'activeFileContextChip';
      chipEl.setAttribute('role', 'status');
      chipEl.setAttribute('aria-live', 'polite');
      chipEl.innerHTML =
        '<span class="active-file-context-chip-icon" aria-hidden="true">' + EYE_SVG + '</span>'
        + '<span class="active-file-context-chip-label"></span>'
        + '<span class="active-file-context-chip-budget" aria-hidden="true"></span>'
        + actionButton({
          plain: true,
          className: 'active-file-context-chip-dismiss',
          ariaLabel: 'Stop sharing the active file with Jenny',
          title: 'Stop sharing the active file with Jenny',
          dataset: { 'active-file-dismiss': '1' },
          trustedHtml: DISMISS_SVG,
        });
      labelEl = chipEl.querySelector('.active-file-context-chip-label');
      budgetEl = chipEl.querySelector('.active-file-context-chip-budget');
      // Mount above the composer input, alongside the attachment/notice rows.
      wrap.insertBefore(chipEl, wrap.firstChild);
      chipEl.addEventListener('click', onChipClickBound);
      return chipEl;
    }

    function hideChip() {
      if (chipEl) {
        chipEl.classList.add('hidden');
      }
    }

    function hideAction() {
      var host = getActionHost();
      if (host) host.classList.add('hidden');
    }

    function renderAction(info) {
      var host = getActionHost();
      if (!host || !actionButton || !info) {
        hideAction();
        return;
      }
      var name = basename(info.path);
      var armed = armedPath === info.path;
      var escape = typeof actionButton.escapeHtml === 'function'
        ? actionButton.escapeHtml
        : function fallbackEscape(value) { return String(value || ''); };
      var html = actionButton({
        plain: true,
        className: 'composer-popover-action composer-active-file-action',
        ariaLabel: armed ? 'Active workspace file added to the next message' : 'Add active workspace file to the next message',
        ariaPressed: armed,
        dataset: { 'active-file-arm': '1' },
        trustedHtml: '<span>' + (armed ? 'Active File Added' : 'Add Active File') + '</span>'
          + '<span class="composer-active-file-name">' + escape(name) + '</span>',
      });
      if (host.__jennyActiveFileActionMarkup !== html) {
        host.innerHTML = html;
        host.__jennyActiveFileActionMarkup = html;
      }
      host.classList.remove('hidden');
    }

    function refreshChip() {
      if (disposed || !isEnabled()) {
        hideChip();
        hideAction();
        return;
      }
      var path = currentActivePath();
      if (!path) {
        hideChip();
        hideAction();
        return;
      }
      // Compute the slice the way the send path will: a null result (non-file,
      // empty, or too-large-for-context) means there is nothing to offer, so the
      // chip stays hidden rather than claiming Jenny can see a file she can't.
      // Always recompute (no cache): the slice is cheap for the file sizes we
      // slice (large files are excluded before getValue), and recomputing on
      // every refresh is what keeps the token-cost label fresh after an in-place
      // edit — which fires no activation event this module can hear.
      var info = computeActiveSlice(getReader(), radius);
      if (!info) {
        hideChip();
        hideAction();
        return;
      }
      renderAction(info);
      if (armedPath !== info.path) {
        hideChip();
        return;
      }
      if (!ensureChip()) {
        return;
      }
      if (labelEl) {
        labelEl.textContent = 'Jenny can see ' + basename(path);
      }
      if (budgetEl) {
        budgetEl.textContent = '~' + approxTokenLabel(info.slice) + ' tokens';
      }
      chipEl.setAttribute('title', 'Jenny can see ' + path + ' (~' + approxTokenLabel(info.slice)
        + ' tokens) — click ✕ to stop sharing it this turn.');
      chipEl.classList.remove('hidden');
    }

    function handleActiveFileChanged(event) {
      // Explicit consent belongs to one exact file and never transfers.
      var nextPath = normalizePath(event && event.detail && event.detail.path);
      if (armedPath && nextPath !== armedPath) {
        armedPath = null;
      }
      refreshChip();
    }

    function handleActionClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function' || !target.closest('[data-active-file-arm]')) {
        return;
      }
      event.preventDefault();
      var info = computeActiveSlice(getReader(), radius);
      if (!info) {
        armedPath = null;
        refreshChip();
        return;
      }
      armedPath = armedPath === info.path ? null : info.path;
      appendClientLog('INFO', armedPath ? 'chat.active_file_context_armed' : 'chat.active_file_context_dismissed', {
        file_name: basename(info.path),
      });
      refreshChip();
    }

    function handleChipClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      if (!target.closest('[data-active-file-dismiss]')) {
        return;
      }
      event.preventDefault();
      var dismissedPath = armedPath || currentActivePath();
      armedPath = null;
      appendClientLog('INFO', 'chat.active_file_context_dismissed', { file_name: basename(dismissedPath) });
      refreshChip();
    }

    // Re-validate when the composer regains focus. This covers two transitions
    // the editor host does not announce via `ide:active-file-changed`:
    //   1. closing the LAST tab (showEmpty fires no activation event), and
    //   2. an IN-PLACE edit of the active file — the host fires no content-change
    //      event this controller-free module can hear, so without a focus-time
    //      recompute the token-cost label would stay stale. Focus is the
    //      post-edit refresh point (the user moves to the composer to act on the
    //      chip); refreshChip always recomputes a fresh slice (no cache).
    function handleComposerFocus() {
      refreshChip();
    }

    // Root switch (JCA-005): consent belongs to one file in one workspace
    // root. Without this, arming README.md under root A survives a root
    // transition and authorizes sending root B's same-relative-path README.md.
    // Every committed root change (broadcast by the IDE controller on the
    // window) clears the pending consent outright.
    function handleRootCommitted() {
      clearPending();
    }

    function attach() {
      if (disposed || attached || !win) {
        return dispose;
      }
      attached = true;
      onChangeBound = handleActiveFileChanged;
      onChipClickBound = handleChipClick;
      onActionClickBound = handleActionClick;
      onComposerFocusBound = handleComposerFocus;
      onRootCommittedBound = handleRootCommitted;
      win.addEventListener('ide:active-file-changed', onChangeBound);
      win.addEventListener('ide:workspace-root-committed', onRootCommittedBound);
      var actionHost = getActionHost();
      if (actionHost) {
        actionHost.addEventListener('click', onActionClickBound);
      }
      var wrap = getComposerWrap();
      if (wrap) {
        wrap.addEventListener('focusin', onComposerFocusBound);
      }
      refreshChip();
      return dispose;
    }

    // The send-path entry point. Computes a fresh slice and applies dedupe
    // against @-mentioned and already-attached paths. Returns null (send
    // nothing) when not explicitly armed, when there is no file-kind active document, or
    // when the file is already arriving another way.
    function readActiveFileContextForTurn(args) {
      if (disposed || !isEnabled()) {
        return null;
      }
      var info = computeActiveSlice(getReader(), radius);
      if (!info) {
        return null;
      }
      if (!armedPath || armedPath !== info.path) {
        return null;
      }
      var params = args || {};
      var mentioned = (Array.isArray(params.mentionedPaths) ? params.mentionedPaths : [])
        .map(normalizePath)
        .filter(Boolean);
      if (mentioned.indexOf(info.path) !== -1) {
        return null; // already sent as an @-mention
      }
      var attachedNorm = (Array.isArray(params.attachedPaths) ? params.attachedPaths : [])
        .map(normalizePath)
        .filter(Boolean);
      for (var i = 0; i < attachedNorm.length; i += 1) {
        var a = attachedNorm[i];
        // Attachment paths are typically absolute; the active path is
        // workspace-relative. Match on a path-segment boundary so 'a.js' does
        // not spuriously match 'bba.js'.
        if (a === info.path || a.slice(-(info.path.length + 1)) === '/' + info.path) {
          return null; // already sent as a composer attachment (path match)
        }
      }
      // Text attachments carry only a display name (no path), so fall back to a
      // basename match — the file the user attached AND is looking at must not be
      // sent twice. A same-basename-different-dir collision merely drops the
      // (lower-value) cursor slice; it can never cause a double-send.
      var activeName = basename(info.path);
      if (activeName) {
        var attachedNames = (Array.isArray(params.attachedNames) ? params.attachedNames : [])
          .map(basename)
          .filter(Boolean);
        if (attachedNames.indexOf(activeName) !== -1) {
          return null; // already sent as a composer attachment (name match)
        }
      }
      return info;
    }

    function clearPending() {
      var changed = Boolean(armedPath);
      armedPath = null;
      refreshChip();
      return changed;
    }

    function markTurnAccepted(path) {
      var acceptedPath = normalizePath(path);
      if (!armedPath || (acceptedPath && acceptedPath !== armedPath)) {
        return false;
      }
      return clearPending();
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (win && onChangeBound) {
        win.removeEventListener('ide:active-file-changed', onChangeBound);
      }
      if (win && onRootCommittedBound) {
        win.removeEventListener('ide:workspace-root-committed', onRootCommittedBound);
      }
      var wrap = getComposerWrap();
      if (wrap && onComposerFocusBound) {
        wrap.removeEventListener('focusin', onComposerFocusBound);
      }
      if (chipEl) {
        if (onChipClickBound) {
          chipEl.removeEventListener('click', onChipClickBound);
        }
        if (chipEl.parentNode) {
          chipEl.parentNode.removeChild(chipEl);
        }
      }
      var actionHost = getActionHost();
      if (actionHost && onActionClickBound) {
        actionHost.removeEventListener('click', onActionClickBound);
        actionHost.classList.add('hidden');
      }
      chipEl = null;
      labelEl = null;
    }

    return {
      attach: attach,
      dispose: dispose,
      refreshChip: refreshChip,
      readActiveFileContextForTurn: readActiveFileContextForTurn,
      clearPending: clearPending,
      markTurnAccepted: markTurnAccepted,
      isArmed: function isArmed() { return Boolean(armedPath); },
    };
  }

  // Singleton installed against the live DOM + the real flag state, mirroring
  // renderer-chat-codebase-cite-utils.js: the flag is read once at boot (no
  // onChanged subscription, to avoid a cross-reload listener leak), and the
  // event listener/chip are only wired when the flag is ON.
  var installedController = null;

  // logs.clientAppend is the current batched sink, taking an
  // { entries, dropped_count } shape. Forwarding is best-effort.
  function forwardClientLog(root, level, code, detail) {
    try {
      var logs = root && root.jennyShell && root.jennyShell.logs;
      if (!logs || typeof logs.clientAppend !== 'function') {
        return;
      }
      var data = (detail && typeof detail === 'object' && !Array.isArray(detail)) ? detail : {};
      var event = String(code || 'renderer.event').trim() || 'renderer.event';
      logs.clientAppend({
        entries: [{
          ts: new Date().toISOString(),
          level: String(level || 'INFO').trim().toUpperCase() || 'INFO',
          layer: 'renderer',
          source: 'renderer',
          component: 'renderer.ide.active_file',
          event: event,
          message: String(data.message || data.reason || event),
          data: data,
          details: data,
        }],
        dropped_count: 0,
      });
    } catch (_error) { /* logging is best-effort */ }
  }

  function installSelf(root) {
    var doc = root && root.document;
    if (!doc) {
      return null; // non-browser (test) context
    }
    var enabled = false;
    var controller = null;
    var controllerDispose = null;

    function isEnabled() {
      return enabled === true;
    }

    function ensureAttached() {
      if (enabled && controller && !controllerDispose) {
        controllerDispose = controller.attach();
      }
    }

    function applyFlagState(state) {
      enabled = Boolean(
        state && state.featureFlags && state.featureFlags.workspace_active_file_context === true
      );
      ensureAttached();
    }

    function refreshFlag() {
      try {
        var features = root.jennyShell && root.jennyShell.features;
        if (features && typeof features.getState === 'function') {
          Promise.resolve(features.getState()).then(applyFlagState).catch(function noop() {});
        }
      } catch (_error) {
        /* best-effort — feature gating just stays off */
      }
    }

    function boot() {
      controller = createActiveFileContextController({
        document: doc,
        window: root,
        isEnabled: isEnabled,
        appendClientLog: function appendClientLog(level, code, detail) {
          forwardClientLog(root, level, code, detail);
        },
      });
      installedController = controller;
      refreshFlag();
    }

    function dispose() {
      if (typeof controllerDispose === 'function') {
        controllerDispose();
        controllerDispose = null;
      } else if (controller && typeof controller.dispose === 'function') {
        controller.dispose();
      }
      if (installedController === controller) {
        installedController = null;
      }
    }

    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
    return { boot: boot, dispose: dispose };
  }

  // Module-level send-path entry: delegates to the installed singleton (returns
  // null when the feature is off / not installed, e.g. in tests).
  function readActiveFileContextForTurn(args) {
    if (installedController && typeof installedController.readActiveFileContextForTurn === 'function') {
      return installedController.readActiveFileContextForTurn(args);
    }
    return null;
  }

  function clearPending() {
    return installedController?.clearPending?.() === true;
  }

  function markTurnAccepted(path) {
    return installedController?.markTurnAccepted?.(path) === true;
  }

  function isArmed() {
    return installedController?.isArmed?.() === true;
  }

  return {
    createActiveFileContextController: createActiveFileContextController,
    computeActiveSlice: computeActiveSlice,
    installSelf: installSelf,
    forwardClientLog: forwardClientLog,
    readActiveFileContextForTurn: readActiveFileContextForTurn,
    clearPending: clearPending,
    isArmed: isArmed,
    markTurnAccepted: markTurnAccepted,
  };
});
