'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSnapshotEntries, retainRunEntries } = require('../renderer/shell/renderer-diagnostics-view-state');

test('run-aware retention preserves prior evidence while trimming current informational rows', () => {
  const prior = Array.from({ length: 250 }, (_, index) => ({ run_id: 'prior', sequence: index + 1, level: 'INFO', event: `prior.${index}` }));
  const current = [
    { run_id: 'current', sequence: 1, level: 'ERROR', event: 'current.failure' },
    ...Array.from({ length: 760 }, (_, index) => ({ run_id: 'current', sequence: index + 2, level: 'INFO', event: `current.${index}` })),
  ];
  const retained = retainRunEntries(prior.concat(current), 'current', 'prior');
  assert.equal(retained.filter((entry) => entry.run_id === 'prior').length, 250);
  assert.equal(retained.filter((entry) => entry.run_id === 'current').length, 750);
  assert.ok(retained.some((entry) => entry.event === 'current.failure'));
});

test('snapshot merge preserves only uncommitted renderer origins and assigns them to the active run', () => {
  const snapshot = {
    active_run: { run_id: 'current' }, prior_run: { run_id: 'prior' },
    entries: [
      { entry_id: 'prior:1', run_id: 'prior', sequence: 1, source: 'renderer', event: 'prior.event' },
      { entry_id: 'current:1', run_id: 'current', sequence: 1, source: 'renderer', origin_entry_id: 'boot:committed', event: 'committed' },
    ],
  };
  const merged = mergeSnapshotEntries([
    { source: 'renderer', origin_entry_id: 'boot:pending', event: 'pending' },
    { source: 'renderer', origin_entry_id: 'boot:committed', event: 'duplicate' },
    { source: 'renderer', entry_id: 'legacy-canonical', event: 'must-not-duplicate' },
  ], snapshot);
  assert.equal(merged.filter((entry) => entry.origin_entry_id === 'boot:committed').length, 1);
  assert.equal(merged.some((entry) => entry.event === 'must-not-duplicate'), false);
  assert.equal(merged.find((entry) => entry.event === 'pending').run_id, 'current');
});
