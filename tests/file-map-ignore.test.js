'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  partitionByKeepSet,
  fallbackPartition,
  buildBucketNodes,
} = require('../services/workspace-file-map-ignore');

describe('workspace-file-map-ignore — partitionByKeepSet', () => {
  test('included is the sorted bounded-enumeration intersection; ignored files are bucketed', () => {
    const allFiles = [
      'src/a.js', 'src/b.js',
      'node_modules/pkg/index.js', 'node_modules/pkg/lib/x.js',
      'artifacts/out.bin', 'artifacts/log/trace.txt',
      'dist/bundle.js',
      '.gitignore',
    ];
    const keepSet = new Set(['src/b.js', 'src/a.js', '.gitignore']);

    const { included, buckets } = partitionByKeepSet(allFiles, keepSet);

    assert.deepEqual(included, ['.gitignore', 'src/a.js', 'src/b.js'], 'included is the intersection, sorted');
    assert.deepEqual(buckets, [
      { dir: 'artifacts', count: 2 },
      { dir: 'dist', count: 1 },
      { dir: 'node_modules', count: 2 },
    ]);
  });

  test('a keepSet file absent from the bounded enumeration cannot bypass its cap', () => {
    const allFiles = ['src/a.js'];
    const keepSet = new Set(['src/a.js', 'generated/only-in-keepset.js']);

    const { included, buckets } = partitionByKeepSet(allFiles, keepSet);

    assert.deepEqual(included, ['src/a.js']);
    assert.deepEqual(buckets, [], 'nothing in allFiles is unaccounted for, so no buckets');
  });

  test('a partial dir buckets only its fully-excluded subtree, never the top-level dir', () => {
    // docs/ holds tracked source (docs/manifests/*) AND ignored files
    // (docs/archive/*); vendor/ likewise. The excluded subtrees must bucket as
    // docs/archive and vendor/unsloth — NOT as top-level `docs`/`vendor`
    // buckets that would collide with those dirs' real folder regions.
    const allFiles = [
      'docs/manifests/wiring.md',
      'docs/archive/old-a.md', 'docs/archive/old-b.md',
      'vendor/keep.js',
      'vendor/unsloth/model.bin', 'vendor/unsloth/nested/w.bin',
      'node_modules/pkg/index.js',
    ];
    const keepSet = new Set(['docs/manifests/wiring.md', 'vendor/keep.js']);

    const { included, buckets } = partitionByKeepSet(allFiles, keepSet);

    assert.deepEqual(included, ['docs/manifests/wiring.md', 'vendor/keep.js']);
    assert.deepEqual(buckets, [
      { dir: 'docs/archive', count: 2 },
      { dir: 'node_modules', count: 1 },
      { dir: 'vendor/unsloth', count: 2 },
    ]);
  });

  test('root-level ignored files and files sitting directly in a partial dir fold into one "." bucket', () => {
    // preload.bundle.js is a root ignored file; tests/.last-run.json sits
    // directly inside the partial `tests` dir (which has tracked source) with no
    // fully-excluded subtree of its own. Both fold into the single '.' catch-all
    // rather than emitting a `tests` bucket that collides with the tests region.
    const allFiles = [
      'tests/real.test.js',
      'preload.bundle.js', 'model.gguf',
      'tests/.last-run.json',
    ];
    const keepSet = new Set(['tests/real.test.js']);

    const { included, buckets } = partitionByKeepSet(allFiles, keepSet);

    assert.deepEqual(included, ['tests/real.test.js']);
    assert.deepEqual(buckets, [{ dir: '.', count: 3 }]);
  });

  test('deterministic across repeated calls with the same inputs', () => {
    const allFiles = ['b/x.js', 'a/y.js', 'a/z.js', 'root.js'];
    const keepSet = new Set();
    const first = partitionByKeepSet(allFiles, keepSet);
    const second = partitionByKeepSet(allFiles, keepSet);
    assert.deepEqual(first, second);
    assert.deepEqual(first.included, []);
    assert.deepEqual(first.buckets, [
      { dir: '.', count: 1 },
      { dir: 'a', count: 2 },
      { dir: 'b', count: 1 },
    ]);
  });
});

describe('workspace-file-map-ignore — fallbackPartition', () => {
  test('node_modules/dist/binary files are skipped and bucketed; source files are kept in input order', () => {
    const allFiles = [
      'src/a.js',
      'node_modules/pkg/index.js',
      'src/b.ts',
      'dist/bundle.js',
      'assets/logo.png',
      'src/c.js',
      'build/out.txt',
    ];
    const { included, buckets } = fallbackPartition(allFiles);

    assert.deepEqual(included, ['src/a.js', 'src/b.ts', 'src/c.js'], 'source files preserve input read order');
    assert.deepEqual(buckets, [
      { dir: 'assets', count: 1 },
      { dir: 'build', count: 1 },
      { dir: 'dist', count: 1 },
      { dir: 'node_modules', count: 1 },
    ]);
  });

  test('a denylisted directory nested deeper than the top level buckets under its excluded subtree', () => {
    // pkg/ is partial (pkg/src/y.js is kept), so its excluded pkg/node_modules
    // subtree buckets as `pkg/node_modules` — not a top-level `pkg` bucket that
    // would collide with pkg's own source region.
    const allFiles = ['pkg/node_modules/x.js', 'pkg/src/y.js'];
    const { included, buckets } = fallbackPartition(allFiles);
    assert.deepEqual(included, ['pkg/src/y.js']);
    assert.deepEqual(buckets, [{ dir: 'pkg/node_modules', count: 1 }]);
  });

  test('a binary/lock extension is skipped regardless of directory, bucketed under its own top-level dir', () => {
    const allFiles = ['icon.ico', 'index.js', 'yarn.lock', 'src/photo.jpeg'];
    const { included, buckets } = fallbackPartition(allFiles);
    assert.deepEqual(included, ['index.js']);
    assert.deepEqual(buckets, [
      { dir: '.', count: 2 },
      { dir: 'src', count: 1 },
    ]);
  });

  test('an empty input produces empty included and buckets', () => {
    assert.deepEqual(fallbackPartition([]), { included: [], buckets: [] });
  });
});

describe('workspace-file-map-ignore — buildBucketNodes', () => {
  test('produces the full engine node shape plus bucket:true and count, ordered by dir', () => {
    const buckets = [
      { dir: '.', count: 1 },
      { dir: 'dist', count: 3 },
      { dir: 'node_modules', count: 40 },
    ];
    const nodes = buildBucketNodes(buckets);
    assert.deepEqual(nodes, [
      {
        id: 'bucket:.', label: '(ignored)', dir: '.', isTest: false, loc: 0, inbound: 0, outbound: 0,
        cochangeDegree: 0, importance: 0, externalRefs: 0, x: 0, y: 0, bucket: true, count: 1,
      },
      {
        id: 'bucket:dist', label: 'dist', dir: 'dist', isTest: false, loc: 0, inbound: 0, outbound: 0,
        cochangeDegree: 0, importance: 0, externalRefs: 0, x: 0, y: 0, bucket: true, count: 3,
      },
      {
        id: 'bucket:node_modules', label: 'node_modules', dir: 'node_modules', isTest: false, loc: 0,
        inbound: 0, outbound: 0, cochangeDegree: 0, importance: 0, externalRefs: 0, x: 0, y: 0,
        bucket: true, count: 40,
      },
    ]);
  });

  test('an empty buckets list produces an empty node list', () => {
    assert.deepEqual(buildBucketNodes([]), []);
  });
});
