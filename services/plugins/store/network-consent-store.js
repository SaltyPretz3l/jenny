'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');
const { stableStringify } = require('../package/canonical-metadata');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');

const DIR = 'policy';
const FILE = 'network-consent.json';
const CONTRACT = 'PluginNetworkConsentV1';

function emptyNetworkConsent() {
  return {
    network_consent_schema_version: 1,
    revision: 1,
    system_authorized: false,
    purpose_grants: [],
    plugin_consents: [],
  };
}

function networkConsentDigest(document) {
  return crypto.createHash('sha256').update(stableStringify(document), 'utf8').digest('hex');
}

async function readNetworkConsent(facade, baseDir) {
  const read = await readJsonFile(facade, joinPath(baseDir, DIR, FILE));
  if (read.status === 'missing') {
    const document = emptyNetworkConsent();
    return { ok: true, document, digest: networkConsentDigest(document), missing: true };
  }
  if (read.status !== 'ok') return { ok: false, reason: 'network_consent_corrupted' };
  const checked = validate(CONTRACT, read.value);
  if (!checked.ok) return { ok: false, reason: 'network_consent_invalid' };
  return {
    ok: true,
    document: checked.value,
    digest: networkConsentDigest(checked.value),
    missing: false,
  };
}

async function setPluginNetworkConsent(facade, baseDir, {
  publisherId,
  pluginId,
  enabled,
  scopes,
  destinations,
} = {}) {
  const current = await readNetworkConsent(facade, baseDir);
  if (!current.ok) return current;
  const rows = current.document.plugin_consents.filter((row) => !(
    row.publisher_id === publisherId
    && row.plugin_id === pluginId
    && row.purpose === 'plugin_runtime'
  ));
  rows.push({
    publisher_id: publisherId,
    plugin_id: pluginId,
    purpose: 'plugin_runtime',
    scopes,
    destinations,
    enabled: enabled === true,
  });
  rows.sort((left, right) => (
    `${left.publisher_id}\0${left.plugin_id}`.localeCompare(
      `${right.publisher_id}\0${right.plugin_id}`
    )
  ));
  const candidate = {
    ...current.document,
    revision: current.document.revision + 1,
    plugin_consents: rows,
  };
  const checked = validate(CONTRACT, candidate);
  if (!checked.ok) {
    return { ok: false, reason: 'network_consent_invalid', detail: checked.error };
  }
  try {
    await writeJsonFileAtomic(facade, joinPath(baseDir, DIR), FILE, checked.value);
  } catch (_error) {
    return { ok: false, reason: 'network_consent_write_failed' };
  }
  const authorized = checked.value.system_authorized === true;
  return {
    ok: authorized,
    ...(authorized ? {} : { reason: 'system_network_authorization_required' }),
    revision: checked.value.revision,
    digest: networkConsentDigest(checked.value),
    document: checked.value,
  };
}

function brokerConsentFor(document, { publisherId, pluginId, destination, scope } = {}) {
  const destinationConsent = brokerConsentForDestination(document, {
    publisherId, pluginId, destination,
  });
  const scopeAllowed = destinationConsent.allowed_scopes.includes(scope);
  return {
    granted: destinationConsent.granted && scopeAllowed,
    allowed_scopes: scopeAllowed ? destinationConsent.allowed_scopes : [],
  };
}

function brokerConsentForDestination(document, { publisherId, pluginId, destination } = {}) {
  const row = document?.plugin_consents?.find((entry) => (
    entry.publisher_id === publisherId
    && entry.plugin_id === pluginId
    && entry.purpose === 'plugin_runtime'
  ));
  const destinationAllowed = Array.isArray(row?.destinations)
    && row.destinations.includes(destination);
  const allowedScopes = Array.isArray(row?.scopes)
    ? row.scopes.filter((scope) => ['loopback', 'lan', 'internet'].includes(scope)) : [];
  return {
    granted: document?.system_authorized === true
      && row?.enabled === true
      && destinationAllowed
      && allowedScopes.length > 0,
    allowed_scopes: allowedScopes,
  };
}

module.exports = {
  DIR,
  FILE,
  readNetworkConsent,
  setPluginNetworkConsent,
  brokerConsentFor,
  brokerConsentForDestination,
};
