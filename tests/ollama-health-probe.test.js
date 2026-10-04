'use strict';

// ELC-01: the Ollama health probe must settle on every failure shape,
// including a 2xx response cut off mid-body and a response that never ends.
const http = require('http');
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { probeOllamaHealth, probeOllamaRefused } = require('../services/backend/ollama-health-probe');
const { OllamaProcessManager } = require('../services/backend/ollama-process-manager');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

// Resolves with the probe result, or the string 'unsettled' after waitMs.
async function settleWithin(promise, waitMs) {
  return Promise.race([promise, sleep(waitMs).then(() => 'unsettled')]);
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function truncatedBodyHandler(_request, response) {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
  response.write('{"models":[');
  setTimeout(() => response.socket.destroy(), 10);
}

// Fake http layer: the test drives the request/response events by hand.
function makeFakeHttp({ throwOnGet = false } = {}) {
  const state = { request: null, response: null, destroyed: 0 };
  const httpImpl = {
    get(_url, _options, onResponse) {
      if (throwOnGet) throw new Error('get exploded');
      const request = new EventEmitter();
      request.destroy = () => { state.destroyed += 1; };
      state.request = request;
      state.onResponse = onResponse;
      return request;
    },
  };
  state.respond = (statusCode = 200) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    response.setEncoding = () => {};
    response.resume = () => {};
    state.response = response;
    state.onResponse(response);
    return response;
  };
  return { httpImpl, state };
}

test('probe accepts a 2xx JSON body with a models array', async () => {
  await withServer((_req, res) => sendJson(res, { models: [{ name: 'm' }] }), async (port) => {
    assert.equal(await probeOllamaHealth({ host: '127.0.0.1', port, timeoutMs: 500 }), true);
  });
});

test('probe rejects non-2xx, bad JSON, missing models and an oversize body', async () => {
  const cases = [
    (_req, res) => sendJson(res, { models: [] }, 503),
    (_req, res) => sendJson(res, '{not json'),
    (_req, res) => sendJson(res, { models: 'nope' }),
    (_req, res) => sendJson(res, { models: [], pad: 'x'.repeat(1024 * 1024 + 10) }),
  ];
  for (const handler of cases) {
    await withServer(handler, async (port) => {
      const result = await settleWithin(
        probeOllamaHealth({ host: '127.0.0.1', port, timeoutMs: 500 }), 3000,
      );
      assert.equal(result, false);
    });
  }
});

test('probe settles false when a 2xx response is cut off mid-body', async () => {
  await withServer(truncatedBodyHandler, async (port) => {
    const result = await settleWithin(
      probeOllamaHealth({ host: '127.0.0.1', port, timeoutMs: 40 }), 250,
    );
    assert.equal(result, false);
  });
});

test('manager health probe settles false when a 2xx response is cut off mid-body', async () => {
  await withServer(truncatedBodyHandler, async (port) => {
    const manager = new OllamaProcessManager({
      port, healthTimeoutMs: 40, stateStore: null, detectTrayConflictImpl: () => null,
    });
    assert.equal(await settleWithin(manager._isRunning(), 250), false);
  });
});

test('probe total deadline settles a response that keeps the socket busy but never ends', async () => {
  const timers = new Set();
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"models":[');
    const drip = setInterval(() => res.write(' '), 5);
    timers.add(drip);
    res.on('close', () => clearInterval(drip));
  }, async (port) => {
    const started = Date.now();
    const result = await settleWithin(
      probeOllamaHealth({ host: '127.0.0.1', port, timeoutMs: 200 }), 4000,
    );
    const elapsed = Date.now() - started;
    // The idle timeout (200ms) never fires on a 5ms drip; the 800ms deadline does.
    assert.equal(result, false);
    assert.ok(elapsed >= 700, `deadline fired too early: ${elapsed}ms`);
    assert.ok(elapsed < 3000, `deadline fired too late: ${elapsed}ms`);
  });
  for (const timer of timers) clearInterval(timer);
});

test('probe settles false on response aborted, error and premature close', async () => {
  for (const event of ['aborted', 'error', 'close']) {
    const { httpImpl, state } = makeFakeHttp();
    const promise = probeOllamaHealth({ host: 'h', port: 1, timeoutMs: 1000, httpImpl });
    const response = state.respond(200);
    response.emit('data', '{"models":[');
    response.emit(event, event === 'error' ? new Error('reset') : undefined);
    assert.equal(await settleWithin(promise, 200), false, `event ${event}`);
  }
});

test('probe settles false on request error and request timeout', async () => {
  for (const event of ['error', 'timeout']) {
    const { httpImpl, state } = makeFakeHttp();
    const promise = probeOllamaHealth({ host: 'h', port: 1, timeoutMs: 1000, httpImpl });
    state.request.emit(event, new Error('boom'));
    assert.equal(await settleWithin(promise, 200), false, `event ${event}`);
  }
});

test('probe settles false when the http layer throws synchronously', async () => {
  const { httpImpl } = makeFakeHttp({ throwOnGet: true });
  assert.equal(await probeOllamaHealth({ host: 'h', port: 1, timeoutMs: 1000, httpImpl }), false);
});

test('probe deadline destroys the request and is cleared once the probe settled', async () => {
  const hung = makeFakeHttp();
  const hungPromise = probeOllamaHealth({ host: 'h', port: 1, timeoutMs: 20, httpImpl: hung.httpImpl });
  hung.state.respond(200);
  assert.equal(await settleWithin(hungPromise, 1000), false);
  assert.equal(hung.state.destroyed, 1, 'the deadline must destroy the request');

  const healthy = makeFakeHttp();
  const healthyPromise = probeOllamaHealth({
    host: 'h', port: 1, timeoutMs: 20, httpImpl: healthy.httpImpl,
  });
  const response = healthy.state.respond(200);
  response.emit('data', '{"models":[]}');
  response.emit('end');
  assert.equal(await healthyPromise, true);
  await sleep(150);
  assert.equal(healthy.state.destroyed, 0, 'a settled probe must not fire its deadline');
});

// The engine switch skips a failed unload only for a daemon that is positively
// gone. A hung or erroring daemon may still hold its model on the GPU.
test('probeOllamaRefused is true only when nothing listens on the port', async () => {
  const closedPort = await withServer(() => {}, async (port) => port);
  assert.equal(await probeOllamaRefused({ host: '127.0.0.1', port: closedPort, timeoutMs: 200 }), true);
  const manager = new OllamaProcessManager({
    port: closedPort, healthTimeoutMs: 200, stateStore: null, detectTrayConflictImpl: () => null,
  });
  assert.equal(await manager.isConfirmedDown(), true);
});

test('probeOllamaRefused is false for a daemon that answers, errors, hangs, or resets', async () => {
  await withServer((_req, res) => sendJson(res, { models: [] }), async (port) => {
    assert.equal(await probeOllamaRefused({ host: '127.0.0.1', port, timeoutMs: 200 }), false);
  });
  await withServer((_req, res) => sendJson(res, 'boom', 500), async (port) => {
    assert.equal(await probeOllamaRefused({ host: '127.0.0.1', port, timeoutMs: 200 }), false);
  });
  await withServer(() => { /* accepts, never answers */ }, async (port) => {
    const result = await settleWithin(
      probeOllamaRefused({ host: '127.0.0.1', port, timeoutMs: 40 }), 1000,
    );
    assert.equal(result, false);
  });
  await withServer((request) => request.socket.destroy(), async (port) => {
    assert.equal(await probeOllamaRefused({ host: '127.0.0.1', port, timeoutMs: 200 }), false);
  });
});
