'use strict';
// SPEC: Workspace Test Runner P0 — S4 (Architecture/Reliability): config parse.
// Configs read via the service parse to { id, label, command, cwd?, env?,
// timeoutMs? }; malformed/absent -> [] (never throws into the IDE); unknown
// fields ignored; normalization idempotent.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeConfigs,
  normalizeGateOnFailure,
  findConfig,
  findGateConfig,
  MAX_TEST_TIMEOUT_MS,
} = require('../services/workspace-test-runner-config');

test('s4: a fully-specified config normalizes to the canonical shape', () => {
  // RED-BECAUSE: normalizeConfigs throws NotImplementedError (no body yet).
  const out = normalizeConfigs([
    {
      id: 'unit',
      label: 'Unit suite',
      command: 'npm test',
      cwd: 'packages/api',
      env: { CI: '1', VERBOSE: 'true' },
      timeoutMs: 60000,
      summaryRegex: '(?<passed>\\d+) passed',
      bogusField: 'ignored',
    },
  ]);
  assert.deepEqual(out, [
    {
      id: 'unit',
      label: 'Unit suite',
      command: 'npm test',
      cwd: 'packages/api',
      env: { CI: '1', VERBOSE: 'true' },
      timeoutMs: 60000,
      summaryRegex: '(?<passed>\\d+) passed',
      gate: false,
      gateOnFailure: '',
    },
  ]);
});

test('s4: defaults fill label/cwd/env/timeoutMs when omitted', () => {
  // RED-BECAUSE: normalizeConfigs throws (no body yet).
  const [config] = normalizeConfigs([{ id: 'lint', command: 'npm run lint' }]);
  assert.equal(config.id, 'lint', 'id passes through unmangled');
  assert.equal(config.command, 'npm run lint', 'command passes through unmangled');
  assert.equal(config.label, 'lint', 'label defaults to id');
  assert.equal(config.cwd, '');
  assert.deepEqual(config.env, {});
  assert.equal(config.timeoutMs, null);
  assert.equal(config.summaryRegex, '', 'summaryRegex defaults to the empty string');
});

test('s17: summaryRegex is kept as a string, dropped to "" when non-string, idempotent', () => {
  // RED-BECAUSE: normalizeConfigs does not yet carry summaryRegex.
  const [kept] = normalizeConfigs([{ id: 'a', command: 'npm test', summaryRegex: '(\\d+) ok' }]);
  assert.equal(kept.summaryRegex, '(\\d+) ok', 'a string summaryRegex passes through');
  for (const bad of [42, true, {}, ['x'], null]) {
    const [dropped] = normalizeConfigs([{ id: 'a', command: 'npm test', summaryRegex: bad }]);
    assert.equal(dropped.summaryRegex, '', `a ${typeof bad} summaryRegex is dropped to ""`);
  }
  const once = normalizeConfigs([{ id: 'a', command: 'npm test', summaryRegex: '(?<passed>\\d+)' }]);
  assert.deepEqual(normalizeConfigs(once), once, 'summaryRegex round-trips idempotently');
});

test('s4: malformed / absent input degrades to [] and never throws', () => {
  // RED-BECAUSE: normalizeConfigs throws instead of returning [].
  assert.deepEqual(normalizeConfigs(undefined), []);
  assert.deepEqual(normalizeConfigs(null), []);
  assert.deepEqual(normalizeConfigs('not-an-array'), []);
  assert.deepEqual(normalizeConfigs({}), []);
  // Entries missing an id or a command are dropped, not thrown on.
  assert.deepEqual(normalizeConfigs([{ command: 'npm test' }]), []);
  assert.deepEqual(normalizeConfigs([{ id: 'x' }]), []);
  assert.deepEqual(normalizeConfigs([{ id: 'x', command: '   ' }]), []);
  // An invalid id shape (spaces / leading symbol) is rejected.
  assert.deepEqual(normalizeConfigs([{ id: 'bad id', command: 'npm test' }]), []);
  assert.deepEqual(normalizeConfigs([{ id: '-bad', command: 'npm test' }]), []);
});

