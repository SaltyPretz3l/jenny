'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DesktopSandboxService } = require('../../services/execution/desktop-sandbox-service');

function fixture(backend = {}) {
  const changes = [];
  const service = new DesktopSandboxService({
    userDataPath: '/unused-runtime-sandbox-profile',
    sourceRoot: '/unused-runtime-sandbox-source',
    configService: {
      getState: () => ({ commandSandbox: { enabled: false } }),
      updateCommandSandbox: patch => changes.push(patch),
    },
    getBackend: () => backend,
  });
  service._reconcile = async () => {};
  service._prepare = async () => service._publish('ready');
  service._resources = async () => {};
  return { service, changes };
}

test('sandbox settings require positive runtime quiescence before changing policy', async () => {
  for (const runtime of [
    { hasPendingOrAdmittedWork: () => true },
    {},
    { hasPendingOrAdmittedWork: () => undefined },
    { hasPendingOrAdmittedWork: () => { throw new Error('unavailable'); } },
  ]) {
    const { service, changes } = fixture({ activeStreams: new Map(), sessionRuntime: runtime });
    await assert.rejects(service.setEnabled({ enabled: true }),
      error => error.reason === 'sandbox_wait_for_active_chats');
    assert.deepEqual(changes, []);
    assert.equal(service.generation, 0);
    assert.equal(service.transition, null);
  }
  const { service, changes } = fixture({ sessionRuntime: { hasPendingOrAdmittedWork: () => false } });
  assert.equal((await service.setEnabled({ enabled: true })).state, 'ready');
  assert.deepEqual(changes, [{ enabled: true }]);
});

test('sandbox transition barrier exists before configuration and event reentrancy', async () => {
  const { service } = fixture();
  const attempts = [];
  service.on('changed', () => {
    assert.ok(service.transition);
    attempts.push(assert.rejects(service.setEnabled({ enabled: false }),
      error => error.reason === 'sandbox_wait_for_active_chats'));
    attempts.push(assert.rejects(service.execute({}, {}, () => {}),
      error => error.reason === 'sandbox_unavailable'));
  });
  const pending = service.setEnabled({ enabled: true });
  assert.ok(service.transition);
  await pending;
  await Promise.all(attempts);
  assert.equal(service.transition, null);
  assert.equal(service.enabled, true);
});

test('sandbox recovery installs its barrier while paused runtime evidence remains inspectable', async () => {
  const { service, changes } = fixture({ sessionRuntime: { hasPendingOrAdmittedWork: () => true } });
  service.on('changed', () => assert.ok(service.transition));
  const recovery = service.retry();
  assert.ok(service.transition);
  assert.equal((await recovery).state, 'disabled');
  assert.equal(service.transition, null);
  assert.deepEqual(changes, []);
});
