'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultRegistry, ToolRegistry } = require('../services/tools');
const { ToolExecutor } = require('../services/tools/tool-executor');

test('exit_plan_mode is structurally limited to Plan Mode schemas', () => {
  const registry = createDefaultRegistry();
  const normal = registry.getToolSchemas({ planMode: false }).map((entry) => entry.function.name);
  const planning = registry.getToolSchemas({ planMode: true }).map((entry) => entry.function.name);
  assert.equal(normal.includes('exit_plan_mode'), false);
  assert.equal(planning.includes('exit_plan_mode'), true);
});

test('read-only boundary blocks mutating tools even when execution was pre-approved', async () => {
  const registry = new ToolRegistry();
  registry.registerTool({
    name: 'mutate', description: 'mutate', parameters: { type: 'object' },
    readOnly: false, sideEffecting: true, workspaceRequired: false,
    summarize: () => 'mutate',
    execute: async () => ({ content: 'mutated', isError: false }),
  });
  const executor = new ToolExecutor({
    registry,
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    pathPolicy: {}, logger: () => {},
  });
  const result = await executor.executePreApproved(
    { callId: 'call_mutate', toolName: 'mutate', input: {} },
    { sessionId: 's', streamId: 't', readOnly: true, workingDirectory: '' }
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /read-only/i);
});

test('direct out-of-mode exit_plan_mode invocation fails explicitly', async () => {
  const registry = createDefaultRegistry();
  const executor = new ToolExecutor({
    registry,
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    pathPolicy: {}, logger: () => {},
  });
  const result = await executor.executePreApproved(
    { callId: 'call_exit', toolName: 'exit_plan_mode', input: { title: 'Plan', steps: ['Step'] } },
    { sessionId: 's', streamId: 't', planMode: false, readOnly: false, workingDirectory: '' }
  );
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'CMP-TOOL-0002');
});
