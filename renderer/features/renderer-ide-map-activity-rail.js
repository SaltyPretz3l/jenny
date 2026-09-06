/* renderer/features/renderer-ide-map-activity-rail.js — the File Map's
 * activity PRESENTER: subscribes to the activity bus, resolves the bus's
 * workspace-relative paths to graph node ids (exact first, then Windows
 * case-insensitive; unresolved paths fall through to a bucket-chip prefix
 * match so a write into a gitignored dir still heats its rollup chip),
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
 *   viewportEl         map viewport (rail host + bucket chips live here)
 *   escapeHtml, timers, appendClientLog
 *   onTurnActiveChange (active) => void   controller layout freeze hook
 *   onRowClick         (nodeId) => void   reveal-in-map
 * → { refresh, setVisible, dispose }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapActivityRail = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

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
  const inventoryButton = resolveModule('inventoryActionButton', '../inventory/action-button');
  const actionButton = typeof inventoryButton === 'function'
    ? inventoryButton
    : inventoryButton.actionButton || inventoryButton.default || null;

  const ROW_CAP = 50;
  // Turn-end choreography: hold the finished trail briefly, fade, then clear.
  const FADE_AFTER_MS = 4000;
  const CLEAR_AFTER_MS = 8000;

  const VERB_ICON_KIND = { read: 'Read', edit: 'Edit', search: 'Grep', run: 'Bash', tool: 'Bash' };
  const VERB_LABEL = { read: 'read', edit: 'edit', search: 'search', run: 'run', tool: 'tool' };

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function basenameOf(rel) {
    const s = String(rel || '');
    return s.slice(s.lastIndexOf('/') + 1) || s;
  }

  function createMapActivityPresenter(deps) {
    const d = deps || {};
    const bus = d.bus || null;
    const getSessionId = typeof d.getSessionId === 'function' ? d.getSessionId : () => '';
    const view = d.view || null;
    const viewportEl = d.viewportEl || null;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : defaultEscapeHtml;
    const timers = d.timers || globalRef;
    const onTurnActiveChange = typeof d.onTurnActiveChange === 'function' ? d.onTurnActiveChange : () => {};
    const onRowClick = typeof d.onRowClick === 'function' ? d.onRowClick : () => {};

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
      railEl.setAttribute('aria-label', 'Jenny activity');
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

    // rel -> node id: exact, then case-insensitive (Windows tool inputs may
    // case-mismatch the scan). Index rebuilt per paint — O(nodes), and
    // paints are per-tool-event (low frequency), never per-frame.
    function buildResolver() {
      const ids = view && typeof view.getAllNodeIds === 'function' ? view.getAllNodeIds() : new Set();
      const lower = new Map();
      for (const id of ids) lower.set(String(id).toLowerCase(), id);
      return (rel) => {
        if (ids.has(rel)) return rel;
        return lower.get(String(rel).toLowerCase()) || null;
      };
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
          ariaLabel: `Reveal ${step.rel} in the map`,
          title: `Reveal ${step.rel} in the map`,
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

    function paint(opts) {
      if (disposed) return;
      const rail = ensureRail();
      const sessionId = String(getSessionId() || '');
      const snapshot = bus && typeof bus.getState === 'function' ? bus.getState(sessionId) : null;
      if (expiredSessionId === sessionId) {
        clearPresentation(rail);
        return;
      }
      if (!snapshot || (!snapshot.trail.length && !snapshot.heat.size && !snapshot.turnActive)) {
        if (rail) rail.classList.add('hidden');
        view?.applyActivity?.({ heat: new Map(), editedIds: new Set(), trail: [], faded: false });
        applyBucketHeat([]);
        if (lastTurnActive) { lastTurnActive = false; onTurnActiveChange(false); }
        return;
      }
      const faded = opts && opts.faded === true;
      const resolve = buildResolver();

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
            ? 'Jenny · waiting for approval'
            : (snapshot.turnActive ? 'Jenny · working' : 'Jenny · turn finished');
        }
        if (rowsEl) {
          const steps = snapshot.trail.slice(-ROW_CAP).reverse();
          rowsEl.innerHTML = steps
            .map((step) => rowMarkup(step, step.rel ? resolve(step.rel) : null))
            .join('');
        }
        if (footEl) {
          const c = snapshot.counts;
          const outside = c.outside > 0 ? ` · ${c.outside} outside workspace` : '';
          footEl.textContent = `${c.touched} touched · ${c.edited} edited${outside}`;
        }
      }

      if (snapshot.turnActive !== lastTurnActive) {
        lastTurnActive = snapshot.turnActive;
        onTurnActiveChange(snapshot.turnActive);
        if (!snapshot.turnActive) scheduleTurnEndChoreo(sessionId);
        else clearTimersPending();
      }
    }

    // Re-apply after a view re-render (renderAtlas wipes classes/overlay).
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
      unsubscribe = bus.subscribe((sessionId) => {
        if (String(sessionId || '') === String(getSessionId() || '')) {
          if (expiredSessionId === String(sessionId || '')) expiredSessionId = '';
          paint();
        }
      });
    }

    return {
      refresh,
      setVisible,
      dispose,
      _internals: { paint, buildResolver, ROW_CAP, FADE_AFTER_MS, CLEAR_AFTER_MS },
    };
  }

  return { createMapActivityPresenter };
});
