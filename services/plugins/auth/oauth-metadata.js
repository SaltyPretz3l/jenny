'use strict';

const { digestText, normalizeDestination } = require('../network/destination-policy');

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_SERVERS = 4;
const MAX_SCOPES = 32;

function parseBearerChallenge(header) {
  if (typeof header !== 'string' || Buffer.byteLength(header, 'utf8') > 8192) {
    return { ok: false, reason: 'oauth_challenge_invalid' };
  }
  if (!/^\s*Bearer(?:\s|$)/i.test(header)) return { ok: false, reason: 'oauth_challenge_invalid' };
  const source = header.replace(/^\s*Bearer(?:\s+|$)/i, '');
  const params = {};
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([^,\s]+))/g;
  let found;
  while ((found = pattern.exec(source))) {
    const key = found[1].toLowerCase();
    const value = found[2] === undefined ? found[3] : found[2].replace(/\\(["\\])/g, '$1');
    if (Object.hasOwn(params, key)) return { ok: false, reason: 'oauth_challenge_invalid' };
    params[key] = value;
  }
  if (source.replace(pattern, '').replace(/[,\s]/g, '')) {
    return { ok: false, reason: 'oauth_challenge_invalid' };
  }
  const scopes = String(params.scope || '').split(/\s+/).filter(Boolean);
  if (scopes.length > MAX_SCOPES || scopes.some((scope) => !/^[A-Za-z0-9._:/-]{1,128}$/.test(scope))) {
    return { ok: false, reason: 'oauth_scope_invalid' };
  }
  return { ok: true, resource_metadata: params.resource_metadata || null, scopes };
}

function protectedResourceMetadataUrls(resourceUrl, challengeUrl = null) {
  let resource;
  try { resource = new URL(resourceUrl); } catch (_error) {
    return { ok: false, reason: 'oauth_resource_invalid' };
  }
  const loopback = ['127.0.0.1', '[::1]', '::1'].includes(resource.hostname.toLowerCase());
  if (resource.protocol !== 'https:' && !(resource.protocol === 'http:' && loopback)) {
    return { ok: false, reason: 'oauth_resource_invalid' };
  }
  const urls = [];
  if (challengeUrl) {
    try { urls.push(new URL(challengeUrl, resource).href); } catch (_error) {
      return { ok: false, reason: 'oauth_resource_metadata_url_invalid' };
    }
  }
  const path = resource.pathname === '/' ? '' : resource.pathname;
  urls.push(`${resource.origin}/.well-known/oauth-protected-resource${path}`);
  urls.push(`${resource.origin}/.well-known/oauth-protected-resource`);
  return { ok: true, resource: resource.href, urls: [...new Set(urls)] };
}

function authorizationMetadataUrls(issuer) {
  let url;
  try { url = new URL(issuer); } catch (_error) { return { ok: false, reason: 'oauth_issuer_invalid' }; }
  if (url.protocol !== 'https:' || url.search || url.hash) return { ok: false, reason: 'oauth_issuer_invalid' };
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  const urls = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
  ];
  if (path) urls.push(`${url.origin}${path}/.well-known/openid-configuration`);
  return { ok: true, issuer: url.href.replace(/\/$/, ''), urls };
}

function parseJsonBody(result, reason) {
  if (!result?.ok || result.status_code !== 200 || !Buffer.isBuffer(result.body)
    || result.body.length > MAX_METADATA_BYTES) return { ok: false, reason };
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.body));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ok: true, value } : { ok: false, reason };
  } catch (_error) { return { ok: false, reason }; }
}

function validateProtectedResourceMetadata(value, resourceUrl) {
  if (value.resource !== resourceUrl || !Array.isArray(value.authorization_servers)
    || value.authorization_servers.length < 1
    || value.authorization_servers.length > MAX_AUTHORIZATION_SERVERS) {
    return { ok: false, reason: 'protected_resource_metadata_invalid' };
  }
  const issuers = [];
  for (const issuer of value.authorization_servers) {
    const checked = authorizationMetadataUrls(issuer);
    if (!checked.ok) return { ok: false, reason: 'protected_resource_metadata_invalid' };
    issuers.push(checked.issuer);
  }
  const scopes = Array.isArray(value.scopes_supported) ? value.scopes_supported : [];
  if (scopes.length > MAX_SCOPES
    || scopes.some((scope) => typeof scope !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(scope))) {
    return { ok: false, reason: 'protected_resource_metadata_invalid' };
  }
  return { ok: true, issuers, scopes };
}

