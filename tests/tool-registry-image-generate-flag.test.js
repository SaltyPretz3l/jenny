'use strict';

// The image_generate tool is registered only under its default-on flag
// (services/tools/index.js); flag-off builds never see it, and the registered
// descriptor carries the manifest's contract (workspace-required, side-effecting).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDefaultRegistry } = require('../services/tools/index');

function findTool(registry, name) {
  return registry.getTool(name) || null;
}

test('image_generate registers under toolsImageGenerateEnabled with the manifest contract', () => {
  const registry = createDefaultRegistry({ toolsImageGenerateEnabled: true });
  const tool = findTool(registry, 'image_generate');
  assert.ok(tool, 'image_generate is registered when the flag is on');
  assert.equal(tool.workspaceRequired, true);
  assert.equal(tool.sideEffecting, true);
  assert.equal(tool.readOnly, false);
  assert.equal(tool.toolFamily, 'workspace');
  assert.equal(typeof tool.execute, 'function');
  assert.deepEqual(tool.parameters.required, ['prompt']);
  assert.equal(tool.summarize({ prompt: '  a red   fox\n in snow ' }), 'Generate image: a red fox in snow');
  assert.equal(tool.summarize({}), 'Generate image');
});

test('image_generate is absent when the flag is off (kill switch path)', () => {
  const registry = createDefaultRegistry({});
  assert.equal(findTool(registry, 'image_generate'), null);
});
