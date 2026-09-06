'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CleanupReconciler } = require('../../../services/plugins/full-host/cleanup-reconciler');

test('cleanup reconciler exposes proven complete state', async () => {
  const persisted = [];
  const reconciler = new CleanupReconciler({
    reconcileReceipt: async () => ({ ok: true, terminated: true, tree_empty: true }),
    persistReceipt: async (receipt) => persisted.push(receipt),
  });
  const receipt = { session_id: 'session_a', session_epoch: 7 };
  const result = await reconciler.reconcile([receipt]);
  assert.equal(result.ok, true);
  assert.equal(result.cleanup_status, 'complete');
  assert.deepEqual(reconciler.state(), { cleanup_status: 'complete' });
  assert.deepEqual(persisted, [receipt]);
});

test('cleanup reconciler fails closed when termination cannot be proved', async () => {
  const events = [];
  const reconciler = new CleanupReconciler({
    reconcileReceipt: async () => ({ ok: true, terminated: false, tree_empty: false }),
    persistReceipt: async () => assert.fail('unproven cleanup must not persist success'),
    diagnostics: { record: (...args) => events.push(args) },
  });
  const result = await reconciler.reconcile([{ session_id: 'session_a' }]);
  assert.equal(result.ok, false);
  assert.equal(result.cleanup_status, 'termination_failed');
  assert.equal(events.length, 1);
});

test('pending restart is preserved as a distinct cleanup-only state', async () => {
  const reconciler = new CleanupReconciler({
    reconcileReceipt: async () => ({ ok: false, cleanup_status: 'pending_restart' }),
  });
  const result = await reconciler.reconcile([{}]);
  assert.equal(result.ok, false);
  assert.equal(result.cleanup_status, 'pending_restart');
});
