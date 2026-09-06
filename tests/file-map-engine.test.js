'use strict';

// Engine-unit tests for services/workspace-file-map-engine.js.
// Hand-built { nodes, edges } graphs — no real files, no scan-rules involvement.
// Covers computeImportance (3 ways), findings (cycle/hub/orphan in isolation),
// layout determinism + cycle termination, and the non-git zero-cochange
// sub-case of buildGraph.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildGraph,
  computeImportance,
  findings,
  layout,
  IMPORTANCE_WEIGHTS,
  COCHANGE_MIN,
  HUB_COUNT,
} = require('../services/workspace-file-map-engine');

// A node factory with sensible zero defaults so tests set only what they mean.
function node(id, extra = {}) {
  return {
    id,
    label: id,
    dir: '.',
    isTest: false,
    loc: 0,
    inbound: 0,
    outbound: 0,
    cochangeDegree: 0,
    importance: 0,
    externalRefs: 0,
    x: 0,
    y: 0,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  test('COCHANGE_MIN and HUB_COUNT have the documented defaults', () => {
    assert.equal(COCHANGE_MIN, 2);
    assert.equal(HUB_COUNT, 5);
  });

  test('IMPORTANCE_WEIGHTS sum to 1 and weight import > cochange > loc', () => {
    const { importDegree, cochangeDegree, loc } = IMPORTANCE_WEIGHTS;
    assert.ok(Math.abs(importDegree + cochangeDegree + loc - 1) < 1e-9);
    assert.ok(importDegree > cochangeDegree);
    assert.ok(cochangeDegree > loc);
  });
});

// ---------------------------------------------------------------------------
// computeImportance — three ways
// ---------------------------------------------------------------------------

describe('computeImportance', () => {
  test('(a) import-only graph ranks by import inbound degree', () => {
    // Three nodes, inbound 2/1/0, no cochange, no loc.
    const graph = {
      nodes: [
        node('a', { inbound: 2 }),
        node('b', { inbound: 1 }),
        node('c', { inbound: 0 }),
      ],
      edges: [],
    };
    computeImportance(graph);
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n.importance]));
    // Highest inbound -> importance 1, lowest -> 0, monotonic between.
    assert.equal(byId.a, 1);
    assert.equal(byId.c, 0);
    assert.ok(byId.a > byId.b && byId.b > byId.c);
  });

  test('(b) cochange-only graph (zero import edges) still ranks, never flat', () => {
    // The renderer's own case: no resolvable imports, only cochange coupling.
    const graph = {
      nodes: [
        node('a', { cochangeDegree: 3 }),
        node('b', { cochangeDegree: 1 }),
        node('c', { cochangeDegree: 0 }),
      ],
      edges: [],
    };
    computeImportance(graph);
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n.importance]));
    assert.equal(byId.a, 1);
    assert.equal(byId.c, 0);
    assert.ok(byId.a > byId.b && byId.b > byId.c);
    // Explicitly NOT uniform.
    assert.notEqual(byId.a, byId.b);
  });

  test('(c) neither edge type — differentiates by LOC alone', () => {
    const graph = {
      nodes: [
        node('a', { loc: 100 }),
        node('b', { loc: 50 }),
        node('c', { loc: 0 }),
      ],
      edges: [],
    };
    computeImportance(graph);
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n.importance]));
    assert.equal(byId.a, 1);
    assert.equal(byId.c, 0);
    assert.ok(byId.a > byId.b && byId.b > byId.c);
  });

  test('all-zero graph -> every importance 0, no NaN', () => {
    const graph = {
      nodes: [node('a'), node('b')],
      edges: [],
    };
    computeImportance(graph);
    for (const n of graph.nodes) {
      assert.equal(n.importance, 0);
      assert.ok(!Number.isNaN(n.importance));
    }
  });

  test('single-node graph -> importance 0 (no span), no divide-by-zero', () => {
    const graph = { nodes: [node('solo', { inbound: 5, loc: 99 })], edges: [] };
    computeImportance(graph);
    assert.equal(graph.nodes[0].importance, 0);
  });

  test('empty graph -> returns without throwing', () => {
    const graph = { nodes: [], edges: [] };
    const result = computeImportance(graph);
    assert.equal(result, graph);
    assert.deepEqual(result.nodes, []);
  });

  test('idempotent: computing twice yields identical numbers', () => {
    const mk = () => ({
      nodes: [
        node('a', { inbound: 2, cochangeDegree: 1, loc: 10 }),
        node('b', { inbound: 1, cochangeDegree: 2, loc: 5 }),
        node('c', { inbound: 0, cochangeDegree: 0, loc: 20 }),
      ],
      edges: [],
    });
    const g1 = mk();
    computeImportance(g1);
    const once = g1.nodes.map((n) => n.importance);
    computeImportance(g1);
    const twice = g1.nodes.map((n) => n.importance);
    assert.deepEqual(once, twice);
  });
});

