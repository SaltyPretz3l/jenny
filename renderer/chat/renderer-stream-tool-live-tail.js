(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-stream-dom-patch-utils'));
    return;
  }
  root.rendererStreamToolLiveTail = factory(root.rendererStreamDomPatchUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (streamDomPatchUtils) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  /* W2-1: live stdout/stderr tail for an in-flight run_command tool row.
     Chunks are EPHEMERAL — this module patches the DOM directly (textContent
     appends, like the deck clock and patchStatus) and never touches the
     row-model/render cache (perf-audit bug class: cache keyed on a value that
     changes every tick). A tail is keyed by session + stream + call id and
     paints into the live (running/executing) classic block or minimal row; a
     timeline observer repaints it when a render replaces the row. The paired
     tool_result render is authoritative: on settle the tail pane is removed and
     the normal Output panel takes over. */

  // Renderer-side scrollback cap (the sidecar caps the wire volume; this
  // bounds DOM size for a long-running chatty command).
  const MAX_TAIL_LINES = 400;
  // Retained tails are bounded too: interrupted turns (cancel, stream error)
  // may never call settle(), so cap the map and evict the oldest entry.
  const MAX_TRACKED_CALLS = 8;
  const STICKY_SCROLL_SLACK_PX = 24;
  const KEY_SEPARATOR = '\u001f';
  const LIVE_STATUSES = new Set(['running', 'executing']);

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  const { escapeSelectorValue } = streamDomPatchUtils;

  function readIdentity(source) {
    const payload = source || {};
    return {
      sessionId: normalizeId(payload.sessionId || payload.session_id),
      streamId: normalizeId(payload.streamId || payload.stream_id),
      callId: normalizeId(payload.callId || payload.tool_call_id),
    };
  }

  function buildTailKey(identity) {
    return [identity.sessionId, identity.streamId, identity.callId].join(KEY_SEPARATOR);
  }

  function createToolLiveTail(options = {}) {
    const {
      getChatTimeline = () => null,
      isSessionVisible = () => true,
      maxTailLines = MAX_TAIL_LINES,
      maxTrackedCalls = MAX_TRACKED_CALLS,
    } = options;
    // key (session + stream + call id) -> retained tail. Source of truth for
    // the capped scrollback: chunks that arrive before the async tool_use render
    // mounts, or after a render replaced the row, are painted by the reconcile
    // observer.
    const tails = new Map();
    const stickyByPane = new WeakMap();
    let observer = null;
    let observedTimeline = null;
    let disposed = false;

    function listPanes(scope, key) {
      if (!scope || typeof scope.querySelectorAll !== 'function') return [];
      return Array.from(scope.querySelectorAll('[data-tool-live-output]'))
        .filter((pane) => key === undefined || pane.getAttribute('data-tool-live-key') === key);
    }

    function disconnectObserver() {
      if (!observer) return;
      observer.disconnect();
      observer = null;
      observedTimeline = null;
    }

    function dropTail(key) {
      if (!tails.delete(key)) return;
      for (const pane of listPanes(getChatTimeline(), key)) {
        pane.remove();
      }
      if (!tails.size) disconnectObserver();
    }

    function isVisible(tail) {
      return !tail.sessionId || Boolean(isSessionVisible(tail.sessionId));
    }

    function getTail(identity) {
      const key = buildTailKey(identity);
      let tail = tails.get(key);
      if (tail) return tail;
      // One live turn per session: a newer stream supersedes the older tail of
      // the same call id (local models reuse call_0, call_1 on every turn).
      for (const [otherKey, other] of [...tails]) {
        if (other.sessionId === identity.sessionId && other.callId === identity.callId) {
          dropTail(otherKey);
        }
      }
      tail = {
        ...identity, key, lines: [], partial: '', droppedUpstream: 0, droppedLocally: 0,
        // Lines recorded so far, and what the painted text node already holds.
        totalLines: 0, row: null, painted: null,
      };
      tails.set(key, tail);
      while (tails.size > maxTrackedCalls) {
        dropTail(tails.keys().next().value);
      }
      return tail;
    }

    // A settled row is never a target: it owns its Output panel.
    function isLiveRow(node) {
      return LIVE_STATUSES.has(normalizeId(node.getAttribute('data-tool-status')).toLowerCase());
    }

    // The tail remembers its row, so a chunk costs no timeline-wide query
    // until a render replaces (disconnects) or settles that row.
    function findLiveRow(tail) {
      const chatTimeline = getChatTimeline();
      if (!chatTimeline || !tail.callId || typeof chatTimeline.querySelectorAll !== 'function') {
        return null;
      }
      const cached = tail.row;
      if (cached && cached.isConnected && chatTimeline.contains(cached) && isLiveRow(cached)) return cached;
      tail.row = null;
      const escaped = escapeSelectorValue(tail.callId);
      let candidates;
      try {
        candidates = chatTimeline.querySelectorAll(
          `.tool-call-block[data-call-id="${escaped}"], .tool-call-row--minimal[data-tool-call-id="${escaped}"]`
        );
      } catch (_error) { return null; }
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        if (isLiveRow(candidates[index])) {
          tail.row = candidates[index];
          return tail.row;
        }
      }
      return null;
    }

    // A minimal row's body is what its expansion shows and hides.
    function resolvePaneHost(row) {
      return row.classList.contains('tool-call-row--minimal')
        ? (row.querySelector('.tool-call-row-body') || row)
        : row;
    }

    // TTL-1: only a pane that sits in the row's host with its text node still
    // shows output. A keyed pane anywhere else in the row (stranded or gutted
    // by a re-render) must not count as painted, or the row never recovers.
    function findIntactPane(row, tail) {
      const host = resolvePaneHost(row);
      return listPanes(row, tail.key).find((pane) => pane.parentElement === host
        && pane.querySelector('.tool-live-output-text')) || null;
    }

    function ensurePane(row, tail) {
      const pane = findIntactPane(row, tail);
      for (const existing of listPanes(row)) {
        if (existing !== pane) existing.remove();
      }
      if (pane) return pane;
      return createPane(row, tail);
    }

    function createPane(row, tail) {
      const doc = row.ownerDocument;
      if (!doc) return null;
      const pane = doc.createElement('div');
      pane.className = 'tool-live-output';
      pane.setAttribute('data-tool-live-output', tail.callId);
      pane.setAttribute('data-tool-live-key', tail.key);
      const text = doc.createElement('pre');
      text.className = 'tool-live-output-text';
      pane.appendChild(text);
      const partial = doc.createElement('pre');
      partial.className = 'tool-live-output-partial hidden';
      pane.appendChild(partial);
      const marker = doc.createElement('div');
      marker.className = 'tool-live-output-truncation hidden';
      pane.appendChild(marker);
      // Sticky tail: follow new output unless the user scrolled up. Tracked
      // from scroll events so a chunk never reads layout before it writes.
      pane.addEventListener('scroll', () => {
        stickyByPane.set(pane, pane.scrollHeight - pane.scrollTop - pane.clientHeight <= STICKY_SCROLL_SLACK_PX);
      });
      resolvePaneHost(row).appendChild(pane);
      return pane;
    }

    function recordChunk(tail, payload) {
      const rawLines = Array.isArray(payload && payload.lines) ? payload.lines : [];
      for (const line of rawLines) {
        const text = String((line && line.text) || '');
        if (!text) continue;
        const prefix = line && line.stream === 'stderr' ? '! ' : '';
        tail.lines.push(prefix + text);
        tail.totalLines += 1;
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

    function paint(row, tail) {
      const pane = ensurePane(row, tail);
      if (!pane) return false;
      const textNode = pane.querySelector('.tool-live-output-text');
      if (!textNode) return false;
      paintLines(textNode, tail);

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
          marker.textContent = jtn('chat.toolLiveTail.omittedLines', droppedTotal, { count: droppedTotal }, '… {count} line omitted — full output arrives with the result', '… {count} lines omitted — full output arrives with the result');
          marker.classList.remove('hidden');
        } else {
          marker.classList.add('hidden');
        }
      }
      if (stickyByPane.get(pane) !== false) {
        pane.scrollTop = pane.scrollHeight;
      }
      return true;
    }

    // Append only the new lines to the text node this tail painted last; a new
    // node, or a scrollback trim at the cap, rewrites it whole.
    function paintLines(textNode, tail) {
      const painted = tail.painted;
      const newCount = painted ? tail.totalLines - painted.total : 0;
      const textChild = textNode.firstChild;
      if (painted && painted.node === textNode && painted.droppedLocally === tail.droppedLocally
        && newCount >= 0 && newCount <= tail.lines.length
        && (textChild ? textChild.nodeType === 3 && !textChild.nextSibling : painted.total === 0)) {
        if (newCount > 0) {
          const added = tail.lines.slice(-newCount).join('\n');
          if (textChild) textChild.appendData(`\n${added}`);
          else textNode.textContent = added;
        }
      } else {
        textNode.textContent = tail.lines.join('\n');
      }
      tail.painted = { node: textNode, total: tail.totalLines, droppedLocally: tail.droppedLocally };
    }

    // Writes inside a pane (its text, partial and marker) are the tail's own
    // paint, not a render: they never need a reconcile pass.
    function isOwnPaneMutation(record) {
      return Boolean(record.target?.closest?.('[data-tool-live-output]'));
    }

    function reconcile(records) {
      if (records && records.length && Array.from(records).every(isOwnPaneMutation)) return;
      for (const tail of [...tails.values()]) {
        if (!isVisible(tail)) continue;
        const row = findLiveRow(tail);
        // Only paint a row that does not already show this tail's pane.
        if (!row || findIntactPane(row, tail)) continue;
        paint(row, tail);
      }
    }

    function ensureObserver() {
      if (!tails.size) return;
      const chatTimeline = getChatTimeline();
      if (observer && observedTimeline === chatTimeline) return;
      disconnectObserver();
      const MutationObserverImpl = chatTimeline?.ownerDocument?.defaultView?.MutationObserver;
      if (!chatTimeline || typeof MutationObserverImpl !== 'function') return;
      observer = new MutationObserverImpl(reconcile);
      observedTimeline = chatTimeline;
      // TTL-1: a re-render (view switch, live patch) can return a row to the
      // running state in place, with no child list change to wake us.
      observer.observe(chatTimeline, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-tool-status'],
      });
    }

    function appendChunk(payload) {
      if (disposed) return false;
      const identity = readIdentity(payload);
      if (!identity.callId) return false;
      const hasLines = Array.isArray(payload && payload.lines) && payload.lines.length > 0;
      const hasPartial = Boolean(payload && payload.partial);
      if (!hasLines && !hasPartial) return false;

      // Record FIRST: the tool_use render is async, so early chunks can land
      // before the row exists.
      const tail = getTail(identity);
      recordChunk(tail, payload);
      ensureObserver();
      const row = findLiveRow(tail);
      if (!row || !isVisible(tail)) return false;
      return paint(row, tail);
    }

    function settle(identity) {
      const parsed = readIdentity(identity !== null && typeof identity === 'object' ? identity : { callId: identity });
      if (!parsed.callId) return;
      dropTail(buildTailKey(parsed));
    }

    function settleStream(streamId) {
      const normalizedStreamId = normalizeId(streamId);
      if (!normalizedStreamId) return;
      for (const [key, tail] of [...tails]) {
        if (tail.streamId === normalizedStreamId) dropTail(key);
      }
    }

    function reset() {
      tails.clear();
      disconnectObserver();
    }

    function dispose() {
      disposed = true;
      reset();
    }

    return { appendChunk, settle, settleStream, reset, dispose };
  }

  return { MAX_TAIL_LINES, MAX_TRACKED_CALLS, createToolLiveTail };
});
