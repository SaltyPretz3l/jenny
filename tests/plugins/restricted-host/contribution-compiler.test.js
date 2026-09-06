'use strict';

const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ABI_WORLD,
  RESTRICTED_KINDS,
  compileRestrictedContributions,
} = require('../../../services/plugins/restricted-host/contribution-compiler');

function fixture(kind, overrides = {}) {
  const component = Buffer.from(`component:${kind}`);
  const componentDigest = crypto.createHash('sha256').update(component).digest('hex');
  const contribution = {
    kind, contribution_id: 'main', name: `Restricted ${kind}`,
    content_path: 'content/main.json', content_sha256: '1'.repeat(64),
    component_path: 'components/main.wasm', component_sha256: componentDigest,
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
    component,
    contribution,
    content,
    manifest: {
      manifest_schema_version: 4, publisher_id: 'acme-labs', plugin_id: 'widgets',
      requested_permissions: overrides.requested_permissions || [],
      contributions: [contribution],
    },
  };
}

function compile(item) {
  return compileRestrictedContributions({
    manifest: item.manifest,
    contents: [item.content],
    componentBytesByDigest: new Map([[item.contribution.component_sha256, item.component]]),
    authority: {
      artifact_digest: '2'.repeat(64), generation_id: 'gen-1', commit_epoch: 2,
      lifecycle_epoch: 3, policy_revision: 4, workspace_incarnation_id: 'workspace-1',
    },
    abiDigest: '3'.repeat(64),
    protocolDigest: '4'.repeat(64),
  });
}

test('all and only the four Stage 6 kinds compile to exact namespaced dynamic tools', () => {
  for (const kind of RESTRICTED_KINDS) {
    const result = compile(fixture(kind));
    assert.equal(result.ok, true, `${kind}: ${result.reason}`);
    assert.equal(result.descriptors.length, 1);
    assert.equal(result.descriptors[0].kind, kind);
    assert.equal(result.descriptors[0].namespaced_name, 'plugin:acme-labs:widgets:main');
    assert.equal(result.descriptors[0].commit_epoch, 2);
    assert.equal(Object.isFrozen(result.descriptors[0]), true);
  }
});

test('restricted network requires both signed origin and requested permission', () => {
  const withoutPermission = fixture('restricted_compute', {
    payload: {
      capabilities: ['network.request'], network_origins: ['https://api.example.test'],
    },
  });
  assert.equal(compile(withoutPermission).reason, 'restricted_network_permission_missing');

  const withoutOrigin = fixture('restricted_compute', {
    requested_permissions: ['network.restricted_runtime'],
    payload: { capabilities: ['network.request'], network_origins: [] },
  });
  assert.equal(compile(withoutOrigin).reason, 'restricted_network_origin_mismatch');

  const valid = fixture('restricted_compute', {
    requested_permissions: ['network.restricted_runtime'],
    payload: {
      capabilities: ['network.request'], network_origins: ['https://api.example.test'],
    },
  });
  assert.equal(compile(valid).ok, true);
});

test('component digest and ABI world mismatches fail closed before publication', () => {
  const wrongBytes = fixture('restricted_transform');
  wrongBytes.component = Buffer.from('replaced');
  assert.equal(compile(wrongBytes).reason, 'restricted_component_digest_mismatch');

  const wrongAbi = fixture('restricted_formatter');
  wrongAbi.contribution.abi_world = 'plugin:foreign/host@1.0.0';
  assert.equal(compile(wrongAbi).reason, 'restricted_content_authority_mismatch');
});
