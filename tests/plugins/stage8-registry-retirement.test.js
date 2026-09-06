'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionProviderManager } = require(
  '../../services/plugins/full-host/session-provider-manager',
);
const { NativeMcpRuntimeRegistry } = require(
  '../../services/plugins/native-mcp/runtime-registry',
);
const { createStage8ControlPlane } = require('../../services/plugins/stage8-control-plane');

test('repeated privileged generations retain only the current registry authority', async () => {
  const nativeMcpRegistry = new NativeMcpRuntimeRegistry();
  const sessionProviders = new SessionProviderManager();
  const revoked = [];
  const plane = createStage8ControlPlane({
    enabled: true,
    runtimeCoordinator: {
      prepare: async () => ({ ok: true, commit: async () => ({ ok: true }) }),
      getState: () => ({}),
    },
    sessionManager: {
      revokeGeneration: async (generationId) => { revoked.push(generationId); },
      snapshot: () => ({ active: 0, pending: 0 }),
    },
    nativeMcpRegistry,
    sessionProviders,
  });

  for (let generation = 1; generation <= 1000; generation += 1) {
    const prepared = await plane.runtimeCoordinator.prepare({ compiled: {
      snapshot: {
        active_generation_id: `generation-${generation}`,
        commit_epoch: generation,
        registry_revision: generation,
        dependency_graph_hash: 'a'.repeat(64),
      },
      privileged: {},
    } });
    assert.equal((await prepared.commit()).ok, true);
  }

  assert.equal(nativeMcpRegistry._bindings.size, 1);
  assert.equal(sessionProviders._bindings.size, 1);
  assert.equal([...nativeMcpRegistry._bindings.keys()][0].startsWith('generation-1000\0'), true);
  assert.equal([...sessionProviders._bindings.keys()][0].startsWith('generation-1000\0'), true);
  assert.equal(revoked.length, 999);
});
