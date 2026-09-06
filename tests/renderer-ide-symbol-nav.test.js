const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createIdeSymbolNav,
  findBreadcrumbPath,
  flattenNavigationTree,
  symbolRowModel,
  rankSymbols,
  symbolKindLabel,
} = require('../renderer/features/renderer-ide-symbol-nav');

// A synthetic TypeScript NavigationTree (zero-based offsets) mirroring:
//   export class Greeter { greet(name) { return helloMessage(name); } }
//   export function helloMessage(name) { ... }
// The root "module" node spans the whole file and is skipped by both walkers.
function sampleTree() {
  return {
    text: '"greeter.ts"',
    kind: 'module',
    spans: [{ start: 0, length: 200 }],
    childItems: [
      {
        text: 'Greeter',
        kind: 'class',
        nameSpan: { start: 13, length: 7 },
        spans: [{ start: 0, length: 90 }],
        childItems: [
          {
            text: 'greet',
            kind: 'method',
            nameSpan: { start: 24, length: 5 },
            spans: [{ start: 24, length: 60 }],
            childItems: [],
          },
        ],
      },
      {
        text: 'helloMessage',
        kind: 'function',
        nameSpan: { start: 116, length: 12 },
        spans: [{ start: 100, length: 80 }],
        childItems: [],
      },
    ],
  };
}

function createModel({ path = 'src/file.ts', languageId = 'typescript', withVersionId = true } = {}) {
  let versionId = 1;
  let disposed = false;
  const uriString = `jenny-workspace:/${path}`;
  const model = {
    uri: {
      scheme: 'jenny-workspace',
      path: `/${path}`,
      toString: () => uriString,
    },
    getLanguageId: () => languageId,
    getOffsetAt: () => 40,
    getPositionAt: () => ({ lineNumber: 1, column: 1 }),
    isDisposed: () => disposed,
    setVersionId(value) { versionId = value; },
    dispose() { disposed = true; },
  };
  if (withVersionId) {
    model.getVersionId = () => versionId;
  }
  return model;
}

function createMonacoDouble(models, getNavigationTree) {
  const getWorker = async () => async () => ({ getNavigationTree });
  return {
    Uri: { parse: () => models[0].uri },
    editor: {
      getModel: () => models[0],
      getModels: () => models,
    },
    languages: {
      typescript: {
        getTypeScriptWorker: getWorker,
        getJavaScriptWorker: getWorker,
      },
    },
  };
}

