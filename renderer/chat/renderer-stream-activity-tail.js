/* renderer/chat/renderer-stream-activity-tail.js - Follow Jenny: the last lines of a file arriving, under the chat's writing row (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamActivityTail = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || ((k, d, p) => p ? d.replace(/\{(\w+)\}/g, (m, n) => String(p[n] ?? m)) : d);
  /* While the model writes a file, the follow store holds one record per call.
     This module draws two things at that call's activity row: the last lines of
     the arriving text under it and a "Watch in Workspace" link at its end. It
     acts only when the store notifies or sync() is called. The row can be
     recreated at any time, so every pass re-finds it and puts the nodes back. */

  const TAIL_LINES = 4;
  const TAIL_LINE_MAX_CHARS = 240;
  const ROW_ATTR = 'data-turn-activity-row';
  const TAIL_ATTR = 'data-turn-activity-tail';
  const WATCH_ATTR = 'data-turn-activity-watch';

  // The text that is arriving right now: a write's content, or an edit's last
  // new text once it started and its old text before.
  function getArrivingText(call) {
    if (!call) return '';
    if (call.mode === 'edit') {
      const edits = Array.isArray(call.edits) ? call.edits : [];
      const last = edits[edits.length - 1];
      if (!last) return '';
      const text = last.newStarted ? last.newText : last.oldText;
      return text == null ? '' : String(text);
    }
    return call.content == null ? '' : String(call.content);
  }

  // The last `count` lines of `text`, newest last, each with the offset it starts
  // at. Walks back from the end so a large file is never split on every fragment.
  function lastLines(text, count, maxChars) {
    if (!text) return [];
    let pos = text.endsWith('\n') ? text.length - 1 : text.length;
    const lines = [];
    while (lines.length < count) {
      const start = pos <= 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
      let end = pos;
      if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
      lines.unshift({ at: start, text: text.slice(start, Math.min(end, start + maxChars)) });
      if (start === 0) break;
      pos = start - 1;
    }
    return lines;
  }

  function isRowOf(row, timeline, streamId) {
    return Boolean(row) && row.isConnected && row.getAttribute(ROW_ATTR) === streamId && timeline.contains(row);
  }

  // The stream id is compared as a value, so it never has to be quoted into a selector.
  function findRow(timeline, streamId, known) {
    if (typeof timeline?.querySelectorAll !== 'function') return null;
    if (isRowOf(known, timeline, streamId)) return known;
    for (const row of timeline.querySelectorAll(`[${ROW_ATTR}]`)) {
      if (row.getAttribute(ROW_ATTR) === streamId) return row;
    }
    return null;
  }

  function isShown(call, workspaceActive) {
    return Boolean(call) && call.phase === 'arriving' && call.source === 'stream'
      && call.authoritative !== true && !workspaceActive;
  }

  function createStreamActivityTail({ store, getTimeline, isWorkspaceActive, onWatch, actionButton } = {}) {
    const entries = new Map(); // callId -> { row, tail, link }: the row last drawn under and the nodes added for that call
    const roots = new Set(); // transcript roots that carry the delegated click listener
    let disposed = false;
    let unsubscribe = null;

    function onClick(event) {
      if (disposed) return;
      const button = event.target?.closest?.(`[${WATCH_ATTR}]`);
      if (!button) return;
      const call = store?.getCall?.(button.getAttribute(WATCH_ATTR));
      if (call) onWatch?.(call);
    }

    function listenOn(timeline) {
      if (roots.has(timeline)) return;
      for (const root of roots) { // a transcript that left the page takes its listener with it
        if (root.isConnected) continue;
        root.removeEventListener('click', onClick);
        roots.delete(root);
      }
      roots.add(timeline);
      timeline.addEventListener('click', onClick);
    }

    function makeLink(doc, call) {
      const holder = doc.createElement('span');
      holder.innerHTML = actionButton({
        plain: true,
        className: 'turn-activity-watch',
        label: jt('chat.follow.watch', 'Watch in Workspace'),
        title: jt('chat.follow.watchTitle', 'Open Workspace and show the file arriving'),
        dataset: { 'turn-activity-watch': call.callId },
      });
      return holder.firstElementChild;
    }

    function makeTail(doc, call) {
      const node = doc.createElement('div');
      node.className = 'turn-activity-tail';
      node.setAttribute(TAIL_ATTR, String(call.callId));
      node.setAttribute('aria-hidden', 'true');
      return node;
    }

    function dropNodes(callId) {
      const entry = entries.get(callId);
      if (!entry) return;
      entries.delete(callId);
      if (entry.tail) entry.tail.remove();
      if (entry.link) entry.link.remove();
    }

    // A line keeps its span for as long as it shows (its start offset is its identity), so a
    // new line is one new span at the end: the CSS slides it in and the lines above move up.
    function writeLines(tail, lines) {
      const first = lines.length ? lines[0].at : -1;
      while (tail.firstElementChild && tail.firstElementChild.lineAt !== first) tail.firstElementChild.remove();
      for (let i = 0; i < lines.length; i += 1) {
        let span = tail.children[i];
        if (span && span.lineAt !== lines[i].at) {
          while (tail.children.length > i) tail.lastElementChild.remove();
          span = null;
        }
        if (!span) {
          span = tail.appendChild(tail.ownerDocument.createElement('span'));
          span.lineAt = lines[i].at;
        }
        if (span.textContent !== lines[i].text) span.textContent = lines[i].text;
      }
      while (tail.children.length > lines.length) tail.lastElementChild.remove();
    }

    function draw(call) {
      const callId = String(call.callId);
      const timeline = getTimeline ? getTimeline(call) : null;
      const row = findRow(timeline, String(call.streamId), entries.get(callId)?.row);
      if (!row) {
        dropNodes(callId);
        return;
      }
      const doc = row.ownerDocument;
      listenOn(timeline);
      // Two file calls in one reply share the row: the newest one has it.
      for (const [otherId, other] of entries) {
        if (otherId !== callId && other.row === row) dropNodes(otherId);
      }
      const entry = entries.get(callId) || { row: null, tail: null, link: null };
      entry.row = row;
      entries.set(callId, entry);

      // Link: the row's last child; one per row.
      if (!entry.link) entry.link = makeLink(doc, call);
      if (!entry.link) {
        entries.delete(callId);
        return;
      }
      for (const stray of row.querySelectorAll(`[${WATCH_ATTR}]`)) {
        if (stray !== entry.link) stray.remove();
      }
      if (entry.link.parentNode !== row || row.lastChild !== entry.link) row.appendChild(entry.link);

      // Tail: the row's next sibling; gone once the file is too large to show live.
      if (call.tooLarge === true) {
        if (entry.tail) entry.tail.remove();
        entry.tail = null;
        return;
      }
      if (!entry.tail) entry.tail = makeTail(doc, call);
      if (row.nextSibling !== entry.tail) row.after(entry.tail);
      // One line more than shows: it is clipped above the four, where a line slides out.
      writeLines(entry.tail, lastLines(getArrivingText(call), TAIL_LINES + 1, TAIL_LINE_MAX_CHARS));
    }

    function update(call) {
      if (disposed || !call) return;
      if (isShown(call, isWorkspaceActive ? isWorkspaceActive() : false)) draw(call);
      else dropNodes(String(call.callId));
    }

    function sync() {
      if (disposed) return;
      for (const call of store?.listCalls?.() || []) update(call);
    }

    function onNotify(event) {
      if (disposed || !event || !event.call) return;
      if (event.type === 'removed') dropNodes(String(event.call.callId));
      else update(event.call);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      for (const callId of [...entries.keys()]) dropNodes(callId);
      for (const timeline of roots) timeline.removeEventListener('click', onClick);
      roots.clear();
    }

    unsubscribe = store?.subscribe?.(onNotify);
    return { sync, dispose };
  }

  return { createStreamActivityTail, getArrivingText, TAIL_LINES, TAIL_LINE_MAX_CHARS };
});
