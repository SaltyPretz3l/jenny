/* renderer/features/renderer-ide-mention-autocomplete.js
 * Tier-3 "@file mentions" — composer autocomplete.
 *
 * Typing `@partial` in the chat composer (#chatInput) opens a Quick-Open-backed
 * popover of matching workspace files (reusing the command palette's subsequence
 * scorer). Accepting a suggestion rewrites the token to `@<relpath>` and records
 * the mention; the send path (renderer-send-utils.js) calls collectMentionContents()
 * to resolve each mention to file content via window.jennyShell.workspaceFs.readFile
 * and rides it on the per-turn payload. @symbol mentions are intentionally NOT
 * implemented (would need a controller wire into Monaco's DocumentSymbol provider).
 *
 * Fully decoupled from the IDE controller (mirrors renderer-ide-quick-open.js /
 * renderer-chat-codebase-cite-utils.js): owns its own listeners on #chatInput +
 * a capture-phase keydown so it can claim Arrow/Enter/Escape before the composer's
 * send handler. Gated on the default-ON workspace_active_file_context flag read
 * once at boot; when OFF nothing is attached. No new IPC.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  var api = factory();
  root.rendererIdeMentionAutocomplete = api;
  if (api && typeof api.installSelf === 'function') {
    api.installSelf(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_RESULTS = 8; // popover rows
  var MAX_MENTIONS = 8; // cap @-mentions resolved per turn (matches attachment cap)
  var MAX_RECORDED = 64; // cap the accept-history (memory bound; see acceptPath)
  var FILES_TTL_MS = 4000; // re-index the workspace file list after this long
  // Per-file cap on resolving an @mention to its contents. A hung workspace read
  // (e.g. a stalled network mount under the workspace root) must degrade to a
  // skip, never leave the send awaiting a promise that never settles.
  var MENTION_READ_TIMEOUT_MS = 5000;

  // Match a trailing `@partial` token before the caret: the `@` must start the
  // text or follow whitespace / an opening paren, and the partial is everything
  // up to the caret that is not whitespace or another `@`.
  var TRIGGER_RE = /(?:^|[\s([{])@([^\s@]*)$/;

  function normalizePath(value) {
    return String(value || '').trim().replace(/\\/g, '/');
  }

  function basename(relPath) {
    var parts = normalizePath(relPath).split('/');
    return parts[parts.length - 1] || relPath;
  }

  function defaultEscapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createMentionAutocomplete(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var win = options.window || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    var getInput = typeof options.getInput === 'function'
      ? options.getInput
      : function defaultGetInput() { return doc ? doc.getElementById('chatInput') : null; };
    var getMountEl = typeof options.getMountEl === 'function'
      ? options.getMountEl
      : function defaultGetMountEl() { return doc ? doc.body : null; };
    var getWorkspaceFs = typeof options.getWorkspaceFs === 'function'
      ? options.getWorkspaceFs
      : function defaultGetWorkspaceFs() { return (win && win.jennyShell && win.jennyShell.workspaceFs) || null; };
    var paletteUtils = options.paletteUtils
      || (win && win.rendererCommandPaletteUtils)
      || {};
    var escapeHtml = typeof options.escapeHtml === 'function'
      ? options.escapeHtml
      : ((win && win.stringUtils && win.stringUtils.escapeHtml) || defaultEscapeHtml);
    var isEnabled = typeof options.isEnabled === 'function'
      ? options.isEnabled
      : function defaultIsEnabled() { return true; };
    var appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};
    var nowMs = typeof options.now === 'function'
      ? options.now
      : function defaultNow() { return Date.now(); };
    // Timer source: prefer the captured window (so jsdom/fake-timer tests drive it),
    // fall back to the global timers when no window is available.
    var setTimeoutFn = (win && typeof win.setTimeout === 'function')
      ? function scheduleTimeout(fn, ms) { return win.setTimeout(fn, ms); }
      : function scheduleTimeout(fn, ms) { return setTimeout(fn, ms); };
    var clearTimeoutFn = (win && typeof win.clearTimeout === 'function')
      ? function cancelTimeout(handle) { win.clearTimeout(handle); }
      : function cancelTimeout(handle) { clearTimeout(handle); };
    var asyncFence = options.asyncFence || (win && win.rendererAsyncFence) || null;
    if (!asyncFence && typeof require === 'function') {
      asyncFence = require('../shared/async-fence');
    }
    var filesGate = asyncFence.createGenerationGate();

    var disposed = false;
    var attached = false;
    var inputEl = null;
    var popoverEl = null;
    var resultsEl = null;
    var visible = false;
    var allFiles = null; // null = not fetched
    var filesFetchedAt = 0; // nowMs() of the last successful listAllFiles
    var loadingToken = null;
    var matches = [];
    var selectedIndex = 0;
    var triggerStart = -1; // index in the textarea value where the `@` sits
    var triggerEnd = -1; // caret index (exclusive end of the partial)
    // Root identity of the cached file list (`rootId|generation` from
    // listAllFiles, or null when the service reports none). JCA-001: the cache
    // and the accepted records are bound to this key so a mention accepted
    // under root A can never resolve a same-relative-path file under root B.
    var filesRootKey = null;
    // Recorded accepted mentions ({ path, rootKey }, workspace-relative).
    // collectMentionPaths() filters these to the ones still present in the
    // live text AND recorded under the current root, so deleting an `@mention`
    // or switching workspace roots drops it from the turn.
    var recorded = [];

    function rootKeyOf(result) {
      if (!result || result.rootId == null) {
        return null;
      }
      return String(result.rootId) + '|' + String(result.generation);
    }

    // Listener references (so dispose can detach exactly what attach added).
    var onInput = null;
    var onKeydownCapture = null;
    var onPointerDownCapture = null;
    var onPopoverClick = null;
    var onRootCommitted = null;

    function detectTrigger() {
      if (!inputEl) {
        return null;
      }
      var value = String(inputEl.value || '');
      var caret = Number(inputEl.selectionStart);
      if (!Number.isFinite(caret)) {
        caret = value.length;
      }
      var before = value.slice(0, caret);
      var match = TRIGGER_RE.exec(before);
      if (!match) {
        return null;
      }
      var partial = match[1] || '';
      return { partial: partial, start: caret - partial.length - 1, end: caret };
    }

    async function ensureFiles() {
      var requestToken = filesGate.capture();
      if (loadingToken && filesGate.isCurrent(loadingToken)) {
        return;
      }
      // Re-index when the cached list is older than the TTL so files created
      // after the popover first opened still autocomplete; the stale list stays
      // visible during the refresh (no "Indexing…" flash on reopen).
      if (allFiles && (nowMs() - filesFetchedAt) < FILES_TTL_MS) {
        return;
      }
      var fsApi = getWorkspaceFs();
      if (!fsApi || typeof fsApi.listAllFiles !== 'function') {
        allFiles = allFiles || [];
        filesFetchedAt = nowMs();
        return;
      }
      loadingToken = requestToken;
      try {
        var result = await fsApi.listAllFiles();
        if (disposed || !filesGate.isCurrent(requestToken)) {
          return;
        }
        allFiles = Array.isArray(result && result.files) ? result.files : [];
        filesFetchedAt = nowMs();
        var nextRootKey = rootKeyOf(result);
        if (nextRootKey !== filesRootKey) {
          // The list came back from a different workspace root (a root switch
          // that raced the TTL): accepted mentions recorded under the old root
          // must not resolve against the new one.
          recorded = recorded.filter(function (entry) { return entry.rootKey === nextRootKey; });
          filesRootKey = nextRootKey;
        }
      } catch (error) {
        if (disposed || !filesGate.isCurrent(requestToken)) {
          return;
        }
        if (!allFiles) {
          allFiles = []; // keep any prior list visible on a refresh failure
        }
        appendClientLog('WARN', 'chat.mention_list_failed', {
          message: String((error && error.message) || error || ''),
        });
      } finally {
        if (loadingToken === requestToken) {
          loadingToken = null;
        }
      }
      if (visible) {
        refreshResults();
      }
    }

    function computeMatches(query) {
      var files = allFiles || [];
      var scorer = paletteUtils.scoreMatch;
      if (!query) {
        return files.slice(0, MAX_RESULTS).map(function (path) { return { path: path, ranges: [] }; });
      }
      if (typeof scorer !== 'function') {
        var needle = query.toLowerCase();
        return files
          .filter(function (path) { return path.toLowerCase().indexOf(needle) !== -1; })
          .slice(0, MAX_RESULTS)
          .map(function (path) { return { path: path, ranges: [] }; });
      }
      var scored = [];
      for (var i = 0; i < files.length; i += 1) {
        var m = scorer(files[i], query);
        if (m) {
          scored.push({ path: files[i], score: m.score, ranges: m.ranges });
        }
      }
      scored.sort(function (a, b) { return b.score - a.score || a.path.localeCompare(b.path); });
      return scored.slice(0, MAX_RESULTS);
    }

    function buildRowMarkup(match, index) {
      var highlight = typeof paletteUtils.highlightRanges === 'function'
        ? paletteUtils.highlightRanges(match.path, match.ranges, escapeHtml)
        : escapeHtml(match.path);
      var name = basename(match.path);
      return '<div class="ide-mention-row' + (index === selectedIndex ? ' ide-mention-row--selected' : '')
        + '" role="option" aria-selected="' + (index === selectedIndex ? 'true' : 'false') + '"'
        + ' data-ide-mention-path="' + escapeHtml(match.path) + '" title="' + escapeHtml(match.path) + '">'
        + '<span class="ide-mention-name">' + escapeHtml(name) + '</span>'
        + '<span class="ide-mention-path">' + highlight + '</span>'
        + '</div>';
    }

    function ensurePopover() {
      if (popoverEl || !doc) {
        return popoverEl;
      }
      var mount = getMountEl();
      if (!mount) {
        return null;
      }
      popoverEl = doc.createElement('div');
      popoverEl.className = 'ide-mention-popover hidden';
      popoverEl.setAttribute('role', 'listbox');
      popoverEl.setAttribute('aria-label', 'Mention a workspace file');
      resultsEl = doc.createElement('div');
      resultsEl.className = 'ide-mention-results';
      popoverEl.appendChild(resultsEl);
      mount.appendChild(popoverEl);
      popoverEl.addEventListener('click', onPopoverClick);
      return popoverEl;
    }

    function positionPopover() {
      if (!popoverEl || !inputEl || typeof inputEl.getBoundingClientRect !== 'function') {
        return;
      }
      var rect = inputEl.getBoundingClientRect();
      var viewportHeight = (win && win.innerHeight) || 0;
      popoverEl.style.position = 'fixed';
      popoverEl.style.left = Math.max(8, rect.left) + 'px';
      popoverEl.style.width = Math.max(180, rect.width) + 'px';
      // Float above the composer input.
      popoverEl.style.bottom = Math.max(8, viewportHeight - rect.top + 6) + 'px';
    }

    // Paint the popover from the CURRENT matches (no re-scoring). Used by both
    // refreshResults (after a re-score) and moveSelection (selection-only repaint).
    function renderRows() {
      if (!resultsEl) {
        return;
      }
      if (allFiles === null) {
        resultsEl.innerHTML = '<div class="ide-mention-status">Indexing workspace files…</div>';
      } else if (!matches.length) {
        resultsEl.innerHTML = '<div class="ide-mention-status">No matching files.</div>';
      } else {
        resultsEl.innerHTML = matches.map(buildRowMarkup).join('');
      }
      var selected = resultsEl.querySelector('.ide-mention-row--selected');
      if (selected && typeof selected.scrollIntoView === 'function') {
        selected.scrollIntoView({ block: 'nearest' });
      }
    }

    function refreshResults() {
      if (!resultsEl) {
        return;
      }
      var trigger = detectTrigger();
      var query = trigger ? trigger.partial : '';
      matches = computeMatches(query);
      selectedIndex = Math.max(0, Math.min(selectedIndex, matches.length - 1));
      renderRows();
    }

    function showPopover() {
      if (!ensurePopover()) {
        return;
      }
      visible = true;
      popoverEl.classList.remove('hidden');
      positionPopover();
      refreshResults();
    }

    function hidePopover() {
      visible = false;
      triggerStart = -1;
      triggerEnd = -1;
      if (popoverEl) {
        popoverEl.classList.add('hidden');
      }
    }

    function moveSelection(delta) {
      if (!matches.length) {
        return;
      }
      selectedIndex = (selectedIndex + delta + matches.length) % matches.length;
      renderRows(); // selection-only repaint — the query is unchanged, no re-score
    }

    function acceptPath(path) {
      var relPath = normalizePath(path);
      if (!relPath || !inputEl || triggerStart < 0) {
        hidePopover();
        return;
      }
      var value = String(inputEl.value || '');
      var insertion = '@' + relPath + ' ';
      var nextValue = value.slice(0, triggerStart) + insertion + value.slice(triggerEnd);
      inputEl.value = nextValue;
      var caret = triggerStart + insertion.length;
      try {
        inputEl.setSelectionRange(caret, caret);
      } catch (_error) { /* selection best-effort */ }
      var alreadyRecorded = recorded.some(function (entry) {
        return entry.path === relPath && entry.rootKey === filesRootKey;
      });
      if (!alreadyRecorded) {
        recorded.push({ path: relPath, rootKey: filesRootKey });
        // The accept-history intentionally outlives a single message (a draft
        // restore after a failed send must keep its mentions, and the post-send
        // composer clear fires no input event), so bound it here. collectMention*
        // still intersect with the live text, so this only caps memory.
        if (recorded.length > MAX_RECORDED) {
          recorded.shift();
        }
      }
      appendClientLog('INFO', 'chat.mention_accepted', { path: relPath });
      hidePopover();
      inputEl.focus();
      // Let the composer (auto-resize, etc.) observe the programmatic edit.
      try {
        if (win && typeof win.Event === 'function') {
          inputEl.dispatchEvent(new win.Event('input', { bubbles: true }));
        }
      } catch (_error) { /* best-effort */ }
    }

    function acceptSelected() {
      var match = matches[selectedIndex] || matches[0] || null;
      if (match) {
        acceptPath(match.path);
      } else {
        hidePopover();
      }
    }

    function handleInput() {
      if (disposed || !isEnabled() || !inputEl) {
        return;
      }
      if (!String(inputEl.value || '').trim()) {
        recorded = []; // input cleared (e.g. after send) — forget mentions
      }
      var trigger = detectTrigger();
      if (!trigger) {
        hidePopover();
        return;
      }
      triggerStart = trigger.start;
      triggerEnd = trigger.end;
      ensureFiles();
      showPopover();
    }

    function handleKeydownCapture(event) {
      if (disposed || !visible || !inputEl || event.target !== inputEl) {
        return;
      }
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          event.stopPropagation();
          moveSelection(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          event.stopPropagation();
          moveSelection(-1);
          break;
        case 'Enter':
        case 'Tab':
          event.preventDefault();
          event.stopPropagation();
          acceptSelected();
          break;
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          hidePopover();
          break;
        default:
          break;
      }
    }

    function handlePointerDownCapture(event) {
      if (!visible) {
        return;
      }
      var target = event && event.target;
      var insidePopover = popoverEl && target && typeof target.closest === 'function'
        && target.closest('.ide-mention-popover');
      if (target === inputEl || insidePopover) {
        return;
      }
      hidePopover();
    }

    function handlePopoverClick(event) {
      var target = event && event.target;
      var row = target && typeof target.closest === 'function'
        ? target.closest('[data-ide-mention-path]')
        : null;
      if (row) {
        event.preventDefault();
        acceptPath(row.getAttribute('data-ide-mention-path') || '');
      }
    }

    // Root switch (JCA-001): everything this module caches or has recorded is
    // scoped to one workspace root. On a committed root change, drop the file
    // list, the matches, the popover, and every accepted mention so a retained
    // draft cannot attach a same-relative-path file from the new root.
    function resetForRoot() {
      filesGate.bump();
      loadingToken = null;
      allFiles = null;
      filesFetchedAt = 0;
      filesRootKey = null;
      matches = [];
      selectedIndex = 0;
      recorded = [];
      hidePopover();
    }

    function attach() {
      if (disposed || attached) {
        return dispose;
      }
      inputEl = getInput();
      if (!inputEl || !win) {
        return dispose;
      }
      attached = true;
      onInput = handleInput;
      onKeydownCapture = handleKeydownCapture;
      onPointerDownCapture = handlePointerDownCapture;
      onRootCommitted = function handleRootCommitted() { resetForRoot(); };
      inputEl.addEventListener('input', onInput);
      // Capture phase so we intercept Arrow/Enter/Escape BEFORE the composer's
      // bubble-phase send handler claims Enter.
      doc.addEventListener('keydown', onKeydownCapture, true);
      doc.addEventListener('pointerdown', onPointerDownCapture, true);
      // The IDE controller broadcasts committed root transitions on the window
      // (this module is controller-free by design).
      win.addEventListener('ide:workspace-root-committed', onRootCommitted);
      return dispose;
    }

    // True when `@<path>` appears in the text as a whole token. An accepted
    // mention is always written as `@<path> ` (trailing space, see acceptPath),
    // so the char after the token must NOT be a path char — otherwise `@utils.js`
    // would spuriously match inside a later `@utils.js.map`.
    function mentionTokenPresent(value, path) {
      var token = '@' + path;
      var from = 0;
      for (;;) {
        var idx = value.indexOf(token, from);
        if (idx === -1) {
          return false;
        }
        var after = value.charAt(idx + token.length);
        if (after === '' || !/[\w./\\-]/.test(after)) {
          return true;
        }
        from = idx + 1;
      }
    }

    // Mentions still present in the live composer text (workspace-relative),
    // restricted to records accepted under the CURRENT root (JCA-001).
    function collectMentionPaths() {
      if (!inputEl) {
        return [];
      }
      var value = String(inputEl.value || '');
      var present = [];
      for (var i = 0; i < recorded.length; i += 1) {
        var entry = recorded[i];
        if (entry.rootKey !== filesRootKey) {
          continue; // accepted under a different workspace root
        }
        if (mentionTokenPresent(value, entry.path) && present.indexOf(entry.path) === -1) {
          present.push(entry.path);
        }
      }
      return present.slice(0, MAX_MENTIONS);
    }

    // Resolve each present mention to { path, content } via workspaceFs.readFile.
    // Failures (binary / too large / not found throw typed errors) are skipped,
    // never blocking the turn. Each read races a per-file timeout so a hung read
    // (e.g. a stalled network mount under the workspace root) degrades to a skip
    // instead of leaving the send awaiting a promise that never settles.
    // `collectOptions.readTimeoutMs` overrides the per-file cap (injectable for tests).
    async function collectMentionContents(collectOptions) {
      var paths = collectMentionPaths();
      if (!paths.length) {
        return [];
      }
      var fsApi = getWorkspaceFs();
      if (!fsApi || typeof fsApi.readFile !== 'function') {
        return [];
      }
      var settleOptions = collectOptions || {};
      var readTimeoutMs = (typeof settleOptions.readTimeoutMs === 'number'
        && Number.isFinite(settleOptions.readTimeoutMs)
        && settleOptions.readTimeoutMs > 0)
        ? settleOptions.readTimeoutMs
        : MENTION_READ_TIMEOUT_MS;

      // Resolve to a per-file outcome that NEVER rejects, so one hung/failed read
      // can't reject Promise.all and drop the healthy reads in the same batch.
      function readOne(path) {
        return new Promise(function (resolve) {
          var timer = setTimeoutFn(function onReadTimeout() {
            timer = null;
            resolve({ ok: false, path: path, reason: 'timeout' });
          }, readTimeoutMs);
          Promise.resolve()
            .then(function () { return fsApi.readFile({ path: path }); })
            .then(function (res) {
              if (timer === null) {
                return; // already settled via timeout — drop the late result
              }
              clearTimeoutFn(timer);
              timer = null;
              if (res && typeof res.content === 'string') {
                resolve({ ok: true, path: path, content: res.content });
              } else {
                resolve({ ok: false, path: path, reason: 'empty' });
              }
            }, function (err) {
              if (timer === null) {
                return; // already settled via timeout — swallow the late rejection
              }
              clearTimeoutFn(timer);
              timer = null;
              resolve({
                ok: false,
                path: path,
                reason: 'error',
                message: String((err && err.message) || err || ''),
              });
            });
        });
      }

      var outcomes = await Promise.all(paths.map(readOne));
      var out = [];
      for (var i = 0; i < outcomes.length; i += 1) {
        var outcome = outcomes[i];
        if (outcome.ok) {
          out.push({ path: outcome.path, content: outcome.content });
        } else if (outcome.reason === 'timeout') {
          appendClientLog('INFO', 'chat.mention_read_failed', {
            path: outcome.path,
            reason: 'timeout',
          });
        } else if (outcome.reason === 'error') {
          appendClientLog('INFO', 'chat.mention_read_failed', {
            path: outcome.path,
            message: outcome.message,
          });
        }
      }
      return out;
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      filesGate.bump();
      loadingToken = null;
      if (inputEl && onInput) {
        inputEl.removeEventListener('input', onInput);
      }
      if (doc && onKeydownCapture) {
        doc.removeEventListener('keydown', onKeydownCapture, true);
      }
      if (doc && onPointerDownCapture) {
        doc.removeEventListener('pointerdown', onPointerDownCapture, true);
      }
      if (win && onRootCommitted) {
        win.removeEventListener('ide:workspace-root-committed', onRootCommitted);
      }
      if (popoverEl) {
        if (onPopoverClick) {
          popoverEl.removeEventListener('click', onPopoverClick);
        }
        if (popoverEl.parentNode) {
          popoverEl.parentNode.removeChild(popoverEl);
        }
      }
      popoverEl = null;
      resultsEl = null;
    }

    onPopoverClick = handlePopoverClick;

    return {
      attach: attach,
      dispose: dispose,
      resetForRoot: resetForRoot,
      collectMentionPaths: collectMentionPaths,
      collectMentionContents: collectMentionContents,
      isOpen: function isOpen() { return visible; },
    };
  }

  var installedController = null;

  // Ship a renderer log line to the on-disk shell.log via the batched
  // logs:client-append IPC channel. The supported sink is logs.clientAppend,
  // which takes a { entries, dropped_count } batch. Best-effort: never throws.
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
          component: 'renderer.ide.mention',
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
      return null;
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
        /* best-effort */
      }
    }

    function boot() {
      controller = createMentionAutocomplete({
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

  function collectMentionPaths() {
    return installedController && typeof installedController.collectMentionPaths === 'function'
      ? installedController.collectMentionPaths()
      : [];
  }

  function collectMentionContents() {
    return installedController && typeof installedController.collectMentionContents === 'function'
      ? installedController.collectMentionContents()
      : Promise.resolve([]);
  }

  return {
    createMentionAutocomplete: createMentionAutocomplete,
    installSelf: installSelf,
    forwardClientLog: forwardClientLog,
    collectMentionPaths: collectMentionPaths,
    collectMentionContents: collectMentionContents,
  };
});
