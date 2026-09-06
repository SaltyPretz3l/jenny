'use strict';
// SPEC: Workspace Test Runner P1 Wave B — S17 (Behavior): an optional, user-
// authored summaryRegex parses a run's stdout tail into advisory
// {passedCount, failedCount}. Status is ALWAYS from the exit code, never from
// parsing. The parse is ReDoS-guarded: (a) the scanned input is tail-sliced,
// (b) an over-long regex source is rejected, (c) compile+exec are wrapped so any
// throw degrades to no counts. A miss/malformation NEVER throws and NEVER yields
// partial-but-wrong counts.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSummary,
  parseSummaryBounded,
  hasNestedQuantifier,
  MAX_REGEX_SOURCE,
  MAX_INPUT_TAIL,
} = require('../services/workspace-test-runner-summary');

function createDeferredWorker() {
  const listeners = new Map();
  return {
    terminated: 0,
    once(event, callback) { listeners.set(event, callback); return this; },
    emit(event, value) { listeners.get(event)?.(value); },
    terminate() { this.terminated += 1; return Promise.resolve(0); },
  };
}

test('s17: named (?<passed>/(?<failed>) groups extract both counts', () => {
  // RED-BECAUSE: parseSummary throws NotImplementedError (no body yet).
  const out = parseSummary('Tests: 12 passed, 3 failed', '(?<passed>\\d+) passed, (?<failed>\\d+) failed');
  assert.deepEqual(out, { passedCount: 12, failedCount: 3 });
});

test('s17: positional groups fall back to 1=passed / 2=failed when unnamed', () => {
  // RED-BECAUSE: parseSummary throws (no body yet).
  const out = parseSummary('ok=7 ng=2', 'ok=(\\d+) ng=(\\d+)');
  assert.deepEqual(out, { passedCount: 7, failedCount: 2 });
});

test('s17: a single passed group yields only passedCount (failed omitted)', () => {
  // RED-BECAUSE: parseSummary throws (no body yet).
  assert.deepEqual(parseSummary('42 passing', '(?<passed>\\d+) passing'), { passedCount: 42 });
});

test('s17: a non-matching regex omits counts (and never throws)', () => {
  // RED-BECAUSE: parseSummary throws (no body yet).
  assert.deepEqual(parseSummary('all good, nothing to report', '(?<passed>\\d+) passed'), {});
});

test('s17: a malformed regex is swallowed -> {} (try/catch, never throws)', () => {
  // ReDoS guard (c): a compile throw must degrade to no counts, not propagate.
  // Mutation: drop the try/catch -> this throws instead of returning {} -> RED.
  assert.deepEqual(parseSummary('5 passed', '(unbalanced'), {});
});

test('s17: a non-string summaryRegex yields {}', () => {
  // RED-BECAUSE: parseSummary throws (no body yet).
  assert.deepEqual(parseSummary('5 passed', undefined), {});
  assert.deepEqual(parseSummary('5 passed', null), {});
  assert.deepEqual(parseSummary('5 passed', 42), {});
  assert.deepEqual(parseSummary('5 passed', ''), {}, 'an empty regex is treated as "no regex"');
});

test('s17: a non-numeric / negative capture is dropped (status stays exit-code authoritative)', () => {
  // RED-BECAUSE: parseSummary throws (no body yet).
  assert.deepEqual(parseSummary('passed=abc', 'passed=(?<passed>\\w+)'), {}, 'a letter capture is not a count');
  assert.deepEqual(parseSummary('passed=-4', 'passed=(?<passed>-?\\d+)'), {}, 'a negative capture is not a count');
});

test('s17: an over-long regex source is rejected even though it would otherwise match (ReDoS guard b)', () => {
  // A long-but-valid pattern that genuinely DOES match its input; the source-length
  // cap must reject it before compile. The padding is a LINEAR literal prefix (no
  // nested quantifiers) so executing it is itself safe — proving the cap, not a
  // non-matching pattern, is what suppresses the counts.
  // Mutation: remove the cap -> it compiles, matches, returns {passedCount:7} -> RED.
  const literalPrefix = 'ok '.repeat(80); // 240 chars, linear to match
  const big = `${literalPrefix}(?<passed>\\d+) passed`;
  const input = `${literalPrefix}7 passed`;
  assert.ok(big.length > MAX_REGEX_SOURCE, 'the crafted pattern exceeds the source cap');
  assert.equal(new RegExp(big).test(input), true, 'the pattern WOULD match its input if it were ever compiled');
  assert.deepEqual(parseSummary(input, big), {}, 'but the over-long source is rejected before compile');
});

