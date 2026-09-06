'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../package/canonical-metadata');
const { isValidDigest } = require('../store/content-store');

const FIELDS = ['artifact_digest', 'publisher_trust_digest', 'tuf_root_digest', 'advisory_digest', 'source_policy_digest', 'contract_lock_digest'];
function buildVerificationCacheKey(input) {
  if (!input || FIELDS.some((field) => !isValidDigest(input[field]))) return { ok: false, reason: 'verification_cache_input_invalid' };
  const material = Object.fromEntries(FIELDS.map((field) => [field, input[field]]));
  return { ok: true, key: crypto.createHash('sha256').update(stableStringify(material), 'utf8').digest('hex') };
}
module.exports = { buildVerificationCacheKey };
