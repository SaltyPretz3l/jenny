/* renderer/features/renderer-ide-map-activity-rail.js — the File Map's
 * activity PRESENTER: subscribes to the activity bus, resolves the bus's
 * workspace-relative paths to graph node ids (exact first, then Windows
 * case-insensitive; unresolved paths fall through to a bucket-row prefix
 * match so a write into a gitignored dir still heats its not-mapped row),
 * forwards node-id-native heat/trail to the atlas view, drives the
 * turn-end fade ticker (ONE timer, never per-node), reports turn
 * activity to the controller (layout freeze), and renders the right-edge
 * activity rail: live head, verb-iconed rows (click = reveal in map),
 * touched/edited/outside counts.
 *
 * The rail is CHROME (screen space, viewport child) — content-space
 * painting (pulses, trail steps, heat classes) is the atlas view's job via
 * view.applyActivity. Rail rows for rail-only actions (run_command, greps
 * without a resolvable path) are non-interactive.
 *
 * createMapActivityPresenter(deps):
 *   bus                the shared renderer-ide-map-activity-bus
 *   getSessionId       () => active chat session id (rail shows ONLY it)
 *   view               atlas view (applyActivity/getAllNodeIds/...)
 *   viewportEl         map viewport (rail host + footer bucket rows live here)
 *   escapeHtml, timers (setTimeout/clearTimeout, optional rAF pair)
 *   isHostVisible      () => boolean  false while the map stage is hidden:
 *                      paints are skipped (refresh() on show repaints)
 *   onTurnActiveChange (active) => void   controller layout freeze hook
 *   onRowClick         (nodeId) => void   reveal-in-map
 * → { refresh, setVisible, dispose }
 *
 * Every bus notification (any session) re-evaluates the ACTIVE session's
 * turn state synchronously, so a chat switch mid-turn releases the layout
 * freeze; paints for the active session (or after a session switch) are
 * coalesced to one per animation frame.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapActivityRail = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) { /* unavailable */ }
    }
    return {};
  }

  const toolCallUtils = resolveModule('toolCallUtils', '../chat/tool-call-utils');
  const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');

  const ROW_CAP = 50;
  // Turn-end choreography: hold the finished trail briefly, fade, then clear.
  const FADE_AFTER_MS = 4000;
  const CLEAR_AFTER_MS = 8000;

  const VERB_ICON_KIND = { read: 'Read', edit: 'Edit', search: 'Grep', run: 'Bash', tool: 'Bash' };
  const VERB_LABEL = { read: 'read', edit: 'edit', search: 'search', run: 'run', tool: 'tool' };

  const defaultEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function basenameOf(rel) {
    const s = String(rel || '');
    return s.slice(s.lastIndexOf('/') + 1) || s;
  }

  function isWindowsPlatform(platform) {
    return /^(win|windows)/i.test(String(platform || ''));
  }

  function createMapActivityPresenter(deps) {
    const d = deps || {};
    const bus = d.bus || null;
    const getSessionId = typeof d.getSessionId === 'function' ? d.getSessionId : () => '';
    const view = d.view || null;
    const viewportEl = d.viewportEl || null;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : defaultEscapeHtml;
    const timers = d.timers || globalRef;
    const isHostVisible = typeof d.isHostVisible === 'function' ? d.isHostVisible : () => true;
    const onTurnActiveChange = typeof d.onTurnActiveChange === 'function' ? d.onTurnActiveChange : () => {};
    const onRowClick = typeof d.onRowClick === 'function' ? d.onRowClick : () => {};
    const platform = String(d.platform
      || (typeof navigator !== 'undefined' ? navigator.platform : '')
      || (typeof process !== 'undefined' ? process.platform : ''));

    let disposed = false;
    let visible = true;
    let railEl = null;
    let rowsEl = null;
    let headTitleEl = null;
    let footEl = null;
    let unsubscribe = null;
    let fadeTimerId = null;
    let clearTimerId = null;
    let lastTurnActive = false;
    let expiredSessionId = '';
    let paintedSessionId = String(getSessionId() || '');
    let resolverIds = null;
    let resolver = null;
    let frameQueued = false;
    let frameId = null;
    // One paint per frame: the injected rAF pair, else the window's, else a
    // ~frame timeout.
    const [requestFrame, cancelFrame] = typeof timers.requestAnimationFrame === 'function'
      ? [(fn) => timers.requestAnimationFrame(fn), (id) => timers.cancelAnimationFrame?.(id)]
      : typeof globalRef.requestAnimationFrame === 'function'
        ? [(fn) => globalRef.requestAnimationFrame(fn), (id) => globalRef.cancelAnimationFrame?.(id)]
        : [(fn) => timers.setTimeout(fn, 16), (id) => timers.clearTimeout(id)];

    function doc() {
      return viewportEl && viewportEl.ownerDocument ? viewportEl.ownerDocument : null;
    }

    function iconFor(verb) {
      const kind = VERB_ICON_KIND[verb] || 'Bash';
      if (typeof toolCallUtils.getToolIcon === 'function') {
        return toolCallUtils.getToolIcon(kind);
      }
      return '';
    }

    function ensureRail() {
      const documentRef = doc();
      if (!documentRef || !viewportEl) return null;
      if (railEl && railEl.parentNode === viewportEl) return railEl;
      railEl = documentRef.createElement('div');
      railEl.className = 'ide-map-activity-rail hidden';
      railEl.setAttribute('aria-label', jt('ide.map.activity.label', 'Jenny activity'));
      railEl.innerHTML = ''
        + '<div class="ide-map-activity-rail-head">'
        + '<span class="ide-map-activity-rail-live" aria-hidden="true"></span>'
        + '<span class="ide-map-activity-rail-title">Jenny</span>'
        + '</div>'
        + '<div class="ide-map-activity-rail-rows" role="list"></div>'
        + '<div class="ide-map-activity-rail-foot"></div>';
      rowsEl = railEl.querySelector('.ide-map-activity-rail-rows');
      headTitleEl = railEl.querySelector('.ide-map-activity-rail-title');
      footEl = railEl.querySelector('.ide-map-activity-rail-foot');
      railEl.addEventListener('click', handleRailClick);
      viewportEl.appendChild(railEl);
      return railEl;
    }

    function handleRailClick(event) {
      const rowEl = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-activity-node]')
        : null;
      if (rowEl && rowEl.dataset.activityNode) {
        onRowClick(rowEl.dataset.activityNode);
      }
    }

    // rel -> node id: exact, then Windows-only case-insensitive fallback for
    // tool inputs that case-mismatch the scan. O(nodes) to build, so
    // resolverFor() caches it per rendered graph (the view hands back the
    // same id Set until its next render).
    function buildResolver(nodeIds) {
      const ids = nodeIds || (view && typeof view.getAllNodeIds === 'function' ? view.getAllNodeIds() : new Set());
      const lower = isWindowsPlatform(platform) ? new Map() : null;
      if (lower) {
        for (const id of ids) lower.set(String(id).toLowerCase(), id);
      }
      return (rel) => {
        if (ids.has(rel)) return rel;
        return lower ? lower.get(String(rel).toLowerCase()) || null : null;
      };
    }

    function resolverFor() {
      const ids = view && typeof view.getAllNodeIds === 'function' ? view.getAllNodeIds() : new Set();
      if (!resolver || ids !== resolverIds) {
        resolverIds = ids;
        resolver = buildResolver(ids);
      }
      return resolver;
    }

    function applyBucketHeat(unresolved) {
      if (!viewportEl || typeof viewportEl.querySelectorAll !== 'function') return;
      const chips = viewportEl.querySelectorAll('[data-map-bucket]');
      for (const chip of chips) {
        const key = String(chip.dataset.mapBucket || '');
        const hot = key !== '' && unresolved.some((rel) => rel === key || rel.startsWith(`${key}/`));
        chip.classList.toggle('is-heat', hot);
      }
    }

    function rowMarkup(step, resolvedId) {
      const name = step.rel ? basenameOf(step.rel) : step.label;
      const count = step.count > 1 ? ` ×${step.count}` : '';
      const inner = ''
        + `<span class="ide-map-activity-row-icon" aria-hidden="true">${iconFor(step.verb)}</span>`
        + `<span class="ide-map-activity-row-name">${escapeHtml(name)}${count}</span>`
        + `<span class="ide-map-activity-row-verb">${escapeHtml(VERB_LABEL[step.verb] || step.verb)}</span>`;
      const editCls = step.verb === 'edit' ? ' is-edit' : '';
      if (resolvedId && typeof actionButton === 'function') {
        // Interactive rows go through the inventory button primitive.
        return actionButton({
          plain: true,
          className: `ide-map-activity-row${editCls}`,
          ariaLabel: jt('ide.map.activity.revealFile', 'Reveal {file} in the map', { file: step.rel }),
          title: jt('ide.map.activity.revealFile', 'Reveal {file} in the map', { file: step.rel }),
          dataset: { 'activity-node': resolvedId },
          trustedHtml: inner,
        });
      }
      return `<div class="ide-map-activity-row is-static${editCls}" role="listitem">${inner}</div>`;
    }

    function clearTimersPending() {
      if (fadeTimerId != null) { timers.clearTimeout(fadeTimerId); fadeTimerId = null; }
      if (clearTimerId != null) { timers.clearTimeout(clearTimerId); clearTimerId = null; }
    }

    function clearPresentation(rail) {
      if (rail) rail.classList.add('hidden');
      view?.applyActivity?.({ heat: new Map(), editedIds: new Set(), trail: [], faded: false });
      applyBucketHeat([]);
    }

    function scheduleTurnEndChoreo(sessionId) {
      clearTimersPending();
      fadeTimerId = timers.setTimeout(() => {
        fadeTimerId = null;
        paint({ faded: true });
      }, FADE_AFTER_MS);
      clearTimerId = timers.setTimeout(() => {
        clearTimerId = null;
        if (String(getSessionId() || '') !== sessionId) return;
        expiredSessionId = sessionId;
        clearPresentation(railEl);
      }, CLEAR_AFTER_MS);
    }

    function snapshotFor(sessionId) {
      return bus && typeof bus.getState === 'function' ? bus.getState(sessionId) : null;
    }

    // Layout-freeze bookkeeping for the ACTIVE session; independent of
    // painting so it also runs while the map is hidden.
    function syncTurnState(sessionId) {
      const snapshot = snapshotFor(sessionId);
      const live = expiredSessionId !== sessionId && Boolean(snapshot && snapshot.turnActive);
      if (live === lastTurnActive) return;
      lastTurnActive = live;
      onTurnActiveChange(live);
      if (live) clearTimersPending();
      else if (snapshot && (snapshot.trail.length || snapshot.heat.size)) scheduleTurnEndChoreo(sessionId);
    }

    function schedulePaint() {
      if (disposed || frameQueued) return;
      frameQueued = true;
      const id = requestFrame(() => {
        frameQueued = false;
        frameId = null;
        paint();
      });
      if (frameQueued) frameId = id;
    }

    function paint(opts) {
      if (disposed) return;
      const sessionId = String(getSessionId() || '');
      syncTurnState(sessionId);
      if (disposed || !isHostVisible()) return;
      paintedSessionId = sessionId;
      const rail = ensureRail();
      const snapshot = snapshotFor(sessionId);
      if (expiredSessionId === sessionId
        || !snapshot || (!snapshot.trail.length && !snapshot.heat.size && !snapshot.turnActive)) {
        clearPresentation(rail);
        return;
      }
      const faded = opts && opts.faded === true;
      const resolve = resolverFor();

      // Resolve heat + edited to node ids; collect unresolved for buckets.
      const heatById = new Map();
      const unresolved = [];
      for (const [rel, entry] of snapshot.heat) {
        const id = resolve(rel);
        if (id) heatById.set(id, entry);
        else unresolved.push(rel);
      }
      const editedIds = new Set();
      for (const rel of snapshot.editedIds) {
        const id = resolve(rel);
        if (id) editedIds.add(id);
      }
      // Trail: resolved steps only, renumbered in map order.
      const trail = [];
      for (const step of snapshot.trail) {
        if (!step.rel) continue;
        const id = resolve(step.rel);
        if (id) trail.push({ id, n: trail.length + 1, count: step.count });
      }
      view?.applyActivity?.({ heat: heatById, editedIds, trail, faded });
      applyBucketHeat(unresolved);

      // Rail chrome.
      if (rail) {
        rail.classList.toggle('hidden', !visible);
        rail.classList.toggle('is-live', snapshot.turnActive);
        if (headTitleEl) {
          headTitleEl.textContent = snapshot.pendingApproval
            ? jt('ide.map.activity.waitingForApproval', 'Jenny · waiting for approval')
            : (snapshot.turnActive ? jt('ide.map.activity.working', 'Jenny · working') : jt('ide.map.activity.finished', 'Jenny · turn finished'));
        }
        if (rowsEl) {
          const steps = snapshot.trail.slice(-ROW_CAP).reverse();
          rowsEl.innerHTML = steps
            .map((step) => rowMarkup(step, step.rel ? resolve(step.rel) : null))
            .join('');
        }
        if (footEl) {
          const c = snapshot.counts;
          const outside = c.outside > 0;
          footEl.textContent = outside ? jt('ide.map.activity.countsWithOutside', '{touched} touched · {edited} edited · {outside} outside workspace', c) : jt('ide.map.activity.counts', '{touched} touched · {edited} edited', c);
        }
      }
    }

    // Re-apply after a view re-render (renderAtlas wipes classes/overlay),
    // a session switch, or the map stage becoming visible.
    function refresh() {
      paint();
    }

    // The Activity layer chip gates the rail's visibility, not its state.
    function setVisible(next) {
      visible = next !== false;
      if (railEl) railEl.classList.toggle('hidden', !visible);
      if (visible) paint();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      clearTimersPending();
      if (frameId != null) cancelFrame(frameId);
      frameId = null;
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_error) { /* already gone */ }
        unsubscribe = null;
      }
      if (railEl) {
        railEl.removeEventListener('click', handleRailClick);
        railEl.remove();
      }
      railEl = null;
      rowsEl = null;
      headTitleEl = null;
      footEl = null;
    }

    if (bus && typeof bus.subscribe === 'function') {
      unsubscribe = bus.subscribe((changedSessionId) => {
        const sessionId = String(getSessionId() || '');
        const ownEvent = String(changedSessionId || '') === sessionId;
        if (ownEvent && expiredSessionId === sessionId) expiredSessionId = '';
        syncTurnState(sessionId);
        if (ownEvent || sessionId !== paintedSessionId) schedulePaint();
      });
    }

    return {
      refresh,
      setVisible,
      dispose,
      _internals: { buildResolver },
    };
  }

  return { createMapActivityPresenter };
});
