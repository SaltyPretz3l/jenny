/* renderer/features/renderer-ide-explode-view.js — the Exploded View painter.
 * Draws the engine's single-file graph into the transformed content element:
 * one inventory actionButton({plain:true}) card per symbol (function/method/
 * data/import), absolutely positioned by its CENTER in content space, plus ONE
 * shared <svg> edge layer (call = solid + arrow, read = dashed, import = faint
 * dotted) painted under the cards, plus the lane "band" backdrops painted under
 * everything. Coordinates come from renderer-ide-explode-layout (positions +
 * bands); this module only assigns classes + inline geometry. Palette-token
 * styling lives in styles/ide-explode-view.css.
 *
 * Cards are tagged data-map-node so the reused transform/node-drag modules
 * (which key on [data-map-node]) work unchanged. Card kind drives the one color
 * channel; the exported entry node is the hero (success ring). Center-anchored
 * (left/top = x - w/2, y - h/2) so edge endpoints meet card centers without
 * measuring the DOM — the same technique as renderer-ide-map-view.
 *
 * Public interface — createExplodeView({ contentEl, escapeHtml? }):
 *   .renderGraph(graph, { positions, bands, bounds? })  Full render; returns
 *       the content bounds for transform.fitToContent().
 *   .setSpotlight(nodeId|null)   Brighten a node + incident edges, calm rest.
 *   .setLodTier('dots'|'pills'|'cards')  Semantic-zoom presentation classes.
 *   .dispose()   Clears the host + indices. Idempotent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeExplodeView = factory();
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
    return {};
  }

  const inventoryButton = resolveModule('inventoryActionButton', '../inventory/action-button');
  const actionButton = typeof inventoryButton === 'function'
    ? inventoryButton
    : inventoryButton.actionButton || inventoryButton.default || null;

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Reference card footprint at scale 1 (kept in sync with the CSS + layout
  // module). Used only for center-anchoring + bounds padding.
  const NODE_BASE_W = 176;
  const NODE_BASE_H = 46;
  const HERO_SCALE = 1.12;

  const KIND_CLASS = {
    function: 'ide-explode-node--function',
    method: 'ide-explode-node--method',
    data: 'ide-explode-node--data',
    import: 'ide-explode-node--import',
  };

  const DATA_SHAPE_TAG = {
    array: 'array',
    object: 'object',
    primitive: 'const',
    expr: 'value',
    enum: 'enum',
    unknown: '',
  };

  function isHero(node) {
    return !!(node && node.isExported && node.zone === 'entry');
  }

  function scaleFor(node) {
    return isHero(node) ? HERO_SCALE : 1;
  }

  function tagFor(node) {
    if (!node) return '';
    if (isHero(node)) return 'export';
    if (node.kind === 'data') return DATA_SHAPE_TAG[node.dataShape] || '';
    if (node.kind === 'method') return node.container ? String(node.container) : '';
    if (node.kind === 'import') return node.source ? String(node.source) : 'import';
    if (node.kind === 'function' && node.isAsync) return 'async';
    return '';
  }

  function createExplodeView(deps) {
    const d = deps || {};
    const contentEl = d.contentEl || null;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : defaultEscapeHtml;

    let disposed = false;
    let bounds = null;
    const nodeIndex = new Map();  // id -> { el, node }
    const edgeIndex = new Map();  // key -> { el, edge }
    const incidence = new Map();  // id -> [edgeKey]
    let spotlightId = null;

    function doc() {
      return contentEl && contentEl.ownerDocument ? contentEl.ownerDocument : null;
    }

    function edgeKeyOf(edge) {
      return `${edge.from}|${edge.to}|${edge.kind}`;
    }

    function nodeCardMarkup(node) {
      if (typeof actionButton !== 'function') return '';
      const classes = [
        'ide-explode-node',
        KIND_CLASS[node.kind] || 'ide-explode-node--function',
        isHero(node) ? 'ide-explode-node--hero' : '',
      ].filter(Boolean).join(' ');
      const tag = tagFor(node);
      const tagHtml = tag
        ? `<span class="ide-explode-node-tag">${escapeHtml(tag)}</span>`
        : '';
      const trustedHtml = ''
        + '<span class="ide-explode-node-dot" aria-hidden="true"></span>'
        + `<span class="ide-explode-node-name">${escapeHtml(node.name)}</span>`
        + tagHtml;
      return actionButton({
        plain: true,
        className: classes,
        ariaLabel: `${node.name}, ${node.kind}${node.isExported ? ', exported' : ''}`,
        title: `${node.name}, ${node.kind}${node.isExported ? ', exported' : ''}`,
        dataset: { 'map-node': node.id },
        trustedHtml,
      });
    }

    function positionCard(el, node) {
      const scale = scaleFor(node);
      el.style.left = `${Math.round(node.x - (NODE_BASE_W * scale) / 2)}px`;
      el.style.top = `${Math.round(node.y - (NODE_BASE_H * scale) / 2)}px`;
      el.style.setProperty('--explode-node-scale', String(scale));
    }

    function edgePathD(fromNode, toNode) {
      const x1 = fromNode.x; const y1 = fromNode.y;
      const x2 = toNode.x; const y2 = toNode.y;
      const dx = (x2 - x1) * 0.4;
      return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    }

    function appendArrowMarker(defs, documentRef, id, cls) {
      const marker = documentRef.createElementNS(SVG_NS, 'marker');
      marker.setAttribute('id', id);
      marker.setAttribute('viewBox', '0 0 8 8');
      marker.setAttribute('refX', '7');
      marker.setAttribute('refY', '4');
      marker.setAttribute('markerWidth', '7');
      marker.setAttribute('markerHeight', '7');
      marker.setAttribute('orient', 'auto-start-reverse');
      const tip = documentRef.createElementNS(SVG_NS, 'path');
      tip.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
      tip.setAttribute('class', cls);
      marker.appendChild(tip);
      defs.appendChild(marker);
    }

    function buildSvg(graph, positions, viewBox) {
      const documentRef = doc();
      if (!documentRef) return null;
      const svg = documentRef.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'ide-explode-edges');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('width', String(viewBox.w));
      svg.setAttribute('height', String(viewBox.h));
      svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
      svg.style.left = `${viewBox.x}px`;
      svg.style.top = `${viewBox.y}px`;

      const defs = documentRef.createElementNS(SVG_NS, 'defs');
      appendArrowMarker(defs, documentRef, 'ideExplodeArrowCall', 'ide-explode-edge-arrow--call');
      appendArrowMarker(defs, documentRef, 'ideExplodeArrowRead', 'ide-explode-edge-arrow--read');
      svg.appendChild(defs);

      const at = (id) => positions[id];
      for (const edge of graph.edges || []) {
        const fromPt = at(edge.from);
        const toPt = at(edge.to);
        if (!fromPt || !toPt) continue;
        const key = edgeKeyOf(edge);
        if (edgeIndex.has(key)) continue;
        const kind = edge.kind === 'read' ? 'read' : (edge.kind === 'import' ? 'import' : 'call');
        const path = documentRef.createElementNS(SVG_NS, 'path');
        path.setAttribute('class', `ide-explode-edge ide-explode-edge--${kind}`);
        path.setAttribute('d', edgePathD(fromPt, toPt));
        if (kind === 'call') {
          path.setAttribute('marker-end', 'url(#ideExplodeArrowCall)');
        } else if (kind === 'read') {
          path.setAttribute('marker-end', 'url(#ideExplodeArrowRead)');
        }
        svg.appendChild(path);
        edgeIndex.set(key, { el: path, edge });
        if (!incidence.has(edge.from)) incidence.set(edge.from, []);
        if (!incidence.has(edge.to)) incidence.set(edge.to, []);
        incidence.get(edge.from).push(key);
        incidence.get(edge.to).push(key);
      }
      return svg;
    }

    function renderBands(bands) {
      const documentRef = doc();
      if (!documentRef || !Array.isArray(bands)) return;
      for (const band of bands) {
        if (!band) continue;
        const el = documentRef.createElement('div');
        el.className = 'ide-explode-band';
        el.style.left = `${Math.round(band.x)}px`;
        el.style.top = `${Math.round(band.y)}px`;
        el.style.width = `${Math.round(band.w)}px`;
        el.style.height = `${Math.round(band.h)}px`;
        const label = documentRef.createElement('span');
        label.className = 'ide-explode-band-label';
        label.textContent = String(band.label == null ? '' : band.label);
        el.appendChild(label);
        contentEl.appendChild(el);
      }
    }

    function boundsFromPositions(nodes, positions) {
      if (!nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const node of nodes) {
        const p = positions[node.id];
        if (!p) continue;
        const scale = scaleFor(node);
        const halfW = (NODE_BASE_W * scale) / 2;
        const halfH = (NODE_BASE_H * scale) / 2;
        minX = Math.min(minX, p.x - halfW);
        minY = Math.min(minY, p.y - halfH);
        maxX = Math.max(maxX, p.x + halfW);
        maxY = Math.max(maxY, p.y + halfH);
      }
      if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      return { minX, minY, maxX, maxY };
    }

    function renderGraph(graph, opts) {
      if (disposed || !contentEl || !graph) return null;
      const o = opts || {};
      const positions = o.positions || {};
      const bands = o.bands || [];

      nodeIndex.clear();
      edgeIndex.clear();
      incidence.clear();
      spotlightId = null;
      contentEl.innerHTML = '';
      contentEl.classList.remove('ide-explode-content--spotlit');

      const nodes = (graph.nodes || []).filter((n) => n && positions[n.id]);

      // Bands paint first (behind), then edges, then cards on top.
      renderBands(bands);

      const providedBounds = o.bounds && Number.isFinite(o.bounds.minX) ? o.bounds : null;
      bounds = providedBounds || boundsFromPositions(nodes, positions);
      const pad = 80;
      const viewBox = {
        x: Math.floor(bounds.minX - pad),
        y: Math.floor(bounds.minY - pad),
        w: Math.ceil(bounds.maxX - bounds.minX + pad * 2) || 1,
        h: Math.ceil(bounds.maxY - bounds.minY + pad * 2) || 1,
      };

      const svg = buildSvg({ nodes, edges: graph.edges || [] }, positions, viewBox);
      if (svg) {
        contentEl.appendChild(svg);
      }

      const documentRef = doc();
      if (documentRef) {
        const holder = documentRef.createElement('div');
        for (const rawNode of nodes) {
          const node = { ...rawNode, x: positions[rawNode.id].x, y: positions[rawNode.id].y };
          holder.innerHTML = nodeCardMarkup(node);
          const el = holder.firstElementChild;
          if (!el) continue;
          positionCard(el, node);
          contentEl.appendChild(el);
          nodeIndex.set(node.id, { el, node });
        }
      }
      return bounds;
    }

    function setLodTier(tier) {
      if (disposed || !contentEl) return;
      const t = tier === 'dots' || tier === 'pills' ? tier : 'cards';
      contentEl.classList.toggle('ide-explode-content--tier-dots', t === 'dots');
      contentEl.classList.toggle('ide-explode-content--tier-pills', t === 'pills');
    }

    function setSpotlight(nodeId) {
      if (disposed || !contentEl) return;
      spotlightId = nodeId || null;
      const active = spotlightId != null && nodeIndex.has(spotlightId);
      contentEl.classList.toggle('ide-explode-content--spotlit', active);
      for (const [id, entry] of nodeIndex) {
        entry.el.classList.toggle('is-spotlit', active && id === spotlightId);
        entry.el.classList.toggle('is-incident-node', false);
      }
      for (const { el } of edgeIndex.values()) {
        el.classList.toggle('is-incident', false);
      }
      if (!active) return;
      for (const key of incidence.get(spotlightId) || []) {
        const entry = edgeIndex.get(key);
        if (!entry) continue;
        entry.el.classList.add('is-incident');
        const other = entry.edge.from === spotlightId ? entry.edge.to : entry.edge.from;
        const otherNode = nodeIndex.get(other);
        if (otherNode) otherNode.el.classList.add('is-incident-node');
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (contentEl) contentEl.innerHTML = '';
      nodeIndex.clear();
      edgeIndex.clear();
      incidence.clear();
      bounds = null;
    }

    return {
      renderGraph,
      setSpotlight,
      setLodTier,
      dispose,
      _internals: {
        nodeIndex,
        edgeIndex,
        incidence,
        tagFor,
        isHero,
        NODE_BASE_W,
        NODE_BASE_H,
      },
    };
  }

  return { createExplodeView };
});
