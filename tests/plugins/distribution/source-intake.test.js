'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { normalizeReusableUrl, normalizeOfflineRoot, sourceTrustMatches } = require('../../../services/plugins/distribution/source-intake');
test('reusable locators reject credentials, queries, and fragments', () => {
  assert.equal(normalizeReusableUrl('https://u:p@example.test/a').reason, 'source_userinfo_rejected');
  assert.equal(normalizeReusableUrl('https://example.test/a?q=1').reason, 'source_query_rejected');
  assert.equal(normalizeReusableUrl('https://example.test/a#x').reason, 'source_fragment_rejected');
  assert.equal(normalizeReusableUrl('http://localhost/a', { allowLoopbackHttp: true }).reason, 'source_https_required');
  assert.equal(normalizeReusableUrl('http://127.0.0.1/a', { allowLoopbackHttp: true }).ok, true);
  assert.equal(normalizeReusableUrl('https://EXAMPLE.test:443/a').locator, 'https://example.test/a');
});
test('offline roots persist only the resolved real root', async () => {
  const result = await normalizeOfflineRoot('C:\\mirror', { realpath: async () => 'C:\\real-mirror' });
  assert.equal(result.ok, true); assert.match(result.root_digest, /^[0-9a-f]{64}$/);
});
test('source trust binds every acquired identity to its authorized locator', () => {
  const d = (value) => value.repeat(64);
  assert.equal(sourceTrustMatches({ kind: 'https_url', url_digest: d('a') }, { kind: 'https_url', url_digest: d('a') }), true);
  assert.equal(sourceTrustMatches({ kind: 'https_url', url_digest: d('a') }, { kind: 'https_url', url_digest: d('b') }), false);
  assert.equal(sourceTrustMatches({ kind: 'git', repository_url_digest: d('a'), pinned_commit: '1'.repeat(40) },
    { kind: 'git', repository_url_digest: d('a'), pinned_commit: '2'.repeat(40) }), false);
  assert.equal(sourceTrustMatches({ kind: 'signed_catalog', catalog_id: 'stable', tuf_root_digest: d('c'), target_path_digest: d('d') },
    { kind: 'signed_catalog', catalog_id: 'stable', tuf_root_digest: d('c'), sbom_attested: true }), true);
});
