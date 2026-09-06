'use strict';

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatGptAuthService,
} = require('../services/backend/chatgpt-auth-service');

async function reserveUnusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition.');
}

function requestUrl(urlValue) {
  return new Promise((resolve, reject) => {
    const request = http.request(urlValue, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

test('authorization-code body reads settle with auth_timeout when json stalls', async () => {
  const port = await reserveUnusedPort();
  let openedUrl = '';
  let bodyReadStarted = false;
  const service = createChatGptAuthService({
    secureStore: {
      getModelProviderOAuth() { return ''; },
      setModelProviderOAuth() { assert.fail('Timed-out credentials must not persist.'); },
      deleteModelProviderOAuth() {},
    },
    listenPorts: [port],
    openExternal(url) {
      openedUrl = url;
    },
    async fetchImpl() {
      return {
        ok: true,
        status: 200,
        json() {
          bodyReadStarted = true;
          return new Promise(() => {});
        },
      };
    },
  });

  const startPromise = service.start({ timeoutMs: 250 });
  await waitFor(() => openedUrl);
  const authUrl = new URL(openedUrl);
  const callback = new URL(authUrl.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authUrl.searchParams.get('state'));
  callback.searchParams.set('code', 'authorization-code');
  assert.equal(await requestUrl(callback), 200);
  await waitFor(() => bodyReadStarted);

  let watchdog;
  const timedOut = Symbol('watchdog');
  const status = await Promise.race([
    startPromise,
    new Promise((resolve) => { watchdog = setTimeout(() => resolve(timedOut), 1500); }),
  ]);
  clearTimeout(watchdog);
  assert.notEqual(status, timedOut, 'start() must settle after the flow timeout');
  assert.equal(status.state, 'signed_out');
  assert.equal(status.error.code, 'auth_timeout');
});