// ---------------------------------------------------------------------------
// findings — cycle / hub / orphan in isolation
// ---------------------------------------------------------------------------

describe('findings', () => {
  test('hubs: top HUB_COUNT by importance desc, ties by id', () => {
    const nodes = [];
    for (let i = 0; i < 7; i += 1) {
      // importance descending by index, but two ties to exercise id tiebreak.
      nodes.push(node(`n${i}`, { importance: i === 6 ? 0.5 : 1 - i * 0.1 }));
    }
    const graph = { nodes, edges: [] };
    const result = findings(graph);
    assert.equal(result.hubs.length, HUB_COUNT);
    // n0 highest importance (1.0).
    assert.equal(result.hubs[0], 'n0');
  });

  test('hubs never exceeds available node count', () => {
    const graph = { nodes: [node('a', { importance: 1 }), node('b', { importance: 0.5 })], edges: [] };
    assert.equal(findings(graph).hubs.length, 2);
  });

  test('cycles: a->b->c->a reports the 3-node cycle (repeated node omitted)', () => {
    const graph = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        { from: 'a', to: 'b', kind: 'import' },
        { from: 'b', to: 'c', kind: 'import' },
        { from: 'c', to: 'a', kind: 'import' },
      ],
    };
    const result = findings(graph);
    assert.equal(result.cycles.length, 1);
    // Canonical rotation leads with lexicographically-smallest id: a,b,c.
    assert.deepEqual(result.cycles[0], ['a', 'b', 'c']);
  });

  test('cycles: cochange edges never form cycles (import-only subgraph)', () => {
    const graph = {
      nodes: [node('a'), node('b')],
      edges: [
        { from: 'a', to: 'b', kind: 'cochange', weight: 3 },
        { from: 'b', to: 'a', kind: 'cochange', weight: 3 },
      ],
    };
    assert.deepEqual(findings(graph).cycles, []);
  });

  test('cycles: two distinct cycles both reported, deduped by rotation', () => {
    const graph = {
      nodes: ['a', 'b', 'x', 'y'].map((id) => node(id)),
      edges: [
        { from: 'a', to: 'b', kind: 'import' },
        { from: 'b', to: 'a', kind: 'import' },
        { from: 'x', to: 'y', kind: 'import' },
        { from: 'y', to: 'x', kind: 'import' },
      ],
    };
    const result = findings(graph);
    assert.equal(result.cycles.length, 2);
  });

  test('orphans: node with zero edges of any kind', () => {
    const graph = {
      nodes: [node('a'), node('b'), node('lonely')],
      edges: [
        { from: 'a', to: 'b', kind: 'import' },
      ],
    };
    assert.deepEqual(findings(graph).orphans, ['lonely']);
  });

  test('orphans: a cochange-only edge disqualifies a node from being an orphan', () => {
    const graph = {
      nodes: [node('a'), node('b')],
      edges: [{ from: 'a', to: 'b', kind: 'cochange', weight: 2 }],
    };
    assert.deepEqual(findings(graph).orphans, []);
  });
});

