'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ABI_WORLD,
  RESTRICTED_KINDS,
  RESTRICTED_KIND_SET,
  validateRestrictedContent,
} = require('../../../services/plugins/package/restricted-content-validator');

function fixture(kind, overrides = {}) {
  const contribution = {
    kind, contribution_id: 'main', name: `Restricted ${kind}`,
    content_path: 'content/main.json', content_sha256: '1'.repeat(64),
    component_path: 'components/main.wasm', component_sha256: '2'.repeat(64),
    abi_world: ABI_WORLD,
  };
  const content = {
    content_schema_version: 4, publisher_id: 'acme-labs', plugin_id: 'widgets',
    contribution_id: 'main',
    payload: {
      kind, description: 'Bounded restricted contribution',
      input_schema_json: '{"type":"object"}',
      output_schema_json: '{"type":"object"}', timeout_ms: 1000,
      capabilities: ['control.cancelled'], network_origins: [],
      ...overrides.payload,
    },
  };
  return {
    contribution,
    content,
    manifest: {
      manifest_schema_version: 4, publisher_id: 'acme-labs', plugin_id: 'widgets',
      requested_permissions: overrides.requested_permissions || [],
      contributions: [contribution],
    },
  };
}

function check(item) {
  return validateRestrictedContent(item.content, {
    manifest: item.manifest, contribution: item.contribution,
  });
}

test('the four retired restricted kinds stay recognised so leftover packages still parse', () => {
  assert.deepEqual([...RESTRICTED_KINDS], [
    'restricted_transform', 'restricted_formatter', 'restricted_renderer', 'restricted_compute',
  ]);
  assert.equal(RESTRICTED_KIND_SET.has('restricted_compute'), true);
  assert.equal(RESTRICTED_KIND_SET.has('tool_descriptor'), false);
});

test('a leftover restricted package content still reverifies', () => {
  for (const kind of RESTRICTED_KINDS) {
    const checked = check(fixture(kind));
    assert.equal(checked.ok, true, `${kind}: ${checked.reason}`);
  }
});

test('authority, schema and permission mismatches still fail closed', () => {
  const wrongAbi = fixture('restricted_formatter');
  wrongAbi.contribution.abi_world = 'plugin:foreign/host@1.0.0';
  assert.equal(check(wrongAbi).reason, 'restricted_content_authority_mismatch');

  const wrongPlugin = fixture('restricted_compute');
  wrongPlugin.content.plugin_id = 'other';
  assert.equal(check(wrongPlugin).reason, 'restricted_content_authority_mismatch');

  assert.equal(check(fixture('restricted_compute', {
    payload: { input_schema_json: '[1]' },
  })).reason, 'restricted_schema_not_object');
  assert.equal(check(fixture('restricted_compute', {
    payload: { output_schema_json: '{nope' },
  })).reason, 'restricted_schema_json_invalid');

  assert.equal(check(fixture('restricted_compute', {
    payload: { capabilities: ['network.request'], network_origins: ['https://api.example.test'] },
  })).reason, 'restricted_network_permission_missing');
  assert.equal(check(fixture('restricted_compute', {
    requested_permissions: ['network.restricted_runtime'],
    payload: { capabilities: ['network.request'], network_origins: [] },
  })).reason, 'restricted_network_origin_mismatch');
  assert.equal(check(fixture('restricted_compute', {
    payload: { capabilities: ['secret.use_handle'] },
  })).reason, 'restricted_secret_permission_missing');
  assert.equal(check(fixture('restricted_compute', {
    requested_permissions: ['network.restricted_runtime'],
    payload: { capabilities: ['network.request'], network_origins: ['https://api.example.test'] },
  })).ok, true);
});
