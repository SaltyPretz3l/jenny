'use strict';

// Row 77: the File Map Components draft (services/workspace-file-map-
// components{,-names,-fold}.js), a port of CodeBoarding's name-tree grouping.
// Hand-built graphs: file ids plus import edges, no real files.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  LIMIT,
  classifyPath,
  draftComponents,
} = require('../services/workspace-file-map-components');
const { replay, stem, tokenize, unitsFromPaths } = require('../services/workspace-file-map-components-names');
const { MAX_FOLD_GROUPS, nameOf } = require('../services/workspace-file-map-components-fold');

function graph(files, imports = []) {
  return {
    nodes: files.map((id) => ({ id })),
    edges: imports.map(([from, to]) => ({ from, to, kind: 'import', weight: 1 })),
  };
}

function range(prefix, count, ext = '.js') {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}${ext}`);
}

function roots(result) {
  return result.components.filter((c) => c.parentId === null);
}

function children(result, parentId) {
  return result.components.filter((c) => c.parentId === parentId);
}

// Only leaves list their files (phase 2); a box's files are its leaves'.
function filesOf(result, component) {
  const kids = children(result, component.id);
  return kids.length ? kids.flatMap((kid) => filesOf(result, kid)) : component.files;
}

describe('words', () => {
  test('stem folds inflections and keeps singular -s words', () => {
    assert.equal(stem('services'), 'service');
    assert.equal(stem('Ordering'), 'order');
    assert.equal(stem('Mappings'), stem('Mapping'));
    assert.equal(stem('analysis'), 'analysis');
    assert.equal(stem('status'), 'status');
  });

  test('tokenize splits camel case, capital runs and separators', () => {
    assert.deepEqual(tokenize('HTTPServer'), ['HTTP', 'Server']);
    assert.deepEqual(tokenize('renderer-ide_map2'), ['renderer', 'ide', 'map2']);
    assert.deepEqual(tokenize('IOrderService'), ['Order', 'Service']);
  });
});

describe('classifyPath (D14)', () => {
  test('partitions source code only', () => {
    assert.equal(classifyPath('src/app.js'), 'source');
    assert.equal(classifyPath('sidecar/ai/router.py'), 'source');
    assert.equal(classifyPath('styles/chat.css'), 'source');
    assert.equal(classifyPath('tests/app.test.js'), 'tests');
    assert.equal(classifyPath('src/app.spec.ts'), 'tests');
    assert.equal(classifyPath('pkg/test_router.py'), 'tests');
    assert.equal(classifyPath('src/__mocks__/fs.js'), 'tests');
    assert.equal(classifyPath('docs/guide.md'), 'docs');
    assert.equal(classifyPath('README.md'), 'docs');
    assert.equal(classifyPath('package.json'), 'other');
    assert.equal(classifyPath('.github/scripts/ci.js'), 'other');
    assert.equal(classifyPath('dist/bundle.js'), 'other');
    assert.equal(classifyPath('webpack.config.js'), 'other');
    assert.equal(classifyPath('vendor/lib.min.js'), 'other');
  });
});

describe('draftComponents', () => {
  test('an empty graph draws nothing', () => {
    const result = draftComponents(graph([]));
    assert.deepEqual(result.components, []);
    assert.deepEqual(result.outside, []);
    assert.equal(result.scopes[0].rung, 'leaf');
  });

  test('directories are the boxes, and a wrapping src/ is stepped through', () => {
    const files = [...range('src/app/a', 4), ...range('src/lib/b', 4), ...range('src/util/c', 4)];
    const result = draftComponents(graph(files));
    assert.deepEqual(roots(result).map((c) => [c.name, c.fileCount]), [['app', 4], ['lib', 4], ['util', 4]]);
    assert.deepEqual(roots(result).map((c) => c.label), [
      { kind: 'folder', text: 'app' }, { kind: 'folder', text: 'lib' }, { kind: 'folder', text: 'util' },
    ]);
    assert.equal(result.scopes[0].axis, 'structural');
  });

  test('a small box opening onto at most seven files is a leaf with a reason', () => {
    const files = [...range('app/a', 4), ...range('lib/b', 4)];
    const result = draftComponents(graph(files), { maxDepth: 2 });
    const app = roots(result).find((c) => c.name === 'app');
    const scope = result.scopes.find((s) => s.id === app.id);
    assert.equal(scope.rung, 'leaf');
    assert.match(scope.leafReason, /^small: 4 files, at most 7/);
    assert.equal(scope.leafKind, 'small');
    assert.equal(result.scopes[0].leafKind, '', 'a drafted scope has no leaf kind');
  });

  test('kinship merges directories that share their distinctive word', () => {
    const files = [...range('ordering/a', 3), ...range('order-processor/b', 3), ...range('billing/c', 3)];
    const result = draftComponents(graph(files));
    const sizes = roots(result).map((c) => c.fileCount).sort((a, b) => a - b);
    assert.deepEqual(sizes, [3, 6]);
    const merged = roots(result).find((c) => c.fileCount === 6);
    assert.equal(merged.origin, 'grouped');
    assert.deepEqual(merged.parts.slice().sort(), ['order-processor', 'ordering']);
  });

  test('a helper folds into its one importer; a hub every sibling imports stands alone', () => {
    const files = [
      ...range('alpha/f', 60), ...range('beta/f', 60), ...range('gamma/f', 60),
      ...range('tiny/t', 5), ...range('hub/h', 5),
    ];
    const imports = [
      ['alpha/f0.js', 'tiny/t0.js'], ['alpha/f1.js', 'tiny/t1.js'],
      ['alpha/f0.js', 'hub/h0.js'], ['alpha/f1.js', 'hub/h1.js'],
      ['beta/f0.js', 'hub/h0.js'], ['beta/f1.js', 'hub/h1.js'],
      ['gamma/f0.js', 'hub/h0.js'], ['gamma/f1.js', 'hub/h1.js'],
    ];
    const result = draftComponents(graph(files, imports));
    const byName = Object.fromEntries(roots(result).map((c) => [c.name, c.fileCount]));
    assert.deepEqual(byName, { alpha: 65, beta: 60, gamma: 60, hub: 5 });
    const rel = result.relations.filter((r) => r.scopeId === 'root');
    const hub = roots(result).find((c) => c.name === 'hub');
    assert.equal(rel.filter((r) => r.to === hub.id).length, 3);
  });

  test('a scope never exceeds the limit: the smallest pool into "Other files"', () => {
    const files = [];
    for (let d = 0; d < 20; d += 1) files.push(...range(`dir${String.fromCharCode(97 + d)}x/f`, 3 + (d % 4)));
    const result = draftComponents(graph(files));
    const top = roots(result);
    assert.ok(top.length <= LIMIT, `expected at most ${LIMIT} root boxes, got ${top.length}`);
    const pool = top.find((c) => c.name === 'Other files');
    assert.ok(pool, 'a pool of the smallest boxes');
    assert.deepEqual(pool.label, { kind: 'other', word: '' });
    assert.ok(pool.parts.length >= 2);
    assert.equal(top.reduce((sum, c) => sum + c.fileCount, 0), files.length);
  });

  test('a flat directory splits into file families named by their shared start (D12)', () => {
    // A lone directory is stepped through, so its families are the root boxes.
    const files = [
      ...['bubble', 'scroll', 'zoom', 'thread', 'header'].map((x) => `flat/renderer-chat-${x}.js`),
      ...['buffer', 'guard', 'rows', 'metrics'].map((x) => `flat/renderer-stream-${x}.js`),
      ...['clock', 'phase', 'pause', 'model'].map((x) => `flat/renderer-turn-${x}.js`),
    ];
    const result = draftComponents(graph(files));
    assert.deepEqual(roots(result).map((c) => [c.name, c.fileCount]), [
      ['renderer-chat-*', 5],
      ['renderer-stream-*', 4],
      ['renderer-turn-*', 4],
    ]);
    assert.equal(result.scopes[0].rung, 'files');
    assert.deepEqual(roots(result)[0].label, { kind: 'family', stem: 'renderer-chat-', more: false });
  });

  test('every source file lands in exactly one root component', () => {
    const files = [...range('a/x', 9), ...range('a/b/y', 9), ...range('c/z', 12), 'top.js', 'other.js'];
    const result = draftComponents(graph(files));
    const placed = roots(result).flatMap((c) => filesOf(result, c)).sort();
    assert.deepEqual(placed, files.slice().sort());
    const loose = roots(result).find((c) => c.label.kind === 'loose');
    assert.deepEqual(loose && loose.label, { kind: 'loose', dir: '' }, 'files at the workspace root');
  });

  test('every component carries a structured label its English name is drawn from (D16)', () => {
    const files = [
      ...range('services/backend/session-', 9), ...range('services/backend/chat-', 9), ...range('services/main/m', 8),
      ...range('services/x', 3), ...range('renderer/chat/r', 10), ...range('renderer/shell/s', 10), 'top.js', 'other.js',
    ];
    const result = draftComponents(graph(files, [['services/main/m0.js', 'services/backend/chat-0.js']]));
    const kinds = new Set(['folder', 'file', 'family', 'role', 'loose', 'other', 'residual', 'all']);
    for (const component of result.components) {
      assert.ok(kinds.has(component.label.kind), JSON.stringify(component.label));
      assert.equal(nameOf(component.label), component.name);
    }
    for (const scope of result.scopes) assert.ok(['', 'small', 'cohesive', 'exhausted'].includes(scope.leafKind), scope.id);
  });

  test('only leaves list their files; every box carries its count (phase 2)', () => {
    const files = [
      ...range('app/chat/c', 12), ...range('app/shell/s', 12), ...range('app/store/t', 12),
      ...range('lib/l', 10), 'top.js',
    ];
    const result = draftComponents(graph(files));
    assert.ok(result.components.some((c) => children(result, c.id).length), 'the draft opens at least one box');
    for (const component of result.components) {
      const own = filesOf(result, component);
      assert.equal(component.fileCount, own.length, component.name);
      if (children(result, component.id).length) assert.equal('files' in component, false, component.name);
      else assert.deepEqual(component.files, own);
    }
  });

  test('tests, docs and other files sit beside the tree with their imports into it', () => {
    const files = [...range('app/a', 4), ...range('lib/b', 4), 'tests/app.test.js', 'tests/lib.test.js', 'README.md', 'package.json'];
    const imports = [['tests/app.test.js', 'app/a0.js'], ['tests/app.test.js', 'app/a1.js'], ['tests/lib.test.js', 'lib/b0.js']];
    const result = draftComponents(graph(files, imports));
    assert.deepEqual(result.outside, [
      { id: 'tests', fileCount: 2 },
      { id: 'docs', fileCount: 1 },
      { id: 'other', fileCount: 1 },
    ]);
    const ids = Object.fromEntries(roots(result).map((c) => [c.name, c.id]));
    assert.deepEqual(result.outsideRelations, [
      { from: 'tests', to: ids.app, files: 1 },
      { from: 'tests', to: ids.lib, files: 1 },
    ].sort((a, b) => (a.to < b.to ? -1 : 1)));
    assert.equal(roots(result).reduce((sum, c) => sum + c.fileCount, 0), 8);
  });

  test('output is byte-identical whatever the order of files and edges', () => {
    const files = [
      ...range('services/backend/session-', 9), ...range('services/backend/chat-', 9), ...range('services/main/m', 8),
      ...range('renderer/chat/r', 10), ...range('renderer/shell/s', 10), ...range('sidecar/ai/p', 12, '.py'),
    ];
    const imports = [
      ['services/main/m0.js', 'services/backend/chat-0.js'], ['services/main/m1.js', 'services/backend/chat-1.js'],
      ['renderer/chat/r0.js', 'renderer/shell/s0.js'], ['renderer/chat/r1.js', 'renderer/shell/s1.js'],
      ['services/backend/session-0.js', 'services/backend/chat-2.js'],
    ];
    const forward = JSON.stringify(draftComponents(graph(files, imports)));
    const backward = JSON.stringify(draftComponents(graph(files.slice().reverse(), imports.slice().reverse())));
    assert.equal(forward, backward);
  });

  test('a directory of more files than the fold takes still drafts within the limit (D10)', () => {
    const files = Array.from({ length: MAX_FOLD_GROUPS + 50 }, (_, i) => `big/w${i.toString(36)}q${i}.js`);
    const result = draftComponents(graph(files), { maxDepth: 2 });
    const [big] = roots(result);
    assert.equal(big.fileCount, files.length);
    assert.ok(children(result, big.id).length <= LIMIT);
  });
});

describe('nameOf (D16)', () => {
  test('words every label kind as the payload names it', () => {
    assert.equal(nameOf({ kind: 'folder', text: 'services' }), 'services');
    assert.equal(nameOf({ kind: 'file', text: 'main' }), 'main');
    assert.equal(nameOf({ kind: 'family', stem: 'renderer-chat-', more: false }), 'renderer-chat-*');
    assert.equal(nameOf({ kind: 'family', stem: 'managed-', more: true }), 'managed-* and more');
    assert.equal(nameOf({ kind: 'role', word: 'route' }), 'Route');
    assert.equal(nameOf({ kind: 'loose', dir: '' }), 'Loose files');
    assert.equal(nameOf({ kind: 'loose', dir: 'services/tools' }), 'Loose files in services.tools');
    assert.equal(nameOf({ kind: 'other', word: '' }), 'Other files');
    assert.equal(nameOf({ kind: 'other', word: 'route' }), 'Other routes');
    assert.equal(nameOf({ kind: 'other', word: 'tests' }), 'Other tests');
    assert.equal(nameOf({ kind: 'residual', text: 'renderer' }), 'renderer (residual)');
    assert.equal(nameOf({ kind: 'all' }), 'All files');
  });
});

describe('replay', () => {
  test('a file prefix claims its file whatever rung reopens it (D13)', () => {
    const units = unitsFromPaths(['srv/a-route.js', 'srv/b-store.js']);
    const partition = replay(units, {
      rung: 'unmerge',
      rules: [
        { id: '1', prefixes: [['srv', 'a-route.js']], terms: [], fallbackPrefixes: [] },
        { id: '2', prefixes: [], terms: [], fallbackPrefixes: [['srv']] },
      ],
    });
    assert.deepEqual(partition.members.get('1').map((u) => u.id), ['srv/a-route.js']);
    assert.deepEqual(partition.members.get('2').map((u) => u.id), ['srv/b-store.js']);
  });

  test('a word a rule owns claims a file no prefix does, before any fallback', () => {
    const units = unitsFromPaths(['x/billing-report.js', 'x/misc.js']);
    const partition = replay(units, {
      rung: 'frontier',
      rules: [
        { id: '1', prefixes: [['y']], terms: ['bill'], fallbackPrefixes: [] },
        { id: '2', prefixes: [], terms: [], fallbackPrefixes: [['x']] },
      ],
    });
    assert.deepEqual(partition.members.get('1').map((u) => u.id), ['x/billing-report.js']);
    assert.deepEqual(partition.members.get('2').map((u) => u.id), ['x/misc.js']);
    assert.deepEqual(partition.unplaced, []);
  });
});
