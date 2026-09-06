'use strict';

const crypto = require('node:crypto');
const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeDestination } = require('../network/destination-policy');
const {
  discoverAuthorizationServer,
  chooseClientRegistration,
  MAX_METADATA_BYTES,
} = require('./oauth-metadata');

const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_FLOWS = 4;
const MAX_STEP_UP_ATTEMPTS = 2;
const MAX_SCOPES = 32;
const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

function failure(reason, retryable = false) {
  return { ok: false, code: PLUGIN_ERROR_CODES.REMOTE_AUTH_FAILED, reason, retryable };
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function createPkce(randomBytes = crypto.randomBytes) {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

function normalizedScopes(scopes) {
  if (!Array.isArray(scopes)) return null;
  const values = [...new Set(scopes)].sort();
  return values.length <= MAX_SCOPES
    && values.every((scope) => /^[A-Za-z0-9._:/-]{1,128}$/.test(scope)) ? values : null;
}

function buildAuthority(binding, discovered) {
  return {
    publisher_id: binding.publisher_id,
    plugin_id: binding.plugin_id,
    contribution_id: binding.contribution_id,
    descriptor_digest: binding.descriptor_digest,
    resource_digest: discovered.resource_digest,
    issuer_digest: discovered.issuer_digest,
    auth_profile_ref: binding.auth_profile_ref,
  };
}

function parseJsonResponse(result, reason) {
  if (!result?.ok || result.status_code < 200 || result.status_code >= 300
    || !Buffer.isBuffer(result.body) || result.body.length > TOKEN_RESPONSE_MAX_BYTES) {
    return failure(reason, result?.retryable === true);
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.body));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ok: true, value } : failure(reason);
  } catch (_error) { return failure(reason); }
}

class OAuthFlowService {
  constructor({ networkBroker, credentialBroker, now = () => new Date(),
    randomBytes = crypto.randomBytes } = {}) {
    this._networkBroker = networkBroker;
    this._credentialBroker = credentialBroker;
    this._now = now;
    this._randomBytes = randomBytes;
    this._flows = new Map();
    this._stepUps = new Map();
    this._disposed = false;
  }

  _nowMs() { return this._now().getTime(); }

  _prune() {
    const now = this._nowMs();
    for (const [id, flow] of this._flows) if (flow.expires_at_ms <= now) this._flows.delete(id);
  }

  async _dynamicRegistration(registration, redirectUri, context) {
    const body = JSON.stringify({
      client_name: 'Jenny', redirect_uris: [redirectUri], grant_types: ['authorization_code'],
      response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native',
    });
    const result = await this._networkBroker.request({
      purpose: 'oauth_registration', request_id: context.request_id,
      operation_id: context.operation_id, url: registration.registration_endpoint,
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body, consent: context.consent, redaction_policy: 'strict',
      deadline_epoch_ms: context.deadline_epoch_ms,
      limits: { max_response_bytes: MAX_METADATA_BYTES }, signal: context.signal || null,
      same_origin_redirects_only: true,
    });
    if (this._disposed) return failure('oauth_flow_cancelled');
    const parsed = parseJsonResponse(result, 'dynamic_registration_failed');
    if (!parsed.ok || typeof parsed.value.client_id !== 'string' || !parsed.value.client_id) {
      return failure('dynamic_registration_failed');
    }
    if (Buffer.byteLength(parsed.value.client_id, 'utf8') > 2048
      || (parsed.value.client_secret !== undefined
        && (typeof parsed.value.client_secret !== 'string'
          || Buffer.byteLength(parsed.value.client_secret, 'utf8') > 16384))) {
      return failure('dynamic_registration_failed');
    }
    return {
      ok: true, kind: 'dynamic_registration', client_id: parsed.value.client_id,
      client_secret: typeof parsed.value.client_secret === 'string' ? parsed.value.client_secret : null,
    };
  }

