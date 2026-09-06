'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { OAuthFlowService, MAX_FLOWS } = require('../../../services/plugins/auth/oauth-flow-service');

const NOW = new Date('2026-08-05T20:00:00Z');
function binding() {
  return { publisher_id: 'jenny-official', plugin_id: 'remote', contribution_id: 'server',
    descriptor_digest: 'a'.repeat(64), auth_profile_ref: 'd'.repeat(64) };
}
function broker({ token = {} } = {}) {
  const calls = [];
  return { calls, async request(input) {
    calls.push(input);
    if (input.purpose === 'oauth_token') return { ok: true, status_code: 200, headers: {},
      body: Buffer.from(JSON.stringify({ token_type: 'Bearer', access_token: 'opaque',
        expires_in: 3600, scope: 'tools.read', ...token })) };
    if (input.url.includes('oauth-protected-resource')) return { ok: true, status_code: 200, headers: {},
      body: Buffer.from(JSON.stringify({ resource: 'https://mcp.test/mcp',
        authorization_servers: ['https://auth.test'], scopes_supported: ['tools.read'] })) };
    return { ok: true, status_code: 200, headers: {}, body: Buffer.from(JSON.stringify({
      issuer: 'https://auth.test', authorization_endpoint: 'https://auth.test/authorize',
      token_endpoint: 'https://auth.test/token', code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    })) };
  } };
}
function credentials() {
  return { states: [], stored: [],
    async writeState(authority, fields) { this.states.push({ authority, fields }); return { ok: true }; },
    async store(authority, value) { this.stored.push({ authority, value }); return { ok: true }; } };
}
function input(overrides = {}) {
  return { binding: binding(), resource_url: 'https://mcp.test/mcp',
    redirect_uri: 'http://127.0.0.1:49152/callback', registration: {
      client_id_metadata_document: 'https://jenny.test/oauth/client.json',
    }, context: { request_id: 'req-1', operation_id: 'op-1', consent: {},
      deadline_epoch_ms: NOW.getTime() + 60000 }, ...overrides };
}

test('OAuth flow uses PKCE S256, state/resource binding, and stores validated tokens', async () => {
  const network = broker(); const credentialBroker = credentials();
  const service = new OAuthFlowService({ networkBroker: network, credentialBroker,
    now: () => NOW, randomBytes: (size) => Buffer.alloc(size, 7) });
  const begun = await service.beginAuthorization(input());
  assert.equal(begun.ok, true);
  const authorization = new URL(begun.authorization_url);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  // The METHOD label is not the derivation. randomBytes is pinned to Buffer.alloc(48, 7),
  // so the verifier and its S256 challenge are fixed values; these literals are
  // independent of production, which is what makes a switch to sha1 detectable.
  assert.equal(
    authorization.searchParams.get('code_challenge'),
    'Ir8XyCKefo-uHOtECWrNwk4BiKfbSZNJ0CcQAZcvA9A',
    'code_challenge must be base64url(sha256(verifier))'
  );
  assert.equal(authorization.searchParams.get('resource'), 'https://mcp.test/mcp');
  const callback = new URL('http://127.0.0.1:49152/callback');
  callback.searchParams.set('code', 'authorization-code');
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('iss', 'https://auth.test');
  assert.equal((await service.completeAuthorization({ flow_id: begun.flow_id,
    callback_url: callback.href })).ok, true);
  assert.equal(credentialBroker.stored[0].value.access_token, 'opaque');
  const tokenCall = network.calls.find((call) => call.purpose === 'oauth_token');
  assert.equal(tokenCall.same_origin_redirects_only, true);
  // The authorization URL carrying `resource` proves nothing about the TOKEN
  // exchange, which is where a swapped resource would bind the credential to the
  // wrong audience.
  const tokenForm = new URLSearchParams(tokenCall.body);
  assert.equal(tokenForm.get('resource'), 'https://mcp.test/mcp',
    'the token request must bind the same resource as the authorization request');
  assert.equal(tokenForm.get('code_verifier'),
    'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH',
    'the token request must present the verifier the challenge was derived from');
});