test('s17: the scanned input is tail-sliced; a marker older than the window is not scanned (ReDoS guard a)', () => {
  const marker = 'SUMMARY 9 passed';
  // The marker sits at the very START, then padded PAST the tail window, so the
  // tail slice drops it. Mutation: remove the slice -> the far-past marker is
  // scanned and matches -> {passedCount:9} -> RED.
  const farPast = `${marker}${'.'.repeat(MAX_INPUT_TAIL + 50)}`;
  assert.deepEqual(parseSummary(farPast, '(?<passed>\\d+) passed'), {}, 'a marker older than the tail window is dropped');
  // The SAME marker INSIDE the tail window is scanned and matched.
  const recent = `${'.'.repeat(MAX_INPUT_TAIL + 50)}${marker}`;
  assert.deepEqual(parseSummary(recent, '(?<passed>\\d+) passed'), { passedCount: 9 });
});

test('s17: a large input with a LINEAR pattern is length-bounded and returns {} (ReDoS guard a)', () => {
  // Guard (a) bounds the scanned LENGTH (not backtracking time — that is guard (c)).
  // A greedy LINEAR pattern over a 2x-window non-matching input returns {} without
  // growing the scan past the cap. NOTE: this does NOT verify "no hang" for a
  // catastrophic pattern; that is the nested-quantifier-rejection test below.
  const input = 'x'.repeat(MAX_INPUT_TAIL * 2);
  assert.deepEqual(parseSummary(input, '(?<passed>\\d+) passed'), {});
});

test('s17: a nested-quantifier (catastrophic-shaped) source is rejected before it executes (ReDoS guard c)', () => {
  // Guard (c) stops the canonical catastrophic-backtracking shapes BEFORE compile,
  // so they never run on the synchronous main thread. Inputs are tiny so this stays
  // safe even under the mutation that removes the guard.
  // Mutation: drop the guard -> (\d+)+ executes on '12' and returns {passedCount:12} -> RED.
  assert.deepEqual(parseSummary('12', '(\\d+)+'), {}, 'a nested quantifier is rejected, not executed');
  assert.deepEqual(parseSummary('aaaa!', '(a+)+$'), {}, 'the classic (a+)+ catastrophe is rejected');
  assert.deepEqual(parseSummary('ab', '([a-z]+)*'), {}, '([a-z]+)* is rejected');
});

test('s17: hasNestedQuantifier flags nested quantifiers but NOT separate adjacent ones', () => {
  // The detector is the teeth behind guard (c): it must catch a quantifier applied
  // to a group whose body is itself quantified, and must NOT false-positive on the
  // legitimate "two separate (\\d+) groups" summary shape (else real configs break).
  for (const bad of ['(a+)+', '(a*)*', '([a-z]+)+', '(\\d+){2,}', '(ab+)*']) {
    assert.equal(hasNestedQuantifier(bad), true, `${bad} is a nested quantifier`);
  }
  for (const ok of ['(?<passed>\\d+) passed, (?<failed>\\d+) failed', '(\\d+) ok (\\d+) ng', 'passed=(\\d+)', '[a-z]+\\d*']) {
    assert.equal(hasNestedQuantifier(ok), false, `${ok} must not be flagged`);
  }
});

test('s17: a non-string / nullish stdout tail is tolerated', () => {
  // RED-BECAUSE: parseSummary throws (no body yet).
  assert.deepEqual(parseSummary(undefined, '(?<passed>\\d+) passed'), {});
  assert.deepEqual(parseSummary(null, '(?<passed>\\d+) passed'), {});
});

test('wide-034: bounded summary evaluation times out and terminates a stuck worker', async () => {
  const worker = createDeferredWorker();
  let fireDeadline = null;
  const promise = parseSummaryBounded(
    `${'a'.repeat(4096)}!`,
    '(a|aa)+$',
    {
      createWorker: () => worker,
      setTimeoutImpl: (callback) => { fireDeadline = callback; return 1; },
      clearTimeoutImpl: () => {},
      deadlineMs: 25,
    }
  );
  assert.equal(typeof fireDeadline, 'function', 'the worker evaluation arms a wall-clock deadline');
  fireDeadline();
  assert.deepEqual(await promise, {}, 'a timed-out adversarial pattern degrades to no counts');
  assert.equal(worker.terminated, 1, 'the stuck regex worker is terminated exactly once');
});

test('wide-034: bounded summary evaluation validates worker output before returning counts', async () => {
  const worker = createDeferredWorker();
  const promise = parseSummaryBounded('7 passed', '(?<passed>\\d+) passed', {
    createWorker: () => worker,
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
  });
  worker.emit('message', { passedCount: 7, failedCount: -1, ignored: 'payload' });
  assert.deepEqual(await promise, { passedCount: 7 });
  assert.equal(worker.terminated, 1, 'the one-shot worker is cleaned up after success');
});
