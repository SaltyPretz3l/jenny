'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { parseArgs, probe } = require('../../server/healthcheck');

test('healthcheck CLI accepts only an absolute config and optional readiness probe', () => {
  assert.deepEqual(parseArgs(['--config', '/etc/jenny/host.json']), {
    configPath: '/etc/jenny/host.json', route: '/healthz',
  });
  assert.deepEqual(parseArgs(['--config', '/etc/jenny/host.json', '--ready']), {
    configPath: '/etc/jenny/host.json', route: '/readyz',
  });
  assert.throws(() => parseArgs(['--config', 'host.json']), /invalid_arguments/);
  assert.throws(() => parseArgs(['--config', '/etc/jenny/host.json', '--unknown']), /invalid_arguments/);
});

test('healthcheck probes loopback with the configured canonical host identity', async () => {
  let options;
  const requestImpl = (value, callback) => {
    options = value;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit('end');
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  await probe({ listenHost: '0.0.0.0', port: 8080,
    canonicalOrigin: 'https://jenny.tailnet.ts.net' }, '/readyz', { requestImpl });
  assert.deepEqual(options, {
    hostname: '127.0.0.1', port: 8080, path: '/readyz', method: 'GET',
    headers: { Host: 'jenny.tailnet.ts.net', Origin: 'https://jenny.tailnet.ts.net' },
  });
});

test('healthcheck rejects a non-200 server response', async () => {
  const requestImpl = (_options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 503;
      response.resume = () => {};
      callback(response);
      response.emit('end');
    };
    return request;
  };
  await assert.rejects(probe({ listenHost: '127.0.0.1', port: 8080,
    canonicalOrigin: 'https://jenny.test' }, '/readyz', { requestImpl }), /host_unhealthy/);
});
