(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamToolLiveTail = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* W2-1: live stdout/stderr tail for an in-flight run_command tool row.
     Chunks are EPHEMERAL — this module patches the DOM directly (textContent
     appends, like the deck clock and patchStatus) and never touches the
     row-model/render cache (perf-audit bug class: cache keyed on a value that
     changes every tick). The paired tool_result render is authoritative: on
     settle the tail pane is removed and the normal Output panel takes over. */

  // Renderer-side scrollback cap (the sidecar caps the wire volume; this
  // bounds DOM size for a long-running chatty command).
  const MAX_TAIL_LINES = 400;
  // Retained tails are bounded too: interrupted turns (cancel, stream error)
  // never call settle(), so cap the map and evict the oldest entry.
  const MAX_TRACKED_CALLS = 8;
  const STICKY_SCROLL_SLACK_PX = 24;

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  function escapeSelectorValue(value) {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
      return CSS.escape(String(value || ''));
    }
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function createToolLiveTail(options = {}) {
    const {
      getChatTimeline = () => null,
      maxTailLines = MAX_TAIL_LINES,
      maxTrackedCalls = MAX_TRACKED_CALLS,
    } = options;
    // callId -> retained tail (source of truth for the capped scrollback so
    // chunks that arrive before the async tool_use render mounts are retained
    // and painted by the row-mount observer).
    const tailsByCallId = new Map();
    const pendingMountCallIds = new Set();
    let mountObserver = null;

    function clearPendingMount(callId) {
      pendingMountCallIds.delete(callId);
      if (!pendingMountCallIds.size && mountObserver) {
        mountObserver.disconnect();
        mountObserver = null;
      }
    }

    function getTail(callId) {
      let tail = tailsByCallId.get(callId);
      if (tail) return tail;
      tail = { lines: [], partial: '', droppedUpstream: 0, droppedLocally: 0 };
      tailsByCallId.set(callId, tail);
      while (tailsByCallId.size > maxTrackedCalls) {
        const oldestKey = tailsByCallId.keys().next().value;
        tailsByCallId.delete(oldestKey);
        clearPendingMount(oldestKey);
      }
      return tail;
    }

    function findToolBlock(callId) {
      const chatTimeline = getChatTimeline();
      const normalizedCallId = normalizeId(callId);
      if (!chatTimeline || !normalizedCallId || typeof chatTimeline.querySelectorAll !== 'function') {
        return null;
      }
      const escaped = escapeSelectorValue(normalizedCallId);
      try {
        const nodes = chatTimeline.querySelectorAll(`.tool-call-block[data-call-id="${escaped}"]`);
        if (nodes.length > 0) return nodes[nodes.length - 1];
      } catch (_error) { /* fall through to the attribute walk */ }
      const candidates = Array.from(chatTimeline.querySelectorAll('.tool-call-block[data-call-id]'));
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        if (normalizeId(candidates[index].getAttribute('data-call-id')) === normalizedCallId) {
          return candidates[index];
        }
      }
      return null;
    }

    function ensurePane(block, callId) {
      let pane = block.querySelector('[data-tool-live-output]');
      if (pane) return pane;
      const doc = block.ownerDocument;
      if (!doc) return null;
      pane = doc.createElement('div');
      pane.className = 'tool-live-output';
      pane.setAttribute('data-tool-live-output', normalizeId(callId));
      const text = doc.createElement('pre');
      text.className = 'tool-live-output-text';
      pane.appendChild(text);
      const partial = doc.createElement('pre');
      partial.className = 'tool-live-output-partial hidden';
      pane.appendChild(partial);
      const marker = doc.createElement('div');
      marker.className = 'tool-live-output-truncation hidden';
      pane.appendChild(marker);
      block.appendChild(pane);
      return pane;
    }

    function recordChunk(tail, payload) {
      const rawLines = Array.isArray(payload && payload.lines) ? payload.lines : [];
      for (const line of rawLines) {
        const text = String((line && line.text) || '');
        if (!text) continue;
        const prefix = line && line.stream === 'stderr' ? '! ' : '';
        tail.lines.push(prefix + text);
      }
      if (tail.lines.length > maxTailLines) {
        tail.droppedLocally += tail.lines.length - maxTailLines;
        tail.lines = tail.lines.slice(-maxTailLines);
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'partial')) {
        tail.partial = String(payload.partial || '');
      }
      const droppedUpstream = Number(
        (payload && (payload.droppedLines || payload.dropped_lines)) || 0
      ) || 0;
      if (droppedUpstream > tail.droppedUpstream) {
        tail.droppedUpstream = droppedUpstream;
      }
    }

    function paint(block, callId, tail) {
      const pane = ensurePane(block, callId);
      if (!pane) return false;
      const textNode = pane.querySelector('.tool-live-output-text');
      if (!textNode) return false;
      const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight
        <= STICKY_SCROLL_SLACK_PX;
      textNode.textContent = tail.lines.join('\n');

      const partialNode = pane.querySelector('.tool-live-output-partial');
      if (partialNode) {
        if (tail.partial) {
          partialNode.textContent = tail.partial;
          partialNode.classList.remove('hidden');
        } else {
          partialNode.textContent = '';
          partialNode.classList.add('hidden');
        }
      }

      const droppedTotal = tail.droppedUpstream + tail.droppedLocally;
      const marker = pane.querySelector('.tool-live-output-truncation');
      if (marker) {
        if (droppedTotal > 0) {
          marker.textContent = `… ${droppedTotal} line${droppedTotal === 1 ? '' : 's'} omitted — full output arrives with the result`;
          marker.classList.remove('hidden');
        } else {
          marker.classList.add('hidden');
        }
      }
      // Sticky tail: follow new output unless the user scrolled up.
      if (nearBottom) {
        pane.scrollTop = pane.scrollHeight;
      }
      return true;
    }

    function repaintMountedTail(callId) {
      const tail = tailsByCallId.get(callId);
      const block = tail ? findToolBlock(callId) : null;
      if (!tail || !block) return false;
      const status = normalizeId(block.getAttribute('data-tool-status')).toLowerCase();
      clearPendingMount(callId);
      if (status && status !== 'running' && status !== 'executing') return false;
      return paint(block, callId, tail);
    }

    function watchForMount(callId) {
      pendingMountCallIds.add(callId);
      if (mountObserver) return;
      const chatTimeline = getChatTimeline();
      const MutationObserverImpl = chatTimeline?.ownerDocument?.defaultView?.MutationObserver;
      if (!chatTimeline || typeof MutationObserverImpl !== 'function') return;
      mountObserver = new MutationObserverImpl(() => {
        for (const pendingCallId of [...pendingMountCallIds]) {
          repaintMountedTail(pendingCallId);
        }
      });
      mountObserver.observe(chatTimeline, { childList: true, subtree: true });
    }

    function appendChunk(payload) {
      const callId = normalizeId(payload && (payload.callId || payload.tool_call_id));
      if (!callId) return false;
      const hasLines = Array.isArray(payload && payload.lines) && payload.lines.length > 0;
      const hasPartial = Boolean(payload && payload.partial);
      if (!hasLines && !hasPartial) return false;

      const block = findToolBlock(callId);
      if (block) {
        // Post-result stragglers: once the row settled, drop late chunks.
        const status = normalizeId(block.getAttribute('data-tool-status')).toLowerCase();
        if (status && status !== 'running' && status !== 'executing') return false;
      }

      // Record FIRST: the tool_use render is async, so early chunks can land
      // before the block exists.
      const tail = getTail(callId);
      recordChunk(tail, payload);
      if (!block) {
        watchForMount(callId);
        return false;
      }
      clearPendingMount(callId);
      return paint(block, callId, tail);
    }

    function settle(callId) {
      const normalizedCallId = normalizeId(callId);
      if (!normalizedCallId) return;
      tailsByCallId.delete(normalizedCallId);
      clearPendingMount(normalizedCallId);
      const chatTimeline = getChatTimeline();
      if (!chatTimeline || typeof chatTimeline.querySelectorAll !== 'function') return;
      const escaped = escapeSelectorValue(normalizedCallId);
      let panes;
      try {
        panes = Array.from(chatTimeline.querySelectorAll(`[data-tool-live-output="${escaped}"]`));
      } catch (_error) {
        panes = Array.from(chatTimeline.querySelectorAll('[data-tool-live-output]'))
          .filter((node) => normalizeId(node.getAttribute('data-tool-live-output')) === normalizedCallId);
      }
      for (const pane of panes) {
        pane.remove();
      }
    }

    function reset() {
      tailsByCallId.clear();
      pendingMountCallIds.clear();
      clearPendingMount('');
    }

    return { appendChunk, settle, reset };
  }

  return { MAX_TAIL_LINES, MAX_TRACKED_CALLS, createToolLiveTail };
});
