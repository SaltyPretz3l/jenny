'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { RemoteMcpService } = require('../../../services/plugins/remote-mcp/remote-mcp-service');
const { remoteBinding, transportContext } = require('../../helpers/plugins/remote-mcp-fixtures');

function fakeTransportFactory(calls) {
  return () => ({
    async negotiate() { return { ok: true, protocol: '2026-07-28' }; },
    async call(method, params, options) {
      calls.push({ method, params, options });
      if (method === 'tools/list') return { ok: true, result: { tools: [{ name: 'search',
        inputSchema: { type: 'object', properties: {
          q: { type: 'string' }, region: { type: 'string', 'x-mcp-header': 'Region' },
        }, required: ['q'], additionalProperties: false } }] } };
      return { ok: true, result: { content: [{ type: 'text', text: 'ok' }] }, notifications: [] };
    },
  });
}

function invocationContext(binding, contribution) {
  return {
    binding,
    invocation: { binding_digest: binding.binding_digest,
      descriptor_digest: binding.descriptor_digest, namespaced_name: contribution.namespaced_name },
    current: { publisher_id: binding.publisher_id, plugin_id: binding.plugin_id,
      generation_id: binding.generation_id, artifact_digest: binding.artifact_digest,
      commit_epoch: binding.commit_epoch, lifecycle_state: 'active',
      activation_scope: 'stage5_remote_mcp' },
    policy: { stage5_enabled: true, consent_granted: true,
      consent_digest: binding.consent_digest, advisory_status: 'clear',
      authorization: 'none',
      revoked_artifact_digests: new Set(), revoked_descriptor_digests: new Set() },
    arguments: { q: 'hello', region: 'us-east1' }, context: transportContext(),
  };
}

test('service discovers active contributions and revalidates authority and arguments per call', async () => {
  const calls = [];
  const service = new RemoteMcpService({ facade: createMemoryFsFacade(),
    transportFactory: fakeTransportFactory(calls) });
  const discovered = await service.discover({
    bindingDraft: remoteBinding({ binding_digest: '0'.repeat(64), schema_digest: '0'.repeat(64) }),
    consent: {}, context: transportContext(),
  });
  assert.equal(discovered.ok, true);
  const input = invocationContext(discovered.binding, discovered.contributions[0]);
  const invoked = await service.invoke(input);
  assert.equal(invoked.ok, true);
  assert.equal(calls[1].method, 'tools/call');
  assert.equal(calls[1].options.extraHeaders['Mcp-Param-Region'], 'us-east1');
  assert.equal(invoked.provenance.binding_digest, discovered.binding.binding_digest);
  assert.match(invoked.provenance.response_digest, /^[0-9a-f]{64}$/);

  input.arguments.extra = true;
  assert.equal((await service.invoke(input)).reason, 'arguments_schema_invalid');
  input.arguments = { q: 'hello' };
  input.current.commit_epoch += 1;
  assert.equal((await service.invoke(input)).reason, 'remote_generation_stale');
  service.dispose();
  assert.equal((await service.invoke(input)).reason, 'remote_service_disposed');
});

test('restart requires rediscovery and never trusts persisted binding alone', async () => {
  const restarted = new RemoteMcpService({ facade: createMemoryFsFacade(),
    transportFactory: fakeTransportFactory([]) });
  const binding = remoteBinding();
  const input = invocationContext(binding, { namespaced_name: 'plugin:remote:server:tool:search:x' });
  assert.equal((await restarted.invoke(input)).reason, 'remote_descriptor_rediscovery_required');
});

test('disposing during discovery aborts compilation without caching a descriptor', async () => {
  let releaseNegotiation;
  let receivedSignal;
  let writes = 0;
  const negotiation = new Promise((resolve) => { releaseNegotiation = resolve; });
  const facade = createMemoryFsFacade();
  const writeFile = facade.writeFile.bind(facade);
  facade.writeFile = async (...args) => { writes += 1; return writeFile(...args); };
  const service = new RemoteMcpService({ facade,
    transportFactory: ({ context }) => {
      receivedSignal = context.signal;
      return {
        negotiate: () => negotiation,
        call: async () => ({ ok: true, result: { tools: [] } }),
      };
    } });
  const pending = service.discover({
    bindingDraft: remoteBinding({ binding_digest: '0'.repeat(64), schema_digest: '0'.repeat(64) }),
    consent: {}, context: transportContext(),
  });
  service.dispose();
  assert.equal(receivedSignal.aborted, true);
  releaseNegotiation({ ok: true, protocol: '2026-07-28' });

  assert.equal((await pending).reason, 'remote_service_disposed');
  assert.equal(service._descriptors.size, 0);
  assert.equal(writes, 0);
});

test('name lookup prefers the latest descriptor and can filter committed bindings', () => {
  const service = new RemoteMcpService({ scheduler: { dispose() {} } });
  const row = (bindingDigest) => ({
    binding: { binding_digest: bindingDigest },
    runtime_binding: { contributions: [{ namespaced_name: 'plugin:p:c:tool:x' }] },
  });
  service._descriptors.set('old', row('old'));
  service._descriptors.set('new', row('new'));

  assert.equal(service.descriptorForName('plugin:p:c:tool:x').binding.binding_digest, 'new');
  assert.equal(service.descriptorForName(
    'plugin:p:c:tool:x', new Set(['old'])
  ).binding.binding_digest, 'old');
});
