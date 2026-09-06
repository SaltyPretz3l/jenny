/* renderer/features/renderer-ide-map-findings.js - the Workspace File Map's
 * findings chip bar (P2 scope). Renders a compact row of inventory chips
 * ("hubs N", "cycles N", "orphans N") into hostEl from a real
 * `graph.findings` shape produced by services/workspace-file-map-engine.js
 * `findings()`:
 *   { hubs: [id, ...], cycles: [[id, id, ...], ...], orphans: [id, ...] }
 * (cycles is an ARRAY OF ARRAYS — one entry per distinct cycle, each an
 * ordered list of node ids in that cycle).
 *
 * Clicking a chip toggles a highlight: view.applyFindingHighlight(kind, ids)
 * rings the implicated nodes (kind ∈ 'hub'|'cycle'|'orphan'; 'hubs' chip ->
 * 'hub', 'cycles' chip -> 'cycle' over the union of every cycle's ids,
 * 'orphans' chip -> 'orphan'), announces a summary via an aria-live region,
 * and frames the implicated nodes by computing their bounding box from
 * `view.getNodePosition(id)` and calling
 * `transform.fitToContent(bounds)`. Clicking the SAME chip again (or a
 * different chip) clears the previous highlight first — only one kind is
 * ever highlighted at a time, mirroring the plan's "clicking again clears".
 *
 * ── Public interface — createMapFindings({hostEl, view, transform}) ────────
 *   .update(graph)   Rebuilds the chip bar from graph.findings. Clears any
 *                    active highlight (the previous selection may no longer
 *                    be valid against the new graph).
 *   .clear()         Empties hostEl and clears the active highlight (does
 *                    NOT touch view state — callers that also want the ring
 *                    cleared should still hold a reference and call
 *                    view.applyFindingHighlight(kind, []) themselves, but in
 *                    practice update()/dispose() always follow this with a
 *                    fresh state).
 *   .dispose()       Removes listeners + clears hostEl. Idempotent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapFindings = factory();
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
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  const chip = resolveModule('inventoryChip', '../inventory/chip');

  // Chip definitions in display order. `kind` is the view's highlight kind;
  // `idsOf(findings)` extracts the flat list of implicated node ids for both
  // the highlight call and the aria-live summary/bounds computation.
  const CHIP_DEFS = [
    {
      id: 'hubs',
      kind: 'hub',
      label: 'hubs',
      singular: 'hub',
      idsOf: (findings) => (Array.isArray(findings.hubs) ? findings.hubs.slice() : []),
    },
    {
      id: 'cycles',
      kind: 'cycle',
      label: 'cycles',
      singular: 'cycle',
      // cycles is an array of arrays (one per distinct cycle); the chip count
      // is the number of distinct cycles, but the highlight/bounds ids are the
      // UNION of every id across every cycle.
      idsOf: (findings) => {
        const cycles = Array.isArray(findings.cycles) ? findings.cycles : [];
        const out = new Set();
        for (const cyc of cycles) {
          if (!Array.isArray(cyc)) continue;
          for (const id of cyc) out.add(id);
        }
        return Array.from(out);
      },
      countOf: (findings) => (Array.isArray(findings.cycles) ? findings.cycles.length : 0),
    },
    {
      id: 'orphans',
      kind: 'orphan',
      label: 'orphans',
      singular: 'orphan',
      idsOf: (findings) => (Array.isArray(findings.orphans) ? findings.orphans.slice() : []),
    },
  ];

  function countFor(def, findings) {
    if (typeof def.countOf === 'function') {
      return def.countOf(findings);
    }
    return def.idsOf(findings).length;
  }

  function createMapFindings(deps) {
    const d = deps || {};
    const hostEl = d.hostEl || null;
    const view = d.view || {};
    const transform = d.transform || {};
    let disposed = false;
    let currentFindings = { hubs: [], cycles: [], orphans: [] };
    let activeChipId = null;
    let liveRegionEl = null;

    function doc() {
      return hostEl && hostEl.ownerDocument ? hostEl.ownerDocument : null;
    }

    function ensureLiveRegion() {
      if (liveRegionEl || !hostEl) return;
      const documentRef = doc();
      if (!documentRef) return;
      const el = documentRef.createElement('div');
      el.className = 'ide-map-findings-live';
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('role', 'status');
      hostEl.appendChild(el);
      liveRegionEl = el;
    }

    function announce(text) {
      ensureLiveRegion();
      if (!liveRegionEl) return;
      liveRegionEl.textContent = String(text == null ? '' : text);
    }

    function boundsForIds(ids) {
      if (!ids.length) return null;
      // Positions come off the atlas view's public accessor (the controller
      // bakes layout coords before update() runs), so framing never depends
      // on view internals or on which tiles happen to be materialized.
      const getPos = typeof view.getNodePosition === 'function'
        ? (id) => view.getNodePosition(id)
        : () => null;
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      let found = 0;
      for (const id of ids) {
        const pos = getPos(id);
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
        found += 1;
        minX = Math.min(minX, pos.x);
        minY = Math.min(minY, pos.y);
        maxX = Math.max(maxX, pos.x);
        maxY = Math.max(maxY, pos.y);
      }
      if (!found) return null;
      const pad = 80;
      return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    }

    function clearHighlight() {
      const previous = CHIP_DEFS.find((def) => def.id === activeChipId);
      if (previous && typeof view.applyFindingHighlight === 'function') {
        view.applyFindingHighlight(previous.kind, []);
      }
      activeChipId = null;
      syncActiveClasses();
    }

    function syncActiveClasses() {
      if (!hostEl || typeof hostEl.querySelectorAll !== 'function') return;
      const chips = hostEl.querySelectorAll('[data-inv-chip]');
      for (const el of chips) {
        const id = el.getAttribute('data-inv-chip');
        el.classList.toggle('is-active', id === activeChipId);
      }
    }

    function handleChipClick(defId) {
      const def = CHIP_DEFS.find((c) => c.id === defId);
      if (!def) return;
      if (activeChipId === defId) {
        // Toggle off.
        clearHighlight();
        announce('');
        return;
      }
      // Switching (or first activation): clear any previous highlight first.
      if (activeChipId && activeChipId !== defId) {
        const prevDef = CHIP_DEFS.find((c) => c.id === activeChipId);
        if (prevDef && typeof view.applyFindingHighlight === 'function') {
          view.applyFindingHighlight(prevDef.kind, []);
        }
      }
      const ids = def.idsOf(currentFindings);
      activeChipId = defId;
      syncActiveClasses();
      if (typeof view.applyFindingHighlight === 'function') {
        view.applyFindingHighlight(def.kind, ids);
      }
      const count = countFor(def, currentFindings);
      const label = count === 1 ? def.singular : def.label;
      announce(`${count} ${label}: ${ids.map((id) => String(id)).join(', ') || 'none'}`);
      const bounds = boundsForIds(ids);
      if (bounds && typeof transform.fitToContent === 'function') {
        transform.fitToContent(bounds);
      }
    }

    function handleClick(event) {
      if (disposed) return;
      const target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-inv-chip]')
        : null;
      if (!target) return;
      handleChipClick(target.getAttribute('data-inv-chip'));
    }

    if (hostEl && typeof hostEl.addEventListener === 'function') {
      hostEl.addEventListener('click', handleClick);
    }

    function renderChips() {
      if (!hostEl || typeof chip !== 'function') return;
      const documentRef = doc();
      const markup = CHIP_DEFS
        .map((def) => chip({
          id: def.id,
          label: def.label,
          count: String(countFor(def, currentFindings)),
          ariaLabel: `${def.label}, ${countFor(def, currentFindings)}`,
        }))
        .join('');
      hostEl.innerHTML = markup;
      if (documentRef) {
        ensureLiveRegion();
      }
      syncActiveClasses();
    }

    function update(graph) {
      if (disposed) return;
      currentFindings = (graph && graph.findings) || { hubs: [], cycles: [], orphans: [] };
      activeChipId = null;
      renderChips();
    }

    function clear() {
      if (disposed || !hostEl) return;
      hostEl.innerHTML = '';
      liveRegionEl = null;
      activeChipId = null;
      currentFindings = { hubs: [], cycles: [], orphans: [] };
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (hostEl && typeof hostEl.removeEventListener === 'function') {
        hostEl.removeEventListener('click', handleClick);
      }
      if (hostEl) {
        hostEl.innerHTML = '';
      }
      liveRegionEl = null;
      activeChipId = null;
    }

    return {
      update,
      clear,
      dispose,
      _internals: {
        CHIP_DEFS,
        get activeChipId() { return activeChipId; },
      },
    };
  }

  return { createMapFindings };
});
