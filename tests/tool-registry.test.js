'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry } = require('../services/tools/tool-registry');
const { createDefaultRegistry } = require('../services/tools');

function makeTool(overrides = {}) {
  return {
    name: 'TestTool',
    description: 'A test tool',
    category: 'builtin',
    readOnly: false,
    parameters: { type: 'object', properties: {} },
    summarize: (input) => `TestTool`,
    execute: async (input, ctx) => ({ content: 'ok', summary: 'ok', isError: false }),
    ...overrides,
  };
}

describe('ToolRegistry', () => {
  test('registerTool stores and getTool retrieves', () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool({ name: 'Read' }));
    const tool = registry.getTool('Read');
    assert.equal(tool.name, 'Read');
    assert.equal(tool.description, 'A test tool');
  });

  test('getTool returns undefined for unknown tools', () => {
    const registry = new ToolRegistry();
    assert.equal(registry.getTool('Unknown'), undefined);
  });

  test('registerTool throws on duplicate name', () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool({ name: 'Read' }));
    assert.throws(
      () => registry.registerTool(makeTool({ name: 'Read' })),
      /already registered/
    );
  });

  test('registerTool throws when required fields are missing', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () => registry.registerTool({ name: 'Bad' }),
      /missing required field/
    );
  });

  test('registerTool throws when execute is not a function', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () => registry.registerTool(makeTool({ execute: 'not a function' })),
      /execute must be a function/
    );
  });

  test('getAllTools returns all registered tools', () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool({ name: 'A' }));
    registry.registerTool(makeTool({ name: 'B' }));
    const all = registry.getAllTools();
    assert.equal(all.length, 2);
    assert.equal(all[0].name, 'A');
    assert.equal(all[1].name, 'B');
  });

  test('getToolSchemas returns schemas for all tools', () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool({ name: 'Read', readOnly: true }));
    registry.registerTool(makeTool({ name: 'Write', readOnly: false }));
    const schemas = registry.getToolSchemas();
    assert.equal(schemas.length, 2);
    assert.equal(schemas[0].type, 'function');
    assert.equal(schemas[0].function.name, 'Read');
  });

  test('getToolSchemas with planMode filters to readOnly', () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool({ name: 'Read', readOnly: true }));
    registry.registerTool(makeTool({ name: 'Write', readOnly: false }));
    const schemas = registry.getToolSchemas({ planMode: true });
    assert.equal(schemas.length, 1);
    assert.equal(schemas[0].function.name, 'Read');
  });

  test('readOnly defaults to false when not set', () => {
    const registry = new ToolRegistry();
    const def = makeTool({ name: 'X' });
    delete def.readOnly;
    registry.registerTool(def);
    assert.equal(registry.getTool('X').readOnly, false);
  });

  test('registerTool exposes canonical names while resolving legacy aliases', () => {
    const registry = new ToolRegistry();
    registry.registerTool(makeTool({ name: 'run_command', aliases: ['Bash'] }));

    assert.equal(registry.getTool('run_command').name, 'run_command');
    assert.equal(registry.getTool('Bash').name, 'run_command');
    assert.equal(registry.getToolSchemas()[0].function.name, 'run_command');
  });

  test('default registry does not duplicate sidecar-owned canonical tools', () => {
    const registry = createDefaultRegistry();
    const schemaNames = registry.getToolSchemas().map((entry) => entry.function.name);

    for (const toolName of [
      'read_file',
      'write_file',
      'edit_file',
      'glob_files',
      'grep_search',
      'run_command',
      'create_artifact',
    ]) {
      assert.equal(schemaNames.includes(toolName), false, toolName);
    }
  });

  test('default registry exposes Jenny status as a read-only workspace-independent facade', () => {
    const registry = createDefaultRegistry();
    const tool = registry.getTool('jenny_status');

    assert.ok(tool);
    assert.equal(tool.category, 'diagnostics');
    assert.equal(tool.readOnly, true);
    assert.equal(tool.workspaceRequired, false);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.parameters.properties.session_id.type, 'string');

    const planModeNames = registry
      .getToolSchemas({ planMode: true })
      .map((entry) => entry.function.name);
    assert.equal(planModeNames.includes('jenny_status'), true);
  });

});
