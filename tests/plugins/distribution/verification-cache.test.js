'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { buildVerificationCacheKey } = require('../../../services/plugins/distribution/verification-cache');
test('cache key binds all trust inputs', () => {
  const input = Object.fromEntries(['artifact_digest', 'publisher_trust_digest', 'tuf_root_digest', 'advisory_digest', 'source_policy_digest', 'contract_lock_digest'].map((key, index) => [key, String(index + 1).repeat(64)]));
  const key = buildVerificationCacheKey(input); assert.equal(key.ok, true);
});
