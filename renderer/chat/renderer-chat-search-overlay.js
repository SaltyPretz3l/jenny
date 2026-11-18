/**
 * renderer/chat/renderer-chat-search-overlay.js
 *
 * F1 / E6: glue between the inventory search-bar primitive
 * (renderer/inventory/search-bar.js) and the highlight controller
 * (renderer-chat-search-highlight.js).
 *
 * Owns:
 *   - the open/close state machine
 *   - the Ctrl+F, F3 / Shift+F3 and Esc document handlers, for this pane only
 *     (the focused pane; never a pane hosted in the IDE dock or the Workspace)
 *   - debounced query rescan + highlight refresh
 *   - prev/next nav + roving-tabindex sync via the E3 keyboardController
 *   - row 156: the find field and its toggle in the pane's session bar
 *     (`data-find-open` on the cluster while open); a close keeps the query,
 *     a reopen paints it in place and the first Enter / F3 reveals it
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

  var toolCallUtils = root.toolCallUtils || require('./tool-call-utils');

  var DEBOUNCE_MS = 120;
  var SEED_MAX_CHARS = 200;
  var CLUSTER_SELECTOR = '[data-chat-node="chatTimelineUtilityCluster"]';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d) { return d; };

  function createChatSearchOverlay(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var win = options.window || (doc && doc.defaultView) || (typeof globalThis !== 'undefined' ? globalThis : null);

    var chatTimeline = options.chatTimeline
      || (doc ? doc.getElementById('chatTimeline') : null);
    var paneRoot = options.paneRoot || (chatTimeline && chatTimeline.closest ? chatTimeline.closest('.chat-pane') : null);
    var cluster = options.cluster || (paneRoot && paneRoot.querySelector ? paneRoot.querySelector(CLUSTER_SELECTOR) : null);
    // Pane 1 gets its own element ids and highlight names (pane 0 keeps the plain ones).
    var paneId = paneRoot ? String(paneRoot.dataset.paneId || '0') : '0';
    var paneSuffix = paneId === '0' ? '' : '-' + paneId;
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
    // Message documents carry the rendered (visible) text; the cache is bounded
    // and cleared when the overlay closes.
    var visibleText = highlightModule && typeof highlightModule.createVisibleTextProvider === 'function'
      ? highlightModule.createVisibleTextProvider({ document: doc, getFeatureFlags: options.getFeatureFlags })
      : null;

    if (!searchBarFactory || !highlightFactory) {
      throw new Error('rendererChatSearchOverlay: searchBar + highlight factories required');
    }

    var bar = null;
    var highlight = null;
    var hostEl = null;
    var toggleEl = null;
    var isOpen = false;
    // A reopen restored the last query without moving: the first next/prev
    // reveals the current match instead of stepping past it.
    var revealPending = false;
    var debounceTimer = null;
    var mutationRescanTimer = null;
    var timelineMutationObserver = null;
    var savedFocusEl = null;
    var fallbackKeydownTarget = null;
    var fallbackExpansionTarget = null;
    var transientToolExpansions = new Map();
    var transientDetails = new Set();
    var canonicalFallbackLogged = false;

    // The IDE dock or a Workspace-hosted pane: Monaco owns Ctrl+F there.
    function isHostedElsewhere() {
      return Boolean(paneRoot && (paneRoot.classList.contains('ide-chat-dock-body') || paneRoot.hasAttribute('data-pane-hosted')));
    }

    // Not yet synced (no attribute): focused only while the view has one pane.
    function isPaneFocused() {
      var focused = paneRoot && paneRoot.dataset.paneFocused;
      if (focused) return focused === 'true';
      return !paneRoot || !paneRoot.closest('.chat-view[data-pane-count="2"]');
    }

    function ownsKeys() {
      if (getActiveView && getActiveView() !== 'chat') return false;
      return isPaneFocused() && !isHostedElsewhere();
    }

    function ensureHost() {
      if (!doc || !cluster) return null;
      if (hostEl && hostEl.isConnected) return hostEl;
      hostEl = doc.createElement('div');
      hostEl.className = 'chat-find';
      hostEl.hidden = true;
      cluster.appendChild(hostEl);
      return hostEl;
    }

    function ensureToggle() {
      if (toggleEl || !doc || !cluster || !searchBarModule) return toggleEl;
      toggleEl = searchBarModule.createFindToggle(doc, jt('chat.find.toggleLabel', 'Find in this chat'),
        jt('chat.find.toggleTitle', 'Find in this chat (Ctrl+F)'));
      toggleEl.addEventListener('click', handleToggleClick);
      cluster.appendChild(toggleEl);
      return toggleEl;
    }

    function handleToggleClick() {
      if (isOpen) close();
      else open();
    }

    function syncOpenState() {
      if (toggleEl) toggleEl.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
      if (cluster && typeof cluster.toggleAttribute === 'function') cluster.toggleAttribute('data-find-open', isOpen);
    }

    function ensureBar() {
      if (bar) return bar;
      bar = searchBarFactory({ document: doc, hostId: 'chat-search' + paneSuffix, extraKeys: ['F3', 'Shift+F3'] });
      bar.on('input', handleQueryInput);
      bar.on('next', handleNext);
      bar.on('prev', handlePrev);
      bar.on('close', close);
      bar.on('toggle-case', function () { rescan(true); });
      bar.on('toggle-word', function () { rescan(true); });
      return bar;
    }

    function ensureHighlight() {
      if (highlight) return highlight;
      highlight = highlightFactory({ document: doc, chatTimeline: chatTimeline, window: win, nameSuffix: paneSuffix });
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
        rescan(false, true);
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
        && left.sourceMessageId === right.sourceMessageId
        && left.turnId === right.turnId
        && left.field === right.field
        && left.documentIndex === right.documentIndex
        && left.start === right.start
        && left.end === right.end;
    }

    // passive: a timeline mutation (a stream patch, the elapsed clock) refreshes
    // the matches and the highlight only; scrolling to the match and releasing
    // follow belong to a reader action (next, previous, a new query).
    function rescan(focusFirst, passive) {
      if (!isOpen) return;
      ensureBar();
      ensureHighlight();
      if (passive !== true) revealPending = false;
      var query = String(bar.getQuery() || '').trim() ? bar.getQuery() : '';
      var previousIndex = highlight.getCurrentIndex();
      var previousMatch = highlight.getMatches()[previousIndex] || null;
      syncTimelineMutationObserver();
      var scanOptions = {
        caseSensitive: bar.getCaseSensitive(),
        wholeWord: bar.getWholeWord(),
      };
      var documentBuilder = highlightModule && highlightModule.buildCanonicalSearchDocuments;
      var sessionMessages = getCurrentSessionMessages();
      if (visibleText) visibleText.reserve(Array.isArray(sessionMessages) ? sessionMessages.length : 0);
      var documents = typeof documentBuilder === 'function'
        ? documentBuilder(sessionMessages, getSessionTurnEventState(), { toVisibleText: visibleText && visibleText.toVisibleText })
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
      if (documents.length && typeof highlight.paintMounted === 'function') highlight.paintMounted(query, scanOptions);
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
      applyCurrent(idx, passive === true);
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

    function hasRowOfMessage(entryEl, sourceMessageId) {
      var rows = entryEl.querySelectorAll?.('.chat-row') || [];
      for (var index = 0; index < rows.length; index += 1) {
        if (rows[index].getAttribute('data-source-message-id') === sourceMessageId
          || (' ' + (rows[index].getAttribute('data-source-message-ids') || '') + ' ').indexOf(' ' + sourceMessageId + ' ') >= 0) return true;
      }
      return false;
    }

    // CTR-5: a search document is owned by the turn's first assistant message,
    // but the renderer anchors a coalesced turn article at its first assistant
    // *render* message (renderer-turn-article-coalesce-utils.js), e.g. the
    // tool_use message when the opening segment is blank; the owner is then
    // only a compat-anchor span. Resolve the article that holds the match's
    // own rows: the tool row for a tool detail, the source message's rows
    // otherwise.
    function findEntryForMatch(match) {
      var entryEl = findEntryByMessageId(match.messageId);
      var toolCallId = match.field === 'tool_detail' ? String(match.toolCallId || '').trim() : '';
      if (entryEl && (!toolCallId || findToolRow(entryEl, toolCallId))) return entryEl;
      var sourceMessageId = String(match.sourceMessageId || '').trim();
      var entries = chatTimeline?.querySelectorAll?.('.chat-entry') || [];
      for (var index = 0; index < entries.length; index += 1) {
        var candidate = entries[index];
        if (toolCallId ? findToolRow(candidate, toolCallId)
          : sourceMessageId && (candidate.getAttribute('data-message-id') === sourceMessageId || hasRowOfMessage(candidate, sourceMessageId))) {
          return candidate;
        }
      }
      return entryEl;
    }

    function findToolRow(entryEl, toolCallId) {
      var target = String(toolCallId || '').trim();
      if (!entryEl || !target) return null;
      var rows = entryEl.querySelectorAll?.('[data-tool-call-id], [data-call-id]') || [];
      for (var index = 0; index < rows.length; index += 1) {
        var candidate = rows[index];
        var candidateId = String(candidate.getAttribute?.('data-tool-call-id') || candidate.getAttribute?.('data-call-id') || '').trim();
        // The .chat-row wrapper carries the call id too: resolve the inner row.
        if (candidateId === target) {
          return candidate.closest?.('.tool-call-row--minimal, .tool-call-block')
            || candidate.querySelector?.('.tool-call-row--minimal, .tool-call-block') || candidate;
        }
      }
      return null;
    }

    // Answers tool run: a match inside a collapsed run opens the run as well,
    // as a transient expansion restored like the tool row's own.
    function findToolRunForSearch(row, entryEl) {
      var member = row?.closest?.('.chat-row[data-run-member]');
      var runId = member?.getAttribute?.('data-run-id');
      if (!runId) return null;
      var summaryRow = toolCallUtils.getToolRunRows(entryEl, runId).find(function isSummary(node) {
        return node.getAttribute('data-row-kind') === 'tool_run';
      });
      var toggle = summaryRow?.querySelector?.('[data-tool-run-toggle]');
      var runKey = String(toggle?.getAttribute?.('data-tool-run-key') || '').trim();
      return runKey ? { runKey: runKey, expanded: member.getAttribute('data-run-expanded') === 'true' } : null;
    }

    function openToolRunForSearch(run) {
      if (!run || run.expanded) return false;
      if (!transientToolExpansions.has(run.runKey)) {
        transientToolExpansions.set(run.runKey, { minimal: true, previous: false });
      }
      root.rendererTurnRowToolRenderUtils?.setToolRowExpansion?.(run.runKey, true);
      return true;
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
      var run = findToolRunForSearch(row, entryEl);
      var restoredPrior = restoreTransientToolExpansions(false, run ? [rowKey, run.runKey] : rowKey);
      var runOpened = openToolRunForSearch(run);
      if (wasExpanded) {
        if (restoredPrior || runOpened) renderAll({ forceFullRender: true });
        return restoredPrior || runOpened;
      }
      if (!transientToolExpansions.has(rowKey)) {
        transientToolExpansions.set(rowKey, { minimal: Boolean(minimal), previous: false });
      }
      var toolUtils = root.rendererTurnRowToolRenderUtils;
      var transcriptUtils = root.rendererTranscriptToolCallUtils;
      if (minimal && toolUtils?.setToolRowExpansion) toolUtils.setToolRowExpansion(rowKey, true);
      else if (!minimal && transcriptUtils?.setToolCallExpansion) transcriptUtils.setToolCallExpansion(rowKey, true);
      renderAll({ forceFullRender: true });
      if (minimal) openMinimalRowIfStillCollapsed(rowKey);
      return true;
    }

    function findMinimalRowByKey(rowKey) {
      var rows = chatTimeline?.querySelectorAll?.('.tool-call-row--minimal[data-tool-row-key]') || [];
      for (var index = 0; index < rows.length; index += 1) {
        if (rows[index].getAttribute('data-tool-row-key') === rowKey) return rows[index];
      }
      return null;
    }

    // CTR-5: the full render morphs the row in place, and the morph's
    // preservation registry restores the row's prior collapsed DOM state over
    // the expanded markup. A row still collapsed afterwards opens through the
    // transcript's toggle path (the one a reader's click takes), which writes
    // data-expanded and materializes the lazy body in place.
    function openMinimalRowIfStillCollapsed(rowKey) {
      var row = findMinimalRowByKey(rowKey);
      var toggle = row?.querySelector?.('[data-tool-row-toggle]');
      var EventCtor = (win && win.CustomEvent) || (typeof CustomEvent === 'function' ? CustomEvent : null);
      if (!toggle || row.getAttribute('data-expanded') === 'true' || typeof EventCtor !== 'function') return;
      var record = transientToolExpansions.get(rowKey);
      toggle.dispatchEvent(new EventCtor('tool-row-expand-request', { bubbles: true, detail: { expanded: true } }));
      // The toggle path announces a reader expansion; this one stays transient.
      if (record) transientToolExpansions.set(rowKey, record);
    }

    // A closed <details> around the bound passage (an approval's input, an
    // error card's detail) opens for the match and closes again when the
    // search moves on or closes, unless the reader took it over meanwhile.
    function openDetailsForSearch(bound) {
      var node = bound && bound.range ? bound.range.startContainer : null;
      var element = node && node.nodeType !== 1 ? node.parentElement : node;
      var holding = [];
      for (var details = element?.closest?.('details'); details && chatTimeline.contains(details); details = details.parentElement?.closest?.('details')) {
        holding.push(details);
      }
      restoreTransientDetails(holding);
      holding.forEach(function openForMatch(details) {
        if (details.open) return;
        details.open = true;
        transientDetails.add(details);
      });
    }

    function restoreTransientDetails(except) {
      transientDetails.forEach(function closeAgain(details) {
        if (except && except.indexOf(details) >= 0) return;
        transientDetails.delete(details);
        if (details.isConnected) details.open = false;
      });
    }

    function handleUserDetailsToggle(event) {
      var summary = event?.target?.closest?.('summary');
      if (summary) transientDetails.delete(summary.parentElement);
    }

    // fieldFocused: the step started in the find field, which keeps focus
    // (Enter keeps stepping); F3 from the timeline leaves focus on the entry.
    function bindMountedCurrent(match, passive, fieldFocused) {
      if (!match) return;
      if (!passive) virtualizer?.ensureMountedForMessageId?.(match.messageId);
      var entryEl = findEntryForMatch(match);
      if (!entryEl) return;
      if (!passive && expandToolRowForSearch(match, entryEl)) {
        virtualizer?.ensureMountedForMessageId?.(match.messageId);
        entryEl = findEntryForMatch(match) || entryEl;
      }
      var scanOptions = { caseSensitive: bar.getCaseSensitive(), wholeWord: bar.getWholeWord() };
      var scopeEl = match.field === 'tool_detail' ? findToolRow(entryEl, match.toolCallId) : entryEl;
      var bound = typeof highlight.bindCurrentToEntry === 'function'
        ? highlight.bindCurrentToEntry(entryEl, bar.getQuery(), scanOptions, { scopeEl })
        : match;
      if (passive) return;
      openDetailsForSearch(bound);
      if (keyboardController && typeof keyboardController.focusEntryAtIndex === 'function') {
        var entries = Array.from(chatTimeline.querySelectorAll('.chat-entry'));
        keyboardController.focusEntryAtIndex(Math.max(0, entries.indexOf(entryEl)));
      }
      if (bar && fieldFocused) bar.focusInput(false);
      viewportReveal?.revealElement?.(bound?.entryEl || entryEl, {
        block: 'center',
        range: bound?.range || null,
        // Instant, matching pre-helper Ctrl+F behavior: rescan re-applies the
        // current match every keystroke/mutation debounce, and restarting a
        // smooth animation each 120ms judders (Opus pre-land finding M1).
        behavior: 'auto',
        followLatest: false,
        reason: 'search_nav',
      });
    }

    function applyCurrent(index, passive) {
      ensureHighlight();
      var fieldFocused = focusInBar();
      var match = highlight.setCurrentIndex(index);
      var matches = highlight.getMatches();
      bar.setMatchInfo(
        matches.length ? (highlight.getCurrentIndex() + 1) : 0,
        matches.length,
        { truncated: highlight.wasTruncated?.() === true }
      );
      if (!match || passive && !match.messageId) return;
      if (match.messageId) {
        bindMountedCurrent(match, passive, fieldFocused);
        return;
      }
      // Refocus the input first so Enter/Shift+Enter keep firing for sequential
      // nav (matches Chrome's Ctrl+F behavior). Then update E3 roving tabindex
      // and scroll last so layout settles after attribute changes.
      if (keyboardController && typeof keyboardController.focusEntryAtIndex === 'function') {
        keyboardController.focusEntryAtIndex(match.entryIndex);
      }
      if (bar && fieldFocused) bar.focusInput(false);
      viewportReveal?.revealElement?.(match.entryEl, {
        block: 'center',
        range: match.range || null,
        behavior: 'auto',
        followLatest: false,
        reason: 'search_nav',
      });
    }

    // After a reopen, the first step reveals the restored current match.
    function revealRestored() {
      if (!revealPending) return false;
      revealPending = false;
      applyCurrent(Math.max(0, highlight.getCurrentIndex()));
      return true;
    }

    function handleNext() {
      ensureHighlight();
      var matches = highlight.getMatches();
      if (!matches.length) return;
      if (revealRestored()) return;
      var idx = highlight.getCurrentIndex();
      var next = idx < 0 ? 0 : (idx + 1) % matches.length;
      applyCurrent(next);
    }

    function handlePrev() {
      ensureHighlight();
      var matches = highlight.getMatches();
      if (!matches.length) return;
      if (revealRestored()) return;
      var idx = highlight.getCurrentIndex();
      var next = idx <= 0 ? matches.length - 1 : idx - 1;
      applyCurrent(next);
    }

    // Selected text inside this timeline seeds the query: one line, at most
    // SEED_MAX_CHARS characters.
    function selectionSeed() {
      var selection = win && typeof win.getSelection === 'function' ? win.getSelection() : null;
      if (!selection || selection.isCollapsed || !selection.rangeCount || !chatTimeline) return '';
      var container = selection.getRangeAt(0).commonAncestorContainer;
      if (!container || !chatTimeline.contains(container)) return '';
      var text = String(selection.toString() || '').trim();
      if (!text || text.length > SEED_MAX_CHARS || /[\r\n]/.test(text)) return '';
      return text;
    }

    // open({ seed }) — seed replaces the query (Ctrl+F over a selection).
    function open(openOptions) {
      if (isHostedElsewhere()) return;
      ensureBar();
      ensureHighlight();
      var host = ensureHost();
      if (!host) return;
      var seed = openOptions && typeof openOptions.seed === 'string' ? openOptions.seed : '';
      var seeded = Boolean(seed) && seed !== bar.getQuery();
      if (seeded) bar.setQuery(seed);
      if (!isOpen) {
        savedFocusEl = doc ? doc.activeElement : null;
        host.hidden = false;
        bar.mount(host);
        isOpen = true;
        syncOpenState();
        if (!seeded && hasActiveQuery()) {
          // Reopen: the last query paints in place; the first step reveals it.
          rescan(true, true);
          revealPending = true;
        } else if (!seeded) {
          bar.setMatchInfo(0, 0);
        }
      }
      if (seeded) rescan(true);
      bar.focusInput(true);
    }

    function restoreTransientToolExpansions(shouldRender, exceptRowKey) {
      if (!transientToolExpansions.size) return false;
      var toolUtils = root.rendererTurnRowToolRenderUtils;
      var transcriptUtils = root.rendererTranscriptToolCallUtils;
      var restored = false;
      var exceptRowKeys = [].concat(exceptRowKey || []);
      transientToolExpansions.forEach(function restoreExpansion(value, rowKey) {
        if (exceptRowKeys.includes(rowKey)) return;
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

    function focusInBar() {
      var active = doc ? doc.activeElement : null;
      return Boolean(hostEl && active && hostEl.contains(active));
    }

    function close() {
      if (!isOpen) return;
      // Focus elsewhere (Esc from the timeline) stays where it is.
      var active = doc ? doc.activeElement : null;
      var restoreFocus = focusInBar() || !active || active === doc.body || active === toggleEl;
      clearDebounce();
      if (highlight) highlight.clear();
      if (visibleText) visibleText.clear();
      // The query and options stay for the next open.
      if (bar) bar.unmount();
      if (hostEl) hostEl.hidden = true;
      isOpen = false;
      revealPending = false;
      syncOpenState();
      stopTimelineMutationObserver();
      restoreTransientDetails(null);
      restoreTransientToolExpansions(true);
      var restore = savedFocusEl;
      savedFocusEl = null;
      if (!restoreFocus) restore = null;
      // Skip restore if the saved element was detached between open and close
      // (rerender, virtualization, etc.) — calling .focus() on a detached node
      // is a no-op but pins it in memory.
      if (restore && typeof restore.focus === 'function' && doc && doc.contains(restore)) {
        restore.focus();
      } else if (restoreFocus && chatTimeline && typeof chatTimeline.focus === 'function') {
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

    // Esc closes from this pane's timeline (or with nothing focused) when no
    // earlier handler took it; the field handles its own Esc, and a text input
    // elsewhere (the composer, a message editor) keeps it.
    function handleEscape(event) {
      if (!isOpen || event.defaultPrevented || !ownsKeys()) return;
      var active = doc ? doc.activeElement : null;
      if (focusInBar()) return;
      var inPane = !active || active === doc.body || active === toggleEl || Boolean(chatTimeline && chatTimeline.contains(active));
      if (!inPane || isTextInputFocused()) return;
      event.preventDefault();
      close();
    }

    function handleGlobalKeydown(event) {
      var key = event.key;
      // Keys typed in the chat's Terminal panel belong to the shell (Ctrl+F is forward-char, Escape is Escape).
      if (event.target && typeof event.target.closest === 'function' && event.target.closest('.chat-terminal-panel .xterm')) return;
      if (key === 'F3') {
        if (!isOpen || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !ownsKeys()) return;
        event.preventDefault();
        if (event.shiftKey) handlePrev();
        else handleNext();
        return;
      }
      if (key === 'Escape') {
        handleEscape(event);
        return;
      }
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || (key !== 'f' && key !== 'F')) return;
      // A1: Ctrl+F belongs to chat search only while Chat is active, and to the
      // focused pane only. Other surfaces keep their native/local find
      // behavior; defaultPrevented also protects any earlier consumer.
      if (!ownsKeys()) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      open({ seed: selectionSeed() });
    }

    // A transcript view switch already dropped the session's row overrides:
    // restoring a transient expansion's "previous" state would write one back.
    // The notice also fires when the pane changes session; records of other
    // sessions keep their restore (row keys carry `session=<enc>|`).
    function handleTranscriptViewRendered(event) {
      var detail = event && event.detail;
      if (!detail || !detail.previousView) return;
      var prefix = toolCallUtils.toolRowKeySessionPrefix(detail.sessionId);
      transientToolExpansions.forEach(function dropSessionRecord(_value, rowKey) {
        if (rowKey.indexOf(prefix) === 0) transientToolExpansions.delete(rowKey);
      });
    }

    function attach(registerListener, listenerOptions) {
      if (!doc) return;
      ensureToggle();
      if (typeof registerListener === 'function') {
        registerListener(doc, 'keydown', handleGlobalKeydown, listenerOptions);
        registerListener(chatTimeline, 'tool-row-user-expansion', handleUserToolExpansion, listenerOptions);
        registerListener(chatTimeline, 'transcript-view-rendered', handleTranscriptViewRendered, listenerOptions);
        registerListener(chatTimeline, 'click', handleUserDetailsToggle, listenerOptions);
        return;
      }
      doc.addEventListener('keydown', handleGlobalKeydown, listenerOptions);
      chatTimeline?.addEventListener?.('tool-row-user-expansion', handleUserToolExpansion, listenerOptions);
      chatTimeline?.addEventListener?.('transcript-view-rendered', handleTranscriptViewRendered, listenerOptions);
      chatTimeline?.addEventListener?.('click', handleUserDetailsToggle, listenerOptions);
      fallbackKeydownTarget = doc;
      fallbackExpansionTarget = chatTimeline;
    }

    function dispose() {
      clearDebounce();
      stopTimelineMutationObserver();
      if (highlight) highlight.clear();
      if (visibleText) visibleText.clear();
      // Restore the preference store but do not schedule a render while this
      // controller and its listeners are being torn down.
      restoreTransientToolExpansions(false);
      restoreTransientDetails(null);
      if (bar) bar.dispose();
      if (fallbackKeydownTarget) {
        fallbackKeydownTarget.removeEventListener('keydown', handleGlobalKeydown);
        fallbackKeydownTarget = null;
      }
      if (fallbackExpansionTarget) {
        fallbackExpansionTarget.removeEventListener('tool-row-user-expansion', handleUserToolExpansion);
        fallbackExpansionTarget.removeEventListener('transcript-view-rendered', handleTranscriptViewRendered);
        fallbackExpansionTarget.removeEventListener('click', handleUserDetailsToggle);
        fallbackExpansionTarget = null;
      }
      if (toggleEl) {
        toggleEl.removeEventListener('click', handleToggleClick);
        toggleEl.remove();
        toggleEl = null;
      }
      if (hostEl) hostEl.remove();
      hostEl = null;
      if (cluster && typeof cluster.removeAttribute === 'function') cluster.removeAttribute('data-find-open');
      bar = null;
      highlight = null;
      isOpen = false;
      revealPending = false;
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
