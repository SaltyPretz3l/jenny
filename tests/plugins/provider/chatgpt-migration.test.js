'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  createChatGptPluginMigration,
} = require('../../../services/plugins/provider/chatgpt-migration');

function setup(overrides = {}) {
  const bytes = Buffer.from('signed-package');
  const expectedSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const installs = [];
  const enables = [];
  const facade = createMemoryFsFacade();
  const migration = createChatGptPluginMigration({
    facade, baseDir: 'plugins',
    stage5Service: { installBundledPackage: async (payload) => {
      installs.push(payload);
      return { ok: true, operation_id: 'operation_1', status: 'committed' };
    } },
    chatgptAuthService: { hasCredential: () => true },
    preferredEngineType: () => '',
    enablePlugin: async (identity) => { enables.push(identity); return { ok: true }; },
    loadBundledPackage: async () => ({ ok: true, bytes, expectedSha256 }),
    now: () => '2026-08-06T00:00:00.000Z',
    ...overrides,
  });
  return { migration, installs, enables, bytes, expectedSha256, facade };
}

test('prior ChatGPT users install once, preserve the credential owner, and wait for terminal commit', async () => {
  const { migration, installs, enables } = setup();
  assert.equal((await migration.run()).migrated, true);
  assert.equal(installs[0].wait_for_completion, true);
  assert.equal((await migration.run()).migrated, true);
  assert.equal(installs.length, 1);
  assert.equal(enables.length, 1);
});

test('fresh users remain inactive and explicit removal creates an idempotent tombstone', async () => {
  const { migration, installs, enables } = setup({
    chatgptAuthService: { hasCredential: () => false }, preferredEngineType: () => 'ollama',
  });
  const available = await migration.run();
  assert.equal(available.migrated, false);
  assert.equal(available.available, true);
  assert.equal(installs.length, 1);
  assert.equal(enables.length, 0);
  await migration.markRemoved();
  const after = await migration.run();
  assert.equal(after.state.status, 'removed');
  assert.equal(installs.length, 1);
});

test('a signed-out user who preferred ChatGPT is migrated and remains preferred', async () => {
  let preferenceReads = 0;
  const { migration, enables } = setup({
    chatgptAuthService: { hasCredential: () => false },
    preferredEngineType: () => { preferenceReads += 1; return 'chatgpt'; },
  });
  const result = await migration.run();
  assert.equal(result.migrated, true);
  assert.equal(enables.length, 1);
  assert.equal(preferenceReads, 1);
});

test('an unavailable bundle is skipped without a failed receipt or diagnostic', async () => {
  const diagnostics = [];
  const { migration } = setup({
    loadBundledPackage: async () => ({ ok: false, reason: 'bundled_package_unavailable' }),
    log: (event, detail) => diagnostics.push({ event, detail }),
  });
  assert.deepEqual(await migration.run(), {
    ok: true, migrated: false, reason: 'bundled_package_unavailable',
  });
  assert.equal(await migration.readState(), null);
  assert.deepEqual(diagnostics, []);
});

test('a packaged build missing its bundle stays loud with a failed receipt', async () => {
  const diagnostics = [];
  const { migration } = setup({
    loadBundledPackage: async () => ({ ok: false, reason: 'bundled_package_missing_from_build' }),
    log: (event, detail) => diagnostics.push({ event, detail }),
  });
  assert.equal((await migration.run()).reason, 'bundled_package_missing_from_build');
  assert.equal((await migration.readState()).status, 'failed');
  assert.deepEqual(diagnostics.map((entry) => entry.event), ['plugin.chatgpt_migration.failed']);
});

test('a digest-mismatched package still writes a failed receipt', async () => {
  const { migration } = setup({
    loadBundledPackage: async () => ({ ok: true, bytes: Buffer.from('tampered'), expectedSha256: 'a'.repeat(64) }),
  });
  assert.equal((await migration.run()).reason, 'bundled_package_digest_mismatch');
  assert.equal((await migration.readState()).status, 'failed');
});

test('a failed package install never writes an installed receipt', async () => {
  const failed = setup({ stage5Service: { installBundledPackage: async () => ({ ok: false,
    reason: 'migration_install_failed' }) } }).migration;
  assert.equal((await failed.run()).reason, 'migration_install_failed');
  assert.equal((await failed.readState()).status, 'failed');
});

test('a prior failed receipt does not block a later valid bundled install', async () => {
  const { migration, facade, installs } = setup();
  await facade.mkdir('plugins/provider-migrations');
  await facade.writeFile('plugins/provider-migrations/chatgpt-subscription.json', JSON.stringify({
    migration_schema_version: 1,
    publisher_id: 'jenny-official',
    plugin_id: 'chatgpt-subscription',
    status: 'failed',
    package_sha256: null,
    reason_code: 'bundled_package_unavailable',
    auto_enabled: false,
    updated_at: '2026-08-05T00:00:00.000Z',
  }));
  const result = await migration.run();
  assert.equal(result.available, true);
  assert.equal(installs.length, 1);
  assert.equal((await migration.readState()).status, 'installed');
});

test('legacy enable failure preserves retryable migration state', async () => {
  const { migration } = setup({ enablePlugin: async () => ({ ok: false, reason: 'activation_failed' }) });
  assert.equal((await migration.run()).reason, 'activation_failed');
  assert.equal((await migration.readState()).status, 'failed');
});

test('a corrupt receipt is diagnosed and replaced by an idempotent valid receipt', async () => {
  const diagnostics = [];
  const { migration, facade, installs } = setup({
    log: (event, detail) => diagnostics.push({ event, detail }),
  });
  await facade.mkdir('plugins/provider-migrations');
  await facade.writeFile('plugins/provider-migrations/chatgpt-subscription.json',
    '{"migration_schema_version":1,"status":"installed","package_sha256":"forged"}');
  const result = await migration.run();
  assert.equal(result.migrated, true);
  assert.equal(installs.length, 1);
  assert.equal((await migration.readState()).status, 'installed');
  assert.deepEqual(diagnostics, [{ event: 'plugin.chatgpt_migration.receipt_invalid',
    detail: { reason_code: 'migration_receipt_invalid' } }]);
});
