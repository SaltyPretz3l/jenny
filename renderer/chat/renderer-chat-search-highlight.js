/**
 * renderer/chat/renderer-chat-search-highlight.js
 *
 * F1: scans the rendered chat timeline for substring matches and registers
 * them with the CSS Custom Highlight API. Zero DOM mutation — highlights
 * live in `CSS.highlights` and are painted by the browser via the
 * `::highlight(chat-search-match)` and `::highlight(chat-search-current)`
 * pseudo-elements (see styles/chat-search-v2.css).
 *
 * Streaming bubbles (`.chat-bubble-streaming`) are skipped — search runs
 * over finalized message content only. The search bar's own DOM is
 * excluded via `[data-search-skip="true"]`.
 *
 * Electron 40 / Chromium 128+ supports `CSS.highlights` and `Highlight()`
 * natively, so no polyfill is shipped. Tests in JSDOM provide a tiny shim
 * (a Map plus a stub Highlight class) — see
 * tests/renderer-chat-search-highlight.test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererChatSearchHighlight = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';

  var escapeRegExp = stringUtils && stringUtils.escapeRegExp;
  if (typeof escapeRegExp !== 'function') {
    throw new Error('rendererChatSearchHighlight: renderer/shared/string-utils.js must load before this module');
  }

  var HIGHLIGHT_NAME_ALL = 'chat-search-match';
  var HIGHLIGHT_NAME_CURRENT = 'chat-search-current';
  var MAX_SEARCH_FIELD_CHARS = 10000;
  var MAX_SEARCH_TOTAL_MATCHES = 500;

  function buildPattern(query, options) {
    var opts = options || {};
    var escaped = escapeRegExp(query);
    if (opts.wholeWord) {
      var startsWithWord = /\w/.test(String(query || '').charAt(0));
      var endsWithWord = /\w/.test(String(query || '').slice(-1));
      escaped = (startsWithWord ? '\\b' : '(?<!\\w)')
        + escaped
        + (endsWithWord ? '\\b' : '(?!\\w)');
    }
    var flags = 'g' + (opts.caseSensitive ? '' : 'i');
    return new RegExp(escaped, flags);
  }

  function getCssHighlights(rootObj) {
    var win = rootObj || (typeof globalThis !== 'undefined' ? globalThis : null);
    if (!win || !win.CSS || !win.CSS.highlights) return null;
    return win.CSS.highlights;
  }

  function getHighlightCtor(rootObj) {
    var win = rootObj || (typeof globalThis !== 'undefined' ? globalThis : null);
    if (!win || typeof win.Highlight !== 'function') return null;
    return win.Highlight;
  }

  function entryHasStreamingBubble(entry) {
    return !!entry.querySelector('.chat-bubble-streaming');
  }

  function shouldSkipTextNode(node) {
    var parent = node && node.parentElement;
    if (!parent || typeof parent.closest !== 'function') return false;
    return Boolean(parent.closest(
      '[data-search-skip="true"],'
      + '[hidden],'
      + '[aria-hidden="true"],'
      + 'button,'
      + '[role="button"],'
      + '.chat-hover-actions,'
      + '.chat-hover-action,'
      + '.inv-artifact-actions,'
      + '.tool-call-status-badge,'
      + '.sr-only'
    ));
  }

  function collectMatchesInEntry(entry, entryIndex, pattern, doc, limit) {
    var matches = [];
    var filterReject = 2;
    var filterAccept = 1;
    var walker = doc.createTreeWalker(entry, 4 /* NodeFilter.SHOW_TEXT */, {
      acceptNode: function acceptNode(node) {
        return shouldSkipTextNode(node) ? filterReject : filterAccept;
      },
    });
    var node = walker.nextNode();
    while (node && matches.length < limit) {
      if (node.nodeValue) {
        pattern.lastIndex = 0;
        var text = node.nodeValue;
        var found;
        while (matches.length < limit && (found = pattern.exec(text)) !== null) {
          if (found[0].length === 0) {
            pattern.lastIndex += 1;
            continue;
          }
          var range = doc.createRange();
          range.setStart(node, found.index);
          range.setEnd(node, found.index + found[0].length);
          matches.push({ entryEl: entry, entryIndex: entryIndex, range: range });
        }
      }
      node = walker.nextNode();
    }
    return matches;
  }

  function boundedText(value) {
    return String(value == null ? '' : value).slice(0, MAX_SEARCH_FIELD_CHARS);
  }

  function buildCanonicalSearchDocuments(messages, turnEventState) {
    var documents = [];
    var seen = new Set();
    var ownerByMessageId = new Map();
    function pushDocument(messageId, text, metadata) {
      var normalizedText = boundedText(text);
      var normalizedMessageId = String(messageId || '').trim();
      if (!normalizedMessageId || !normalizedText) return;
      var meta = metadata || {};
      var key = normalizedMessageId + '|' + String(meta.toolCallId || '') + '|' + String(meta.field || '') + '|' + normalizedText;
      if (seen.has(key)) return;
      seen.add(key);
      documents.push({
        messageId: normalizedMessageId,
        text: normalizedText,
        toolCallId: String(meta.toolCallId || '').trim(),
        turnId: String(meta.turnId || '').trim(),
        field: String(meta.field || 'message'),
      });
    }
    var sourceMessages = Array.isArray(messages) ? messages : [];
    var turnOwnerId = '';
    for (var index = 0; index < sourceMessages.length; index += 1) {
      var message = sourceMessages[index] || {};
      var messageId = String(message.id || '').trim();
      var role = String(message.role || '').trim();
      var kind = String(message.kind || '').trim();
      if (role === 'user') turnOwnerId = '';
      if (role === 'assistant' && kind !== 'interactive_round_recap' && kind !== 'slash_command_output' && !turnOwnerId) {
        turnOwnerId = messageId;
      }
      var articleOwnerId = role === 'assistant' && turnOwnerId ? turnOwnerId : messageId;
      if (messageId && articleOwnerId) ownerByMessageId.set(messageId, articleOwnerId);
      pushDocument(articleOwnerId, message.content || message.text || '', { field: 'message' });
      var call = message.tool_call && typeof message.tool_call === 'object' ? message.tool_call : null;
      if (call) {
        pushDocument(articleOwnerId, [call.summary, call.input_summary, call.input_json].filter(Boolean).join('\n'), {
          field: 'tool_detail', toolCallId: call.call_id,
        });
      }
      var result = message.tool_result && typeof message.tool_result === 'object' ? message.tool_result : null;
      if (result) {
        pushDocument(articleOwnerId, [result.summary, result.output_text, result.error_code].filter(Boolean).join('\n'), {
          field: 'tool_detail', toolCallId: result.call_id,
        });
      }
    }
    var turnEvents = Array.isArray(turnEventState?.turnEvents) ? turnEventState.turnEvents : [];
    for (var eventIndex = 0; eventIndex < turnEvents.length; eventIndex += 1) {
      var event = turnEvents[eventIndex] || {};
      var payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
      var eventMessageId = String(event.primary_message_id || event.source_message_ids?.[0] || '').trim();
      var ownerId = ownerByMessageId.get(eventMessageId) || eventMessageId;
      pushDocument(ownerId, [
        payload.summary,
        payload.input_summary,
        payload.input_json,
        payload.result_summary,
        payload.output_text,
        payload.error_code,
      ].filter(Boolean).join('\n'), {
        field: /^tool_|^approval_/.test(String(event.kind || '')) ? 'tool_detail' : 'message',
        toolCallId: event.tool_call_id || payload.tool_call_id,
        turnId: event.turn_id,
      });
    }
    return documents;
  }

  function findDocumentMatches(documents, query, options) {
    var q = String(query == null ? '' : query);
    if (!q) return [];
    var pattern;
    try { pattern = buildPattern(q, options); } catch (_error) { return []; }
    var matches = [];
    var sourceDocuments = Array.isArray(documents) ? documents : [];
    for (var index = 0; index < sourceDocuments.length && matches.length < MAX_SEARCH_TOTAL_MATCHES; index += 1) {
      var document = sourceDocuments[index] || {};
      var text = String(document.text || '');
      pattern.lastIndex = 0;
      var found;
      var occurrence = 0;
      while (matches.length < MAX_SEARCH_TOTAL_MATCHES && (found = pattern.exec(text)) !== null) {
        if (!found[0].length) { pattern.lastIndex += 1; continue; }
        matches.push({ ...document, documentIndex: index, occurrenceInDocument: occurrence, start: found.index, end: found.index + found[0].length });
        occurrence += 1;
      }
    }
    return matches;
  }

  function createSearchHighlightController(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var chatTimeline = options.chatTimeline || null;
    var win = options.window
      || (doc && doc.defaultView)
      || (typeof globalThis !== 'undefined' ? globalThis : null);

    var matches = [];
    var currentIndex = -1;
    var truncated = false;

    function scan(query, scanOptions) {
      clear();
      var q = String(query == null ? '' : query);
      if (!q || !chatTimeline || !doc) {
        return matches;
      }
      var pattern;
      try {
        pattern = buildPattern(q, scanOptions);
      } catch (_e) {
        return matches;
      }
      var entries = Array.from(chatTimeline.querySelectorAll('.chat-entry'));
      for (var i = 0; i < entries.length; i++) {
        if (matches.length >= MAX_SEARCH_TOTAL_MATCHES) break;
        var entry = entries[i];
        if (entryHasStreamingBubble(entry)) continue;
        var entryMatches = collectMatchesInEntry(
          entry,
          i,
          pattern,
          doc,
          MAX_SEARCH_TOTAL_MATCHES - matches.length
        );
        for (var j = 0; j < entryMatches.length; j++) {
          matches.push(entryMatches[j]);
        }
      }
      truncated = matches.length >= MAX_SEARCH_TOTAL_MATCHES;
      registerAll();
      return matches;
    }

    function scanDocuments(documents, query, scanOptions) {
      clear();
      matches = findDocumentMatches(documents, query, scanOptions);
      truncated = matches.length >= MAX_SEARCH_TOTAL_MATCHES;
      return matches;
    }

    function bindCurrentToEntry(entryEl, query, scanOptions, bindOptions) {
      if (!entryEl || currentIndex < 0 || currentIndex >= matches.length || !doc) return matches[currentIndex] || null;
      var canonicalMatch = matches[currentIndex];
      var pattern;
      try { pattern = buildPattern(String(query || ''), scanOptions); } catch (_error) { return matches[currentIndex] || null; }
      var entryIndex = Array.from(chatTimeline?.querySelectorAll?.('.chat-entry') || []).indexOf(entryEl);
      var requestedScope = bindOptions && bindOptions.scopeEl;
      var scopeEl = requestedScope && entryEl.contains?.(requestedScope) ? requestedScope : entryEl;
      var mountedMatches = collectMatchesInEntry(scopeEl, entryIndex, pattern, doc, MAX_SEARCH_TOTAL_MATCHES);
      var occurrence = Math.max(0, Number(canonicalMatch.occurrenceInDocument) || 0);
      var selected = mountedMatches[occurrence] || null;
      if (selected) {
        matches[currentIndex] = { ...matches[currentIndex], ...selected };
        var registry = getCssHighlights(win);
        var Ctor = getHighlightCtor(win);
        if (registry && Ctor) registry.set(HIGHLIGHT_NAME_CURRENT, new Ctor(selected.range));
      }
      return matches[currentIndex];
    }

    function registerAll() {
      var registry = getCssHighlights(win);
      var Ctor = getHighlightCtor(win);
      if (!registry || !Ctor) return;
      if (matches.length === 0) {
        registry.delete(HIGHLIGHT_NAME_ALL);
        registry.delete(HIGHLIGHT_NAME_CURRENT);
        return;
      }
      var ranges = matches.filter(function (m) { return m.range; }).map(function (m) { return m.range; });
      if (!ranges.length) return;
      registry.set(HIGHLIGHT_NAME_ALL, Reflect.construct(Ctor, ranges));
    }

    function setCurrentIndex(index) {
      var registry = getCssHighlights(win);
      var Ctor = getHighlightCtor(win);
      if (!matches.length) {
        currentIndex = -1;
        if (registry) registry.delete(HIGHLIGHT_NAME_CURRENT);
        return null;
      }
      var clamped = Math.max(0, Math.min(matches.length - 1, Number(index) || 0));
      currentIndex = clamped;
      if (registry && Ctor && matches[clamped].range) {
        registry.set(HIGHLIGHT_NAME_CURRENT, new Ctor(matches[clamped].range));
      } else if (registry) {
        registry.delete(HIGHLIGHT_NAME_CURRENT);
      }
      return matches[clamped];
    }

    function getCurrentIndex() {
      return currentIndex;
    }

    function getMatches() {
      return matches;
    }

    function wasTruncated() {
      return truncated;
    }

    function clear() {
      var registry = getCssHighlights(win);
      if (registry) {
        registry.delete(HIGHLIGHT_NAME_ALL);
        registry.delete(HIGHLIGHT_NAME_CURRENT);
      }
      matches = [];
      currentIndex = -1;
      truncated = false;
    }

    return {
      scan: scan,
      scanDocuments: scanDocuments,
      bindCurrentToEntry: bindCurrentToEntry,
      clear: clear,
      setCurrentIndex: setCurrentIndex,
      getCurrentIndex: getCurrentIndex,
      getMatches: getMatches,
      wasTruncated: wasTruncated,
    };
  }

  return {
    createSearchHighlightController: createSearchHighlightController,
    buildCanonicalSearchDocuments: buildCanonicalSearchDocuments,
    findDocumentMatches: findDocumentMatches,
    MAX_SEARCH_TOTAL_MATCHES: MAX_SEARCH_TOTAL_MATCHES,
    escapeRegExp: escapeRegExp,
  };
});
