'use strict';

// Unit tests for renderer/features/renderer-ide-exploded-graph-utils.js (pure
// helpers) and renderer-ide-exploded-graph.js (async orchestration, driven
// entirely against a FAKE worker client - no Monaco, no real TS language
// service). Every nav-tree / highlight-span fixture below has its offsets
// computed from the actual fixture source text via indexOf() rather than
// hand-counted, so a fixture edit can't silently desync from reality.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const utils = require('../renderer/features/renderer-ide-exploded-graph-utils');
const { buildExplodedGraph } = require('../renderer/features/renderer-ide-exploded-graph');

const {
  classifyInitializer,
  scanImports,
  scanExports,
  isInlineExported,
  charAfterIsOpenParen,
  createLineIndex,
  buildSymbolNodes,
  createContainerResolver,
  applySymbolCap,
  finalizeGraph,
} = utils;

function moduleRoot(spans, childItems) {
  return { text: '"file"', kind: 'module', spans, childItems };
}

// ---------------------------------------------------------------------------
// classifyInitializer
// ---------------------------------------------------------------------------

describe('classifyInitializer', () => {
  test('no "=" in range -> data/unknown (ambient declare-only binding)', () => {
    const src = 'let x;';
    const result = classifyInitializer(src, src.indexOf('x') + 1, src.length);
    assert.deepEqual(result, { kind: 'data', dataShape: 'unknown', isAsync: false });
  });

  test('function keyword -> function', () => {
    const src = 'const f = function () { return 1; };';
    const eq = src.indexOf('=');
    const result = classifyInitializer(src, eq, src.length);
    assert.equal(result.kind, 'function');
    assert.equal(result.isAsync, false);
  });

  test('async keyword -> function, isAsync true', () => {
    const src = 'const f = async () => 1;';
    const result = classifyInitializer(src, src.indexOf('='), src.length);
    assert.equal(result.kind, 'function');
    assert.equal(result.isAsync, true);
  });

  test('"(" first token -> function (arrow with parens)', () => {
    const src = 'const f = (a, b) => a + b;';
    const result = classifyInitializer(src, src.indexOf('='), src.length);
    assert.equal(result.kind, 'function');
  });

  test('"(" first token but NOT an arrow param list -> data/expr, not function', () => {
    const src = 'const total = (a + b) / 2;';
    const result = classifyInitializer(src, src.indexOf('='), src.length);
    assert.deepEqual(result, { kind: 'data', dataShape: 'expr', isAsync: false });
  });

  test('bare identifier then "=>" -> function', () => {
    const src = 'const f = x => x * 2;';
    const result = classifyInitializer(src, src.indexOf('='), src.length);
    assert.equal(result.kind, 'function');
  });

  test('bare identifier NOT followed by "=>" -> data/expr', () => {
    const src = 'const f = otherThing;';
    const result = classifyInitializer(src, src.indexOf('='), src.length);
    assert.deepEqual(result, { kind: 'data', dataShape: 'expr', isAsync: false });
  });

  test('require(...) -> import, captures the source literal', () => {
    const src = "const m = require('./mod-a');";
    const result = classifyInitializer(src, src.indexOf('='), src.length);
    assert.equal(result.kind, 'import');
    assert.equal(result.source, './mod-a');
  });

  test('dynamic import(...) -> import, captures the source literal', () => {
    const src = 'const m = import("./mod-b");';
    const result = classifyInitializer(src, src.indexOf('='), src.length);
    assert.equal(result.kind, 'import');
    assert.equal(result.source, './mod-b');
  });

  test('"[" -> data/array', () => {
    const src = 'const list = [1, 2, 3];';
    const result = classifyInitializer(src, src.indexOf('='), src.length);
    assert.deepEqual(result, { kind: 'data', dataShape: 'array', isAsync: false });
  });

  test('"{" -> data/object', () => {
    const src = 'const cfg = { a: 1 };';
    const result = classifyInitializer(src, src.indexOf('='), src.length);
    assert.deepEqual(result, { kind: 'data', dataShape: 'object', isAsync: false });
  });

  test('"new " -> data/object', () => {
    const src = 'const inst = new Widget();';
    const result = classifyInitializer(src, src.indexOf('='), src.length);
    assert.deepEqual(result, { kind: 'data', dataShape: 'object', isAsync: false });
  });

  test('string/number/boolean/null literal -> data/primitive', () => {
    const cases = ["const s = 'hi';", 'const n = 42;', 'const neg = -3;', 'const b = true;', 'const z = null;'];
    for (const src of cases) {
      const result = classifyInitializer(src, src.indexOf('='), src.length);
      assert.equal(result.kind, 'data', src);
      assert.equal(result.dataShape, 'primitive', src);
    }
  });

  test('other expression forms -> data/expr', () => {
    const src = 'const v = a + b;';
    const result = classifyInitializer(src, src.indexOf('='), src.length);
    assert.deepEqual(result, { kind: 'data', dataShape: 'expr', isAsync: false });
  });

  test('ignores "==" / "=>" / "<=" when scanning for the assignment "="', () => {
    // The type annotation contains no "=", so the first real "=" is the
    // initializer's - classification must not stop at a false positive.
    const src = 'const f: () => void = () => {};';
    const result = classifyInitializer(src, src.indexOf(':'), src.length);
    assert.equal(result.kind, 'function');
  });
});

