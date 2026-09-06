'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_ITEM_CONTEXT_BYTES,
  validateDeclarativeContent,
} = require('../../../services/plugins/data/declarative-content-validator');

function content(kind, payload, overrides = {}) {
  return {
    content_schema_version: 1,
    publisher_id: 'acme-labs',
    plugin_id: 'widgets',
    contribution_id: `${kind}-main`,
    payload: { kind, ...payload },
    ...overrides,
  };
}

function contentV2(kind, payload, overrides = {}) {
  return content(kind, payload, { content_schema_version: 2, ...overrides });
}

const VALID_THEME_TOKENS = [
  ['surface.chat', '#000000'], ['surface.message_user', '#000000'],
  ['surface.message_assistant', '#000000'], ['surface.tool', '#000000'],
  ['text.primary', '#FFFFFF'], ['text.muted', '#B3B3B3'], ['text.link', '#66CCFF'],
  ['border.default', '#777777'], ['border.focus', '#00FFFF'],
  ['color.accent', '#005FCC'], ['color.accent_text', '#FFFFFF'],
].map(([token, value]) => ({ token, value }));

function workflow(nodes, edges, overrides = {}) {
  return content('workflow', {
    entry_node_id: nodes[0]?.node_id || 'start',
    nodes,
    edges,
    total_timeout_ms: 300000,
    ...overrides,
  });
}

function promptNode(nodeId) {
  return {
    type: 'prompt',
    node_id: nodeId,
    target_contribution_id: 'prompt-main',
    input_placeholders: ['input'],
    max_attempts: 2,
  };
}

test('skill/prompt context is bounded at 16 KiB and authority must match the manifest', () => {
  assert.equal(validateDeclarativeContent(content('skill', { instructions: 'x'.repeat(MAX_ITEM_CONTEXT_BYTES) })).ok, true);
  const overflow = validateDeclarativeContent(content('prompt', { template: 'x'.repeat(MAX_ITEM_CONTEXT_BYTES + 1) }));
  assert.equal(overflow.ok, false);
  assert.match(overflow.reason, /max_bytes_exceeded/);

  const mismatch = validateDeclarativeContent(content('skill', { instructions: 'safe' }), {
    expectedAuthority: { publisher_id: 'other', plugin_id: 'widgets', contribution_id: 'skill-main' },
    expectedKind: 'skill',
  });
  assert.deepEqual(mismatch, { ok: false, reason: 'manifest_authority_mismatch', path: 'publisher_id' });
});

test('themes accept host tokens only and reject CSS/network/executable value forms', () => {
  assert.equal(validateDeclarativeContent(content('theme', {
    tokens: [{ token: 'color.accent', value: '#12abef' }, { token: 'spacing.compact', value: '4px' }],
  })).ok, true);
  assert.equal(validateDeclarativeContent(content('theme', {
    tokens: [{ token: 'plugin.custom', value: '#fff' }],
  })).reason, 'contract_pattern_mismatch');
  for (const value of [
    'url(https://example.test/x)',
    '@import "x"',
    'javascript:alert(1)',
    '<script>x</script>',
    'body { color: red }',
    'red; position: fixed',
    'linear-gradient(red, blue)',
    'var(--plugin-color)',
  ]) {
    assert.equal(validateDeclarativeContent(content('theme', {
      tokens: [{ token: 'color.accent', value }],
    })).reason, 'contract_pattern_mismatch');
  }
});

test('V2 themes require the complete opaque host registry and accessible contrast', () => {
  assert.equal(validateDeclarativeContent(contentV2('theme', { tokens: VALID_THEME_TOKENS })).ok, true);
  assert.equal(validateDeclarativeContent(contentV2('theme', {
    tokens: VALID_THEME_TOKENS.slice(0, -1),
  })).reason, 'theme_token_set_incomplete');
  assert.match(validateDeclarativeContent(contentV2('theme', {
    tokens: VALID_THEME_TOKENS.map((row) => (
      row.token === 'text.primary' ? { ...row, value: '#111111' } : row
    )),
  })).reason, /contrast_insufficient/);
  assert.match(validateDeclarativeContent(contentV2('theme', {
    tokens: VALID_THEME_TOKENS.map((row) => (
      row.token === 'surface.chat' ? { ...row, value: '#00000080' } : row
    )),
  })).reason, /pattern_mismatch|max_bytes_exceeded/);
});

test('settings reject secret delivery and inconsistent defaults/bounds', () => {
  assert.equal(validateDeclarativeContent(content('settings_schema', {
    fields: [{ type: 'boolean', key: 'feature.enabled', label: 'Enabled', default: true }],
  })).ok, true);
  assert.equal(validateDeclarativeContent(content('settings_schema', {
    fields: [{ type: 'string', key: 'api_token', label: 'Token', default: '', max_length: 10 }],
  })).reason, 'secret_setting_key_rejected');
  assert.equal(validateDeclarativeContent(content('settings_schema', {
    fields: [{ type: 'integer', key: 'count', label: 'Count', default: 5, minimum: 10, maximum: 1 }],
  })).reason, 'integer_bounds_reversed');
  assert.equal(validateDeclarativeContent(content('settings_schema', {
    fields: [{ type: 'enum', key: 'mode', label: 'Mode', default: 'missing', values: ['one', 'two'] }],
  })).reason, 'enum_default_not_declared');
});

test('workflows are finite reachable DAGs with depth 16 and fan-out 4', () => {
  const validNodes = [promptNode('start'), promptNode('finish')];
  assert.equal(validateDeclarativeContent(workflow(validNodes, [{ from_node_id: 'start', to_node_id: 'finish' }])).ok, true);

  const cycle = workflow(validNodes, [
    { from_node_id: 'start', to_node_id: 'finish' },
    { from_node_id: 'finish', to_node_id: 'start' },
  ]);
  assert.equal(validateDeclarativeContent(cycle).reason, 'workflow_cycle_rejected');

  const fanNodes = [promptNode('start'), ...Array.from({ length: 5 }, (_unused, index) => promptNode(`leaf${index}`))];
  const fanEdges = fanNodes.slice(1).map((node) => ({ from_node_id: 'start', to_node_id: node.node_id }));
  assert.equal(validateDeclarativeContent(workflow(fanNodes, fanEdges)).reason, 'workflow_fan_out_exceeded');

  const deepNodes = Array.from({ length: 17 }, (_unused, index) => promptNode(`node${index}`));
  const deepEdges = deepNodes.slice(1).map((node, index) => ({ from_node_id: deepNodes[index].node_id, to_node_id: node.node_id }));
  assert.equal(validateDeclarativeContent(workflow(deepNodes, deepEdges)).reason, 'workflow_depth_exceeded');

  const unreachable = workflow([promptNode('start'), promptNode('orphan')], []);
  assert.equal(validateDeclarativeContent(unreachable).reason, 'workflow_unreachable_node');
});

test('MCP descriptors are inert metadata and reject endpoint/launch/auth fields structurally', () => {
  const valid = content('mcp_descriptor', {
    display_name: 'Local tools',
    transport_class: 'native_stdio',
    capabilities: ['tools.list'],
  });
  assert.equal(validateDeclarativeContent(valid).ok, true);
  for (const field of ['endpoint', 'launch_command', 'authentication']) {
    const hostile = structuredClone(valid);
    hostile.payload[field] = 'forbidden';
    const result = validateDeclarativeContent(hostile);
    assert.equal(result.ok, false);
    assert.match(result.reason, /max_keys_exceeded|unknown_field/);
  }
});
