/* renderer/features/renderer-ide-explode-layout.js — pure, DOM-free geometry
 * for the Exploded View. Given the engine's graph (nodes carry a `zone` and a
 * within-zone `rank`), it assigns each node a CENTER coordinate {x,y} in four
 * left->right lanes (imports | data | functions | entry) and emits the lane
 * "band" rectangles + the overall content bounds. The renderer (explode-view)
 * consumes { positions, bands, bounds } and never computes coordinates itself —
 * same discipline as the File Map (engine owns layout, view owns DOM). Kept
 * pure so it unit-tests without a DOM. UMD, mirroring the repo's module style. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeExplodeLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Lanes left->right: dependencies feed in from the left, the exported public
  // surface reads last on the right (matches the approved mockup).
  const ZONE_ORDER = ['imports', 'data', 'functions', 'entry'];
  const ZONE_LABELS = {
    imports: 'imports',
    data: 'data',
    functions: 'functions',
    entry: 'exported',
  };

  const COLUMN_WIDTH = 260;
  const ROW_HEIGHT = 88;
  // Reference card footprint (CSS keeps these roughly in sync). Used only for
  // center-anchoring math + band/bounds padding — never measured from the DOM.
  const NODE_W = 176;
  const NODE_H = 46;
  const BAND_W = 212;
  const BAND_HEADER = 30;
  const BAND_PAD_Y = 16;

  function zoneOf(node) {
    const z = node && node.zone;
    return ZONE_ORDER.includes(z) ? z : 'functions';
  }

  function rankOf(node) {
    const r = node && Number(node.rank);
    return Number.isFinite(r) ? r : 0;
  }

  // graph: { nodes: [{ id, zone, rank }], ... }. Returns:
  //   positions: { [id]: {x, y} }   node CENTERS in content space
  //   bands:     [{ zone, label, x, y, w, h }]  lane rectangles (behind cards)
  //   bounds:    { minX, minY, maxX, maxY }     content extent for fitToContent
  function layout(graph) {
    const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
    const positions = {};
    const bands = [];
    if (!nodes.length) {
      return { positions, bands, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
    }

    // Bucket by zone, preserving only zones that actually have nodes so lanes
    // stay gap-free (an import-only file shouldn't leave three empty columns).
    const byZone = new Map();
    for (const node of nodes) {
      if (!node || node.id == null) continue;
      const zone = zoneOf(node);
      if (!byZone.has(zone)) byZone.set(zone, []);
      byZone.get(zone).push(node);
    }
    const presentZones = ZONE_ORDER.filter((z) => byZone.has(z));

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;

    presentZones.forEach((zone, colIndex) => {
      const column = byZone.get(zone).slice().sort((a, b) => {
        const dr = rankOf(a) - rankOf(b);
        return dr !== 0 ? dr : String(a.id).localeCompare(String(b.id));
      });
      const x = colIndex * COLUMN_WIDTH;
      const n = column.length;
      let colTop = Infinity; let colBottom = -Infinity;
      column.forEach((node, i) => {
        // Vertically center each lane around y=0 so uneven columns stay balanced.
        const y = (i - (n - 1) / 2) * ROW_HEIGHT;
        positions[node.id] = { x, y };
        colTop = Math.min(colTop, y - NODE_H / 2);
        colBottom = Math.max(colBottom, y + NODE_H / 2);
        minX = Math.min(minX, x - NODE_W / 2);
        maxX = Math.max(maxX, x + NODE_W / 2);
      });
      const bandTop = colTop - BAND_HEADER;
      const bandBottom = colBottom + BAND_PAD_Y;
      bands.push({
        zone,
        label: ZONE_LABELS[zone] || zone,
        x: x - BAND_W / 2,
        y: bandTop,
        w: BAND_W,
        h: bandBottom - bandTop,
      });
      minX = Math.min(minX, x - BAND_W / 2);
      maxX = Math.max(maxX, x + BAND_W / 2);
      minY = Math.min(minY, bandTop);
      maxY = Math.max(maxY, bandBottom);
    });

    return { positions, bands, bounds: { minX, minY, maxX, maxY } };
  }

  return {
    layout,
    ZONE_ORDER,
    ZONE_LABELS,
    COLUMN_WIDTH,
    ROW_HEIGHT,
    NODE_W,
    NODE_H,
  };
});