// ---------------------------------------------------------------------------
// scanImports
// ---------------------------------------------------------------------------

describe('scanImports', () => {
  test('default + named + aliased named import', () => {
    const src = "import Def, { a, b as c } from 'mod-x';\n";
    const out = scanImports(src);
    assert.deepEqual(
      out.map((o) => [o.name, o.source]).sort(),
      [['Def', 'mod-x'], ['a', 'mod-x'], ['c', 'mod-x']].sort()
    );
    const def = out.find((o) => o.name === 'Def');
    assert.equal(src.slice(def.nameOffset, def.nameOffset + 3), 'Def');
    const c = out.find((o) => o.name === 'c');
    assert.equal(src.slice(c.nameOffset, c.nameOffset + 1), 'c');
  });

  test('namespace import (* as ns)', () => {
    const src = "import * as ns from 'ns-mod';\n";
    const out = scanImports(src);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'ns');
    assert.equal(out[0].source, 'ns-mod');
    assert.equal(src.slice(out[0].nameOffset, out[0].nameOffset + 2), 'ns');
  });

  test('side-effect import (no "from") produces no binding node', () => {
    const src = "import 'polyfill';\nconst x = 1;\n";
    assert.deepEqual(scanImports(src), []);
  });

  test('const NAME = require(...)', () => {
    const src = "const helper = require('./helper');\n";
    const out = scanImports(src);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'helper');
    assert.equal(out[0].source, './helper');
    assert.equal(src.slice(out[0].nameOffset, out[0].nameOffset + 6), 'helper');
  });

  test('const { a, b: bb } = require(...) destructure, "b: bb" -> local name bb', () => {
    const src = "const { a, b: bb } = require('./destructured');\n";
    const out = scanImports(src);
    assert.deepEqual(out.map((o) => o.name).sort(), ['a', 'bb']);
    const bb = out.find((o) => o.name === 'bb');
    assert.equal(src.slice(bb.nameOffset, bb.nameOffset + 2), 'bb');
    assert.equal(bb.source, './destructured');
  });

  test('dynamic import() and "export ... from" are not treated as bindings', () => {
    const src = "export { x } from 'reexport-mod';\nconst p = import('./dyn');\n";
    assert.deepEqual(scanImports(src), []);
  });

  test('stops the head scan at the first non-import top-level statement', () => {
    const src = "import { a } from 'mod-a';\n\nconst notAnImport = 1;\n\nconst { b } = require('./late');\n";
    const out = scanImports(src);
    // The require() after the first real statement is OUTSIDE the head region.
    assert.deepEqual(out.map((o) => o.name), ['a']);
  });

  test('a multi-line block-comment banner at the head of the file does not swallow the imports that follow', () => {
    const src = '/* renderer/features/foo.js - banner\n * second line\n */\n' + "import { a } from './m';\n";
    assert.deepEqual(scanImports(src).map((o) => o.name), ['a']);
  });
});

// ---------------------------------------------------------------------------
// scanExports / isInlineExported
// ---------------------------------------------------------------------------

describe('scanExports / isInlineExported', () => {
  test('deferred export list resolves local names, not aliases', () => {
    const src = 'const a = 1;\nconst b = 2;\nexport { a, b as bAlias };\n';
    const { deferredNames, defaultName } = scanExports(src);
    assert.deepEqual(Array.from(deferredNames).sort(), ['a', 'b']);
    assert.equal(defaultName, null);
  });

  test('"export { x } from \'mod\'" re-export is ignored (not a local binding)', () => {
    const { deferredNames } = scanExports("export { x } from 'mod';\n");
    assert.equal(deferredNames.size, 0);
  });

  test('bare "export default identifier;" is captured', () => {
    const { defaultName } = scanExports('function helloMessage() {}\nexport default helloMessage;\n');
    assert.equal(defaultName, 'helloMessage');
  });

  test('isInlineExported detects "export" immediately before the range (over whitespace)', () => {
    const src = 'export   function run() {}\n';
    const start = src.indexOf('function');
    assert.equal(isInlineExported(src, start), true);
  });

  test('isInlineExported detects "export default" before the range', () => {
    const src = 'export default function run() {}\n';
    const start = src.indexOf('function');
    assert.equal(isInlineExported(src, start), true);
  });

  test('isInlineExported is false with no export keyword present', () => {
    const src = 'function run() {}\n';
    const start = src.indexOf('function');
    assert.equal(isInlineExported(src, start), false);
  });

  test('isInlineExported skips a block comment between export and the declaration', () => {
    const src = 'export /* keep */ function run() {}\n';
    const start = src.indexOf('function');
    assert.equal(isInlineExported(src, start), true);
  });
});

// ---------------------------------------------------------------------------
// charAfterIsOpenParen / createLineIndex
// ---------------------------------------------------------------------------

describe('charAfterIsOpenParen', () => {
  test('true when the next non-trivia char is "("', () => {
    const src = 'shape(id)';
    assert.equal(charAfterIsOpenParen(src, 'shape'.length), true);
  });

  test('true across whitespace/comments before "("', () => {
    const src = 'shape /* call */ (id)';
    assert.equal(charAfterIsOpenParen(src, 'shape'.length), true);
  });

  test('false when the next non-trivia char is not "("', () => {
    const src = 'shape.value';
    assert.equal(charAfterIsOpenParen(src, 'shape'.length), false);
  });
});

