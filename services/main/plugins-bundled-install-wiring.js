'use strict';

const { join } = require('node:path');
const {
  createBundledPluginMigration,
} = require('../../services/plugins/provider/bundled-plugin-migration');
const {
  resolveBundledPluginRecord,
} = require('../../services/plugins/provider/bundled-plugin-inventory');

const { joinPath } = require('../../services/plugins/store/fs-facade');
const { readJsonFile } = require('../../services/plugins/store/json-file-io');

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RECEIPT_DIR = 'provider-migrations';
// Bundled plugins whose feature was removed from the app or moved into core
// (Remote Control and ChatGPT, 2026-10-02). A profile that installed one still
// has the plugin and its install receipt; startup hands the plugin's on/off
// facts to carryRetiredChoice, uninstalls the plugin and drops the receipt, so
// this runs once per profile.
const RETIRED_PLUGINS = Object.freeze([
  Object.freeze({ publisher_id: 'jenny-official', plugin_id: 'remote-control' }),
  Object.freeze({ publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription' }),
]);

function validIdentity(record) {
  return record?.publisher_id === 'jenny-official'
    && typeof record.plugin_id === 'string' && PLUGIN_ID_RE.test(record.plugin_id);
}

function sameIdentity(left, right) {
  return left?.publisher_id === right?.publisher_id
    && left?.plugin_id === right?.plugin_id;
}

function createBundledInstallWiring({ inventory, facade, baseDir, stage5Service,
  enablePlugin, uninstallPlugin, readDesiredState = async () => '',
  carryRetiredChoice = async () => {}, resourcesRoot, appRoot, isPackaged = false, readFile, now, log = () => {} } = {}) {
  if (typeof readFile !== 'function') {
    throw new TypeError('Bundled install wiring dependencies invalid');
  }
  const records = Array.isArray(inventory?.plugins) ? inventory.plugins : [];
  const migrations = [];

  for (const record of records) {
    if (!validIdentity(record)) {
      log('WARN', 'plugins.bundled_install.record_invalid', {
        reason_code: 'bundled_plugin_identity_invalid',
      });
      continue;
    }
    const identity = Object.freeze({
      publisher_id: record.publisher_id,
      plugin_id: record.plugin_id,
    });
    const loadBundledPackage = async () => {
      const bundled = resolveBundledPluginRecord(inventory, identity);
      if (!bundled.ok) return bundled;
      const resourceParts = bundled.record.package_resource.split('/');
      try {
        return { ok: true, bytes: await readFile(join(resourcesRoot, ...resourceParts)),
          expectedSha256: bundled.record.package_sha256 };
      } catch (_error) {
        if (!isPackaged) {
          try {
            return { ok: true, bytes: await readFile(join(appRoot, ...resourceParts)),
              expectedSha256: bundled.record.package_sha256 };
          } catch (_devError) { /* fall through to the unavailable result */ }
        }
        return { ok: false, reason: isPackaged
          ? 'bundled_package_missing_from_build' : 'bundled_package_unavailable' };
      }
    };
    const shared = {
      facade, baseDir, stage5Service, loadBundledPackage, enablePlugin, now,
      log: (event, data, level = 'WARN') => log(level, event, data),
    };
    migrations.push(createBundledPluginMigration({ ...shared, identity, autoEnable: () => false }));
  }

  const identities = Object.freeze(migrations.map(({ identity }) => identity));
  let inFlight = null;

  async function retireRemovedPlugins() {
    for (const identity of RETIRED_PLUGINS) {
      const receiptPath = joinPath(baseDir, RECEIPT_DIR, `${identity.plugin_id}.json`);
      let status = 'failed';
      try {
        const read = await readJsonFile(facade, receiptPath);
        if (read.status === 'missing') continue;
        await carryRetiredChoice(identity, {
          receipt: read.status === 'ok' ? read.value : null,
          desiredState: await readDesiredState(identity),
        });
        // Uninstalling a plugin that is already absent succeeds without a commit.
        const removed = await uninstallPlugin(identity);
        if (removed?.ok === true) {
          await facade.remove(receiptPath);
          status = 'removed';
        }
      } catch (_error) { /* the receipt stays, so the next start tries again */ }
      log(status === 'removed' ? 'INFO' : 'WARN', 'plugins.bundled_retired', {
        plugin_id: identity.plugin_id,
        status,
      });
    }
  }

  async function execute() {
    await retireRemovedPlugins();
    const bundled = [];
    for (const migration of migrations) {
      let result;
      try {
        result = await migration.run();
      } catch (_error) {
        result = { ok: false, reason: 'bundled_install_internal_error' };
      }
      const status = result?.ok ? (result.available ? 'installed' : 'skipped') : 'failed';
      log(result?.ok ? 'INFO' : 'WARN', 'plugins.bundled_install', {
        plugin_id: migration.identity.plugin_id,
        status,
        reason_code: result?.reason || 'none',
      });
      bundled.push({ plugin_id: migration.identity.plugin_id,
        ok: result?.ok === true, reason: result?.reason });
    }
    return { ok: bundled.every((item) => item.ok), bundled };
  }

  function run() {
    if (!inFlight) inFlight = execute().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function markRemoved(identity) {
    const migration = migrations.find((item) => sameIdentity(item.identity, identity));
    return migration ? migration.markRemoved() : { ok: true, ignored: true };
  }

  return Object.freeze({ run, markRemoved, identities });
}

module.exports = { createBundledInstallWiring };
