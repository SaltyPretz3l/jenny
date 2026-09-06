'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const vm = require('node:vm');
const { compileJsonSchema } = require('../../../services/plugins/remote-mcp/json-schema-validator');
const {
  RestrictedInvocationController,
} = require('../../../services/plugins/restricted-host/invocation-controller');

function descriptor(overrides = {}) {
  return {
    publisher_id: 'acme-labs',
    plugin_id: 'restricted_tools',
    contribution_id: 'compute',
    artifact_digest: '1'.repeat(64),
    component_digest: '2'.repeat(64),
    generation_id: 'gen_1',
    commit_epoch: 1,
    lifecycle_epoch: 2,
    policy_revision: 3,
    workspace_incarnation_id: 'workspace_1',
    timeout_ms: 1000,
    network_origins: [],
    capabilities: ['control.cancelled'],
    compiled_input_schema: compileJsonSchema({ type: 'object' }),
    compiled_output_schema: compileJsonSchema({ type: 'object' }),
    ...overrides,
  };
}

function currentFor(source, invocation) {
  return {
    ...source,
    lifecycle_state: 'active',
    stage6_enabled: true,
    revoked: false,
    quarantined: false,
    revocation_generation: 1,
    argument_hash: invocation.argument_hash,
  };
}

test('canonical argument serialization accepts JSON objects from another realm', async () => {
  let invokedInput;
  const host = {
    process_instance_id: 'proc_1',
    channel_id: 'channel_1',
    invoke: async (input) => {
      invokedInput = input;
      return { ok: true, status: 'succeeded', result_json: '{}' };
    },
  };
  const controller = new RestrictedInvocationController({
    hostPool: { acquire: async () => ({ ok: true, host }), invalidate: async () => {} },
    tokenService: { mint: () => ({ ok: true, token_id: 'a'.repeat(64) }),
      revokeInvocation() {}, clear() {} },
    getCurrentAuthority: (candidate, invocation) => currentFor(candidate, invocation),
  });
  const result = await controller.invoke(descriptor(), vm.runInNewContext('({ x: 1 })'));
  assert.equal(result.ok, true);
  assert.equal(invokedInput, '{"x":1}');
});

test('an already-aborted invocation settles without entering the queue or host pool', async () => {
  const abort = new AbortController();
  abort.abort();
  let acquired = false;
  const controller = new RestrictedInvocationController({
    hostPool: { acquire: async () => { acquired = true; throw new Error('unexpected'); } },
    tokenService: { clear() {}, revokeInvocation() {} },
    getCurrentAuthority: currentFor,
  });
  const result = await controller.invoke(descriptor(), {}, { signal: abort.signal });
  assert.deepEqual(result, {
    ok: false,
    code: 'CMP-PLUGIN-0034',
    reason: 'operation_cancelled',
    retryable: false,
  });
  assert.equal(acquired, false);
  assert.deepEqual(controller.snapshot(), { active: 0, queued: 0 });
});

test('host authority is bound to the signed destination and absolute deadline', async () => {
  const source = descriptor({
    network_origins: ['https://api.example.test'],
    capabilities: ['network.request'],
  });
  let mintedAuthority;
  let invokedAuthority;
  const host = {
    process_instance_id: 'proc_1',
    channel_id: 'channel_1',
    invoke: async (_input, _timeout, authority) => {
      invokedAuthority = authority;
      return { ok: true, status: 'succeeded', result_json: '{}' };
    },
  };
  const controller = new RestrictedInvocationController({
    hostPool: { acquire: async () => ({ ok: true, host }), invalidate: async () => {} },
    tokenService: {
      mint: (authority) => { mintedAuthority = authority; return { ok: true, token_id: 'a'.repeat(64) }; },
      revokeInvocation() {}, clear() {},
    },
    getCurrentAuthority: (candidate, invocation) => currentFor(candidate, invocation),
  });
  const before = Date.now();
  const result = await controller.invoke(source, {});
  assert.equal(result.ok, true);
  assert.equal(mintedAuthority.destination, 'https://api.example.test');
  assert.equal(mintedAuthority.purpose, 'restricted_runtime');
  assert.ok(mintedAuthority.deadline_epoch_ms >= before + 900);
  assert.equal(invokedAuthority.token_id, 'a'.repeat(64));
  assert.equal(invokedAuthority.destination, mintedAuthority.destination);
  assert.equal(invokedAuthority.deadline_epoch_ms, mintedAuthority.deadline_epoch_ms);
});

test('cancellation that races a successful host terminal can never settle as success', async () => {
  const abort = new AbortController();
  let cancelledHost = false;
  const host = {
    process_instance_id: 'proc_1',
    channel_id: 'channel_1',
    cancel: () => { cancelledHost = true; },
    invoke: async () => {
      abort.abort();
      return { ok: true, status: 'succeeded', result_json: '{}' };
    },
  };
  const controller = new RestrictedInvocationController({
    hostPool: { acquire: async () => ({ ok: true, host }), invalidate: async () => {} },
    tokenService: {
      mint: () => ({ ok: true, token_id: 'a'.repeat(64) }),
      revokeInvocation() {}, clear() {},
    },
    getCurrentAuthority: (candidate, invocation) => currentFor(candidate, invocation),
  });

  const result = await controller.invoke(descriptor(), {}, { signal: abort.signal });
  assert.equal(cancelledHost, true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'operation_cancelled');
});

test('authority is revalidated after asynchronous host acquisition', async () => {
  let authorityReads = 0;
  let invalidated = 0;
  let minted = false;
  let invoked = false;
  const host = {
    process_instance_id: 'proc_1',
    channel_id: 'channel_1',
    invoke: async () => { invoked = true; return { ok: true, status: 'succeeded', result_json: '{}' }; },
  };
  const controller = new RestrictedInvocationController({
    hostPool: {
      acquire: async () => ({ ok: true, host }),
      invalidate: async () => { invalidated += 1; },
    },
    tokenService: {
      mint: () => { minted = true; return { ok: true, token_id: 'a'.repeat(64) }; },
      revokeInvocation() {}, clear() {},
    },
    getCurrentAuthority: (candidate, invocation) => {
      authorityReads += 1;
      return authorityReads === 1
        ? currentFor(candidate, invocation)
        : { ...currentFor(candidate, invocation), lifecycle_state: 'installed_disabled' };
    },
  });

  const result = await controller.invoke(descriptor(), {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'restricted_contribution_inactive');
  assert.equal(authorityReads, 2);
  assert.equal(invalidated, 1);
  assert.equal(minted, false);
  assert.equal(invoked, false);
});

test('disposing queued invocations removes their abort listeners', async () => {
  const abort = new AbortController();
  const controller = new RestrictedInvocationController({
    hostPool: { dispose: async () => {} },
    tokenService: { clear() {} },
    getCurrentAuthority: async () => ({}),
  });
  controller._active.set(Symbol('held'), { key: 'acme-labs\0restricted_tools\0compute' });
  const pending = controller.invoke(descriptor(), {}, { signal: abort.signal });
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1);

  await controller.dispose();

  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  assert.equal((await pending).reason, 'operation_cancelled');
});
