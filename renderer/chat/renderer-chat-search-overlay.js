/**
 * renderer/chat/renderer-chat-search-overlay.js
 *
 * F1 / E6: glue between the inventory search-bar primitive
 * (renderer/inventory/search-bar.js) and the highlight controller
 * (renderer-chat-search-highlight.js).
 *
 * Owns:
 *   - the open/close state machine
 *   - the Ctrl+F global handler (opens overlay, focuses input)
 *   - debounced query rescan + highlight refresh
 *   - prev/next nav + roving-tabindex sync via the E3 keyboardController
 *   - the host element that anchors the search bar above #chatTimeline
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      root,
      require('./renderer-chat-keyboard-utils'),
      require('./renderer-chat-search-highlight'),
      require('../inventory/search-bar')
    );
    return;
  }
  root.rendererChatSearchOverlay = factory(
    root,
    root.rendererChatKeyboardUtils,
    root.rendererChatSearchHighlight,
    root.inventorySearchBar
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, keyboardUtils, highlightModule, searchBarModule) {
  'use strict';

  var isTextInputFocused = keyboardUtils && keyboardUtils.isTextInputFocused;
  if (typeof isTextInputFocused !== 'function') {
    throw new Error('rendererChatSearchOverlay: renderer-chat-keyboard-utils must load before this module');
  }

  var DEBOUNCE_MS = 120;
  var HOST_ID = 'chatSearchOverlayHost';

  function createChatSearchOverlay(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var win = options.window || (doc && doc.defaultView) || (typeof globalThis !== 'undefined' ? globalThis : null);

    var chatTimeline = options.chatTimeline
      || (doc ? doc.getElementById('chatTimeline') : null);
    var chatView = options.chatView
      || (doc ? doc.getElementById('chatView') : null);
    var keyboardController = options.keyboardController || null;
    var virtualizer = options.virtualizer || null;
    var viewportReveal = options.viewportReveal || null;
    var getCurrentSessionMessages = typeof options.getCurrentSessionMessages === 'function'
      ? options.getCurrentSessionMessages : function () { return []; };
    var getSessionTurnEventState = typeof options.getSessionTurnEventState === 'function'
      ? options.getSessionTurnEventState : function () { return { turnEvents: [] }; };
    var renderAll = typeof options.renderAll === 'function' ? options.renderAll : function () {};
    var appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : function () {};
    // UIUX-020: same stand-down seam renderer-chat-help-overlay.js uses for
    // its `?` shortcut -- when the Workspace IDE view is active, Ctrl+F is
    // Monaco's find, not chat search's. Optional/absent-safe: callers that
    // don't wire it (most tests) keep the prior always-on behavior.
    var getActiveView = typeof options.getActiveView === 'function' ? options.getActiveView : null;

    var searchBarFactory = options.searchBarFactory
      || (searchBarModule && searchBarModule.createSearchBar)
      || null;
    var highlightFactory = options.highlightFactory
      || (highlightModule && highlightModule.createSearchHighlightController)
      || null;

    if (!searchBarFactory || !highlightFactory) {
      throw new Error('rendererChatSearchOverlay: searchBar + highlight factories required');
    }

    var bar = null;
    var highlight = null;
    var hostEl = null;
    var isOpen = false;
    var debounceTimer = null;
    var mutationRescanTimer = null;
    var timelineMutationObserver = null;
    var savedFocusEl = null;
    var fallbackKeydownTarget = null;
    var fallbackExpansionTarget = null;
    var transientToolExpansions = new Map();
    var canonicalFallbackLogged = false;

    function ensureHost() {
      if (!doc) return null;
      hostEl = doc.getElementById(HOST_ID);
      if (hostEl) {
        if (!hostEl.classList.contains('chat-search-overlay-host')) {
          hostEl.classList.add('chat-search-overlay-host');
        }
        return hostEl;
      }
      if (!chatView || !chatTimeline) return null;
      hostEl = doc.createElement('div');
      hostEl.id = HOST_ID;
      hostEl.className = 'chat-search-overlay-host';
      hostEl.hidden = true;
      chatView.insertBefore(hostEl, chatTimeline);
      return hostEl;
    }

    function ensureBar() {
      if (bar) return bar;
      bar = searchBarFactory({ document: doc, hostId: 'chat-search' });
      bar.on('input', handleQueryInput);
      bar.on('next', handleNext);
      bar.on('prev', handlePrev);
      bar.on('close', handleClose);
      bar.on('toggle-case', function () { rescan(true); });
      bar.on('toggle-word', function () { rescan(true); });
      return bar;
    }

    function ensureHighlight() {
      if (highlight) return highlight;
      highlight = highlightFactory({ document: doc, chatTimeline: chatTimeline, window: win });
      return highlight;
    }

    function clearDebounce() {
      if (debounceTimer == null) return;
      (win || globalThis).clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    function clearMutationRescan() {
      if (mutationRescanTimer == null) return;
      (win || globalThis).clearTimeout(mutationRescanTimer);
      mutationRescanTimer = null;
    }

    function hasActiveQuery() {
      return Boolean(bar && String(bar.getQuery() || '').trim());
    }

    function scheduleMutationRescan() {
      if (!isOpen || !hasActiveQuery()) return;
      clearMutationRescan();
      var setTimeoutFn = (win && win.setTimeout) || setTimeout;
      mutationRescanTimer = setTimeoutFn(function runMutationRescan() {
        mutationRescanTimer = null;
        rescan(false);
      }, DEBOUNCE_MS);
    }

    function startTimelineMutationObserver() {
      if (timelineMutationObserver || !chatTimeline) return;
      var MutationObserverCtor = win && typeof win.MutationObserver === 'function'
        ? win.MutationObserver
        : typeof MutationObserver === 'function'
          ? MutationObserver
          : null;
      if (!MutationObserverCtor) return;
      try {
        timelineMutationObserver = new MutationObserverCtor(scheduleMutationRescan);
        timelineMutationObserver.observe(chatTimeline, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      } catch (_e) {
        timelineMutationObserver = null;
      }
    }

    function stopTimelineMutationObserver() {
      clearMutationRescan();
      if (timelineMutationObserver) {
        try { timelineMutationObserver.disconnect(); } catch (_e) { /* best-effort */ }
        timelineMutationObserver = null;
      }
    }

    function syncTimelineMutationObserver() {
      if (isOpen && hasActiveQuery()) {
        startTimelineMutationObserver();
      } else {
        stopTimelineMutationObserver();
      }
    }

    function handleQueryInput() {
      clearDebounce();
      var setTimeoutFn = (win && win.setTimeout) || setTimeout;
      debounceTimer = setTimeoutFn(function () {
        debounceTimer = null;
        rescan(true);
      }, DEBOUNCE_MS);
    }

    function isSameCanonicalMatch(left, right) {
      if (!left || !right || !left.messageId || !right.messageId) return false;
      return left.messageId === right.messageId
        && left.toolCallId === right.toolCallId
        && left.turnId === right.turnId
        && left.field === right.field
        && left.documentIndex === right.documentIndex
        && left.start === right.start
        && left.end === right.end;
    }

    function rescan(focusFirst) {
      if (!isOpen) return;
      ensureBar();
      ensureHighlight();
      var query = bar.getQuery();
      var previousIndex = highlight.getCurrentIndex();
      var previousMatch = highlight.getMatches()[previousIndex] || null;
      syncTimelineMutationObserver();
      var scanOptions = {
        caseSensitive: bar.getCaseSensitive(),
        wholeWord: bar.getWholeWord(),
      };
      var documentBuilder = highlightModule && highlightModule.buildCanonicalSearchDocuments;
      var documents = typeof documentBuilder === 'function'
        ? documentBuilder(getCurrentSessionMessages(), getSessionTurnEventState())
        : [];
      var matches = documents.length && typeof highlight.scanDocuments === 'function'
        ? highlight.scanDocuments(documents, query, scanOptions)
        : highlight.scan(query, scanOptions);
      if (!documents.length && String(query || '').trim() && !canonicalFallbackLogged) {
        canonicalFallbackLogged = true;
        try { appendClientLog('WARN', 'chat.search_canonical_documents_unavailable', {}); } catch (_error) { /* best-effort */ }
      }
      if (!matches.length) {
        restoreTransientToolExpansions(true);
        bar.setMatchInfo(0, 0);
        return;
      }
      var idx = 0;
      if (!focusFirst) {
        var restoredIndex = previousMatch && previousMatch.messageId
          ? matches.findIndex(function findPriorMatch(match) {
              return isSameCanonicalMatch(previousMatch, match);
            })
          : -1;
        idx = restoredIndex >= 0
          ? restoredIndex
          : Math.max(0, Math.min(matches.length - 1, previousIndex));
      }
      applyCurrent(idx);
    }

    function findEntryByMessageId(messageId) {
      var target = String(messageId || '').trim();
      if (!target || !chatTimeline) return null;
      var entries = chatTimeline.querySelectorAll?.('.chat-entry') || [];
      for (var index = 0; index < entries.length; index += 1) {
        if (String(entries[index].getAttribute?.('data-message-id') || '').trim() === target) return entries[index];
      }
      return null;
    }

    function findToolRow(entryEl, toolCallId) {
      var target = String(toolCallId || '').trim();
      if (!entryEl || !target) return null;
      var rows = entryEl.querySelectorAll?.('[data-tool-call-id], [data-call-id]') || [];
      for (var index = 0; index < rows.length; index += 1) {
        var candidate = rows[index];
        var candidateId = String(candidate.getAttribute?.('data-tool-call-id') || candidate.getAttribute?.('data-call-id') || '').trim();
        if (candidateId === target) return candidate.closest?.('.tool-call-row--minimal, .tool-call-block') || candidate;
      }
      return null;
    }

    function expandToolRowForSearch(match, entryEl) {
      if (!match || match.field !== 'tool_detail') return restoreTransientToolExpansions(true);
      var row = findToolRow(entryEl, match.toolCallId);
      if (!row) return restoreTransientToolExpansions(true);
      var rowKey = String(row.getAttribute?.('data-tool-row-key') || '').trim();
      if (!rowKey) return restoreTransientToolExpansions(true);
      var minimal = row.classList?.contains?.('tool-call-row--minimal');
      var toggle = minimal ? row.querySelector?.('[data-tool-row-toggle]') : row.querySelector?.('.tool-call-header');
      var wasExpanded = minimal
        ? row.getAttribute?.('data-expanded') === 'true'
        : toggle?.getAttribute?.('aria-expanded') === 'true';
      var restoredPrior = restoreTransientToolExpansions(false, rowKey);
      if (wasExpanded) {
        if (restoredPrior) renderAll({ forceFullRender: true });
        return restoredPrior;
      }
      if (!transientToolExpansions.has(rowKey)) {
        transientToolExpansions.set(rowKey, { minimal: Boolean(minimal), previous: false });
      }
      var toolUtils = root.rendererTurnRowToolRenderUtils;
      var transcriptUtils = root.rendererTranscriptToolCallUtils;
      if (minimal && toolUtils?.setToolRowExpansion) toolUtils.setToolRowExpansion(rowKey, true);
      else if (!minimal && transcriptUtils?.setToolCallExpansion) transcriptUtils.setToolCallExpansion(rowKey, true);
      renderAll({ forceFullRender: true });
      return true;
    }

    function bindMountedCurrent(match) {
      if (!match) return;
      virtualizer?.ensureMountedForMessageId?.(match.messageId);
      var entryEl = findEntryByMessageId(match.messageId);
      if (!entryEl) return;
      if (expandToolRowForSearch(match, entryEl)) {
        virtualizer?.ensureMountedForMessageId?.(match.messageId);
        entryEl = findEntryByMessageId(match.messageId) || entryEl;
      }
      var scanOptions = { caseSensitive: bar.getCaseSensitive(), wholeWord: bar.getWholeWord() };
      var scopeEl = match.field === 'tool_detail' ? findToolRow(entryEl, match.toolCallId) : entryEl;
      var bound = typeof highlight.bindCurrentToEntry === 'function'
        ? highlight.bindCurrentToEntry(entryEl, bar.getQuery(), scanOptions, { scopeEl })
        : match;
      if (keyboardController && typeof keyboardController.focusEntryAtIndex === 'function') {
        var entries = Array.from(chatTimeline.querySelectorAll('.chat-entry'));
        keyboardController.focusEntryAtIndex(Math.max(0, entries.indexOf(entryEl)));
      }
      if (bar) bar.focusInput(false);
      viewportReveal?.revealElement?.(bound?.entryEl || entryEl, {
        block: 'center',
        // Instant, matching pre-helper Ctrl+F behavior: rescan re-applies the
        // current match every keystroke/mutation debounce, and restarting a
        // smooth animation each 120ms judders (Opus pre-land finding M1).
        behavior: 'auto',
        followLatest: false,
        reason: 'search_nav',
      });
    }

    function applyCurrent(index) {
      ensureHighlight();
      var match = highlight.setCurrentIndex(index);
      var matches = highlight.getMatches();
      bar.setMatchInfo(
        matches.length ? (highlight.getCurrentIndex() + 1) : 0,
        matches.length,
        { truncated: highlight.wasTruncated?.() === true }
      );
      if (!match) return;
      if (match.messageId) {
        bindMountedCurrent(match);
        return;
      }
      // Refocus the input first so Enter/Shift+Enter keep firing for sequential
      // nav (matches Chrome's Ctrl+F behavior). Then update E3 roving tabindex
      // and scroll last so layout settles after attribute changes.
      if (keyboardController && typeof keyboardController.focusEntryAtIndex === 'function') {
        keyboardController.focusEntryAtIndex(match.entryIndex);
      }
      if (bar) bar.focusInput(false);
      viewportReveal?.revealElement?.(match.entryEl, {
        block: 'center',
        behavior: 'auto',
        followLatest: false,
        reason: 'search_nav',
      });
    }

    function handleNext() {
      ensureHighlight();
      var matches = highlight.getMatches();
      if (!matches.length) return;
      var idx = highlight.getCurrentIndex();
      var next = idx < 0 ? 0 : (idx + 1) % matches.length;
      applyCurrent(next);
    }

    function handlePrev() {
      ensureHighlight();
      var matches = highlight.getMatches();
      if (!matches.length) return;
      var idx = highlight.getCurrentIndex();
      var next = idx <= 0 ? matches.length - 1 : idx - 1;
      applyCurrent(next);
    }

    function handleClose() {
      close();
    }

    function open() {
      ensureBar();
      ensureHighlight();
      var host = ensureHost();
      if (!host) return;
      if (!isOpen) {
        savedFocusEl = doc ? doc.activeElement : null;
        host.hidden = false;
        bar.mount(host);
        isOpen = true;
      }
      bar.focusInput(true);
    }

    function restoreTransientToolExpansions(shouldRender, exceptRowKey) {
      if (!transientToolExpansions.size) return false;
      var toolUtils = root.rendererTurnRowToolRenderUtils;
      var transcriptUtils = root.rendererTranscriptToolCallUtils;
      var restored = false;
      transientToolExpansions.forEach(function restoreExpansion(value, rowKey) {
        if (rowKey === exceptRowKey) return;
        if (value.minimal && toolUtils?.setToolRowExpansion) toolUtils.setToolRowExpansion(rowKey, value.previous);
        else if (!value.minimal && transcriptUtils?.setToolCallExpansion) transcriptUtils.setToolCallExpansion(rowKey, value.previous);
        transientToolExpansions.delete(rowKey);
        restored = true;
      });
      if (restored && shouldRender !== false) renderAll({ forceFullRender: true });
      return restored;
    }

    function handleUserToolExpansion(event) {
      var rowKey = String(event?.detail?.rowKey || '').trim();
      if (rowKey) transientToolExpansions.delete(rowKey);
    }

    function close() {
      if (!isOpen) return;
      clearDebounce();
      if (highlight) highlight.clear();
      if (bar) {
        bar.unmount();
        bar.setQuery('');
        bar.setCaseSensitive(false);
        bar.setWholeWord(false);
        bar.setMatchInfo(0, 0);
      }
      if (hostEl) hostEl.hidden = true;
      isOpen = false;
      stopTimelineMutationObserver();
      restoreTransientToolExpansions(true);
      var restore = savedFocusEl;
      savedFocusEl = null;
      // Skip restore if the saved element was detached between open and close
      // (rerender, virtualization, etc.) — calling .focus() on a detached node
      // is a no-op but pins it in memory.
      if (restore && typeof restore.focus === 'function' && doc && doc.contains(restore)) {
        restore.focus();
      } else if (chatTimeline && typeof chatTimeline.focus === 'function') {
        if (!chatTimeline.getAttribute || chatTimeline.getAttribute('tabindex') == null) {
          try { chatTimeline.setAttribute('tabindex', '-1'); } catch (_e) { /* best-effort */ }
        }
        try { chatTimeline.focus({ preventScroll: true }); } catch (_e2) { /* best-effort */ }
      }
      if (keyboardController && typeof keyboardController.syncTabindex === 'function') {
        keyboardController.syncTabindex();
      }
    }

    function isOverlayOpen() { return isOpen; }

    function handleGlobalKeydown(event) {
      // Cheap early-out: most keystrokes have no Ctrl/Meta — skip the string
      // coercion for them.
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.altKey) return;
      var key = event.key;
      if (key !== 'f' && key !== 'F') return;
      // A1: Ctrl+F belongs to chat search only while Chat is active. Other
      // surfaces keep their native/local find behavior; defaultPrevented also
      // protects any earlier consumer on the active surface.
      if (getActiveView && getActiveView() !== 'chat') return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      open();
    }

    function attach(registerListener, listenerOptions) {
      if (!doc) return;
      if (typeof registerListener === 'function') {
        registerListener(doc, 'keydown', handleGlobalKeydown, listenerOptions);
        registerListener(chatTimeline, 'tool-row-user-expansion', handleUserToolExpansion, listenerOptions);
        return;
      }
      doc.addEventListener('keydown', handleGlobalKeydown, listenerOptions);
      chatTimeline?.addEventListener?.('tool-row-user-expansion', handleUserToolExpansion, listenerOptions);
      fallbackKeydownTarget = doc;
      fallbackExpansionTarget = chatTimeline;
    }

    function dispose() {
      clearDebounce();
      stopTimelineMutationObserver();
      if (highlight) highlight.clear();
      // Restore the preference store but do not schedule a render while this
      // controller and its listeners are being torn down.
      restoreTransientToolExpansions(false);
      if (bar) bar.dispose();
      if (fallbackKeydownTarget) {
        fallbackKeydownTarget.removeEventListener('keydown', handleGlobalKeydown);
        fallbackKeydownTarget = null;
      }
      if (fallbackExpansionTarget) {
        fallbackExpansionTarget.removeEventListener('tool-row-user-expansion', handleUserToolExpansion);
        fallbackExpansionTarget = null;
      }
      if (hostEl) hostEl.hidden = true;
      bar = null;
      highlight = null;
      isOpen = false;
    }

    return {
      attach: attach,
      open: open,
      close: close,
      isOpen: isOverlayOpen,
      dispose: dispose,
    };
  }

  return { createChatSearchOverlay: createChatSearchOverlay };
});