describe('createLineIndex', () => {
  test('maps offsets to 1-based line numbers', () => {
    const src = 'aaa\nbbb\nccc';
    const idx = createLineIndex(src);
    assert.equal(idx.lineAt(0), 1);
    assert.equal(idx.lineAt(3), 1); // the \n itself still belongs to line 1
    assert.equal(idx.lineAt(4), 2);
    assert.equal(idx.lineAt(9), 3);
  });

  test('clamps out-of-range offsets', () => {
    const idx = createLineIndex('abc');
    assert.equal(idx.lineAt(-5), 1);
    assert.equal(idx.lineAt(999), 1);
  });
});

// ---------------------------------------------------------------------------
// buildSymbolNodes - classification, merge, export resolution
// ---------------------------------------------------------------------------

describe('buildSymbolNodes', () => {
  const SRC = [
    'export function topFn() {',
    '  return 1;',
    '}',
    '',
    'interface Ignored {',
    '  x: number;',
    '}',
    '',
    'enum Color {',
    '  Red,',
    '  Green,',
    '}',
    '',
    'const list = [1, 2, 3];',
    '',
    'const makeThing = () => {',
    '  return {};',
    '};',
    '',
    'class Widget {',
    '  render() {',
    '    return list;',
    '  }',
    '}',
    '',
    'const NOT_EXPORTED_BUT_LISTED = 5;',
    '',
    "export { NOT_EXPORTED_BUT_LISTED as widgetFlag };",
    '',
  ].join('\n');

  function block(text) {
    const start = SRC.indexOf(text);
    assert.ok(start !== -1, `fixture substring not found: ${text}`);
    return { start, end: start + text.length };
  }

  function leaf(name, kind, blockText, extra) {
    const { start, end } = block(blockText);
    const nameOffset = SRC.indexOf(name, start);
    return Object.assign({
      text: name,
      kind,
      nameSpan: { start: nameOffset, length: name.length },
      spans: [{ start, length: end - start }],
      childItems: [],
    }, extra || {});
  }

  const topFnBlock = 'function topFn() {\n  return 1;\n}';
  const ignoredBlock = 'interface Ignored {\n  x: number;\n}';
  const colorBlock = 'enum Color {\n  Red,\n  Green,\n}';
  const listBlock = 'const list = [1, 2, 3];';
  const makeThingBlock = 'const makeThing = () => {\n  return {};\n};';
  const widgetBlock = 'class Widget {\n  render() {\n    return list;\n  }\n}';
  const renderBlock = 'render() {\n    return list;\n  }';
  const flaggedBlock = 'const NOT_EXPORTED_BUT_LISTED = 5;';

  const tree = moduleRoot([{ start: 0, length: SRC.length }], [
    leaf('topFn', 'function', topFnBlock),
    leaf('Ignored', 'interface', ignoredBlock),
    leaf('Color', 'enum', colorBlock),
    leaf('list', 'const', listBlock),
    leaf('makeThing', 'const', makeThingBlock),
    (() => {
      const { start, end } = block(widgetBlock);
      return {
        text: 'Widget',
        kind: 'class',
        nameSpan: { start: SRC.indexOf('Widget', start), length: 6 },
        spans: [{ start, length: end - start }],
        childItems: [leaf('render', 'method', renderBlock)],
      };
    })(),
    leaf('NOT_EXPORTED_BUT_LISTED', 'const', flaggedBlock),
  ]);

  const nodes = buildSymbolNodes(tree, SRC);
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));

  test('function declaration classifies as function and picks up inline export', () => {
    assert.equal(byName.topFn.kind, 'function');
    assert.equal(byName.topFn.isExported, true);
    assert.equal(byName.topFn.container, '');
  });

  test('interface is dropped entirely (no node emitted)', () => {
    assert.equal(byName.Ignored, undefined);
  });

  test('enum classifies as data with dataShape "enum"', () => {
    assert.equal(byName.Color.kind, 'data');
    assert.equal(byName.Color.dataShape, 'enum');
  });

  test('array initializer classifies as data with dataShape "array"', () => {
    assert.equal(byName.list.kind, 'data');
    assert.equal(byName.list.dataShape, 'array');
  });

  test('arrow-function const classifies as function, not data', () => {
    assert.equal(byName.makeThing.kind, 'function');
  });

  test('class produces no node of its own; its method is a "method" with container=class name', () => {
    assert.equal(byName.Widget, undefined);
    assert.equal(byName.render.kind, 'method');
    assert.equal(byName.render.container, 'Widget');
  });

  test('deferred "export { X as alias }" marks the LOCAL name exported', () => {
    assert.equal(byName.NOT_EXPORTED_BUT_LISTED.kind, 'data');
    assert.equal(byName.NOT_EXPORTED_BUT_LISTED.dataShape, 'primitive');
    assert.equal(byName.NOT_EXPORTED_BUT_LISTED.isExported, true);
  });

  test('every id follows the "kind:name@nameOffset" contract and is unique', () => {
    const ids = nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const n of nodes) {
      assert.equal(n.id, `${n.kind}:${n.name}@${n.nameOffset}`);
    }
  });

  test('non-exported, non-data/import nodes carry no dataShape/source keys', () => {
    assert.equal('dataShape' in byName.topFn, false);
    assert.equal('source' in byName.topFn, false);
  });

  test('merges overload/accessor-style duplicate declarations by (kind, name, container)', () => {
    const src2 = 'function ovl(a) {}\nfunction ovl(a, b) {\n  return a + b;\n}\n';
    const firstStart = src2.indexOf('function ovl(a) {}');
    const secondStart = src2.indexOf('function ovl(a, b)');
    const secondEnd = src2.indexOf('\n', src2.indexOf('return a + b;')) + 1;
    const tree2 = moduleRoot([{ start: 0, length: src2.length }], [
      {
        text: 'ovl', kind: 'function',
        nameSpan: { start: firstStart + 'function '.length, length: 3 },
        spans: [{ start: firstStart, length: 'function ovl(a) {}'.length }],
        childItems: [],
      },
      {
        text: 'ovl', kind: 'function',
        nameSpan: { start: secondStart + 'function '.length, length: 3 },
        spans: [{ start: secondStart, length: secondEnd - secondStart }],
        childItems: [],
      },
    ]);
    const merged = buildSymbolNodes(tree2, src2);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, 'ovl');
    assert.equal(merged[0].range.start, firstStart);
    assert.equal(merged[0].range.length, secondEnd - firstStart);
  });
});

