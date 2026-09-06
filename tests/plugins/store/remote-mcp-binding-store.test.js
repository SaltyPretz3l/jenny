'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  bindingDigest,
  readRemoteMcpBinding,
  writeRemoteMcpBinding,
} = require('../../../services/plugins/store/remote-mcp-binding-store');

function binding(overrides = {}) {
  const value = {
    binding_schema_version: 1,
    publisher_id: 'jenny-official', plugin_id: 'remote', contribution_id: 'server',
    artifact_digest: 'a'.repeat(64), generation_id: 'gen-stage5', commit_epoch: 3,
    descriptor_digest: 'b'.repeat(64), schema_digest: 'c'.repeat(64),
    endpoint_url: 'https://example.test/mcp', endpoint_origin_digest: 'd'.repeat(64),
    destination_scope: 'internet', protocol_versions: ['2026-07-28'],
    feature_classes: ['tools'], consent_digest: 'e'.repeat(64),
    auth_profile_ref: 'f'.repeat(64), binding_digest: '0'.repeat(64),
    ...overrides,
  };
  value.binding_digest = bindingDigest(value);
  return value;
}

test('binding store validates, content-addresses, and rereads frozen evidence', async () => {
  const facade = createMemoryFsFacade();
  const value = binding();
  const written = await writeRemoteMcpBinding(facade, 'plugins', value);
  assert.equal(written.ok, true);
  assert.equal(written.digest, value.binding_digest);
  assert.deepEqual((await readRemoteMcpBinding(facade, 'plugins', written.digest)).binding, value);
});

test('binding store rejects authority drift and malformed digest paths', async () => {
  const facade = createMemoryFsFacade();
  const value = binding();
  value.endpoint_url = 'https://attacker.test/mcp';
  assert.equal((await writeRemoteMcpBinding(facade, '', value)).reason,
    'remote_mcp_binding_digest_mismatch');
  assert.equal((await readRemoteMcpBinding(facade, '', '../escape')).reason,
    'binding_digest_invalid');
});
