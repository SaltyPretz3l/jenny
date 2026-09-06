'use strict';

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { validate } = require('../contracts/generated-plugin-contracts');
const {
  readRemoteMcpAuthorization,
  writeRemoteMcpAuthorization,
} = require('../store/remote-mcp-authorization-store');

const CONTRACT_NAME = 'PluginRemoteMcpAuthorizationV1';
const DIGEST_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const PUBLISHER_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_TOKEN_BYTES = 16 * 1024;

function fail(reason, retryable = false) {
  return { ok: false, code: PLUGIN_ERROR_CODES.REMOTE_AUTH_FAILED, reason, retryable };
}

function validateAuthority(authority) {
  if (!authority || !PUBLISHER_RE.test(authority.publisher_id || '')
    || !ID_RE.test(authority.plugin_id || '') || !ID_RE.test(authority.contribution_id || '')
    || !DIGEST_RE.test(authority.descriptor_digest || '')
    || !DIGEST_RE.test(authority.resource_digest || '')
    || !DIGEST_RE.test(authority.issuer_digest || '')
    || !DIGEST_RE.test(authority.auth_profile_ref || '')) return fail('credential_authority_invalid');
  return { ok: true };
}

function secureBinding(authority) {
  return {
    publisher_id: authority.publisher_id,
    plugin_id: authority.plugin_id,
    descriptor_digest: authority.descriptor_digest,
    resource_digest: authority.resource_digest,
    issuer_digest: authority.issuer_digest,
  };
}

function buildAuthorization(authority, fields) {
  return {
    authorization_schema_version: 1,
    publisher_id: authority.publisher_id,
    plugin_id: authority.plugin_id,
    contribution_id: authority.contribution_id,
    resource_digest: authority.resource_digest,
    issuer_digest: authority.issuer_digest,
    auth_profile_ref: authority.auth_profile_ref,
    state: fields.state,
    granted_scopes: [...(fields.grantedScopes || [])].sort(),
    credential_present: fields.credentialPresent === true,
    expires_at: fields.expiresAt,
    updated_at: fields.updatedAt,
  };
}

function validateCredentialEnvelope(envelope, authority) {
  return Boolean(envelope && envelope.credential_schema_version === 1
    && envelope.descriptor_digest === authority.descriptor_digest
    && envelope.resource_digest === authority.resource_digest
    && envelope.issuer_digest === authority.issuer_digest
    && envelope.auth_profile_ref === authority.auth_profile_ref
    && envelope.token_type === 'Bearer'
    && typeof envelope.access_token === 'string' && envelope.access_token
    && Buffer.byteLength(envelope.access_token, 'utf8') <= MAX_TOKEN_BYTES
    && (envelope.refresh_token === null || (typeof envelope.refresh_token === 'string'
      && Buffer.byteLength(envelope.refresh_token, 'utf8') <= MAX_TOKEN_BYTES))
    && Array.isArray(envelope.granted_scopes)
    && Number.isFinite(Date.parse(envelope.expires_at)));
}

class CredentialBroker {
  constructor({ secureStore, facade, baseDir = '', now = () => new Date() } = {}) {
    this._secureStore = secureStore;
    this._facade = facade;
    this._baseDir = baseDir;
    this._now = now;
  }

  _nowIso() { return this._now().toISOString(); }

  async writeState(authority, fields) {
    const valid = validateAuthority(authority);
    if (!valid.ok) return valid;
    const value = buildAuthorization(authority, fields);
    const checked = validate(CONTRACT_NAME, value);
    if (!checked.ok) return fail('authorization_state_invalid');
    return writeRemoteMcpAuthorization(this._facade, this._baseDir, checked.value);
  }

  async store(authority, credential) {
    const valid = validateAuthority(authority);
    if (!valid.ok) return valid;
    const envelope = {
      credential_schema_version: 1,
      descriptor_digest: authority.descriptor_digest,
      resource_digest: authority.resource_digest,
      issuer_digest: authority.issuer_digest,
      auth_profile_ref: authority.auth_profile_ref,
      token_type: 'Bearer', access_token: credential.access_token,
      refresh_token: credential.refresh_token || null,
      granted_scopes: [...(credential.granted_scopes || [])].sort(),
      expires_at: credential.expires_at,
    };
    if (!validateCredentialEnvelope(envelope, authority)) return fail('credential_payload_invalid');
    try {
      await this._secureStore.setPluginRemoteMcpCredential(
        secureBinding(authority),
        JSON.stringify(envelope)
      );
    } catch (_error) { return fail('secure_storage_unavailable'); }
    const state = await this.writeState(authority, {
      state: 'authorized', grantedScopes: envelope.granted_scopes,
      credentialPresent: true, expiresAt: envelope.expires_at, updatedAt: this._nowIso(),
    });
    if (!state.ok) {
      await this._secureStore.deletePluginRemoteMcpCredential(secureBinding(authority)).catch(() => {});
      return fail(state.reason || 'authorization_state_write_failed');
    }
    return { ok: true, authorization: state.authorization };
  }

  async get(authority, { revoked = false } = {}) {
    const valid = validateAuthority(authority);
    if (!valid.ok) return valid;
    if (revoked) return fail('credential_authority_revoked');
    const state = await readRemoteMcpAuthorization(
      this._facade,
      this._baseDir,
      authority.auth_profile_ref
    );
    if (!state.ok || state.authorization.state !== 'authorized'
      || state.authorization.publisher_id !== authority.publisher_id
      || state.authorization.plugin_id !== authority.plugin_id
      || state.authorization.contribution_id !== authority.contribution_id
      || state.authorization.resource_digest !== authority.resource_digest
      || state.authorization.issuer_digest !== authority.issuer_digest
      || state.authorization.auth_profile_ref !== authority.auth_profile_ref) {
      return { ok: false, code: PLUGIN_ERROR_CODES.REMOTE_AUTH_REQUIRED,
        reason: 'remote_authorization_required', retryable: false };
    }
    let raw;
    try { raw = await this._secureStore.getPluginRemoteMcpCredential(secureBinding(authority)); }
    catch (_error) { return fail('secure_storage_unavailable'); }
    if (!raw) {
      return { ok: false, code: PLUGIN_ERROR_CODES.REMOTE_AUTH_REQUIRED,
        reason: 'remote_authorization_required', retryable: false };
    }
    let envelope;
    try { envelope = JSON.parse(raw); } catch (_error) { return fail('credential_payload_invalid'); }
    if (!validateCredentialEnvelope(envelope, authority)) return fail('credential_authority_mismatch');
    if (Date.parse(envelope.expires_at) <= this._now().getTime()) return fail('credential_expired', true);
    return { ok: true, credential: envelope };
  }

  async revoke(authority) {
    const valid = validateAuthority(authority);
    if (!valid.ok) return valid;
    try { await this._secureStore.deletePluginRemoteMcpCredential(secureBinding(authority)); }
    catch (_error) { return fail('secure_storage_unavailable'); }
    return this.writeState(authority, {
      state: 'revoked', grantedScopes: [], credentialPresent: false,
      expiresAt: this._nowIso(), updatedAt: this._nowIso(),
    });
  }
}

module.exports = {
  CredentialBroker,
};
