'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatGptAuthService } = require('../services/backend/chatgpt-auth-service');

for (const payload of [{}, { access_token: '' }, { access_token: 123 },
  { access_token: 'x'.repeat(131073) }, { access_token: 'e30.eyJleHAiOjF9.test' }]) {
  test('malformed successful refresh preserves the original secure credential', async () => {
    let stored = JSON.stringify({ refresh_token: 'fixture-refresh',
      access_token: 'e30.eyJleHAiOjF9.old', id_token: 'fixture-id',
      account_id: 'fixture-account', last_refresh_ms: 1 });
    const original = stored;
    let writes = 0;
    const auth = createChatGptAuthService({
      secureStore: { getModelProviderOAuth: () => stored,
        setModelProviderOAuth: (_provider, value) => { stored = value; writes += 1; } },
      fetchImpl: async () => ({ status: 200, ok: true, json: async () => payload }),
    });
    await assert.rejects(auth.getAccessToken({ force: true }), { code: 'refresh_failed' });
    assert.equal(writes, 0);
    assert.equal(stored, original);
    assert.equal(auth.hasCredential(), true);
    assert.equal(auth.getCachedAccessToken(), '');
  });
}
