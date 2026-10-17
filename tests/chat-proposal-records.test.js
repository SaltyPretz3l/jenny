'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const R = require('../services/backend/chat-proposal-records');

const {
  NOW, DAY, DECISION, ATTEMPT, HEX, gitBinding, commandBinding, identity, makeGit, makeCommand, git, cmd, causeOf,
} = require('./helpers/chat-proposal-records-fixture');

test('canonicalJson sorts keys recursively, keeps array order and rejects unrepresentable values', () => {
  assert.equal(R.canonicalJson({ b: 1, a: { d: [3, 1], c: null } }), '{"a":{"c":null,"d":[3,1]},"b":1}');
  assert.equal(R.canonicalJson('é"'), '"é\\""');
  assert.throws(() => R.canonicalJson({ a: undefined }));
  assert.throws(() => R.canonicalJson(Number.NaN));
});

test('proposal ids are deterministic, identity-bound and accept object or positional form', () => {
  const a = R.computeProposalId('inc', 'turn', 'call');
  assert.match(a, /^proposal_[0-9a-f]{64}$/);
  assert.equal(a, `proposal_${R.sha256Hex('["inc","turn","call"]')}`);
  assert.equal(a, R.computeProposalId('inc', 'turn', 'call'));
  assert.equal(a, R.computeProposalId({ source_session_incarnation: 'inc', source_turn_id: 'turn', source_tool_call_id: 'call' }));
  assert.equal(a, R.computeProposalId({ sessionIncarnation: 'inc', turnId: 'turn', toolCallId: 'call' }));
  assert.notEqual(a, R.computeProposalId('inc2', 'turn', 'call'));
  assert.notEqual(a, R.computeProposalId('inc', 'turn', 'call2'));
  assert.throws(() => R.computeProposalId('inc', '', 'call'));
});

test('dispatch keys and the runtime idempotency key follow C1', () => {
  const key = R.buildGitDispatchKey('proposal_x', DECISION);
  assert.equal(key, `proposal:proposal_x:${DECISION}:local`);
  const sha = R.sha256Hex(key);
  assert.equal(R.runtimeIdempotencyKey(sha), `pdk_${sha}`);
  assert.equal(R.runtimeIdempotencyKey(sha).length, 68);
  assert.equal(R.sha256Hex(Buffer.from('abc')), R.sha256Hex('abc'));
});

test('git input: defaults, D3 schema_version, unknown keys and sorted distinct paths', () => {
  const ok = git({ paths: ['z/b.js', 'a.js', 'z/a.js'], schema_version: 1 });
  assert.deepEqual(ok, { ok: true, value: { schema_version: 1, summary: 'S', question: 'Q', paths: ['a.js', 'z/a.js', 'z/b.js'] } });
  assert.equal(git({}).value.schema_version, 1);
  assert.equal(causeOf(git({ schema_version: 2 })), 'field_schema_version');
  assert.equal(causeOf(git({ extra: 1 })), 'unknown_key');
  assert.equal(causeOf(R.normalizeGitProposalInput(null)), 'invalid_args');
  assert.equal(causeOf(R.normalizeGitProposalInput([])), 'invalid_args');
  assert.equal(causeOf(git({ paths: ['a', 'a'] })), 'field_paths');
  assert.deepEqual(git({ summary: 5 }), { ok: false, reason: 'invalid_request', cause_code: 'field_summary' });
  for (const text of ['', '   \n\t']) {
    assert.equal(causeOf(git({ summary: text })), 'field_summary');
    assert.equal(causeOf(git({ question: text })), 'field_question');
  }
  assert.equal(git({ summary: ' padded ' }).value.summary, ' padded ', 'nothing is trimmed');
});

test('git summary and question limits count code points, reject at max+1', () => {
  assert.equal(git({ summary: 'x'.repeat(4096) }).ok, true);
  assert.equal(causeOf(git({ summary: 'x'.repeat(4097) })), 'field_summary');
  assert.equal(git({ question: 'x'.repeat(512) }).ok, true);
  assert.equal(causeOf(git({ question: 'x'.repeat(513) })), 'field_question');
  const astral = '\u{1F600}';
  assert.equal(git({ question: astral.repeat(512) }).ok, true, '512 astral code points are 1024 UTF-16 units');
  assert.equal(causeOf(git({ question: astral.repeat(513) })), 'field_question');
  assert.equal(causeOf(git({ summary: 'bad\ud800' })), 'field_summary', 'lone surrogates are not well-formed text');
  assert.equal(causeOf(git({ summary: 'a\0b' })), 'field_summary');
});

