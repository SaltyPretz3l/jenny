'use strict';

const { join } = require('node:path');
const {
  PACKAGE_IDENTITY,
  createBundledPluginMigration,
  createChatGptPluginMigration,
} = require('../../services/plugins/provider/chatgpt-migration');
const {
  resolveBundledPluginRecord,
} = require('../../services/plugins/provider/bundled-plugin-inventory');

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function validIdentity(record) {
  return record?.publisher_id === 'jenny-official'
    && typeof record.plugin_id === 'string' && PLUGIN_ID_RE.test(record.plugin_id);
}

function sameIdentity(left, right) {
  return left?.publisher_id === right?.publisher_id
    && left?.plugin_id === right?.plugin_id;
}

function createBundledInstallWiring({ inventory, facade, baseDir, stage5Service,
  chatgptAuthService, preferredEngineType = () => '', enablePlugin,
  resourcesRoot, appRoot, isPackaged = false, readFile, now, log = () => {} } = {}) {
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
    const migration = sameIdentity(identity, PACKAGE_IDENTITY)
      ? createChatGptPluginMigration({
        ...shared, chatgptAuthService, preferredEngineType,
      })
      : createBundledPluginMigration({ ...shared, identity, autoEnable: () => false });
    migrations.push(migration);
  }

  const identities = Object.freeze(migrations.map(({ identity }) => identity));
  const chatgptMigration = migrations.find(({ identity }) => (
    sameIdentity(identity, PACKAGE_IDENTITY)
  ));
  const bundledMigrations = migrations.filter(({ identity }) => (
    !sameIdentity(identity, PACKAGE_IDENTITY)
  ));
  let inFlight = null;

  async function execute() {
    const chatgptResult = chatgptMigration
      ? await chatgptMigration.run()
      : { ok: true, migrated: false, available: false, reason: 'no_chatgpt_record' };
    const bundled = [];
    for (const migration of bundledMigrations) {
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
    return { ...chatgptResult, bundled };
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
