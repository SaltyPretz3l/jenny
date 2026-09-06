'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPluginProviderAuthService } = require('../../../services/plugins/provider/provider-auth-service');

test('provider auth delegates to the existing credential owner without exposing tokens', async () => {
  const events = [];
  const owner = {
    getStatus: () => ({ status: 'signed_in' }),
    start: async () => ({ status: 'signed_in' }),
    cancel: () => events.push('cancel'),
    signOut: async () => ({ status: 'signed_out' }),
    hasCredential: () => true,
    getAccessToken: async () => 'secret-token',
    onStatusChange: () => () => {},
  };
  const service = createPluginProviderAuthService({ chatgptAuthService: owner,
    isProviderActive: () => true, onAuthChanged: async (value) => events.push(value.reason) });
  assert.deepEqual(service.status('chatgpt'), { ok: true, provider_id: 'chatgpt', active: true,
    auth: { status: 'signed_in' } });
  assert.equal(JSON.stringify(await service.start('chatgpt', {})).includes('secret-token'), false);
  assert.equal(await service.getAccessToken('chatgpt'), 'secret-token');
  await service.signOut('chatgpt');
  assert.deepEqual(events, ['provider_auth_started', 'provider_auth_signed_out']);
});

test('a missing auth owner degrades the provider surface without throwing', async () => {
  const service = createPluginProviderAuthService();
  assert.equal(service.status('chatgpt').reason, 'provider_not_available');
  assert.equal((await service.start('chatgpt')).reason, 'provider_not_available');
  assert.equal(await service.getAccessToken('chatgpt'), '');
});

test('committed auth changes stay successful when provider reconfiguration degrades', async () => {
  const logged = [];
  const owner = {
    getStatus: () => ({ state: 'signed_in' }),
    start: async () => ({ state: 'signed_in' }),
    cancel() {},
    signOut: async () => ({ state: 'signed_out' }),
    hasCredential: () => false,
    getAccessToken: async () => '',
    onStatusChange: () => () => {},
  };
  const service = createPluginProviderAuthService({
    chatgptAuthService: owner,
    onAuthChanged: async () => { throw new Error('sensitive downstream detail'); },
    log: (event, detail) => logged.push([event, detail]),
  });

  const signedOut = await service.signOut('chatgpt');
  assert.deepEqual(signedOut, {
    ok: true,
    provider_id: 'chatgpt',
    auth: { state: 'signed_out' },
  });
  assert.deepEqual(logged, [['plugin.provider.reconfigure_failed', {
    provider_id: 'chatgpt',
    operation: 'provider_auth_signed_out',
    reason_code: 'provider_reconfigure_failed',
  }]]);
  assert.equal(JSON.stringify(logged).includes('sensitive downstream detail'), false);
});