test('s4: env keeps only string->string pairs and timeoutMs only positive ints', () => {
  // RED-BECAUSE: normalizeConfigs throws (no body yet).
  const [config] = normalizeConfigs([
    {
      id: 'mix',
      command: 'pytest',
      env: { GOOD: 'yes', NUM: 5, NESTED: { a: 1 }, NULLED: null },
      timeoutMs: -10,
    },
  ]);
  assert.deepEqual(config.env, { GOOD: 'yes' }, 'non-string env values are dropped');
  assert.equal(config.timeoutMs, null, 'non-positive timeoutMs falls back to null');
});

test('wide-034: timeout normalization has an explicit timer-safe maximum', () => {
  const values = [
    { id: 'max', command: 'x', timeoutMs: MAX_TEST_TIMEOUT_MS },
    { id: 'over', command: 'x', timeoutMs: MAX_TEST_TIMEOUT_MS + 1 },
    { id: 'huge', command: 'x', timeoutMs: 2 ** 31 },
    { id: 'fractional', command: 'x', timeoutMs: 1.5 },
    { id: 'negative', command: 'x', timeoutMs: -1 },
    { id: 'nullish', command: 'x', timeoutMs: null },
  ];
  const byId = Object.fromEntries(normalizeConfigs(values).map((entry) => [entry.id, entry]));
  assert.ok(Number.isSafeInteger(MAX_TEST_TIMEOUT_MS) && MAX_TEST_TIMEOUT_MS < 2 ** 31 - 1);
  assert.equal(byId.max.timeoutMs, MAX_TEST_TIMEOUT_MS, 'the documented maximum is accepted');
  assert.equal(byId.over.timeoutMs, MAX_TEST_TIMEOUT_MS, 'max+1 clamps instead of timer-overflowing');
  assert.equal(byId.huge.timeoutMs, MAX_TEST_TIMEOUT_MS, 'huge persisted values clamp safely');
  assert.equal(byId.fractional.timeoutMs, null, 'fractional values fall back to the default');
  assert.equal(byId.negative.timeoutMs, null, 'negative values fall back to the default');
  assert.equal(byId.nullish.timeoutMs, null, 'null stays absent instead of coercing to a timer');
});

