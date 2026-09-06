/*
 * renderer/chat/chat-scroll-utils.js — pure scroll-state helpers (UMD)
 *
 * Scroll anchoring is renderer-driven, not browser-driven. The transcript
 * explicitly disables browser overflow anchoring in styles/chat-thread.css.
 * renderer/shell/renderer-viewport-utils.js calls getScrollBehavior()
 * per-scroll to respect reduced-motion, active streaming, and follow-latest
 * state.  This module supplies the heuristics; the viewport controller owns
 * the actual scroll calls.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.chatScrollUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_SCROLL_FOLLOW_THRESHOLD = 48;
  const DEFAULT_LOGICAL_ANCHOR_CAP = 32;
  const LOGICAL_ROW_SELECTOR = '[data-row-id]';
  const LOGICAL_ENTRY_FALLBACK_SELECTOR = '.chat-entry[data-message-id]';

  function getLatestUserMessageId(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (String(list[index] && list[index].role || '') === 'user') {
        return String(list[index].id || '');
      }
    }
    return '';
  }

  function isNearBottom(metrics, threshold = DEFAULT_SCROLL_FOLLOW_THRESHOLD) {
    const scrollTop = Number(metrics && metrics.scrollTop) || 0;
    const scrollHeight = Number(metrics && metrics.scrollHeight) || 0;
    const clientHeight = Number(metrics && metrics.clientHeight) || 0;
    return scrollHeight - (scrollTop + clientHeight) <= threshold;
  }

  function deriveFollowLatestFromScroll(metrics, threshold = DEFAULT_SCROLL_FOLLOW_THRESHOLD) {
    return isNearBottom(metrics, threshold);
  }

  function shouldAutoScrollThread(options) {
    const settings = options || {};
    if (settings.forceBottom) {
      return true;
    }
    return Boolean(settings.followLatest) && settings.thinkingAutoScroll !== false;
  }

  function readLogicalRowIdentity(node) {
    const rowId = String(node?.getAttribute?.('data-row-id') || '').trim();
    const parentMessageId = String(
      node?.closest?.('.chat-entry[data-message-id]')?.getAttribute?.('data-message-id') || ''
    ).trim();
    if (rowId) return { kind: 'row', id: rowId, parentMessageId };
    const messageId = String(node?.getAttribute?.('data-message-id') || '').trim();
    return messageId ? { kind: 'message', id: messageId, parentMessageId: messageId } : null;
  }

  function isVolatileApprovalRow(node) {
    return String(node?.getAttribute?.('data-row-kind') || '').trim() === 'approval_gap';
  }

  function findMessageEntry(rootNode, messageId) {
    const normalizedId = String(messageId || '').trim();
    if (!normalizedId || !rootNode || typeof rootNode.querySelectorAll !== 'function') return null;
    try {
      return Array.from(rootNode.querySelectorAll(LOGICAL_ENTRY_FALLBACK_SELECTOR))
        .find((node) => String(node?.getAttribute?.('data-message-id') || '').trim() === normalizedId)
        || null;
    } catch (_error) {
      return null;
    }
  }

  function collectLogicalRows(rootNode, options = {}) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return [];
    try {
      if (options.preferEntries === true) {
        return Array.from(rootNode.querySelectorAll(LOGICAL_ENTRY_FALLBACK_SELECTOR));
      }
      const rowNodes = Array.from(rootNode.querySelectorAll(LOGICAL_ROW_SELECTOR));
      const candidates = rowNodes.length
        ? rowNodes
        : Array.from(rootNode.querySelectorAll(LOGICAL_ENTRY_FALLBACK_SELECTOR));
      const seen = new Set();
      return candidates.filter((node) => {
        const identity = readLogicalRowIdentity(node);
        if (!identity) return false;
        const key = `${identity.kind}:${identity.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch (_error) {
      return [];
    }
  }

  function createLogicalScrollAnchorRegistry(options = {}) {
    const cap = Number.isFinite(options.cap)
      ? Math.max(1, Math.trunc(options.cap))
      : DEFAULT_LOGICAL_ANCHOR_CAP;
    const threshold = Number.isFinite(options.threshold)
      ? Math.max(0, Number(options.threshold))
      : DEFAULT_SCROLL_FOLLOW_THRESHOLD;
    const preferEntries = options.preferEntries === true;
    const getContentGeneration = typeof options.getContentGeneration === 'function'
      ? options.getContentGeneration
      : null;
    const anchors = new Map();
    let captureRowCache = null;
    let disposed = false;

    function getMetrics(container) {
      return {
        scrollTop: Number(container?.scrollTop) || 0,
        scrollHeight: Number(container?.scrollHeight) || 0,
        clientHeight: Number(container?.clientHeight) || 0,
      };
    }

    function getRect(node) {
      try { return node?.getBoundingClientRect?.() || null; } catch (_error) { return null; }
    }

    function findFirstVisibleIndex(rows, containerTop) {
      if (!rows.length) return -1;
      if (!preferEntries) {
        return rows.findIndex((candidate) => {
          const rect = getRect(candidate);
          return rect && rect.bottom > containerTop;
        });
      }
      let low = 0;
      let high = rows.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const rect = getRect(rows[middle]);
        if (!rect) {
          return rows.findIndex((candidate) => {
            const fallbackRect = getRect(candidate);
            return fallbackRect && fallbackRect.bottom > containerTop;
          });
        }
        if (rect.bottom > containerTop) high = middle;
        else low = middle + 1;
      }
      return low < rows.length ? low : -1;
    }

    function isRetainedAnchorNode(rootNode, node, identity) {
      if (!rootNode || !node || !identity) return false;
      try {
        if (rootNode !== node && !rootNode.contains?.(node)) return false;
      } catch (_error) {
        return false;
      }
      const currentIdentity = readLogicalRowIdentity(node);
      return currentIdentity?.kind === identity.kind && currentIdentity.id === identity.id;
    }

    function touch(key, value) {
      anchors.delete(key);
      anchors.set(key, value);
      while (anchors.size > cap) {
        anchors.delete(anchors.keys().next().value);
      }
    }

    function collectCaptureRows(rootNode) {
      if (!getContentGeneration) return collectLogicalRows(rootNode, { preferEntries });
      const generation = getContentGeneration();
      if (
        captureRowCache
        && captureRowCache.generation === generation
        && captureRowCache.rootNode === rootNode
      ) {
        return captureRowCache.rows;
      }
      const rows = collectLogicalRows(rootNode, { preferEntries });
      captureRowCache = { generation, rootNode, rows };
      return rows;
    }

    function capture(key, container, rootNode = container) {
      const normalizedKey = String(key || '').trim();
      if (disposed || !normalizedKey || !container) return false;
      const metrics = getMetrics(container);
      const containerRect = getRect(container);
      const rows = collectCaptureRows(rootNode);
      let row = null;
      let rowIndex = -1;
      if (containerRect) {
        rowIndex = findFirstVisibleIndex(rows, containerRect.top);
        if (rowIndex >= 0 && isVolatileApprovalRow(rows[rowIndex])) {
          const nextDurableIndex = rows.findIndex((candidate, index) => (
            index > rowIndex && !isVolatileApprovalRow(candidate)
          ));
          if (nextDurableIndex >= 0) {
            rowIndex = nextDurableIndex;
          } else {
            for (let index = rowIndex - 1; index >= 0; index -= 1) {
              if (!isVolatileApprovalRow(rows[index])) {
                rowIndex = index;
                break;
              }
            }
          }
        }
        if (rowIndex >= 0) row = rows[rowIndex];
      }
      const identity = readLogicalRowIdentity(row);
      const rowRect = getRect(row);
      touch(normalizedKey, {
        identity,
        node: row,
        rowIndex,
        offset: rowRect && containerRect ? Number(rowRect.top - containerRect.top) || 0 : 0,
        rawScrollTop: metrics.scrollTop,
        nearBottom: isNearBottom(metrics, threshold),
      });
      return true;
    }

    function restore(key, container, rootNode = container) {
      const normalizedKey = String(key || '').trim();
      if (disposed || !normalizedKey || !container) return 'unavailable';
      const anchor = anchors.get(normalizedKey);
      if (!anchor) return 'missing';
      touch(normalizedKey, anchor);
      if (anchor.nearBottom) {
        container.scrollTop = Math.max(0, (Number(container.scrollHeight) || 0) - (Number(container.clientHeight) || 0));
        return 'near_bottom';
      }
      let rows = null;
      let target = isRetainedAnchorNode(rootNode, anchor.node, anchor.identity)
        ? anchor.node
        : null;
      if (!target && anchor.identity) {
        rows = collectLogicalRows(rootNode, { preferEntries });
        target = rows.find((row) => {
          const identity = readLogicalRowIdentity(row);
          return identity?.kind === anchor.identity.kind && identity.id === anchor.identity.id;
        }) || null;
      }
      let outcome = 'logical';
      if (!target && anchor.identity?.parentMessageId) {
        target = findMessageEntry(rootNode, anchor.identity.parentMessageId);
        outcome = target ? 'parent' : outcome;
      }
      // Older anchors without a parent identity retain the historical nearest
      // fallback. New row anchors never jump to an unrelated row when their
      // virtualized interior is temporarily absent.
      if (!target && !anchor.identity?.parentMessageId) {
        if (!rows) rows = collectLogicalRows(rootNode, { preferEntries });
      }
      if (!target && !anchor.identity?.parentMessageId && rows.length && anchor.rowIndex >= 0) {
        target = rows[Math.min(anchor.rowIndex, rows.length - 1)];
        outcome = 'nearest';
      }
      const containerRect = getRect(container);
      const targetRect = getRect(target);
      if (target && containerRect && targetRect) {
        container.scrollTop = Math.max(0, (Number(container.scrollTop) || 0)
          + (Number(targetRect.top - containerRect.top) || 0) - anchor.offset);
        return outcome;
      }
      container.scrollTop = Math.max(0, anchor.rawScrollTop);
      return 'raw';
    }

    function clear(key) {
      if (key === undefined) anchors.clear();
      else anchors.delete(String(key || '').trim());
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      anchors.clear();
      captureRowCache = null;
    }

    return {
      capture,
      clear,
      dispose,
      restore,
      size() { return anchors.size; },
    };
  }

  return {
    DEFAULT_LOGICAL_ANCHOR_CAP,
    DEFAULT_SCROLL_FOLLOW_THRESHOLD,
    collectLogicalRows,
    createLogicalScrollAnchorRegistry,
    deriveFollowLatestFromScroll,
    findMessageEntry,
    getLatestUserMessageId,
    isNearBottom,
    readLogicalRowIdentity,
    shouldAutoScrollThread,
  };
});
