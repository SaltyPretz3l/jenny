'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseBearerChallenge,
  protectedResourceMetadataUrls,
  authorizationMetadataUrls,
  discoverAuthorizationServer,
  chooseClientRegistration,
} = require('../../../services/plugins/auth/oauth-metadata');

function response(value) {
  return { ok: true, status_code: 200, body: Buffer.from(JSON.stringify(value)), headers: {} };
}

test('challenge and well-known construction preserve resource paths and bounded scopes', () => {
  const challenge = parseBearerChallenge('Bearer resource_metadata="https://mcp.test/meta", scope="tools.read files:read"');
  assert.deepEqual(challenge.scopes, ['tools.read', 'files:read']);
  assert.equal(challenge.resource_metadata, 'https://mcp.test/meta');
  assert.equal(parseBearerChallenge('Basic realm="mcp"').reason, 'oauth_challenge_invalid');
  const urls = protectedResourceMetadataUrls('https://mcp.test/public/mcp');
  assert.deepEqual(urls.urls, [
    'https://mcp.test/.well-known/oauth-protected-resource/public/mcp',
    'https://mcp.test/.well-known/oauth-protected-resource',
  ]);
  assert.deepEqual(authorizationMetadataUrls('https://auth.test/tenant').urls, [
    'https://auth.test/.well-known/oauth-authorization-server/tenant',
    'https://auth.test/.well-known/openid-configuration/tenant',
    'https://auth.test/tenant/.well-known/openid-configuration',
  ]);
});

test('discovery rejects issuer confusion and accepts exact RFC 8414 metadata', async () => {
  const calls = [];
  const broker = { request: async (input) => {
    calls.push(input.url);
    if (input.url.includes('oauth-protected-resource')) return response({
      resource: 'https://mcp.test/mcp', authorization_servers: ['https://auth.test/tenant'],
      scopes_supported: ['tools.read'],
    });
    return response({
      issuer: calls.some((url) => url.includes('openid-configuration'))
        ? 'https://auth.test/tenant' : 'https://attacker.test',
      authorization_endpoint: 'https://auth.test/authorize',
      token_endpoint: 'https://auth.test/token', code_challenge_methods_supported: ['S256'],
    });
  } };
  const result = await discoverAuthorizationServer({ broker, resourceUrl: 'https://mcp.test/mcp',
    context: { request_id: 'req-1', operation_id: 'op-1', consent: {},
      deadline_epoch_ms: Date.now() + 1000 } });
  assert.equal(result.ok, true);
  assert.equal(result.issuer, 'https://auth.test/tenant');
  assert.equal(calls.some((url) => url.includes('openid-configuration')), true);
});

test('Jenny registration policy keeps CIMD ahead of preregistration and DCR explicit', () => {
  const metadata = { client_id_metadata_document_supported: true,
    registration_endpoint: 'https://auth.test/register' };
  const chosen = chooseClientRegistration(metadata, {
    client_id_metadata_document: 'https://jenny.test/oauth/client.json',
    preregistered: { client_id: 'static-id' }, allow_dcr: true,
  });
  assert.equal(chosen.kind, 'client_id_metadata_document');
  assert.equal(chooseClientRegistration({ registration_endpoint: metadata.registration_endpoint }, {
    allow_dcr: false,
  }).reason, 'oauth_client_registration_unavailable');
});