test('s4: duplicate ids keep the first occurrence', () => {
  // RED-BECAUSE: normalizeConfigs throws (no body yet).
  const out = normalizeConfigs([
    { id: 'dupe', command: 'first' },
    { id: 'dupe', command: 'second' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].command, 'first');
});

test('s4: normalization is idempotent', () => {
  // RED-BECAUSE: normalizeConfigs throws (no body yet).
  const once = normalizeConfigs([
    { id: 'unit', command: 'npm test', extra: 'x' },
    { id: 'e2e', label: 'End to end', command: 'npm run e2e', timeoutMs: 120000 },
  ]);
  const twice = normalizeConfigs(once);
  assert.deepEqual(twice, once);
});

test('s4: findConfig resolves by id and returns null for misses', () => {
  // RED-BECAUSE: findConfig throws (no body yet).
  const configs = normalizeConfigs([
    { id: 'unit', command: 'npm test' },
    { id: 'e2e', command: 'npm run e2e' },
  ]);
  assert.equal(findConfig(configs, 'e2e').command, 'npm run e2e');
  assert.equal(findConfig(configs, 'missing'), null);
  assert.equal(findConfig(configs, ''), null);
});

// -- Verification gate designation -------------------------------------------
// At most ONE configuration may be the gate, and normalize is the only path into
// the store, so this is where the invariant is enforced -- not in the UI.

test('gate: only the first designated configuration keeps the gate', () => {
  const out = normalizeConfigs([
    { id: 'unit', command: 'npm test', gate: true, gateOnFailure: 'report' },
    { id: 'lint', command: 'npm run lint', gate: true },
    { id: 'e2e', command: 'npm run e2e' },
  ]);
  assert.deepEqual(out.map((c) => c.gate), [true, false, false]);
  assert.equal(findGateConfig(out).id, 'unit');
  assert.equal(out[0].gateOnFailure, 'report');
});

test('gate: the on-failure mode is only kept on the designated row', () => {
  // A stale mode on a config that is not the gate must not survive, or it would
  // silently come back if the row were ever re-designated.
  const out = normalizeConfigs([
    { id: 'unit', command: 'npm test', gateOnFailure: 'report' },
  ]);
  assert.equal(out[0].gate, false);
  assert.equal(out[0].gateOnFailure, '');
});

test('gate: the on-failure mode defaults to retry and rejects junk', () => {
  assert.equal(normalizeGateOnFailure(undefined), 'retry');
  assert.equal(normalizeGateOnFailure(''), 'retry');
  assert.equal(normalizeGateOnFailure('nonsense'), 'retry');
  assert.equal(normalizeGateOnFailure('REPORT'), 'report');
  assert.equal(normalizeGateOnFailure(' retry '), 'retry');
  const out = normalizeConfigs([
    { id: 'unit', command: 'npm test', gate: true, gateOnFailure: 'nonsense' },
  ]);
  assert.equal(out[0].gateOnFailure, 'retry');
});

test('gate: a truthy-but-not-true gate value does not designate', () => {
  const out = normalizeConfigs([{ id: 'unit', command: 'npm test', gate: 'yes' }]);
  assert.equal(out[0].gate, false);
});

test('gate: an invalid row cannot claim the designation from a valid one', () => {
  // The invalid entry is dropped BEFORE it can consume the single gate slot.
  const out = normalizeConfigs([
    { id: 'BAD ID', command: 'npm test', gate: true },
    { id: 'unit', command: 'npm test', gate: true },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'unit');
  assert.equal(out[0].gate, true);
});

test('gate: findGateConfig returns null when nothing is designated', () => {
  assert.equal(findGateConfig(normalizeConfigs([{ id: 'unit', command: 'x' }])), null);
  assert.equal(findGateConfig(null), null);
  assert.equal(findGateConfig([]), null);
});

// ---------------------------------------------------------------------------
// Verification gate Wave 3 / finding 1: normalization reports its drops.
// ---------------------------------------------------------------------------

test('finding 1: normalizeConfigsDetailed names every dropped entry with a typed reason', () => {
  const { normalizeConfigsDetailed, REJECT_REASONS } = require('../services/workspace-test-runner-config');
  const detailed = normalizeConfigsDetailed([
    { id: 'unit', command: 'npm test' },
    { id: 'has space', command: 'x' },
    { id: 'a'.repeat(81), command: 'x' },
    { id: 'unit', command: 'dup' },
    { id: 'nocmd', command: '' },
    { id: 'longcwd', command: 'x', cwd: 'c'.repeat(1025) },
    null,
    ['array'],
  ]);
  assert.deepEqual(detailed.configs.map((c) => c.id), ['unit']);
  assert.deepEqual(detailed.rejected, [
    { id: 'has space', reason: REJECT_REASONS.INVALID_ID },
    { id: 'a'.repeat(81), reason: REJECT_REASONS.INVALID_ID },
    { id: 'unit', reason: REJECT_REASONS.DUPLICATE_ID },
    { id: 'nocmd', reason: REJECT_REASONS.INVALID_COMMAND },
    { id: 'longcwd', reason: REJECT_REASONS.INVALID_CWD },
    { id: '', reason: REJECT_REASONS.MALFORMED },
    { id: '', reason: REJECT_REASONS.MALFORMED },
  ]);
  // The rejected id is bounded so a hostile id cannot bloat the response.
  const huge = normalizeConfigsDetailed([{ id: 'z'.repeat(5000), command: 'x' }]);
  assert.equal(huge.rejected[0].id.length, 120);
});

test('finding 1: normalizeConfigs is exactly the configs half of the detailed result', () => {
  const { normalizeConfigs, normalizeConfigsDetailed } = require('../services/workspace-test-runner-config');
  const raw = [{ id: 'unit', command: 'npm test' }, { id: 'bad id', command: 'x' }];
  assert.deepEqual(normalizeConfigs(raw), normalizeConfigsDetailed(raw).configs);
  assert.deepEqual(normalizeConfigsDetailed('garbage'), { configs: [], rejected: [] });
});
