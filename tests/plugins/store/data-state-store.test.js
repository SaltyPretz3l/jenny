'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { writeDataState, readDataState } = require('../../../services/plugins/store/data-state-store');
function state(sequence = 0) { return { publisher_id: 'publisher', plugin_id: 'plugin', data_domain_id: 'primary', data_schema_version: 1, data_generation_id: 'g1', migration_executor_tier: 'declarative', mutation_watermark: { sequence, recorded_at: '2026-08-04T00:00:00Z' }, rollback_barrier: { kind: 'none' }, snapshot_references: [] }; }
test('data state is versioned and rejects watermark rollback', async () => {
  const fs = new MemoryFsFacade(); assert.equal((await writeDataState(fs, 's', state(2))).ok, true);
  assert.equal((await writeDataState(fs, 's', state(1))).reason, 'data_state_watermark_rollback');
  assert.equal((await readDataState(fs, 's', { publisherId: 'publisher', pluginId: 'plugin' })).state.mutation_watermark.sequence, 2);
});
