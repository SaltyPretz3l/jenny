'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry } = require('../services/tools/tool-registry');
const { ToolExecutor } = require('../services/tools/tool-executor');

function makeMockTool(overrides = {}) {
  return {
    name: 'MockTool',
    description: 'A mock tool',
    category: 'builtin',
    readOnly: false,
    sideEffecting: false,
    parameters: { type: 'object', properties: {} },
    summarize: () => 'MockTool',
    execute: async () => ({ content: 'done', summary: 'done', isError: false }),
    ...overrides,
  };
}

function makeRegistry(tools = []) {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.registerTool(tool);
  }
  return registry;
}

describe('ToolExecutor permission policy snapshots', () => {
  const readTool = makeMockTool({
    name: 'read_file',
    readOnly: true,
    toolFamily: 'filesystem',
    sourceKind: 'builtin',
  });
  const writeTool = makeMockTool({
    name: 'write_file',
    sideEffecting: true,
    toolFamily: 'filesystem',
    sourceKind: 'builtin',
  });

  test('requires approval when the permission snapshot cannot be read', () => {
    const logs = [];
    const executor = new ToolExecutor({
      registry: makeRegistry([readTool, writeTool]),
      permissionStore: {
        getSnapshot() {
          throw new Error('permission file unreadable');
        },
      },
      pathPolicy: {},
      logger(level, event, payload) {
        logs.push({ level, event, payload });
      },
    });

    assert.equal(executor.getToolPolicy('read_file'), 'ask');
    assert.equal(executor.getToolPolicy('write_file'), 'ask');
    assert.ok(logs.some(({ level, event, payload }) => (
      level === 'WARN'
      && event === 'tool.policy_snapshot_unavailable'
      && payload.effect === 'approval_required'
    )));
  });

  test('keeps the read-only automatic default when no permission store exists', () => {
    const executor = new ToolExecutor({
      registry: makeRegistry([readTool]),
      pathPolicy: {},
      logger() {},
    });

    assert.equal(executor.getToolPolicy('read_file'), 'auto');
  });
});
