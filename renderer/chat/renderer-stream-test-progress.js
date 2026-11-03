(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-tool-test-summary'));
    return;
  }
  root.rendererStreamTestProgress = factory(root.rendererToolTestSummary);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (summary) {
  'use strict';
  /* Live progress of a running test command (row 96): tool_test_progress events
     paint a bar, a counts line, the per-file grid and the failures under the
     run_command row, and its header shows the %. Like the live output tail these
     events are EPHEMERAL: this module patches the DOM directly, never the row
     model or render cache. A timeline observer repaints a row a re-render
     replaced; the tool_result render shows the finished record (from
     metadata.test_summary) and settle() removes the live block. */

  // Interrupted turns may never settle a call: keep only the newest few.
  const MAX_TRACKED_RUNS = 4;
  const KEY_SEPARATOR = '\u001f';
  const LIVE_STATUSES = new Set(['running', 'executing']);
  const SAFE_ID = /^[\w.:-]+$/;

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  function readIdentity(source) {
    const payload = source || {};
    return {
      sessionId: normalizeId(payload.sessionId || payload.session_id),
      streamId: normalizeId(payload.streamId || payload.stream_id),
      callId: normalizeId(payload.callId || payload.tool_call_id),
    };
  }

  function findLiveRow(timeline, callId) {
    const rows = SAFE_ID.test(callId)
      ? timeline.querySelectorAll(`.tool-call-row--minimal[data-tool-call-id="${callId}"]`)
      : [...timeline.querySelectorAll('.tool-call-row--minimal[data-tool-call-id]')].filter((row) => row.getAttribute('data-tool-call-id') === callId);
    const live = [...rows].filter((row) => LIVE_STATUSES.has(row.getAttribute('data-tool-status')));
    return live[live.length - 1] || null;
  }

  function ensureBlock(row) {
    let block = row.querySelector(':scope > .tool-test-progress[data-test-progress-state="live"]');
    if (block) return block;
    const doc = row.ownerDocument;
    block = doc.createElement('div');
    block.className = 'tool-test-progress';
    block.setAttribute('data-test-progress-state', 'live');
    block.setAttribute('data-grid-open', 'true');
    block.innerHTML = '<div data-test-progress-slot="bar"></div>'
      + '<div class="tool-test-progress-line"><span data-test-progress-slot="counts"></span><span class="tool-test-progress-links" data-test-progress-slot="links"></span></div>'
      + '<div class="tool-test-progress-grid-wrap" data-test-progress-slot="grid"></div>'
      + '<div data-test-progress-slot="fails"></div>';
    const header = row.querySelector(':scope > .tool-call-row-header');
    if (header) header.after(block);
    else row.prepend(block);
    return block;
  }

  function paintMeta(row, data) {
    const cluster = row.querySelector(':scope > .tool-call-row-header .tool-call-status-cluster');
    let meta = cluster?.querySelector('[data-test-progress-meta]') || null;
    if (data.percent == null) {
      meta?.remove();
      return;
    }
    if (!cluster) return;
    if (!meta) {
      meta = row.ownerDocument.createElement('span');
      meta.className = 'tool-call-meta';
      meta.setAttribute('data-test-progress-meta', '');
      cluster.insertBefore(meta, cluster.querySelector('.tool-call-status'));
    }
    const text = summary.percentText(data.percent);
    if (meta.textContent !== text) meta.textContent = text;
  }

  function paintBar(slot, data) {
    if (data.percent == null) {
      if (slot.firstChild) slot.textContent = '';
      return;
    }
    const failures = data.failures || [];
    const fill = slot.querySelector('.inv-progress-fill');
    if (!fill || slot.querySelectorAll('.tool-test-progress-tick').length !== failures.length) {
      slot.innerHTML = summary.barHtml(data.percent, failures);
      return;
    }
    // Keep the element so the fill's width transition runs between updates.
    fill.style.setProperty('--progress', `${Math.min(100, Math.max(0, data.percent)).toFixed(2)}%`);
    slot.firstElementChild.setAttribute('aria-valuenow', String(Math.floor(data.percent)));
  }

  function paintLinks(slot, row, data, block) {
    const outputOpen = row.getAttribute('data-expanded') === 'true';
    const key = `${data.grid ? 1 : 0}:${block.getAttribute('data-grid-open')}:${outputOpen}`;
    if (slot.getAttribute('data-painted') === key) return;
    slot.setAttribute('data-painted', key);
    slot.innerHTML = (data.grid ? summary.linkHtml('grid', summary.gridToggleLabel(block.getAttribute('data-grid-open') === 'true')) : '')
      + summary.linkHtml('output', summary.outputToggleLabel(outputOpen));
  }

  function paintGrid(slot, run) {
    const { grid, unit, total } = run.data;
    const cells = slot.querySelector('.tool-test-progress-grid');
    if (!grid) {
      if (slot.firstChild) slot.textContent = '';
      return;
    }
    // The stage is part of the key: a new stage's same-size grid must not keep old titles.
    const shape = `${unit}:${grid.group}:${Number(run.data.stage) || 0}`;
    if (!cells || cells.children.length !== grid.count || cells.getAttribute('data-px') !== String(grid.px)
      || slot.getAttribute('data-unit') !== shape) {
      slot.innerHTML = summary.gridHtml(unit, grid, total, run.labels);
      slot.setAttribute('data-unit', shape);
      slot.__states = grid.states;
      slot.__labelled = run.labels.length;
      return;
    }
    // Only the cells whose state changed are touched.
    const previous = slot.__states || '';
    const children = cells.children;
    for (let index = 0; index < grid.count; index += 1) {
      if (previous[index] !== grid.states[index]) {
        children[index].setAttribute('data-s', summary.CELL_STATES[grid.states[index]] || '');
      }
    }
    slot.__states = grid.states;
    for (let index = slot.__labelled || 0; index < Math.min(run.labels.length, grid.count); index += 1) {
      if (run.labels[index]) children[index].setAttribute('title', run.labels[index]);
    }
    slot.__labelled = run.labels.length;
  }

  function paintFails(slot, data) {
    const failures = data.failures || [];
    if (slot.getAttribute('data-painted') === String(failures.length)) return;
    slot.setAttribute('data-painted', String(failures.length));
    slot.innerHTML = summary.failuresHtml(failures);
  }

  function paint(row, run) {
    const block = ensureBlock(row);
    const slot = (name) => block.querySelector(`[data-test-progress-slot="${name}"]`);
    // The output link follows the row's expansion, which changes without a new event.
    paintLinks(slot('links'), row, run.data, block);
    const metaShown = run.data.percent == null || row.querySelector('[data-test-progress-meta]');
    // Painting mutates the timeline and re-enters the observer: skip a row that shows this version.
    if (block.getAttribute('data-painted-version') === String(run.version) && metaShown) return;
    block.setAttribute('data-painted-version', String(run.version));
    paintMeta(row, run.data);
    paintBar(slot('bar'), run.data);
    const counts = summary.countsText(run.data);
    if (slot('counts').innerHTML !== counts) slot('counts').innerHTML = counts;
    paintGrid(slot('grid'), run);
    paintFails(slot('fails'), run.data);
  }

  // This module's own paint (the block, its slots, the header %) must not re-enter the observer.
  const OWN_NODES = '.tool-test-progress, [data-test-progress-meta]';
  function isOwnMutation(record) {
    if (record.target?.closest?.(OWN_NODES)) return true;
    return record.type === 'childList' && !record.removedNodes.length && [...record.addedNodes].every((node) => node.matches?.(OWN_NODES));
  }

  function removeLive(row) {
    row.querySelector(':scope > .tool-test-progress[data-test-progress-state="live"]')?.remove();
    row.querySelector('[data-test-progress-meta]')?.remove();
  }

  function createToolTestProgress(options = {}) {
    const { getChatTimeline = () => null, maxTrackedRuns = MAX_TRACKED_RUNS } = options;
    // key (session + stream + call id) -> latest progress of that run.
    const runs = new Map();
    let observer = null;
    let observedTimeline = null;
    let frame = 0;
    let disposed = false;
    let paintVersion = 0;

    function disconnectObserver() {
      if (!observer) return;
      observer.disconnect();
      observer = null;
      observedTimeline = null;
    }

    function reconcile() {
      frame = 0;
      const timeline = getChatTimeline();
      if (!runs.size || !timeline || typeof timeline.querySelectorAll !== 'function') return;
      const byCall = new Map();
      for (const run of runs.values()) byCall.set(run.callId, run);
      for (const run of byCall.values()) {
        // The row is remembered: an event costs a timeline-wide query only after a re-render or status flip.
        if (!run.row?.isConnected || !LIVE_STATUSES.has(run.row.getAttribute('data-tool-status'))) run.row = findLiveRow(timeline, run.callId);
        if (run.row) paint(run.row, run);
      }
    }

    // One paint per frame however fast events arrive.
    function schedule() {
      const win = getChatTimeline()?.ownerDocument?.defaultView;
      if (frame) return;
      if (win && typeof win.requestAnimationFrame === 'function') frame = win.requestAnimationFrame(reconcile);
      else reconcile();
    }

    function ensureObserver() {
      const timeline = getChatTimeline();
      if (observer && observedTimeline === timeline) return;
      disconnectObserver();
      const MutationObserverImpl = timeline?.ownerDocument?.defaultView?.MutationObserver;
      if (!timeline || typeof MutationObserverImpl !== 'function') return;
      // A re-rendered row (new nodes) or a row whose status flipped needs its block back.
      observer = new MutationObserverImpl((records) => {
        if (records.some((record) => (record.addedNodes.length || record.type === 'attributes') && !isOwnMutation(record))) schedule();
      });
      observedTimeline = timeline;
      observer.observe(timeline, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tool-status', 'data-expanded'] });
    }

    function apply(payload) {
      if (disposed || !payload || payload.type !== 'tool_test_progress') return false;
      const identity = readIdentity(payload);
      if (!identity.callId) return false;
      const key = [identity.sessionId, identity.streamId, identity.callId].join(KEY_SEPARATOR);
      // A newer stream of the same session supersedes an older run with a reused call id.
      for (const [otherKey, other] of [...runs]) {
        if (otherKey !== key && other.sessionId === identity.sessionId && other.callId === identity.callId) runs.delete(otherKey);
      }
      const previous = runs.get(key);
      // Batches leave the sidecar from several threads: an older one must not paint over a newer one.
      if (previous && (Number(payload.sequence) || 0) < (Number(previous.data.sequence) || 0)) return false;
      // A multi-stage command (run_ci.py, test:affected) moved on: drop the old stage's grid labels.
      const sameStage = previous && (Number(previous.data.stage) || 0) === (Number(payload.stage) || 0);
      const labels = sameStage ? previous.labels : [];
      // The hosted browser wire (server/backend-events.js) is snake_case; the desktop event is camelCase.
      const data = { ...payload, totalUnit: payload.totalUnit ?? payload.total_unit, elapsedMs: payload.elapsedMs ?? payload.elapsed_ms,
        etaMs: payload.etaMs ?? payload.eta_ms, labelsFrom: payload.labelsFrom ?? payload.labels_from };
      if (Array.isArray(data.labels) && Number.isSafeInteger(data.labelsFrom)) {
        data.labels.forEach((label, offset) => { labels[data.labelsFrom + offset] = String(label || ''); });
      }
      runs.delete(key);
      runs.set(key, { ...identity, version: paintVersion += 1, data, labels, row: previous ? previous.row : null });
      while (runs.size > maxTrackedRuns) runs.delete(runs.keys().next().value);
      ensureObserver();
      schedule();
      return true;
    }

    function dropWhere(match) {
      const timeline = getChatTimeline();
      for (const [key, run] of [...runs]) {
        if (!match(run)) continue;
        runs.delete(key);
        const row = timeline && typeof timeline.querySelectorAll === 'function'
          ? [...timeline.querySelectorAll('.tool-call-row--minimal[data-tool-call-id]')].filter((node) => node.getAttribute('data-tool-call-id') === run.callId)
          : [];
        row.forEach(removeLive);
      }
      if (!runs.size) disconnectObserver();
    }

    function settle(identity) {
      const parsed = readIdentity(identity !== null && typeof identity === 'object' ? identity : { callId: identity });
      dropWhere((run) => run.callId === parsed.callId && (!parsed.streamId || run.streamId === parsed.streamId));
    }

    function settleStream(streamId) {
      const normalized = normalizeId(streamId);
      dropWhere((run) => run.streamId === normalized);
    }

    function dispose() {
      disposed = true;
      runs.clear();
      disconnectObserver();
    }

    return { apply, settle, settleStream, dispose };
  }

  return { createToolTestProgress };
});
