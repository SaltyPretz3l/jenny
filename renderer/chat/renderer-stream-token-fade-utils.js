/*
 * renderer/chat/renderer-stream-token-fade-utils.js
 *
 * Rebuilds short-lived fade spans after each streaming tail HTML rewrite.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamTokenFadeUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createStreamTokenFadeTracker(options = {}) {
    const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
    const fadeValue = Number(options.fadeMs);
    const fadeMs = Number.isFinite(fadeValue) ? Math.max(0, fadeValue) : 220;
    const setInnerHtml = typeof options.setInnerHtml === 'function'
      ? options.setInnerHtml
      : (element, html) => { element.innerHTML = html; };
    const segmentsByUnit = new Map();
    let messageId = '';

    function reset(nextMessageId) {
      const nextId = String(nextMessageId || '');
      if (nextId === messageId) return;
      segmentsByUnit.clear();
      messageId = nextId;
    }

    function wrapSegments(unitEl, segments, now) {
      const doc = unitEl && unitEl.ownerDocument;
      if (!doc || typeof doc.createElement !== 'function') return false;
      const textNodes = [];
      const collectTextNodes = (node) => {
        for (const child of Array.from(node.childNodes || [])) {
          if (child.nodeType === 3) textNodes.push(child);
          else collectTextNodes(child);
        }
      };
      collectTextNodes(unitEl);
      if (!textNodes.length) return false;

      const firstStart = segments[0].start;
      const lastEnd = segments[segments.length - 1].end;
      let offset = 0;
      for (const textNode of textNodes) {
        const nodeStart = offset;
        const nodeEnd = nodeStart + textNode.data.length;
        offset = nodeEnd;
        // Segments live at the tail: skip the settled prefix, stop past the end.
        if (nodeStart >= lastEnd) break;
        if (nodeEnd <= firstStart) continue;
        const ranges = segments
          .map((segment) => ({
            start: Math.max(segment.start, nodeStart) - nodeStart,
            end: Math.min(segment.end, nodeEnd) - nodeStart,
            t: segment.t,
          }))
          .filter((range) => range.start < range.end);
        for (let index = ranges.length - 1; index >= 0; index -= 1) {
          const range = ranges[index];
          let covered = textNode;
          if (range.end < covered.data.length) covered.splitText(range.end);
          if (range.start > 0) covered = covered.splitText(range.start);
          const span = doc.createElement('span');
          span.className = 'chat-stream-token';
          span.style.animationDelay = `-${Math.max(0, now - range.t)}ms`;
          covered.parentNode.replaceChild(span, covered);
          span.appendChild(covered);
        }
      }
      return true;
    }

    // A delta larger than this is a bulk paste (tool output, a fast burst),
    // not token streaming: wrapping hundreds of text nodes per frame costs
    // more than the fade is worth, so such a jump paints plainly.
    const MAX_SEGMENT_CHARS = 1500;

    function applyTailUnit(unitEl, nextHtml, unitIndex) {
      if (!unitEl) return false;
      const prevText = String(unitEl.textContent || '');
      setInnerHtml(unitEl, nextHtml);
      const nextText = String(unitEl.textContent || '');
      // Only one unit is ever the tail; drop history that belonged to another.
      for (const key of Array.from(segmentsByUnit.keys())) {
        if (key !== unitIndex) segmentsByUnit.delete(key);
      }

      const now = Number(nowFn());
      const live = (segmentsByUnit.get(unitIndex) || []).filter((segment) => now - segment.t <= fadeMs);
      const grew = nextText.length > prevText.length && nextText.startsWith(prevText);
      if (grew && nextText.length - prevText.length <= MAX_SEGMENT_CHARS) {
        live.push({ start: prevText.length, end: nextText.length, t: now });
      }
      // In-flight fades survive a markup reflow (**bo -> <strong>bold) or an
      // unchanged frame as long as the settled prefix before them still holds;
      // dropping them would snap every fading token to full opacity. Only a
      // rewrite of that settled prefix starts over.
      const stableStart = live.length ? Math.min(...live.map((segment) => segment.start)) : nextText.length;
      const stableHolds = nextText.startsWith(prevText.slice(0, Math.min(stableStart, prevText.length)));
      const nextSegments = stableHolds
        ? live
          .map((segment) => ({ start: segment.start, end: Math.min(segment.end, nextText.length), t: segment.t }))
          .filter((segment) => segment.start < segment.end)
          .sort((a, b) => a.start - b.start)
        : [];
      if (nextSegments.length && wrapSegments(unitEl, nextSegments, now)) {
        segmentsByUnit.set(unitIndex, nextSegments);
      } else {
        segmentsByUnit.delete(unitIndex);
      }
      return true;
    }

    return { reset, applyTailUnit };
  }

  return { createStreamTokenFadeTracker };
});
