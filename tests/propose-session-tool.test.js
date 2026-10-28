'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const authorityModule = require('../services/backend/session-execution-authority');

// The preparation capability lives on the trusted binding (execution-authority slice). The tools read
// `trusted.handoffPreparation`, so the reader is wrapped before the tool modules load.
let preparation = null;
const realGetTrusted = authorityModule.getTrustedExecutionBinding;
authorityModule.getTrustedExecutionBinding = (binding) => {
  const trusted = realGetTrusted(binding);
  return trusted ? Object.create(trusted, { handoffPreparation: { get: () => preparation } }) : trusted;
};

const { SessionExecutionAuthority } = authorityModule;
const { createDefaultRegistry } = require('../services/tools');
const toolManifest = require('../services/tools/tool-manifest.json');
const proposeSessionTool = require('../services/tools/builtin/propose-session-tool');
const completeHandoffTool = require('../services/tools/builtin/complete-session-handoff-tool');
const { captureSessionBinding } = require('../services/chat-proposal-session-binding');

const PROPOSAL_ID = `proposal_${'a'.repeat(64)}`;
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = `group_${'b'.repeat(64)}`;
const SECRET_TITLE = 'Refactor the secret-title module';
const SECRET_TASK = 'do the secret-task thing';
const SECRET_BACKGROUND = 'secret-background details';

