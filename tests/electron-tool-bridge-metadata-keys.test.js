'use strict';

// Bridge metadata keys are filtered per segment, not by substring (tool review,
// 2026-10-19): `files`, `file_count`, `locale`, `max_tokens` and `cache_key`
// survive; path-, token-, secret- and trust-bearing keys drop; the top level is
// capped like every nested object.

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeBridgeMetadata } = require('../services/backend/electron-tool-bridge');

test('descriptive keys that merely contain a sensitive substring survive', () => {
  const sanitized = sanitizeBridgeMetadata({
    files: ['a.md'], file_count: 2, fileName: 'a.md', locale: 'en-GB', max_tokens: 400,
    tokens_used: 12, cache_key: 'memo-1', keywords: ['x'], keyboard: 'us', pathological: true,
  });
  assert.deepEqual(Object.keys(sanitized).sort(), [
    'cache_key', 'fileName', 'file_count', 'files', 'keyboard', 'keywords', 'locale',
    'max_tokens', 'pathological', 'tokens_used',
  ]);
});

test('path, token, secret, credential and trust keys drop in every spelling', () => {
  const sanitized = sanitizeBridgeMetadata({
    file_path: 'C:/x', local_path: '/y', absolute_path: '/z', absolutePath: '/z', paths: ['/p'],
    access_token: 't', accessToken: 't', api_key: 'k', apiKey: 'k', key: 'k', private_key: 'k',
    session_key: 'k', secret: 's', client_secret: 's', password: 'p', passwd: 'p',
    credentials: 'c', local_trusted: true, trusted_local_path: true, 'auth-token': 't',
    kept: 1,
  });
  assert.deepEqual(Object.keys(sanitized), ['kept']);
});

test('the top level is capped at 100 entries', () => {
  const metadata = {};
  for (let index = 0; index < 150; index += 1) metadata[`k${index}`] = index;
  const sanitized = sanitizeBridgeMetadata(metadata);
  assert.equal(Object.keys(sanitized).length, 100);
  assert.equal(sanitized.k0, 0);
  assert.equal(Object.hasOwn(sanitized, 'k120'), false);
});

test('the bridge drops every prototype key the stored-metadata bounds drop, at any depth', () => {
  const { FORBIDDEN_STORAGE_KEYS } = require('../services/backend/tool-result-metadata-bounds');
  assert.ok(FORBIDDEN_STORAGE_KEYS instanceof Set && FORBIDDEN_STORAGE_KEYS.size >= 3);
  for (const key of FORBIDDEN_STORAGE_KEYS) {
    const sanitized = sanitizeBridgeMetadata(JSON.parse(`{"${key}": {"x": 1}, "nested": {"${key}": 1, "ok": 2}}`));
    assert.equal(Object.hasOwn(sanitized, key), false, key);
    assert.deepEqual(sanitized.nested, { ok: 2 }, key);
  }
});
