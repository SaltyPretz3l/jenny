'use strict';
// SPEC: Verification gate Wave 3 -- the pure helpers behind the Test Runner
// panel's persistent gate header (variant B): verdict copy for every reviewed
// state, "by Jenny · 2m ago" attribution, rejection copy for a dropped
// configuration save, and the header markup itself. No DOM, no IPC.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const gateUtils = require('../renderer/features/renderer-ide-test-runner-gate-utils.js');
const selectField = require('../renderer/inventory/select-field.js');

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const iso = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

function stateWith(records, active = {}) {
  return {
    configs: [],
    history: { byConfig: { unit: records } },
    activeRun: active.activeRun || null,
    activeConfigId: active.activeConfigId || null,
  };
}

const GATE = { id: 'unit', label: 'Unit', command: 'npm test', gate: true, gateOnFailure: 'retry' };
const REPORT_GATE = { ...GATE, gateOnFailure: 'report' };

test('relative time is coarse and never negative', () => {
  assert.equal(gateUtils.formatRelativeTime(iso(5), NOW), 'just now');
  assert.equal(gateUtils.formatRelativeTime(iso(150), NOW), '2m ago');
  assert.equal(gateUtils.formatRelativeTime(iso(3700), NOW), '1h ago');
  assert.equal(gateUtils.formatRelativeTime(iso(2 * 86400 + 10), NOW), '2d ago');
  assert.equal(gateUtils.formatRelativeTime(iso(-500), NOW), 'just now', 'a future stamp clamps to now');
  assert.equal(gateUtils.formatRelativeTime('garbage', NOW), '');
  assert.equal(gateUtils.formatRelativeTime(null, NOW), '');
});

test('attribution names Jenny only when the record says so', () => {
  assert.deepEqual(
    gateUtils.attributionFor({ initiator: 'jenny', startedAt: iso(120) }, NOW),
    { text: 'by Jenny · 2m ago', initiator: 'jenny' }
  );
  assert.deepEqual(
    gateUtils.attributionFor({ startedAt: iso(3600) }, NOW),
    { text: 'by you · 1h ago', initiator: 'user' }
  );
  // A pre-existing record with no stamp still attributes, just without a time.
  assert.deepEqual(gateUtils.attributionFor({ status: 'passed' }, NOW), { text: 'by you', initiator: 'user' });
  assert.deepEqual(gateUtils.attributionFor(null, NOW), { text: '', initiator: '' });
});

test('verdict: no gate set sells the feature in one line', () => {
  const verdict = gateUtils.deriveGateVerdict(stateWith([]), [{ id: 'unit', command: 'npm test' }]);
  assert.equal(verdict.status, 'none');
  assert.equal(verdict.text, 'No gate set');
  assert.match(verdict.detail, /pick a test configuration and Jenny will run it/);
});

test('verdict: a gate with no Jenny run yet is empty, not "never run"', () => {
  // A user's own runs are not turn verdicts; the header stays quiet.
  const verdict = gateUtils.deriveGateVerdict(stateWith([{ status: 'passed', durationMs: 900 }]), [GATE]);
  assert.deepEqual(verdict, { status: '', text: '', detail: '' });
});

test('verdict: passed is deliberately quiet', () => {
  const verdict = gateUtils.deriveGateVerdict(
    stateWith([{ status: 'passed', initiator: 'jenny', passedCount: 142, durationMs: 21400 }]),
    [GATE]
  );
  assert.equal(verdict.status, 'passed');
  assert.equal(verdict.text, 'Passed');
  assert.equal(verdict.detail, '142 · 21.4s');
});

test('verdict: failed in retry mode shows the counts and the attempt', () => {
  const verdict = gateUtils.deriveGateVerdict(
    stateWith([{ status: 'failed', initiator: 'jenny', passedCount: 138, failedCount: 4, gateAttempt: 1 }]),
    [GATE]
  );
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.text, 'Failed · 4 of 142');
  assert.equal(verdict.detail, `attempt 1 of ${gateUtils.GATE_MAX_ATTEMPTS}`);
});

test('verdict: failed in report-only mode says no fix was attempted', () => {
  const verdict = gateUtils.deriveGateVerdict(
    stateWith([{ status: 'failed', initiator: 'jenny', passedCount: 138, failedCount: 4, gateAttempt: 1 }]),
    [REPORT_GATE]
  );
  assert.equal(verdict.text, 'Failed · 4 of 142');
  assert.equal(verdict.detail, 'report-only, no fix attempted');
});

test('verdict: retries exhausted is the honest end state', () => {
  const verdict = gateUtils.deriveGateVerdict(
    stateWith([{ status: 'failed', initiator: 'jenny', failedCount: 4, passedCount: 138, gateAttempt: 2 }]),
    [GATE]
  );
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.text, 'Failed after 2 attempts');
  assert.equal(verdict.detail, 'Jenny stopped trying and reported it');
});

test('verdict: failed without counts still reads Failed', () => {
  const verdict = gateUtils.deriveGateVerdict(stateWith([{ status: 'failed', initiator: 'jenny' }]), [GATE]);
  assert.equal(verdict.text, 'Failed');
});

test('verdict: a skipped gate names the user run that held the lock', () => {
  const verdict = gateUtils.deriveGateVerdict(
    stateWith([{ status: 'skipped', initiator: 'jenny', skipReason: 'already_running' }]),
    [GATE]
  );
  assert.equal(verdict.status, 'skipped');
  assert.equal(verdict.text, 'Skipped');
  assert.equal(verdict.detail, 'your Unit run was in progress · turn completed unverified');
});

