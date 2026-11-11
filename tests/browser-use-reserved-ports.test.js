'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReservedPortReader } = require('../services/browser-use/reserved-ports');

const FIXED = [11434, 8033, 8034, 8000, 8080, 9222];

test('the fixed engine and debug ports are always reserved', () => {
  const ports = createReservedPortReader({ getBaseUrls: () => [], getDebugPort: () => undefined })();
  assert.ok(ports instanceof Set);
  assert.deepEqual([...ports].sort((a, b) => a - b), [...FIXED].sort((a, b) => a - b));
});

test('the port of every parseable base URL is added', () => {
  const read = createReservedPortReader({
    getBaseUrls: () => ['http://127.0.0.1:9911/v1', 'https://api.example.com:8443/v1', 'http://localhost:1234'],
    getDebugPort: () => 0,
  });
  const ports = read();
  for (const port of [9911, 8443, 1234, ...FIXED]) assert.ok(ports.has(port), String(port));
});

test('a loopback base URL without a port reserves the scheme default, a remote one does not', () => {
  const ports = createReservedPortReader({
    getBaseUrls: () => ['http://localhost/v1', 'https://api.example.com/v1'],
    getDebugPort: () => null,
  })();
  assert.ok(ports.has(80));
  assert.equal(ports.has(443), false);
});

test('a valid debug port is reserved, an invalid one is ignored', () => {
  const valid = (value) => createReservedPortReader({ getBaseUrls: () => [], getDebugPort: () => value })();
  assert.ok(valid(9333).has(9333));
  assert.ok(valid('9444').has(9444));
  for (const bad of [0, -1, 70000, 12.5, 'abc', NaN, null, undefined, {}]) {
    assert.equal(valid(bad).size, FIXED.length, String(bad));
  }
});

test('bad input is ignored and never thrown', () => {
  const read = createReservedPortReader({
    getBaseUrls: () => ['not a url', 42, null, undefined, '', 'ftp://host:7000', 'http://host:99999'],
    getDebugPort: () => { throw new Error('boom'); },
  });
  const ports = read();
  assert.ok(ports.has(7000));
  assert.ok(!ports.has(99999));
  assert.equal(createReservedPortReader({ getBaseUrls: () => { throw new Error('boom'); } })().size, FIXED.length);
  assert.equal(createReservedPortReader({})().size, FIXED.length);
  assert.equal(createReservedPortReader()().size, FIXED.length);
});

test('base URLs are read on every call so a moved engine port is picked up', () => {
  let urls = ['http://127.0.0.1:5000'];
  const read = createReservedPortReader({ getBaseUrls: () => urls });
  assert.ok(read().has(5000));
  urls = ['http://127.0.0.1:5001'];
  const next = read();
  assert.ok(next.has(5001));
  assert.ok(!next.has(5000));
});
