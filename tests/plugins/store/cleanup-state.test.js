'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  buildCleanupState,
  writeCleanupState,
  readCleanupState,
  transitionCleanupState,
  cleanupStateDir,
} = require('../../../services/plugins/store/cleanup-state');

function state(overrides = {}) {
  return buildCleanupState({
    cleanupStatus: 'not_required',
    cleanupTarget: { kind: 'installed_disabled' },
    lifecycleEpoch: 1,
    commitEpoch: 0,
    cleanupDetail: { code: 'no-action', retryable: false },
    ...overrides,
  });
}

test('buildCleanupState produces a schema-valid record and throws on an invalid one', () => {
  const built = state();
  assert.equal(built.cleanup_status, 'not_required');
  assert.throws(() => buildCleanupState({
    cleanupStatus: 'not_a_real_status',
    cleanupTarget: { kind: 'installed_disabled' },
    lifecycleEpoch: 1,
    commitEpoch: 0,
    cleanupDetail: { code: 'no-action', retryable: false },
  }));
});

test('cleanupStateDir places the record under data/<publisher_id>/<plugin_id>/', () => {
  assert.equal(cleanupStateDir('plugins', 'acme-labs', 'widgets'), 'plugins/data/acme-labs/widgets');
});

test('writeCleanupState then readCleanupState round-trips the record', async () => {
  const facade = createMemoryFsFacade();
  const written = await writeCleanupState(facade, 'plugins', 'acme-labs', 'widgets', state());
  assert.equal(written.ok, true);
  const read = await readCleanupState(facade, 'plugins', 'acme-labs', 'widgets');
  assert.equal(read.ok, true);
  assert.deepEqual(read.state, written.state);
});

test('writeCleanupState itself refuses an epoch regression, without the caller opting in', async () => {
  const facade = createMemoryFsFacade();
  const newer = await writeCleanupState(facade, 'plugins', 'acme-labs', 'widgets', state({ commitEpoch: 6 }));
  assert.equal(newer.ok, true);

  // A delayed worker reporting on a since-superseded operation. It never calls
  // transitionCleanupState -- the durable path must stop it anyway.
  const stale = await writeCleanupState(facade, 'plugins', 'acme-labs', 'widgets', state({ commitEpoch: 5 }));
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'commit_epoch_regression');

  const read = await readCleanupState(facade, 'plugins', 'acme-labs', 'widgets');
  assert.equal(read.state.commit_epoch, 6, 'the newer record must survive the stale write');
});

test('writeCleanupState surfaces a corrupted existing record instead of overwriting it', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('plugins/data/acme-labs/widgets');
  await facade.writeFile('plugins/data/acme-labs/widgets/cleanup-state.json', '{not json');
  const written = await writeCleanupState(facade, 'plugins', 'acme-labs', 'widgets', state({ commitEpoch: 1 }));
  assert.equal(written.ok, false);
  assert.equal(written.reason, 'cleanup_state_corrupted');
});

test('readCleanupState reports not_found for a plugin with no cleanup record yet', async () => {
  const facade = createMemoryFsFacade();
  const read = await readCleanupState(facade, 'plugins', 'acme-labs', 'widgets');
  assert.deepEqual(read, { ok: false, reason: 'cleanup_state_not_found' });
});

test('readCleanupState reports corrupted for malformed JSON without throwing', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('plugins/data/acme-labs/widgets');
  await facade.writeFile('plugins/data/acme-labs/widgets/cleanup-state.json', '{not json');
  const read = await readCleanupState(facade, 'plugins', 'acme-labs', 'widgets');
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'cleanup_state_corrupted');
});

test('transitionCleanupState accepts a monotonic-or-equal commit_epoch and rejects regression', () => {
  const current = state({ commitEpoch: 5, lifecycleEpoch: 2 });
  const forward = transitionCleanupState(current, state({ commitEpoch: 6, lifecycleEpoch: 1, cleanupStatus: 'settling' }));
  assert.equal(forward.ok, true);

  const regressed = transitionCleanupState(current, state({ commitEpoch: 4, cleanupStatus: 'settling' }));
  assert.deepEqual(regressed, { ok: false, reason: 'commit_epoch_regression' });
});

test('transitionCleanupState rejects a lifecycle_epoch regression within the same commit_epoch', () => {
  const current = state({ commitEpoch: 5, lifecycleEpoch: 3 });
  const regressed = transitionCleanupState(current, state({ commitEpoch: 5, lifecycleEpoch: 2, cleanupStatus: 'settling' }));
  assert.deepEqual(regressed, { ok: false, reason: 'lifecycle_epoch_regression' });
});

test('transitionCleanupState never authorizes cleanup failure to look like a settled/complete state -- it only reports the transition, never touches authority', () => {
  const current = state({ commitEpoch: 5, lifecycleEpoch: 1 });
  const failed = transitionCleanupState(current, state({
    commitEpoch: 5,
    lifecycleEpoch: 1,
    cleanupStatus: 'termination_failed',
    cleanupTarget: { kind: 'installed_disabled' },
  }));
  assert.equal(failed.ok, true);
  assert.equal(failed.state.cleanup_status, 'termination_failed');
  // The module exposes no function that reads or writes an active pointer or
  // generation record -- this module has no import of active-pointer.js or
  // generation-store.js, so it structurally cannot promote authority.
  const cleanupStateModule = require('../../../services/plugins/store/cleanup-state');
  assert.equal('commitActivePointer' in cleanupStateModule, false);
  assert.equal('writeGeneration' in cleanupStateModule, false);
});