// ---------------------------------------------------------------------------
// createContainerResolver
// ---------------------------------------------------------------------------

describe('createContainerResolver', () => {
  test('resolves the innermost enclosing function/method (smallest span wins)', () => {
    const outer = { id: 'function:outer@0', kind: 'function', range: { start: 0, length: 100 } };
    const inner = { id: 'method:inner@40', kind: 'method', range: { start: 40, length: 20 } };
    const dataNode = { id: 'data:x@10', kind: 'data', range: { start: 10, length: 1 } };
    const resolve = createContainerResolver([outer, inner, dataNode]);
    assert.equal(resolve(45).id, 'method:inner@40');
    assert.equal(resolve(10).id, 'function:outer@0');
    assert.equal(resolve(500), null);
  });

  test('data/import nodes are never returned as a container', () => {
    const dataNode = { id: 'data:x@0', kind: 'data', range: { start: 0, length: 50 } };
    const resolve = createContainerResolver([dataNode]);
    assert.equal(resolve(5), null);
  });
});

// ---------------------------------------------------------------------------
// applySymbolCap
// ---------------------------------------------------------------------------

describe('applySymbolCap', () => {
  function n(id, extra) {
    return Object.assign({ id, isExported: false, loc: 1, line: 1 }, extra);
  }

  test('no truncation when the node count is within the cap', () => {
    const nodes = [n('a'), n('b')];
    const { survivors, truncated } = applySymbolCap(nodes, 5);
    assert.equal(truncated, false);
    assert.equal(survivors.length, 2);
  });

  test('exported-first, then loc desc, then line asc; survivors keep original order', () => {
    const nodes = [
      n('lowLoc', { loc: 1, line: 1 }),
      n('exported', { isExported: true, loc: 1, line: 5 }),
      n('highLoc', { loc: 9, line: 2 }),
    ];
    const { survivors, truncated } = applySymbolCap(nodes, 2);
    assert.equal(truncated, true);
    assert.deepEqual(survivors.map((s) => s.id), ['exported', 'highLoc']);
  });
});

// ---------------------------------------------------------------------------
// finalizeGraph - prune, degrees, callDepth, importance, zone/rank/layout
// ---------------------------------------------------------------------------

