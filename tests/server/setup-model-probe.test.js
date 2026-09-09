'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { probeModels, probePrivateHttps, probeLocalHost } = require('../../services/host/setup-model-probe');

async function server(t, handler) {
  const host = http.createServer(handler);
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  t.after(() => { host.closeAllConnections(); return new Promise((resolve) => host.close(resolve)); });
  return 'http://127.0.0.1:' + host.address().port;
}

test('real container-style endpoint probing lists models without generation and filters control output', async (t) => {
  const requests = [];
  const apiUrl = await server(t, (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    requests.push([request.method, request.url]);
    response.end(JSON.stringify({ models: [{ name: 'model-a' }, { name: 'bad\u001b[31m' }, { name: 'model-a' }] }));
  });
  assert.deepEqual(await probeModels({ engine: 'ollama', apiUrl }, { apiKey: 'stale-openai-key' }), { ok: true, models: ['model-a'] });
  assert.deepEqual(requests, [['GET', '/api/tags']]);
});

test('OpenAI metadata keys never follow redirects or escape into errors', async (t) => {
  let secondReached = false;
  const redirectUrl = await server(t, (_request, response) => { secondReached = true; response.end('{}'); });
  const apiUrl = await server(t, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer private-test-key');
    response.writeHead(302, { Location: redirectUrl });
    response.end();
  });
  const result = await probeModels({ engine: 'openai-compatible', apiUrl }, { apiKey: 'private-test-key' });
  assert.equal(result.ok, false);
  assert.equal(secondReached, false);
  assert.doesNotMatch(JSON.stringify(result), /private-test-key|127\.0\.0\.1/);
});

test('metadata response consumption is bounded by bytes and deadline', async (t) => {
  const oversized = await server(t, (_request, response) => response.end('x'.repeat(1024 * 1024 + 1)));
  assert.equal((await probeModels({ engine: 'ollama', apiUrl: oversized })).ok, false);
  const stalled = await server(t, (_request, response) => { response.writeHead(200); response.write('{'); });
  const result = await probeModels({ engine: 'ollama', apiUrl: stalled }, { timeoutMs: 30 });
  assert.deepEqual(result, { ok: false, reason: 'endpoint_timeout' });
});

test('doctor differentiates authentication, invalid shapes, no models, and a health response', async (t) => {
  const apiUrl = await server(t, (request, response) => {
    if (request.url === '/healthz') return response.end('{"alive":true}');
    response.writeHead(401);
    response.end('do not show this body');
  });
  assert.deepEqual(await probeModels({ engine: 'ollama', apiUrl }), { ok: false, reason: 'endpoint_auth_required' });
  assert.equal(await probePrivateHttps(apiUrl), true);
  const fetchImpl = async () => new Response('{"data":[]}');
  assert.deepEqual(await probeModels({ engine: 'openai-compatible', apiUrl }, { fetchImpl }),
    { ok: false, reason: 'endpoint_no_models' });
  assert.equal((await probeModels({ engine: 'ollama', apiUrl }, { fetchImpl })).reason, 'endpoint_invalid_response');
});

test('localhost health probe uses the fixed service name and exact configured browser origin', async () => {
  const calls = [];
  const requestImpl = (options, callback) => {
    calls.push(options);
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      response.emit('data', Buffer.from('{"alive":true}'));
      response.emit('end');
    };
    return request;
  };
  const config = { port: 8080, canonicalOrigin: 'http://127.0.0.1:8080' };
  assert.equal(await probeLocalHost(config, { requestImpl }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, 'jenny');
  assert.equal(calls[0].port, 8080);
  assert.equal(calls[0].path, '/healthz');
  assert.equal(calls[0].headers.Host, '127.0.0.1:8080');
  assert.equal(calls[0].headers.Origin, 'http://127.0.0.1:8080');
});
