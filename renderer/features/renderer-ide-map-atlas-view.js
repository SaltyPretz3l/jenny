/* renderer/features/renderer-ide-map-atlas-view.js — the Living Atlas
 * renderer for the Workspace File Map. Replaces renderer-ide-map-view.js
 * (global node+edge canvas) with a hierarchy-first city map:
 *
 *   districts  one absolutely-positioned div per directory (nested by
 *              GEOMETRY, flat in the DOM, parents painted first) with a
 *              header row: name · subtree count · language bar · health tick.
 *   dots       ONE shared <svg> with a pointer-events:none circle per file
 *              (language tint). No per-dot DOM, no per-dot listeners —
 *              interactions resolve through hitTest()'s uniform-grid spatial
 *              index (12px effective radius).
 *   tiles      DOM cards materialized ONLY for districts intersecting the
 *              current viewport rect at the 'tiles' tier, hard-capped.
 *   rays       ONE shared <svg> painted last: the selected file's OWN
 *              dependency edges (imports out / importers in), drawn on
 *              demand — there is no always-on global edge layer.
 *
 * Tier switching ('regions' | 'dots' | 'tiles') is presentation-only via
 * content classes; geometry never re-layouts on a tier flip. The activity
 * layer (pulses / trail / edit badges) paints into the same surfaces via
 * applyActivity (wired by the activity bus, W3).
 *
 * Positions come BAKED from renderer-ide-map-atlas-layout via renderAtlas —
 * this module owns DOM only. Palette-token styling lives in
 * styles/ide-file-map.css; this module assigns classes + inline geometry.
 * UMD, windowRef-free (document reached via contentEl.ownerDocument).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapAtlasView = factory();
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

  const inventoryButton = resolveModule('inventoryActionButton', '../inventory/action-button');
  const actionButton = typeof inventoryButton === 'function'
    ? inventoryButton
    : inventoryButton.actionButton || inventoryButton.default || null;
  const atlasLayout = resolveModule('rendererIdeMapAtlasLayout', './renderer-ide-map-atlas-layout');
  const langClassFor = typeof atlasLayout.langClassFor === 'function'
    ? atlasLayout.langClassFor
    : () => 'other';

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Tile footprint at scale 1 (CSS keeps in sync; atlas-layout CELL spacing
  // must exceed it so adjacent tiles never collide).
  const TILE_W = Number(atlasLayout.TILE_W) || 132;
  const TILE_H = Number(atlasLayout.TILE_H) || 26;
  // Dot radius (CSS keeps in sync) and the spatial index's effective hit
  // radius — generous so 3px-at-zoom dots aren't fiddly to hover.
  const DOT_R = 4;
  const HIT_RADIUS = 12;
  // Uniform-grid cell for the spatial index.
  const INDEX_CELL = 64;
  // Materialized-tile hard ceiling (backstop; viewport culling is primary).
  const MAX_TILES = 2000;
  // Ray control-point bias (same lane discipline as the old edge layer).
  const RAY_CONTROL_BIAS = 0.5;

  function createAtlasView(deps) {
    const d = deps || {};
    const contentEl = d.contentEl || null;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : defaultEscapeHtml;

    let disposed = false;
    let districtLayer = null;   // holder div for district rects
    let dotsSvg = null;         // shared circles layer
    let raysSvg = null;         // on-demand selection edges
    let tilesLayer = null;      // materialized tile cards
    let bounds = null;
    let tier = 'regions';
    let viewportRect = null;    // content-space rect for culling (null = all)
    let hideTests = false;

    // Data indices, rebuilt by renderAtlas.
    let nodeById = new Map();          // id -> graph node (with baked x/y)
    let districtByKey = new Map();     // key -> public district record
    let districtEls = new Map();       // key -> element
    let dotEls = new Map();            // id -> svg circle
    let tileEls = new Map();           // id -> materialized tile element
    let spatial = new Map();           // "cx|cy" -> [nodeId]
    let sourceViewBox = null;
    let activeGitStatus = {};
    let activeFinding = { kind: null, ids: [] };
    let selection = null;              // { focusId, rays }
    let spotlightSet = null;           // { focusId, memberIds:Set }
    let hoverId = null;

    function doc() {
      return contentEl && contentEl.ownerDocument ? contentEl.ownerDocument : null;
    }

    // ── spatial index ───────────────────────────────────────────────────────
    function indexKey(x, y) {
      return `${Math.floor(x / INDEX_CELL)}|${Math.floor(y / INDEX_CELL)}`;
    }

    function buildSpatialIndex() {
      spatial = new Map();
      for (const node of nodeById.values()) {
        const k = indexKey(node.x, node.y);
        if (!spatial.has(k)) spatial.set(k, []);
        spatial.get(k).push(node.id);
      }
    }

    function isNodeNavigable(id) {
      const node = nodeById.get(id);
      return Boolean(node) && !(hideTests && node.isTest === true);
    }

    // Nearest file within HIT_RADIUS of a content-space point, else the
    // deepest district containing it, else null.
    function hitTest(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      let best = null;
      let bestDist = HIT_RADIUS * HIT_RADIUS;
      const c0 = Math.floor((x - HIT_RADIUS) / INDEX_CELL);
      const c1 = Math.floor((x + HIT_RADIUS) / INDEX_CELL);
      const r0 = Math.floor((y - HIT_RADIUS) / INDEX_CELL);
      const r1 = Math.floor((y + HIT_RADIUS) / INDEX_CELL);
      for (let cx = c0; cx <= c1; cx += 1) {
        for (let cy = r0; cy <= r1; cy += 1) {
          for (const id of spatial.get(`${cx}|${cy}`) || []) {
            const node = nodeById.get(id);
            if (!node) continue;
            if (hideTests && node.isTest) continue;
            const dx = node.x - x;
            const dy = node.y - y;
            const dist = dx * dx + dy * dy;
            if (dist <= bestDist) {
              bestDist = dist;
              best = id;
            }
          }
        }
      }
      if (best) return { kind: 'node', id: best };
      let deepest = null;
      for (const dist of districtByKey.values()) {
        if (x >= dist.x && x <= dist.x + dist.w && y >= dist.y && y <= dist.y + dist.h) {
          if (!deepest || dist.depth > deepest.depth) deepest = dist;
        }
      }
      return deepest ? { kind: 'district', id: deepest.key } : null;
    }

    // ── district rendering ──────────────────────────────────────────────────
    function healthTickLevel(health) {
      const h = health || {};
      if ((h.capRed || 0) > 0 || (h.cycles || 0) > 0) return 'red';
      if ((h.capAmber || 0) > 0 || (h.orphans || 0) > 0) return 'amber';
      return 'ok';
    }

    function districtMarkup(district) {
      const total = district.fileCount;
      const mix = Array.isArray(district.langMix) ? district.langMix : [];
      const barSegs = mix.slice(0, 4).map((m) => {
        const pct = total > 0 ? Math.max(2, Math.round((m.count / total) * 100)) : 0;
        return `<span class="ide-atlas-langseg ide-atlas-langseg--${escapeHtml(m.cls)}" style="width:${pct}%"></span>`;
      }).join('');
      const tick = healthTickLevel(district.health);
      const name = district.key === '.' ? '(root)' : `${district.label}/`;
      const flat = district.flattened ? '<span class="ide-atlas-district-flat" aria-hidden="true">…</span>' : '';
      // A real button (inventory primitive) so zoom-to-district is
      // keyboard-reachable for free; the event-ownership classifier treats
      // it as a control, so a pan gesture can never start from the header.
      if (typeof actionButton !== 'function') return '';
      return actionButton({
        plain: true,
        className: 'ide-atlas-district-header',
        ariaLabel: `Zoom to ${district.key === '.' ? 'repository root' : district.key}`,
        title: `Zoom to ${district.key === '.' ? 'repository root' : district.key}`,
        dataset: { 'map-district-header': district.key },
        trustedHtml: ''
          + `<span class="ide-atlas-district-name">${escapeHtml(name)}</span>${flat}`
          + `<span class="ide-atlas-district-count">${total}</span>`
          + `<span class="ide-atlas-langbar" aria-hidden="true">${barSegs}</span>`
          + `<span class="ide-atlas-health ide-atlas-health--${tick}" aria-hidden="true"></span>`,
      });
    }

    function renderDistricts(districts) {
      const documentRef = doc();
      if (!documentRef) return;
      districtLayer = documentRef.createElement('div');
      districtLayer.className = 'ide-atlas-districts';
      for (const district of districts) {
        const el = documentRef.createElement('div');
        el.className = `ide-atlas-district ide-atlas-district--d${Math.min(district.depth, 3)}`;
        el.dataset.mapDistrict = district.key;
        el.style.left = `${Math.round(district.x)}px`;
        el.style.top = `${Math.round(district.y)}px`;
        el.style.width = `${Math.round(district.w)}px`;
        el.style.height = `${Math.round(district.h)}px`;
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label',
          `${district.key === '.' ? 'repository root' : district.key}, ${district.fileCount} files`);
        el.innerHTML = districtMarkup(district);
        districtLayer.appendChild(el);
        districtEls.set(district.key, el);
      }
      contentEl.appendChild(districtLayer);
    }

    // ── dots layer ──────────────────────────────────────────────────────────
    function renderDots(viewBox) {
      const documentRef = doc();
      if (!documentRef) return;
      dotsSvg = documentRef.createElementNS(SVG_NS, 'svg');
      dotsSvg.setAttribute('class', 'ide-atlas-dots');
      dotsSvg.setAttribute('aria-hidden', 'true');
      dotsSvg.setAttribute('width', String(viewBox.w));
      dotsSvg.setAttribute('height', String(viewBox.h));
      dotsSvg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
      dotsSvg.style.left = `${viewBox.x}px`;
      dotsSvg.style.top = `${viewBox.y}px`;
      for (const node of nodeById.values()) {
        const c = documentRef.createElementNS(SVG_NS, 'circle');
        c.setAttribute('class',
          `ide-atlas-dot ide-atlas-dot--lang-${langClassFor(node.id)}${node.isTest ? ' ide-atlas-dot--test' : ''}`);
        c.setAttribute('cx', String(node.x));
        c.setAttribute('cy', String(node.y));
        c.setAttribute('r', String(DOT_R));
        dotsSvg.appendChild(c);
        dotEls.set(node.id, c);
      }
      contentEl.appendChild(dotsSvg);
    }

    // ── rays layer (selection dependencies, on demand) ──────────────────────
    function buildRaysSvg(viewBox) {
      const documentRef = doc();
      if (!documentRef) return null;
      const svg = documentRef.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'ide-atlas-rays');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('width', String(viewBox.w));
      svg.setAttribute('height', String(viewBox.h));
      svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
      svg.style.left = `${viewBox.x}px`;
      svg.style.top = `${viewBox.y}px`;
      const defs = documentRef.createElementNS(SVG_NS, 'defs');
      const marker = documentRef.createElementNS(SVG_NS, 'marker');
      marker.setAttribute('id', 'ideAtlasRayArrow');
      marker.setAttribute('viewBox', '0 0 8 8');
      marker.setAttribute('refX', '7');
      marker.setAttribute('refY', '4');
      marker.setAttribute('markerWidth', '7');
      marker.setAttribute('markerHeight', '7');
      marker.setAttribute('orient', 'auto-start-reverse');
      const tip = documentRef.createElementNS(SVG_NS, 'path');
      tip.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
      tip.setAttribute('class', 'ide-atlas-ray-arrow');
      marker.appendChild(tip);
      defs.appendChild(marker);
      svg.appendChild(defs);
      return svg;
    }

    function halfExtentOf(id) {
      if (tier === 'tiles' && tileEls.has(id)) {
        return { hw: TILE_W / 2, hh: TILE_H / 2 };
      }
      return { hw: DOT_R + 1, hh: DOT_R + 1 };
    }

    function clipToBorder(cx, cy, hw, hh, tx, ty) {
      const dx = tx - cx;
      const dy = ty - cy;
      if (dx === 0 && dy === 0) return { x: cx, y: cy };
      const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
      const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
      const s = Math.min(sx, sy);
      return { x: cx + dx * s, y: cy + dy * s };
    }

    function rayPathD(fromNode, toNode) {
      const e1 = halfExtentOf(fromNode.id);
      const e2 = halfExtentOf(toNode.id);
      const a1 = clipToBorder(fromNode.x, fromNode.y, e1.hw, e1.hh, toNode.x, toNode.y);
      const a2 = clipToBorder(toNode.x, toNode.y, e2.hw, e2.hh, fromNode.x, fromNode.y);
      const dx = (a2.x - a1.x) * RAY_CONTROL_BIAS;
      const r = (n) => Math.round(n * 10) / 10;
      return `M ${r(a1.x)} ${r(a1.y)} C ${r(a1.x + dx)} ${r(a1.y)}, ${r(a2.x - dx)} ${r(a2.y)}, ${r(a2.x)} ${r(a2.y)}`;
    }

    function drawRay(fromId, toId, cls) {
      const documentRef = doc();
      const fromNode = nodeById.get(fromId);
      const toNode = nodeById.get(toId);
      if (!documentRef || !fromNode || !toNode || !raysSvg
        || !isNodeNavigable(fromId) || !isNodeNavigable(toId)) return;
      const path = documentRef.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', `ide-atlas-ray ${cls}`);
      path.setAttribute('d', rayPathD(fromNode, toNode));
      path.setAttribute('marker-end', 'url(#ideAtlasRayArrow)');
      raysSvg.appendChild(path);
    }

    function clearRays() {
      if (!raysSvg) return;
      for (const p of Array.from(raysSvg.querySelectorAll('path.ide-atlas-ray'))) p.remove();
    }

    // ── tiles layer (viewport-culled materialization) ───────────────────────
    function tileMarkup(node) {
      if (typeof actionButton !== 'function') return '';
      const lang = langClassFor(node.id);
      return actionButton({
        plain: true,
        className: `ide-atlas-tile ide-atlas-tile--lang-${lang}${node.isTest ? ' ide-atlas-tile--test' : ''}`,
        ariaLabel: `${node.id}, ${Number(node.inbound) || 0} inbound, ${Number(node.outbound) || 0} outbound`,
        title: `${node.id} — ${Number(node.inbound) || 0} inbound, ${Number(node.outbound) || 0} outbound`,
        dataset: { 'map-node': node.id },
        trustedHtml: ''
          + '<span class="ide-atlas-tile-dot" aria-hidden="true"></span>'
          + `<span class="ide-atlas-tile-name">${escapeHtml(node.label || node.id)}</span>`
          + '<span class="ide-atlas-tile-git" aria-hidden="true"></span>',
      });
    }

    function districtIntersectsViewport(district) {
      if (!viewportRect) return true;
      return district.x < viewportRect.x + viewportRect.w
        && viewportRect.x < district.x + district.w
        && district.y < viewportRect.y + viewportRect.h
        && viewportRect.y < district.y + district.h;
    }

    function nodeInViewport(node) {
      if (!viewportRect) return true;
      return node.x >= viewportRect.x - TILE_W && node.x <= viewportRect.x + viewportRect.w + TILE_W
        && node.y >= viewportRect.y - TILE_H && node.y <= viewportRect.y + viewportRect.h + TILE_H;
    }

    function desiredTileIds() {
      if (tier !== 'tiles') return new Set();
      const ids = new Set();
      const visibleDistricts = [];
      for (const district of districtByKey.values()) {
        if (districtIntersectsViewport(district)) visibleDistricts.push(district.key);
      }
      const visibleKeySet = new Set(visibleDistricts);
      for (const node of nodeById.values()) {
        if (ids.size >= MAX_TILES) break;
        if (!isNodeNavigable(node.id)) continue;
        if (!visibleKeySet.size || visibleKeySet.has(node.districtKey)) {
          if (nodeInViewport(node)) ids.add(node.id);
        }
      }
      return ids;
    }

    function positionTile(el, node) {
      el.style.left = `${Math.round(node.x - TILE_W / 2)}px`;
      el.style.top = `${Math.round(node.y - TILE_H / 2)}px`;
    }

    function decorateTile(el, id) {
      const status = activeGitStatus[id];
      el.classList.toggle('ide-atlas-tile--git-modified', status === 'modified');
      el.classList.toggle('ide-atlas-tile--git-added', status === 'added');
      const f = activeFinding;
      el.classList.toggle('ide-atlas-node--finding-hub', f.kind === 'hub' && f.ids.includes(id));
      el.classList.toggle('ide-atlas-node--finding-cycle', f.kind === 'cycle' && f.ids.includes(id));
      el.classList.toggle('ide-atlas-node--finding-orphan', f.kind === 'orphan' && f.ids.includes(id));
      if (selection && selection.focusId === id) el.classList.add('is-selected');
      if (spotlightSet) {
        el.classList.toggle('is-spotlit', spotlightSet.focusId === id);
        el.classList.toggle('is-incident-node', spotlightSet.focusId !== id && spotlightSet.memberIds.has(id));
      }
    }

    function materializeTiles() {
      if (disposed || !tilesLayer) return;
      const documentRef = doc();
      if (!documentRef) return;
      const want = desiredTileIds();
      for (const [id, el] of tileEls) {
        if (!want.has(id)) {
          el.remove();
          tileEls.delete(id);
        }
      }
      const holder = documentRef.createElement('div');
      for (const id of want) {
        if (tileEls.has(id)) continue;
        const node = nodeById.get(id);
        if (!node) continue;
        holder.innerHTML = tileMarkup(node);
        const el = holder.firstElementChild;
        if (!el) continue;
        el.tabIndex = -1;
        positionTile(el, node);
        decorateTile(el, id);
        tilesLayer.appendChild(el);
        tileEls.set(id, el);
      }
    }

    // Force-materialize one tile (reveal / a11y focus target) regardless of
    // tier or viewport — the caller is about to pan it into view anyway.
    function ensureTileFor(id) {
      if (disposed || !tilesLayer || !isNodeNavigable(id)) return null;
      if (tileEls.has(id)) return tileEls.get(id) || null;
      const node = nodeById.get(id);
      const documentRef = doc();
      if (!node || !documentRef || !isNodeNavigable(id)) return null;
      const holder = documentRef.createElement('div');
      holder.innerHTML = tileMarkup(node);
      const el = holder.firstElementChild;
      if (!el) return null;
      el.tabIndex = -1;
      positionTile(el, node);
      decorateTile(el, id);
      tilesLayer.appendChild(el);
      tileEls.set(id, el);
      return el;
    }

    // ── main render ─────────────────────────────────────────────────────────
    // graph: engine graph (for node metadata); layoutResult: atlas-layout
    // output { districts, positions, buckets, bounds }.
    function renderAtlas(graph, layoutResult) {
      if (disposed || !contentEl || !graph || !layoutResult) return null;
      const positions = layoutResult.positions || {};
      const districts = Array.isArray(layoutResult.districts) ? layoutResult.districts : [];

      contentEl.replaceChildren();
      districtEls = new Map();
      dotEls = new Map();
      tileEls = new Map();
      activityLayer = null;
      lastHeatIds = new Set();
      livePulseCount = 0;
      nodeById = new Map();
      districtByKey = new Map(districts.map((dist) => [dist.key, dist]));
      selection = null;
      spotlightSet = null;
      hoverId = null;
      contentEl.classList.remove('ide-atlas--spotlit');

      const keyOf = typeof atlasLayout.districtKeyOf === 'function'
        ? atlasLayout.districtKeyOf
        : () => '.';
      for (const node of graph.nodes || []) {
        if (!node || node.id == null || node.bucket === true) continue;
        const pos = positions[node.id];
        if (!pos) continue;
        nodeById.set(node.id, { ...node, x: pos.x, y: pos.y, districtKey: keyOf(node.id) });
      }
      buildSpatialIndex();

      bounds = layoutResult.bounds && Number.isFinite(layoutResult.bounds.minX)
        ? { ...layoutResult.bounds }
        : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      const pad = 80;
      sourceViewBox = {
        x: Math.floor(bounds.minX - pad),
        y: Math.floor(bounds.minY - pad),
        w: Math.ceil(bounds.maxX - bounds.minX + pad * 2) || 1,
        h: Math.ceil(bounds.maxY - bounds.minY + pad * 2) || 1,
      };

      renderDistricts(districts);
      renderDots(sourceViewBox);
      const documentRef = doc();
      if (documentRef) {
        tilesLayer = documentRef.createElement('div');
        tilesLayer.className = 'ide-atlas-tiles';
        contentEl.appendChild(tilesLayer);
      }
      raysSvg = buildRaysSvg(sourceViewBox);
      if (raysSvg) contentEl.appendChild(raysSvg);

      applyTierClasses();
      materializeTiles();
      applyGitStatus(activeGitStatus);
      applyFindingHighlight(activeFinding.kind, activeFinding.ids);
      return { ...bounds };
    }

    // ── tiers / culling ─────────────────────────────────────────────────────
    function applyTierClasses() {
      contentEl.classList.toggle('ide-atlas--tier-regions', tier === 'regions');
      contentEl.classList.toggle('ide-atlas--tier-dots', tier === 'dots');
      contentEl.classList.toggle('ide-atlas--tier-tiles', tier === 'tiles');
    }

    function setTier(nextTier) {
      if (disposed || !contentEl) return;
      const t = nextTier === 'regions' || nextTier === 'dots' || nextTier === 'tiles' ? nextTier : 'regions';
      if (t === tier) return;
      tier = t;
      applyTierClasses();
      materializeTiles();
      if (selection) redrawSelection();
    }

    function setViewportRect(rect) {
      if (disposed) return;
      viewportRect = rect && Number.isFinite(rect.x) && Number.isFinite(rect.w) ? { ...rect } : null;
      if (tier === 'tiles') materializeTiles();
    }

    // ── selection / spotlight ───────────────────────────────────────────────
    function forEachNodeEl(id, fn) {
      const dot = dotEls.get(id);
      if (dot) fn(dot);
      const tile = tileEls.get(id);
      if (tile) fn(tile);
    }

    function clearNodeStateClasses() {
      for (const layerEls of [dotEls, tileEls]) {
        for (const el of layerEls.values()) {
          el.classList.remove('is-selected', 'is-ray-target', 'is-spotlit', 'is-incident-node');
        }
      }
    }

    function redrawSelection() {
      clearRays();
      if (!selection) return;
      const { focusId, rays } = selection;
      for (const depId of rays.dependencies || []) drawRay(focusId, depId, 'ide-atlas-ray--out');
      for (const depId of rays.dependents || []) drawRay(depId, focusId, 'ide-atlas-ray--in');
    }

    // Select a file and light ITS dependency rays (deps layer). Pass null to
    // clear. rays = { dependencies: [ids], dependents: [ids] }.
    function setSelection(focusId, rays) {
      if (disposed || !contentEl) return;
      spotlightSet = null;
      clearNodeStateClasses();
      clearRays();
      if (focusId == null || !isNodeNavigable(focusId)) {
        selection = null;
        contentEl.classList.remove('ide-atlas--spotlit');
        return;
      }
      selection = {
        focusId,
        rays: {
          dependencies: (rays && rays.dependencies) || [],
          dependents: (rays && rays.dependents) || [],
        },
      };
      contentEl.classList.add('ide-atlas--spotlit');
      forEachNodeEl(focusId, (el) => el.classList.add('is-selected'));
      for (const list of [selection.rays.dependencies, selection.rays.dependents]) {
        for (const id of list) forEachNodeEl(id, (el) => el.classList.add('is-ray-target'));
      }
      redrawSelection();
    }

    // Blast radius: focus + transitive dependents lit, rest calmed (same
    // seam as the old view so controller/findings survive the swap).
    function setSpotlightSet(focusId, memberIds) {
      if (disposed || !contentEl) return;
      selection = null;
      clearRays();
      clearNodeStateClasses();
      const active = focusId != null && isNodeNavigable(focusId);
      if (!active) {
        spotlightSet = null;
        contentEl.classList.remove('ide-atlas--spotlit');
        return;
      }
      const members = new Set(memberIds || []);
      members.add(focusId);
      spotlightSet = { focusId, memberIds: members };
      contentEl.classList.add('ide-atlas--spotlit');
      forEachNodeEl(focusId, (el) => el.classList.add('is-spotlit'));
      for (const id of members) {
        if (id === focusId) continue;
        forEachNodeEl(id, (el) => el.classList.add('is-incident-node'));
      }
    }

    // Transient hover accent (cheap: class toggles only, no rays).
    function setHover(id) {
      if (disposed) return;
      const next = id != null && nodeById.has(id) ? id : null;
      if (next === hoverId) return;
      if (hoverId) forEachNodeEl(hoverId, (el) => el.classList.remove('is-hover'));
      hoverId = next;
      if (hoverId) forEachNodeEl(hoverId, (el) => el.classList.add('is-hover'));
    }

    // ── decorations ─────────────────────────────────────────────────────────
    function applyGitStatus(statusByPath) {
      if (disposed) return;
      activeGitStatus = statusByPath || {};
      for (const [id, el] of tileEls) {
        const status = activeGitStatus[id];
        el.classList.toggle('ide-atlas-tile--git-modified', status === 'modified');
        el.classList.toggle('ide-atlas-tile--git-added', status === 'added');
      }
      for (const [id, el] of dotEls) {
        const status = activeGitStatus[id];
        el.classList.toggle('ide-atlas-dot--git-modified', status === 'modified');
        el.classList.toggle('ide-atlas-dot--git-added', status === 'added');
      }
    }

    function applyFindingHighlight(kind, nodeIds) {
      if (disposed) return;
      const ids = new Set(nodeIds || []);
      activeFinding = { kind, ids: Array.from(ids) };
      for (const layerEls of [dotEls, tileEls]) {
        for (const [id, el] of layerEls) {
          el.classList.toggle('ide-atlas-node--finding-hub', kind === 'hub' && ids.has(id));
          el.classList.toggle('ide-atlas-node--finding-cycle', kind === 'cycle' && ids.has(id));
          el.classList.toggle('ide-atlas-node--finding-orphan', kind === 'orphan' && ids.has(id));
        }
      }
    }

    function setHideTests(next) {
      if (disposed || !contentEl) return;
      hideTests = next === true;
      contentEl.classList.toggle('ide-atlas--hide-tests', hideTests);
      if (hideTests && selection && !isNodeNavigable(selection.focusId)) {
        selection = null;
        clearNodeStateClasses();
        clearRays();
      }
      if (hideTests && spotlightSet && !isNodeNavigable(spotlightSet.focusId)) {
        spotlightSet = null;
        clearNodeStateClasses();
      }
      if (hideTests && hoverId && !isNodeNavigable(hoverId)) {
        forEachNodeEl(hoverId, (el) => el.classList.remove('is-hover'));
        hoverId = null;
      }
      materializeTiles();
      if (selection) redrawSelection();
    }

    // Layer chips (Activity / Health / Deps) are presentation gates.
    function setLayerState(layers) {
      if (disposed || !contentEl) return;
      const l = layers || {};
      contentEl.classList.toggle('ide-atlas--layer-activity', l.activity !== false);
      contentEl.classList.toggle('ide-atlas--layer-health', l.health === true);
      contentEl.classList.toggle('ide-atlas--layer-deps', l.deps !== false);
    }

    // ── activity layer (fed by the activity presenter, node-id-native) ──────
    // state: { heat: Map id -> {verb, ts}, editedIds: Set<id>,
    //          trail: [{ id, n, count }], faded?: bool }
    // Heat/edit ride the dots/tiles as classes; the trail's numbered steps +
    // pulse rings render into one .ide-atlas-activity overlay (content
    // space, so it pans/zooms with the map). Pulses spawn only for ids NEW
    // since the previous apply, capped, and self-remove on animationend.
    let activityLayer = null;
    let lastHeatIds = new Set();
    let livePulseCount = 0;
    const MAX_PULSES = 30;

    function ensureActivityLayer() {
      const documentRef = doc();
      if (!documentRef || !contentEl) return null;
      if (activityLayer && activityLayer.parentNode === contentEl) return activityLayer;
      activityLayer = documentRef.createElement('div');
      activityLayer.className = 'ide-atlas-activity';
      contentEl.appendChild(activityLayer);
      return activityLayer;
    }

    function spawnPulse(id) {
      const windowRef = doc()?.defaultView;
      if (windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const layer = ensureActivityLayer();
      const node = nodeById.get(id);
      const documentRef = doc();
      if (!layer || !node || !documentRef || livePulseCount >= MAX_PULSES) return;
      const el = documentRef.createElement('div');
      el.className = 'ide-atlas-pulse';
      el.style.left = `${Math.round(node.x)}px`;
      el.style.top = `${Math.round(node.y)}px`;
      livePulseCount += 1;
      const drop = () => {
        el.remove();
        livePulseCount = Math.max(0, livePulseCount - 1);
      };
      if (typeof el.addEventListener === 'function') {
        el.addEventListener('animationend', drop, { once: true });
        el.addEventListener('animationcancel', drop, { once: true });
      }
      layer.appendChild(el);
    }

    function renderTrailSteps(trail) {
      const layer = ensureActivityLayer();
      const documentRef = doc();
      if (!layer || !documentRef) return;
      for (const el of Array.from(layer.querySelectorAll('.ide-atlas-trail-step'))) el.remove();
      for (const step of trail) {
        const node = nodeById.get(step.id);
        if (!node) continue;
        const el = documentRef.createElement('div');
        el.className = 'ide-atlas-trail-step';
        el.style.left = `${Math.round(node.x)}px`;
        el.style.top = `${Math.round(node.y)}px`;
        el.textContent = String(step.n);
        if (step.count > 1) el.title = `×${step.count}`;
        layer.appendChild(el);
      }
    }

    function applyActivity(state) {
      if (disposed || !contentEl) return;
      const s = state || {};
      const heat = s.heat instanceof Map ? s.heat : new Map(Object.entries(s.heat || {}));
      const edited = s.editedIds instanceof Set ? s.editedIds : new Set(s.editedIds || []);
      const trail = Array.isArray(s.trail) ? s.trail : [];
      for (const layerEls of [dotEls, tileEls]) {
        for (const [id, el] of layerEls) {
          const entry = heat.get(id);
          el.classList.toggle('is-heat', !!entry);
          el.classList.toggle('is-heat-edit', !!entry && edited.has(id));
        }
      }
      for (const id of heat.keys()) {
        if (!lastHeatIds.has(id)) spawnPulse(id);
      }
      lastHeatIds = new Set(heat.keys());
      renderTrailSteps(trail);
      const layer = ensureActivityLayer();
      if (layer) layer.classList.toggle('is-fading', s.faded === true);
    }

    // ── misc public surface ─────────────────────────────────────────────────
    function getNodeElement(nodeId) {
      return tileEls.get(nodeId) || null;
    }

    function getDistrict(key) {
      return districtByKey.get(key) || null;
    }

    function getNodePosition(nodeId) {
      const node = nodeById.get(nodeId);
      return node ? { x: node.x, y: node.y } : null;
    }

    function getRenderedSet() {
      return new Set(tileEls.keys());
    }

    function getAllNodeIds() {
      return new Set(nodeById.keys());
    }

    function getBounds() {
      return bounds ? { ...bounds } : null;
    }

    function getTier() {
      return tier;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (contentEl) contentEl.replaceChildren();
      nodeById = new Map();
      districtByKey = new Map();
      districtEls = new Map();
      dotEls = new Map();
      tileEls = new Map();
      spatial = new Map();
      districtLayer = null;
      dotsSvg = null;
      raysSvg = null;
      tilesLayer = null;
      activityLayer = null;
      lastHeatIds = new Set();
      livePulseCount = 0;
      bounds = null;
      sourceViewBox = null;
      selection = null;
      spotlightSet = null;
    }

    return {
      renderAtlas,
      setTier,
      setViewportRect,
      setSelection,
      setSpotlightSet,
      setHover,
      hitTest,
      applyGitStatus,
      applyFindingHighlight,
      setHideTests,
      setLayerState,
      applyActivity,
      ensureTileFor,
      getNodeElement,
      getDistrict,
      getNodePosition,
      isNodeNavigable,
      getRenderedSet,
      getAllNodeIds,
      getBounds,
      getTier,
      dispose,
      _internals: {
        get nodeById() { return nodeById; },
        get dotEls() { return dotEls; },
        get tileEls() { return tileEls; },
        get districtEls() { return districtEls; },
        get spatial() { return spatial; },
        desiredTileIds,
        clipToBorder,
        rayPathD,
        healthTickLevel,
        TILE_W,
        TILE_H,
        DOT_R,
        HIT_RADIUS,
        INDEX_CELL,
        MAX_TILES,
      },
    };
  }

  // Ignored-directory rollups render as CHROME (screen-space footer chips),
  // never as spatial cards — the controller owns the strip element.
  function renderBucketStrip(stripEl, buckets, escapeHtmlFn) {
    if (!stripEl) return;
    const esc = typeof escapeHtmlFn === 'function' ? escapeHtmlFn : defaultEscapeHtml;
    const list = Array.isArray(buckets) ? buckets : [];
    if (!list.length) {
      stripEl.innerHTML = '';
      stripEl.classList.add('hidden');
      return;
    }
    stripEl.classList.remove('hidden');
    stripEl.innerHTML = list.slice(0, 8).map((b) => ''
      + `<span class="ide-atlas-bucket-chip" data-map-bucket="${esc(b.key)}" title="${esc(b.key)} — excluded from the map">`
      + '<span class="ide-atlas-bucket-glyph" aria-hidden="true">▤</span>'
      + `<span class="ide-atlas-bucket-name">${esc(b.label)}</span>`
      + `<span class="ide-atlas-bucket-count">${Number(b.count) || 0}</span>`
      + '</span>').join('');
  }

  return { createAtlasView, renderBucketStrip };
});
