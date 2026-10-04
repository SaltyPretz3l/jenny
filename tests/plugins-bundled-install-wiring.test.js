'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createMemoryFsFacade } = require('../services/plugins/store/fs-facade');
const {
  createBundledInstallWiring,
} = require('../services/main/plugins-bundled-install-wiring');

const FIRST_ID = 'first-plugin';
const SECOND_ID = 'second-plugin';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function record(pluginId, bytes, status = 'pinned') {
  return {
    publisher_id: 'jenny-official',
    plugin_id: pluginId,
    version: '1.0.0',
    package_resource: `plugins/${pluginId}.jenny-plugin`,
    package_sha256: status === 'pinned' ? sha256(bytes) : null,
    signing_key_id: 'a'.repeat(64),
    status,
  };
}

function setup(records, {
  bytesById = {}, failedPluginId = '', readFile,
  uninstallResult = { ok: true }, desiredState = '', carryRetiredChoice,
  isPackaged = false, resourcesRoot = path.join('root', 'resources'),
  appRoot = path.join('root', 'app'),
} = {}) {
  const inventory = { bundled_plugins_schema_version: 1, plugins: records };
  const facade = createMemoryFsFacade();
  const installs = [];
  const enables = [];
  const uninstalls = [];
  const logs = [];
  const carried = [];
  const packageReader = readFile || (async (filePath) => {
    const pluginId = path.basename(filePath, '.jenny-plugin');
    if (!bytesById[pluginId]) throw new Error('missing');
    return bytesById[pluginId];
  });
  const wiring = createBundledInstallWiring({
    inventory,
    facade,
    baseDir: 'plugins',
    stage5Service: {
      installBundledPackage: async (payload) => {
        const pluginId = Object.keys(bytesById).find((item) => (
          payload.selected.bytes.equals(bytesById[item])
        ));
        installs.push({ pluginId, payload });
        return pluginId === failedPluginId
          ? { ok: false, reason: 'install_refused' }
          : { ok: true, operation_id: `operation_${pluginId}`, status: 'committed' };
      },
    },
    enablePlugin: async (identity) => { enables.push(identity); return { ok: true }; },
    uninstallPlugin: async (identity) => { uninstalls.push(identity); return uninstallResult; },
    readDesiredState: async () => desiredState,
    carryRetiredChoice: carryRetiredChoice || (async (identity, facts) => {
      carried.push({ identity, facts, uninstalledBefore: uninstalls.length });
    }),
    resourcesRoot,
    appRoot,
    isPackaged,
    readFile: packageReader,
    now: () => '2026-09-06T00:00:00.000Z',
    log: (level, event, data) => logs.push({ level, event, data }),
  });
  return { wiring, facade, installs, enables, uninstalls, carried, logs };
}

test('all pinned records install once in order while awaiting records skip quietly', async () => {
  const firstBytes = Buffer.from('first-package');
  const secondBytes = Buffer.from('second-package');
  const awaitingBytes = Buffer.from('awaiting-package');
  const records = [
    record(FIRST_ID, firstBytes),
    record(SECOND_ID, secondBytes),
    record('awaiting-plugin', awaitingBytes, 'awaiting_owner_signature'),
  ];
  const harness = setup(records, { bytesById: {
    [FIRST_ID]: firstBytes,
    [SECOND_ID]: secondBytes,
  } });

  const first = harness.wiring.run();
  assert.equal(harness.wiring.run(), first, 'concurrent callers share one promise');
  const result = await first;
  assert.deepEqual(harness.installs.map((item) => item.pluginId), [FIRST_ID, SECOND_ID]);
  const requestIds = harness.installs.map((item) => item.payload.client_request_id);
  assert.equal(new Set(requestIds).size, 2);
  assert.ok(requestIds.every((value) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)));
  assert.equal(harness.installs.every((item) => item.payload.wait_for_completion === true), true);
  assert.deepEqual(result.bundled, [
    { plugin_id: FIRST_ID, ok: true, reason: undefined },
    { plugin_id: SECOND_ID, ok: true, reason: undefined },
    { plugin_id: 'awaiting-plugin', ok: true,
      reason: 'bundled_package_awaiting_owner_signature' },
  ]);
  assert.deepEqual(harness.enables, []);
  assert.equal(await harness.facade.stat(
    'plugins/provider-migrations/awaiting-plugin.json').then((item) => item.exists), false);

  await harness.wiring.run();
  assert.equal(harness.installs.length, 2, 'installed receipts suppress repeated installs');
});