  async beginAuthorization(input) {
    if (this._disposed) return failure('oauth_flow_cancelled');
    this._prune();
    if (this._flows.size >= MAX_FLOWS) return failure('oauth_flow_capacity_exceeded');
    const redirect = normalizeDestination(input.redirect_uri, { allowLoopbackHttp: true });
    if (!redirect.ok || !['https:', 'http:'].includes(redirect.url.protocol)
      || (redirect.url.protocol === 'http:' && redirect.literal_scope !== 'loopback')) {
      return failure('oauth_redirect_uri_invalid');
    }
    const discovered = await discoverAuthorizationServer({
      broker: this._networkBroker, resourceUrl: input.resource_url,
      challengeHeader: input.challenge_header || null, context: input.context,
    });
    if (this._disposed) return failure('oauth_flow_cancelled');
    if (!discovered.ok) return failure(discovered.reason, discovered.retryable === true);
    const resourceKey = discovered.resource_digest;
    if ([...this._flows.values()].some((flow) => flow.resource_key === resourceKey)) {
      return failure('oauth_resource_flow_in_progress');
    }
    let registration = chooseClientRegistration(discovered.metadata, input.registration || {});
    if (!registration.ok) return failure(registration.reason);
    if (registration.kind === 'dynamic_registration') {
      registration = await this._dynamicRegistration(registration, redirect.url.href, input.context);
      if (this._disposed) return failure('oauth_flow_cancelled');
      if (!registration.ok) return registration;
    }
    const priorScopes = normalizedScopes(input.previous_scopes || []);
    if (!priorScopes) return failure('oauth_scope_invalid');
    const challengeScopes = discovered.challenged_scopes.length
      ? discovered.challenged_scopes : discovered.supported_scopes;
    const scopes = normalizedScopes([...priorScopes, ...challengeScopes]);
    if (!scopes) return failure('oauth_scope_invalid');
    const isStepUp = priorScopes.length > 0 && scopes.some((scope) => !priorScopes.includes(scope));
    const stepUpAttempts = this._stepUps.get(resourceKey) || 0;
    if (isStepUp && stepUpAttempts >= MAX_STEP_UP_ATTEMPTS) {
      return failure('oauth_step_up_limit_exceeded');
    }
    const pkce = createPkce(this._randomBytes);
    const state = base64url(this._randomBytes(32));
    const flowId = `oauth-${base64url(this._randomBytes(18))}`;
    const authority = buildAuthority(input.binding, discovered);
    const authorizationUrl = new URL(discovered.metadata.authorization_endpoint);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', registration.client_id);
    authorizationUrl.searchParams.set('redirect_uri', redirect.url.href);
    authorizationUrl.searchParams.set('code_challenge', pkce.challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('resource', discovered.resource);
    if (scopes.length) authorizationUrl.searchParams.set('scope', scopes.join(' '));
    const expiresAtMs = this._nowMs() + FLOW_TTL_MS;
    const flow = {
      flow_id: flowId, resource_key: resourceKey, authority, state,
      verifier: pkce.verifier, issuer: discovered.issuer,
      metadata: discovered.metadata, resource: discovered.resource,
      redirect_uri: redirect.url.href, registration, scopes, step_up_attempts: stepUpAttempts,
      expires_at_ms: expiresAtMs, context: input.context,
    };
    this._flows.set(flowId, flow);
    if (isStepUp) this._stepUps.set(resourceKey, stepUpAttempts + 1);
    const written = await this._credentialBroker.writeState(authority, {
      state: 'authorizing', grantedScopes: priorScopes, credentialPresent: false,
      expiresAt: new Date(expiresAtMs).toISOString(), updatedAt: this._now().toISOString(),
    });
    if (this._disposed) return failure('oauth_flow_cancelled');
    if (!written.ok) {
      this._flows.delete(flowId);
      if (isStepUp) this._stepUps.set(resourceKey, stepUpAttempts);
      return failure(written.reason);
    }
    return { ok: true, flow_id: flowId, authorization_url: authorizationUrl.href,
      expires_at: new Date(expiresAtMs).toISOString(), authority };
  }

  async completeAuthorization({ flow_id: flowId, callback_url: callbackUrl }) {
    this._prune();
    const flow = this._flows.get(flowId);
    if (!flow) return failure('oauth_flow_not_found');
    this._flows.delete(flowId);
    let callback;
    try { callback = new URL(callbackUrl); } catch (_error) { return failure('oauth_callback_invalid'); }
    const expected = new URL(flow.redirect_uri);
    const singular = ['state', 'code', 'iss', 'error'];
    if (callback.hash || singular.some((key) => callback.searchParams.getAll(key).length > 1)) {
      return failure('oauth_callback_invalid');
    }
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
      || callback.searchParams.get('state') !== flow.state) return failure('oauth_state_mismatch');
    if (callback.searchParams.has('error')) return failure('oauth_authorization_denied');
    const code = callback.searchParams.get('code');
    if (!code || Buffer.byteLength(code, 'utf8') > 4096) return failure('oauth_code_invalid');
    const responseIssuer = callback.searchParams.get('iss');
    const issuerRequired = flow.metadata.authorization_response_iss_parameter_supported === true;
    if ((issuerRequired && !responseIssuer) || (responseIssuer && responseIssuer !== flow.issuer)) {
      return failure('oauth_issuer_mismatch');
    }
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: flow.redirect_uri,
      client_id: flow.registration.client_id, code_verifier: flow.verifier,
      resource: flow.resource,
    });
    if (flow.registration.client_secret) form.set('client_secret', flow.registration.client_secret);
    const result = await this._networkBroker.request({
      purpose: 'oauth_token', request_id: flow.context.request_id,
      operation_id: flow.context.operation_id, url: flow.metadata.token_endpoint,
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json' }, body: form.toString(), consent: flow.context.consent,
      redaction_policy: 'strict', deadline_epoch_ms: flow.context.deadline_epoch_ms,
      limits: { max_response_bytes: TOKEN_RESPONSE_MAX_BYTES },
      signal: flow.context.signal || null, same_origin_redirects_only: true,
    });
    if (this._disposed) return failure('oauth_flow_cancelled');
    const parsed = parseJsonResponse(result, 'oauth_token_exchange_failed');
    if (!parsed.ok) return parsed;
    const token = parsed.value;
    const grantedScopes = normalizedScopes(String(token.scope || flow.scopes.join(' ')).split(/\s+/).filter(Boolean));
    if (!grantedScopes || grantedScopes.some((scope) => !flow.scopes.includes(scope))
      || token.token_type !== 'Bearer' || typeof token.access_token !== 'string'
      || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0) {
      return failure('oauth_token_response_invalid');
    }
    const stored = await this._credentialBroker.store(flow.authority, {
      access_token: token.access_token,
      refresh_token: typeof token.refresh_token === 'string' ? token.refresh_token : null,
      granted_scopes: grantedScopes,
      expires_at: new Date(this._nowMs() + Math.min(token.expires_in, 86400) * 1000).toISOString(),
    });
    return this._disposed ? failure('oauth_flow_cancelled') : stored;
  }

  dispose() {
    this._disposed = true;
    this._flows.clear();
    this._stepUps.clear();
  }
}

module.exports = {
  FLOW_TTL_MS,
  MAX_FLOWS,
  MAX_STEP_UP_ATTEMPTS,
  OAuthFlowService,
};
