'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const toolManifest = require('../services/tools/tool-manifest.json');
const proposeGitActionTool = require('../services/tools/builtin/propose-git-action-tool');
const proposeCommandTool = require('../services/tools/builtin/propose-command-tool');

const PROPOSAL_ID = `proposal_${'a'.repeat(64)}`;
const SECRET_COMMAND = 'npm run build -- --token=do-not-echo';
const SECRET_PATH = 'src/secret-file-name.js';

// The record, binding and service owners are separate modules; every test
// injects stubs through `context.proposalDeps` and `backendService.chatProposals`.
function makeHarness({ summary = { id: 'sess_1', run_mode: 'ask', plan_mode: false }, publishResult = null } = {}) {
  const projectAuthority = Object.freeze({
    project_id: 'project_1', root_path: require('os').tmpdir(), root_id: 'root_1', root_revision: 1, device_id: 'dev_1', inode: 'ino_1',
  });
  const authority = new SessionExecutionAuthority({
    projectAuthority: {
      _sessionStore: { getSessionSummary: () => summary },
      captureSession: () => projectAuthority,
      requireCurrent: (captured) => captured,
    },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    randomUUID: () => 'authority_revision_1',
  });
  const executionAuthority = authority.captureSession('sess_1', {
    requestId: 'stream_1', mode: 'assist', approvalMode: 'prompt',
  });
  const calls = { published: [], captured: [], validated: [] };
  const state = { activeTurn: { stream_id: 'stream_1', turn_id: 'turn_1', session_incarnation: 'inc_1' } };
  const backendService = {
    sessionStore: { getActiveTurn: () => state.activeTurn },
    chatProposals: {
      async publish(request) {
        calls.published.push(request);
        return publishResult || {
          ok: true,
          created: true,
          proposal: {
            proposal_id: PROPOSAL_ID, revision: 1, decision_state: 'pending', action_state: 'none',
          },
        };
      },
    },
  };
  const deps = {
    records: {
      normalizeGitProposalInput(args) {
        calls.validated.push({ kind: 'git', args });
        if (!args || typeof args.summary !== 'string' || !Array.isArray(args.paths) || !args.paths.length) {
          return { ok: false, reason: 'invalid_request', cause_code: 'field_summary' };
        }
        return { ok: true, value: { schema_version: 1, summary: args.summary, question: args.question, paths: [...args.paths].sort() } };
      },
      normalizeCommandProposalInput(args, options) {
        calls.validated.push({ kind: 'command', args, options });
        if (!args || typeof args.command !== 'string' || !args.command.trim()) {
          return { ok: false, reason: 'invalid_request', cause_code: 'field_command' };
        }
        if (options?.backend === 'docker' && args.timeout_seconds > 120) {
          return { ok: false, reason: 'invalid_request', cause_code: 'timeout_sandbox_limit' };
        }
        if (options?.shell === 'cmd.exe' && /\n/.test(args.command)) {
          return { ok: false, reason: 'invalid_request', cause_code: 'multiline_cmd_exe' };
        }
        return { ok: true, value: { schema_version: 1, command: args.command, cwd: args.cwd || '.', purpose: args.purpose } };
      },
    },
    binding: {
      async captureGitProposalBinding(request) {
        calls.captured.push({ kind: 'git', request });
        return { ok: true, binding: { git: { ref: 'refs/heads/main', head: 'f'.repeat(40), paths: [], fingerprint: '0'.repeat(64) } } };
      },
      async captureCommandProposalBinding(request) {
        calls.captured.push({ kind: 'command', request });
        return { ok: true, binding: { command: { backend: 'native', shell: '/bin/sh', cwd: '.', command_sha256: '1'.repeat(64) } } };
      },
    },
  };
  const context = {
    sessionId: 'sess_1',
    streamId: 'stream_1',
    logicalTurnId: 'turn_1',
    sessionIncarnation: 'inc_1',
    callId: 'call_1',
    executionAuthority,
    backendService,
    proposalDeps: deps,
    abortSignal: null,
  };
  return { context, calls, deps, state, backendService, summary };
}

