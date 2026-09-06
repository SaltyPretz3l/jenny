'use strict';

const crypto = require('node:crypto');
const { joinPath } = require('../store/fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('../store/json-file-io');

const STATE_DIR = 'provider-migrations';
const STATE_FILE = 'chatgpt-subscription.json';
const PACKAGE_IDENTITY = Object.freeze({ publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription' });
const RECEIPT_STATUSES = new Set(['installed', 'failed', 'removed']);
const DIGEST_RE = /^[0-9a-f]{64}$/;

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function validState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.migration_schema_version !== 1
    || value.publisher_id !== PACKAGE_IDENTITY.publisher_id
    || value.plugin_id !== PACKAGE_IDENTITY.plugin_id
    || !RECEIPT_STATUSES.has(value.status)
    || typeof value.auto_enabled !== 'boolean'
    || typeof value.reason_code !== 'string' || value.reason_code.length > 128
    || typeof value.updated_at !== 'string' || value.updated_at.length > 64) return false;
  if (value.status === 'installed') return DIGEST_RE.test(value.package_sha256 || '');
  return value.package_sha256 === null || DIGEST_RE.test(value.package_sha256 || '');
}

function createChatGptPluginMigration({ facade, baseDir, stage5Service, chatgptAuthService,
  preferredEngineType = () => '', loadBundledPackage, now = () => new Date().toISOString(),
  enablePlugin = async () => ({ ok: false, reason: 'migration_enable_unavailable' }),
  log = () => {} } = {}) {
  if (!facade || !stage5Service || typeof loadBundledPackage !== 'function') {
    throw new TypeError('ChatGPT plugin migration dependencies invalid');
  }
  let inFlight = null;

  async function readState() {
    const read = await readJsonFile(facade, joinPath(baseDir, STATE_DIR, STATE_FILE));
    if (read.status === 'missing') return null;
    if (read.status === 'ok' && validState(read.value)) return read.value;
    log('plugin.chatgpt_migration.receipt_invalid', { reason_code: 'migration_receipt_invalid' });
    return null;
  }

  async function writeState(status, packageSha256 = null, reason = '', autoEnabled = false) {
    const value = { migration_schema_version: 1, ...PACKAGE_IDENTITY, status,
      package_sha256: packageSha256, reason_code: reason, auto_enabled: autoEnabled,
      updated_at: now() };
    try {
      await writeJsonFileAtomic(facade, joinPath(baseDir, STATE_DIR), STATE_FILE, value);
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
    const legacyUser = chatgptAuthService?.hasCredential?.() === true
      || String(preferredEngineType() || '').toLowerCase() === 'chatgpt';
    const bundled = await loadBundledPackage();
    if (!bundled?.ok) {
      if (bundled?.reason === 'bundled_package_awaiting_owner_signature'
        || bundled?.reason === 'bundled_package_unavailable') {
        return { ok: true, migrated: false, reason: bundled.reason };
      }
      await writeState('failed', null, bundled?.reason || 'bundled_package_unavailable');
      log('plugin.chatgpt_migration.failed', { reason_code: bundled?.reason || 'bundled_package_unavailable' });
      return { ok: false, reason: bundled?.reason || 'bundled_package_unavailable' };
    }
    const packageSha256 = digest(bundled.bytes);
    if (packageSha256 !== bundled.expectedSha256) {
      await writeState('failed', packageSha256, 'bundled_package_digest_mismatch');
      return { ok: false, reason: 'bundled_package_digest_mismatch' };
    }
    const installed = await stage5Service.installBundledPackage({
      selected: { ok: true, canceled: false, bytes: bundled.bytes,
        sourcePathDigest: packageSha256 },
      client_request_id: `chatgpt_migration_${packageSha256.slice(0, 12)}`,
      wait_for_completion: true,
    });
    if (!installed?.ok) {
      await writeState('failed', packageSha256, installed?.reason || 'migration_install_failed');
      return { ok: false, reason: installed?.reason || 'migration_install_failed' };
    }
    if (legacyUser) {
      const enabled = await enablePlugin(PACKAGE_IDENTITY);
      if (!enabled?.ok) {
        await writeState('failed', packageSha256, enabled?.reason || 'migration_enable_failed');
        return { ok: false, reason: enabled?.reason || 'migration_enable_failed' };
      }
    }
    const receipt = await writeState('installed', packageSha256, '', legacyUser);
    return receipt.ok ? { ok: true, migrated: legacyUser, available: true, operation: installed }
      : { ok: false, reason: receipt.reason };
  }

  function run() {
    if (!inFlight) {
      inFlight = execute().finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  async function markRemoved() {
    if (inFlight) await inFlight.catch(() => {});
    return writeState('removed', null, 'user_removed');
  }

  return Object.freeze({ run, markRemoved, readState });
}

module.exports = { PACKAGE_IDENTITY, createChatGptPluginMigration };
