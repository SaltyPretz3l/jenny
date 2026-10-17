'use strict';

/* Row 59 checkpoint 3 batch-review fixes at the record layer: settled non-retryable
 * receipts, the offline-lockdown Run gate, invisible/bidi refusal and lowercase ids. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../services/backend/chat-proposal-records');
const {
  NOW, DAY, DECISION, ATTEMPT, identity, makeGit, makeCommand, git, cmd, causeOf,
} = require('./helpers/chat-proposal-records-fixture');

const ch = (code) => String.fromCharCode(code);

test('review #3: a non-retryable needs_attention receipt is settled for caps and pruning', () => {
  const CR = require('../services/backend/chat-proposal-command-records');
  const queued = R.acceptGitDecision(makeGit(), { decisionId: DECISION, choice: 'commit', now: NOW, attemptId: ATTEMPT });
  const retryable = R.markDispatchRefused(queued, { runtimeUnavailable: true });
  assert.equal(retryable.last_error.retryable, true);
  assert.equal(R.isUnresolved(retryable), true, 'a Retry-able record still counts');
  const gitUnknown = R.markOutcomeUnknown(R.markAdmitted(queued));
  assert.equal(R.isUnresolved(gitUnknown), false);
  const accepted = CR.acceptCommandDecision(makeCommand(1), { decisionId: DECISION, now: NOW, confirmedPreconditions: [0] });
  const commandUnknown = CR.markCommandOutcome(CR.markCommandProgress(accepted, { status: 'running' }), { status: 'interrupted_unknown' });
  assert.equal(commandUnknown.action_state, 'needs_attention');
  assert.equal(R.isUnresolved(commandUnknown), false);
  assert.equal(R.isUnresolved(CR.markCommandRefused(accepted, { causeCode: 'dispatch_lost' })), false);
  // Pruning: an old non-retryable receipt goes; an old retryable one stays.
  const old = new Date(NOW.getTime() - 40 * DAY);
  const base = makeGit(7);
  const oldQueued = R.acceptGitDecision(
    R.createProposalRecord({ ...identity(8), kind: 'git', now: old, input: base.normalized_input, binding: base.binding }).record,
    { decisionId: DECISION, choice: 'commit', now: old, attemptId: ATTEMPT });
  const oldUnknown = R.markOutcomeUnknown(R.markAdmitted(oldQueued));
  const oldRetryable = R.markDispatchRefused(
    R.acceptGitDecision(
      R.createProposalRecord({ ...identity(9), kind: 'git', now: old, input: base.normalized_input, binding: base.binding }).record,
      { decisionId: DECISION, choice: 'commit', now: old, attemptId: ATTEMPT }),
    { runtimeUnavailable: true });
  const kept = R.pruneFinalized([oldUnknown, oldRetryable], NOW);
  assert.deepEqual(kept.map((r) => r.proposal_id), [oldRetryable.proposal_id]);
});

test('review #1: offline lockdown makes Run unavailable with its own reason', () => {
  const ctx = { now: NOW, commandRunSupported: true };
  assert.equal(R.projectProposal(makeCommand(1), ctx).actions.run.available, true);
  assert.deepEqual(R.projectProposal(makeCommand(1), { ...ctx, lockdown: true }).actions.run, { available: false, reason: 'lockdown' });
  assert.deepEqual(R.projectProposal(makeCommand(1), { ...ctx, lockdown: true, readOnly: true }).actions.run,
    { available: false, reason: 'read_only' }, 'read-only keeps precedence');
});

test('review #2: invisible and bidi characters are refused in commands, cwd and Git paths', () => {
  for (const code of [0x1b, 0x0b, 0x7f, 0x85, 0xad, 0x061c, 0x200b, 0x200e, 0x202e, 0x2066, 0xfeff]) {
    assert.equal(causeOf(cmd({ command: `echo a${ch(code)}b` })), 'invisible_characters', `U+${code.toString(16)}`);
    assert.equal(cmd({ cwd: `src${ch(code)}x` }).ok, false, `cwd U+${code.toString(16)}`);
    assert.equal(git({ paths: [`a${ch(code)}.js`] }).ok, false, `path U+${code.toString(16)}`);
  }
  for (const text of ['echo\ta', 'echo a\nb', 'echo a\r\nb', 'echo café', `echo ${ch(0x4e2d)}`]) {
    assert.equal(cmd({ command: text }).ok, true, JSON.stringify(text));
  }
  assert.equal(git({ paths: [`caf${ch(0xe9)}.js`] }).ok, true);
});

test('review #13: decision ids are lowercase only', () => {
  assert.equal(R.isUuid(DECISION), true);
  assert.equal(R.isUuid('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true);
  assert.equal(R.isUuid('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), false);
});
