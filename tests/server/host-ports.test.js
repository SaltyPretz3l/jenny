'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHostPorts, validateHostPortConfig } = require('../../services/host/host-ports');
const credentials = { get: () => '', getStatus: () => ({ ready: true }) };

test('default desktop preserves managed engines; hosted engines are externally managed', () => {
  const desktop = createHostPorts();
  assert.equal(desktop.mode, 'desktop');
  assert.equal(desktop.posture.ownsEngineLifecycle, true);
  const host = createHostPorts({ hostMode: 'server', credentialService: credentials });
  assert.equal(host.mode, 'server');
  assert.equal(host.engineLifecycle, 'external');
  assert.equal(host.posture.ownsEngineLifecycle, false);
  assert.equal(host.credentialService.getStatus().ready, true);
  assert.equal(Object.isFrozen(host), true);
  assert.equal(Object.isFrozen(host.posture), true);
});

test('invalid host choices and ambiguous aliases never fall back to desktop', () => {
  for (const input of [null, [], { hostMode: null }, { hostMode: 'container' },
    { mode: undefined, host_mode: 'server' }, { hostMode: 'desktop', mode: 'server' }]) {
    assert.equal(validateHostPortConfig(input).ok, false);
  }
});

test('credential port matches mandatory backend reads and fails closed at construction', () => {
  assert.equal(validateHostPortConfig({ hostMode: 'server' }).reason, 'credential_service_required');
  assert.equal(validateHostPortConfig({ hostMode: 'server', credentialService: { get: () => '' } }).reason,
    'invalid_credential_service');
  assert.throws(() => createHostPorts({ hostMode: 'server' }), (error) =>
    error.code === 'CMP-HOST-0001' && error.reason === 'credential_service_required');
});
