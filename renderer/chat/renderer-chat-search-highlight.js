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
  var MAX_SEARCH_TOTAL_MATCHES = 500;
  var VISIBLE_TEXT_CACHE_LIMIT = 500;
  // A text boundary between two of these elements reads as a line break, so a
  // phrase matches across inline nodes (strong, em, code, a, span) but not
  // across blocks.
  var BLOCK_TAGS = {
    P: 1, DIV: 1, LI: 1, UL: 1, OL: 1, PRE: 1, BLOCKQUOTE: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, TD: 1, TH: 1, BR: 1, HR: 1, DETAILS: 1, SUMMARY: 1,
    ARTICLE: 1, SECTION: 1, DT: 1, DD: 1,
  };
  // Rows that render a message's own prose; tool, reasoning and notice rows
  // share its source id but not its text.
  var PROSE_ROW_KINDS = { '': 1, assistant_text: 1, user_bubble: 1, slash_output: 1 };
  // Messages whose rows are not the Markdown rendering of their content.
  var NON_MARKDOWN_MESSAGE_KINDS = {
    tool_use: 1, tool_result: 1, interactive_round_recap: 1, proactive_suggestion: 1, slash_command_output: 1,
  };

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

  // The text the user can read under `roots` (an element or a list of them), as
  // one string plus the text node behind each stretch of it. A newline marks
  // a block boundary; the same walker serves canonical documents and mounted DOM.
  function collectSearchableText(roots) {
    var text = '';
    var segments = [];
    var pendingBreak = false;
    function walk(parent) {
      var children = parent.childNodes;
      for (var index = 0; index < children.length; index += 1) {
        var child = children[index];
        if (child.nodeType === 3 /* Node.TEXT_NODE */) {
          var value = child.nodeValue;
          // Whitespace between blocks is collapsed, not visible text.
          if (!value || (pendingBreak && !value.trim()) || shouldSkipTextNode(child)) continue;
          if (pendingBreak && text) text += '\n';
          pendingBreak = false;
          segments.push({ node: child, start: text.length, end: text.length + value.length });
          text += value;
        } else if (child.nodeType === 1 /* Node.ELEMENT_NODE */) {
          var isBlock = BLOCK_TAGS[child.tagName] === 1;
          if (isBlock) pendingBreak = true;
          walk(child);
          if (isBlock) pendingBreak = true;
        }
      }
    }
    [].concat(roots).forEach(function walkRoot(rootNode) {
      pendingBreak = true;
      walk(rootNode);
    });
    return { text: text, segments: segments };
  }

  function collectMatchesInEntry(entry, entryIndex, pattern, doc, limit, roots) {
    var matches = [];
    var searchable = collectSearchableText(roots || entry);
    var segments = searchable.segments;
    var segmentIndex = 0;
    var found;
    pattern.lastIndex = 0;
    while (matches.length < limit && (found = pattern.exec(searchable.text)) !== null) {
      if (found[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      var start = found.index;
      var end = start + found[0].length;
      while (segments[segmentIndex].end <= start) segmentIndex += 1;
      var endIndex = segmentIndex;
      while (segments[endIndex].end < end) endIndex += 1;
      var range = doc.createRange();
      range.setStart(segments[segmentIndex].node, start - segments[segmentIndex].start);
      range.setEnd(segments[endIndex].node, end - segments[endIndex].start);
      matches.push({ entryEl: entry, entryIndex: entryIndex, range: range });
    }
    return matches;
  }

  function isRowOfMessage(row, sourceMessageId) {
    return row.getAttribute('data-source-message-id') === sourceMessageId
      || (' ' + (row.getAttribute('data-source-message-ids') || '') + ' ').indexOf(' ' + sourceMessageId + ' ') >= 0;
  }

  function isProseRow(row) {
    return Boolean(PROSE_ROW_KINDS[String(row.getAttribute('data-row-kind') || '')]);
  }

  // Visible-text documents for message prose: renders the content like the
  // transcript row does (user bubbles with line breaks, assistant text with
  // citation markers stripped when that flag is on), parses it inertly and runs
  // the shared walker. Bounded LRU keyed by message id, invalidated when the
  // source string changes.
  function createVisibleTextProvider(deps) {
    var settings = deps || {};
    var doc = settings.document || (typeof document !== 'undefined' ? document : null);
    var cache = new Map();
    var cacheLimit = VISIBLE_TEXT_CACHE_LIMIT;
    var scope = typeof globalThis !== 'undefined' ? globalThis : null;

    function citationStripper() {
      var flags = typeof settings.getFeatureFlags === 'function' ? settings.getFeatureFlags() : null;
      var chips = scope && scope.rendererCitationChipsUtils;
      if (!chips && typeof require === 'function') {
        try { chips = require('./renderer-citation-chips-utils'); } catch (_error) { chips = null; }
      }
      return flags && flags.source_citations === true && chips && typeof chips.stripCitationMarkers === 'function'
        ? chips.stripCitationMarkers : null;
    }

    function toVisibleText(message) {
      var render = settings.renderMarkdown || (scope && scope.markdownUtils && scope.markdownUtils.renderMarkdown);
      if (!doc || typeof render !== 'function' || NON_MARKDOWN_MESSAGE_KINDS[String(message.kind || '').trim()]) return null;
      var source = String(message.content || message.text || '');
      var isUser = String(message.role || '').trim() === 'user';
      var strip = isUser ? null : citationStripper();
      var variant = (isUser ? 'user' : 'assistant') + (strip ? '+strip' : '');
      var messageId = String(message.id || '').trim();
      var cached = messageId ? cache.get(messageId) : null;
      if (cached && cached.source === source && cached.variant === variant) {
        cache.delete(messageId);
        cache.set(messageId, cached);
        return cached.text;
      }
      var template = doc.createElement('template');
      template.innerHTML = String(isUser ? render(source, { breaks: true }) : render(strip ? strip(source) : source));
      var text = collectSearchableText(template.content).text;
      if (messageId) {
        cache.delete(messageId);
        cache.set(messageId, { source: source, variant: variant, text: text });
        if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
      }
      return text;
    }

    // A rescan reads every message in order: a cache smaller than the session
    // would miss on every lookup, so it holds the searched session while open.
    function reserve(messageCount) {
      cacheLimit = Math.max(VISIBLE_TEXT_CACHE_LIMIT, Number(messageCount) || 0);
    }

    return { toVisibleText: toVisibleText, reserve: reserve, clear: function clear() { cache.clear(); } };
  }

  function buildCanonicalSearchDocuments(messages, turnEventState, buildOptions) {
    var toVisibleText = buildOptions && typeof buildOptions.toVisibleText === 'function' ? buildOptions.toVisibleText : null;
    var documents = [];
    var seen = new Map();
    var ownerByMessageId = new Map();
    function pushDocument(messageId, text, metadata) {
      var normalizedText = String(text == null ? '' : text);
      var normalizedMessageId = String(messageId || '').trim();
      if (!normalizedMessageId || !normalizedText) return;
      var meta = metadata || {};
      var field = String(meta.field || 'message');
      // Where the text is shown: a tool detail in its call's row, anything
      // else in the rows of its own message.
      var sourceMessageId = String(meta.sourceMessageId || '').trim();
      var identity = [normalizedMessageId, field === 'tool_detail' ? '' : sourceMessageId, String(meta.toolCallId || ''), field].join('|');
      var seenTexts = seen.get(identity);
      if (!seenTexts) {
        seenTexts = { fromMessages: [], fromEvents: [] };
        seen.set(identity, seenTexts);
      }
      if (meta.fromEvent === true) {
        // A turn event repeats what its message already carries (a tool
        // summary): one visible passage, not a second match. Events are told
        // apart from each other by exact text only.
        if (seenTexts.fromMessages.some(function containsText(seenText) { return seenText.indexOf(normalizedText) >= 0; })
          || seenTexts.fromEvents.indexOf(normalizedText) >= 0) return;
        seenTexts.fromEvents.push(normalizedText);
      } else {
        if (seenTexts.fromMessages.indexOf(normalizedText) >= 0) return;
        seenTexts.fromMessages.push(normalizedText);
      }
      documents.push({
        messageId: normalizedMessageId,
        sourceMessageId: sourceMessageId,
        // Documents shown in the same rows number their matches together.
        bindGroup: identity,
        text: normalizedText,
        toolCallId: String(meta.toolCallId || '').trim(),
        turnId: String(meta.turnId || '').trim(),
        field: field,
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
      var visibleText = toVisibleText ? toVisibleText(message) : null;
      pushDocument(articleOwnerId, typeof visibleText === 'string' ? visibleText : message.content || message.text || '', {
        field: 'message', sourceMessageId: messageId,
      });
      var call = message.tool_call && typeof message.tool_call === 'object' ? message.tool_call : null;
      if (call) {
        pushDocument(articleOwnerId, [call.summary, call.input_summary, call.input_json].filter(Boolean).join('\n'), {
          field: 'tool_detail', toolCallId: call.call_id, sourceMessageId: messageId,
        });
      }
      var result = message.tool_result && typeof message.tool_result === 'object' ? message.tool_result : null;
      if (result) {
        pushDocument(articleOwnerId, [result.summary, result.output_text, result.error_code].filter(Boolean).join('\n'), {
          field: 'tool_detail', toolCallId: result.call_id, sourceMessageId: messageId,
        });
      }
    }
    var turnEvents = Array.isArray(turnEventState?.turnEvents) ? turnEventState.turnEvents : [];
    for (var eventIndex = 0; eventIndex < turnEvents.length; eventIndex += 1) {
      var event = turnEvents[eventIndex] || {};
      var payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
      var eventMessageId = String(event.primary_message_id || event.source_message_ids?.[0] || '').trim();
      var ownerId = ownerByMessageId.get(eventMessageId) || eventMessageId;
      var eventMeta = {
        // 'event': text a non-tool event contributes (a reasoning summary),
        // shown outside the message's prose rows.
        field: /^tool_|^approval_/.test(String(event.kind || '')) ? 'tool_detail' : 'event',
        toolCallId: event.tool_call_id || payload.tool_call_id,
        turnId: event.turn_id,
        sourceMessageId: eventMessageId,
        fromEvent: true,
      };
      // One document per field, so a field the message documents already
      // carry is dropped on its own.
      [
        payload.summary,
        payload.input_summary,
        payload.input_json,
        payload.result_summary,
        payload.output_text,
        payload.error_code,
      ].filter(Boolean).forEach(function pushEventField(value) { pushDocument(ownerId, value, eventMeta); });
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
    // The ordinal a match is bound by counts across the documents shown in the
    // same rows (bindGroup), in document order; a document without a group
    // counts alone.
    var occurrencesByGroup = new Map();
    for (var index = 0; index < sourceDocuments.length && matches.length < MAX_SEARCH_TOTAL_MATCHES; index += 1) {
      var document = sourceDocuments[index] || {};
      var text = String(document.text || '');
      pattern.lastIndex = 0;
      var found;
      var group = document.bindGroup || '#' + index;
      var occurrence = occurrencesByGroup.get(group) || 0;
      while (matches.length < MAX_SEARCH_TOTAL_MATCHES && (found = pattern.exec(text)) !== null) {
        if (!found[0].length) { pattern.lastIndex += 1; continue; }
        matches.push({ ...document, documentIndex: index, occurrenceInDocument: occurrence, start: found.index, end: found.index + found[0].length });
        occurrence += 1;
      }
      occurrencesByGroup.set(group, occurrence);
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
      var occurrence = Math.max(0, Number(canonicalMatch.occurrenceInDocument) || 0);
      var prose = canonicalMatch.field === 'message';
      var sourceMessageId = prose || canonicalMatch.field === 'event' ? String(canonicalMatch.sourceMessageId || '') : '';
      // A turn's messages share one article: the ordinal counts inside the rows
      // of the match's own message, never across the whole article.
      var ownRows = sourceMessageId
        ? Array.from(entryEl.querySelectorAll('.chat-row')).filter(function ownRow(row) { return isRowOfMessage(row, sourceMessageId); })
        : null;
      var rows = ownRows && ownRows.filter(function ofKind(row) { return isProseRow(row) === prose; });
      // A message with no prose row (a plan document, a recap) shows its text
      // in whatever rows carry its id.
      if (prose && rows && !rows.length) rows = ownRows;
      var mountedMatches = rows && !rows.length
        ? []
        : collectMatchesInEntry(rows ? entryEl : scopeEl, entryIndex, pattern, doc, occurrence + 1, rows || undefined);
      var selected = mountedMatches[occurrence] || null;
      var registry = getCssHighlights(win);
      var Ctor = getHighlightCtor(win);
      if (selected) {
        matches[currentIndex] = { ...matches[currentIndex], ...selected };
        if (registry && Ctor) registry.set(HIGHLIGHT_NAME_CURRENT, new Ctor(selected.range));
      } else if (registry) {
        registry.delete(HIGHLIGHT_NAME_CURRENT);
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
    createVisibleTextProvider: createVisibleTextProvider,
    collectSearchableText: collectSearchableText,
    findDocumentMatches: findDocumentMatches,
    MAX_SEARCH_TOTAL_MATCHES: MAX_SEARCH_TOTAL_MATCHES,
    escapeRegExp: escapeRegExp,
  };
});
