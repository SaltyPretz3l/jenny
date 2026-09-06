'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  createEmptyDistributionState,
  readDistributionState,
  writeDistributionState,
} = require('../../../services/plugins/store/distribution-state-store');

const NOW = '2026-08-04T20:00:00Z';
const NEXT = '2026-08-04T20:01:00Z';

function catalog(overrides = {}) {
  return {
    catalog_id: 'official', root_version: 1, root_digest: '1'.repeat(64),
    timestamp_version: 1, timestamp_digest: '2'.repeat(64),
    snapshot_version: 1, snapshot_digest: '3'.repeat(64),
    targets_version: 1, targets_digest: '4'.repeat(64),
    last_update_started_at: NOW, last_verified_at: NOW,
    ...overrides,
  };
}

test('distribution state is atomic, canonical, and revision guarded', async () => {
  const facade = createMemoryFsFacade();
  const initial = createEmptyDistributionState(NOW);
  assert.equal((await writeDistributionState(facade, 'plugins', initial, { expectedRevision: -1 })).ok, true);
  const next = { ...initial, revision: 1, updated_at: NEXT, catalogs: [catalog()] };
  assert.equal((await writeDistributionState(facade, 'plugins', next, { expectedRevision: 0 })).ok, true);
  const read = await readDistributionState(facade, 'plugins');
  assert.equal(read.state.catalogs[0].catalog_id, 'official');
  assert.equal((await writeDistributionState(facade, 'plugins', { ...next, revision: 2 }, {
    expectedRevision: 0,
  })).reason, 'distribution_state_revision_conflict');
});

test('distribution state rejects TUF rollback and contradictory equal-version bytes', async () => {
  const facade = createMemoryFsFacade();
  const initial = { ...createEmptyDistributionState(NOW), catalogs: [catalog()] };
  assert.equal((await writeDistributionState(facade, '', initial, { expectedRevision: -1 })).ok, true);
  const rollback = {
    ...initial, revision: 1, updated_at: NEXT,
    catalogs: [catalog({ timestamp_version: 0 })],
  };
  assert.equal((await writeDistributionState(facade, '', rollback)).reason, 'distribution_state_invalid');
  const conflict = {
    ...initial, revision: 1, updated_at: NEXT,
    catalogs: [catalog({ timestamp_digest: '9'.repeat(64) })],
  };
  const result = await writeDistributionState(facade, '', conflict);
  assert.equal(result.reason, 'distribution_state_regression');
  assert.match(result.detail, /timestamp_digest_conflict/);
  const removed = await writeDistributionState(facade, '', {
    ...initial, revision: 1, updated_at: NEXT, catalogs: [],
  });
  assert.equal(removed.reason, 'distribution_state_regression');
  assert.equal(removed.detail, 'official:catalog_removed');
});

test('malformed distribution state fails closed instead of becoming absence', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('distribution');
  await facade.writeFile('distribution/state.json', '{');
  assert.equal((await readDistributionState(facade, '')).reason, 'distribution_state_corrupted');
});