test('a second-record install failure is receipted without stopping the first', async () => {
  const firstBytes = Buffer.from('successful-first-package');
  const secondBytes = Buffer.from('failing-second-package');
  const harness = setup([
    record(FIRST_ID, firstBytes),
    record(SECOND_ID, secondBytes),
  ], { failedPluginId: SECOND_ID, bytesById: {
    [FIRST_ID]: firstBytes,
    [SECOND_ID]: secondBytes,
  } });
  const result = await harness.wiring.run();
  assert.equal(result.ok, false);
  assert.deepEqual(result.bundled, [
    { plugin_id: FIRST_ID, ok: true, reason: undefined },
    { plugin_id: SECOND_ID, ok: false, reason: 'install_refused' },
  ]);
  const receipt = JSON.parse(await harness.facade.readFile(
    'plugins/provider-migrations/second-plugin.json'));
  assert.deepEqual({ status: receipt.status, reason: receipt.reason_code },
    { status: 'failed', reason: 'install_refused' });
  assert.equal(harness.logs.some(({ event, data }) => event === 'plugins.bundled_install'
    && data.plugin_id === SECOND_ID && data.status === 'failed'), true);
});

test('development reads fall back to appRoot while packaged misses stay loud', async () => {
  const bytes = Buffer.from('fallback-package');
  const resourcesRoot = path.join('root', 'resources');
  const appRoot = path.join('root', 'app');
  const reads = [];
  const development = setup([record(SECOND_ID, bytes)], {
    bytesById: { [SECOND_ID]: bytes }, resourcesRoot, appRoot,
    readFile: async (filePath) => {
      reads.push(filePath);
      if (filePath.startsWith(resourcesRoot)) throw new Error('not built');
      return bytes;
    },
  });
  assert.equal((await development.wiring.run()).bundled[0].ok, true);
  assert.deepEqual(reads, [
    path.join(resourcesRoot, 'plugins', `${SECOND_ID}.jenny-plugin`),
    path.join(appRoot, 'plugins', `${SECOND_ID}.jenny-plugin`),
  ]);

  const packaged = setup([record(SECOND_ID, bytes)], {
    bytesById: { [SECOND_ID]: bytes }, isPackaged: true,
    readFile: async () => { throw new Error('missing from build'); },
  });
  const packagedResult = await packaged.wiring.run();
  assert.equal(packagedResult.bundled[0].reason, 'bundled_package_missing_from_build');
  const receipt = JSON.parse(await packaged.facade.readFile(
    'plugins/provider-migrations/second-plugin.json'));
  assert.deepEqual({ status: receipt.status, reason: receipt.reason_code }, {
    status: 'failed', reason: 'bundled_package_missing_from_build',
  });
});

test('markRemoved tombstones known identities and ignores malformed or unknown records', async () => {
  const bytes = Buffer.from('removable-package');
  const harness = setup([
    { publisher_id: 'other', plugin_id: 'bad-plugin' },
    record(SECOND_ID, bytes),
  ], { bytesById: { [SECOND_ID]: bytes } });
  assert.deepEqual(harness.wiring.identities, [{
    publisher_id: 'jenny-official', plugin_id: SECOND_ID,
  }]);
  assert.equal(Object.isFrozen(harness.wiring.identities), true);
  assert.equal(harness.logs.filter(({ event }) => (
    event === 'plugins.bundled_install.record_invalid')).length, 1);

  assert.deepEqual(await harness.wiring.markRemoved({
    publisher_id: 'jenny-official', plugin_id: 'unknown-plugin',
  }), { ok: true, ignored: true });
  await harness.wiring.markRemoved({
    publisher_id: 'jenny-official', plugin_id: SECOND_ID,
  });
  const receipt = JSON.parse(await harness.facade.readFile(
    'plugins/provider-migrations/second-plugin.json'));
  assert.deepEqual({ status: receipt.status, reason: receipt.reason_code },
    { status: 'removed', reason: 'user_removed' });
});

const RETIRED_RECEIPT = 'plugins/provider-migrations/remote-control.json';

