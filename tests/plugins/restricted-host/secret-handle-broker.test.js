'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_HANDLES,
  SecretHandleBroker,
} = require('../../../services/plugins/restricted-host/secret-handle-broker');

function authority(overrides = {}) {
  return {
    publisher_id: 'acme-labs', plugin_id: 'widgets', contribution_id: 'compute',
    artifact_digest: '1'.repeat(64), component_digest: '2'.repeat(64),
    generation_id: 'gen-1', commit_epoch: 1, lifecycle_epoch: 2,
    ...overrides,
  };
}

test('opaque handles bind exact authority, expire, and reject replay', async () => {
  let now = 0;
  let nonce = 1;
  const broker = new SecretHandleBroker({
    now: () => now,
    randomBytes: () => Buffer.alloc(24, nonce++),
  });
  const current = authority();
  const wrong = broker.issue({ ...current, component_digest: 'invalid' }, async () => ({ ok: true }));
  assert.equal(wrong.reason, 'secret_handle_issue_rejected');

  const issued = broker.issue(current, async () => ({
    ok: true, secret_value: 'must-not-cross',
  }), { lifetimeMs: 10, uses: 1 });
  assert.equal(issued.ok, true);
  assert.equal((await broker.use(issued.handle, '3'.repeat(64), {
    ...current, commit_epoch: 2,
  })).reason, 'secret_handle_unknown_or_stale');
  assert.deepEqual(await broker.use(issued.handle, '3'.repeat(64), current), {
    ok: true, used: true,
  });
  assert.equal((await broker.use(issued.handle, '3'.repeat(64), current)).reason,
    'secret_handle_unknown_or_stale');

  const expiring = broker.issue(current, async () => ({ ok: true }), { lifetimeMs: 10 });
  now = 10;
  assert.equal((await broker.use(expiring.handle, '4'.repeat(64), current)).reason,
    'secret_handle_expired');
});

test('a failed Electron-owned operation still spends the bounded handle use', async () => {
  const broker = new SecretHandleBroker({ randomBytes: () => Buffer.alloc(24, 9) });
  const current = authority();
  const issued = broker.issue(current, async () => {
    throw new Error('private failure with secret bytes');
  });
  assert.equal((await broker.use(issued.handle, '3'.repeat(64), current)).reason,
    'secret_handle_operation_failed');
  assert.equal((await broker.use(issued.handle, '3'.repeat(64), current)).reason,
    'secret_handle_unknown_or_stale');
});

test('generation revocation invalidates all matching handles', async () => {
  let nonce = 10;
  const broker = new SecretHandleBroker({ randomBytes: () => Buffer.alloc(24, nonce++) });
  const first = broker.issue(authority(), async () => ({ ok: true }));
  const secondAuthority = authority({ generation_id: 'gen-2' });
  const second = broker.issue(secondAuthority, async () => ({ ok: true }));
  assert.equal(broker.revokeGeneration('gen-1'), 1);
  assert.equal((await broker.use(first.handle, '3'.repeat(64), authority())).reason,
    'secret_handle_unknown_or_stale');
  assert.equal((await broker.use(second.handle, '3'.repeat(64), secondAuthority)).ok, true);
});

test('expired handles are purged before enforcing issue capacity', () => {
  let now = 0;
  let nonce = 0;
  const broker = new SecretHandleBroker({
    now: () => now,
    randomBytes: () => {
      const bytes = Buffer.alloc(24);
      bytes.writeUInt32BE(nonce++);
      return bytes;
    },
  });
  for (let index = 0; index < MAX_HANDLES; index += 1) {
    assert.equal(broker.issue(authority(), async () => ({ ok: true }),
      { lifetimeMs: 1 }).ok, true);
  }
  now = 2;

  assert.equal(broker.issue(authority(), async () => ({ ok: true }),
    { lifetimeMs: 1 }).ok, true);
  assert.deepEqual(broker.snapshot(), { active_handles: 1 });
});
