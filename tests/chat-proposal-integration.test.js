'use strict';

/* Row 59 checkpoint 3 integration: the real producer tools, binding capture,
 * proposal records/store and ChatProposalService wired together with no stubs
 * between them. Only the durable runtime (FakeRuntime), the project-authority
 * owner and the session's active-turn claim are faked at their edges. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const R = require('../services/backend/chat-proposal-records');
const { PROPOSAL_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { recheckCommandBinding, recheckGitBinding } = require('../services/chat-proposal-binding');
const { WorkspaceGitService } = require('../services/workspace-git-service');
const { runWorkspaceGit } = require('../services/workspace-git-executor');
const proposeGitActionTool = require('../services/tools/builtin/propose-git-action-tool');
const proposeCommandTool = require('../services/tools/builtin/propose-command-tool');
const { createFixture } = require('./helpers/chat-proposal-service-fixture');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { windowsOnly } = require('./helpers/platform-skips');

const STREAM_ID = 'stream_it_1';
const TURN_ID = 'turn_it_1';
const CALL_ID = 'call_it_1';
const IS_WIN32 = process.platform === 'win32';
const EXPECTED_SHELL = IS_WIN32 ? 'cmd.exe' : '/bin/sh';

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

// A repo whose HEAD has a.txt/b.txt; a.txt is modified and new.txt is untracked.
function createRepo() {
  const root = createTrackedTempDir('jenny-proposal-integration-');
  git(root, ['init']);
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  for (const [key, value] of [['user.email', 'jenny@example.invalid'], ['user.name', 'Jenny Tests'],
    ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(root, ['config', key, value]);
  for (const name of ['README.md', 'a.txt', 'b.txt']) fs.writeFileSync(path.join(root, name), `${name}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'brand new\n');
  return root;
}

// Wires the real service fixture to a live-call context for one tool invocation.
function createHarness(t, { commandPorts = null } = {}) {
  const root = createRepo();
  const projectAuthority = {
    project_id: 'proj_it', root_path: root, root_id: 'root_it', root_revision: 7, device_id: 'dev_it', inode: 'ino_it',
    _sessionStore: null,
    captureSession() { return { ...this.authority }; },
    requireCurrent() {},
  };
  projectAuthority.authority = {
    project_id: 'proj_it', root_path: root, root_id: 'root_it', root_revision: 7, device_id: 'dev_it', inode: 'ino_it',
  };
  const gitService = new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_git: true }),
    exec: runWorkspaceGit,
    logger() {},
  });
  let backend;
  const commandAdapter = commandPorts && {
    isSupported: () => true,
    recheck: (record) => recheckCommandBinding(record, { backendService: backend }),
    submit: commandPorts.submit,
    cancel: () => ({ status: 'cancelled' }),
  };
  const fx = createFixture(t, { recheck: (record) => recheckGitBinding(record, { backendService: backend }), commandAdapter });
  projectAuthority._sessionStore = fx.store;
  const claim = { current: { stream_id: STREAM_ID, turn_id: TURN_ID, session_incarnation: fx.sessionIncarnation } };
  const published = [];
  backend = {
    sessionStore: Object.create(fx.store, { getActiveTurn: { value: () => claim.current } }),
    projectAuthority,
    resolveProjectWorkspaceServices: () => ({ workspaceGitService: gitService }),
    chatProposals: {
      async publish(request) {
        const out = await fx.service.publish(request);
        published.push(out);
        return out;
      },
    },
  };
  const authority = new SessionExecutionAuthority({
    projectAuthority,
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    randomUUID: () => 'authority_revision_it',
  });
  const executionAuthority = authority.captureSession(fx.sessionId, {
    requestId: STREAM_ID, mode: 'assist', approvalMode: 'prompt',
  });
  const context = (callId = CALL_ID) => ({
    sessionId: fx.sessionId,
    streamId: STREAM_ID,
    logicalTurnId: TURN_ID,
    sessionIncarnation: fx.sessionIncarnation,
    callId,
    executionAuthority,
    backendService: backend,
    abortSignal: null,
  });
  return { fx, root, backend, context, published, claim };
}

const GIT_ARGS = { summary: 'Updated a and added new.', question: 'Commit these?', paths: ['new.txt', 'a.txt'] };
const coordination = (fx) => fx.proposalStore.read(fx.sessionId).coordination_revision;

test('propose_git_action end to end: bound record, metadata, idempotent repeat', async (t) => {
  const { fx, root, context, published } = createHarness(t);
  const before = coordination(fx);

  const result = await proposeGitActionTool.execute(GIT_ARGS, context());
  assert.equal(result.isError, false, result.content);
  const proposalId = R.computeProposalId(fx.sessionIncarnation, TURN_ID, CALL_ID);
  assert.deepEqual(result.metadata, {
    schema_version: 1, result_kind: 'git_proposal', proposal_id: proposalId,
    revision: 1, decision_state: 'pending', action_state: 'none',
  });
  assert.equal(published.length, 1);
  assert.equal(published[0].created, true);
  assert.equal(JSON.stringify(result).includes('a.txt'), false, 'the result never echoes paths');

  const stored = fx.proposalStore.read(fx.sessionId);
  assert.equal(stored.records.length, 1);
  assert.equal(stored.coordination_revision, before + 1);
  const record = stored.records[0];
  assert.equal(record.proposal_id, proposalId);
  assert.equal(record.kind, 'git');
  assert.deepEqual(record.normalized_input.paths, ['a.txt', 'new.txt'], 'paths are sorted');
  assert.equal(record.binding.workspace_id, 'root_it');
  assert.equal(record.binding.authority_revision, 7);
  assert.equal(record.binding.git.ref, 'refs/heads/main');
  assert.equal(record.binding.git.head, git(root, ['rev-parse', 'HEAD']));
  const facts = Object.fromEntries(record.binding.git.paths.map((fact) => [fact.path, fact]));
  assert.equal(facts['a.txt'].worktree_oid, git(root, ['hash-object', 'a.txt']));
  assert.equal(facts['new.txt'].index_status, '?');
  assert.equal(facts['new.txt'].worktree_oid, git(root, ['hash-object', 'new.txt']));
  assert.equal(record.binding.git.fingerprint, R.sha256Hex(R.canonicalJson({
    ref: record.binding.git.ref, head: record.binding.git.head, paths: record.binding.git.paths,
  })));

  const again = await proposeGitActionTool.execute(GIT_ARGS, context());
  assert.equal(again.isError, false);
  assert.equal(again.metadata.proposal_id, proposalId);
  assert.equal(published.length, 2);
  assert.equal(published[1].created, false);
  assert.equal(published[1].proposal.proposal_id, proposalId);
  assert.equal(fx.proposalStore.read(fx.sessionId).records.length, 1);
  assert.equal(coordination(fx), before + 1, 'a replay is not a mutation');
});

test('a tool call that is not the live active turn records nothing', async (t) => {
  const { fx, context, claim } = createHarness(t);
  claim.current = { stream_id: STREAM_ID, turn_id: 'turn_other', session_incarnation: fx.sessionIncarnation };
  const result = await proposeGitActionTool.execute(GIT_ARGS, context());
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, CODES.AUTHORITY_CHANGED);
  assert.equal(fx.proposalStore.read(fx.sessionId).records.length, 0);
});

test('decide commit: durable runtime submission, queued, then succeeded on turn complete', async (t) => {
  const { fx, context } = createHarness(t);
  const { metadata } = await proposeGitActionTool.execute(GIT_ARGS, context());
  const proposal = await fx.get(metadata.proposal_id);
  assert.equal(proposal.actions.commit.available, true);

  const decisionId = randomUUID();
  const decided = await fx.service.decide(fx.request({
    proposal_id: proposal.proposal_id, expected_revision: proposal.revision, decision_id: decisionId, choice: 'commit',
  }));
  assert.equal(decided.ok, true, JSON.stringify(decided));
  assert.equal(decided.created, true);
  assert.equal(decided.proposal.decision_state, 'accepted');
  assert.equal(decided.proposal.action_state, 'queued');

  assert.equal(fx.runtime.submits.length, 1);
  const submit = fx.runtime.submits[0];
  assert.match(submit.idempotencyKey, /^pdk_[0-9a-f]{64}$/);
  assert.equal(submit.request.sessionId, fx.sessionId);
  assert.deepEqual(submit.request.proposalDecision, {
    proposal_id: proposal.proposal_id, decision_id: decisionId, accepted_revision: decided.proposal.decision.accepted_revision, choice: 'commit',
  });

  const record = fx.record(proposal.proposal_id);
  assert.equal(record.continuation_work_id, 'work_1');
  assert.equal(record.continuation_turn_id, 'turn_c1');
  assert.equal(record.dispatch_key, `proposal:${proposal.proposal_id}:${decisionId}:local`);
  assert.equal(submit.idempotencyKey, R.runtimeIdempotencyKey(record.dispatch_key_sha256));
  assert.equal(record.attempt_number, 1);

  fx.stream('turn_c1', 'complete');
  const done = fx.record(proposal.proposal_id);
  assert.equal(done.decision_state, 'accepted');
  assert.equal(done.action_state, 'succeeded');

  // Replay of the same gesture, then a new gesture with the old revision.
  const replay = await fx.service.decide(fx.request({
    proposal_id: proposal.proposal_id, expected_revision: proposal.revision, decision_id: decisionId, choice: 'commit',
  }));
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(fx.runtime.submits.length, 1, 'a replay never resubmits');
  const stale = await fx.service.decide(fx.request({
    proposal_id: proposal.proposal_id, expected_revision: proposal.revision, decision_id: randomUUID(), choice: 'commit',
  }));
  assert.deepEqual([stale.ok, stale.reason, stale.error_code], [false, 'stale_revision', CODES.STALE_REVISION]);
});

test('drift after proposing makes the record stale and refuses every further choice', async (t) => {
  const { fx, root, context } = createHarness(t);
  const { metadata } = await proposeGitActionTool.execute(GIT_ARGS, context());
  const proposal = await fx.get(metadata.proposal_id);

  fs.writeFileSync(path.join(root, 'a.txt'), 'edited after the proposal\n');
  const refused = await fx.decide(proposal, 'commit');
  assert.deepEqual([refused.ok, refused.reason, refused.error_code], [false, 'authority_changed', CODES.AUTHORITY_CHANGED]);
  assert.equal(fx.runtime.submits.length, 0);

  const record = fx.record(proposal.proposal_id);
  assert.equal(record.decision_state, 'stale');
  assert.equal(record.action_state, 'none');
  assert.equal(record.last_error.code, CODES.AUTHORITY_CHANGED);
  assert.equal(record.last_error.reason, 'authority_changed');
  assert.equal(record.last_error.retryable, false);
  assert.equal(record.last_error.cause_code, 'paths_changed');

  const current = await fx.get(proposal.proposal_id);
  const further = await fx.decide(current, 'test_first');
  assert.equal(further.ok, false);
  assert.equal(further.reason, 'authority_changed');
  assert.equal((await fx.decide(current, 'dismiss')).ok, false);
  assert.equal(fx.runtime.submits.length, 0);
});

test('propose_command end to end: bound record, Run unsupported without a command adapter, dismiss works', async (t) => {
  const { fx, context } = createHarness(t);
  const command = 'echo hello';
  const result = await proposeCommandTool.execute({ command, cwd: '.', purpose: 'Say hello' }, context('call_cmd_1'));
  assert.equal(result.isError, false, result.content);
  const proposalId = R.computeProposalId(fx.sessionIncarnation, TURN_ID, 'call_cmd_1');
  assert.deepEqual(result.metadata, {
    schema_version: 1, result_kind: 'command_proposal', proposal_id: proposalId,
    revision: 1, decision_state: 'pending', action_state: 'none',
  });
  assert.equal(JSON.stringify(result).includes('echo hello'), false, 'the result never echoes the command');

  const record = fx.record(proposalId);
  assert.equal(record.kind, 'command');
  assert.equal(record.normalized_input.command, command);
  assert.equal(record.binding.command.shell, EXPECTED_SHELL);
  assert.equal(record.binding.command.backend, 'native');
  assert.equal(record.binding.command.cwd, '.');
  assert.equal(record.binding.command.command_sha256, R.sha256Hex(Buffer.from(command, 'utf8')));
  assert.equal(record.binding.git, null);

  const proposal = await fx.get(proposalId);
  assert.equal(proposal.actions.run.available, false);
  assert.equal(proposal.actions.run.reason, 'unsupported_capability');
  const revisionBefore = coordination(fx);
  const recordBefore = JSON.stringify(fx.record(proposalId));
  const run = await fx.decide(proposal, 'run');
  assert.deepEqual([run.ok, run.reason, run.error_code], [false, 'unsupported_capability', CODES.UNSUPPORTED_CAPABILITY]);
  assert.equal(JSON.stringify(fx.record(proposalId)), recordBefore, 'Run changed nothing');
  assert.equal(coordination(fx), revisionBefore);
  assert.equal(fx.runtime.submits.length, 0);

  const dismissed = await fx.decide(proposal, 'dismiss');
  assert.equal(dismissed.ok, true, JSON.stringify(dismissed));
  assert.equal(dismissed.proposal.decision_state, 'dismissed');
  assert.equal(fx.record(proposalId).decision_state, 'dismissed');
});

test('propose_command then Run end to end: real binding recheck, accepted/queued, one durable submission', async (t) => {
  const submits = [];
  const { fx, context } = createHarness(t, {
    commandPorts: { submit: async (args) => { submits.push(args); return { ok: true, created: true, work_id: 'work_it', turn_id: 'turn_it_cmd' }; } },
  });
  const command = 'echo hello';
  const result = await proposeCommandTool.execute({ command, cwd: '.', purpose: 'Say hello' }, context('call_cmd_run'));
  assert.equal(result.isError, false, result.content);
  const proposalId = R.computeProposalId(fx.sessionIncarnation, TURN_ID, 'call_cmd_run');
  const proposal = await fx.get(proposalId);
  assert.equal(proposal.actions.run.available, true);
  assert.equal(proposal.links.command_tool_call_id, null);

  const run = await fx.decide(proposal, 'run');
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.proposal.action_state, 'queued');
  assert.equal(submits.length, 1);
  const { commandProposal } = submits[0];
  assert.equal(commandProposal.command_sha256, R.sha256Hex(command));
  assert.deepEqual(commandProposal.command_binding, {
    backend: 'native', shell: EXPECTED_SHELL, cwd: '.', root_revision: 7,
  });
  assert.equal(commandProposal.command_input.command, command);
  assert.equal(commandProposal.tool_call_id, run.proposal.links.command_tool_call_id);
  const record = fx.record(proposalId);
  assert.equal(record.continuation_work_id, 'work_it');
  assert.equal(record.continuation_turn_id, 'turn_it_cmd');
  assert.equal(fx.runtime.submits.length, 0);
});

test('Run recaptures the command binding: a vanished cwd or a bumped authority makes the proposal stale', async (t) => {
  const submits = [];
  const { fx, root, context } = createHarness(t, {
    commandPorts: { submit: async (args) => { submits.push(args); return { ok: true, work_id: 'w', turn_id: 't' }; } },
  });
  fs.mkdirSync(path.join(root, 'sub'));
  await proposeCommandTool.execute({ command: 'echo a', cwd: 'sub', purpose: 'A' }, context('call_cmd_a'));
  await proposeCommandTool.execute({ command: 'echo b', cwd: '.', purpose: 'B' }, context('call_cmd_b'));
  const [a, b] = ['call_cmd_a', 'call_cmd_b'].map((id) => R.computeProposalId(fx.sessionIncarnation, TURN_ID, id));

  fs.rmSync(path.join(root, 'sub'), { recursive: true });
  const vanished = await fx.decide(await fx.get(a), 'run');
  assert.deepEqual([vanished.ok, vanished.reason, vanished.error_code], [false, 'authority_changed', CODES.AUTHORITY_CHANGED]);
  assert.equal(fx.record(a).decision_state, 'stale');
  assert.equal(fx.record(a).last_error.cause_code, 'cwd_changed');

  const harnessAuthority = context().backendService.projectAuthority;
  harnessAuthority.authority.root_revision = 8;
  const bumped = await fx.decide(await fx.get(b), 'run');
  assert.equal(bumped.reason, 'authority_changed');
  assert.equal(fx.record(b).last_error.cause_code, 'authority_stale');
  assert.equal(submits.length, 0);
});

test('a multi-line command on the native cmd.exe shell is refused with no record (D4)', { skip: windowsOnly('native cmd.exe shell') }, async (t) => {
  const { fx, context } = createHarness(t);
  const before = coordination(fx);
  const result = await proposeCommandTool.execute(
    { command: 'echo one\necho two', cwd: '.', purpose: 'Two lines' }, context('call_cmd_2'),
  );
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, CODES.INVALID_REQUEST);
  assert.match(result.content, /multiline_cmd_exe/);
  assert.equal(fx.proposalStore.read(fx.sessionId).records.length, 0);
  assert.equal(coordination(fx), before);
});
