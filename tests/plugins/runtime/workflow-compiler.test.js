'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compileWorkflow,
  descriptorDigest,
} = require('../../../services/plugins/runtime/workflow-compiler');
const toolManifest = require('../../../services/tools/tool-manifest.json');

function compile(toolId = 'read_file', bindings = [{
  target: 'path', value: { source: 'setting', settings_contribution_id: 'settings-main', key: 'path' },
}]) {
  return compileWorkflow({
    publisherId: 'jenny-official',
    pluginId: 'starter',
    workflowId: 'workflow-main',
    contents: [],
    settingsFields: new Map([['settings-main', [{ type: 'string', key: 'path' }]]]),
    invocationFields: [],
    payload: {
      kind: 'workflow',
      entry_node_id: 'read',
      nodes: [{ type: 'tool', node_id: 'read', tool_id: toolId, bindings, max_attempts: 1, timeout_ms: 1000 }],
      edges: [],
      total_timeout_ms: 2000,
    },
  });
}

test('compiles an eligible scalar tool node with a canonical descriptor attestation', () => {
  const result = compile();
  const descriptor = toolManifest.tools.find((entry) => entry.name === 'read_file');

  assert.equal(result.ok, true);
  assert.equal(descriptorDigest(descriptor), '95620d16a1374d672d20dd3a36f7e7a1deba070af1d624ebacbb120a9f0229df');
  assert.equal(result.plan.terminal_node_id, 'read');
  assert.deepEqual(result.plan.nodes.map((node) => node.node_id), ['read']);
  assert.deepEqual(result.tool_bindings, [{
    publisher_id: 'jenny-official', plugin_id: 'starter', workflow_id: 'workflow-main',
    node_id: 'read', tool_id: 'read_file', manifest_version: 2,
    descriptor_sha256: descriptorDigest(descriptor),
  }]);
});

test('rejects forbidden tools, missing required bindings, unknown arguments, and type drift', () => {
  assert.deepEqual(compile('write_file'), {
    ok: false, reason: 'workflow_tool_not_eligible', detail: 'write_file',
  });
  assert.deepEqual(compile('read_file', []), {
    ok: false, reason: 'workflow_tool_required_input_missing', detail: 'read_file',
  });
  assert.deepEqual(compile('read_file', [
    { target: 'path', value: { source: 'literal_string', value: 'README.md' } },
    { target: 'unknown', value: { source: 'literal_string', value: 'x' } },
  ]), {
    ok: false, reason: 'workflow_binding_target_unknown', detail: 'read:unknown',
  });
  assert.deepEqual(compile('read_file', [{
    target: 'path', value: { source: 'literal_integer', value: 1 },
  }]), {
    ok: false, reason: 'workflow_binding_type_mismatch', detail: 'read:path',
  });
});

test('prompt nodes bind every declared placeholder exactly', () => {
  const result = compileWorkflow({
    publisherId: 'jenny-official', pluginId: 'starter', workflowId: 'workflow-main',
    contents: [{ contribution_id: 'prompt-main', payload: { kind: 'prompt', placeholders: ['subject', 'suffix'] } }],
    settingsFields: new Map(), invocationFields: [{ type: 'string', key: 'subject' }],
    payload: {
      kind: 'workflow', entry_node_id: 'prompt', edges: [], total_timeout_ms: 2_000,
      nodes: [{
        type: 'prompt', node_id: 'prompt', target_contribution_id: 'prompt-main',
        bindings: [{ target: 'subject', value: { source: 'invocation_input', key: 'subject' } }],
        max_attempts: 1, timeout_ms: 1_000,
      }],
    },
  });
  assert.deepEqual(result, {
    ok: false, reason: 'workflow_prompt_required_input_missing', detail: 'prompt',
  });
});
