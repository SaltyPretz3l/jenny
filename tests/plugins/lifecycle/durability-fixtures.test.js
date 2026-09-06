'use strict';

// Pins the durability corpora under tests/fixtures/plugins/durability/ against
// the live system.
//
// These fixtures are not inputs -- the suites generate their own data. They are
// GOLDEN RECORDS of the two things a reader cannot otherwise see at a glance:
// exactly which durability boundaries the crash sweep covers, and exactly what
// shape the lifecycle model has. Their job is to make a silent change loud: add
// a durability step to the commit recipe, or an edge to the state table, and
// this suite fails and forces the change to be acknowledged rather than
// quietly shrinking or reshaping coverage.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createCrashInjectingFs } = require('../../helpers/plugins/crash-injecting-fs');
const { makeStoreFactory, commitOperation } = require('../../helpers/plugins/durability-scenario');
const { bfsWalks, firstReachedDepth, randomTransitionPlan } = require('../../helpers/plugins/lifecycle-explorer');
const { STATES, TRANSITIONS } = require('../../../services/plugins/lifecycle/state-machine');

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixtures', 'plugins', 'durability');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

// Mirrors the role classification the catalog was generated with. Kept here
// rather than in a helper because the catalog's whole value is being an
// independent second statement of the recipe -- deriving both sides from one
// shared function would let them drift together.
function roleFor(filePath) {
  if (filePath.includes('mutation-lease')) return 'mutation_lease';
  if (filePath.includes('operations/')) return 'operation_receipt';
  if (filePath.includes('control-plane')) return 'generation_record';
  if (filePath.includes('active-generation.prior')) return 'retained_prior_pointer';
  if (filePath.includes('active-generation.json')) return 'active_pointer';
  if (filePath.includes('journal.jsonl')) return 'journal_evidence';
  if (filePath.includes('audit.jsonl')) return 'audit_evidence';
  return 'directory';
}

test('the crash-point catalog matches the live commit recipe exactly', async () => {
  const catalog = loadFixture('crash-point-catalog.json');
  const build = makeStoreFactory({ priorCommits: catalog.prior_commits });
  const { facade, baseDir } = await build();
  const probe = createCrashInjectingFs(facade);
  await commitOperation('gen-target')(probe, baseDir);

  const observed = probe.calls
    .filter((call) => call.mutating)
    .map((call) => ({ point: call.point, method: call.method, role: roleFor(call.path) }));

  assert.equal(observed.length, catalog.total_points, 'the number of durability boundaries changed');
  assert.deepEqual(observed, catalog.points, 'the commit recipe’s durability boundaries changed');
});

test('every authority-bearing file is represented in the crash catalog', () => {
  const catalog = loadFixture('crash-point-catalog.json');
  const roles = new Set(catalog.points.map((entry) => entry.role));
  // If a durability-relevant file stopped being written, the sweep would still
  // pass while silently no longer covering it.
  for (const required of [
    'mutation_lease',
    'operation_receipt',
    'generation_record',
    'retained_prior_pointer',
    'active_pointer',
    'journal_evidence',
    'audit_evidence',
  ]) {
    assert.ok(roles.has(required), `no crash point covers ${required}`);
  }
});

test('the active pointer is written after the generation record it names', () => {
  // Ordering is the crash-safety argument itself: bytes first, authority last.
  const catalog = loadFixture('crash-point-catalog.json');
  const firstPointer = catalog.points.find((entry) => entry.role === 'active_pointer').point;
  const lastGeneration = catalog.points.filter((entry) => entry.role === 'generation_record').at(-1).point;
  const firstReceipt = catalog.points.find((entry) => entry.role === 'operation_receipt').point;

  assert.ok(lastGeneration < firstPointer, 'the generation must be durable before the pointer commits');
  assert.ok(firstReceipt < firstPointer, 'the pending receipt must exist before any authority-bearing effect');
});

test('evidence writes come after the pointer commit, never before', () => {
  const catalog = loadFixture('crash-point-catalog.json');
  const lastPointer = catalog.points.filter((entry) => entry.role === 'active_pointer').at(-1).point;
  for (const role of ['journal_evidence', 'audit_evidence']) {
    const first = catalog.points.find((entry) => entry.role === role).point;
    assert.ok(first > lastPointer, `${role} must be appended after the pointer commits, not before`);
  }
});

test('the lifecycle model golden matches the live state machine', () => {
  const golden = loadFixture('lifecycle-model.json');

  assert.deepEqual(STATES.slice().sort(), golden.states, 'the state set changed');

  const edges = [];
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) edges.push(`${from}->${to}`);
  }
  assert.deepEqual(edges.sort(), golden.edges, 'the transition table changed');
  assert.equal(edges.length, golden.edge_count);

  assert.deepEqual(
    Object.fromEntries([...firstReachedDepth('absent').entries()].sort()),
    golden.first_reached_depth_from_absent,
    'reachability depths changed'
  );

  for (const [depth, expected] of Object.entries(golden.walk_counts_by_depth)) {
    assert.equal(bfsWalks('absent', Number(depth)).length, expected, `walk count at depth ${depth} changed`);
  }
});

test('seeded walks still terminate where the golden says they do', () => {
  const golden = loadFixture('lifecycle-model.json');
  for (const [seed, expected] of Object.entries(golden.seeded_walk_final_states)) {
    const actual = randomTransitionPlan({ seed: Number(seed), steps: 200 }).finalState;
    assert.equal(actual, expected, `seed ${seed} now terminates at ${actual}, not ${expected}`);
  }
});
