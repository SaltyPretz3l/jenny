'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { CredentialBroker } = require('../../../services/plugins/auth/credential-broker');

const NOW = new Date('2026-08-05T20:00:00Z');
function authority(overrides = {}) {
  return {
    publisher_id: 'jenny-official', plugin_id: 'remote', contribution_id: 'server',
    descriptor_digest: 'a'.repeat(64), resource_digest: 'b'.repeat(64),
    issuer_digest: 'c'.repeat(64), auth_profile_ref: 'd'.repeat(64), ...overrides,
  };
}
function secureStore({ available = true } = {}) {
  const records = new Map();
  return {
    records,
    async setPluginRemoteMcpCredential(binding, value) {
      if (!available) throw new Error('weak storage secret');
      records.set(JSON.stringify(binding), value);
    },
    async getPluginRemoteMcpCredential(binding) {
      if (!available) throw new Error('weak storage secret');
      return records.get(JSON.stringify(binding)) || '';
    },
    async deletePluginRemoteMcpCredential(binding) { records.delete(JSON.stringify(binding)); },
  };
}

test('credential broker encrypts opaque material and persists only redacted authorization state', async () => {
  const store = secureStore();
  const broker = new CredentialBroker({ secureStore: store, facade: createMemoryFsFacade(),
    now: () => NOW });
  const saved = await broker.store(authority(), {
    access_token: 'top-secret', refresh_token: 'refresh-secret',
    granted_scopes: ['tools.read'], expires_at: '2026-08-05T21:00:00Z',
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.authorization.credential_present, true);
  assert.doesNotMatch(JSON.stringify(saved.authorization), /top-secret|refresh-secret/);
  assert.equal((await broker.get(authority())).credential.access_token, 'top-secret');
});

test('credential broker rejects authority drift, expiry, revocation, and weak storage', async () => {
  const facade = createMemoryFsFacade();
  const broker = new CredentialBroker({ secureStore: secureStore(), facade, now: () => NOW });
  await broker.store(authority(), { access_token: 'opaque', granted_scopes: [],
    expires_at: '2026-08-05T19:00:00Z' });
  assert.equal((await broker.get(authority())).reason, 'credential_expired');
  assert.equal((await broker.get(authority({ descriptor_digest: 'e'.repeat(64) }))).reason,
    'remote_authorization_required');
  assert.equal((await broker.get(authority({ plugin_id: 'other' }))).reason,
    'remote_authorization_required');
  assert.equal((await broker.get(authority(), { revoked: true })).reason, 'credential_authority_revoked');
  const unavailable = new CredentialBroker({ secureStore: secureStore({ available: false }),
    facade: createMemoryFsFacade(), now: () => NOW });
  assert.equal((await unavailable.store(authority(), { access_token: 'opaque', granted_scopes: [],
    expires_at: '2026-08-05T21:00:00Z' })).reason, 'secure_storage_unavailable');
});

test('credential broker revocation deletes encrypted material and survives a service restart', async () => {
  const facade = createMemoryFsFacade();
  const store = secureStore();
  const first = new CredentialBroker({ secureStore: store, facade, now: () => NOW });
  await first.store(authority(), { access_token: 'opaque', granted_scopes: [],
    expires_at: '2026-08-05T21:00:00Z' });
  const restarted = new CredentialBroker({ secureStore: store, facade, now: () => NOW });
  assert.equal((await restarted.get(authority())).ok, true);
  assert.equal((await restarted.revoke(authority())).ok, true);
  assert.equal((await restarted.get(authority())).reason, 'remote_authorization_required');
});
