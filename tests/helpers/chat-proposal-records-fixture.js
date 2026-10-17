'use strict';

/* Shared record fixtures for the chat proposal record tests (row 59 checkpoint 3). */

const assert = require('node:assert/strict');

const R = require('../../services/backend/chat-proposal-records');

const NOW = new Date('2026-10-15T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const DECISION = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const HEX = 'a'.repeat(64);

function gitFact(path) {
  return {
    path, orig_path: null, index_status: ' ', worktree_status: 'M',
    head_oid: 'b'.repeat(40), index_oid: 'b'.repeat(40), worktree_oid: 'c'.repeat(40), worktree_kind: 'file',
  };
}

function commonBinding() {
  return {
    source_project_id: 'proj_1', workspace_id: 'root_1', root_identity: { root_id: 'root_1', device_id: '1', inode: '2' },
    authority_revision: 3, run_mode: 'agent', restrictions: { read_only: false, plan_mode: false },
    model: 'm', effort: null,
  };
}

function gitBinding(paths = ['a.js']) {
  return { ...commonBinding(), git: { ref: 'refs/heads/main', head: 'd'.repeat(40), paths: paths.map(gitFact), fingerprint: HEX }, command: null };
}

function commandBinding(command, { backend = 'native', shell = '/bin/sh', cwd = '.' } = {}) {
  return { ...commonBinding(), git: null, command: { backend, shell, cwd, command_sha256: R.sha256Hex(command) } };
}

function identity(n = 1) {
  return { sessionId: 'sess_a', sessionIncarnation: 'inc_a', turnId: `turn_${n}`, toolCallId: `call_${n}`, now: NOW };
}

function makeGit(n = 1, extra = {}) {
  const input = R.normalizeGitProposalInput({ summary: 'S', question: 'Q?', paths: ['a.js'], ...extra });
  assert.equal(input.ok, true);
  const made = R.createProposalRecord({ kind: 'git', ...identity(n), input: input.value, binding: gitBinding(input.value.paths) });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.record;
}

function makeCommand(n = 1, command = 'npm test', opts = {}) {
  const input = R.normalizeCommandProposalInput({ command, cwd: '.', purpose: 'Run tests', preconditions: [{ kind: 'user_confirmation', text: 'Server is stopped' }] }, opts);
  assert.equal(input.ok, true, JSON.stringify(input));
  const made = R.createProposalRecord({ kind: 'command', ...identity(n), input: input.value, binding: commandBinding(command, opts.binding) });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.record;
}

const git = (args) => R.normalizeGitProposalInput({ summary: 'S', question: 'Q', paths: ['a'], ...args });
const cmd = (args, opts) => R.normalizeCommandProposalInput({ command: 'ls', cwd: '.', purpose: 'p', ...args }, opts);
const causeOf = (result) => (result.ok ? null : result.cause_code);

module.exports = {
  NOW, DAY, DECISION, ATTEMPT, HEX, gitFact, commonBinding, gitBinding, commandBinding, identity, makeGit, makeCommand, git, cmd, causeOf,
};
