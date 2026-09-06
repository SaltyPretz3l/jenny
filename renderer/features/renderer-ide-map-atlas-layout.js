/* renderer/features/renderer-ide-map-atlas-layout.js — pure, DOM-free nested-
 * directory district geometry for the Workspace File Map.
 *
 * Given the engine's graph it returns:
 *   districts: [{ key, label, depth, parentKey, x, y, w, h,
 *                 directCount, fileCount, langMix, health }]
 *     ordered parents-before-children (safe paint order). fileCount is
 *     subtree-inclusive; langMix is [{ cls, count }] desc by count;
 *     health = { capRed, capAmber, hubs, cycles, orphans } subtree counts.
 *   positions: { [id]: {x, y} }   file-node CENTERS in content space
 *   buckets:   [{ key, label, count }]  ignored-dir rollups — footer chips
 *     in the view (screen space), never fake spatial cards.
 *   bounds:    { minX, minY, maxX, maxY }
 *
 * Directories deeper than MAX_DEPTH flatten into their depth-MAX_DEPTH
 * ancestor: their files join that ancestor's grid, so a pathological deep
 * tree can't nest unreadably. Root files live in the '.' district.
 *
 * Determinism: same graph -> byte-identical output (no Date/random). Kept
 * pure so it unit-tests without a DOM. UMD, mirroring the repo's style.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapAtlasLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // File slot spacing inside a district grid. TILE_W/H is the tiles-tier DOM
  // footprint (CSS keeps in sync); CELL adds breathing room around a tile.
  // Far denser than the old card grid (216x76) — density is the atlas.
  const TILE_W = 132;
  const TILE_H = 26;
  const CELL_W = 144;
  const CELL_H = 34;
  // Space reserved at the top of a district for its label row.
  const DISTRICT_HEADER = 30;
  // Padding inside a district around its content (file grid + children).
  const DISTRICT_PAD = 12;
  // Gap between sibling items (file block / child districts) inside a parent,
  // and between top-level districts.
  const ITEM_GAP = 16;
  const ROOT_GAP = 28;
  // Target width:height ratio for packed content at every level.
  const ASPECT = 1.4;
  // Nesting cap: dirs deeper than this flatten into their depth-cap ancestor.
  const MAX_DEPTH = 3;
  // The repo's file-size policy ceiling (scripts/checks/check_file_size.py);
  // health derivation colors headroom against it. Override via opts.
  const FILE_SIZE_CAP = 1015;
  const CAP_AMBER_HEADROOM = 30;
  const CAP_RED_HEADROOM = 2;

  // Language classing shared with the view (view resolves this module so the
  // dot/tile tint and the district language bar agree on one mapping).
  const LANG_CLASS_RULES = [
    { re: /\.(mjs|cjs|jsx|js)$/i, cls: 'js' },
    { re: /\.(tsx|ts)$/i, cls: 'ts' },
    { re: /\.py$/i, cls: 'py' },
    { re: /\.css$/i, cls: 'css' },
    { re: /\.(html|htm)$/i, cls: 'html' },
    { re: /\.(md|markdown)$/i, cls: 'md' },
    { re: /\.(json|ya?ml|toml)$/i, cls: 'data' },
  ];

  function langClassFor(relPath) {
    for (const rule of LANG_CLASS_RULES) {
      if (rule.re.test(relPath)) return rule.cls;
    }
    return 'other';
  }

  // id -> the district key that owns the file: the dir path truncated to
  // MAX_DEPTH segments; '.' for root files.
  function districtKeyOf(id, maxDepth) {
    const s = String(id == null ? '' : id);
    const slash = s.lastIndexOf('/');
    if (slash === -1) return '.';
    const dir = s.slice(0, slash);
    const segs = dir.split('/');
    const cap = typeof maxDepth === 'number' ? maxDepth : MAX_DEPTH;
    return segs.length <= cap ? dir : segs.slice(0, cap).join('/');
  }

  function lastSegment(key) {
    const slash = key.lastIndexOf('/');
    return slash === -1 ? key : key.slice(slash + 1);
  }

  function makeDistrict(key, depth, parentKey) {
    return {
      key,
      label: key === '.' ? '(root)' : lastSegment(key),
      depth,
      parentKey,
      files: [],
      children: new Map(),
      directCount: 0,
      fileCount: 0,
      langCounts: new Map(),
      health: { capRed: 0, capAmber: 0, hubs: 0, cycles: 0, orphans: 0 },
      // filled by packing:
      x: 0, y: 0, w: 0, h: 0, cells: null, flattened: false,
    };
  }

  // Build the district tree (root sentinel holds depth-1 districts + the '.'
  // district for root files). Every ancestor dir of a file becomes a district
  // even when it has no direct files, so nesting always reads structurally.
  function buildTree(nodes, maxDepth) {
    const rootHolder = makeDistrict('', 0, null);
    const byKey = new Map([['', rootHolder]]);

    function ensure(key) {
      if (byKey.has(key)) return byKey.get(key);
      const segs = key === '.' ? ['.'] : key.split('/');
      const depth = key === '.' ? 1 : segs.length;
      const parentKey = key === '.' || segs.length === 1 ? '' : segs.slice(0, -1).join('/');
      const parent = key === '.' || segs.length === 1 ? rootHolder : ensure(parentKey);
      const d = makeDistrict(key, depth, parent === rootHolder ? null : parentKey);
      parent.children.set(key, d);
      byKey.set(key, d);
      return d;
    }

    for (const node of nodes) {
      const key = districtKeyOf(node.id, maxDepth);
      const d = ensure(key);
      d.files.push(node);
      const fullDir = String(node.id).slice(0, String(node.id).lastIndexOf('/'));
      if (key !== '.' && fullDir.length > key.length) d.flattened = true;
    }
    return { rootHolder, byKey };
  }

  // Subtree aggregates: fileCount, langCounts, health — post-order.
  function aggregate(district, findingSets, cap) {
    district.directCount = district.files.length;
    let total = district.files.length;
    for (const file of district.files) {
      const cls = langClassFor(file.id);
      district.langCounts.set(cls, (district.langCounts.get(cls) || 0) + 1);
      const headroom = cap - (Number(file.loc) || 0);
      if (headroom <= CAP_RED_HEADROOM) district.health.capRed += 1;
      else if (headroom < CAP_AMBER_HEADROOM) district.health.capAmber += 1;
      if (findingSets.hubs.has(file.id)) district.health.hubs += 1;
      if (findingSets.cycles.has(file.id)) district.health.cycles += 1;
      if (findingSets.orphans.has(file.id)) district.health.orphans += 1;
    }
    for (const child of district.children.values()) {
      aggregate(child, findingSets, cap);
      total += child.fileCount;
      for (const [cls, n] of child.langCounts) {
        district.langCounts.set(cls, (district.langCounts.get(cls) || 0) + n);
      }
      for (const k of Object.keys(district.health)) {
        district.health[k] += child.health[k];
      }
    }
    district.fileCount = total;
  }

  // Grid a district's DIRECT files into near-square local cells.
  function gridFiles(district) {
    const n = district.files.length;
    if (!n) {
      district.cells = [];
      district.gridW = 0;
      district.gridH = 0;
      return;
    }
    district.files.sort((a, b) => {
      const di = (b.importance || 0) - (a.importance || 0);
      if (di !== 0) return di;
      return String(a.id).localeCompare(String(b.id));
    });
    const cols = Math.max(1, Math.ceil(Math.sqrt((n * CELL_H) / CELL_W)));
    const rows = Math.ceil(n / cols);
    district.cells = district.files.map((node, i) => ({
      node,
      lx: (i % cols) * CELL_W + CELL_W / 2,
      ly: Math.floor(i / cols) * CELL_H + CELL_H / 2,
    }));
    district.gridW = cols * CELL_W;
    district.gridH = rows * CELL_H;
  }

  // Shelf-pack rectangles (w/h in) left-to-right into rows targeting ASPECT.
  // Mutates each item's px/py (local offsets). Returns the packed extent.
  function shelfPack(items, gap) {
    if (!items.length) return { w: 0, h: 0 };
    const totalArea = items.reduce((s, it) => s + it.w * it.h, 0);
    const maxW = items.reduce((m, it) => Math.max(m, it.w), 0);
    const targetW = Math.max(maxW, Math.ceil(Math.sqrt(totalArea * ASPECT)));
    let cursorX = 0;
    let shelfY = 0;
    let shelfH = 0;
    let extentW = 0;
    for (const it of items) {
      if (cursorX > 0 && cursorX + it.w > targetW) {
        shelfY += shelfH + gap;
        cursorX = 0;
        shelfH = 0;
      }
      it.px = cursorX;
      it.py = shelfY;
      shelfH = Math.max(shelfH, it.h);
      cursorX += it.w + gap;
      extentW = Math.max(extentW, cursorX - gap);
    }
    return { w: extentW, h: shelfY + shelfH };
  }

  // Post-order sizing: children first, then pack [file grid, ...children]
  // inside this district. Children sort by subtree size desc (better packing)
  // then key asc (deterministic).
  function sizeDistrict(district) {
    gridFiles(district);
    const children = Array.from(district.children.values()).sort((a, b) => {
      const df = b.fileCount - a.fileCount;
      return df !== 0 ? df : a.key.localeCompare(b.key);
    });
    for (const child of children) sizeDistrict(child);
    const items = [];
    if (district.gridW > 0) {
      items.push({ kind: 'grid', w: district.gridW, h: district.gridH });
    }
    for (const child of children) {
      items.push({ kind: 'district', district: child, w: child.w, h: child.h });
    }
    const packed = shelfPack(items, ITEM_GAP);
    district.items = items;
    district.w = Math.max(packed.w, 0) + 2 * DISTRICT_PAD;
    district.h = DISTRICT_HEADER + Math.max(packed.h, 0) + DISTRICT_PAD;
    // A district with no content at all (defensive) still gets a visible box.
    if (!items.length) {
      district.w = Math.max(district.w, 2 * DISTRICT_PAD + CELL_W);
      district.h = Math.max(district.h, DISTRICT_HEADER + DISTRICT_PAD + CELL_H);
    }
  }

  // Pre-order placement: assign absolute x/y from parent origin + packed
  // local offsets, emit positions for this district's file cells.
  function placeDistrict(district, originX, originY, positions, out) {
    district.x = originX;
    district.y = originY;
    out.push(district);
    const contentX = originX + DISTRICT_PAD;
    const contentY = originY + DISTRICT_HEADER;
    for (const it of district.items) {
      if (it.kind === 'grid') {
        for (const cell of district.cells) {
          positions[cell.node.id] = {
            x: contentX + it.px + cell.lx,
            y: contentY + it.py + cell.ly,
          };
        }
      } else {
        placeDistrict(it.district, contentX + it.px, contentY + it.py, positions, out);
      }
    }
  }

  function toLangMix(langCounts) {
    return Array.from(langCounts.entries())
      .map(([cls, count]) => ({ cls, count }))
      .sort((a, b) => (b.count - a.count) || a.cls.localeCompare(b.cls));
  }

  // graph: { nodes, findings? } (engine shape). opts: { maxDepth?, fileSizeCap? }.
  function layout(graph, opts) {
    const o = opts || {};
    const cap = Number(o.fileSizeCap) > 0 ? Number(o.fileSizeCap) : FILE_SIZE_CAP;
    const maxDepth = Number(o.maxDepth) > 0 ? Number(o.maxDepth) : MAX_DEPTH;
    const allNodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];

    const buckets = [];
    const fileNodes = [];
    for (const node of allNodes) {
      if (!node || node.id == null) continue;
      if (node.bucket === true) {
        buckets.push({
          key: String(node.dir || node.id),
          label: String(node.label || node.dir || node.id),
          count: Number(node.count) || 0,
        });
      } else {
        fileNodes.push(node);
      }
    }
    buckets.sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key));

    if (!fileNodes.length) {
      return {
        districts: [],
        positions: {},
        buckets,
        bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      };
    }

    const findings = (graph && graph.findings) || {};
    const findingSets = {
      hubs: new Set(Array.isArray(findings.hubs) ? findings.hubs : []),
      cycles: new Set(Array.isArray(findings.cycles) ? findings.cycles.flat() : []),
      orphans: new Set(Array.isArray(findings.orphans) ? findings.orphans : []),
    };

    const { rootHolder } = buildTree(fileNodes, maxDepth);
    aggregate(rootHolder, findingSets, cap);

    // Size + pack the top level: the root holder's children ARE the top-level
    // districts; pack them with the wider ROOT_GAP and no enclosing frame.
    const topLevel = Array.from(rootHolder.children.values()).sort((a, b) => {
      const df = b.fileCount - a.fileCount;
      return df !== 0 ? df : a.key.localeCompare(b.key);
    });
    for (const d of topLevel) sizeDistrict(d);
    const topItems = topLevel.map((d) => ({ kind: 'district', district: d, w: d.w, h: d.h }));
    shelfPack(topItems, ROOT_GAP);

    const positions = {};
    const districts = [];
    for (const it of topItems) {
      placeDistrict(it.district, it.px, it.py, positions, districts);
    }

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const d of districts) {
      if (d.depth > 1) continue; // top-level rects already enclose children
      minX = Math.min(minX, d.x);
      minY = Math.min(minY, d.y);
      maxX = Math.max(maxX, d.x + d.w);
      maxY = Math.max(maxY, d.y + d.h);
    }

    // Public district shape: strip builder internals.
    const publicDistricts = districts.map((d) => ({
      key: d.key,
      label: d.label,
      depth: d.depth,
      parentKey: d.parentKey,
      x: d.x,
      y: d.y,
      w: d.w,
      h: d.h,
      directCount: d.directCount,
      fileCount: d.fileCount,
      flattened: d.flattened === true,
      langMix: toLangMix(d.langCounts),
      health: { ...d.health },
    }));

    return { districts: publicDistricts, positions, buckets, bounds: { minX, minY, maxX, maxY } };
  }

  return {
    layout,
    langClassFor,
    districtKeyOf,
    TILE_W,
    TILE_H,
    CELL_W,
    CELL_H,
    DISTRICT_HEADER,
    DISTRICT_PAD,
    ITEM_GAP,
    ROOT_GAP,
    ASPECT,
    MAX_DEPTH,
    FILE_SIZE_CAP,
  };
});