const GIT_ARGS = { summary: 'Two files changed', question: 'Commit these?', paths: [SECRET_PATH, 'a.js'] };
const COMMAND_ARGS = { command: SECRET_COMMAND, cwd: '.', purpose: 'Build the app' };

test('propose_git_action publishes a validated, bound proposal and returns metadata only', async () => {
  const { context, calls } = makeHarness();
  const result = await proposeGitActionTool.execute(GIT_ARGS, context);

  assert.equal(result.isError, false);
  assert.deepEqual(result.metadata, {
    schema_version: 1, result_kind: 'git_proposal', proposal_id: PROPOSAL_ID,
    revision: 1, decision_state: 'pending', action_state: 'none',
  });
  assert.equal(calls.published.length, 1);
  const request = calls.published[0];
  assert.equal(request.kind, 'git');
  assert.equal(request.sessionId, 'sess_1');
  assert.equal(request.sessionIncarnation, 'inc_1');
  assert.equal(request.turnId, 'turn_1');
  assert.equal(request.toolCallId, 'call_1');
  assert.deepEqual(request.input.paths, ['a.js', SECRET_PATH]);
  assert.equal(calls.captured[0].request.sessionId, 'sess_1');
  assert.deepEqual(calls.captured[0].request.paths, ['a.js', SECRET_PATH]);
  assert.ok(calls.captured[0].request.trusted, 'the trusted execution binding is handed to the capture');
  const text = `${result.content}${result.summary}${JSON.stringify(result.metadata)}`;
  assert.equal(text.includes(SECRET_PATH), false);
  assert.equal(text.includes('Two files changed'), false);
  assert.match(result.content, /Commit/);
  assert.match(result.content, /Do not commit/);
});

test('a duplicate publish (created:false) is still a success with the current projection', async () => {
  const { context } = makeHarness({
    publishResult: {
      ok: true, created: false,
      proposal: { proposal_id: PROPOSAL_ID, revision: 3, decision_state: 'accepted', action_state: 'queued' },
    },
  });
  const result = await proposeGitActionTool.execute(GIT_ARGS, context);
  assert.equal(result.isError, false);
  assert.equal(result.metadata.revision, 3);
  assert.equal(result.metadata.action_state, 'queued');
});

test('propose_git_action rejects invalid arguments before any liveness, capture or publish', async () => {
  const { context, calls } = makeHarness();
  const result = await proposeGitActionTool.execute({ summary: 'x' }, context);
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'CMP-PROPOSAL-0001');
  assert.match(result.content, /field_summary/);
  assert.equal(calls.captured.length, 0);
  assert.equal(calls.published.length, 0);
});

test('propose_command captures the binding, then validates with its shell and backend', async () => {
  const { context, calls, deps } = makeHarness();
  deps.binding.captureCommandProposalBinding = async (request) => {
    calls.captured.push({ kind: 'command', request });
    return { ok: true, binding: { command: { backend: 'docker', shell: '/bin/sh', cwd: '.', command_sha256: '2'.repeat(64) } } };
  };
  const result = await proposeCommandTool.execute(COMMAND_ARGS, context);

  assert.equal(result.isError, false);
  assert.equal(result.metadata.result_kind, 'command_proposal');
  assert.equal(calls.published[0].kind, 'command');
  assert.equal(calls.captured[0].request.command, SECRET_COMMAND);
  assert.equal(calls.captured[0].request.cwd, '.');
  const commandValidations = calls.validated.filter((entry) => entry.kind === 'command');
  assert.equal(commandValidations.length, 2);
  assert.equal(commandValidations[0].options.shell, null);
  assert.deepEqual(commandValidations[1].options, { shell: '/bin/sh', backend: 'docker' });
  const text = `${result.content}${result.summary}${JSON.stringify(result.metadata)}`;
  assert.equal(text.includes('do-not-echo'), false);
  assert.match(result.content, /Copy or Run/);
});

