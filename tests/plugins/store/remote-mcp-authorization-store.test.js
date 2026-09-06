'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  readRemoteMcpAuthorization,
  writeRemoteMcpAuthorization,
} = require('../../../services/plugins/store/remote-mcp-authorization-store');

function authorization(overrides = {}) {
  return {
    authorization_schema_version: 1,
    publisher_id: 'jenny-official', plugin_id: 'remote', contribution_id: 'server',
    resource_digest: 'a'.repeat(64), issuer_digest: 'b'.repeat(64),
    auth_profile_ref: 'c'.repeat(64), state: 'authorized',
    granted_scopes: ['tools.read'], credential_present: true,
    expires_at: '2026-08-05T23:00:00Z', updated_at: '2026-08-05T22:00:00Z',
    ...overrides,
  };
}

test('authorization store persists only frozen redacted state', async () => {
  const facade = createMemoryFsFacade();
  const value = authorization();
  assert.equal((await writeRemoteMcpAuthorization(facade, 'plugins', value)).ok, true);
  const read = await readRemoteMcpAuthorization(facade, 'plugins', value.auth_profile_ref);
  assert.deepEqual(read.authorization, value);
  assert.doesNotMatch(JSON.stringify(read.authorization), /access_token|refresh_token|Bearer/);
});

test('authorization store fails closed for malformed or mismatched state', async () => {
  const facade = createMemoryFsFacade();
  assert.equal((await writeRemoteMcpAuthorization(facade, '', authorization({
    state: 'authorized', credential_present: 'yes',
  }))).reason, 'remote_mcp_authorization_invalid');
  assert.equal((await readRemoteMcpAuthorization(facade, '', '../escape')).reason,
    'auth_profile_ref_invalid');
});
