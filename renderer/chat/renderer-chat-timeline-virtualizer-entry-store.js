/* renderer/chat/renderer-chat-timeline-virtualizer-entry-store.js
 * Bounded storage and restoration for DOM-windowed timeline articles.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatTimelineVirtualizerEntryStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SEMANTIC_PREVIEW_CAP = 512;
  var FALLBACK_TEXT = 'Message content is temporarily unavailable. Jenny is refreshing the transcript.';
  var LIVE_STATE_SELECTOR = 'textarea, input, select, audio, video, '
    + '[contenteditable="true"], [contenteditable=""], [data-virtualizer-pin-live]';
  var HISTORICAL_LIVE_SELECTOR = '[role="alert"], [role="status"], [aria-live]:not([aria-live="off"])';
  var SEMANTIC_DETAIL_SELECTOR = '.tool-call-row-body, .tool-call-details, .tool-result-body';

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function normalizePreview(value) {
    var text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= SEMANTIC_PREVIEW_CAP) return text;
    return text.slice(0, SEMANTIC_PREVIEW_CAP - 1).trimEnd() + '\u2026';
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createTimelineVirtualizerEntryStore(deps) {
    var options = deps || {};
    var chatTimeline = options.chatTimeline || null;
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var boundsEnabled = options.boundsEnabled !== false;
    var budgets = options.budgets || {};
    var stringCap = Math.max(1, Number(budgets.virtualizedMarkupEntries) || 160);
    var requestEntryMarkup = typeof options.requestEntryMarkup === 'function'
      ? options.requestEntryMarkup
      : null;
    var requestCanonicalRerender = typeof options.requestCanonicalRerender === 'function'
      ? options.requestCanonicalRerender
      : null;
    var onAfterMount = typeof options.onAfterMount === 'function' ? options.onAfterMount : null;
    var appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};

    var entryStates = new WeakMap();
    var rowIdToEntry = new Map();
    var toolCallIdToEntry = new Map();
    var messageIdToEntry = new Map();
    var stringCache = new Map();
    var rebuiltMarkupCount = 0;
    var rebuildFailureCount = 0;
    var canonicalRerenderRequested = false;
    var virtualizedCount = 0;
    var disposed = false;

    function hasAttribute(entryEl, name) {
      if (!entryEl) return false;
      if (typeof entryEl.hasAttribute === 'function') return entryEl.hasAttribute(name);
      return Boolean(entryEl.getAttribute && entryEl.getAttribute(name) !== null);
    }

    function collectAttributeValues(entryEl, selector, attributes) {
      if (!entryEl || typeof entryEl.querySelectorAll !== 'function') return [];
      var nodes;
      try { nodes = Array.from(entryEl.querySelectorAll(selector)); } catch (_error) { return []; }
      var values = [];
      for (var index = 0; index < nodes.length; index += 1) {
        for (var attrIndex = 0; attrIndex < attributes.length; attrIndex += 1) {
          var id = normalizeId(nodes[index].getAttribute && nodes[index].getAttribute(attributes[attrIndex]));
          if (id && values.indexOf(id) < 0) values.push(id);
        }
      }
      return values;
    }

    function setIndexEntries(indexMap, ids, entryEl) {
      for (var index = 0; index < ids.length; index += 1) indexMap.set(ids[index], entryEl);
    }

    function clearIndexEntries(indexMap, ids, entryEl) {
      for (var index = 0; index < ids.length; index += 1) {
        if (indexMap.get(ids[index]) === entryEl) indexMap.delete(ids[index]);
      }
    }

    function indexEntry(entryEl, stash) {
      setIndexEntries(rowIdToEntry, stash.rowIds, entryEl);
      setIndexEntries(toolCallIdToEntry, stash.toolCallIds, entryEl);
      if (stash.messageId) messageIdToEntry.set(stash.messageId, entryEl);
    }

    function clearEntryIndex(entryEl, stash) {
      clearIndexEntries(rowIdToEntry, stash.rowIds, entryEl);
      clearIndexEntries(toolCallIdToEntry, stash.toolCallIds, entryEl);
      if (stash.messageId && messageIdToEntry.get(stash.messageId) === entryEl) {
        messageIdToEntry.delete(stash.messageId);
      }
    }

    function isEntryCurrent(entryEl) {
      if (!entryEl || entryEl.isConnected === false || !entryStates.has(entryEl)) return false;
      if (!chatTimeline || typeof chatTimeline.contains !== 'function') return true;
      try { return chatTimeline.contains(entryEl); } catch (_error) { return entryEl.isConnected !== false; }
    }

    function pruneIndexMap(indexMap) {
      indexMap.forEach(function removeStale(entryEl, key) {
        if (!isEntryCurrent(entryEl)) indexMap.delete(key);
      });
    }

    function pruneIndexes() {
      pruneIndexMap(rowIdToEntry);
      pruneIndexMap(toolCallIdToEntry);
      pruneIndexMap(messageIdToEntry);
      stringCache.forEach(function removeStaleString(stash, entryEl) {
        if (!isEntryCurrent(entryEl)) removeStash(entryEl, stash);
      });
    }

    function resolveIndexedEntry(indexMap, id) {
      var normalized = normalizeId(id);
      if (!normalized) return null;
      var entryEl = indexMap.get(normalized);
      if (isEntryCurrent(entryEl)) return entryEl;
      indexMap.delete(normalized);
      return null;
    }

    function hasLiveState(entryEl) {
      if (!entryEl || typeof entryEl.querySelector !== 'function') return false;
      try { return Boolean(entryEl.querySelector(LIVE_STATE_SELECTOR)); } catch (_error) { return false; }
    }

    function admitString(entryEl, stash) {
      if (!boundsEnabled) return;
      stringCache.delete(entryEl);
      stringCache.set(entryEl, stash);
      while (stringCache.size > stringCap) {
        var oldest = stringCache.keys().next();
        if (oldest.done) break;
        var oldestEl = oldest.value;
        var oldestStash = stringCache.get(oldestEl);
        stringCache.delete(oldestEl);
        if (oldestStash && oldestStash.mode === 'string') {
          oldestStash.originalHtml = '';
          oldestStash.mode = 'rebuild';
        }
      }
    }

    function isSemanticTextVisible(node, entryEl) {
      var element = node && node.parentElement;
      while (element) {
        if (element.matches?.(SEMANTIC_DETAIL_SELECTOR)
          || element.hasAttribute?.('inert')
          || element.hasAttribute?.('hidden')
          || element.getAttribute?.('aria-hidden') === 'true') {
          return false;
        }
        if (element === entryEl) break;
        element = element.parentElement;
      }
      return true;
    }

    function collectSemanticPreviewText(entryEl) {
      var ownerDoc = entryEl && (entryEl.ownerDocument || doc);
      if (!entryEl || !ownerDoc || typeof ownerDoc.createTreeWalker !== 'function') return '';
      var walker = ownerDoc.createTreeWalker(entryEl, 4 /* NodeFilter.SHOW_TEXT */, {
        acceptNode: function acceptSemanticText(node) {
          return isSemanticTextVisible(node, entryEl) ? 1 /* FILTER_ACCEPT */ : 2 /* FILTER_REJECT */;
        },
      });
      var parts = [];
      var length = 0;
      var node = walker.nextNode();
      while (node && length <= SEMANTIC_PREVIEW_CAP) {
        var value = String(node.nodeValue || '').trim();
        if (value) {
          parts.push(value);
          length += value.length + 1;
        }
        node = walker.nextNode();
      }
      return parts.join(' ');
    }

    function getSemanticPreview(entryEl) {
      var role = normalizeId(entryEl?.getAttribute?.('data-message-role'));
      var status = normalizeId(entryEl?.getAttribute?.('data-message-status'));
      var prefix = role ? role.charAt(0).toUpperCase() + role.slice(1) + ' message' : 'Message';
      if (status && status !== 'complete') prefix += ' (' + status + ')';
      var body = normalizePreview(collectSemanticPreviewText(entryEl));
      return normalizePreview(body ? prefix + ': ' + body : prefix + '.');
    }

    function buildPlaceholderHtml(preview) {
      return '<div class="chat-entry-virtualized">'
        + '<span class="sr-only" data-virtualized-summary="true">'
        + escapeHtml(preview)
        + '</span></div>';
    }

    function restoreShellAttributes(entryEl, stash) {
      entryEl.removeAttribute?.('data-virtualized');
      if (entryEl.style) entryEl.style.minHeight = stash.hadInlineMinHeight ? stash.previousMinHeight : '';
      if (stash.hadTabindex) entryEl.setAttribute?.('tabindex', stash.previousTabindex);
      else entryEl.removeAttribute?.('tabindex');
      if (stash.hadAriaLabel) entryEl.setAttribute?.('aria-label', stash.previousAriaLabel);
      else entryEl.removeAttribute?.('aria-label');
      if (stash.hadAriaHidden) entryEl.setAttribute?.('aria-hidden', stash.previousAriaHidden);
      else entryEl.removeAttribute?.('aria-hidden');
    }

    function suppressHistoricalAnnouncements(entryEl) {
      if (!entryEl || typeof entryEl.querySelectorAll !== 'function') return;
      var liveNodes;
      try { liveNodes = Array.from(entryEl.querySelectorAll(HISTORICAL_LIVE_SELECTOR)); }
      catch (_error) { return; }
      for (var index = 0; index < liveNodes.length; index += 1) {
        liveNodes[index].setAttribute?.('aria-live', 'off');
      }
    }

    function removeStash(entryEl, stash) {
      clearEntryIndex(entryEl, stash);
      entryStates.delete(entryEl);
      stringCache.delete(entryEl);
      virtualizedCount = Math.max(0, virtualizedCount - 1);
    }

    function applyUnmount(entryEl, height, layout) {
      if (!entryEl || disposed || entryStates.has(entryEl)) return { ok: false, reason: 'unavailable' };
      var preview = getSemanticPreview(entryEl);
      var previousMinHeight = entryEl.style ? entryEl.style.minHeight : '';
      var predictedHeight = Math.max(
        0,
        Number(entryEl.getAttribute && entryEl.getAttribute('data-predicted-height')) || 0
      );
      // Pretext's inline min-height is a one-paint stabilizer, not durable
      // article state. If virtualization wins the race before prediction
      // cleanup, restoring that value later creates a viewport-sized blank gap
      // below otherwise short content. Preserve unrelated authored min-heights.
      var minHeightIsPredictionOwned = predictedHeight > 0
        && previousMinHeight === predictedHeight + 'px';
      var stash = {
        mode: 'string',
        originalHtml: '',
        placeholderHtml: buildPlaceholderHtml(preview),
        placeholderNode: null,
        semanticPreview: preview,
        height: Math.max(0, Number(height) || 0),
        layoutEpoch: Math.max(0, Number(layout && layout.epoch) || 0),
        layoutWidth: Math.max(0, Number(layout && layout.width) || 0),
        messageId: normalizeId(entryEl.getAttribute && entryEl.getAttribute('data-message-id')),
        rowIds: collectAttributeValues(entryEl, '[data-row-id]', ['data-row-id']),
        toolCallIds: collectAttributeValues(entryEl, '[data-tool-call-id], [data-call-id]', ['data-tool-call-id', 'data-call-id']),
        previousMinHeight: minHeightIsPredictionOwned ? '' : previousMinHeight,
        hadInlineMinHeight: Boolean(previousMinHeight) && !minHeightIsPredictionOwned,
        previousTabindex: entryEl.getAttribute ? entryEl.getAttribute('tabindex') : null,
        hadTabindex: hasAttribute(entryEl, 'tabindex'),
        previousAriaHidden: entryEl.getAttribute ? entryEl.getAttribute('aria-hidden') : null,
        hadAriaHidden: hasAttribute(entryEl, 'aria-hidden'),
        previousAriaLabel: entryEl.getAttribute ? entryEl.getAttribute('aria-label') : null,
        hadAriaLabel: hasAttribute(entryEl, 'aria-label'),
      };
      stash.originalHtml = entryEl.innerHTML;
      admitString(entryEl, stash);
      entryStates.set(entryEl, stash);
      virtualizedCount += 1;
      indexEntry(entryEl, stash);
      if (entryEl.style) entryEl.style.minHeight = stash.height + 'px';
      entryEl.innerHTML = stash.placeholderHtml;
      stash.placeholderNode = entryEl.firstChild || null;
      entryEl.setAttribute?.('data-virtualized', 'true');
      // Keep the article's stable accessible name across unmount/remount.
      // The bounded sr-only child carries the role/status preview; changing
      // both would duplicate it and make remounts more likely to be announced.
      entryEl.removeAttribute?.('aria-hidden');
      return { ok: true, reason: 'virtualized', stash: stash };
    }

    function dropIfMorphed(entryEl) {
      var stash = entryStates.get(entryEl);
      if (!stash) return false;
      var markerIntact = entryEl.getAttribute?.('data-virtualized') === 'true';
      var placeholderIntact = stash.placeholderNode
        ? entryEl.firstChild === stash.placeholderNode && entryEl.lastChild === stash.placeholderNode
        : entryEl.innerHTML === stash.placeholderHtml;
      if (markerIntact && placeholderIntact) return false;
      removeStash(entryEl, stash);
      return true;
    }

    function showRebuildFallback(entryEl, stash, reason) {
      rebuildFailureCount += 1;
      removeStash(entryEl, stash);
      restoreShellAttributes(entryEl, stash);
      entryEl.innerHTML = '<div class="chat-entry-virtualized-fallback" role="note">'
        + escapeHtml(FALLBACK_TEXT) + '</div>';
      entryEl.setAttribute?.('data-virtualizer-fallback', 'true');
      if (rebuildFailureCount === 1) {
        try {
          appendClientLog('WARN', 'chat.timeline_virtualizer_rebuild_failed', {
            reason: reason,
            failureCount: rebuildFailureCount,
          });
        } catch (_error) { /* best-effort */ }
      }
      if (!canonicalRerenderRequested && requestCanonicalRerender) {
        canonicalRerenderRequested = true;
        try { requestCanonicalRerender(); } catch (_error2) { /* fallback remains readable */ }
      }
      return { ok: false, reason: reason, stash: stash, degraded: true };
    }

    function acknowledgeCanonicalRerender() {
      if (!disposed) canonicalRerenderRequested = false;
    }

    function mount(entryEl, layout) {
      if (!entryEl || disposed) return { ok: false, reason: 'unavailable' };
      var stash = entryStates.get(entryEl);
      if (!stash || dropIfMorphed(entryEl)) return { ok: false, reason: 'not_virtualized' };
      if (stash.mode === 'rebuild') {
        var rebuiltHtml;
        try { rebuiltHtml = String(requestEntryMarkup && requestEntryMarkup(entryEl) || ''); }
        catch (_error) { return showRebuildFallback(entryEl, stash, 'threw'); }
        if (!rebuiltHtml) return showRebuildFallback(entryEl, stash, 'empty');
        entryEl.innerHTML = rebuiltHtml;
        rebuiltMarkupCount += 1;
      } else {
        entryEl.innerHTML = stash.originalHtml;
      }
      entryEl.removeAttribute?.('data-virtualizer-fallback');
      restoreShellAttributes(entryEl, stash);
      removeStash(entryEl, stash);
      // Restoring historical status/alert markup must not replay old events.
      // The role remains navigable; only implicit/explicit live behavior is disabled.
      suppressHistoricalAnnouncements(entryEl);
      if (onAfterMount) {
        try { onAfterMount(entryEl, entryEl); } catch (_error2) { /* best-effort */ }
      }
      var nextEpoch = Math.max(0, Number(layout && layout.epoch) || 0);
      var nextWidth = Math.max(0, Number(layout && layout.width) || 0);
      return {
        ok: true,
        reason: 'mounted',
        stash: stash,
        layoutInvalidated: stash.layoutEpoch !== nextEpoch || Math.abs(stash.layoutWidth - nextWidth) > 1,
      };
    }

    function restoreAll(entries, layout) {
      var restored = 0;
      var list = Array.isArray(entries) ? entries : [];
      for (var index = 0; index < list.length; index += 1) {
        if (entryStates.has(list[index]) && mount(list[index], layout).ok) restored += 1;
      }
      return restored;
    }

    function getStats() {
      return {
        virtualizedEntries: virtualizedCount,
        serializedMarkupEntries: stringCache.size,
        serializedMarkupCap: stringCap,
        rebuiltMarkupCount: rebuiltMarkupCount,
        rebuildFailureCount: rebuildFailureCount,
      };
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      rowIdToEntry.clear();
      toolCallIdToEntry.clear();
      messageIdToEntry.clear();
      stringCache.clear();
      entryStates = new WeakMap();
      virtualizedCount = 0;
    }

    return {
      acknowledgeCanonicalRerender: acknowledgeCanonicalRerender,
      applyUnmount: applyUnmount,
      dispose: dispose,
      dropIfMorphed: dropIfMorphed,
      getRetentionMode: function getRetentionMode(entryEl) { return entryStates.get(entryEl)?.mode || null; },
      getStats: getStats,
      has: function has(entryEl) { return entryStates.has(entryEl); },
      hasLiveState: hasLiveState,
      mount: mount,
      pruneIndexes: pruneIndexes,
      resolveMessageId: function resolveMessageId(id) { return resolveIndexedEntry(messageIdToEntry, id); },
      resolveRowId: function resolveRowId(id) { return resolveIndexedEntry(rowIdToEntry, id); },
      resolveToolCallId: function resolveToolCallId(id) { return resolveIndexedEntry(toolCallIdToEntry, id); },
      restoreAll: restoreAll,
      _internals: {
        getSemanticPreview: getSemanticPreview,
        getIndexSizes: function getIndexSizes() {
          return { rows: rowIdToEntry.size, tools: toolCallIdToEntry.size, messages: messageIdToEntry.size };
        },
      },
    };
  }

  return {
    FALLBACK_TEXT: FALLBACK_TEXT,
    LIVE_STATE_SELECTOR: LIVE_STATE_SELECTOR,
      SEMANTIC_PREVIEW_CAP: SEMANTIC_PREVIEW_CAP,
    createTimelineVirtualizerEntryStore: createTimelineVirtualizerEntryStore,
  };
});