test('git paths: count boundary and path shape rules', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(3, '0')}.js`);
  assert.equal(git({ paths: many(200) }).ok, true);
  assert.equal(causeOf(git({ paths: many(201) })), 'field_paths');
  assert.equal(causeOf(git({ paths: [] })), 'field_paths');
  assert.equal(causeOf(git({ paths: 'a' })), 'field_paths');
  for (const bad of ['', '/abs', 'C:/x', 'c:x', '../x', 'a/../b', './a', 'a/./b', 'a//b', 'a/', '.', '..', 'a\\b', 'a\nb', 'a\rb', 'a\0b', 5]) {
    assert.equal(causeOf(git({ paths: [bad] })), 'field_paths', JSON.stringify(bad));
  }
  assert.equal(git({ paths: ['a'.repeat(4096)] }).ok, true);
  assert.equal(causeOf(git({ paths: ['a'.repeat(4097)] })), 'field_paths');
  assert.equal(git({ paths: ['\u00e9'.repeat(2048)] }).ok, true, '2048 two-byte characters are exactly 4 KiB');
  assert.equal(causeOf(git({ paths: ['\u00e9'.repeat(2049)] })), 'field_paths', 'KiB limits count UTF-8 bytes');
  assert.equal(git({ paths: ['\u00e9.js', 'Z.js', 'a.js'] }).value.paths.join(','), 'Z.js,a.js,\u00e9.js', 'code-unit order');
});

test('command input: defaults and exact preservation', () => {
  const ok = cmd({ command: '  echo "hi"\n\tdone  ' });
  assert.deepEqual(ok.value, {
    schema_version: 1, command: '  echo "hi"\n\tdone  ', cwd: '.', purpose: 'p',
    timeout_seconds: 30, expected_exit_codes: [0], preconditions: [],
  });
  assert.equal(cmd({ command: 'a\r\nb' }).value.command, 'a\r\nb', 'all non-NUL bytes are preserved');
  assert.equal(cmd({ cwd: 'packages/app', schema_version: 1 }).value.cwd, 'packages/app');
  assert.equal(causeOf(cmd({ schema_version: 2 })), 'field_schema_version');
  assert.equal(causeOf(cmd({ shell: 'bash' })), 'unknown_key');
  assert.equal(causeOf(cmd({ env: {} })), 'unknown_key');
  assert.equal(causeOf(R.normalizeCommandProposalInput('ls')), 'invalid_args');
});

test('command text limits: bytes, NUL, whitespace-only', () => {
  assert.equal(cmd({ command: 'x'.repeat(8192) }).ok, true);
  assert.equal(causeOf(cmd({ command: 'x'.repeat(8193) })), 'field_command');
  assert.equal(cmd({ command: '\u00e9'.repeat(4096) }).ok, true, '4096 two-byte characters are exactly 8 KiB');
  assert.equal(causeOf(cmd({ command: '\u00e9'.repeat(4097) })), 'field_command');
  assert.equal(cmd({ command: 'x' }).ok, true, '1 byte accepted');
  for (const bad of ['', ' \t\n', 'a\0b', 5, 'x\ud800']) assert.equal(causeOf(cmd({ command: bad })), 'field_command');
});

test('command cwd, purpose and precondition limits', () => {
  assert.equal(cmd({ cwd: '.' }).ok, true);
  for (const bad of ['', '/x', '..', 'a/../b', 'a\\b', 'C:\\x', './', 5]) assert.equal(causeOf(cmd({ cwd: bad })), 'field_cwd', JSON.stringify(bad));
  assert.equal(cmd({ purpose: 'p'.repeat(1024) }).ok, true);
  assert.equal(causeOf(cmd({ purpose: 'p'.repeat(1025) })), 'field_purpose');
  assert.equal(causeOf(cmd({ purpose: '  ' })), 'field_purpose');
  const pre = (n, text = 't') => Array.from({ length: n }, () => ({ kind: 'user_confirmation', text }));
  assert.equal(cmd({ preconditions: pre(5) }).value.preconditions.length, 5);
  assert.equal(causeOf(cmd({ preconditions: pre(6) })), 'field_preconditions');
  assert.equal(cmd({ preconditions: pre(1, 't'.repeat(256)) }).ok, true);
  assert.equal(causeOf(cmd({ preconditions: pre(1, 't'.repeat(257)) })), 'field_preconditions');
  assert.equal(cmd({ preconditions: pre(1, '\u{1F600}'.repeat(256)) }).ok, true, 'code points, not UTF-16 units');
  assert.equal(causeOf(cmd({ preconditions: [{ kind: 'user_confirmation', text: ' ' }] })), 'field_preconditions');
  assert.equal(causeOf(cmd({ preconditions: [{ kind: 'verify', text: 't' }] })), 'field_preconditions');
  assert.equal(causeOf(cmd({ preconditions: [{ kind: 'user_confirmation', text: 't', extra: 1 }] })), 'field_preconditions');
  assert.equal(causeOf(cmd({ preconditions: 'x' })), 'field_preconditions');
});

test('command timeout and exit-code boundaries', () => {
  assert.equal(cmd({ timeout_seconds: 1 }).value.timeout_seconds, 1);
  assert.equal(cmd({ timeout_seconds: 300 }).value.timeout_seconds, 300);
  for (const bad of [0, 301, 1.5, '30', Number.NaN, null]) assert.equal(causeOf(cmd({ timeout_seconds: bad })), 'field_timeout_seconds');
  assert.equal(cmd({ expected_exit_codes: [0, 255] }).ok, true);
  assert.deepEqual(cmd({ expected_exit_codes: [2, 1] }).value.expected_exit_codes, [2, 1], 'order is kept');
  const codes = (n) => Array.from({ length: n }, (_, i) => i);
  assert.equal(cmd({ expected_exit_codes: codes(16) }).ok, true);
  for (const bad of [codes(17), [], [256], [-1], [1, 1], [1.5], 'x']) assert.equal(causeOf(cmd({ expected_exit_codes: bad })), 'field_expected_exit_codes');
});

test('docker backend caps the timeout at 120 seconds, native keeps 300', () => {
  assert.equal(cmd({ timeout_seconds: 120 }, { backend: 'docker' }).value.timeout_seconds, 120);
  assert.deepEqual(cmd({ timeout_seconds: 121 }, { backend: 'docker' }), { ok: false, reason: 'invalid_request', cause_code: 'timeout_sandbox_limit' });
  assert.equal(cmd({ timeout_seconds: 300 }, { backend: 'native' }).value.timeout_seconds, 300);
  assert.equal(cmd({ timeout_seconds: 300 }).value.timeout_seconds, 300, 'no backend -> native range');
  assert.equal(cmd({}, { backend: 'docker' }).value.timeout_seconds, 30);
  assert.equal(causeOf(cmd({ timeout_seconds: 301 }, { backend: 'docker' })), 'field_timeout_seconds', 'out of the global range is still a range error');
});

test('D4: cmd.exe refuses multi-line commands, /bin/sh accepts them', () => {
  assert.equal(causeOf(cmd({ command: 'a\nb' }, { shell: 'cmd.exe' })), 'multiline_cmd_exe');
  assert.equal(causeOf(cmd({ command: 'a\rb' }, { shell: 'cmd.exe' })), 'multiline_cmd_exe');
  assert.equal(cmd({ command: 'a & b' }, { shell: 'cmd.exe' }).ok, true);
  assert.equal(cmd({ command: 'a\nb' }, { shell: '/bin/sh' }).ok, true);
  assert.equal(cmd({ command: 'a\nb' }).ok, true);
});

test('createProposalRecord builds the closed C1 record', () => {
  const record = makeGit();
  assert.equal(record.schema_version, 1);
  assert.equal(record.revision, 1);
  assert.equal(record.kind, 'git');
  assert.equal(record.proposal_id, R.computeProposalId('inc_a', 'turn_1', 'call_1'));
  assert.equal(record.created_at, '2026-10-15T10:00:00.000Z');
  assert.equal(record.expires_at, '2026-10-22T10:00:00.000Z');
  assert.equal(record.decision_state, 'pending');
  assert.equal(record.action_state, 'none');
  assert.equal(record.attempt_number, 0);
  assert.equal(record.restore_requires_confirmation, false);
  for (const key of ['options', 'group_id', 'decision', 'attempt_id', 'handoff', 'dispatch_key', 'last_error', 'execution', 'child_session_id']) {
    assert.equal(record[key], null, key);
  }
  assert.deepEqual(R.normalizeProposalRecord(record), record);
  const snake = R.createProposalRecord({
    kind: 'git', source_session_id: 's', source_session_incarnation: 'i', source_turn_id: 't', source_tool_call_id: 'c',
    input: record.normalized_input, binding: record.binding, now: NOW.getTime(),
  });
  assert.equal(snake.ok, true, 'snake_case keys and numeric now are accepted');
});

test('createProposalRecord rejects bad input, bad bindings, mismatched hashes and oversize records', () => {
  const input = R.normalizeGitProposalInput({ summary: 'S', question: 'Q', paths: ['a.js'] }).value;
  const base = { kind: 'git', ...identity(), input, binding: gitBinding(['a.js']) };
  assert.equal(R.createProposalRecord(base).ok, true);
  assert.equal(causeOf(R.createProposalRecord({ ...base, kind: 'session' })), 'record_invalid', 'a git input is not a session input');
  assert.equal(causeOf(R.createProposalRecord({ ...base, kind: 'other' })), 'field_kind');
  assert.equal(causeOf(R.createProposalRecord({ ...base, turnId: '' })), 'field_identity');
  assert.equal(causeOf(R.createProposalRecord({ ...base, input: { ...input, extra: 1 } })), 'record_invalid');
  assert.equal(causeOf(R.createProposalRecord({ ...base, binding: { ...gitBinding(), run_mode: 'x' } })), 'record_invalid');
  assert.equal(causeOf(R.createProposalRecord({ ...base, binding: { ...gitBinding(), command: commandBinding('x').command } })), 'record_invalid');
  const cmdInput = R.normalizeCommandProposalInput({ command: 'ls', cwd: '.', purpose: 'p' }).value;
  const cmdBase = { kind: 'command', ...identity(), input: cmdInput };
  assert.equal(R.createProposalRecord({ ...cmdBase, binding: commandBinding('ls') }).ok, true);
  assert.equal(causeOf(R.createProposalRecord({ ...cmdBase, binding: commandBinding('other') })), 'record_invalid', 'command hash must match');
  assert.equal(causeOf(R.createProposalRecord({ ...cmdBase, binding: commandBinding('ls', { cwd: 'sub' }) })), 'record_invalid', 'cwd must match');
  const fat = R.normalizeGitProposalInput({
    summary: 'S', question: 'Q', paths: Array.from({ length: 60 }, (_, i) => `${String(i).padStart(2, '0')}${'p'.repeat(3000)}`),
  });
  assert.equal(fat.ok, true);
  const oversize = R.createProposalRecord({ kind: 'git', ...identity(), input: fat.value, binding: gitBinding(fat.value.paths) });
  assert.deepEqual(oversize, { ok: false, reason: 'capacity', cause_code: 'record_too_large' });
});

test('normalizeProposalRecord rejects malformed, relabelled and unknown-shape records', () => {
  const good = makeGit();
  const bad = (patch) => R.normalizeProposalRecord({ ...good, ...patch });
  assert.equal(bad({}) !== null, true);
  assert.equal(bad({ kind: 'session' }), null, 'a git record relabelled session is invalid');
  assert.equal(bad({ schema_version: 2 }), null);
  assert.equal(bad({ extra: 1 }), null);
  assert.equal(bad({ revision: 0 }), null);
  assert.equal(bad({ proposal_id: `proposal_${'0'.repeat(64)}` }), null, 'id must match the identity');
  assert.equal(bad({ decision_state: 'weird' }), null);
  assert.equal(bad({ expires_at: '2026-10-22T10:00:00.001Z' }), null);
  assert.equal(bad({ created_at: '2026-10-15T10:00:00Z', expires_at: '2026-10-22T10:00:00Z' }), null, 'milliseconds required');
  assert.equal(bad({ options: {} }), null);
  assert.equal(bad({ group_id: 'g' }), null);
  assert.equal(bad({ child_session_id: 's' }), null);
  assert.equal(bad({ handoff: {} }), null);
  assert.notEqual(bad({ restore_requires_confirmation: true }), null, 'a trusted archive restore may flag any kind');
  assert.equal(bad({ restore_requires_confirmation: 'yes' }), null, 'the flag is a boolean');
  assert.equal(bad({ restore_requires_confirmation: null }), null);
  const command = makeCommand();
  assert.notEqual(R.normalizeProposalRecord({ ...command, restore_requires_confirmation: true }), null, 'command records carry it too');
  assert.equal(bad({ execution: { status: 'x', exit_code: null, cleanup: null } }), null, 'git has no execution');
  assert.equal(bad({ normalized_input: { ...good.normalized_input, paths: ['z', 'a'] } }), null, 'stored input must be canonical');
  assert.equal(bad({ dispatch_key: 'k', dispatch_key_sha256: HEX }), null, 'hash must match the key');
  assert.equal(bad({ dispatch_key: 'k', dispatch_key_sha256: null }), null);
  assert.equal(bad({ last_error: { code: 'CMP-PROPOSAL-0013', reason: 'x', retryable: false, cause_code: null } }), null);
  assert.equal(bad({ action_state: 'queued' }), null, 'pending requires action none');
  assert.equal(bad({ decision_state: 'accepted', action_state: 'queued' }), null, 'accepted requires a decision');
  assert.equal(R.normalizeProposalRecord(null), null);
  assert.equal(R.normalizeProposalRecord([]), null);
  const missing = { ...good };
  delete missing.execution;
  assert.equal(R.normalizeProposalRecord(missing), null);
  const cmdRecord = makeCommand(2);
  assert.equal(R.normalizeProposalRecord({ ...cmdRecord, execution: { status: 'running', exit_code: null, cleanup: null } }) !== null, true);
  assert.equal(R.normalizeProposalRecord({ ...cmdRecord, execution: { status: 'running', exit_code: null, cleanup: 'maybe' } }), null);
});

test('a stored command record re-validates D4 and the sandbox cap with its own binding', () => {
  const sh = makeCommand(3, 'a\nb');
  assert.notEqual(R.normalizeProposalRecord(sh), null);
  const forged = { ...sh, binding: commandBinding('a\nb', { shell: 'cmd.exe' }) };
  assert.equal(R.normalizeProposalRecord(forged), null);
  const slow = { ...sh, normalized_input: { ...sh.normalized_input, timeout_seconds: 121 }, binding: commandBinding('a\nb', { backend: 'docker' }) };
  assert.equal(R.normalizeProposalRecord(slow), null);
});

test('isUnresolved: pending or accepted-and-unsettled only', () => {
  const pending = makeGit();
  assert.equal(R.isUnresolved(pending), true);
  assert.equal(R.isUnresolved(null), false);
  const queued = R.acceptGitDecision(pending, { decisionId: DECISION, choice: 'commit', now: NOW, attemptId: ATTEMPT });
  assert.equal(R.isUnresolved(queued), true);
  assert.equal(R.isUnresolved(R.markDispatchRefused(queued, { runtimeUnavailable: true })), true, 'needs_attention is unresolved');
  assert.equal(R.isUnresolved(R.markContinuationOutcome(queued, 'succeeded')), false);
  assert.equal(R.isUnresolved(R.markContinuationOutcome(queued, 'failed')), false);
  assert.equal(R.isUnresolved(R.markContinuationOutcome(queued, 'cancelled')), false);
  assert.equal(R.isUnresolved(R.dismissProposal(pending, { decisionId: DECISION, now: NOW })), false);
  assert.equal(R.isUnresolved(R.expireIfDue(pending, new Date(NOW.getTime() + 8 * DAY))), false);
  assert.equal(R.isUnresolved(R.markStale(pending)), false);
});

test('expiry: exactly at expires_at, pending only, input untouched', () => {
  const pending = makeGit();
  assert.equal(R.expireIfDue(pending, new Date(NOW.getTime() + 7 * DAY - 1)), null);
  const expired = R.expireIfDue(pending, new Date(NOW.getTime() + 7 * DAY));
  assert.equal(expired.decision_state, 'expired');
  assert.equal(expired.action_state, 'none');
  assert.equal(expired.revision, 2);
  assert.equal(pending.revision, 1, 'input record is not mutated');
  assert.notEqual(R.normalizeProposalRecord(expired), null);
  assert.equal(R.expireIfDue(expired, new Date(NOW.getTime() + 30 * DAY)), null);
  const accepted = R.acceptGitDecision(pending, { decisionId: DECISION, choice: 'commit', now: NOW });
  assert.equal(R.expireIfDue(accepted, new Date(NOW.getTime() + 30 * DAY)), null, 'accepted work does not expire');
  assert.equal(R.dismissProposal(pending, { decisionId: DECISION, now: new Date(NOW.getTime() + 8 * DAY) }), null, 'no choice after expiry');
  assert.equal(R.acceptGitDecision(pending, { decisionId: DECISION, choice: 'commit', now: new Date(NOW.getTime() + 8 * DAY) }), null);
});

test('pruneFinalized keeps unresolved forever, drops receipts older than 30 days and caps at 1024', () => {
  const old = new Date(NOW.getTime() - 40 * DAY);
  const fresh = makeGit(1);
  const oldPending = R.createProposalRecord({ ...identity(2), kind: 'git', now: old, input: fresh.normalized_input, binding: fresh.binding }).record;
  const oldDismissed = R.dismissProposal(
    R.createProposalRecord({ ...identity(3), kind: 'git', now: old, input: fresh.normalized_input, binding: fresh.binding }).record,
    { decisionId: DECISION, now: old },
  );
  const oldQueued = R.acceptGitDecision(
    R.createProposalRecord({ ...identity(4), kind: 'git', now: old, input: fresh.normalized_input, binding: fresh.binding }).record,
    { decisionId: DECISION, choice: 'commit', now: old },
  );
  const recentDone = R.dismissProposal(makeGit(5), { decisionId: DECISION, now: NOW });
  const kept = R.pruneFinalized([oldPending, oldDismissed, oldQueued, recentDone, fresh], NOW);
  assert.deepEqual(kept.map((r) => r.proposal_id), [oldPending, oldQueued, recentDone, fresh].map((r) => r.proposal_id));

  const many = [];
  for (let i = 0; i < 1030; i += 1) {
    const at = new Date(NOW.getTime() - (2000 - i) * 1000);
    const made = R.createProposalRecord({ ...identity(100 + i), kind: 'git', now: at, input: fresh.normalized_input, binding: fresh.binding }).record;
    many.push(R.dismissProposal(made, { decisionId: DECISION, now: at }));
  }
  many.push(oldPending);
  const pruned = R.pruneFinalized(many, NOW);
  assert.equal(pruned.length, 1024 + 1, '1024 finalized plus the protected unresolved');
  assert.equal(pruned.includes(oldPending), true);
  assert.equal(pruned.includes(many[0]), false, 'the oldest finalized receipts are dropped');
  assert.equal(pruned.includes(many[1029]), true, 'the latest are kept');
});

test('Git state machine: accept -> ack -> admitted -> settled, each step bumps the proposal revision', () => {
  const pending = makeGit();
  const queued = R.acceptGitDecision(pending, { decisionId: DECISION, choice: 'test_first', now: NOW, attemptId: ATTEMPT });
  assert.equal(queued.decision_state, 'accepted');
  assert.equal(queued.action_state, 'queued');
  assert.equal(queued.revision, 2);
  assert.equal(queued.attempt_number, 1);
  assert.equal(queued.attempt_id, ATTEMPT);
  assert.deepEqual(queued.decision, {
    decision_id: DECISION, accepted_revision: 2, choice: 'test_first', accepted_at: '2026-10-15T10:00:00.000Z',
    options: null, confirmed_preconditions: null,
  });
  assert.equal(queued.dispatch_key, `proposal:${queued.proposal_id}:${DECISION}:local`);
  assert.equal(queued.dispatch_key_sha256, R.sha256Hex(queued.dispatch_key));
  assert.notEqual(R.normalizeProposalRecord(queued), null);

  const acked = R.markDispatchAcknowledged(queued, { workId: 'work_1', turnId: 'turn_c' });
  assert.equal(acked.action_state, 'queued');
  assert.equal(acked.continuation_work_id, 'work_1');
  assert.equal(acked.continuation_turn_id, 'turn_c');
  assert.equal(acked.revision, 3);
  const admitted = R.markAdmitted(acked);
  assert.equal(admitted.action_state, 'admitted');
  assert.equal(admitted.continuation_turn_id, 'turn_c');
  assert.equal(admitted.revision, 4);
  assert.equal(R.markAdmitted(admitted), null, 'already admitted');
  for (const outcome of ['succeeded', 'failed', 'cancelled']) {
    const settled = R.markContinuationOutcome(admitted, outcome);
    assert.equal(settled.action_state, outcome);
    assert.equal(settled.revision, 5);
    assert.notEqual(R.normalizeProposalRecord(settled), null);
    assert.equal(R.markContinuationOutcome(settled, 'failed'), null, 'terminal states do not transition');
    assert.equal(R.markOutcomeUnknown(settled), null);
  }
  assert.equal(R.markContinuationOutcome(acked, 'succeeded').action_state, 'succeeded', 'a fast turn can settle from queued');
  assert.equal(R.markContinuationOutcome(admitted, 'weird'), null);
  assert.equal(R.markAdmitted(pending), null);
  assert.equal(R.markDispatchAcknowledged(pending, { workId: 'w' }), null);
});

test('accept validates choice, kind and decision id; dismiss works for both kinds', () => {
  const pending = makeGit();
  assert.equal(R.acceptGitDecision(pending, { decisionId: DECISION, choice: 'dismiss', now: NOW }), null);
  assert.equal(R.acceptGitDecision(pending, { decisionId: DECISION, choice: 'run', now: NOW }), null);
  assert.equal(R.acceptGitDecision(pending, { decisionId: 'not-a-uuid', choice: 'commit', now: NOW }), null);
  assert.equal(R.acceptGitDecision(makeCommand(), { decisionId: DECISION, choice: 'commit', now: NOW }), null);
  const first = R.acceptGitDecision(pending, { decisionId: DECISION, choice: 'commit', now: NOW });
  assert.equal(R.acceptGitDecision(first, { decisionId: DECISION, choice: 'commit', now: NOW }), null, 'accepted records accept no second choice');
  for (const record of [pending, makeCommand(7)]) {
    const dismissed = R.dismissProposal(record, { decisionId: DECISION, now: NOW });
    assert.equal(dismissed.decision_state, 'dismissed');
    assert.equal(dismissed.action_state, 'none');
    assert.equal(dismissed.decision.choice, 'dismiss');
    assert.equal(dismissed.attempt_number, 0);
    assert.notEqual(R.normalizeProposalRecord(dismissed), null);
    assert.equal(R.dismissProposal(dismissed, { decisionId: ATTEMPT, now: NOW }), null, 'dismiss is final');
  }
});

test('decision replay: same payload, different payload, other id', () => {
  const queued = R.acceptGitDecision(makeGit(), { decisionId: DECISION, choice: 'commit', now: NOW });
  assert.equal(R.classifyDecisionReplay(queued, { decisionId: DECISION, choice: 'commit' }), 'same');
  assert.equal(R.classifyDecisionReplay(queued, { decisionId: DECISION, choice: 'test_first' }), 'conflict');
  assert.equal(R.classifyDecisionReplay(queued, { decisionId: DECISION, choice: 'commit', confirmedPreconditions: [0] }), 'conflict');
  assert.equal(R.classifyDecisionReplay(queued, { decisionId: ATTEMPT, choice: 'commit' }), 'none');
  assert.equal(R.classifyDecisionReplay(makeGit(), { decisionId: DECISION, choice: 'commit' }), 'none');
});

test('dispatch refusal maps to 0002 (runtime unavailable) or 0011, both retryable', () => {
  const queued = R.acceptGitDecision(makeGit(), { decisionId: DECISION, choice: 'commit', now: NOW });
  const unavailable = R.markDispatchRefused(queued, { runtimeUnavailable: true });
  assert.equal(unavailable.action_state, 'needs_attention');
  assert.deepEqual(unavailable.last_error, { code: 'CMP-PROPOSAL-0002', reason: 'unavailable', retryable: true, cause_code: 'runtime_unavailable' });
  assert.equal(R.markDispatchRefused(queued, { runtimeUnavailable: true, causeCode: 'runtime_closing' }).last_error.cause_code, 'runtime_closing');
  const failed = R.markDispatchRefused(queued, { causeCode: 'bad_request' });
  assert.deepEqual(failed.last_error, { code: 'CMP-PROPOSAL-0011', reason: 'dispatch_failed', retryable: true, cause_code: 'bad_request' });
  assert.notEqual(R.normalizeProposalRecord(failed), null);
  assert.equal(R.markDispatchRefused(failed, {}), null);
});

test('D5 retry: only after a pre-admission dispatch failure, with the SAME dispatch key', () => {
  const queued = R.acceptGitDecision(makeGit(), { decisionId: DECISION, choice: 'commit', now: NOW, attemptId: ATTEMPT });
  const refused = R.markDispatchRefused(queued, { runtimeUnavailable: true });
  assert.equal(R.canRetry(refused), true);
  const retried = R.prepareRetry(refused, { attemptId: '33333333-3333-4333-8333-333333333333' });
  assert.equal(retried.action_state, 'queued');
  assert.equal(retried.dispatch_key, queued.dispatch_key);
  assert.equal(retried.dispatch_key_sha256, queued.dispatch_key_sha256);
  assert.equal(retried.attempt_number, 2);
  assert.equal(retried.last_error, null);
  assert.equal(retried.revision, refused.revision + 1);
  assert.equal(R.canRetry(R.markDispatchRefused(queued, {})), true);
  const unknown = R.markOutcomeUnknown(R.markAdmitted(queued));
  assert.equal(unknown.action_state, 'needs_attention');
  assert.deepEqual(unknown.last_error, { code: 'CMP-PROPOSAL-0012', reason: 'outcome_unknown', retryable: false, cause_code: 'restart' });
  assert.equal(R.canRetry(unknown), false, 'never after admission');
  assert.equal(R.prepareRetry(unknown), null);
  assert.equal(R.prepareRetry(queued), null);
  assert.equal(R.prepareRetry(makeGit(9)), null);
});

test('D7 markStale: pending only, 0007 authority_changed, no choice afterwards', () => {
  const pending = makeGit();
  const stale = R.markStale(pending, { causeCode: 'head_changed' });
  assert.equal(stale.decision_state, 'stale');
  assert.equal(stale.action_state, 'none');
  assert.deepEqual(stale.last_error, { code: 'CMP-PROPOSAL-0007', reason: 'authority_changed', retryable: false, cause_code: 'head_changed' });
  assert.notEqual(R.normalizeProposalRecord(stale), null);
  assert.equal(R.acceptGitDecision(stale, { decisionId: DECISION, choice: 'commit', now: NOW }), null);
  assert.equal(R.dismissProposal(stale, { decisionId: DECISION, now: NOW }), null);
  assert.equal(R.markStale(stale), null);
  assert.equal(R.markStale(R.acceptGitDecision(pending, { decisionId: DECISION, choice: 'commit', now: NOW })), null);
});

test('projection of a pending git record: actions, display and no internals', () => {
  const p = R.projectProposal(makeGit(1, { paths: ['b.js', 'a.js'] }), { now: NOW, runMode: 'agent', readOnly: false });
  assert.equal(p.schema_version, 1);
  assert.equal(p.kind, 'git');
  assert.deepEqual(p.display, { summary: 'S', question: 'Q?', paths: ['a.js', 'b.js'], path_count: 2 });
  assert.deepEqual(p.actions, {
    commit: { available: true, reason: null },
    test_first: { available: true, reason: null },
    dismiss: { available: true, reason: null },
    cancel: { available: false, reason: 'not_applicable' },
    retry: { available: false, reason: 'not_applicable' },
  });
  assert.equal(p.decision, null);
  assert.deepEqual(p.links, { continuation_turn_id: null, continuation_work_id: null, command_tool_call_id: null });
  assert.equal(p.execution, null);
  assert.equal(p.last_error, null);
  const text = JSON.stringify(p);
  for (const hidden of ['binding', 'root_identity', 'dispatch_key', 'fingerprint', 'command_sha256', 'source_session_incarnation']) {
    assert.equal(text.includes(hidden), false, hidden);
  }
  p.display.paths.push('x');
});

test('projection D6: plan mode and read-only block commit/test_first/run but keep dismiss', () => {
  const pending = makeGit();
  const plan = R.projectProposal(pending, { now: NOW, runMode: 'plan' });
  assert.deepEqual(plan.actions.commit, { available: false, reason: 'plan_mode' });
  assert.deepEqual(plan.actions.test_first, { available: false, reason: 'plan_mode' });
  assert.deepEqual(plan.actions.dismiss, { available: true, reason: null });
  const ro = R.projectProposal(pending, { now: NOW, runMode: 'agent', readOnly: true });
  assert.deepEqual(ro.actions.commit, { available: false, reason: 'read_only' });
  assert.deepEqual(R.projectProposal(pending, { now: NOW, runMode: 'plan', readOnly: true }).actions.commit, { available: false, reason: 'read_only' });
  assert.equal(R.projectProposal(pending, { now: NOW }).actions.commit.available, true, 'mode defaults to agent');
});

test('projection of a pending command record: run support, mode gates, display', () => {
  const record = makeCommand(1, 'npm test', { binding: { backend: 'docker' } });
  const p = R.projectProposal(record, { now: NOW, runMode: 'agent', readOnly: false, commandRunSupported: false });
  assert.deepEqual(p.display, {
    command: 'npm test', cwd: '.', purpose: 'Run tests', timeout_seconds: 30, expected_exit_codes: [0],
    preconditions: [{ text: 'Server is stopped' }], backend: 'docker', shell: '/bin/sh',
  });
  assert.deepEqual(p.actions.run, { available: false, reason: 'unsupported_capability' });
  assert.deepEqual(p.actions.dismiss, { available: true, reason: null });
  assert.equal('commit' in p.actions, false);
  assert.equal('test_first' in p.actions, false);
  assert.deepEqual(R.projectProposal(record, { now: NOW, commandRunSupported: true }).actions.run, { available: true, reason: null });
  assert.deepEqual(R.projectProposal(record, { now: NOW, commandRunSupported: true, runMode: 'plan' }).actions.run, { available: false, reason: 'plan_mode' });
  assert.deepEqual(R.projectProposal(record, { now: NOW, commandRunSupported: true, readOnly: true }).actions.run, { available: false, reason: 'read_only' });
  const gitOnly = R.projectProposal(makeGit(), { now: NOW });
  assert.equal('run' in gitOnly.actions, false);
});

test('projection of an accepted command: tool call id link, cancel for queued|admitted only, never retry', () => {
  const CR = require('../services/backend/chat-proposal-command-records');
  const accepted = CR.acceptCommandDecision(makeCommand(1), { decisionId: DECISION, now: NOW, confirmedPreconditions: [0] });
  const ctx = { now: NOW, commandRunSupported: true };
  const queued = R.projectProposal(accepted, ctx);
  assert.equal(queued.links.command_tool_call_id, `pcmd_${R.sha256Hex(`${accepted.proposal_id}:${DECISION}`).slice(0, 32)}`);
  assert.deepEqual(queued.actions.cancel, { available: true, reason: null });
  assert.deepEqual(queued.actions.retry, { available: false, reason: 'not_applicable' });
  assert.deepEqual(queued.actions.run, { available: false, reason: 'accepted' });
  const admitted = CR.markCommandProgress(accepted, { status: 'running' });
  assert.equal(R.projectProposal(admitted, ctx).actions.cancel.available, true);
  assert.deepEqual(R.projectProposal(admitted, ctx).execution, { status: 'running', exit_code: null, cleanup: null });
  for (const settled of [
    CR.markCommandOutcome(admitted, { status: 'succeeded', exitCode: 0, cleanup: 'confirmed' }),
    CR.markCommandOutcome(admitted, { status: 'interrupted_unknown' }),
    CR.markCommandRefused(accepted, { causeCode: 'x' }),
  ]) {
    const projected = R.projectProposal(settled, ctx);
    assert.equal(projected.actions.cancel.available, false);
    assert.equal(projected.actions.retry.available, false, 'a command never offers Retry, even from a needs_attention it caused');
  }
  assert.equal(R.projectProposal(makeCommand(2), ctx).links.command_tool_call_id, null, 'no run decision yet');
  assert.equal(R.projectProposal(makeGit(), ctx).links.command_tool_call_id, null);
  assert.doesNotMatch(JSON.stringify(queued), /dispatch|sha256|root_identity/u);
});

test('projection of non-pending states: choices unavailable with the state as reason', () => {
  const pending = makeGit();
  const stale = R.projectProposal(R.markStale(pending, { causeCode: 'ref_changed' }), { now: NOW });
  assert.equal(stale.decision_state, 'stale');
  assert.deepEqual(stale.actions.commit, { available: false, reason: 'stale' });
  assert.deepEqual(stale.actions.dismiss, { available: false, reason: 'stale' });
  assert.equal(stale.last_error.code, 'CMP-PROPOSAL-0007');
  const dismissed = R.projectProposal(R.dismissProposal(pending, { decisionId: DECISION, now: NOW }), { now: NOW });
  assert.deepEqual(dismissed.actions.commit, { available: false, reason: 'dismissed' });
  assert.equal(dismissed.decision.choice, 'dismiss');
  const lateNow = new Date(NOW.getTime() + 8 * DAY);
  const effective = R.projectProposal(pending, { now: lateNow });
  assert.equal(effective.decision_state, 'expired', 'a due pending record projects as expired before it is swept');
  assert.deepEqual(effective.actions.commit, { available: false, reason: 'expired' });
  assert.deepEqual(effective.actions.dismiss, { available: false, reason: 'expired' });
  const persisted = R.projectProposal(R.expireIfDue(pending, lateNow), { now: lateNow });
  assert.equal(persisted.decision_state, 'expired');
});

test('projection of accepted records: cancel on queued/admitted, retry per D5 with mode gates', () => {
  const queued = R.acceptGitDecision(makeGit(), { decisionId: DECISION, choice: 'commit', now: NOW });
  const pq = R.projectProposal(queued, { now: NOW });
  assert.deepEqual(pq.actions.cancel, { available: true, reason: null });
  assert.deepEqual(pq.actions.commit, { available: false, reason: 'accepted' });
  assert.deepEqual(pq.actions.retry, { available: false, reason: 'not_applicable' });
  assert.deepEqual(pq.decision, { choice: 'commit', accepted_at: '2026-10-15T10:00:00.000Z', accepted_revision: 2 });
  const acked = R.markDispatchAcknowledged(queued, { workId: 'work_1', turnId: 'turn_c' });
  assert.deepEqual(R.projectProposal(acked, { now: NOW }).links, { continuation_turn_id: 'turn_c', continuation_work_id: 'work_1', command_tool_call_id: null });
  const admitted = R.markAdmitted(acked);
  assert.equal(R.projectProposal(admitted, { now: NOW }).actions.cancel.available, true);
  const done = R.markContinuationOutcome(admitted, 'succeeded');
  assert.deepEqual(R.projectProposal(done, { now: NOW }).actions.cancel, { available: false, reason: 'not_applicable' });
  assert.equal(R.projectProposal(done, { now: NOW }).action_state, 'succeeded');
  const attention = R.markDispatchRefused(queued, { runtimeUnavailable: true });
  const pa = R.projectProposal(attention, { now: NOW });
  assert.deepEqual(pa.actions.retry, { available: true, reason: null });
  assert.deepEqual(pa.actions.cancel, { available: false, reason: 'not_applicable' });
  assert.equal(pa.last_error.code, 'CMP-PROPOSAL-0002');
  assert.deepEqual(R.projectProposal(attention, { now: NOW, runMode: 'plan' }).actions.retry, { available: false, reason: 'plan_mode' });
  assert.deepEqual(R.projectProposal(attention, { now: NOW, readOnly: true }).actions.retry, { available: false, reason: 'read_only' });
  const unknown = R.projectProposal(R.markOutcomeUnknown(admitted), { now: NOW });
  assert.deepEqual(unknown.actions.retry, { available: false, reason: 'not_applicable' });
  assert.equal(unknown.last_error.code, 'CMP-PROPOSAL-0012');
});

test('error code map covers CMP-PROPOSAL-0001..0012 in order', () => {
  assert.deepEqual(Object.values(R.PROPOSAL_ERROR_CODES), Array.from({ length: 12 }, (_, i) => `CMP-PROPOSAL-${String(i + 1).padStart(4, '0')}`));
  assert.equal(R.PROPOSAL_ERROR_CODES.authority_changed, 'CMP-PROPOSAL-0007');
  assert.equal(R.PROPOSAL_ERROR_CODES.outcome_unknown, 'CMP-PROPOSAL-0012');
  assert.equal(R.isUuid(crypto.randomUUID()), true);
  assert.equal(R.isUuid('x'), false);
});
