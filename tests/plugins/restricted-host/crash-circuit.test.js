'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CrashCircuit } = require('../../../services/plugins/restricted-host/crash-circuit');

test('three unexpected crashes open a contribution-and-epoch circuit while expected exits do not count', () => {
  let now = 0;
  const circuit = new CrashCircuit({ now: () => now });
  const identity = { contribution_id: 'compute', artifact_digest: 'a', component_digest: 'b', commit_epoch: 1 };
  assert.equal(circuit.record(identity, { expected: true }).crash_count, 0);
  assert.deepEqual([circuit.record(identity), circuit.record(identity), circuit.record(identity)].map((item) => item.open), [false, false, true]);
  assert.equal(circuit.isOpen(identity), true);
  now = 10 * 60 * 1000 + 1;
  assert.equal(circuit.isOpen(identity), false);
});

test('record and lookup sweep expired crash histories for every identity', () => {
  let now = 0;
  const circuit = new CrashCircuit({ now: () => now });
  for (let index = 0; index < 100; index += 1) {
    circuit.record({ contribution_id: 'compute', artifact_digest: `artifact-${index}`,
      component_digest: 'component', commit_epoch: index });
  }
  now = 10 * 60 * 1000 + 1;
  circuit.isOpen({ contribution_id: 'other', artifact_digest: 'artifact',
    component_digest: 'component', commit_epoch: 0 });
  assert.equal(circuit._crashes.size, 0);
});