test('a docker timeout above the sandbox limit and a multi-line cmd.exe command return validator errors', async () => {
  const docker = makeHarness();
  docker.deps.binding.captureCommandProposalBinding = async () => ({
    ok: true, binding: { command: { backend: 'docker', shell: '/bin/sh', cwd: '.', command_sha256: '2'.repeat(64) } },
  });
  const slow = await proposeCommandTool.execute({ ...COMMAND_ARGS, timeout_seconds: 200 }, docker.context);
  assert.equal(slow.isError, true);
  assert.equal(slow.errorCode, 'CMP-PROPOSAL-0001');
  assert.match(slow.content, /timeout_sandbox_limit/);
  assert.equal(docker.calls.published.length, 0);

  const windows = makeHarness();
  windows.deps.binding.captureCommandProposalBinding = async () => ({
    ok: true, binding: { command: { backend: 'native', shell: 'cmd.exe', cwd: '.', command_sha256: '3'.repeat(64) } },
  });
  const multiline = await proposeCommandTool.execute({ ...COMMAND_ARGS, command: 'echo a\necho b' }, windows.context);
  assert.equal(multiline.isError, true);
  assert.match(multiline.content, /multiline_cmd_exe/);
  assert.equal(multiline.content.includes('echo a'), false);
  assert.equal(windows.calls.published.length, 0);
});

test('binding capture failures map to coded errors and never publish', async () => {
  for (const [reason, cause, code] of [
    ['invalid_request', 'path_not_changed', 'CMP-PROPOSAL-0001'],
    ['capacity', 'binding_budget', 'CMP-PROPOSAL-0006'],
    ['authority_changed', 'root_changed', 'CMP-PROPOSAL-0007'],
  ]) {
    const { context, calls, deps } = makeHarness();
    deps.binding.captureGitProposalBinding = async () => ({ ok: false, reason, cause_code: cause });
    const result = await proposeGitActionTool.execute(GIT_ARGS, context);
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, code);
    assert.equal(calls.published.length, 0);
  }
  const { context, deps } = makeHarness();
  deps.binding.captureCommandProposalBinding = async () => { throw new Error(`boom ${SECRET_COMMAND}`); };
  const thrown = await proposeCommandTool.execute(COMMAND_ARGS, context);
  assert.equal(thrown.errorCode, 'CMP-PROPOSAL-0002');
  assert.equal(thrown.content.includes('do-not-echo'), false);
});

test('a call that is not the live one for the active turn publishes nothing (CMP-PROPOSAL-0007)', async () => {
  const mutations = {
    'no turn id': (h) => { h.context.logicalTurnId = null; },
    'no incarnation': (h) => { h.context.sessionIncarnation = ''; },
    'no execution authority': (h) => { h.context.executionAuthority = null; },
    'stream mismatch': (h) => { h.context.streamId = 'stream_other'; },
    'session mismatch': (h) => { h.context.sessionId = 'sess_other'; },
    'active stream differs': (h) => { h.state.activeTurn = { ...h.state.activeTurn, stream_id: 'stream_2' }; },
    'active turn differs': (h) => { h.state.activeTurn = { ...h.state.activeTurn, turn_id: 'turn_2' }; },
    'incarnation differs': (h) => { h.state.activeTurn = { ...h.state.activeTurn, session_incarnation: 'inc_2' }; },
    'no active turn': (h) => { h.state.activeTurn = null; },
    'run mode flipped under the binding': (h) => { h.summary.plan_mode = true; },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    for (const [tool, args] of [[proposeGitActionTool, GIT_ARGS], [proposeCommandTool, COMMAND_ARGS]]) {
      const harness = makeHarness();
      mutate(harness);
      const result = await tool.execute(args, harness.context);
      assert.equal(result.isError, true, `${tool.name}: ${label}`);
      assert.equal(result.errorCode, 'CMP-PROPOSAL-0007', `${tool.name}: ${label}`);
      assert.equal(harness.calls.published.length, 0, `${tool.name}: ${label}`);
    }
  }
});