function makeHarness({
  summary = { id: 'sess_1', run_mode: 'ask', plan_mode: false }, projectAuthority = null,
  publishResult = null, completeResult = null, supported = true,
} = {}) {
  const authorityRecord = projectAuthority || Object.freeze({
    project_id: 'project_1', root_path: os.tmpdir(), root_id: 'root_1', root_revision: 1, device_id: 'dev_1', inode: 'ino_1',
  });
  const authority = new SessionExecutionAuthority({
    projectAuthority: {
      _sessionStore: { getSessionSummary: () => summary },
      captureSession: () => authorityRecord,
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
  const calls = { published: [], completed: [], validated: [], captured: [], supports: [] };
  const state = { activeTurn: { stream_id: 'stream_1', turn_id: 'turn_1', session_incarnation: 'inc_1' } };
  const backendService = {
    sessionStore: { getActiveTurn: () => state.activeTurn, getSessionSummary: () => summary },
    projectAuthority: { captureSession: () => authorityRecord },
    chatProposals: {
      async publish(request) {
        calls.published.push(request);
        return publishResult || { ok: true, created: true, proposal: projection() };
      },
      async completeHandoff(request) {
        calls.completed.push(request);
        return completeResult || {
          ok: true, proposal_id: PROPOSAL_ID, revision: 4, child_session_id: 'sess_2_abcdef012345',
          first_turn_work_id: 'work_1', first_turn_turn_id: 'turn_c1', admission_state: 'queued',
        };
      },
    },
  };
  const deps = {
    records: {
      normalizeSessionProposalInput(args) {
        calls.validated.push(args);
        if (!args || typeof args.title !== 'string' || !args.title.trim()) {
          return { ok: false, reason: 'invalid_request', cause_code: 'field_title' };
        }
        return {
          ok: true,
          value: {
            schema_version: 1, initiation: args.initiation, title: args.title, description: args.description ?? null,
            group_key: args.group_key ?? null, authorization_ref: args.authorization_ref ?? null,
            project_id: args.project_id ?? null,
            ...(typeof args.preferred_model === 'string' ? { preferred_model: args.preferred_model } : {}),
          },
        };
      },
    },
    binding: {
      async captureSessionBinding(context, live) {
        calls.captured.push({ context, live });
        return { ok: true, binding: { workspace_id: null, session: { source_run_mode: 'ask', lockdown: false } } };
      },
    },
    supportsProducerTool(name) {
      calls.supports.push(name);
      return supported;
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
  return { context, calls, deps, state, backendService };
}

const OFFER_ARGS = { schema_version: 1, initiation: 'offer', title: SECRET_TITLE };

function projection(overrides = {}) {
  return {
    proposal_id: PROPOSAL_ID, revision: 1, decision_state: 'pending', action_state: 'none', group_id: null,
    display: { title: SECRET_TITLE, description: null, initiation: 'offer', authorization_required: false },
    ...overrides,
  };
}

function display(initiation, authorizationRequired = false) {
  return { title: 't', description: null, initiation, authorization_required: authorizationRequired };
}

function assertNoEcho(result) {
  const text = `${result.content}${result.summary}${JSON.stringify(result.metadata)}`;
  for (const secret of [SECRET_TITLE, SECRET_TASK, SECRET_BACKGROUND]) assert.equal(text.includes(secret), false);
}

test.afterEach(() => { preparation = null; });

test('propose_session offer publishes a bound session record and ends the turn', async () => {
  const { context, calls } = makeHarness();
  const result = await proposeSessionTool.execute(OFFER_ARGS, context);

  assert.equal(result.isError, false);
  assert.deepEqual(result.metadata, {
    schema_version: 1, result_kind: 'session_proposal', proposal_id: PROPOSAL_ID, revision: 1,
    decision_state: 'pending', action_state: 'none', effective_initiation: 'offer',
    authorization_required: false, group_id: null, turn_boundary: 'awaiting_proposal',
  });
  assert.equal(result.content, 'The user now sees your offer to continue here or start a new chat. '
    + 'Stop here and wait for their choice.');
  assert.equal(calls.published.length, 1);
  const request = calls.published[0];
  assert.equal(request.kind, 'session');
  assert.equal(request.sessionId, 'sess_1');
  assert.equal(request.sessionIncarnation, 'inc_1');
  assert.equal(request.turnId, 'turn_1');
  assert.equal(request.toolCallId, 'call_1');
  assert.equal(request.input.initiation, 'offer');
  assert.equal(request.binding.session.source_run_mode, 'ask');
  assert.equal(calls.captured[0].live.sessionId, 'sess_1');
  assert.ok(calls.captured[0].live.trusted, 'the trusted execution binding reaches the capture');
  assert.deepEqual(calls.supports, ['propose_session']);
  assertNoEcho(result);
});

test('propose_session own_initiative suggestion continues the answer and carries the group', async () => {
  const { context } = makeHarness({
    publishResult: { ok: true, created: true, proposal: projection({ group_id: GROUP_ID, display: display('own_initiative') }) },
  });
  const result = await proposeSessionTool.execute(
    { schema_version: 1, initiation: 'own_initiative', title: SECRET_TITLE, group_key: 'followups' }, context);
  assert.equal(result.isError, false);
  assert.equal(result.metadata.effective_initiation, 'own_initiative');
  assert.equal(result.metadata.group_id, GROUP_ID);
  assert.equal(Object.hasOwn(result.metadata, 'turn_boundary'), false);
  assert.equal(result.content, 'The suggestion is shown to the user. It starts nothing by itself. Continue your answer.');
  assertNoEcho(result);
});

test('propose_session user_asked with a consumed grant records the request without ending the turn', async () => {
  const { context } = makeHarness({
    publishResult: {
      ok: true, created: true,
      proposal: projection({ decision_state: 'accepted', action_state: 'queued', display: display('user_asked') }),
    },
  });
  const result = await proposeSessionTool.execute(
    { schema_version: 1, initiation: 'user_asked', title: SECRET_TITLE, authorization_ref: ATTEMPT_ID }, context);
  assert.equal(result.isError, false);
  assert.equal(result.metadata.effective_initiation, 'user_asked');
  assert.equal(result.metadata.action_state, 'queued');
  assert.equal(Object.hasOwn(result.metadata, 'turn_boundary'), false);
  assert.equal(result.content, 'The user\'s request for a separate chat is recorded. Jenny prepares it after this turn. '
    + 'Do not do that task here; tell the user briefly.');
});

test('propose_session user_asked without a grant degrades to an offer that waits', async () => {
  const { context } = makeHarness({
    publishResult: { ok: true, created: true, proposal: projection({ display: display('offer', true) }) },
  });
  const result = await proposeSessionTool.execute(
    { schema_version: 1, initiation: 'user_asked', title: SECRET_TITLE }, context);
  assert.equal(result.isError, false);
  assert.equal(result.metadata.effective_initiation, 'offer');
  assert.equal(result.metadata.authorization_required, true);
  assert.equal(result.metadata.turn_boundary, 'awaiting_proposal');
  assert.equal(result.content, 'No launch authorization was found, so the user sees an offer instead. '
    + 'Stop here and wait for their choice.');
});

test('a replayed offer the user already settled does not end the turn again', async () => {
  const { context } = makeHarness({
    publishResult: {
      ok: true, created: false, proposal: projection({ revision: 3, decision_state: 'dismissed', action_state: 'none' }),
    },
  });
  const result = await proposeSessionTool.execute(OFFER_ARGS, context);
  assert.equal(result.isError, false);
  assert.equal(result.metadata.revision, 3);
  assert.equal(Object.hasOwn(result.metadata, 'turn_boundary'), false);
  assert.match(result.content, /already responded/);
});

test('propose_session refuses unsupported_capability when the producer tool was not negotiated', async () => {
  const { context, calls } = makeHarness({ supported: false });
  const result = await proposeSessionTool.execute(OFFER_ARGS, context);
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'CMP-PROPOSAL-0009');
  assert.deepEqual(result.metadata, {});
  assert.equal(calls.published.length, 0);
  assert.equal(calls.validated.length, 0);
});

test('propose_session fails closed when negotiation cannot be read', async () => {
  const { context, deps } = makeHarness();
  delete deps.supportsProducerTool;
  // The real reader needs a sidecar client; none is attached to this backend stub.
  const result = await proposeSessionTool.execute(OFFER_ARGS, context);
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'CMP-PROPOSAL-0009');
});

test('propose_session maps validation, authority and service failures without a record', async () => {
  const invalid = makeHarness();
  const bad = await proposeSessionTool.execute({ initiation: 'offer', title: '  ' }, invalid.context);
  assert.equal(bad.isError, true);
  assert.equal(bad.errorCode, 'CMP-PROPOSAL-0001');
  assert.match(bad.content, /field_title/);
  assert.equal(invalid.calls.published.length, 0);

  const stale = makeHarness();
  stale.state.activeTurn = { stream_id: 'stream_1', turn_id: 'turn_other', session_incarnation: 'inc_1' };
  const authority = await proposeSessionTool.execute(OFFER_ARGS, stale.context);
  assert.equal(authority.errorCode, 'CMP-PROPOSAL-0007');
  assert.equal(stale.calls.published.length, 0);

  const drift = makeHarness();
  drift.deps.binding.captureSessionBinding = async () => {
    drift.state.activeTurn = null;
    return { ok: true, binding: {} };
  };
  const changed = await proposeSessionTool.execute(OFFER_ARGS, drift.context);
  assert.equal(changed.errorCode, 'CMP-PROPOSAL-0007');
  assert.equal(drift.calls.published.length, 0);

  const capture = makeHarness();
  capture.deps.binding.captureSessionBinding = async () => ({ ok: false, reason: 'authority_changed', cause_code: 'authority_stale' });
  assert.equal((await proposeSessionTool.execute(OFFER_ARGS, capture.context)).errorCode, 'CMP-PROPOSAL-0007');

  const full = makeHarness({ publishResult: { ok: false, reason: 'capacity' } });
  assert.equal((await proposeSessionTool.execute(OFFER_ARGS, full.context)).errorCode, 'CMP-PROPOSAL-0006');

  const thrown = makeHarness();
  thrown.backendService.chatProposals.publish = async () => { throw new Error('boom'); };
  const unavailable = await proposeSessionTool.execute(OFFER_ARGS, thrown.context);
  assert.equal(unavailable.errorCode, 'CMP-PROPOSAL-0002');
  assert.equal(`${unavailable.content}`.includes('boom'), false);

  const malformed = makeHarness({ publishResult: { ok: true, proposal: projection({ display: { initiation: 'nonsense' } }) } });
  assert.equal((await proposeSessionTool.execute(OFFER_ARGS, malformed.context)).errorCode, 'CMP-PROPOSAL-0002');
});

const HANDOFF_ARGS = {
  schema_version: 1, proposal_id: PROPOSAL_ID, attempt_id: ATTEMPT_ID, task: SECRET_TASK, background: SECRET_BACKGROUND,
};

test('complete_session_handoff completes the handoff in its preparation turn and ends the turn', async () => {
  preparation = { proposalId: PROPOSAL_ID, attemptId: ATTEMPT_ID };
  const { context, calls } = makeHarness();
  const result = await completeHandoffTool.execute(HANDOFF_ARGS, context);

  assert.equal(result.isError, false);
  assert.deepEqual(calls.completed, [{
    sessionId: 'sess_1', sessionIncarnation: 'inc_1', turnId: 'turn_1', toolCallId: 'call_1',
    proposalId: PROPOSAL_ID, attemptId: ATTEMPT_ID, task: SECRET_TASK, background: SECRET_BACKGROUND,
  }]);
  assert.deepEqual(result.metadata, {
    schema_version: 1, result_kind: 'session_handoff', proposal_id: PROPOSAL_ID, revision: 4,
    child_session_id: 'sess_2_abcdef012345',
    first_turn_work_id: 'work_1', first_turn_turn_id: 'turn_c1', admission_state: 'queued',
    turn_boundary: 'session_handoff_completed',
  });
  assert.deepEqual(calls.supports, ['complete_session_handoff']);
  assertNoEcho(result);
});

test('complete_session_handoff defaults an omitted background to empty and keeps a refused first turn visible', async () => {
  preparation = { proposalId: PROPOSAL_ID, attemptId: ATTEMPT_ID };
  const { context, calls } = makeHarness({
    completeResult: {
      ok: true, proposal_id: PROPOSAL_ID, revision: 5, child_session_id: 'sess_2_abcdef012345',
      first_turn_work_id: null, first_turn_turn_id: null, admission_state: 'needs_attention',
    },
  });
  const { background: _omitted, schema_version: _version, ...withoutBackground } = HANDOFF_ARGS;
  const result = await completeHandoffTool.execute(withoutBackground, context);
  assert.equal(calls.completed[0].background, '', 'an omitted background and schema_version are both accepted');
  assert.equal(result.isError, false);
  assert.equal(result.metadata.admission_state, 'needs_attention');
  assert.equal(result.metadata.turn_boundary, 'session_handoff_completed');
});

test('complete_session_handoff is refused outside its preparation turn or for another attempt', async () => {
  const outside = makeHarness();
  const refused = await completeHandoffTool.execute(HANDOFF_ARGS, outside.context);
  assert.equal(refused.isError, true);
  assert.equal(refused.errorCode, 'CMP-PROPOSAL-0008');
  assert.equal(outside.calls.completed.length, 0);

  for (const wrong of [
    { proposalId: `proposal_${'c'.repeat(64)}`, attemptId: ATTEMPT_ID },
    { proposalId: PROPOSAL_ID, attemptId: '22222222-2222-4222-8222-222222222222' },
  ]) {
    preparation = wrong;
    const other = makeHarness();
    const result = await completeHandoffTool.execute(HANDOFF_ARGS, other.context);
    assert.equal(result.errorCode, 'CMP-PROPOSAL-0008');
    assert.equal(other.calls.completed.length, 0);
  }
});

test('complete_session_handoff validates its arguments and the live call', async () => {
  preparation = { proposalId: PROPOSAL_ID, attemptId: ATTEMPT_ID };
  for (const [args, cause] of [
    [{ ...HANDOFF_ARGS, proposal_id: 'proposal_x' }, 'field_proposal_id'],
    [{ ...HANDOFF_ARGS, attempt_id: 'nope' }, 'field_attempt_id'],
    [{ ...HANDOFF_ARGS, task: '   ' }, 'field_task'],
    [{ ...HANDOFF_ARGS, background: 5 }, 'field_background'],
    [{ ...HANDOFF_ARGS, extra: 1 }, 'unknown_field'],
    [{ ...HANDOFF_ARGS, schema_version: 2 }, 'field_schema_version'],
  ]) {
    const { context, calls } = makeHarness();
    const result = await completeHandoffTool.execute(args, context);
    assert.equal(result.errorCode, 'CMP-PROPOSAL-0001', cause);
    assert.match(result.content, new RegExp(cause));
    assert.equal(calls.completed.length, 0);
  }
  const stale = makeHarness();
  stale.state.activeTurn = null;
  assert.equal((await completeHandoffTool.execute(HANDOFF_ARGS, stale.context)).errorCode, 'CMP-PROPOSAL-0007');
  assert.equal(stale.calls.completed.length, 0);
});

test('complete_session_handoff refuses an unnegotiated producer and maps service failures', async () => {
  preparation = { proposalId: PROPOSAL_ID, attemptId: ATTEMPT_ID };
  const unsupported = makeHarness({ supported: false });
  assert.equal((await completeHandoffTool.execute(HANDOFF_ARGS, unsupported.context)).errorCode, 'CMP-PROPOSAL-0009');
  assert.equal(unsupported.calls.completed.length, 0);

  for (const [reason, code] of [
    ['idempotency_conflict', 'CMP-PROPOSAL-0004'], ['preparation_failed', 'CMP-PROPOSAL-0010'],
    ['authority_changed', 'CMP-PROPOSAL-0007'], ['invalid_request', 'CMP-PROPOSAL-0001'],
  ]) {
    const { context } = makeHarness({ completeResult: { ok: false, reason, cause_code: 'handoff_text' } });
    const result = await completeHandoffTool.execute(HANDOFF_ARGS, context);
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, code, reason);
    assert.deepEqual(result.metadata, {});
    assertNoEcho(result);
  }
  const thrown = makeHarness();
  thrown.backendService.chatProposals.completeHandoff = async () => { throw new Error('boom'); };
  assert.equal((await completeHandoffTool.execute(HANDOFF_ARGS, thrown.context)).errorCode, 'CMP-PROPOSAL-0002');
  const bad = makeHarness({ completeResult: { ok: true, proposal_id: PROPOSAL_ID, revision: 1, admission_state: 'weird' } });
  assert.equal((await completeHandoffTool.execute(HANDOFF_ARGS, bad.context)).errorCode, 'CMP-PROPOSAL-0002');
});

test('captureSessionBinding allows a projectless chat and records the raw run mode', () => {
  const projectless = Object.freeze({
    project_id: 'project_1', root_path: null, root_id: null, root_revision: 0, device_id: null, inode: null,
  });
  const { context } = makeHarness({
    projectAuthority: projectless,
    summary: { run_mode: 'propose', lockdown: true, preferred_model: 'm1', reasoning_effort: ' ' },
  });
  const live = { sessionId: 'sess_1', trusted: { mode: 'assist', readOnly: true, assertCurrent() {} } };
  const captured = captureSessionBinding(context, live);
  assert.equal(captured.ok, true);
  assert.deepEqual(captured.binding, {
    source_project_id: 'project_1', workspace_id: null, root_identity: null, authority_revision: 0,
    run_mode: 'agent', restrictions: { read_only: true, plan_mode: false }, model: 'm1', effort: null,
    git: null, command: null, session: { source_run_mode: 'propose', lockdown: true },
  });
});

test('captureSessionBinding carries a bound root, Plan mode and the model settings', () => {
  const { context } = makeHarness({
    summary: { run_mode: 'plan', plan_mode: true, preferred_model: 'm2', reasoning_effort: 'high' },
  });
  const live = { sessionId: 'sess_1', trusted: { mode: 'plan', readOnly: true, assertCurrent() {} } };
  const captured = captureSessionBinding(context, live);
  assert.equal(captured.ok, true);
  assert.deepEqual(captured.binding.root_identity, { root_id: 'root_1', device_id: 'dev_1', inode: 'ino_1' });
  assert.equal(captured.binding.workspace_id, 'root_1');
  assert.equal(captured.binding.run_mode, 'plan');
  assert.deepEqual(captured.binding.restrictions, { read_only: true, plan_mode: true });
  assert.deepEqual(captured.binding.session, { source_run_mode: 'plan', lockdown: false });
  assert.equal(captured.binding.effort, 'high');
});

test('captureSessionBinding classifies authority failures', () => {
  const { context } = makeHarness();
  const live = (assertCurrent) => ({ sessionId: 'sess_1', trusted: { mode: 'assist', readOnly: false, assertCurrent } });
  assert.deepEqual(
    captureSessionBinding(context, live(() => { throw Object.assign(new Error('x'), { code: 'run_mode_changed' }); })),
    { ok: false, reason: 'authority_changed', cause_code: 'run_mode_changed' },
  );
  assert.equal(captureSessionBinding(context, live(() => { throw new Error('x'); })).reason, 'unavailable');
  context.backendService.projectAuthority.captureSession = () => {
    throw Object.assign(new Error('x'), { reason: 'authority_stale' });
  };
  assert.equal(captureSessionBinding(context, live(() => {})).reason, 'authority_changed');
  context.backendService.projectAuthority.captureSession = () => ({ project_id: 'p', root_revision: 'x' });
  assert.equal(captureSessionBinding(context, live(() => {})).reason, 'unavailable');
  assert.equal(captureSessionBinding({ backendService: {} }, { sessionId: 's' }).reason, 'unavailable');
});

test('both tools are manifest-backed, workspace-free, read-only runtime tools with closed schemas', () => {
  const registry = createDefaultRegistry({});
  for (const name of ['propose_session', 'complete_session_handoff']) {
    const entry = toolManifest.tools.find((tool) => tool.name === name);
    assert.ok(entry, name);
    assert.equal(entry.owner, 'electron');
    assert.equal(entry.tool_family, 'runtime');
    assert.equal(entry.read_only, true);
    assert.equal(entry.side_effecting, false);
    assert.equal(entry.availability.workspace_required, false);
    assert.equal(entry.parameters.additionalProperties, false);
    if (name === 'propose_session') {
      assert.deepEqual(entry.parameters.properties.project_id, { type: 'string', minLength: 1, maxLength: 128, description: entry.parameters.properties.project_id.description });
      assert.deepEqual(entry.parameters.required, ['initiation', 'title']);
    }
    assert.deepEqual(entry.surfaces, ['managed_sidecar']);
    const tool = registry.getTool(name);
    assert.equal(tool.workspaceRequired, false);
    assert.deepEqual(tool.parameters, entry.parameters);
  }
  assert.equal(registry.getTool('propose_session').summarize({ initiation: 'own_initiative' }), 'Suggest a separate chat');
});

// ---------- project_id (row 76, S4) ----------

function withPrimary(harness, { primary = true, projects = ['proj_9'] } = {}) {
  const summary = { id: 'sess_1', session_role: primary ? 'primary' : null };
  harness.backendService.sessionStore.peekSessionSummary = () => summary;
  harness.backendService.projectService = { get: (id) => (projects.includes(id) ? { id } : null) };
  return harness;
}

test('propose_session project_id from the primary reaches publish in the input', async () => {
  const harness = withPrimary(makeHarness());
  const result = await proposeSessionTool.execute({ ...OFFER_ARGS, project_id: 'proj_9' }, harness.context);
  assert.equal(result.isError, false);
  assert.equal(harness.calls.published.length, 1);
  assert.equal(harness.calls.published[0].input.project_id, 'proj_9');
  const plain = await proposeSessionTool.execute(OFFER_ARGS, harness.context);
  assert.equal(plain.isError, false);
  assert.equal(harness.calls.published[1].input.project_id, null);
});

test('propose_session project_id from any other chat is refused before publish', async () => {
  const harness = withPrimary(makeHarness(), { primary: false });
  const result = await proposeSessionTool.execute({ ...OFFER_ARGS, project_id: 'proj_9' }, harness.context);
  assert.equal(result.isError, true);
  assert.match(result.content, /Only the Jenny chat can choose a project; omit project_id\./u);
  assert.equal(harness.calls.published.length, 0);
  assert.equal(harness.calls.captured.length, 0);
  assert.equal(String(result.errorCode).startsWith('CMP-PROPOSAL-'), true);
  assertNoEcho(result);
});

test('propose_session project_id naming an unknown project is refused for the primary', async () => {
  const harness = withPrimary(makeHarness());
  const result = await proposeSessionTool.execute({ ...OFFER_ARGS, project_id: 'proj_missing' }, harness.context);
  assert.equal(result.isError, true);
  assert.match(result.content, /No project with that id\. Use a project\.id from sessions_list, or omit project_id\./u);
  assert.equal(harness.calls.published.length, 0);
  assert.equal(result.content.includes('proj_missing'), false);
  const noService = withPrimary(makeHarness());
  delete noService.backendService.projectService;
  assert.match((await proposeSessionTool.execute({ ...OFFER_ARGS, project_id: 'proj_9' }, noService.context)).content, /No project with that id/u);
});

// 2026-10-27: a launch grant starts the chat without anyone seeing the card, so the preferred_model
// pre-fill must be an installed id; the alias `ornith15:9b` reached a child whose first turn failed.
test('propose_session refuses a preferred_model the catalog does not carry, listing installed ids closest first', async () => {
  const harness = makeHarness();
  harness.backendService.listModels = async () => ({ data: [
    { id: 'qwen3.8-27b-nvfp4', engine_type: 'openai-compatible' }, { id: 'ornith15:9b-q6-256k', engine_type: 'ollama' },
    { id: 'ornith15:9b-q4-k-m', engine_type: 'ollama' }, { id: 'gone:1b', engine_type: 'ollama', available: false },
  ] });
  // Two installed tags extend the short name, so nothing is guessed.
  const refused = await proposeSessionTool.execute({ ...OFFER_ARGS, preferred_model: 'ornith15:9b' }, harness.context);
  assert.equal(refused.isError, true);
  assert.match(refused.content, /preferred_model is not an installed model\. Installed: ornith15:9b-q6-256k, ornith15:9b-q4-k-m, qwen3\.8-27b-nvfp4\./u);
  assert.equal(refused.content.includes('gone:1b'), false, 'an unavailable entry is not offered');
  assert.equal(harness.calls.published.length, 0);
  assertNoEcho(refused);

  const accepted = await proposeSessionTool.execute({ ...OFFER_ARGS, preferred_model: 'ornith15:9b-q6-256k' }, harness.context);
  assert.equal(accepted.isError, false);
  assert.equal(harness.calls.published.length, 1);
});

// Owner run 2026-10-27: the refusal drew a failed tool row, and the model retried with the one
// installed tag anyway. A short name with exactly one installed extension now resolves to it.
test('propose_session resolves a short name to its one installed extension and says so', async () => {
  const harness = makeHarness();
  harness.backendService.listModels = async () => ({ data: [
    { id: 'qwen3.8-27b-nvfp4', engine_type: 'openai-compatible' }, { id: 'ornith15:9b-q6-256k', engine_type: 'ollama' },
    { id: 'solo:7b', engine_type: 'ollama' },
  ] });
  const result = await proposeSessionTool.execute({ ...OFFER_ARGS, preferred_model: 'ornith15:9b' }, harness.context);
  assert.equal(result.isError, false);
  assert.equal(harness.calls.published[0].input.preferred_model, 'ornith15:9b-q6-256k');
  assert.match(result.content, / preferred_model is set to the installed ornith15:9b-q6-256k\.$/u);
  assertNoEcho(result);
  const untagged = await proposeSessionTool.execute({ ...OFFER_ARGS, preferred_model: 'solo' }, harness.context);
  assert.equal(untagged.isError, false);
  assert.equal(harness.calls.published[1].input.preferred_model, 'solo:7b');
  // `ornith15:9` is not a tag the installed id extends at a separator.
  const partial = await proposeSessionTool.execute({ ...OFFER_ARGS, preferred_model: 'ornith15:9' }, harness.context);
  assert.equal(partial.isError, true);
  const exact = await proposeSessionTool.execute({ ...OFFER_ARGS, preferred_model: 'qwen3.8-27b-nvfp4' }, harness.context);
  assert.equal(exact.content.includes('preferred_model is set'), false);
});

test('propose_session accepts the model when the catalog cannot be read or lists nothing', async () => {
  for (const listModels of [async () => { throw new Error('sidecar down'); }, async () => ({ data: [] }), undefined]) {
    const harness = makeHarness();
    if (listModels) harness.backendService.listModels = listModels;
    const result = await proposeSessionTool.execute({ ...OFFER_ARGS, preferred_model: 'ornith15:9b' }, harness.context);
    assert.equal(result.isError, false);
    assert.equal(harness.calls.published.length, 1);
  }
});
