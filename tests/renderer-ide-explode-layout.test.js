'use strict';

/* Pure unit tests for renderer-ide-explode-layout: zone lanes ordered
 * imports->data->functions->entry, within-lane vertical centering by rank,
 * gap-free columns when zones are absent, finite bounds, and the empty case. */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { layout, ZONE_ORDER } = require(path.join(__dirname, '..', 'renderer', 'features', 'renderer-ide-explode-layout.js'));

test('empty graph -> empty positions/bands and zero bounds', () => {
  const r = layout({ nodes: [] });
  assert.deepEqual(r.positions, {});
  assert.deepEqual(r.bands, []);
  assert.deepEqual(r.bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
});

test('lanes are ordered imports -> data -> functions -> entry, left to right', () => {
  const r = layout({ nodes: [
    { id: 'entry:e@0', zone: 'entry', rank: 0 },
    { id: 'func:f@0', zone: 'functions', rank: 0 },
    { id: 'data:d@0', zone: 'data', rank: 0 },
    { id: 'imp:i@0', zone: 'imports', rank: 0 },
  ] });
  assert.deepEqual(r.bands.map((b) => b.zone), ['imports', 'data', 'functions', 'entry']);
  // strictly increasing lane x (band left edges)
  const xs = r.bands.map((b) => b.x);
  for (let i = 1; i < xs.length; i += 1) assert.ok(xs[i] > xs[i - 1], 'lane x increases');
  assert.deepEqual(ZONE_ORDER, ['imports', 'data', 'functions', 'entry']);
});

test('absent zones leave no gap (columns compact)', () => {
  const r = layout({ nodes: [
    { id: 'imp:i@0', zone: 'imports', rank: 0 },
    { id: 'entry:e@0', zone: 'entry', rank: 0 },
  ] });
  // Only two lanes; imports at column 0, entry at column 1 — adjacent, no gap.
  assert.equal(r.bands.length, 2);
  assert.equal(r.positions['imp:i@0'].x, 0);
  assert.ok(r.positions['entry:e@0'].x > 0);
  // Exactly one column-width apart.
  assert.equal(r.positions['entry:e@0'].x, r.bands[1].x + (r.bands[1].w / 2));
});

test('within a lane, nodes are vertically centered around 0 and ordered by rank', () => {
  const r = layout({ nodes: [
    { id: 'f:a@0', zone: 'functions', rank: 0 },
    { id: 'f:b@0', zone: 'functions', rank: 1 },
    { id: 'f:c@0', zone: 'functions', rank: 2 },
  ] });
  const ys = ['f:a@0', 'f:b@0', 'f:c@0'].map((id) => r.positions[id].y);
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2], 'rank order = top to bottom');
  assert.equal(ys[1], 0, 'the middle node centers on 0');
  assert.equal(ys[0], -ys[2], 'symmetric about center');
});

test('bounds are finite and enclose all lanes', () => {
  const r = layout({ nodes: [
    { id: 'imp:i@0', zone: 'imports', rank: 0 },
    { id: 'f:a@0', zone: 'functions', rank: 0 },
    { id: 'f:b@0', zone: 'functions', rank: 1 },
  ] });
  assert.ok(Object.values(r.bounds).every(Number.isFinite));
  assert.ok(r.bounds.maxX > r.bounds.minX && r.bounds.maxY > r.bounds.minY);
});

test('unknown zone falls back to functions lane', () => {
  const r = layout({ nodes: [{ id: 'x:x@0', zone: 'nonsense', rank: 0 }] });
  assert.equal(r.bands.length, 1);
  assert.equal(r.bands[0].zone, 'functions');
});
