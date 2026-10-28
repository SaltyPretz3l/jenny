'use strict';

/* Pure unit tests for renderer-ide-map-atlas-layout: nested district tree
 * (depth cap + flattening), recursive shelf packing with containment and
 * no sibling overlap, subtree aggregates (fileCount/langMix/health),
 * bucket rollups as footer-chip data (never spatial), degenerate repo
 * shapes (flat 1k-file dir, everything-in-root), determinism, and a loose
 * perf bound so a quadratic packing regression can't land silently. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  layout,
  estimateLabelWidth,
  TILE_W,
  TILE_W_MAX,
  WIDE_TILE_LIMIT,
  TILE_CHROME,
  langClassFor,
  districtKeyOf,
  DISTRICT_HEADER,
  DISTRICT_PAD,
  MAX_DEPTH,
  FILE_SIZE_CAP,
} = require(path.join(__dirname, '..', 'renderer', 'features', 'renderer-ide-map-atlas-layout.js'));

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w
    && inner.y + inner.h <= outer.y + outer.h;
}

test('empty graph -> empty districts/positions, zero bounds, buckets pass through', () => {
  const r = layout({ nodes: [] });
  assert.deepEqual(r.districts, []);
  assert.deepEqual(r.positions, {});
  assert.deepEqual(r.buckets, []);
  assert.deepEqual(r.bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });

  const b = layout({ nodes: [{ id: 'node_modules', dir: 'node_modules', label: 'node_modules', bucket: true, count: 5800 }] });
  assert.deepEqual(b.districts, []);
  assert.deepEqual(b.buckets, [{ key: 'node_modules', label: 'node_modules', count: 5800 }]);
});

test('districtKeyOf: dir path capped at MAX_DEPTH segments; "." for root files', () => {
  assert.equal(districtKeyOf('a.js'), '.');
  assert.equal(districtKeyOf('renderer/a.js'), 'renderer');
  assert.equal(districtKeyOf('renderer/features/a.js'), 'renderer/features');
  assert.equal(districtKeyOf('renderer/features/scenes/a.js'), 'renderer/features/scenes');
  assert.equal(districtKeyOf('a/b/c/d/e/f.js'), 'a/b/c');
  assert.equal(districtKeyOf('a/b/c/d/e/f.js', 2), 'a/b');
  assert.equal(MAX_DEPTH, 3);
});

test('nested districts: ancestors exist, parents precede children, children contained', () => {
  const r = layout({ nodes: [
    { id: 'renderer/app.js' },
    { id: 'renderer/features/a.js' },
    { id: 'renderer/features/b.js' },
    { id: 'services/x.js' },
  ] });
  const byKey = new Map(r.districts.map((d) => [d.key, d]));
  assert.ok(byKey.has('renderer'));
  assert.ok(byKey.has('renderer/features'));
  assert.ok(byKey.has('services'));

  const renderer = byKey.get('renderer');
  const features = byKey.get('renderer/features');
  assert.equal(renderer.depth, 1);
  assert.equal(renderer.parentKey, null);
  assert.equal(features.depth, 2);
  assert.equal(features.parentKey, 'renderer');
  assert.equal(features.label, 'features');
  assert.ok(contains(renderer, features), 'child rect inside parent rect');

  const idxParent = r.districts.findIndex((d) => d.key === 'renderer');
  const idxChild = r.districts.findIndex((d) => d.key === 'renderer/features');
  assert.ok(idxParent < idxChild, 'paint order: parent before child');
});

test('every file gets a finite center inside its owning district content area', () => {
  const nodes = [
    { id: 'renderer/app.js' },
    { id: 'renderer/features/a.js' },
    { id: 'deep/x/y/z/q/file.js' },
    { id: 'root.js' },
  ];
  const r = layout({ nodes });
  const byKey = new Map(r.districts.map((d) => [d.key, d]));
  for (const n of nodes) {
    const p = r.positions[n.id];
    assert.ok(p && Number.isFinite(p.x) && Number.isFinite(p.y), `position for ${n.id}`);
    const owner = byKey.get(districtKeyOf(n.id));
    assert.ok(owner, `owning district for ${n.id}`);
    assert.ok(p.x > owner.x + DISTRICT_PAD / 2 && p.x < owner.x + owner.w, 'x within district');
    assert.ok(p.y > owner.y + DISTRICT_HEADER / 2 && p.y < owner.y + owner.h, 'y below header');
  }
});

test('deep dirs flatten into the depth-cap ancestor and mark it flattened', () => {
  const r = layout({ nodes: [
    { id: 'a/b/c/d/e/f.js' },
    { id: 'a/b/c/direct.js' },
  ] });
  const keys = r.districts.map((d) => d.key);
  assert.ok(keys.includes('a/b/c'));
  assert.ok(!keys.some((k) => k.startsWith('a/b/c/')), 'nothing deeper than the cap');
  const flat = r.districts.find((d) => d.key === 'a/b/c');
  assert.equal(flat.flattened, true);
  assert.equal(flat.directCount, 2);
});

test('sibling top-level districts never overlap; bounds enclose them all', () => {
  const nodes = [];
  for (const top of ['renderer', 'services', 'tests', 'styles', 'docs']) {
    for (let i = 0; i < 12; i += 1) nodes.push({ id: `${top}/f${i}.js` });
  }
  const r = layout({ nodes });
  const tops = r.districts.filter((d) => d.depth === 1);
  assert.equal(tops.length, 5);
  for (let i = 0; i < tops.length; i += 1) {
    for (let j = i + 1; j < tops.length; j += 1) {
      assert.ok(!overlaps(tops[i], tops[j]), `${tops[i].key} overlaps ${tops[j].key}`);
    }
    assert.ok(tops[i].x >= r.bounds.minX && tops[i].y >= r.bounds.minY);
    assert.ok(tops[i].x + tops[i].w <= r.bounds.maxX);
    assert.ok(tops[i].y + tops[i].h <= r.bounds.maxY);
  }
});

test('subtree aggregates: fileCount, langMix, directCount', () => {
  const r = layout({ nodes: [
    { id: 'renderer/app.js' },
    { id: 'renderer/features/a.js' },
    { id: 'renderer/features/b.py' },
    { id: 'renderer/features/c.css' },
  ] });
  const byKey = new Map(r.districts.map((d) => [d.key, d]));
  const renderer = byKey.get('renderer');
  assert.equal(renderer.directCount, 1);
  assert.equal(renderer.fileCount, 4);
  const mix = Object.fromEntries(renderer.langMix.map((m) => [m.cls, m.count]));
  assert.deepEqual(mix, { js: 2, py: 1, css: 1 });
  assert.equal(renderer.langMix[0].cls, 'js', 'langMix sorted desc by count');
});

test('health: cap headroom + findings roll up per subtree', () => {
  const r = layout({
    nodes: [
      { id: 'renderer/red.js', loc: FILE_SIZE_CAP - 1 },
      { id: 'renderer/amber.js', loc: FILE_SIZE_CAP - 10 },
      { id: 'renderer/green.js', loc: 10 },
      { id: 'renderer/sub/hub.js', loc: 10 },
    ],
    findings: {
      hubs: ['renderer/sub/hub.js'],
      cycles: [['renderer/red.js', 'renderer/green.js']],
      orphans: ['renderer/amber.js'],
    },
  });
  const renderer = r.districts.find((d) => d.key === 'renderer');
  assert.deepEqual(renderer.health, { capRed: 1, capAmber: 1, hubs: 1, cycles: 2, orphans: 1 });
  const sub = r.districts.find((d) => d.key === 'renderer/sub');
  assert.deepEqual(sub.health, { capRed: 0, capAmber: 0, hubs: 1, cycles: 0, orphans: 0 });
});

test('buckets: excluded from spatial layout, sorted by count desc', () => {
  const r = layout({ nodes: [
    { id: 'renderer/a.js' },
    { id: 'node_modules', dir: 'node_modules', label: 'node_modules', bucket: true, count: 5800 },
    { id: 'dist', dir: 'dist', label: 'dist', bucket: true, count: 1200 },
    { id: 'docs/archive', dir: 'docs/archive', label: 'docs/archive', bucket: true, count: 9000 },
  ] });
  assert.equal(r.positions['node_modules'], undefined);
  assert.ok(!r.districts.some((d) => d.key.includes('node_modules')));
  assert.deepEqual(r.buckets.map((b) => b.key), ['docs/archive', 'node_modules', 'dist']);
});

test('degenerate: everything-in-root repo yields one sane "." district', () => {
  const nodes = [];
  for (let i = 0; i < 40; i += 1) nodes.push({ id: `f${i}.js` });
  const r = layout({ nodes });
  assert.equal(r.districts.length, 1);
  const root = r.districts[0];
  assert.equal(root.key, '.');
  assert.equal(root.label, 'Top level');
  assert.equal(root.fileCount, 40);
  assert.ok(root.w > 0 && root.h > 0);
  const xs = new Set(Object.values(r.positions).map((p) => p.x));
  const ys = new Set(Object.values(r.positions).map((p) => p.y));
  assert.ok(xs.size > 1 && ys.size > 1, 'grids into rows AND columns');
});

test('degenerate: flat 1k-file dir positions everyone without overlaps in grid slots', () => {
  const nodes = [];
  for (let i = 0; i < 1000; i += 1) nodes.push({ id: `flat/f${String(i).padStart(4, '0')}.js` });
  const r = layout({ nodes });
  assert.equal(Object.keys(r.positions).length, 1000);
  const seen = new Set();
  for (const p of Object.values(r.positions)) {
    const k = `${p.x}|${p.y}`;
    assert.ok(!seen.has(k), 'no two files share a slot');
    seen.add(k);
  }
});

test('deterministic: same input -> byte-identical output', () => {
  const graph = {
    nodes: [
      { id: 'renderer/features/a.js', importance: 0.5, loc: 40 },
      { id: 'renderer/features/b.js', importance: 0.2, loc: 10 },
      { id: 'renderer/chat/c.js', importance: 0.1, loc: 5 },
      { id: 'services/x.js', importance: 0.9, loc: 100 },
      { id: 'root.js', importance: 0, loc: 1 },
      { id: 'node_modules', bucket: true, count: 10, dir: 'node_modules', label: 'node_modules' },
    ],
    findings: { hubs: ['services/x.js'], cycles: [], orphans: [] },
  };
  assert.equal(JSON.stringify(layout(graph)), JSON.stringify(layout(graph)));
});

test('perf bound: 3k files across ~700 dirs lays out well under 100ms', () => {
  const nodes = [];
  let n = 0;
  for (let top = 0; top < 12 && n < 3000; top += 1) {
    for (let mid = 0; mid < 10 && n < 3000; mid += 1) {
      for (let leaf = 0; leaf < 6 && n < 3000; leaf += 1) {
        for (let f = 0; f < 5 && n < 3000; f += 1, n += 1) {
          nodes.push({ id: `t${top}/m${mid}/l${leaf}/f${f}.js`, importance: (n % 10) / 10, loc: n % 900 });
        }
      }
    }
  }
  layout({ nodes }); // warm-up (jit)
  const start = process.hrtime.bigint();
  const r = layout({ nodes });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(Object.keys(r.positions).length, nodes.length);
  assert.ok(ms < 100, `layout took ${ms.toFixed(1)}ms (bound 100ms)`);
});

test('langClassFor mapping sanity', () => {
  assert.equal(langClassFor('a/b.ts'), 'ts');
  assert.equal(langClassFor('a/b.test.js'), 'js');
  assert.equal(langClassFor('a/b.py'), 'py');
  assert.equal(langClassFor('a/b.yaml'), 'data');
  assert.equal(langClassFor('a/b.unknown'), 'other');
});

// ---- fit pass (2026-10-26): order, wide tiles, header width, fill, aspect ----

function rowMajorIds(r, ids) {
  return ids.slice().sort((a, b) => {
    const pa = r.positions[a];
    const pb = r.positions[b];
    return (pa.y - pb.y) || (pa.x - pb.x);
  });
}

test('constants and default estimator are exported', () => {
  assert.equal(TILE_W, 132);
  assert.equal(TILE_W_MAX, 220);
  assert.equal(WIDE_TILE_LIMIT, 400);
  assert.equal(TILE_CHROME, 30);
  assert.equal(estimateLabelWidth('abcd'), Math.ceil(4 * 7.44));
  assert.equal(estimateLabelWidth(''), 0);
});

test('file order: non-tests then tests, A-Z by label/name within each, importance ignored', () => {
  const nodes = [
    { id: 'd/zeta.js', importance: 1 },
    { id: 'd/alpha.js', importance: 0 },
    { id: 'd/Beta.js', importance: 0.5 },
    { id: 'd/b.test.js', isTest: true, importance: 1 },
    { id: 'd/a.test.js', isTest: true, importance: 0 },
    { id: 'd/q.js', label: 'Aardvark.js' },
  ];
  const r = layout({ nodes });
  assert.deepEqual(rowMajorIds(r, nodes.map((n) => n.id)), [
    'd/q.js', 'd/alpha.js', 'd/Beta.js', 'd/zeta.js', 'd/a.test.js', 'd/b.test.js',
  ]);
});

test('file order: equal labels tie-break on full id', () => {
  const nodes = [
    { id: 'd/y/same.js', label: 'same.js' },
    { id: 'd/x/same.js', label: 'same.js' },
  ];
  // flatten both into one district so the tie-break decides the grid order
  const r = layout({ nodes }, { maxDepth: 1 });
  assert.deepEqual(rowMajorIds(r, nodes.map((n) => n.id)), ['d/x/same.js', 'd/y/same.js']);
});

test('small graph: tile width follows the p75 measured name; clamped to 132..220', () => {
  const m = (t, kind) => (kind === 'tile' ? t.length * 10 : 0);
  const mk = (name, n) => Array.from({ length: n }, (_, i) => ({ id: `d/${name}${i}.js` }));
  // 'abcdefghij0.js' = 14 chars -> 140 + 30 = 170
  let r = layout({ nodes: mk('abcdefghij', 10) }, { measureLabel: m });
  for (const p of Object.values(r.positions)) assert.equal(p.w, 170);
  // very short names clamp up to TILE_W
  r = layout({ nodes: mk('a', 10) }, { measureLabel: m });
  for (const p of Object.values(r.positions)) assert.equal(p.w, TILE_W);
  // very long names clamp down to TILE_W_MAX
  r = layout({ nodes: mk('x'.repeat(60), 10) }, { measureLabel: m });
  for (const p of Object.values(r.positions)) assert.equal(p.w, TILE_W_MAX);
});

test('p75: one long outlier name does not set the district width', () => {
  const m = (t, kind) => (kind === 'tile' ? t.length * 20 : 0);
  const nodes = [];
  for (let i = 0; i < 9; i += 1) nodes.push({ id: `d/aaaa${i}.js` }); // 8 chars -> 160
  nodes.push({ id: `d/${'z'.repeat(40)}.js` }); // 43 chars -> 860
  const r = layout({ nodes }, { measureLabel: m });
  for (const p of Object.values(r.positions)) assert.equal(p.w, 160 + TILE_CHROME);
});

test('tile width is per district and grid cells keep 12px breathing room', () => {
  const m = (t, kind) => (kind === 'tile' ? t.length * 10 : 0);
  const nodes = [];
  for (let i = 0; i < 20; i += 1) nodes.push({ id: `wide/abcdefghij${String(i).padStart(2, '0')}.js` });
  for (let i = 0; i < 20; i += 1) nodes.push({ id: `narrow/n${String(i).padStart(2, '0')}.js` });
  const r = layout({ nodes }, { measureLabel: m });
  // 'abcdefghij00.js' = 15 chars -> 150 + 30 = 180
  assert.equal(r.positions['wide/abcdefghij00.js'].w, 180);
  assert.equal(r.positions['narrow/n00.js'].w, TILE_W);
  const xs = Array.from(new Set(
    Object.keys(r.positions).filter((k) => k.startsWith('wide/')).map((k) => r.positions[k].x),
  )).sort((a, b) => a - b);
  assert.ok(xs.length >= 2);
  assert.equal(xs[1] - xs[0], 180 + 12);
});

test('graphs above WIDE_TILE_LIMIT keep every tile at TILE_W', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `d${i % 4}/${'longname'.repeat(4)}${i}.js` }));
  let r = layout({ nodes: mk(WIDE_TILE_LIMIT) });
  assert.ok(Object.values(r.positions).every((p) => p.w > TILE_W), 'at the limit tiles are wide');
  r = layout({ nodes: mk(WIDE_TILE_LIMIT + 1) });
  assert.ok(Object.values(r.positions).every((p) => p.w === TILE_W), 'above the limit tiles stay 132');
});

test('buckets do not count toward the wide-tile file limit', () => {
  const nodes = Array.from({ length: 5 }, (_, i) => ({ id: `d/${'longname'.repeat(4)}${i}.js` }));
  for (let i = 0; i < 500; i += 1) nodes.push({ id: `b${i}`, dir: `b${i}`, bucket: true, count: 3 });
  const r = layout({ nodes });
  assert.ok(Object.values(r.positions).every((p) => p.w > TILE_W));
});

test('positions carry w for every file', () => {
  const r = layout({ nodes: [{ id: 'a.js' }, { id: 'x/b.js' }] });
  for (const p of Object.values(r.positions)) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.w));
    assert.ok(p.w >= TILE_W && p.w <= TILE_W_MAX);
  }
});

test('district is at least as wide as its header row', () => {
  const name = 'verylongdirectoryname';
  const r = layout({ nodes: [{ id: `${name}/f.js` }] });
  const d = r.districts[0];
  // Header chrome is measured as 14 header-font digits, so it scales with the font.
  assert.equal(d.w, estimateLabelWidth(`${name}/`) + estimateLabelWidth('0'.repeat(14)));
  assert.ok(d.w > 2 * DISTRICT_PAD + 144, 'header, not the grid, set the width');
  const hdr = [];
  layout({ nodes: [{ id: `${name}/f.js` }, { id: 'f.js' }] }, {
    measureLabel: (t, kind) => { if (kind === 'header') hdr.push(t); return t.length * 7; },
  });
  assert.ok(hdr.includes(`${name}/`), 'normal districts measure "label/"');
  assert.ok(hdr.includes('Top level'), 'root district measures its label without a slash');
});

test('header minimum widens the root district too', () => {
  const measureLabel = (t, kind) => (kind !== 'header' ? 0 : /^0+$/.test(t) ? 100 : 500);
  const r = layout({ nodes: [{ id: 'f.js' }] }, { measureLabel });
  assert.equal(r.districts[0].w, 500 + 100);
});

function fourTops() {
  return { nodes: ['d0', 'd1', 'd2', 'd3'].map((d) => ({ id: `${d}/f.js` })) };
}

test('top level fills one row when availWidth is wide enough, wraps when narrow', () => {
  const g = fourTops();
  const wide = layout(g, { availWidth: 4000 });
  const tops = wide.districts.filter((d) => d.depth === 1);
  assert.equal(new Set(tops.map((d) => d.y)).size, 1, 'one row');
  const narrow = layout(g, { availWidth: 400 });
  const ntops = narrow.districts.filter((d) => d.depth === 1);
  assert.ok(new Set(ntops.map((d) => d.y)).size >= 2, 'wraps when the row does not fit');
  assert.ok(Math.max(...ntops.map((d) => d.x + d.w)) <= 400, 'respects availWidth');
  const noFill = layout(g, {});
  assert.ok(new Set(noFill.districts.map((d) => d.y)).size > 1, 'without availWidth the 1.4 aspect pack applies');
});

test('aspect option clamps to [0.6, 3.2]; invalid falls back to 1.4', () => {
  const nodes = [];
  for (let t = 0; t < 12; t += 1) for (let i = 0; i < 20; i += 1) nodes.push({ id: `t${t}/f${i}.js` });
  const g = { nodes };
  const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
  same(layout(g, { aspect: 100 }), layout(g, { aspect: 3.2 }));
  same(layout(g, { aspect: 0.01 }), layout(g, { aspect: 0.6 }));
  same(layout(g, { aspect: -2 }), layout(g, {}));
  same(layout(g, { aspect: 'x' }), layout(g, {}));
  same(layout(g, { aspect: 1.4 }), layout(g, {}));
  const wideB = layout(g, { aspect: 3.2 }).bounds;
  const tallB = layout(g, { aspect: 0.6 }).bounds;
  assert.ok((wideB.maxX - wideB.minX) > (tallB.maxX - tallB.minX), 'larger aspect packs wider');
});

test('nested districts ignore opts.aspect and availWidth', () => {
  const nodes = [];
  for (const sub of ['a', 'b', 'c']) for (let i = 0; i < 30; i += 1) nodes.push({ id: `top/${sub}/f${i}.js` });
  const base = layout({ nodes }, {});
  const tuned = layout({ nodes }, { aspect: 3.2, availWidth: 5000 });
  assert.equal(tuned.districts.find((d) => d.key === 'top').w, base.districts.find((d) => d.key === 'top').w);
});

test('deterministic with opts: same input + opts -> deep-equal output twice', () => {
  const nodes = [];
  for (let i = 0; i < 60; i += 1) {
    nodes.push({ id: `d${i % 5}/s${i % 3}/file${i}.js`, isTest: i % 7 === 0, loc: i });
  }
  const opts = { aspect: 1.9, availWidth: 1500, measureLabel: (t, k) => t.length * (k === 'tile' ? 8 : 9) };
  assert.deepEqual(layout({ nodes }, opts), layout({ nodes }, opts));
});

test('custom measureLabel is honoured for both kinds', () => {
  const kinds = new Set();
  layout({ nodes: [{ id: 'dir/a.js' }] }, { measureLabel: (t, k) => { kinds.add(k); return 1; } });
  assert.ok(kinds.has('tile') && kinds.has('header'));
  const wide = layout({ nodes: [{ id: 'dir/a.js' }] }, { measureLabel: (t, k) => (k === 'tile' ? 150 : 1) });
  assert.equal(wide.positions['dir/a.js'].w, 180);
});