async function seedRetiredReceipt(facade) {
  await facade.mkdir('plugins/provider-migrations');
  await facade.writeFile(RETIRED_RECEIPT, JSON.stringify({ status: 'installed' }));
}

test('a profile that installed the removed Remote Control plugin has it uninstalled once', async () => {
  const harness = setup([]);
  await seedRetiredReceipt(harness.facade);

  await harness.wiring.run();
  await harness.wiring.run();

  assert.deepEqual(harness.uninstalls, [{
    publisher_id: 'jenny-official', plugin_id: 'remote-control',
  }]);
  await assert.rejects(harness.facade.readFile(RETIRED_RECEIPT), { code: 'ENOENT' });
  assert.deepEqual(harness.logs.filter(({ event }) => event === 'plugins.bundled_retired'), [{
    level: 'INFO', event: 'plugins.bundled_retired',
    data: { plugin_id: 'remote-control', status: 'removed' },
  }]);
});

test('a profile that never installed the removed plugin is left alone', async () => {
  const harness = setup([]);

  await harness.wiring.run();

  assert.deepEqual(harness.uninstalls, []);
  assert.deepEqual(harness.logs.filter(({ event }) => event === 'plugins.bundled_retired'), []);
});

test('a refused uninstall of the removed plugin keeps the receipt for the next start', async () => {
  const harness = setup([], { uninstallResult: { ok: false, reason: 'store_read_only' } });
  await seedRetiredReceipt(harness.facade);

  await harness.wiring.run();

  assert.equal(harness.uninstalls.length, 1);
  assert.equal(JSON.parse(await harness.facade.readFile(RETIRED_RECEIPT)).status, 'installed');
  assert.deepEqual(harness.logs.filter(({ event }) => event === 'plugins.bundled_retired'), [{
    level: 'WARN', event: 'plugins.bundled_retired',
    data: { plugin_id: 'remote-control', status: 'failed' },
  }]);
});

const CHATGPT_RECEIPT = 'plugins/provider-migrations/chatgpt-subscription.json';
const CHATGPT_IDENTITY = { publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription' };

async function seedChatgptReceipt(facade, receipt) {
  await facade.mkdir('plugins/provider-migrations');
  await facade.writeFile(CHATGPT_RECEIPT, JSON.stringify(receipt));
}

test('the retired ChatGPT plugin hands over its on/off facts before it is uninstalled', async () => {
  const receipt = { status: 'installed', auto_enabled: true };
  const harness = setup([], { desiredState: 'active' });
  await seedChatgptReceipt(harness.facade, receipt);

  await harness.wiring.run();
  await harness.wiring.run();

  assert.deepEqual(harness.carried, [{
    identity: CHATGPT_IDENTITY,
    facts: { receipt, desiredState: 'active' },
    uninstalledBefore: 0,
  }]);
  assert.deepEqual(harness.uninstalls, [CHATGPT_IDENTITY]);
  await assert.rejects(harness.facade.readFile(CHATGPT_RECEIPT), { code: 'ENOENT' });
});

test('a failed hand-over keeps the ChatGPT plugin and its receipt for the next start', async () => {
  const harness = setup([], {
    carryRetiredChoice: async () => { throw new Error('config write failed'); },
  });
  await seedChatgptReceipt(harness.facade, { status: 'removed', auto_enabled: false });

  await harness.wiring.run();

  assert.deepEqual(harness.uninstalls, []);
  assert.equal(JSON.parse(await harness.facade.readFile(CHATGPT_RECEIPT)).status, 'removed');
  assert.deepEqual(harness.logs.filter(({ event }) => event === 'plugins.bundled_retired'), [{
    level: 'WARN', event: 'plugins.bundled_retired',
    data: { plugin_id: 'chatgpt-subscription', status: 'failed' },
  }]);
});

test('a corrupt ChatGPT receipt still retires the plugin, with no receipt facts', async () => {
  const harness = setup([], { desiredState: 'disabled' });
  await harness.facade.mkdir('plugins/provider-migrations');
  await harness.facade.writeFile(CHATGPT_RECEIPT, '{not json');

  await harness.wiring.run();

  assert.deepEqual(harness.carried.map(({ facts }) => facts), [{
    receipt: null, desiredState: 'disabled',
  }]);
  assert.deepEqual(harness.uninstalls, [CHATGPT_IDENTITY]);
});