describe('finalizeGraph', () => {
  function fn(id, extra) {
    return Object.assign({
      id, kind: 'function', name: id, container: '', isExported: false, loc: 1, line: 1, degreeIn: 0, degreeOut: 0,
    }, extra);
  }
  function data(id, extra) {
    return Object.assign({ id, kind: 'data', name: id, isExported: false, loc: 1, line: 1 }, extra);
  }
  function imp(id, extra) {
    return Object.assign({ id, kind: 'import', name: id, source: 'mod', isExported: false, loc: 1, line: 1 }, extra);
  }

  test('data/import nodes with no inbound edge and no export are pruned', () => {
    const nodes = [fn('entry', { isExported: true }), data('orphanData'), imp('orphanImport')];
    const { nodes: out, edges } = finalizeGraph(nodes, []);
    assert.deepEqual(out.map((n) => n.id), ['entry']);
    assert.deepEqual(edges, []);
  });

  test('data/import nodes are kept when referenced OR exported even with zero inbound', () => {
    const nodes = [fn('entry', { isExported: true }), data('used'), imp('usedImport'), data('exportedOnly', { isExported: true })];
    const edges = [
      { from: 'entry', to: 'used', kind: 'read', weight: 1 },
      { from: 'entry', to: 'usedImport', kind: 'import', weight: 1 },
    ];
    const { nodes: out } = finalizeGraph(nodes, edges);
    assert.deepEqual(out.map((n) => n.id).sort(), ['entry', 'exportedOnly', 'used', 'usedImport'].sort());
  });

  test('callDepth BFS from exported entries over call edges only; unreachable stays null', () => {
    const nodes = [
      fn('entry', { isExported: true }),
      fn('mid'),
      fn('leaf'),
      fn('unreachable'),
      data('readOnly'),
    ];
    const edges = [
      { from: 'entry', to: 'mid', kind: 'call', weight: 1 },
      { from: 'mid', to: 'leaf', kind: 'call', weight: 1 },
      { from: 'entry', to: 'readOnly', kind: 'read', weight: 1 },
    ];
    const { nodes: out } = finalizeGraph(nodes, edges);
    const byId = Object.fromEntries(out.map((n) => [n.id, n]));
    assert.equal(byId.entry.callDepth, 0);
    assert.equal(byId.mid.callDepth, 1);
    assert.equal(byId.leaf.callDepth, 2);
    // function/method nodes are ALWAYS kept by prune (unlike data/import), so
    // 'unreachable' survives with callDepth null (never reached via a call edge).
    assert.notEqual(byId.unreachable, undefined);
    assert.equal(byId.unreachable.callDepth, null);
    assert.equal(byId.readOnly.callDepth, null);
  });

  test('importance: 0 at min degreeIn, 1 at max, correct rounded fraction between (IMPORTANCE_PRECISION=4)', () => {
    // degreeIn: entry=0 (min, nothing points to it), low=1, mid=2, high=3 (max) -> span 3.
    const nodes = [fn('entry', { isExported: true }), data('low'), data('mid'), data('high')];
    const edges = [
      { from: 'entry', to: 'low', kind: 'read', weight: 1 },
      { from: 'entry', to: 'mid', kind: 'read', weight: 1 }, { from: 'entry', to: 'mid', kind: 'read', weight: 1 },
      { from: 'entry', to: 'high', kind: 'read', weight: 1 }, { from: 'entry', to: 'high', kind: 'read', weight: 1 }, { from: 'entry', to: 'high', kind: 'read', weight: 1 },
    ];
    const byId = Object.fromEntries(finalizeGraph(nodes, edges).nodes.map((n) => [n.id, n]));
    assert.equal(byId.entry.importance, 0);
    assert.equal(byId.high.importance, 1);
    assert.equal(byId.low.importance, 0.3333);
    assert.equal(byId.mid.importance, 0.6667);
  });

  test('importance is 0 for every node when all degreeIn values are equal (zero span)', () => {
    const nodes = [fn('entry', { isExported: true }), data('a', { isExported: true }), data('b', { isExported: true })];
    const out = finalizeGraph(nodes, []).nodes;
    assert.equal(out.length, 3);
    out.forEach((n) => { assert.equal(n.degreeIn, 0); assert.equal(n.importance, 0); });
  });

  test('zones: import -> imports, data -> data, exported fn/method -> entry, else -> functions; rank is zone-local (pixel x/y is the caller\'s concern - see renderer-ide-explode-layout.js)', () => {
    const nodes = [fn('pub', { isExported: true }), fn('priv'), data('d'), imp('i')];
    const edges = [
      { from: 'pub', to: 'priv', kind: 'call', weight: 1 },
      { from: 'pub', to: 'd', kind: 'read', weight: 1 },
      { from: 'pub', to: 'i', kind: 'import', weight: 1 },
    ];
    const byId = Object.fromEntries(finalizeGraph(nodes, edges).nodes.map((n) => [n.id, n]));
    assert.equal(byId.pub.zone, 'entry');
    assert.equal(byId.priv.zone, 'functions');
    assert.equal(byId.d.zone, 'data');
    assert.equal(byId.i.zone, 'imports');
    // Each zone here has exactly one member -> rank 0.
    assert.equal(byId.pub.rank, 0);
    assert.equal(byId.i.rank, 0);
  });

  test('output is deterministically sorted by (zone, rank, id)', () => {
    const nodes = [fn('b', { isExported: true, loc: 1, line: 2 }), fn('a', { isExported: true, loc: 1, line: 1 })];
    const { nodes: out } = finalizeGraph(nodes, []);
    // Both entry-zone, callDepth 0 (no call edges but both are roots via BFS
    // seed) tie -> loc tie -> line asc breaks the tie: a (line 1) before b.
    assert.deepEqual(out.map((n) => n.id), ['a', 'b']);
  });

  test('edges are sorted by (from, to, kind)', () => {
    const nodes = [fn('x', { isExported: true }), data('z'), data('y')];
    const edges = [
      { from: 'x', to: 'z', kind: 'read', weight: 1 },
      { from: 'x', to: 'y', kind: 'read', weight: 1 },
    ];
    const { edges: out } = finalizeGraph(nodes, edges);
    assert.deepEqual(out.map((e) => e.to), ['y', 'z']);
  });
});

// ---------------------------------------------------------------------------
// buildExplodedGraph - end-to-end wiring against a fake worker client
// ---------------------------------------------------------------------------

