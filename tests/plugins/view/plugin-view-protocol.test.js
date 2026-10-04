'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  PLUGIN_VIEW_CSP,
  createPluginViewProtocolHandler,
} = require('../../../services/main/plugin-view-protocol');

const DIGEST = 'a'.repeat(64);

test('the protocol serves only digest-verified immutable assets with restrictive CSP', async () => {
  const bytes = Buffer.from('<!doctype html><title>safe</title>');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const handler = createPluginViewProtocolHandler({
    resolveAsset: async ({ artifactDigest, path }) => artifactDigest === DIGEST && path === 'view/index.html'
      ? { bytes, sha256, media_type: 'text/html' } : null,
  });
  const result = await handler({ url: `jenny-plugin-view://${DIGEST}/view/index.html` });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-security-policy'), PLUGIN_VIEW_CSP);
  assert.match(PLUGIN_VIEW_CSP, /connect-src 'none'/);
  assert.match(PLUGIN_VIEW_CSP, /worker-src 'none'/);
  assert.doesNotMatch(PLUGIN_VIEW_CSP, /unsafe-inline|unsafe-eval/);
  assert.equal(await result.text(), bytes.toString('utf8'));
});

test('path traversal, mutable URL suffixes, and digest mismatch fail closed', async () => {
  const bytes = Buffer.from('bad');
  const handler = createPluginViewProtocolHandler({
    resolveAsset: async () => ({ bytes, sha256: 'b'.repeat(64), media_type: 'text/html' }),
  });
  for (const url of [
    `jenny-plugin-view://${DIGEST}/../secret`,
    `jenny-plugin-view://${DIGEST}/view/index.html?mutable=1`,
    `https://${DIGEST}/view/index.html`,
  ]) assert.equal((await handler({ url })).status, 404);
  assert.equal((await handler({ url: `jenny-plugin-view://${DIGEST}/view/index.html` })).status, 409);
});

test('the retired attachment-ticket path is just an unknown asset path', async () => {
  const assetCalls = [];
  const handler = createPluginViewProtocolHandler({
    resolveAsset: async (request) => { assetCalls.push(request); return null; },
    resolveAttachment: async () => { throw new Error('must never be reached'); },
  });

  const response = await handler({ url: `jenny-plugin-view://${DIGEST}/__attachment/${'b'.repeat(64)}` });
  assert.equal(response.status, 404);
  assert.deepEqual(assetCalls, [{ artifactDigest: DIGEST, path: `__attachment/${'b'.repeat(64)}` }]);
});
