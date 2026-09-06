'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildGraph, findings } = require('../services/workspace-file-map-engine');
const { partitionByKeepSet } = require('../services/workspace-file-map-ignore');

function node(id) {
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
  };
}

test('git keep-set is intersected with the bounded workspace enumeration', () => {
  const result = partitionByKeepSet(
    ['src/a.js', 'src/b.js'],
    new Set(['src/a.js', 'src/b.js', 'generated/one.js', 'generated/two.js'])
  );

  assert.deepEqual(result.included, ['src/a.js', 'src/b.js']);
  assert.equal(result.included.includes('generated/one.js'), false);
});

test('15k linear dependency chain is analyzed iteratively without stack overflow', () => {
  const count = 15_000;
  const nodes = Array.from({ length: count }, (_, index) => node(`n${String(index).padStart(5, '0')}`));
  const edges = [];
  for (let index = 0; index < count - 1; index += 1) {
    edges.push({ from: nodes[index].id, to: nodes[index + 1].id, kind: 'import', weight: 1 });
  }

  let result;
  assert.doesNotThrow(() => { result = findings({ nodes, edges }); });
  assert.deepEqual(result.cycles, []);
  assert.deepEqual(result.orphans, []);
});

test('node, co-change pair, and edge budgets stop work with explicit partial metadata', () => {
  const files = Array.from({ length: 100 }, (_, index) => `f${String(index).padStart(3, '0')}.js`);
  const graph = buildGraph({
    files,
    readContent: () => '',
    cochangeCommits: [
      { hash: 'one', files },
      { hash: 'two', files },
    ],
    budgets: {
      maxNodes: 64,
      maxEdges: 48,
      maxCochangePairs: 32,
      maxFilesPerCommit: 16,
    },
  });

  assert.equal(graph.nodes.length, 64);
  assert.ok(graph.edges.length <= 48);
  assert.equal(graph.meta.partial, true);
  assert.equal(graph.meta.truncated, true);
  assert.ok(graph.meta.truncationReasons.includes('node_limit'));
  assert.ok(graph.meta.truncationReasons.includes('bulk_commit_skipped'));
  assert.equal(graph.meta.budget.nodesSeen, 100);
  assert.equal(graph.meta.budget.nodesAccepted, 64);
  assert.ok(graph.meta.budget.cochangePairsConsidered <= 32);
});

test('node cap stops source enumeration before constructing a full dedupe Set', () => {
  const files = Array.from({ length: 1_000 }, (_, index) => `f${index}.js`);
  Object.defineProperty(files, 65, {
    configurable: true,
    get() {
      throw new Error('source enumerated beyond the node-limit sentinel');
    },
  });

  let graph;
  assert.doesNotThrow(() => {
    graph = buildGraph({ files, readContent: () => '', budgets: { maxNodes: 64 } });
  });
  assert.equal(graph.nodes.length, 64);
  assert.ok(graph.meta.truncationReasons.includes('node_limit'));
});

test('co-change pair and emitted-edge caps are enforced independently', () => {
  const files = Array.from({ length: 8 }, (_, index) => `f${index}.js`);
  const commits = [{ hash: 'one', files }, { hash: 'two', files }];
  const pairLimited = buildGraph({
    files,
    readContent: () => '',
    cochangeCommits: commits,
    budgets: { maxCochangePairs: 10, maxFilesPerCommit: 8 },
  });
  assert.equal(pairLimited.meta.budget.cochangePairsConsidered, 10);
  assert.ok(pairLimited.meta.truncationReasons.includes('cochange_pair_limit'));

  const edgeLimited = buildGraph({
    files,
    readContent: () => '',
    cochangeCommits: commits,
    budgets: { maxEdges: 5, maxCochangePairs: 100, maxFilesPerCommit: 8 },
  });
  assert.equal(edgeLimited.edges.length, 5);
  assert.ok(edgeLimited.meta.truncationReasons.includes('edge_limit'));
});

test('duplicate imports do not consume the unique import-edge budget', () => {
  const graph = buildGraph({
    files: ['a.js', 'b.js', 'c.js'],
    readContent: (relPath) => relPath === 'a.js'
      ? "import './b.js';\nimport './b.js';\nimport './c.js';\n"
      : '',
    budgets: { maxEdges: 2 },
  });

  assert.deepEqual(
    graph.edges.filter((edge) => edge.kind === 'import'),
    [
      { from: 'a.js', to: 'b.js', kind: 'import', weight: 1 },
      { from: 'a.js', to: 'c.js', kind: 'import', weight: 1 },
    ]
  );
});