function fakeClient({ tree, highlightsByOffset, referencesByOffset, noHighlights }) {
  const client = {
    async getNavigationTree() {
      return tree;
    },
  };
  if (!noHighlights) {
    client.getDocumentHighlights = async (uri, pos) => {
      const spans = (highlightsByOffset && highlightsByOffset[pos]) || [];
      return spans.length ? [{ fileName: uri, highlightSpans: spans }] : [];
    };
  }
  client.getReferencesAtPosition = async (uri, pos) => (referencesByOffset && referencesByOffset[pos]) || [];
  return client;
}

describe('buildExplodedGraph - call/read/import wiring', () => {
  const SRC = [
    "import { helper } from './lib';",
    '',
    'export const CONFIG = { retries: 3 };',
    '',
    'export function run(id) {',
    '  const value = helper(id) + helper(id + 1);',
    '  return value + shape(id) + CONFIG.retries;',
    '}',
    '',
    'function shape(id) {',
    '  CONFIG.retries = id;',
    '  return id * 2;',
    '}',
    '',
  ].join('\n');

  const helperImportOffset = SRC.indexOf('helper');
  const helperCall1 = SRC.indexOf('helper(id)');
  const helperCall2 = SRC.indexOf('helper(id + 1)');

  const configBlock = 'const CONFIG = { retries: 3 };';
  const configRangeStart = SRC.indexOf(configBlock);
  const configNameOffset = SRC.indexOf('CONFIG', configRangeStart);
  const configUseInRun = SRC.indexOf('CONFIG.retries;');
  const configUseInShape = SRC.indexOf('CONFIG.retries = id;');

  const runBlock = 'function run(id) {\n  const value = helper(id) + helper(id + 1);\n  return value + shape(id) + CONFIG.retries;\n}';
  const runRangeStart = SRC.indexOf(runBlock);
  const runNameOffset = SRC.indexOf('run', runRangeStart);
  const shapeCallSite = SRC.indexOf('shape(id) +');

  const shapeBlock = 'function shape(id) {\n  CONFIG.retries = id;\n  return id * 2;\n}';
  const shapeRangeStart = SRC.indexOf(shapeBlock);
  const shapeNameOffset = SRC.indexOf('shape', shapeRangeStart);

  const tree = moduleRoot([{ start: 0, length: SRC.length }], [
    {
      text: 'CONFIG', kind: 'const',
      nameSpan: { start: configNameOffset, length: 6 },
      spans: [{ start: configRangeStart, length: configBlock.length }],
      childItems: [],
    },
    {
      text: 'run', kind: 'function',
      nameSpan: { start: runNameOffset, length: 3 },
      spans: [{ start: runRangeStart, length: runBlock.length }],
      childItems: [],
    },
    {
      text: 'shape', kind: 'function',
      nameSpan: { start: shapeNameOffset, length: 5 },
      spans: [{ start: shapeRangeStart, length: shapeBlock.length }],
      childItems: [],
    },
  ]);

  const highlightsByOffset = {
    [helperImportOffset]: [
      { textSpan: { start: helperImportOffset, length: 6 }, kind: 'definition' },
      { textSpan: { start: helperCall1, length: 6 }, kind: 'reference' },
      { textSpan: { start: helperCall2, length: 6 }, kind: 'reference' },
    ],
    [configNameOffset]: [
      { textSpan: { start: configNameOffset, length: 6 }, kind: 'definition' },
      { textSpan: { start: configUseInRun, length: 6 }, kind: 'reference' },
      { textSpan: { start: configUseInShape, length: 6 }, kind: 'writtenReference' },
    ],
    [runNameOffset]: [
      { textSpan: { start: runNameOffset, length: 3 }, kind: 'definition' },
    ],
    [shapeNameOffset]: [
      { textSpan: { start: shapeNameOffset, length: 5 }, kind: 'definition' },
      { textSpan: { start: shapeCallSite, length: 5 }, kind: 'reference' },
    ],
  };

  async function run(overrides) {
    const client = fakeClient({ tree, highlightsByOffset });
    return buildExplodedGraph(Object.assign({
      workerClient: client,
      getText: () => SRC,
      model: 'file:///main.ts',
    }, overrides));
  }

  test('produces the expected call/read/import edges with aggregated weights', async () => {
    const result = await run();
    const edgeKey = (e) => `${e.from}|${e.to}|${e.kind}`;
    const byKey = Object.fromEntries(result.edges.map((e) => [edgeKey(e), e]));

    assert.equal(Object.keys(byKey).length, 4);
    assert.equal(byKey[`function:run@${runNameOffset}|import:helper@${helperImportOffset}|import`].weight, 2);
    assert.equal(byKey[`function:run@${runNameOffset}|function:shape@${shapeNameOffset}|call`].weight, 1);

    const runReadsConfig = byKey[`function:run@${runNameOffset}|data:CONFIG@${configNameOffset}|read`];
    assert.equal(runReadsConfig.weight, 1);
    assert.equal(runReadsConfig.write, false);

    const shapeReadsConfig = byKey[`function:shape@${shapeNameOffset}|data:CONFIG@${configNameOffset}|read`];
    assert.equal(shapeReadsConfig.weight, 1);
    assert.equal(shapeReadsConfig.write, true);
  });

  test('diagnostics report parsed/workerAvailable, symbolCount, and emitted kind tallies', async () => {
    const result = await run();
    assert.equal(result.diagnostics.parsed, true);
    assert.equal(result.diagnostics.workerAvailable, true);
    assert.equal(result.diagnostics.degraded, false);
    assert.equal(result.diagnostics.reason, null);
    assert.equal(result.diagnostics.language, 'typescript');
    assert.equal(result.diagnostics.symbolCount, 4);
    assert.deepEqual(result.diagnostics.emitted, { functions: 2, methods: 0, data: 1, imports: 1 });
    assert.equal(result.diagnostics.unresolvedRefs, 0);
    assert.equal(result.diagnostics.truncated, false);
    assert.ok(Number.isFinite(result.diagnostics.durationMs));
  });

  test('zones/ranks: entry (run), functions (shape), data (CONFIG), imports (helper)', async () => {
    const result = await run();
    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n]));
    assert.equal(byId[`function:run@${runNameOffset}`].zone, 'entry');
    assert.equal(byId[`function:shape@${shapeNameOffset}`].zone, 'functions');
    assert.equal(byId[`data:CONFIG@${configNameOffset}`].zone, 'data');
    assert.equal(byId[`import:helper@${helperImportOffset}`].zone, 'imports');
    // Deterministic emit order: imports, data, functions, entry.
    assert.deepEqual(result.nodes.map((n) => n.zone), ['imports', 'data', 'functions', 'entry']);
  });

  test('resolves the worker via the injected workerClient path with a bare uri string + getText (no Monaco)', async () => {
    const result = await run();
    assert.equal(result.diagnostics.workerAvailable, true);
  });
});