function createRenderHarness(model, getNavigationTree) {
  const dom = new JSDOM('<nav id="ideBreadcrumbs"></nav>');
  const host = dom.window.document.getElementById('ideBreadcrumbs');
  const nav = createIdeSymbolNav({
    windowRef: dom.window,
    getDom: () => ({ ideBreadcrumbs: host }),
    editorHost: {
      isUsingMonaco: () => true,
      getActivePath: () => model.uri.path.replace(/^\//, ''),
      getActiveLanguageId: () => model.getLanguageId(),
      getDocumentKind: () => 'file',
      getCursorInfo: () => ({ lineNumber: 1, column: 1 }),
    },
    setTimeoutFn: (callback) => {
      callback();
      return 1;
    },
    clearTimeoutFn: () => {},
  });
  nav.handleMonacoReady(createMonacoDouble([model], getNavigationTree));
  return nav;
}

function installPickerDouble(t, rowsByOpen) {
  const previousPicker = global.rendererIdePickerOverlay;
  global.rendererIdePickerOverlay = {
    createIdePickerOverlay({ callbacks }) {
      return {
        async open() {
          callbacks.resetOnOpen();
          await callbacks.loadItems();
          rowsByOpen.push(callbacks.computeMatches(''));
          return true;
        },
        close() {},
        dispose() {},
      };
    },
  };
  t.after(() => { global.rendererIdePickerOverlay = previousPicker; });
}

function settleAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function renderBreadcrumb(nav) {
  nav.render();
  await settleAsync();
}

// ── findBreadcrumbPath ──

test('findBreadcrumbPath returns the deepest symbol path at the caret, skipping the root module node', () => {
  const path = findBreadcrumbPath(sampleTree(), 40, true, []);
  assert.deepEqual(path, [
    { label: 'Greeter', kind: 'class', offset: 13 },
    { label: 'greet', kind: 'method', offset: 24 },
  ]);
});

test('findBreadcrumbPath stops at the enclosing class when the caret is outside its methods', () => {
  // Offset 15 is inside Greeter (0..90) but before greet (24..84).
  const path = findBreadcrumbPath(sampleTree(), 15, true, []);
  assert.deepEqual(path, [{ label: 'Greeter', kind: 'class', offset: 13 }]);
});

test('findBreadcrumbPath resolves a top-level sibling symbol', () => {
  const path = findBreadcrumbPath(sampleTree(), 140, true, []);
  assert.deepEqual(path, [{ label: 'helloMessage', kind: 'function', offset: 116 }]);
});

test('findBreadcrumbPath yields [] for a caret in the file but in no named symbol', () => {
  // Offset 95 is between Greeter (ends 90) and helloMessage (starts 100).
  assert.deepEqual(findBreadcrumbPath(sampleTree(), 95, true, []), []);
});

test('findBreadcrumbPath yields [] when the caret is outside the file span entirely', () => {
  assert.deepEqual(findBreadcrumbPath(sampleTree(), 300, true, []), []);
});

test('findBreadcrumbPath checks ALL spans, not just the first (overloaded symbols)', () => {
  const tree = {
    text: 'mod',
    kind: 'module',
    spans: [{ start: 0, length: 100 }],
    childItems: [
      {
        text: 'foo',
        kind: 'function',
        nameSpan: { start: 5, length: 3 },
        // Two disjoint spans, as an overloaded function produces.
        spans: [{ start: 0, length: 10 }, { start: 20, length: 10 }],
        childItems: [],
      },
    ],
  };
  // Inside the SECOND span -> matched via the name offset.
  assert.deepEqual(findBreadcrumbPath(tree, 25, true, []), [{ label: 'foo', kind: 'function', offset: 5 }]);
  // In the gap between the two spans -> not inside foo.
  assert.deepEqual(findBreadcrumbPath(tree, 15, true, []), []);
});

test('findBreadcrumbPath falls back to the first span start when nameSpan is absent', () => {
  const tree = {
    text: 'mod',
    kind: 'module',
    spans: [{ start: 0, length: 50 }],
    childItems: [
      { text: 'bar', kind: 'function', spans: [{ start: 10, length: 20 }], childItems: [] },
    ],
  };
  assert.deepEqual(findBreadcrumbPath(tree, 15, true, []), [{ label: 'bar', kind: 'function', offset: 10 }]);
});

// ── flattenNavigationTree ──

test('flattenNavigationTree flattens to a symbol list with container paths, skipping the root', () => {
  assert.deepEqual(flattenNavigationTree(sampleTree(), true, '', []), [
    { name: 'Greeter', kind: 'class', container: '', offset: 13 },
    { name: 'greet', kind: 'method', container: 'Greeter', offset: 24 },
    { name: 'helloMessage', kind: 'function', container: '', offset: 116 },
  ]);
});

test('flattenNavigationTree tolerates an empty / malformed tree', () => {
  assert.deepEqual(flattenNavigationTree(null, true, '', []), []);
  assert.deepEqual(flattenNavigationTree({ text: 'm', kind: 'module', spans: [], childItems: [] }, true, '', []), []);
});

test('flattenNavigationTree threads a multi-level container path with the › separator', () => {
  // namespace Shapes { class Circle { area() {} } } -> Circle container is the
  // namespace, area's container is "Shapes › Circle".
  const tree = {
    text: '"shapes.ts"',
    kind: 'module',
    spans: [{ start: 0, length: 100 }],
    childItems: [
      {
        text: 'Shapes',
        kind: 'module',
        nameSpan: { start: 10, length: 6 },
        spans: [{ start: 0, length: 100 }],
        childItems: [
          {
            text: 'Circle',
            kind: 'class',
            nameSpan: { start: 25, length: 6 },
            spans: [{ start: 20, length: 70 }],
            childItems: [
              { text: 'area', kind: 'method', nameSpan: { start: 40, length: 4 }, spans: [{ start: 40, length: 20 }], childItems: [] },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(flattenNavigationTree(tree, true, '', []), [
    { name: 'Shapes', kind: 'module', container: '', offset: 10 },
    { name: 'Circle', kind: 'class', container: 'Shapes', offset: 25 },
    { name: 'area', kind: 'method', container: 'Shapes › Circle', offset: 40 },
  ]);
});

// ── symbolRowModel ──

const enriched = { name: 'helloMessage', kind: 'function', container: '', path: 'lib/util.ts', lineNumber: 7, column: 17, offset: 116 };

test('symbolRowModel scores on the NAME and carries the jump location', () => {
  const row = symbolRowModel(enriched, 'hello', undefined);
  assert.equal(row.name, 'helloMessage');
  assert.equal(row.kind, 'function');
  assert.equal(row.kindLabel, 'function');
  assert.equal(row.path, 'lib/util.ts');
  assert.equal(row.lineNumber, 7);
  assert.equal(row.column, 17);
  assert.ok(row.score > 0);
  assert.deepEqual(row.ranges, [[0, 5]]);
});

test('symbolRowModel returns null when a non-empty query does not match the name', () => {
  assert.equal(symbolRowModel(enriched, 'zzz', undefined), null);
});

test('symbolRowModel matches on the name only, never the path (name-first search)', () => {
  // "lib" appears in the path but not the name -> no match.
  assert.equal(symbolRowModel(enriched, 'lib', undefined), null);
});

test('symbolRowModel with an empty query returns a zero-score, unhighlighted row', () => {
  const row = symbolRowModel(enriched, '', undefined);
  assert.equal(row.score, 0);
  assert.deepEqual(row.ranges, []);
});

test('symbolRowModel uses an injected scorer when provided', () => {
  const scorer = (text, query) => (text.includes(query) ? { score: 42, ranges: [[1, 2]] } : null);
  const row = symbolRowModel(enriched, 'ello', scorer);
  assert.equal(row.score, 42);
  assert.deepEqual(row.ranges, [[1, 2]]);
});

test('symbolRowModel rejects nameless items', () => {
  assert.equal(symbolRowModel({ name: '' }, 'x', undefined), null);
});

// ── rankSymbols ──

const corpus = [
  { name: 'greeter', kind: 'const', path: 'a.ts', lineNumber: 1, column: 1 },
  { name: 'doGreet', kind: 'function', path: 'b.ts', lineNumber: 5, column: 1 },
  { name: 'unrelated', kind: 'function', path: 'a.ts', lineNumber: 9, column: 1 },
];

test('rankSymbols filters to query matches and orders best score first', () => {
  const rows = rankSymbols(corpus, 'greet', undefined, 50);
  assert.deepEqual(rows.map((r) => r.name), ['greeter', 'doGreet']);
});

test('rankSymbols with an empty query returns all rows in stable path/line order', () => {
  const rows = rankSymbols(corpus, '', undefined, 50);
  assert.deepEqual(rows.map((r) => `${r.path}:${r.lineNumber}`), ['a.ts:1', 'a.ts:9', 'b.ts:5']);
});

test('rankSymbols honors the result cap', () => {
  assert.equal(rankSymbols(corpus, '', undefined, 1).length, 1);
});

test('rankSymbols tolerates a non-array input', () => {
  assert.deepEqual(rankSymbols(null, 'x', undefined, 5), []);
});

// ── symbolKindLabel ──

test('symbolKindLabel maps TS kinds to friendly labels and passes unknowns through', () => {
  assert.equal(symbolKindLabel('method'), 'method');
  assert.equal(symbolKindLabel('local function'), 'function');
  assert.equal(symbolKindLabel('const'), 'const');
  assert.equal(symbolKindLabel('getter'), 'property');
  assert.equal(symbolKindLabel('widget'), 'widget');
  assert.equal(symbolKindLabel(''), 'symbol');
});

test('two breadcrumb renders on an unedited model query the navigation tree once', async (t) => {
  const model = createModel();
  let navigationTreeCalls = 0;
  const nav = createRenderHarness(model, () => {
    navigationTreeCalls += 1;
    return sampleTree();
  });
  t.after(() => nav.dispose());

  await renderBreadcrumb(nav);
  await renderBreadcrumb(nav);

  assert.equal(navigationTreeCalls, 1);
  assert.deepEqual(nav.stats(), {
    navTreeCacheHits: 1,
    navTreeCacheMisses: 1,
    navTreeCacheSize: 1,
  });
});

test('bumping the model version queries the navigation tree again', async (t) => {
  const model = createModel();
  let navigationTreeCalls = 0;
  const nav = createRenderHarness(model, () => {
    navigationTreeCalls += 1;
    return sampleTree();
  });
  t.after(() => nav.dispose());

  await renderBreadcrumb(nav);
  model.setVersionId(2);
  await renderBreadcrumb(nav);

  assert.equal(navigationTreeCalls, 2);
  assert.equal(nav.stats().navTreeCacheSize, 1);
});

test('a null navigation tree is not cached', async (t) => {
  const model = createModel();
  let navigationTreeCalls = 0;
  const nav = createRenderHarness(model, () => {
    navigationTreeCalls += 1;
    return null;
  });
  t.after(() => nav.dispose());

  await renderBreadcrumb(nav);
  await renderBreadcrumb(nav);

  assert.equal(navigationTreeCalls, 2);
  assert.equal(nav.stats().navTreeCacheSize, 0);
});

test('a model without getVersionId is never cached', async (t) => {
  const model = createModel({ withVersionId: false });
  let navigationTreeCalls = 0;
  const nav = createRenderHarness(model, () => {
    navigationTreeCalls += 1;
    return sampleTree();
  });
  t.after(() => nav.dispose());

  await renderBreadcrumb(nav);
  await renderBreadcrumb(nav);

  assert.equal(navigationTreeCalls, 2);
  assert.equal(nav.stats().navTreeCacheSize, 0);
});

test('a model disposed during the worker call does not populate the cache', async (t) => {
  const model = createModel();
  let navigationTreeCalls = 0;
  let resolveTree;
  const pendingTree = new Promise((resolve) => { resolveTree = resolve; });
  const nav = createRenderHarness(model, () => {
    navigationTreeCalls += 1;
    return pendingTree;
  });
  t.after(() => nav.dispose());

  nav.render();
  await settleAsync();
  assert.equal(navigationTreeCalls, 1, 'the navigation-tree request is in flight');
  model.dispose();
  resolveTree(sampleTree());
  await settleAsync();

  assert.equal(nav.stats().navTreeCacheSize, 0);
});

test('opening the workspace symbol picker twice reuses unchanged model trees and preserves rows', async (t) => {
  const rowsByOpen = [];
  installPickerDouble(t, rowsByOpen);
  const models = [
    createModel({ path: 'src/alpha.ts' }),
    createModel({ path: 'src/beta.js', languageId: 'javascript' }),
  ];
  let navigationTreeCalls = 0;
  const nav = createIdeSymbolNav({
    windowRef: {},
    editorHost: { isUsingMonaco: () => true },
  });
  nav.handleMonacoReady(createMonacoDouble(models, () => {
    navigationTreeCalls += 1;
    return sampleTree();
  }));
  t.after(() => nav.dispose());

  await nav.openPicker();
  await nav.openPicker();

  assert.equal(navigationTreeCalls, 2, 'only the first open queries both model trees');
  assert.equal(rowsByOpen.length, 2);
  assert.deepEqual(rowsByOpen[1], rowsByOpen[0]);
});

test('the navigation-tree cache evicts entries beyond 64 model URIs', async (t) => {
  installPickerDouble(t, []);
  const models = Array.from({ length: 65 }, (_, index) => createModel({ path: `src/file-${index}.ts` }));
  const nav = createIdeSymbolNav({
    windowRef: {},
    editorHost: { isUsingMonaco: () => true },
  });
  nav.handleMonacoReady(createMonacoDouble(models, () => sampleTree()));
  t.after(() => nav.dispose());

  await nav.openPicker();

  assert.equal(nav.stats().navTreeCacheSize, 64);
});

test('workspace-root commit closes the symbol picker and rejects the old-root index', async (t) => {
  const listeners = new Map();
  const windowRef = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  let resolveTree;
  const navigationTree = new Promise((resolve) => { resolveTree = resolve; });
  const model = {
    uri: { scheme: 'jenny-workspace', path: '/root-a.ts', toString: () => 'jenny-workspace:/root-a.ts' },
    getLanguageId: () => 'typescript',
    getPositionAt: () => ({ lineNumber: 1, column: 1 }),
    isDisposed: () => false,
  };
  let closeCalls = 0;
  let rowsAfterLoad = null;
  const previousPicker = global.rendererIdePickerOverlay;
  global.rendererIdePickerOverlay = {
    createIdePickerOverlay({ callbacks }) {
      return {
        async open() {
          callbacks.resetOnOpen();
          await callbacks.loadItems();
          rowsAfterLoad = callbacks.computeMatches('');
          return true;
        },
        close() { closeCalls += 1; },
        dispose() {},
      };
    },
  };
  t.after(() => { global.rendererIdePickerOverlay = previousPicker; });
  const nav = createIdeSymbolNav({
    windowRef,
    editorHost: { isUsingMonaco: () => true },
  });
  nav.handleMonacoReady({
    editor: { getModels: () => [model] },
    languages: {
      typescript: {
        getTypeScriptWorker: async () => async () => ({ getNavigationTree: () => navigationTree }),
      },
    },
  });

  const pendingOpen = nav.openPicker();
  await Promise.resolve();
  listeners.get('ide:workspace-root-committed')?.({ type: 'ide:workspace-root-committed' });
  resolveTree(sampleTree());
  await pendingOpen;

  assert.equal(closeCalls, 1, 'the open picker closes synchronously on root commit');
  assert.deepEqual(rowsAfterLoad, [], 'the late root-A index cannot repopulate rows');
  nav.dispose();
  assert.equal(listeners.has('ide:workspace-root-committed'), false, 'dispose removes the root listener');
});
