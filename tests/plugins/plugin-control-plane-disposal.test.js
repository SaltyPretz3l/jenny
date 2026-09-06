'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createPluginControlPlaneService,
} = require('../../services/plugins/plugin-control-plane-service');
const { createMemoryFsFacade } = require('../../services/plugins/store/fs-facade');
const { readCommittedState } = require('../../services/plugins/lifecycle/commit-sequence');
const { createVerifiedPackageVerifier } = require('../helpers/plugins/durability-scenario');

const NOW = '2026-07-31T00:00:00Z';

function totalFacadeCalls(facade) {
  return Object.values(facade.callCounts).reduce((sum, count) => sum + count, 0);
}

test('disposing during verification fences settlement and receipt compaction', async () => {
  const facade = createMemoryFsFacade();
  let releaseVerifier;
  let markVerifierStarted;
  const verifierStarted = new Promise((resolve) => { markVerifierStarted = resolve; });
  const verifierResult = new Promise((resolve) => { releaseVerifier = resolve; });
  const service = createPluginControlPlaneService({
    facade,
    baseDir: '',
    featureEnabled: true,
    safeMode: { active: false, source: 'none' },
    now: () => NOW,
    readPackageBytes: async () => ({
      ok: true,
      bytes: 'bytes:alpha',
      sourcePathDigest: 'a'.repeat(64),
    }),
    verifyPackage: async () => {
      markVerifierStarted();
      return verifierResult;
    },
    newOperationId: () => 'op-disposed',
  });

  const pending = service.installLocalPackage({});
  await verifierStarted;
  const callsAtDispose = totalFacadeCalls(facade);
  service.dispose();
  releaseVerifier({ ok: true });

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'operation_canceled');
  assert.equal(totalFacadeCalls(facade), callsAtDispose);
});

test('disposing during uninstall consent prevents authority mutation', async () => {
  const facade = createMemoryFsFacade();
  let operationIndex = 0;
  let releaseUninstallConsent;
  let markUninstallConsentStarted;
  const uninstallConsentStarted = new Promise((resolve) => { markUninstallConsentStarted = resolve; });
  const uninstallConsent = new Promise((resolve) => { releaseUninstallConsent = resolve; });
  const service = createPluginControlPlaneService({
    facade,
    baseDir: '',
    featureEnabled: true,
    safeMode: { active: false, source: 'none' },
    now: () => NOW,
    readPackageBytes: async () => ({
      ok: true,
      bytes: 'bytes:alpha',
      sourcePathDigest: 'a'.repeat(64),
    }),
    verifyPackage: createVerifiedPackageVerifier({ publisherId: 'acme', pluginId: 'alpha', now: NOW }),
    requireConsent: async ({ operation }) => {
      if (operation === 'install') return { ok: true };
      markUninstallConsentStarted();
      return uninstallConsent;
    },
    newOperationId: () => `op-disposal-${++operationIndex}`,
  });
  const installed = await service.installLocalPackage({});
  assert.equal(installed.ok, true, installed.reason || 'setup install failed');

  const pending = service.uninstall({ publisher_id: 'acme', plugin_id: 'alpha' });
  await uninstallConsentStarted;
  const callsAtDispose = totalFacadeCalls(facade);
  service.dispose();
  releaseUninstallConsent({ ok: true });

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'operation_canceled');
  assert.equal(totalFacadeCalls(facade), callsAtDispose);
  const state = await readCommittedState(facade, '');
  assert.equal(state.generation.plugins[0].effective_state, 'installed_disabled');
});
