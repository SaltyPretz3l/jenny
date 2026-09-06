'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSeededFacade } = require('../../helpers/plugins/memory-fs-facade');
const { RestrictedTokenService } = require('../../../services/plugins/restricted-host/token-service');
const { SecretHandleBroker } = require('../../../services/plugins/restricted-host/secret-handle-broker');
const {
  digestText,
  RestrictedCapabilityBroker,
} = require('../../../services/plugins/restricted-host/capability-broker');

function authority(overrides = {}) {
  return {
    publisher_id: 'acme-labs', plugin_id: 'restricted_tools', contribution_id: 'compute',
    artifact_digest: '1'.repeat(64), component_digest: '2'.repeat(64),
    generation_id: 'gen_1', commit_epoch: 1, lifecycle_epoch: 2, policy_revision: 3,
    process_instance_id: 'proc_1', channel_id: 'channel_1',
    workspace_incarnation_id: 'workspace_1', purpose: 'restricted_runtime',
    destination: 'https://api.example.test', invocation_id: 'inv_1',
    operation_id: 'op_1', cancellation_id: 'cancel_1', argument_hash: '3'.repeat(64),
    revocation_generation: 1, deadline_epoch_ms: Date.now() + 10000,
    capabilities: ['network.request'],
    ...overrides,
  };
}

function callFor(current, capability, payload) {
  const payloadJson = JSON.stringify(payload);
  return {
    call_schema_version: 4, call_id: 'call_1', invocation_id: current.invocation_id,
    operation_id: current.operation_id, cancellation_id: current.cancellation_id,
    process_instance_id: current.process_instance_id, channel_id: current.channel_id,
    commit_epoch: current.commit_epoch, lifecycle_epoch: current.lifecycle_epoch,
    capability, token_id: current.token_id, argument_digest: digestText(payloadJson),
    payload_json: payloadJson,
  };
}

async function consentFacade() {
  return createSeededFacade({
    'policy/network-consent.json': {
      network_consent_schema_version: 1, revision: 1, system_authorized: true,
      purpose_grants: [],
      plugin_consents: [{
        publisher_id: 'acme-labs', plugin_id: 'restricted_tools', purpose: 'plugin_runtime',
        scopes: ['internet'], destinations: ['https://api.example.test'], enabled: true,
      }],
    },
  });
}

test('network calls require exact signed origin, consent, token, and same-origin redirects', async () => {
  const tokenService = new RestrictedTokenService();
  const current = authority();
  const minted = tokenService.mint(current);
  assert.equal(minted.ok, true);
  current.token_id = minted.token_id;
  let brokerInput;
  const broker = new RestrictedCapabilityBroker({
    tokenService,
    secretHandleBroker: new SecretHandleBroker(),
    facade: await consentFacade(),
    networkBroker: {
      request: async (input) => {
        brokerInput = input;
        return { ok: true, status_code: 200, body: Buffer.from('bounded') };
      },
    },
  });
  const wrong = await broker.handle(callFor(current, 'network.request', {
    method: 'GET', url: 'https://other.example.test/v1', body_b64: '',
  }), current);
  assert.equal(wrong.reason, 'restricted_network_request_rejected');

  const result = await broker.handle(callFor(current, 'network.request', {
    method: 'GET', url: 'https://api.example.test/v1', body_b64: '',
  }), current);
  assert.deepEqual(result, {
    ok: true,
    payload: { status: 200, body_b64: Buffer.from('bounded').toString('base64') },
  });
  assert.equal(brokerInput.purpose, 'restricted_runtime');
  assert.equal(brokerInput.same_origin_redirects_only, true);
  assert.deepEqual(brokerInput.headers, undefined);
});

test('opaque secret handles execute an Electron-owned operation without returning secret bytes', async () => {
  const tokenService = new RestrictedTokenService();
  const secretHandleBroker = new SecretHandleBroker();
  const current = authority({ destination: '', capabilities: ['secret.use_handle'] });
  const minted = tokenService.mint(current);
  assert.equal(minted.ok, true);
  current.token_id = minted.token_id;
  let observed;
  const issued = secretHandleBroker.issue(current, async (request) => {
    observed = request.request_digest;
    return { ok: true, private_value: 'must-never-cross-the-broker' };
  });
  assert.equal(issued.ok, true);
  const broker = new RestrictedCapabilityBroker({
    tokenService, secretHandleBroker, facade: await consentFacade(), networkBroker: null,
  });
  const requestDigest = '4'.repeat(64);
  const result = await broker.handle(callFor(current, 'secret.use_handle', {
    handle: issued.handle, request_digest: requestDigest,
  }), current);
  assert.deepEqual(result, { ok: true, payload: { used: true } });
  assert.equal(observed, requestDigest);
  assert.equal(JSON.stringify(result).includes('must-never-cross'), false);
});
