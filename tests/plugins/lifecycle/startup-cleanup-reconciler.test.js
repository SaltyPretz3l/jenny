'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { readCleanupState } = require('../../../services/plugins/store/cleanup-state');
const { installPackage } = require('../../../services/plugins/lifecycle/install-operation');
const { uninstallPlugin } = require('../../../services/plugins/lifecycle/uninstall-operation');
const { reconcileStartupCleanup } = require(
  '../../../services/plugins/lifecycle/startup-cleanup-reconciler'
);
const { createVerifiedPackageVerifier } = require('../../helpers/plugins/durability-scenario');

const BASE_DIR = 'plugins';
const NOW = '2026-08-10T00:00:00Z';
const POLICY = { policy_snapshot_digest: 'b'.repeat(64), policy_revision: 1,
  grant_set_digest: 'c'.repeat(64) };
const DATA = [{ domain: 'alpha_state', schema_version: 1 }];

test('startup cleanup retries a locked settings target without restoring plugin authority', async () => {
  const facade = createMemoryFsFacade();
  const installed = await installPackage(facade, BASE_DIR, {
    packageBytes: 'alpha-bytes', publisherId: 'acme', pluginId: 'alpha',
    verifyPackage: createVerifiedPackageVerifier({ publisherId: 'acme', pluginId: 'alpha', now: NOW }),
    requireConsent: async () => ({ ok: true }), newOperationId: () => 'op-install-alpha',
    now: NOW, lifecycleEpoch: 1, generationId: 'gen-alpha', policyGrantRef: POLICY,
    dataSchemaRefs: DATA,
  });
  assert.equal(installed.ok, true);
  const removeTree = facade.removeTree.bind(facade);
  let locked = true;
  facade.removeTree = async (target) => {
    if (locked && target === 'plugins/data/acme/alpha/settings') {
      const error = new Error('locked'); error.code = 'EBUSY'; throw error;
    }
    return removeTree(target);
  };
  const removed = await uninstallPlugin(facade, BASE_DIR, {
    publisherId: 'acme', pluginId: 'alpha', requireConsent: async () => ({ ok: true }),
    newOperationId: () => 'op-uninstall-alpha', now: NOW, lifecycleEpoch: 2,
    generationId: 'gen-absent', policyGrantRef: POLICY, dataSchemaRefs: DATA,
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.result.cleanup_status, 'pending_restart');

  locked = false;
  const reconciled = await reconcileStartupCleanup({ facade, baseDir: BASE_DIR });
  assert.deepEqual(reconciled, { ok: true, settled: 1, deferred: 0 });
  const cleanup = await readCleanupState(facade, BASE_DIR, 'acme', 'alpha');
  assert.equal(cleanup.state.cleanup_status, 'complete');
  assert.deepEqual(cleanup.state.cleanup_target, { kind: 'absent' });
});
