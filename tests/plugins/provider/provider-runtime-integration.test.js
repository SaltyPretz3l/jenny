'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PluginProviderRuntimeIntegration } = require('../../../services/plugins/provider/provider-runtime-integration');

test('provider descriptors are epoch-bound and stale authority fails closed', async () => {
  const runtime = new PluginProviderRuntimeIntegration();
  const descriptor = { provider_id: 'chatgpt', engine_type: 'chatgpt' };
  const prepared = runtime.prepare({ snapshot: { runtime_schema_version: 5,
    active_generation_id: 'generation_1', commit_epoch: 8 }, provider_descriptor_values: [descriptor] });
  assert.equal(prepared.ok, true);
  await runtime.commit(prepared.prepared);
  assert.equal(runtime.resolve('chatgpt', { generation_id: 'generation_1', commit_epoch: 8 }), descriptor);
  assert.equal(runtime.resolve('chatgpt', { generation_id: 'generation_1', commit_epoch: 7 }), null);
});

test('legacy and V6 generations prepare while future versions reject', () => {
  const runtime = new PluginProviderRuntimeIntegration();
  assert.equal(runtime.prepare({ snapshot: { runtime_schema_version: 4,
    active_generation_id: 'generation_legacy', commit_epoch: 2 } }).prepared.descriptors.size, 0);
  assert.equal(runtime.prepare({ snapshot: { runtime_schema_version: 6 } }).ok, true);
  assert.equal(runtime.prepare({ snapshot: { runtime_schema_version: 7 } }).reason,
    'provider_runtime_snapshot_invalid');
});

test('provider reconfiguration failure degrades only the provider participant', async () => {
  const logs = [];
  const runtime = new PluginProviderRuntimeIntegration({
    onChanged: async () => { throw new Error('offline'); },
    log: (event, data) => logs.push([event, data]),
  });
  const prepared = runtime.prepare({ snapshot: { runtime_schema_version: 5,
    active_generation_id: 'generation_1', commit_epoch: 1 }, provider_descriptor_values: [] });
  assert.deepEqual(await runtime.commit(prepared.prepared), { ok: true, degraded: true });
  assert.equal(logs[0][0], 'plugin.provider.reconfigure_failed');
});