function validateAuthorizationMetadata(value, issuer) {
  if (value.issuer !== issuer || typeof value.authorization_endpoint !== 'string'
    || typeof value.token_endpoint !== 'string'
    || !Array.isArray(value.code_challenge_methods_supported)
    || !value.code_challenge_methods_supported.includes('S256')) {
    return { ok: false, reason: 'authorization_server_metadata_invalid' };
  }
  for (const endpoint of [value.authorization_endpoint, value.token_endpoint,
    ...(value.registration_endpoint ? [value.registration_endpoint] : [])]) {
    const normalized = normalizeDestination(endpoint);
    if (!normalized.ok || normalized.url.protocol !== 'https:') {
      return { ok: false, reason: 'authorization_server_metadata_invalid' };
    }
  }
  return { ok: true, metadata: value };
}

async function brokerGet(broker, url, context) {
  return broker.request({
    purpose: 'oauth_discovery', request_id: context.request_id,
    operation_id: context.operation_id, url, method: 'GET',
    headers: { accept: 'application/json' }, consent: context.consent,
    redaction_policy: 'strict', deadline_epoch_ms: context.deadline_epoch_ms,
    limits: { max_response_bytes: MAX_METADATA_BYTES }, signal: context.signal || null,
  });
}

async function discoverAuthorizationServer({ broker, resourceUrl, challengeHeader, context }) {
  const challenge = challengeHeader ? parseBearerChallenge(challengeHeader)
    : { ok: true, resource_metadata: null, scopes: [] };
  if (!challenge.ok) return challenge;
  const candidates = protectedResourceMetadataUrls(resourceUrl, challenge.resource_metadata);
  if (!candidates.ok) return candidates;
  let protectedMetadata;
  for (const url of candidates.urls) {
    const parsed = parseJsonBody(await brokerGet(broker, url, context), 'protected_resource_metadata_invalid');
    if (!parsed.ok) continue;
    const checked = validateProtectedResourceMetadata(parsed.value, candidates.resource);
    if (checked.ok) { protectedMetadata = { ...checked, value: parsed.value }; break; }
  }
  if (!protectedMetadata) return { ok: false, reason: 'protected_resource_metadata_unavailable' };
  for (const issuer of protectedMetadata.issuers) {
    const urls = authorizationMetadataUrls(issuer);
    for (const url of urls.urls) {
      const parsed = parseJsonBody(await brokerGet(broker, url, context), 'authorization_server_metadata_invalid');
      if (!parsed.ok) continue;
      const checked = validateAuthorizationMetadata(parsed.value, issuer);
      if (checked.ok) {
        return {
          ok: true, resource: candidates.resource, resource_digest: digestText(candidates.resource),
          issuer, issuer_digest: digestText(issuer), metadata: checked.metadata,
          challenged_scopes: challenge.scopes, supported_scopes: protectedMetadata.scopes,
        };
      }
    }
  }
  return { ok: false, reason: 'authorization_server_metadata_unavailable' };
}

function chooseClientRegistration(metadata, options = {}) {
  if (metadata.client_id_metadata_document_supported === true
    && typeof options.client_id_metadata_document === 'string') {
    const normalized = normalizeDestination(options.client_id_metadata_document);
    if (normalized.ok && normalized.url.protocol === 'https:' && normalized.url.pathname !== '/') {
      return { ok: true, kind: 'client_id_metadata_document', client_id: normalized.url.href };
    }
  }
  const preregistered = options.preregistered;
  if (preregistered && typeof preregistered.client_id === 'string'
    && preregistered.client_id.length > 0
    && Buffer.byteLength(preregistered.client_id, 'utf8') <= 2048
    && (preregistered.client_secret === undefined
      || (typeof preregistered.client_secret === 'string'
        && Buffer.byteLength(preregistered.client_secret, 'utf8') <= 16384))) {
    return { ok: true, kind: 'preregistered', client_id: preregistered.client_id,
      client_secret: preregistered.client_secret || null };
  }
  if (options.allow_dcr === true && typeof metadata.registration_endpoint === 'string') {
    return { ok: true, kind: 'dynamic_registration', registration_endpoint: metadata.registration_endpoint };
  }
  return { ok: false, reason: 'oauth_client_registration_unavailable' };
}

module.exports = {
  MAX_METADATA_BYTES,
  parseBearerChallenge,
  protectedResourceMetadataUrls,
  authorizationMetadataUrls,
  discoverAuthorizationServer,
  chooseClientRegistration,
};
