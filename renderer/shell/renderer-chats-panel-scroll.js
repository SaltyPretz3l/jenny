/* renderer/shell/renderer-chats-panel-scroll.js
 *
 * Scroll and focus keeping for the Chats list across keyed re-renders: the pre-render anchor
 * (first visible row, its offset, the row order, the focused row), its restore onto the nearest
 * surviving row, and quiet focus moves. Split out of renderer-chats-panel-tree.js at its 600-line
 * ratchet; the panel controller is the only caller.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatsPanelScroll = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Neighbours (in the pre-render DOM order) that still exist after a render.
  function survivingNeighborIds(snapshot, sourceIndex, ids) {
    var orderedIds = snapshot && snapshot.orderedIds || [];
    var index = Number.isInteger(sourceIndex) ? sourceIndex : -1;
    var nextId = '';
    var previousId = '';
    for (var next = index + 1; next < orderedIds.length; next += 1) {
      if (ids.has(orderedIds[next])) {
        nextId = orderedIds[next];
        break;
      }
    }
    for (var previous = Math.min(index - 1, orderedIds.length - 1); previous >= 0; previous -= 1) {
      if (ids.has(orderedIds[previous])) {
        previousId = orderedIds[previous];
        break;
      }
    }
    return { nextId: nextId, previousId: previousId };
  }

  function nearestSurvivingSessionId(snapshot, sourceIndex, ids) {
    var neighbors = survivingNeighborIds(snapshot, sourceIndex, ids);
    return neighbors.nextId || neighbors.previousId;
  }

  /** Pre-render scroll state: the first visible row, its offset, the row order and the focused row. */
  function captureScrollAnchor(container, rows, activeElement) {
    var top = Number(container.scrollTop) || 0;
    var clientHeight = Number(container.clientHeight) || 0;
    var scrollHeight = Number(container.scrollHeight) || 0;
    var snapshot = {
      top: top,
      bottomDistance: Math.max(scrollHeight - clientHeight - top, 0),
      atBottom: clientHeight > 0 && scrollHeight > clientHeight && scrollHeight - clientHeight - top <= 2,
      sessionId: '',
      anchorIndex: -1,
      offset: 0,
      focusedSessionId: '',
      focusedIndex: -1,
      focusedControl: '',
    };
    // Pre-render row order, built on first read: an unchanged render never restores or refocuses.
    var orderedIds = null;
    Object.defineProperty(snapshot, 'orderedIds', {
      enumerable: true,
      get: function () {
        return orderedIds || (orderedIds = Array.from(rows, function (row) { return row.dataset.sessionId; }));
      },
    });
    var focusedRow = activeElement && activeElement.closest && activeElement.closest('.conversation-item[data-session-id]');
    if (focusedRow && container.contains(focusedRow)) {
      snapshot.focusedSessionId = focusedRow.dataset.sessionId;
      snapshot.focusedIndex = Array.prototype.indexOf.call(rows, focusedRow);
      snapshot.focusedControl = activeElement.matches('[data-session-action="menu"]') ? 'menu' : 'open';
    }
    if (!clientHeight || typeof container.getBoundingClientRect !== 'function') return snapshot;
    var containerRect = container.getBoundingClientRect();
    for (var index = 0; index < rows.length; index += 1) {
      var rect = rows[index].getBoundingClientRect();
      if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
        snapshot.sessionId = rows[index].dataset.sessionId;
        snapshot.anchorIndex = index;
        snapshot.offset = rect.top - containerRect.top;
        break;
      }
    }
    return snapshot;
  }

  /** Keeps the anchor row where it was (or the nearest surviving neighbour); bottom and top stay pinned. */
  function restoreScrollAnchor(container, snapshot, rows, rowById) {
    if (snapshot.atBottom) {
      container.scrollTop = Math.max((Number(container.scrollHeight) || 0) - (Number(container.clientHeight) || 0), 0);
      return;
    }
    // At the very top, stay there: a chat that lands above the first row
    // must show, not shove the list down a row under the viewport edge.
    if (snapshot.top === 0) {
      container.scrollTop = 0;
      return;
    }
    var currentRows = Array.from(rows);
    var currentIds = currentRows.map(function (row) { return row.dataset.sessionId; });
    var ids = new Set(currentIds);
    var anchor = snapshot.sessionId && rowById.get(snapshot.sessionId);
    if (anchor) {
      var currentIndex = currentIds.indexOf(snapshot.sessionId);
      var neighbors = survivingNeighborIds(snapshot, snapshot.anchorIndex, ids);
      var crossedPrevious = neighbors.previousId
        && currentIds.indexOf(neighbors.previousId) > currentIndex;
      var crossedNext = neighbors.nextId
        && currentIds.indexOf(neighbors.nextId) < currentIndex;
      if (currentIndex < 0 || crossedPrevious || crossedNext) anchor = null;
    }
    if (!anchor && snapshot.anchorIndex >= 0) {
      var fallbackId = nearestSurvivingSessionId(snapshot, snapshot.anchorIndex, ids);
      anchor = fallbackId && rowById.get(fallbackId);
    }
    if (anchor && anchor.isConnected && typeof anchor.getBoundingClientRect === 'function') {
      // Measure from the live offset: the layout the rect read forces has
      // already applied the browser's own scroll anchoring, and adding the
      // delta to the stale snapshot.top would undo it (a one-row jump).
      var delta = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - snapshot.offset;
      container.scrollTop = Math.max(0, (Number(container.scrollTop) || 0) + delta);
      return;
    }
    var max = Math.max((Number(container.scrollHeight) || 0) - (Number(container.clientHeight) || 0), 0);
    var hasLayoutMetrics = Number(container.scrollHeight) > 0 || Number(container.clientHeight) > 0;
    container.scrollTop = hasLayoutMetrics ? Math.min(snapshot.top, max) : snapshot.top;
  }

  /** Focus without scrolling the list (older engines take no options). */
  function focusQuiet(element) {
    if (!element) return;
    try { element.focus({ preventScroll: true }); } catch (_error) { element.focus(); }
  }

  /** The first of `selectors` the focused element inside `container` matches; '' when focus is elsewhere. */
  function focusedSelector(container, selectors) {
    var active = container && container.ownerDocument && container.ownerDocument.activeElement;
    if (!active || !container.contains(active)) return '';
    return selectors.filter(function (selector) { return active.matches(selector); })[0] || '';
  }

  return {
    survivingNeighborIds: survivingNeighborIds,
    nearestSurvivingSessionId: nearestSurvivingSessionId,
    captureScrollAnchor: captureScrollAnchor,
    restoreScrollAnchor: restoreScrollAnchor,
    focusQuiet: focusQuiet,
    focusedSelector: focusedSelector,
  };
});
