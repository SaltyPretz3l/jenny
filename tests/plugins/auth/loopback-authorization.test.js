'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createLoopbackAuthorization,
} = require('../../../services/plugins/auth/loopback-authorization');

function fakeServer(onListen) {
  const server = new EventEmitter();
  server.closed = 0;
  server.listen = (_port, _host, callback) => onListen(callback);
  server.address = () => ({ port: 49152 });
  server.close = () => { server.closed += 1; };
  return server;
}

function fakeResponse() {
  return {
    body: '', statusCode: 0,
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body) { this.body = body; },
  };
}

async function loopbackHarness(completeAuthorization) {
  let handleRequest;
  const server = fakeServer((callback) => callback());
  const authorization = createLoopbackAuthorization({
    oauthFlowService: {
      async beginAuthorization() {
        return { ok: true, flow_id: 'flow', authorization_url: 'https://auth.test/authorize' };
      },
      completeAuthorization,
    },
    openExternal: async () => {},
    createServer: (handler) => {
      handleRequest = handler;
      return server;
    },
  });
  assert.equal((await authorization.begin({})).ok, true);
  return { authorization, handleRequest, server };
}

test('dispose closes in-flight loopback begins before listeners, timers, or browser launch', async () => {
  let authorizationCalls = 0;
  let browserCalls = 0;
  let afterListen;
  const listenServer = fakeServer((callback) => { afterListen = callback; });
  const first = createLoopbackAuthorization({
    oauthFlowService: { async beginAuthorization() { authorizationCalls += 1; } },
    openExternal: async () => { browserCalls += 1; },
    createServer: () => listenServer,
  });
  const listening = first.begin({});
  first.dispose();
  afterListen();
  assert.equal((await listening).reason, 'oauth_loopback_unavailable');
  assert.equal(listenServer.closed, 1);
  assert.equal(authorizationCalls, 0);

  let second;
  const authorizationServer = fakeServer((callback) => callback());
  second = createLoopbackAuthorization({
    oauthFlowService: { async beginAuthorization() {
      second.dispose();
      return { ok: true, flow_id: 'flow', authorization_url: 'https://auth.test/authorize' };
    } },
    openExternal: async () => { browserCalls += 1; },
    createServer: () => authorizationServer,
  });
  assert.equal((await second.begin({})).reason, 'oauth_loopback_unavailable');
  assert.equal(authorizationServer.closed, 1);
  assert.equal(browserCalls, 0);
});

test('loopback listener ignores a wrong-state callback and accepts the legitimate callback', async () => {
  const calls = [];
  const harness = await loopbackHarness(async ({ callback_url: callbackUrl,
    on_consumed: onConsumed }) => {
    calls.push(callbackUrl);
    if (new URL(callbackUrl).searchParams.get('state') !== 'expected') {
      return { ok: false, reason: 'oauth_state_mismatch' };
    }
    onConsumed();
    return { ok: true };
  });
  const invalidResponse = fakeResponse();
  await harness.handleRequest({ method: 'GET', url: '/plugin-oauth/callback?state=wrong' },
    invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(harness.server.closed, 0);

  const validResponse = fakeResponse();
  await harness.handleRequest({ method: 'GET', url: '/plugin-oauth/callback?state=expected' },
    validResponse);
  assert.equal(validResponse.statusCode, 200);
  assert.equal(harness.server.closed, 1);
  assert.equal(calls.length, 2);
  harness.authorization.dispose();
});

test('loopback listener consumes duplicate valid callbacks exactly once', async () => {
  let resolveCompletion;
  let completionCalls = 0;
  const harness = await loopbackHarness(({ on_consumed: onConsumed }) => {
    completionCalls += 1;
    onConsumed();
    return new Promise((resolve) => { resolveCompletion = resolve; });
  });
  const firstResponse = fakeResponse();
  const secondResponse = fakeResponse();
  const first = harness.handleRequest({ method: 'GET', url: '/plugin-oauth/callback?state=expected' },
    firstResponse);
  await harness.handleRequest({ method: 'GET', url: '/plugin-oauth/callback?state=expected' },
    secondResponse);
  assert.equal(secondResponse.statusCode, 409);
  assert.equal(completionCalls, 1);
  resolveCompletion({ ok: true });
  await first;
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(harness.server.closed, 1);
  harness.authorization.dispose();
});

test('loopback listener lets a valid callback win a concurrent invalid request in either order', async () => {
  for (const invalidFirst of [true, false]) {
    let resolveInvalid;
    let resolveValid;
    let validCompletions = 0;
    const harness = await loopbackHarness(({ callback_url: callbackUrl,
      on_consumed: onConsumed }) => {
      if (new URL(callbackUrl).searchParams.get('state') !== 'expected') {
        return new Promise((resolve) => { resolveInvalid = resolve; });
      }
      validCompletions += 1;
      onConsumed();
      return new Promise((resolve) => { resolveValid = resolve; });
    });
    const invalidResponse = fakeResponse();
    const validResponse = fakeResponse();
    const invalidRequest = { method: 'GET', url: '/plugin-oauth/callback?state=wrong' };
    const validRequest = { method: 'GET', url: '/plugin-oauth/callback?state=expected' };
    if (invalidFirst) {
      const invalid = harness.handleRequest(invalidRequest, invalidResponse);
      const valid = harness.handleRequest(validRequest, validResponse);
      resolveValid({ ok: true });
      await valid;
      resolveInvalid({ ok: false, reason: 'oauth_state_mismatch' });
      await invalid;
      assert.equal(invalidResponse.statusCode, 400);
    } else {
      const valid = harness.handleRequest(validRequest, validResponse);
      await harness.handleRequest(invalidRequest, invalidResponse);
      assert.equal(invalidResponse.statusCode, 409);
      resolveValid({ ok: true });
      await valid;
    }
    assert.equal(validResponse.statusCode, 200);
    assert.equal(validCompletions, 1);
    assert.equal(harness.server.closed, 1);
    harness.authorization.dispose();
  }
});