describe('buildExplodedGraph - getReferencesAtPosition fallback path', () => {
  const SRC = [
    'export function outer() {',
    '  return helperFn();',
    '}',
    '',
    'function helperFn() {',
    '  return 1;',
    '}',
    '',
  ].join('\n');

  const outerBlock = 'function outer() {\n  return helperFn();\n}';
  const outerStart = SRC.indexOf(outerBlock);
  const outerNameOffset = SRC.indexOf('outer', outerStart);

  const helperBlock = 'function helperFn() {\n  return 1;\n}';
  const helperStart = SRC.indexOf(helperBlock);
  const helperNameOffset = SRC.indexOf('helperFn', helperStart);
  const callSite = SRC.indexOf('helperFn()');

  const tree = moduleRoot([{ start: 0, length: SRC.length }], [
    {
      text: 'outer', kind: 'function',
      nameSpan: { start: outerNameOffset, length: 5 },
      spans: [{ start: outerStart, length: outerBlock.length }],
      childItems: [],
    },
    {
      text: 'helperFn', kind: 'function',
      nameSpan: { start: helperNameOffset, length: 8 },
      spans: [{ start: helperStart, length: helperBlock.length }],
      childItems: [],
    },
  ]);

  test('empty getDocumentHighlights falls back to getReferencesAtPosition, dropping the decl site + in-string + cross-file hits', async () => {
    const client = fakeClient({
      tree,
      highlightsByOffset: {}, // always empty -> forces the fallback for every target
      referencesByOffset: {
        [helperNameOffset]: [
          { fileName: 'file:///main.ts', textSpan: { start: helperNameOffset, length: 8 }, isWriteAccess: false, isInString: false }, // decl site, dropped
          { fileName: 'file:///main.ts', textSpan: { start: callSite, length: 8 }, isWriteAccess: false, isInString: false }, // real call site, kept
          { fileName: 'file:///main.ts', textSpan: { start: 0, length: 8 }, isWriteAccess: false, isInString: true }, // in a string, dropped
          { fileName: 'file:///other.ts', textSpan: { start: 0, length: 8 }, isWriteAccess: false, isInString: false }, // other file, dropped
        ],
      },
    });
    const result = await buildExplodedGraph({
      workerClient: client,
      getText: () => SRC,
      model: 'file:///main.ts',
    });
    assert.equal(result.edges.length, 1);
    const edge = result.edges[0];
    assert.equal(edge.from, `function:outer@${outerNameOffset}`);
    assert.equal(edge.to, `function:helperFn@${helperNameOffset}`);
    assert.equal(edge.kind, 'call');
    assert.equal(edge.weight, 1);
    assert.equal(result.diagnostics.unresolvedRefs, 0);
  });

  test('a client with neither highlights nor references never throws and yields zero edges', async () => {
    const client = { async getNavigationTree() { return tree; } };
    const result = await buildExplodedGraph({
      workerClient: client,
      getText: () => SRC,
      model: 'file:///main.ts',
    });
    assert.equal(result.diagnostics.parsed, true);
    assert.deepEqual(result.edges, []);
  });
});

// ---------------------------------------------------------------------------
// buildExplodedGraph - symbol cap truncation
// ---------------------------------------------------------------------------

