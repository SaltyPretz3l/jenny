'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { validate } = require('../contracts/generated-plugin-contracts');

const CONTRACT_NAME = 'PluginPublisherTrustRootsV1';

function fail(reason, detail = null) {
  return { ok: false, code: PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED, reason, detail };
}

function keyIdentity(der) {
  const digest = crypto.createHash('sha256').update(der).digest();
  return {
    keyId: digest.toString('hex'),
    fingerprint: `SHA256:${digest.toString('base64')}`,
  };
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string') return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.toString('base64') === value ? decoded : null;
}

function validateTrustedPublisherRoots(document) {
  const structural = validate(CONTRACT_NAME, document);
  if (!structural.ok) {
    return fail('trust_roots_invalid', { path: structural.error.path, code: structural.error.code });
  }

  const publishers = new Map();
  for (const publisher of structural.value.publishers) {
    const keys = [];
    let current = null;
    for (const key of publisher.keys) {
      const der = decodeCanonicalBase64(key.public_key_spki_der_base64);
      if (!der) return fail('publisher_key_base64_invalid', { publisher_id: publisher.publisher_id });
      const identity = keyIdentity(der);
      if (identity.keyId !== key.key_id || identity.fingerprint !== key.fingerprint) {
        return fail('publisher_key_identity_mismatch', { publisher_id: publisher.publisher_id });
      }
      if (key.status === 'revoked' && !key.revoked_at) {
        return fail('revoked_key_missing_timestamp', { publisher_id: publisher.publisher_id });
      }
      if (key.status !== 'revoked' && key.revoked_at) {
        return fail('non_revoked_key_has_revocation_timestamp', { publisher_id: publisher.publisher_id });
      }
      let publicKey;
      try {
        publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
      } catch (_error) {
        return fail('publisher_key_der_invalid', { publisher_id: publisher.publisher_id });
      }
      if (publicKey.asymmetricKeyType !== 'ed25519') {
        return fail('publisher_key_type_invalid', { publisher_id: publisher.publisher_id });
      }
      const normalized = {
        key_id: key.key_id,
        algorithm: 'ed25519',
        status: key.status,
        public_key: publicKey,
        added_at: key.added_at,
        ...(key.revoked_at ? { revoked_at: key.revoked_at } : {}),
      };
      keys.push(normalized);
      if (key.key_id === publisher.current_key_id) current = normalized;
    }
    if (!current) return fail('publisher_current_key_missing', { publisher_id: publisher.publisher_id });
    if (current.status !== 'active') {
      return fail('publisher_current_key_not_active', { publisher_id: publisher.publisher_id });
    }
    publishers.set(publisher.publisher_id, {
      publisher_id: publisher.publisher_id,
      current_key_id: publisher.current_key_id,
      established_at: publisher.established_at,
      keys,
    });
  }
  return { ok: true, value: structural.value, publishers };
}

async function loadTrustedPublisherRoots({ filePath, readFile = fs.promises.readFile } = {}) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (_error) {
    return fail('trust_roots_unavailable');
  }
  let document;
  try {
    document = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (_error) {
    return fail('trust_roots_json_invalid');
  }
  return validateTrustedPublisherRoots(document);
}

function findTrustedPublisher(roots, publisherId) {
  if (!roots || roots.ok !== true || !(roots.publishers instanceof Map)) return null;
  return roots.publishers.get(publisherId) || null;
}

module.exports = {
  CONTRACT_NAME,
  keyIdentity,
  validateTrustedPublisherRoots,
  loadTrustedPublisherRoots,
  findTrustedPublisher,
};
