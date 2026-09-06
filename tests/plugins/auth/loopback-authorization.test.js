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