describe('buildExplodedGraph - symbol cap', () => {
  const SRC = [
    'function small() {',
    '  return 1;',
    '}',
    '',
    'export function keep() {',
    '  return 2;',
    '}',
    '',
    'function big() {',
    '  const a = 1;',
    '  const b = 2;',
    '  const c = 3;',
    '  return a + b + c;',
    '}',
    '',
  ].join('\n');

  function fnEntry(name, blockText) {
    const start = SRC.indexOf(blockText);
    const nameOffset = SRC.indexOf(name, start);
    return {
      text: name, kind: 'function',
      nameSpan: { start: nameOffset, length: name.length },
      spans: [{ start, length: blockText.length }],
      childItems: [],
    };
  }

  const tree = moduleRoot([{ start: 0, length: SRC.length }], [
    fnEntry('small', 'function small() {\n  return 1;\n}'),
    fnEntry('keep', 'function keep() {\n  return 2;\n}'),
    fnEntry('big', 'function big() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;\n}'),
  ]);

  test('truncates to symbolCap keeping exported-first then loc desc; reports truncated + symbol-cap reason', async () => {
    const client = fakeClient({ tree, highlightsByOffset: {} });
    const result = await buildExplodedGraph({
      workerClient: client,
      getText: () => SRC,
      model: 'file:///cap.ts',
      symbolCap: 2,
    });
    const names = result.nodes.map((n) => n.name).sort();
    assert.deepEqual(names, ['big', 'keep']);
    assert.equal(result.diagnostics.truncated, true);
    assert.equal(result.diagnostics.reason, 'symbol-cap');
    assert.equal(result.diagnostics.symbolCount, 3);
    assert.equal(result.diagnostics.symbolCap, 2);
  });

  test('default symbolCap (150) does not truncate this fixture', async () => {
    const client = fakeClient({ tree, highlightsByOffset: {} });
    const result = await buildExplodedGraph({
      workerClient: client,
      getText: () => SRC,
      model: 'file:///cap.ts',
    });
    assert.equal(result.diagnostics.truncated, false);
    assert.equal(result.diagnostics.symbolCap, 150);
    assert.equal(result.nodes.length, 3);
  });
});

// ---------------------------------------------------------------------------
// buildExplodedGraph - degrade paths
// ---------------------------------------------------------------------------

describe('buildExplodedGraph - degrade paths', () => {
  test('unsupported-language (explicit language id)', async () => {
    const model = {
      uri: { toString: () => 'file:///x.txt' },
      getLanguageId: () => 'plaintext',
      getValue: () => 'hello',
      isDisposed: () => false,
    };
    const result = await buildExplodedGraph({ model });
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
    assert.equal(result.diagnostics.parsed, false);
    assert.equal(result.diagnostics.degraded, true);
    assert.equal(result.diagnostics.reason, 'unsupported-language');
    assert.equal(result.diagnostics.language, 'plaintext');
  });

  test('unsupported-language (bare uri string, unrecognized extension)', async () => {
    const result = await buildExplodedGraph({ model: 'file:///x.json', getText: () => '{}' });
    assert.equal(result.diagnostics.reason, 'unsupported-language');
    assert.equal(result.diagnostics.language, null);
  });

  test('no-worker: disposed model', async () => {
    const model = {
      uri: { toString: () => 'file:///x.ts' },
      getLanguageId: () => 'typescript',
      getValue: () => 'export const x = 1;',
      isDisposed: () => true,
    };
    const result = await buildExplodedGraph({ model, workerClient: { getNavigationTree: async () => ({}) } });
    assert.equal(result.diagnostics.reason, 'no-worker');
    assert.equal(result.diagnostics.workerAvailable, false);
  });

  test('no-worker: no workerClient and no monacoApi (prod path unavailable)', async () => {
    const result = await buildExplodedGraph({ model: 'file:///x.ts', getText: () => 'const x = 1;' });
    assert.equal(result.diagnostics.reason, 'no-worker');
    assert.equal(result.diagnostics.workerAvailable, false);
  });

  test('no-worker: injected client missing getNavigationTree', async () => {
    const result = await buildExplodedGraph({
      model: 'file:///x.ts',
      getText: () => 'const x = 1;',
      workerClient: {},
    });
    assert.equal(result.diagnostics.reason, 'no-worker');
  });

  test('parse-failed: getNavigationTree resolves to null', async () => {
    const result = await buildExplodedGraph({
      model: 'file:///x.ts',
      getText: () => 'const x = 1;',
      workerClient: { getNavigationTree: async () => null },
    });
    assert.equal(result.diagnostics.reason, 'parse-failed');
    assert.equal(result.diagnostics.workerAvailable, true);
    assert.equal(result.diagnostics.parsed, false);
  });

  test('parse-failed: getNavigationTree throws', async () => {
    const result = await buildExplodedGraph({
      model: 'file:///x.ts',
      getText: () => 'const x = 1;',
      workerClient: { getNavigationTree: async () => { throw new Error('boom'); } },
    });
    assert.equal(result.diagnostics.reason, 'parse-failed');
  });

  test('never throws even when options is undefined', async () => {
    const result = await buildExplodedGraph();
    assert.deepEqual(result.nodes, []);
    assert.equal(result.diagnostics.degraded, true);
  });

  test('internal-error: a getText that throws degrades cleanly instead of propagating', async () => {
    const model = { uri: { toString: () => 'file:///boom.ts' }, getLanguageId: () => 'typescript', isDisposed: () => false };
    const result = await buildExplodedGraph({
      model, workerClient: { getNavigationTree: async () => ({}) }, getText: () => { throw new Error('boom'); },
    });
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
    assert.equal(result.diagnostics.degraded, true);
    assert.equal(result.diagnostics.reason, 'internal-error');
  });
});