// ---------------------------------------------------------------------------
// layout — determinism + cycle termination
// ---------------------------------------------------------------------------

describe('layout', () => {
  test('deterministic: same input -> byte-identical output (run twice)', () => {
    const nodes = [
      node('src/a.js', { dir: 'src' }),
      node('src/b.js', { dir: 'src' }),
      node('lib/c.js', { dir: 'lib' }),
    ];
    const edges = [
      { from: 'src/a.js', to: 'src/b.js', kind: 'import' },
      { from: 'src/b.js', to: 'lib/c.js', kind: 'import' },
    ];
    const first = layout(nodes, edges);
    const second = layout(nodes, edges);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  test('terminates on a cyclic import graph and stays deterministic', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [
      { from: 'a', to: 'b', kind: 'import' },
      { from: 'b', to: 'c', kind: 'import' },
      { from: 'c', to: 'a', kind: 'import' },
    ];
    let result;
    assert.doesNotThrow(() => { result = layout(nodes, edges); });
    assert.equal(result.length, 3);
    // No two nodes share the exact same coordinate.
    const coords = new Set(result.map((p) => `${p.x},${p.y}`));
    assert.equal(coords.size, 3);
    assert.equal(JSON.stringify(layout(nodes, edges)), JSON.stringify(result));
  });

  test('empty node list -> empty layout', () => {
    assert.deepEqual(layout([], []), []);
  });

  test('collision offset: two roots in the same dir get distinct y', () => {
    const nodes = [node('src/a.js', { dir: 'src' }), node('src/b.js', { dir: 'src' })];
    const result = layout(nodes, []);
    assert.notEqual(result[0].y, result[1].y);
    assert.equal(result[0].x, result[1].x); // same column
  });
});

// ---------------------------------------------------------------------------
// buildGraph — the non-git zero-cochange sub-case (scenario 14's sibling)
// ---------------------------------------------------------------------------

describe('buildGraph — non-git degradation', () => {
  test('empty cochangeCommits produces zero cochange edges without error', () => {
    const files = ['a.js', 'b.js'];
    const contents = { 'a.js': "import './b.js';\n", 'b.js': 'export const b = 1;\n' };
    const graph = buildGraph({
      files,
      readContent: (p) => contents[p],
      cochangeCommits: [],
    });
    const cochangeEdges = graph.edges.filter((e) => e.kind === 'cochange');
    assert.deepEqual(cochangeEdges, []);
    // The import edge still exists.
    assert.ok(graph.edges.some((e) => e.kind === 'import' && e.from === 'a.js' && e.to === 'b.js'));
    // Every node's cochangeDegree is 0.
    for (const n of graph.nodes) assert.equal(n.cochangeDegree, 0);
  });

  test('omitted cochangeCommits (undefined) degrades to zero cochange edges', () => {
    const graph = buildGraph({
      files: ['x.js'],
      readContent: () => 'const x = 1;\n',
    });
    assert.deepEqual(graph.edges.filter((e) => e.kind === 'cochange'), []);
    assert.equal(graph.meta.total, 1);
    assert.equal(graph.meta.scanned, 1);
  });

  test('unreadable file (reader throws) still creates a node, never fails the scan', () => {
    const graph = buildGraph({
      files: ['good.js', 'bad.js'],
      readContent: (p) => {
        if (p === 'bad.js') throw new Error('EACCES');
        return 'const g = 1;\n';
      },
      cochangeCommits: [],
    });
    const bad = graph.nodes.find((n) => n.id === 'bad.js');
    assert.ok(bad, 'unreadable file still has a node');
    assert.equal(bad.loc, 0);
    assert.equal(bad.outbound, 0);
    // scanned counts only files read without throwing.
    assert.equal(graph.meta.scanned, 1);
    assert.equal(graph.meta.total, 2);
  });
});
