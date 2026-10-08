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

function mixedActionExecutor(executed) {
  const registry = new ToolRegistry();
  registry.registerTool({
    name: 'mixed', description: 'mixed', parameters: { type: 'object' },
    readOnly: false, sideEffecting: true, workspaceRequired: false,
    actions: { list: { side_effecting: false }, add: { side_effecting: true } },
    summarize: () => 'mixed',
    execute: async (input) => {
      executed.push(input.action);
      return { content: `ran ${input.action}`, isError: false };
    },
  });
  return new ToolExecutor({
    registry,
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    pathPolicy: {}, logger: () => {},
  });
}

test('read-only boundary admits the declared read action of a mixed tool (HB-002)', async () => {
  const executed = [];
  const executor = mixedActionExecutor(executed);
  const context = { sessionId: 's', streamId: 't', readOnly: true, planMode: true, workingDirectory: '' };
  const listed = await executor.executePreApproved(
    { callId: 'call_list', toolName: 'mixed', input: { action: 'list' } }, context);
  assert.equal(listed.isError, false, listed.content);
  for (const input of [{ action: 'add' }, {}, { action: 'undeclared' }]) {
    const refused = await executor.executePreApproved(
      { callId: `call_${input.action || 'none'}`, toolName: 'mixed', input }, context);
    assert.equal(refused.isError, true);
    assert.match(refused.content, /read-only/i);
  }
  assert.deepEqual(executed, ['list']);
});

test('Plan Mode keeps task_board list, project_notes read and home calendar_list but refuses their writes', () => {
  const executor = new ToolExecutor({
    registry: createDefaultRegistry({ toolsHomeEnabled: true, toolsTaskBoardEnabled: true, toolsProjectNotesEnabled: true }),
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    pathPolicy: {}, logger: () => {},
  });
  const context = { sessionId: 's', streamId: 't', readOnly: true, planMode: true, workingDirectory: '' };
  // The read-only gate is the preflight step; execution needs live Home and
  // Open Loops services, which the executor tests cover separately.
  const verdict = (toolName, input) => {
    const preflight = executor._preflightTool({ callId: `c_${toolName}`, toolName, input }, context,
      { preApproved: true });
    return preflight.tool ? 'allowed' : 'refused';
  };
  assert.equal(verdict('task_board', { action: 'list' }), 'allowed');
  assert.equal(verdict('task_board', { action: 'add', label: 'x' }), 'refused');
  assert.equal(verdict('project_notes', { action: 'read' }), 'allowed');
  assert.equal(verdict('project_notes', { action: 'append', text: 'x' }), 'refused');
  assert.equal(verdict('project_notes', { action: 'replace', old_text: 'a', new_text: 'b' }), 'refused');
  assert.equal(verdict('home', { action: 'calendar_list' }), 'allowed');
  assert.equal(verdict('home', { action: 'scratchpad_read' }), 'allowed');
  assert.equal(verdict('home', { action: 'event_upsert' }), 'refused');
  assert.equal(verdict('home', { action: 'reminder_delete' }), 'refused');
});
