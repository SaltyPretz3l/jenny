'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { FILE_NAME, MAX_RECEIPTS, FullHostCleanupReceiptStore } = require(
  '../../../services/plugins/full-host/cleanup-receipt-store'
);
const { FullHostCrashQuarantineStore } = require(
  '../../../services/plugins/full-host/crash-quarantine-store'
);
const { CrashQuarantineController } = require(
  '../../../services/plugins/full-host/crash-quarantine-controller'
);

test('unproven cleanup survives restart until a proven settlement', async () => {
  const facade = createMemoryFsFacade();
  const first = new FullHostCleanupReceiptStore({
    facade, baseDir: 'plugins', now: () => Date.parse('2026-08-09T00:00:00Z'),
  });
  const recorded = await first.record({
    session: { session_id: 'session-1', session_epoch: 2,
      authority: { active_generation_id: 'generation-1', commit_epoch: 3 },
      publisher_id: 'publisher', plugin_id: 'plugin', contribution_id: 'host' },
    result: { cleanup_status: 'termination_failed' }, reason: 'shutdown',
  });
  assert.equal(recorded.ok, true);
  const restarted = new FullHostCleanupReceiptStore({ facade, baseDir: 'plugins' });
  assert.equal((await restarted.list()).receipts.length, 1);
  assert.equal((await restarted.settle(recorded.receipt)).ok, true);
  assert.deepEqual((await restarted.list()).receipts, []);
});

test('cleanup receipt capacity preserves unresolved and future records', async () => {
  const facade = createMemoryFsFacade();
  const receipts = [null, {
    session_id: 'existing', session_epoch: 4, future_schema: 2, future_detail: { keep: true },
  }];
  while (receipts.length < MAX_RECEIPTS) {
    receipts.push({ session_id: `pending-${receipts.length}`, session_epoch: 1 });
  }
  await facade.mkdir('plugins/runtime');
  await facade.writeFile(`plugins/runtime/${FILE_NAME}`, JSON.stringify({
    schema_version: 1, receipts,
  }));
  const store = new FullHostCleanupReceiptStore({ facade, baseDir: 'plugins', now: () => 0 });

  const rejected = await store.record({ session: { session_id: 'new', session_epoch: 1 } });
  assert.deepEqual(rejected, { ok: false, reason: 'cleanup_receipt_store_capacity' });
  assert.deepEqual((await store.list()).receipts, receipts);

  const updated = await store.record({ session: { session_id: 'existing', session_epoch: 4 },
    reason: 'retry_unproven' });
  assert.equal(updated.ok, true);
  const after = (await store.list()).receipts;
  assert.equal(after.length, MAX_RECEIPTS);
  assert.equal(after[0], null);
  assert.equal(after[1].future_schema, 2);
  assert.deepEqual(after[1].future_detail, { keep: true });
  assert.equal(after[1].reason, 'retry_unproven');
  assert.equal((await store.settle(updated.receipt)).ok, true);
  const settled = (await store.list()).receipts;
  assert.equal(settled.length, MAX_RECEIPTS - 1);
  assert.equal(settled[0], null, 'malformed evidence is preserved for future recovery');
});

test('crash quarantine state hydrates after restart and remains identity-bound', async () => {
  const facade = createMemoryFsFacade();
  const store = new FullHostCrashQuarantineStore({ facade, baseDir: 'plugins' });
  let now = 1;
  const identity = { publisher_id: 'publisher', plugin_id: 'plugin',
    contribution_id: 'host', executable_digest: 'a'.repeat(64) };
  const controller = new CrashQuarantineController({ now: () => now++, limit: 2,
    persist: (entries) => store.save(entries) });
  await controller.recordCrash(identity);
  assert.equal((await controller.recordCrash(identity)).quarantined, true);
  const loaded = await store.load();
  const restarted = new CrashQuarantineController({ limit: 2 });
  restarted.hydrate(loaded.entries);
  assert.equal(restarted.isQuarantined(identity), true);
  assert.equal(restarted.isQuarantined({ ...identity, executable_digest: 'b'.repeat(64) }), false);
});

test('concurrent crash records persist the newest snapshot last', async () => {
  const releases = [];
  let durable;
  const persist = (entries) => new Promise((resolve) => {
    releases.push(() => { durable = entries; resolve(); });
  });
  const controller = new CrashQuarantineController({ persist, limit: 99 });
  const identity = { publisher_id: 'publisher', plugin_id: 'plugin',
    contribution_id: 'host', executable_digest: 'a'.repeat(64) };
  const first = controller.recordCrash(identity);
  const second = controller.recordCrash(identity);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases.shift()();
  await Promise.all([first, second]);
  assert.equal(controller.exportState()[0].times.length, 2);
  assert.equal(durable[0].times.length, 2);
});