test('the call losing liveness while the binding is captured publishes nothing', async () => {
  const { context, calls, deps, state } = makeHarness();
  deps.binding.captureGitProposalBinding = async () => {
    state.activeTurn = null;
    return { ok: true, binding: { git: {} } };
  };
  const result = await proposeGitActionTool.execute(GIT_ARGS, context);
  assert.equal(result.errorCode, 'CMP-PROPOSAL-0007');
  assert.equal(calls.published.length, 0);
});

test('an absent, failing or refusing proposal service yields coded errors and no record', async () => {
  const absent = makeHarness();
  delete absent.backendService.chatProposals;
  assert.equal((await proposeGitActionTool.execute(GIT_ARGS, absent.context)).errorCode, 'CMP-PROPOSAL-0002');

  const throwing = makeHarness();
  throwing.backendService.chatProposals.publish = async () => { throw new Error('disk'); };
  assert.equal((await proposeCommandTool.execute(COMMAND_ARGS, throwing.context)).errorCode, 'CMP-PROPOSAL-0002');

  for (const [reason, code] of [
    ['capacity', 'CMP-PROPOSAL-0006'],
    ['idempotency_conflict', 'CMP-PROPOSAL-0004'],
    ['unavailable', 'CMP-PROPOSAL-0002'],
  ]) {
    const refusing = makeHarness({ publishResult: { ok: false, error_code: code, reason, retryable: false, current_revision: null } });
    const result = await proposeGitActionTool.execute(GIT_ARGS, refusing.context);
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, code);
  }

  const malformed = makeHarness({ publishResult: { ok: true, created: true, proposal: { proposal_id: 'nope' } } });
  assert.equal((await proposeGitActionTool.execute(GIT_ARGS, malformed.context)).errorCode, 'CMP-PROPOSAL-0002');
});

test('the manifest declares flag-less, read-only, closed-schema runtime tools registered in the default registry', () => {
  const registry = createDefaultRegistry({});
  for (const name of ['propose_git_action', 'propose_command']) {
    const entry = toolManifest.tools.find((tool) => tool.name === name);
    assert.ok(entry, `${name} manifest entry`);
    assert.equal(entry.owner, 'electron');
    assert.equal(entry.tool_family, 'runtime');
    assert.equal(entry.read_only, true);
    assert.equal(entry.side_effecting, false);
    assert.equal(entry.availability.config_flag, null);
    assert.equal(entry.availability.workspace_required, true);
    assert.equal(entry.parameters.additionalProperties, false);
    assert.deepEqual(entry.parameters.properties.schema_version.enum, [1]);
    assert.equal(entry.parameters.required.includes('schema_version'), false);
    const tool = registry.getTool(name);
    assert.ok(tool, `${name} registered`);
    assert.equal(tool.workspaceRequired, true);
    assert.equal(tool.readOnly, true);
  }
  assert.deepEqual(
    toolManifest.tools.find((tool) => tool.name === 'propose_git_action').parameters.required,
    ['summary', 'question', 'paths']
  );
  assert.deepEqual(
    toolManifest.tools.find((tool) => tool.name === 'propose_command').parameters.required,
    ['command', 'cwd', 'purpose']
  );
});

test('the tools run through the executor in Plan Mode and read-only sessions and summarize without the command', async () => {
  const harness = makeHarness();
  const executor = new ToolExecutor({
    registry: createDefaultRegistry({}),
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    pathPolicy: {},
    logger: () => {},
  });
  const result = await executor.executePreApproved(
    { callId: 'call_1', toolName: 'propose_command', input: COMMAND_ARGS },
    { ...harness.context, planMode: true, readOnly: true, workingDirectory: '/ws' }
  );
  assert.equal(result.isError, false, result.content);
  assert.equal(result.metadata.result_kind, 'command_proposal');
  assert.equal(proposeCommandTool.summarize(COMMAND_ARGS).includes('do-not-echo'), false);
  assert.match(proposeGitActionTool.summarize(GIT_ARGS), /2 changed files/);
});