test('OAuth flow rejects state/issuer mix-up and scope escalation', async () => {
  const service = new OAuthFlowService({ networkBroker: broker(), credentialBroker: credentials(),
    now: () => NOW, randomBytes: (size) => Buffer.alloc(size, 4) });
  const begun = await service.beginAuthorization(input());
  assert.equal((await service.completeAuthorization({ flow_id: begun.flow_id,
    callback_url: 'http://127.0.0.1:49152/callback?code=x&state=wrong&iss=https%3A%2F%2Fauth.test' })).reason,
  'oauth_state_mismatch');
  const escalated = new OAuthFlowService({ networkBroker: broker({ token: { scope: 'admin' } }),
    credentialBroker: credentials(), now: () => NOW, randomBytes: (size) => Buffer.alloc(size, 5) });
  const second = await escalated.beginAuthorization(input());
  const state = new URL(second.authorization_url).searchParams.get('state');
  const callback = `http://127.0.0.1:49152/callback?code=x&state=${state}&iss=https%3A%2F%2Fauth.test`;
  assert.equal((await escalated.completeAuthorization({ flow_id: second.flow_id,
    callback_url: callback })).reason, 'oauth_token_response_invalid');
});

test('OAuth flow enforces one resource flow, global bounds, step-up cap, and restart loss', async () => {
  const service = new OAuthFlowService({ networkBroker: broker(), credentialBroker: credentials(),
    now: () => NOW, randomBytes: cryptoRandom });
  const first = await service.beginAuthorization(input());
  assert.equal((await service.beginAuthorization(input())).reason, 'oauth_resource_flow_in_progress');
  await service.completeAuthorization({ flow_id: first.flow_id,
    callback_url: 'http://127.0.0.1:49152/callback?state=wrong' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stepped = await service.beginAuthorization(input({ previous_scopes: ['tools.read'],
      challenge_header: 'Bearer scope="admin"' }));
    assert.equal(stepped.ok, true);
    await service.completeAuthorization({ flow_id: stepped.flow_id,
      callback_url: 'http://127.0.0.1:49152/callback?state=wrong' });
  }
  assert.equal((await service.beginAuthorization(input({ previous_scopes: ['tools.read'],
    challenge_header: 'Bearer scope="admin"' }))).reason, 'oauth_step_up_limit_exceeded');
  // `first` was already removed by its failed callback, so asserting it is gone
  // after dispose proved nothing. Open a flow that is still live at dispose time.
  const live = await service.beginAuthorization(input());
  assert.equal(live.ok, true, 'a live flow must exist for dispose to clear');
  service.dispose();
  assert.equal((await service.completeAuthorization({ flow_id: live.flow_id,
    callback_url: 'http://127.0.0.1:49152/callback' })).reason, 'oauth_flow_not_found');
});

// W7c-09-F05: the global MAX_FLOWS bound had no coverage. The suite only ever
// opened flows for ONE resource, so the second one hit the per-resource guard
// (`oauth_resource_flow_in_progress`) and the capacity check was never reached
// -- raising MAX_FLOWS from 4 to 64 changed nothing. This broker echoes whatever
// resource was discovered, so four DISTINCT flows can be live at once.
function echoingBroker() {
  return { async request(input) {
    const wellKnown = '/.well-known/oauth-protected-resource';
    if (input.url.includes(wellKnown)) {
      const url = new URL(input.url);
      const resource = url.origin + url.pathname.slice(wellKnown.length);
      return { ok: true, status_code: 200, headers: {}, body: Buffer.from(JSON.stringify({
        resource, authorization_servers: ['https://auth.test'], scopes_supported: ['tools.read'] })) };
    }
    return { ok: true, status_code: 200, headers: {}, body: Buffer.from(JSON.stringify({
      issuer: 'https://auth.test', authorization_endpoint: 'https://auth.test/authorize',
      token_endpoint: 'https://auth.test/token', code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    })) };
  } };
}

test('OAuth flow refuses a fifth concurrent flow across distinct resources', async () => {
  // Driving the loop from MAX_FLOWS alone makes this test track the constant
  // instead of checking it: raising the cap to 64 just opens 64 flows and the
  // overflow assertion still holds. The bound is a DoS limit, so pin the value.
  assert.equal(MAX_FLOWS, 4, 'MAX_FLOWS is a concurrency bound; raise it deliberately');
  const service = new OAuthFlowService({ networkBroker: echoingBroker(),
    credentialBroker: credentials(), now: () => NOW, randomBytes: cryptoRandom });
  for (let i = 0; i < MAX_FLOWS; i += 1) {
    const opened = await service.beginAuthorization(input({ resource_url: `https://mcp.test/r${i}` }));
    assert.equal(opened.ok, true, `flow ${i} must open below the cap`);
  }
  const overflow = await service.beginAuthorization(input({ resource_url: 'https://mcp.test/r-overflow' }));
  assert.equal(overflow.reason, 'oauth_flow_capacity_exceeded',
    'a distinct resource past MAX_FLOWS must hit the global cap, not the per-resource guard');
  service.dispose();
});

test('OAuth flow rejects malformed previous scopes without throwing', async () => {
  const service = new OAuthFlowService({ networkBroker: broker(), credentialBroker: credentials(),
    now: () => NOW, randomBytes: (size) => Buffer.alloc(size, 6) });
  assert.equal((await service.beginAuthorization(input({
    previous_scopes: ['bad scope'],
  }))).reason, 'oauth_scope_invalid');
});

test('dispose is terminal for in-flight discovery, state writes, and token exchange', async () => {
  const discoveryCredentials = credentials();
  let discoveryService;
  const discoveryNetwork = broker();
  const discoveryRequest = discoveryNetwork.request.bind(discoveryNetwork);
  discoveryNetwork.request = async (request) => {
    const result = await discoveryRequest(request);
    discoveryService.dispose();
    return result;
  };
  discoveryService = new OAuthFlowService({ networkBroker: discoveryNetwork,
    credentialBroker: discoveryCredentials, now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, 7) });
  assert.equal((await discoveryService.beginAuthorization(input())).reason, 'oauth_flow_cancelled');
  assert.equal(discoveryCredentials.states.length, 0);

  const stateCredentials = credentials();
  let stateService;
  stateCredentials.writeState = async () => {
    stateService.dispose();
    return { ok: true };
  };
  stateService = new OAuthFlowService({ networkBroker: broker(), credentialBroker: stateCredentials,
    now: () => NOW, randomBytes: (size) => Buffer.alloc(size, 8) });
  assert.equal((await stateService.beginAuthorization(input())).reason, 'oauth_flow_cancelled');

  const tokenCredentials = credentials();
  let tokenService;
  const tokenNetwork = broker();
  const tokenRequest = tokenNetwork.request.bind(tokenNetwork);
  tokenNetwork.request = async (request) => {
    const result = await tokenRequest(request);
    if (request.purpose === 'oauth_token') tokenService.dispose();
    return result;
  };
  tokenService = new OAuthFlowService({ networkBroker: tokenNetwork,
    credentialBroker: tokenCredentials, now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, 9) });
  const begun = await tokenService.beginAuthorization(input());
  const authorization = new URL(begun.authorization_url);
  const callback = new URL(input().redirect_uri);
  callback.searchParams.set('code', 'authorization-code');
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('iss', 'https://auth.test');
  assert.equal((await tokenService.completeAuthorization({ flow_id: begun.flow_id,
    callback_url: callback.href })).reason, 'oauth_flow_cancelled');
  assert.equal(tokenCredentials.stored.length, 0);
});

function cryptoRandom(size) { return require('node:crypto').randomBytes(size); }