test('verdict: running mid-turn says what is being verified', () => {
  const jenny = gateUtils.deriveGateVerdict(
    stateWith([{ status: 'running', initiator: 'jenny' }], { activeRun: 'r1', activeConfigId: 'unit' }),
    [GATE]
  );
  assert.equal(jenny.status, 'running');
  assert.equal(jenny.detail, 'verifying Unit before finishing this turn…');
  const user = gateUtils.deriveGateVerdict(
    stateWith([{ status: 'running' }], { activeRun: 'r1', activeConfigId: 'unit' }),
    [GATE]
  );
  assert.equal(user.status, 'running');
  assert.equal(user.detail, 'Unit is running');
});

test('verdict: the latest JENNY run wins, not the latest run', () => {
  const verdict = gateUtils.deriveGateVerdict(
    stateWith([
      { status: 'failed', initiator: 'jenny', failedCount: 1, passedCount: 9 },
      { status: 'passed' }, // the user re-ran it by hand afterwards
    ]),
    [GATE]
  );
  assert.equal(verdict.text, 'Failed · 1 of 10');
});

test('verdict: other terminal statuses use the shared labels', () => {
  const verdict = gateUtils.deriveGateVerdict(stateWith([{ status: 'timeout', initiator: 'jenny' }]), [GATE]);
  assert.equal(verdict.status, 'timeout');
  assert.equal(verdict.text, 'Timed out');
});

test('rejection copy names the id and the rule it broke', () => {
  assert.match(gateUtils.describeRejection({ id: 'bad id', reason: 'invalid_id' }), /"bad id" was not saved: ids may only use/);
  assert.match(gateUtils.describeRejection({ id: 'unit', reason: 'duplicate_id' }), /already exists/);
  assert.match(gateUtils.describeRejection({ id: 'x', reason: 'over_cap' }), /maximum number/);
  assert.match(gateUtils.describeRejection({ id: '', reason: 'malformed' }), /^The configuration was not saved/);
  assert.match(gateUtils.describeRejection({ id: 'x', reason: 'something_new' }), /was not accepted/);
  assert.equal(gateUtils.describeRejection(null), '');
});

test('header markup: a gate select over the configs plus Off, the verdict, and the mode select', () => {
  const dom = new JSDOM('<main id="host"></main>');
  const host = dom.window.document.getElementById('host');
  host.innerHTML = gateUtils.buildGateHeaderMarkup({
    configs: [{ id: 'lint', label: 'Lint', command: 'npm run lint' }, GATE],
    state: stateWith([{ status: 'failed', initiator: 'jenny', failedCount: 4, passedCount: 138, gateAttempt: 1 }]),
    selectField,
  });
  const header = host.querySelector('.ide-test-runner-gate');
  assert.ok(header, 'the strip renders');
  assert.equal(header.dataset.gateStatus, 'failed');
  const gateSelect = header.querySelector('[data-test-runner-gate-config]');
  assert.deepEqual(
    Array.from(gateSelect.options).map((option) => [option.value, option.textContent]),
    [['lint', 'Lint'], ['unit', 'Unit'], ['', 'Off']]
  );
  assert.equal(gateSelect.value, 'unit', 'the designated config is selected');
  const verdict = header.querySelector('.ide-test-runner-gate__verdict');
  assert.equal(verdict.dataset.status, 'failed');
  assert.equal(verdict.textContent, 'Failed · 4 of 142');
  assert.equal(header.querySelector('.ide-test-runner-gate__detail').textContent, 'attempt 1 of 2');
  const modeSelect = header.querySelector('[data-test-runner-gate-mode]');
  assert.equal(modeSelect.value, 'retry');
  assert.equal(modeSelect.disabled, false);
  assert.deepEqual(
    Array.from(modeSelect.options).map((option) => option.textContent),
    ['Retry once', 'Report only']
  );
  // Design law: a bordered strip, never a side-highlight bar or a card.
  assert.equal(host.querySelector('.ide-test-runner-gate .card'), null);
});

test('header markup: with no gate the mode select is disabled and Off is selected', () => {
  const dom = new JSDOM('<main id="host"></main>');
  const host = dom.window.document.getElementById('host');
  host.innerHTML = gateUtils.buildGateHeaderMarkup({
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }],
    state: stateWith([]),
    selectField,
  });
  assert.equal(host.querySelector('[data-test-runner-gate-config]').value, '');
  assert.equal(host.querySelector('[data-test-runner-gate-mode]').disabled, true);
  assert.equal(host.querySelector('.ide-test-runner-gate__verdict').textContent, 'No gate set');
});

test('header markup: config labels are escaped, never injected', () => {
  const dom = new JSDOM('<main id="host"></main>');
  const host = dom.window.document.getElementById('host');
  host.innerHTML = gateUtils.buildGateHeaderMarkup({
    configs: [{ id: 'unit', label: '<img src=x onerror="alert(1)">', command: 'npm test', gate: true }],
    state: stateWith([{ status: 'skipped', initiator: 'jenny' }]),
    selectField,
  });
  assert.equal(host.querySelector('img'), null);
  assert.match(host.innerHTML, /&lt;img/);
});

test('header markup: without a select primitive nothing renders (no raw <select>)', () => {
  assert.equal(gateUtils.buildGateHeaderMarkup({ configs: [GATE], state: stateWith([]) }), '');
});
