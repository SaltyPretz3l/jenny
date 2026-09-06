'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scanExports, scanImports } = require('../renderer/features/renderer-ide-exploded-graph-utils');
const { buildExplodedGraph } = require('../renderer/features/renderer-ide-exploded-graph');

test('combined default and namespace imports preserve both bindings and offsets', () => {
  const source = "import Def, * as ns from 'pkg';\n";
  const bindings = scanImports(source);

  assert.deepEqual(bindings.map(({ name, source: moduleName }) => [name, moduleName]), [
    ['Def', 'pkg'],
    ['ns', 'pkg'],
  ]);
  for (const binding of bindings) {
    assert.equal(source.slice(binding.nameOffset, binding.nameOffset + binding.name.length), binding.name);
  }
});

test('import scanning ignores import examples inside block and line comments', () => {
  const source = [
    "/* import { blockFake } from 'block-example'; */",
    "// import { lineFake } from 'line-example';",
    "import { real } from 'real-module';",
    '',
  ].join('\n');
  const bindings = scanImports(source);

  assert.deepEqual(bindings.map(({ name, source: moduleName }) => [name, moduleName]), [
    ['real', 'real-module'],
  ]);
  assert.equal(source.slice(bindings[0].nameOffset, bindings[0].nameOffset + 4), 'real');
});

test('semicolonless default identifier exports are recognized at a line ending', () => {
  const result = scanExports('function f() {}\nexport default f\n');

  assert.equal(result.defaultName, 'f');
});

test('graph construction reads one source snapshot from an injected getter', async () => {
  let calls = 0;
  const result = await buildExplodedGraph({
    model: 'file:///snapshot.ts',
    workerClient: { getNavigationTree: async () => ({ childItems: [] }) },
    getText() {
      calls += 1;
      return 'const value = 1;';
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.diagnostics.parsed, true);
});
