/* renderer/chat/renderer-chat-citation-jump-utils.js
 * Renderer-owned click-to-scroll citation links.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatCitationJumpUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CITATION_KINDS = new Set(['message', 'tool', 'row']);
  var MAX_TARGET_ID_LENGTH = 256;
  var HIGHLIGHT_CLASS = 'chat-citation-target-highlight';
  var DEFAULT_HIGHLIGHT_DURATION_MS = 2200;

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function hasControlCharacter(value) {
    var text = String(value || '');
    for (var index = 0; index < text.length; index += 1) {
      var code = text.charCodeAt(index);
      if (code <= 31 || code === 127) return true;
    }
    return false;
  }

  function cssStringEscape(value) {
    var text = String(value || '');
    var escaped = '';
    for (var index = 0; index < text.length; index += 1) {
      var ch = text.charAt(index);
      var code = text.charCodeAt(index);
      if (ch === '"') {
        escaped += '\\"';
      } else if (ch === '\\') {
        escaped += '\\\\';
      } else if (code <= 31 || code === 127) {
        escaped += '\\' + code.toString(16) + ' ';
      } else {
        escaped += ch;
      }
    }
    return escaped;
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return '';
    }
  }

  function resolveHash(rawHref, currentHref) {
    var href = normalizeId(rawHref);
    if (!href) return '';
    if (href.charAt(0) === '#') return href;
    var baseHref = normalizeId(currentHref);
    if (!baseHref && typeof location !== 'undefined' && location.href) {
      baseHref = String(location.href || '');
    }
    if (!baseHref || typeof URL !== 'function') {
      return '';
    }
    try {
      var currentUrl = new URL(baseHref);
      var targetUrl = new URL(href, currentUrl.href);
      if (
        targetUrl.origin !== currentUrl.origin
        || targetUrl.pathname !== currentUrl.pathname
        || targetUrl.search !== currentUrl.search
      ) {
        return '';
      }
      return targetUrl.hash || '';
    } catch (_error) {
      return '';
    }
  }

  function parseCitationHref(rawHref, currentHref) {
    var hash = resolveHash(rawHref, currentHref);
    if (!hash || hash.charAt(0) !== '#') return null;
    var body = hash.slice(1);
    var separatorIndex = body.indexOf(':');
    if (separatorIndex <= 0) return null;
    var kind = body.slice(0, separatorIndex);
    if (!CITATION_KINDS.has(kind)) return null;
    var decodedId = normalizeId(safeDecode(body.slice(separatorIndex + 1)));
    if (!decodedId || decodedId.length > MAX_TARGET_ID_LENGTH || hasControlCharacter(decodedId)) {
      return null;
    }
    return { kind: kind, id: decodedId };
  }

  function isCitationAnchor(anchor, chatTimeline) {
    if (!anchor || !chatTimeline || !anchor.getAttribute) return false;
    if (typeof chatTimeline.contains === 'function' && !chatTimeline.contains(anchor)) return false;
    if (typeof anchor.closest !== 'function') return false;
    return Boolean(anchor.closest('.chat-bubble-markdown'));
  }

  function findClosestAnchor(target) {
    if (!target || typeof target.closest !== 'function') return null;
    return target.closest('a[href]');
  }

  function createCitationJumpController(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var win = options.window || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    var chatTimeline = options.chatTimeline || null;
    var getCurrentSessionMessages = typeof options.getCurrentSessionMessages === 'function'
      ? options.getCurrentSessionMessages
      : function defaultGetCurrentSessionMessages() { return []; };
    var scrollMessageIntoView = typeof options.scrollMessageIntoView === 'function'
      ? options.scrollMessageIntoView
      : null;
    var viewportReveal = options.viewportReveal || null;
    var focusEntryByMessageId = typeof options.focusEntryByMessageId === 'function'
      ? options.focusEntryByMessageId
      : null;
    var timelineVirtualizer = options.timelineVirtualizer || null;
    var appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};
    var highlightDurationMs = Math.max(
      Number(options.highlightDurationMs) || DEFAULT_HIGHLIGHT_DURATION_MS,
      0
    );

    var highlightTimers = new Map();
    var toolMessageCacheMessages = null;
    var toolMessageCacheLength = -1;
    var toolMessageCache = null;
    var disposed = false;

    function resolveEntry(messageId) {
      var id = normalizeId(messageId);
      if (!id || !chatTimeline || typeof chatTimeline.querySelector !== 'function') return null;
      try {
        return chatTimeline.querySelector('.chat-entry[data-message-id="' + cssStringEscape(id) + '"]');
      } catch (_error) {
        return null;
      }
    }

    function resolveRow(rowId) {
      var id = normalizeId(rowId);
      if (!id || !chatTimeline || typeof chatTimeline.querySelector !== 'function') return null;
      try {
        return chatTimeline.querySelector('.chat-row[data-row-id="' + cssStringEscape(id) + '"]');
      } catch (_error) {
        return null;
      }
    }

    function resolveToolRow(toolCallId) {
      var id = normalizeId(toolCallId);
      if (!id || !chatTimeline || typeof chatTimeline.querySelector !== 'function') return null;
      var escapedId = cssStringEscape(id);
      try {
        return chatTimeline.querySelector(
          '.chat-row[data-tool-call-id="' + escapedId + '"],'
          + '.chat-row[data-call-id="' + escapedId + '"],'
          + '[data-tool-call-id="' + escapedId + '"],'
          + '[data-call-id="' + escapedId + '"]'
        );
      } catch (_error) {
        return null;
      }
    }

    function appendToolIdCandidates(candidates, source, includePlainId) {
      if (!source || typeof source !== 'object') return;
      candidates.push(source.tool_call_id, source.toolCallId, source.call_id, source.callId);
      if (includePlainId) candidates.push(source.id);
    }

    function appendToolCallArrayCandidates(candidates, source) {
      if (!Array.isArray(source)) return;
      for (var i = 0; i < source.length; i += 1) {
        appendToolIdCandidates(candidates, source[i], true);
      }
    }

    function normalizeCandidates(candidates) {
      return candidates.map(normalizeId).filter(Boolean);
    }

    function readToolIds(source) {
      if (!source || typeof source !== 'object') return [];
      var payload = source.payload && typeof source.payload === 'object' ? source.payload : {};
      var candidates = [];
      appendToolIdCandidates(candidates, source, false);
      appendToolIdCandidates(candidates, payload, false);
      appendToolIdCandidates(candidates, source.tool_call, true);
      appendToolIdCandidates(candidates, source.toolCall, true);
      appendToolIdCandidates(candidates, source.tool_result, true);
      appendToolIdCandidates(candidates, source.toolResult, true);
      appendToolIdCandidates(candidates, payload.tool_call, true);
      appendToolIdCandidates(candidates, payload.toolCall, true);
      appendToolIdCandidates(candidates, payload.tool_result, true);
      appendToolIdCandidates(candidates, payload.toolResult, true);
      appendToolCallArrayCandidates(candidates, source.tool_calls);
      appendToolCallArrayCandidates(candidates, source.toolCalls);
      appendToolCallArrayCandidates(candidates, payload.tool_calls);
      appendToolCallArrayCandidates(candidates, payload.toolCalls);
      return normalizeCandidates(candidates);
    }

    function readToolResultIds(source) {
      if (!source || typeof source !== 'object') return [];
      var payload = source.payload && typeof source.payload === 'object' ? source.payload : {};
      var candidates = [];
      appendToolIdCandidates(candidates, source.tool_result, true);
      appendToolIdCandidates(candidates, source.toolResult, true);
      appendToolIdCandidates(candidates, payload.tool_result, true);
      appendToolIdCandidates(candidates, payload.toolResult, true);
      var kind = normalizeId(source.kind || payload.kind).toLowerCase();
      var role = normalizeId(source.role || payload.role).toLowerCase();
      if (kind === 'tool_result' || role === 'tool') {
        appendToolIdCandidates(candidates, source, false);
        appendToolIdCandidates(candidates, payload, false);
      }
      return normalizeCandidates(candidates);
    }

    function buildToolMessageCache(messages) {
      var resultIds = new Map();
      var fallbackIds = new Map();
      for (var i = 0; i < messages.length; i += 1) {
        var message = messages[i];
        var messageId = normalizeId(message && message.id);
        if (!messageId) continue;
        var cacheEntry = { messageId: messageId, message: message, index: i };
        var resultCandidates = readToolResultIds(message);
        for (var r = 0; r < resultCandidates.length; r += 1) {
          if (!resultIds.has(resultCandidates[r])) {
            resultIds.set(resultCandidates[r], cacheEntry);
          }
        }
        var toolCandidates = readToolIds(message);
        for (var t = 0; t < toolCandidates.length; t += 1) {
          if (!fallbackIds.has(toolCandidates[t])) {
            fallbackIds.set(toolCandidates[t], cacheEntry);
          }
        }
      }
      toolMessageCacheMessages = messages;
      toolMessageCacheLength = messages.length;
      toolMessageCache = { resultIds: resultIds, fallbackIds: fallbackIds };
      return toolMessageCache;
    }

    function getToolMessageCache(messages, forceRebuild) {
      if (
        forceRebuild
        || messages !== toolMessageCacheMessages
        || messages.length !== toolMessageCacheLength
        || !toolMessageCache
      ) {
        return buildToolMessageCache(messages);
      }
      return toolMessageCache;
    }

    function isCachedToolMappingCurrent(messages, cached, toolCallId, resultOnly) {
      if (!cached || !Array.isArray(messages)) return false;
      var message = messages[cached.index];
      if (message !== cached.message || normalizeId(message && message.id) !== cached.messageId) {
        return false;
      }
      if (resultOnly) {
        return readToolResultIds(message).indexOf(toolCallId) >= 0;
      }
      return readToolIds(message).indexOf(toolCallId) >= 0;
    }

    function resolveCachedToolMessageId(messages, cache, toolCallId) {
      var resultHit = cache && cache.resultIds && cache.resultIds.get(toolCallId);
      if (isCachedToolMappingCurrent(messages, resultHit, toolCallId, true)) {
        return resultHit.messageId;
      }
      var fallbackHit = cache && cache.fallbackIds && cache.fallbackIds.get(toolCallId);
      if (isCachedToolMappingCurrent(messages, fallbackHit, toolCallId, false)) {
        return fallbackHit.messageId;
      }
      return '';
    }

    function resolveToolMessageId(toolCallId) {
      var id = normalizeId(toolCallId);
      if (!id) return '';
      var messages = getCurrentSessionMessages();
      if (!Array.isArray(messages)) return '';
      var cache = getToolMessageCache(messages, false);
      var found = resolveCachedToolMessageId(messages, cache, id);
      if (found) return found;
      // Most message updates replace the array, but a defensive second pass
      // covers same-reference/same-length mutations from test harnesses or
      // compatibility callers without putting an O(N) scan on every click.
      cache = getToolMessageCache(messages, true);
      return resolveCachedToolMessageId(messages, cache, id);
    }

    function ensureMounted(entryEl) {
      if (
        !entryEl
        || entryEl.getAttribute('data-virtualized') !== 'true'
        || !timelineVirtualizer
        || typeof timelineVirtualizer.ensureMounted !== 'function'
      ) {
        return;
      }
      try { timelineVirtualizer.ensureMounted(entryEl); } catch (_error) { /* best-effort */ }
    }

    function ensureMountedForRowId(rowId) {
      if (!timelineVirtualizer || typeof timelineVirtualizer.ensureMountedForRowId !== 'function') {
        return false;
      }
      try { return timelineVirtualizer.ensureMountedForRowId(rowId) === true; } catch (_error) { return false; }
    }

    function ensureMountedForToolCallId(toolCallId) {
      if (!timelineVirtualizer || typeof timelineVirtualizer.ensureMountedForToolCallId !== 'function') {
        return false;
      }
      try { return timelineVirtualizer.ensureMountedForToolCallId(toolCallId) === true; } catch (_error) { return false; }
    }

    function focusEntry(messageId, targetNode) {
      var id = normalizeId(messageId);
      if (!id && targetNode && typeof targetNode.closest === 'function') {
        id = normalizeId(targetNode.closest('.chat-entry')?.getAttribute('data-message-id'));
      }
      if (!id) return false;
      if (focusEntryByMessageId) {
        try {
          if (focusEntryByMessageId(id)) return true;
        } catch (_error) { /* fall back to DOM focus */ }
      }
      var entry = resolveEntry(id);
      if (!entry || typeof entry.focus !== 'function') return false;
      entry.setAttribute('tabindex', '0');
      entry.focus({ preventScroll: true });
      return true;
    }

    function clearHighlight(target) {
      var timer = highlightTimers.get(target);
      if (timer) {
        (win || globalThis).clearTimeout(timer);
        highlightTimers.delete(target);
      }
      target?.classList?.remove(HIGHLIGHT_CLASS);
    }

    function applyHighlight(target) {
      if (!target || !target.classList) return false;
      clearHighlight(target);
      target.classList.add(HIGHLIGHT_CLASS);
      if (highlightDurationMs > 0 && win && typeof win.setTimeout === 'function') {
        var timer = win.setTimeout(function clearCitationHighlight() {
          clearHighlight(target);
        }, highlightDurationMs);
        highlightTimers.set(target, timer);
      }
      return true;
    }

    function logSuccess(targetKind) {
      appendClientLog('INFO', 'chat.citation_jump', { targetKind: targetKind });
    }

    function logFailure(targetKind, reason) {
      appendClientLog('WARN', 'chat.citation_jump_failed', {
        targetKind: targetKind,
        reason: reason,
      });
    }

    function scrollRowIntoView(row) {
      if (!row) return false;
      return Boolean(viewportReveal?.revealElement?.(row, {
        block: 'center',
        followLatest: false,
        reason: 'citation_jump',
      }));
    }

    function jumpToMessage(messageId, targetKind) {
      var entry = resolveEntry(messageId);
      ensureMounted(entry);
      var didScroll = false;
      if (scrollMessageIntoView) {
        try {
          didScroll = Boolean(scrollMessageIntoView(messageId, {
            block: 'center',
            followLatest: false,
            reason: 'citation_jump',
          }));
        } catch (_error) {
          didScroll = false;
        }
      }
      entry = resolveEntry(messageId) || entry;
      if (!didScroll && entry) {
        didScroll = Boolean(viewportReveal?.revealElement?.(entry, {
          block: 'center',
          followLatest: false,
          reason: 'citation_jump',
        }));
      }
      if (!entry || !didScroll) return false;
      focusEntry(messageId, entry);
      applyHighlight(entry);
      logSuccess(targetKind || 'message');
      return true;
    }

    function jumpToRow(rowId) {
      var row = resolveRow(rowId);
      if (!row && ensureMountedForRowId(rowId)) {
        row = resolveRow(rowId);
      }
      if (!row) return false;
      var entry = typeof row.closest === 'function' ? row.closest('.chat-entry') : null;
      ensureMounted(entry);
      row = resolveRow(rowId) || row;
      if (!scrollRowIntoView(row)) return false;
      focusEntry('', row);
      applyHighlight(row);
      logSuccess('row');
      return true;
    }

    function jumpToToolRow(toolCallId, row, mounted) {
      if (!row) return false;
      var rowEntry = typeof row.closest === 'function' ? row.closest('.chat-entry') : null;
      if (!mounted) {
        ensureMounted(rowEntry);
        row = resolveToolRow(toolCallId) || row;
      }
      if (!scrollRowIntoView(row)) return false;
      focusEntry('', row);
      applyHighlight(row);
      logSuccess('tool');
      return true;
    }

    function jumpToTool(toolCallId) {
      var row = resolveToolRow(toolCallId);
      if (!row && ensureMountedForToolCallId(toolCallId)) {
        row = resolveToolRow(toolCallId);
      }
      if (row) {
        return jumpToToolRow(toolCallId, row);
      }
      var messageId = resolveToolMessageId(toolCallId);
      if (!messageId) return false;
      var entry = resolveEntry(messageId);
      ensureMounted(entry);
      var didScroll = false;
      if (scrollMessageIntoView) {
        try {
          didScroll = Boolean(scrollMessageIntoView(messageId, {
            block: 'center',
            followLatest: false,
            reason: 'citation_jump',
          }));
        } catch (_error) {
          didScroll = false;
        }
      }
      row = resolveToolRow(toolCallId);
      if (row) {
        return jumpToToolRow(toolCallId, row, true);
      }
      entry = resolveEntry(messageId) || entry;
      if (!didScroll && entry) {
        didScroll = Boolean(viewportReveal?.revealElement?.(entry, {
          block: 'center',
          followLatest: false,
          reason: 'citation_jump',
        }));
      }
      if (!entry || !didScroll) return false;
      focusEntry(messageId, entry);
      applyHighlight(entry);
      logSuccess('tool');
      return true;
    }

    function jumpToCitation(citation) {
      if (disposed || !citation) return false;
      var didJump = false;
      if (citation.kind === 'message') {
        didJump = jumpToMessage(citation.id, 'message');
      } else if (citation.kind === 'row') {
        didJump = jumpToRow(citation.id);
      } else if (citation.kind === 'tool') {
        didJump = jumpToTool(citation.id);
      }
      if (!didJump) {
        logFailure(citation.kind, 'target_not_found');
      }
      return didJump;
    }

    function handleClick(event) {
      var anchor = findClosestAnchor(event && event.target);
      if (!isCitationAnchor(anchor, chatTimeline)) return;
      var citation = parseCitationHref(anchor.getAttribute('href'), doc && doc.location && doc.location.href);
      if (!citation) return;
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      jumpToCitation(citation);
    }

    function attach(registerListener, listenerOptions) {
      if (!chatTimeline) return function noopDetachCitationJump() {};
      if (typeof registerListener === 'function') {
        registerListener(chatTimeline, 'click', handleClick, listenerOptions);
        return function noopDetachRegisteredCitationJump() {};
      }
      chatTimeline.addEventListener('click', handleClick, listenerOptions);
      return function detachCitationJump() {
        chatTimeline.removeEventListener('click', handleClick, listenerOptions);
      };
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      highlightTimers.forEach(function clearTimer(timer, target) {
        if (win && typeof win.clearTimeout === 'function') {
          win.clearTimeout(timer);
        }
        target?.classList?.remove(HIGHLIGHT_CLASS);
      });
      highlightTimers.clear();
    }

    return {
      attach: attach,
      dispose: dispose,
      jumpToCitation: jumpToCitation,
    };
  }

  return {
    createCitationJumpController: createCitationJumpController,
    parseCitationHref: parseCitationHref,
  };
});
