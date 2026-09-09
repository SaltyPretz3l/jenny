'use strict';

const crypto = require('node:crypto');
const { joinPath } = require('../store/fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('../store/json-file-io');

const STATE_DIR = 'provider-migrations';
const PACKAGE_IDENTITY = Object.freeze({ publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription' });
const RECEIPT_STATUSES = new Set(['installed', 'failed', 'removed']);
const DIGEST_RE = /^[0-9a-f]{64}$/;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REQUEST_ID_PREFIX_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function validIdentity(identity) {
  return identity?.publisher_id === 'jenny-official'
    && typeof identity.plugin_id === 'string' && PLUGIN_ID_RE.test(identity.plugin_id);
}

function validState(value, identity) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.migration_schema_version !== 1
    || value.publisher_id !== identity.publisher_id
    || value.plugin_id !== identity.plugin_id
    || !RECEIPT_STATUSES.has(value.status)
    || typeof value.auto_enabled !== 'boolean'
    || typeof value.reason_code !== 'string' || value.reason_code.length > 128
    || typeof value.updated_at !== 'string' || value.updated_at.length > 64) return false;
  if (value.status === 'installed') return DIGEST_RE.test(value.package_sha256 || '');
  return value.package_sha256 === null || DIGEST_RE.test(value.package_sha256 || '');
}

function defaultRequestIdPrefix(pluginId) {
  const safePluginId = pluginId.replace(/[^a-z0-9_-]/g, '_').slice(0, 25);
  return `bundled_install_${safePluginId}`;
}

function clientRequestId(requestIdPrefix, packageSha256, previousState) {
  const retrySuffix = previousState?.status === 'failed'
    ? `_r${digest(previousState.updated_at).slice(0, 8)}` : '';
  return `${requestIdPrefix}_${packageSha256.slice(0, 12)}${retrySuffix}`;
}

function createBundledPluginMigration({ identity, facade, baseDir, stage5Service,
  loadBundledPackage, enablePlugin = async () => ({ ok: false,
    reason: 'migration_enable_unavailable' }), autoEnable = () => false,
  requestIdPrefix,
  logPrefix = 'plugin.bundled_install', now = () => new Date().toISOString(),
  log = () => {} } = {}) {
  if (!validIdentity(identity) || !facade || !stage5Service
    || typeof loadBundledPackage !== 'function' || typeof autoEnable !== 'function') {
    throw new TypeError('Bundled plugin migration dependencies invalid');
  }
  const migrationIdentity = Object.freeze({
    publisher_id: identity.publisher_id,
    plugin_id: identity.plugin_id,
  });
  const operationRequestIdPrefix = requestIdPrefix === undefined
    ? defaultRequestIdPrefix(migrationIdentity.plugin_id) : requestIdPrefix;
  if (typeof operationRequestIdPrefix !== 'string'
    || !REQUEST_ID_PREFIX_RE.test(operationRequestIdPrefix)) {
    throw new TypeError('Bundled plugin migration request id prefix invalid');
  }
  const stateFile = `${migrationIdentity.plugin_id}.json`;
  let inFlight = null;

  async function readState() {
    const read = await readJsonFile(facade, joinPath(baseDir, STATE_DIR, stateFile));
    if (read.status === 'missing') return null;
    if (read.status === 'ok' && validState(read.value, migrationIdentity)) return read.value;
    log(`${logPrefix}.receipt_invalid`, {
      plugin_id: migrationIdentity.plugin_id,
      reason_code: 'migration_receipt_invalid',
    });
    return null;
  }

  async function writeState(status, packageSha256 = null, reason = '', autoEnabled = false) {
    const value = { migration_schema_version: 1, ...migrationIdentity, status,
      package_sha256: packageSha256, reason_code: reason, auto_enabled: autoEnabled,
      updated_at: now() };
    try {
      await writeJsonFileAtomic(facade, joinPath(baseDir, STATE_DIR), stateFile, value);
      return { ok: true, state: value };
    } catch (_error) {
      return { ok: false, reason: 'migration_state_write_failed' };
    }
  }

  async function execute() {
    const state = await readState();
    if (state?.status === 'removed' || state?.status === 'installed') {
      return { ok: true, migrated: state.status === 'installed' && state.auto_enabled === true,
        available: state.status === 'installed', state };
    }
    const shouldAutoEnable = autoEnable() === true;
    const bundled = await loadBundledPackage();
    if (!bundled?.ok) {
      if (bundled?.reason === 'bundled_package_awaiting_owner_signature'
        || bundled?.reason === 'bundled_package_unavailable') {
        return { ok: true, migrated: false, reason: bundled.reason };
      }
      const reason = bundled?.reason || 'bundled_package_unavailable';
      await writeState('failed', null, reason);
      log(`${logPrefix}.failed`, { plugin_id: migrationIdentity.plugin_id, reason_code: reason });
      return { ok: false, reason };
    }
    const packageSha256 = digest(bundled.bytes);
    if (packageSha256 !== bundled.expectedSha256) {
      await writeState('failed', packageSha256, 'bundled_package_digest_mismatch');
      return { ok: false, reason: 'bundled_package_digest_mismatch' };
    }
    const installed = await stage5Service.installBundledPackage({
      selected: { ok: true, canceled: false, bytes: bundled.bytes,
        sourcePathDigest: packageSha256 },
      client_request_id: clientRequestId(operationRequestIdPrefix, packageSha256, state),
      wait_for_completion: true,
    });
    if (!installed?.ok) {
      const reason = installed?.reason || 'migration_install_failed';
      await writeState('failed', packageSha256, reason);
      return { ok: false, reason };
    }
    if (installed.status !== 'committed') {
      const reason = 'bundled_install_not_committed';
      await writeState('failed', packageSha256, reason);
      return { ok: false, reason };
    }
    if (shouldAutoEnable) {
      const enabled = await enablePlugin(migrationIdentity);
      if (!enabled?.ok) {
        const reason = enabled?.reason || 'migration_enable_failed';
        await writeState('failed', packageSha256, reason);
        return { ok: false, reason };
      }
    }
    const receipt = await writeState('installed', packageSha256, '', shouldAutoEnable);
    return receipt.ok ? { ok: true, migrated: shouldAutoEnable, available: true,
      operation: installed } : { ok: false, reason: receipt.reason };
  }

  function run() {
    if (!inFlight) inFlight = execute().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function markRemoved() {
    if (inFlight) await inFlight.catch(() => {});
    return writeState('removed', null, 'user_removed');
  }

  return Object.freeze({ run, markRemoved, readState, identity: migrationIdentity });
}

function createChatGptPluginMigration({ chatgptAuthService, preferredEngineType = () => '',
  log = () => {}, ...deps } = {}) {
  const legacyLog = (event, { plugin_id: _pluginId, ...data }) => log(event, data);
  return createBundledPluginMigration({
    ...deps,
    identity: PACKAGE_IDENTITY,
    autoEnable: () => chatgptAuthService?.hasCredential?.() === true
      || String(preferredEngineType() || '').toLowerCase() === 'chatgpt',
    requestIdPrefix: 'chatgpt_migration',
    logPrefix: 'plugin.chatgpt_migration',
    log: legacyLog,
  });
}

module.exports = { PACKAGE_IDENTITY, createBundledPluginMigration, createChatGptPluginMigration };
