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
  assert.equal(root.label, '(root)');
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
