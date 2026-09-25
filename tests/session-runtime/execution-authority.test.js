'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SessionExecutionAuthority,
  getTrustedExecutionBinding,
} = require('../../services/backend/session-execution-authority');
const { executeElectronToolRequest } = require('../../services/backend/electron-tool-bridge');
const { approveToolCall } = require('../../services/backend/backend-chat-stream');
const { setSessionPreferences } = require('../../services/backend/backend-sessions');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { ToolExecutor } = require('../../services/tools/tool-executor');
const homeTool = require('../../services/tools/builtin/home-tool');

const ROOT_A = Object.freeze({
  project_id: 'project_alpha',
  root_path: 'G:\\projects\\alpha',
  root_id: 'root-alpha',
  root_revision: 3,
  device_id: '7',
  inode: '11',
});
const ROOT_B = Object.freeze({ ...ROOT_A, root_path: 'G:\\projects\\beta',
  root_id: 'root-beta', root_revision: 4, inode: '12' });
const PLUGIN_TOOL = 'plugin:acme-labs:widgets:compute';

function pluginCapture(revision = 1, descriptorDigest = 'a'.repeat(64)) {
  return Object.freeze({
    authority: Object.freeze({ mode: 'plugin', registry_revision: revision,
      dependency_graph_hash: 'b'.repeat(64), commit_epoch: revision,
      active_generation_id: `generation-${revision}` }),
    descriptor_digest: descriptorDigest,
    descriptors: Object.freeze([Object.freeze({
      name: PLUGIN_TOOL, side_effecting: true, read_only: false,
      tool_family: 'other', source_kind: 'restricted',
      server_name: 'electron_tool_bridge', plan_mode_only: false,
      workspace_required: false,
      capability_identity: Object.freeze({ runtime_kind: 'restricted',
        component_digest: 'c'.repeat(64) }),
    })]),
  });
}

function createHarness({ decision = 'auto', mode = 'assist', readOnly = false,
  resolvePluginToolAuthority = null, approvalMode = 'prompt' } = {}) {
  let currentAuthority = ROOT_A;
  let currentDecision = decision;
  let currentRules = [];
  const controller = new AbortController();
  const checkpointCalls = [];
  const scopedGit = { createCheckpoint: async (options) => {
    checkpointCalls.push(options);
    return { ok: true, created: true,
      ref: 'refs/jenny/checkpoints/session-alpha/1', sequence: 1 };
  } };
  const scopedArtifact = { identity: 'scoped-artifact' };
  const projectAuthority = {
    captureSession(sessionId) {
      if (sessionId !== 'session-alpha') throw new Error('session not found');
      return currentAuthority;
    },
    requireCurrent(authority) {
      if (authority.root_id !== currentAuthority.root_id
        || authority.root_revision !== currentAuthority.root_revision) {
        throw new Error('Project authority is stale.');
      }
      return authority;
    },
  };
  const permissionStore = {
    getSnapshot(authority) {
      assert.equal(authority.project_id, 'project_alpha');
      return { version: 3, legacy_policies: { read_file: currentDecision,
        write_file: currentDecision, jenny_status: currentDecision, create_artifact: currentDecision,
        [PLUGIN_TOOL]: currentDecision }, rules: currentRules };
    },
  };
  const authorityService = new SessionExecutionAuthority({
    projectAuthority,
    permissionStore,
    knowledgeService: { getSidecarConfig: ({ projectId }) => ({
      tools_knowledge_enabled: true,
      knowledge_roots: [`G:\\knowledge\\${projectId}`],
    }) },
    skillsService: { getSidecarConfig: ({ authority }) => ({
      skills_bundled_root: 'G:\\app\\skills',
      skills_user_root: 'G:\\user\\skills',
      skills_project_root: `${authority.root_path}\\.jenny\\skills`,
      skills_bundled_enabled: true,
      skills_user_enabled: true,
      skills_project_enabled: true,
      skills_disabled_ids: ['unsafe-skill'],
      skills_auto_index: 'auto',
    }) },
    resolveProjectWorkspaceServices: (authority, { sessionId }) => {
      assert.deepEqual(authority, currentAuthority);
      assert.equal(sessionId, 'session-alpha');
      return { workspaceGitService: scopedGit, artifactService: scopedArtifact,
        configService: { getToolsWorkspaceRoot: () => authority.root_path } };
    },
    ...(resolvePluginToolAuthority ? { resolvePluginToolAuthority } : {}),
    randomUUID: () => '8f04ce56-3fd5-4f3f-907c-3a0a6ea83580',
  });
  const binding = authorityService.captureSession('session-alpha', {
    requestId: 'request-alpha', signal: controller.signal, mode, readOnly, approvalMode,
  });
  return {
    authorityService,
    binding,
    checkpointCalls,
    controller,
    scopedArtifact,
    scopedGit,
    setAuthority(value) { currentAuthority = value; },
    setDecision(value) { currentDecision = value; },
    setRules(value) { currentRules = value; },
  };
}

function operation(overrides = {}) {
  return {
    api_version: '2026-08-17',
    schema_version: 1,
    request_id: 'request-alpha',
    session_id: 'session-alpha',
    authority_revision: '8f04ce56-3fd5-4f3f-907c-3a0a6ea83580',
    operation_id: 'tool-call-1',
    phase: 'check',
    tool_name: 'read_file',
    arguments: { path: 'README.md' },
    ...overrides,
  };
}

test('captures an immutable closed execution context with scoped knowledge and skills', () => {
  const { authorityService, binding } = createHarness();
  const context = authorityService.toExecutionContext(binding);

  assert.deepEqual(Object.keys(context).sort(), [
    'authority_revision', 'device_id', 'inode', 'knowledge_roots', 'project_id',
    'root_id', 'root_path', 'root_revision', 'schema_version', 'skills_config',
    'tool_policy_snapshot',
  ]);
  assert.equal(context.project_id, 'project_alpha');
  assert.deepEqual(context.knowledge_roots, ['G:\\knowledge\\project_alpha']);
  assert.equal(context.skills_config.skills_project_enabled, true);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.tool_policy_snapshot), true);
  assert.equal(getTrustedExecutionBinding(binding).services.artifactService.identity,
    'scoped-artifact');
  assert.equal(getTrustedExecutionBinding({}), null);
});

test('Jenny status reports the calling project and Plan gates instead of global availability', async () => {
  const harness = createHarness();
  harness.setAuthority({ ...ROOT_A, root_path: null, root_id: null, root_revision: 0,
    device_id: null, inode: null });
  const binding = harness.authorityService.captureSession('session-alpha', {
    requestId: 'request-status', mode: 'plan',
    toolPreferences: { disabled_tools: ['web_search'] },
  });
  const source = { engine: 'replay', tools_status: {
    write_file: { available: true, reason: null },
    read_file: { available: true, reason: null },
    exit_plan_mode: { available: false, reason: 'tool is available only in plan mode' },
    todo_read: { available: true, reason: null },
    web_search: { available: true, reason: null },
    verify: { available: false, reason: 'config disabled' },
  } };
  const { getJennyStatus } = require('../../services/backend/jenny-status-composer');
  const service = { currentStatus: source, getBackendStatus: () => ({ phase: 'ready' }) };
  let options;
  const result = await require('../../services/tools/builtin/jenny-status-tool').execute({}, {
    executionAuthority: binding, sessionId: 'session-alpha',
    backendService: { getJennyStatus: value => { options = value; return getJennyStatus(service, value); } },
  });
  const runtime = JSON.parse(result.content).runtime;
  assert.equal(options.session_id, 'session-alpha');
  assert.equal(runtime.tools_status_scope, 'request');
  assert.equal(runtime.workspace_configured, false);
  assert.equal(runtime.plan_mode, true);
  assert.equal(runtime.tools_status.read_file.available, false);
  assert.equal(runtime.tools_status.write_file.available, false);
  assert.equal(runtime.tools_status.exit_plan_mode.available, true);
  assert.equal(runtime.tools_status.todo_read.available, true);
  assert.equal(runtime.tools_status.web_search.available, false);
  assert.equal(runtime.tools_status.verify.available, false);
  assert.equal(source.tools_status.read_file.available, true, 'global status remains unchanged');
  harness.authorityService.close(binding);
  assert.equal((await getJennyStatus(service, { executionAuthority: binding })).runtime.available, false);
});

test('runtime operation rejects cross-session, forged-token, cancellation, and stale-root callbacks', () => {
  const harness = createHarness();

  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding,
    operation({ session_id: 'session-other' })).status, 'rejected');
  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding,
    operation({ authority_revision: 'forged' })).status, 'rejected');

  harness.setAuthority(ROOT_B);
  const stale = harness.authorityService.checkRuntimeOperation(harness.binding, operation());
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.error.reason, 'project_authority_stale');

  const cancelled = createHarness();
  cancelled.controller.abort(new Error('cancelled'));
  assert.equal(cancelled.authorityService.checkRuntimeOperation(
    cancelled.binding, operation()).error.reason, 'authority_mismatch');
});

test('switching a live Auto session to Plan revokes a prepared Home mutation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-authority-mode-'));
  const sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'), {
    writeDebounceMs: 0,
  });
  t.after(() => {
    sessionStore.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  sessionStore.createSessionWithId('session-alpha', {
    projectId: 'project_alpha', preferences: { run_mode: 'auto' },
  });
  let writes = 0;
  const homeAssistantService = {
    listCalendar: () => ({ instances: [] }),
    upsertEvent: () => {
      writes += 1;
      return { event: { id: 'event-one' }, journaled: true };
    },
  };
  const permissionStore = { getSnapshot: () => ({ version: 3,
    legacy_policies: { home: 'auto' }, rules: [] }) };
  const projectAuthority = {
    _sessionStore: sessionStore,
    captureSession: () => ROOT_A,
    requireCurrent: () => ROOT_A,
  };
  const authorityService = new SessionExecutionAuthority({
    projectAuthority,
    permissionStore,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({ homeAssistantService }),
  });
  const binding = authorityService.captureSession('session-alpha', {
    requestId: 'request-mode-change', mode: 'assist', approvalMode: 'auto_run',
  });
  await setSessionPreferences({
    sessionStore,
    activeStreams: new Map(),
  }, 'session-alpha', { run_mode: 'plan' });
  const executor = new ToolExecutor({
    registry: { getTool: name => name === 'home' ? homeTool : null },
    permissionStore,
    pathPolicy: {},
    logger() {},
  });

  const result = await executor.executePreApproved({
    callId: 'home-call', toolName: 'home', input: {
      action: 'event_upsert', title: 'Must not be written', start: '2026-09-15T10:00',
    },
  }, { executionAuthority: binding, sessionId: 'session-alpha' });

  assert.equal(result.isError, true);
  assert.equal(writes, 0);
});

test('switching a live Auto session to Ask revokes an unapproved Home mutation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-authority-auto-'));
  const sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'), {
    writeDebounceMs: 0,
  });
  t.after(() => {
    sessionStore.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  sessionStore.createSessionWithId('session-alpha', {
    projectId: 'project_alpha', preferences: { run_mode: 'auto' },
  });
  let writes = 0;
  const homeAssistantService = {
    listCalendar: () => ({ instances: [] }),
    upsertEvent: () => {
      writes += 1;
      return { event: { id: 'event-one' }, journaled: true };
    },
  };
  const permissionStore = { getSnapshot: () => ({ version: 3,
    legacy_policies: { home: 'ask' }, rules: [] }) };
  const projectAuthority = {
    _sessionStore: sessionStore,
    captureSession: () => ROOT_A,
    requireCurrent: () => ROOT_A,
  };
  const authorityService = new SessionExecutionAuthority({
    projectAuthority,
    permissionStore,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({ homeAssistantService }),
  });
  const binding = authorityService.captureSession('session-alpha', {
    requestId: 'request-auto-change', mode: 'assist', approvalMode: 'auto_run',
  });
  await setSessionPreferences({
    sessionStore,
    activeStreams: new Map(),
  }, 'session-alpha', { run_mode: 'ask' });
  const executor = new ToolExecutor({
    registry: { getTool: name => name === 'home' ? homeTool : null },
    permissionStore,
    pathPolicy: {},
    logger() {},
  });

  const result = await executor.executePreApproved({
    callId: 'home-ask-call', toolName: 'home', input: {
      action: 'event_upsert', title: 'Must not be written', start: '2026-09-15T11:00',
    },
  }, { executionAuthority: binding, sessionId: 'session-alpha' });

  assert.equal(result.isError, true);
  assert.equal(writes, 0);
});

test('runtime operation honors scoped approval and observes live policy revocation', () => {
  const harness = createHarness({ decision: 'ask' });
  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding, operation()).status,
    'rejected');
  assert.equal(harness.authorityService.noteApproved(harness.binding, {
    operationId: 'tool-call-1', toolName: 'read_file', arguments: { path: 'README.md' },
  }), true);
  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding, operation()).status,
    'granted');
  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding,
    operation({ arguments: { path: 'secrets.txt' } })).status, 'rejected');

  harness.setDecision('deny');
  const revoked = harness.authorityService.checkRuntimeOperation(harness.binding, operation());
  assert.equal(revoked.status, 'rejected');
  assert.equal(revoked.error.reason, 'policy_rejected');
});

test('Plan exit changes the live binding only after exact consent and successful persistence', async () => {
  const harness = createHarness({ mode: 'plan' });
  const plan = { title: 'Fixture plan', steps: ['Write the fixture'] };
  const trusted = getTrustedExecutionBinding(harness.binding);
  const write = operation({ tool_name: 'write_file', arguments: { path: 'test.txt', content: 'ok' } });
  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding, write).error.reason, 'read_only');
  const options = { operationId: 'plan-call', arguments: plan, decision: 'approved' };
  assert.throws(() => harness.authorityService.preparePlanExit(harness.binding, options), /exact approved/);
  harness.authorityService.noteApproved(harness.binding, { ...options, toolName: 'exit_plan_mode' });
  assert.throws(() => harness.authorityService.preparePlanExit(harness.binding,
    { ...options, decision: 'approved_auto' }), /exact approved/);
  const exitTool = require('../../services/tools/builtin/exit-plan-mode-tool');
  let writes = 0;
  const context = {
    callId: 'plan-call', streamId: 'request-alpha', sessionId: 'session-alpha',
    planDecision: 'approved', planMode: true, readOnly: true, executionAuthority: harness.binding,
    backendService: { sessionExecutionAuthority: harness.authorityService,
      setSessionPreferences: async () => { writes += 1; return false; } },
  };
  assert.equal((await exitTool.execute(plan, context)).isError, true);
  assert.equal(trusted.mode, 'plan');
  assert.equal(trusted.readOnly, true);
  context.backendService.setSessionPreferences = async () => true;
  assert.equal((await exitTool.execute(plan, context)).isError, false);
  assert.equal(writes, 1);
  assert.equal(trusted.mode, 'assist');
  assert.equal(trusted.readOnly, false);
  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding, write).status, 'granted');
  assert.throws(() => harness.authorityService.preparePlanExit(harness.binding, options), /exact approved/);
  harness.setDecision('deny');
  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding, write).error.reason, 'policy_rejected');
});

test('Plan consent cannot lift independent read-only restrictions or survive cancellation', () => {
  for (const restricted of [true, false]) {
    const harness = createHarness({ mode: 'plan', readOnly: restricted });
    const options = { operationId: 'plan-call', arguments: { title: 'Plan', steps: ['One'] }, decision: 'approved' };
    harness.authorityService.noteApproved(harness.binding, { ...options, toolName: 'exit_plan_mode' });
    if (!restricted) harness.controller.abort();
    assert.throws(() => harness.authorityService.preparePlanExit(harness.binding, options));
    assert.equal(getTrustedExecutionBinding(harness.binding).readOnly, true);
  }
});

test('Plan permits inert documents but cannot lift independent read-only or live denies', () => {
  const document = { artifact_kind: 'document', title: 'Plan', content: '# Plan', language: 'markdown' };
  const h = createHarness({ mode: 'plan', decision: null });
  const check = args => h.authorityService.checkRuntimeOperation(h.binding,
    operation({ tool_name: 'create_artifact', arguments: args }));
  assert.equal(check(document).status, 'granted');
  for (const patch of [{ artifact_kind: 'html' }, { language: 'javascript' },
    { extension: '.html' }, { file_name: 'plan.js' }, { extension: '.json' },
    { content: 'a'.repeat(512 * 1024 + 1) }, { language: null }]) {
    assert.equal(check({ ...document, ...patch }).error.reason, 'read_only');
  }
  for (const decision of ['ask', 'deny']) {
    h.setRules([{ id: 'artifact-policy', decision, match: { tool_id: 'create_artifact' } }]);
    assert.equal(check(document).error.reason, 'policy_rejected');
  }
  const restricted = createHarness({ mode: 'plan', readOnly: true });
  assert.equal(restricted.authorityService.checkRuntimeOperation(restricted.binding,
    operation({ tool_name: 'create_artifact', arguments: document })).error.reason, 'read_only');
});

test('Plan keeps the todo list writable unless a live rule or read-only capture says no', () => {
  const todos = { todos: [{ content: 'Outline', status: 'pending' }] };
  const h = createHarness({ mode: 'plan', decision: null });
  const check = () => h.authorityService.checkRuntimeOperation(h.binding,
    operation({ tool_name: 'todo_write', arguments: todos }));
  assert.equal(check().status, 'granted');
  h.setRules([{ id: 'todo-policy', decision: 'deny', match: { tool_id: 'todo_write' } }]);
  assert.equal(check().error.reason, 'policy_rejected');
  const restricted = createHarness({ mode: 'plan', readOnly: true });
  assert.equal(restricted.authorityService.checkRuntimeOperation(restricted.binding,
    operation({ tool_name: 'todo_write', arguments: todos })).error.reason, 'read_only');
});

test('automatic Plan consent covers ordinary asks while live policy denies still win', () => {
  const harness = createHarness({ mode: 'plan', decision: 'ask' });
  const options = { operationId: 'plan-call', arguments: { title: 'Plan', steps: ['One'] }, decision: 'approved_auto' };
  harness.authorityService.noteApproved(harness.binding, { ...options, toolName: 'exit_plan_mode' });
  harness.authorityService.preparePlanExit(harness.binding, options)();
  const write = operation({ tool_name: 'write_file', arguments: { path: 'test.txt', content: 'ok' } });
  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding, write).status, 'granted');
  harness.setDecision('deny');
  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding, write).error.reason, 'policy_rejected');
});

test('ordinary automatic permission comes from captured request options, not tool arguments', () => {
  const write = operation({ tool_name: 'write_file', arguments: { path: 'test.txt', content: 'ok' } });
  for (const approvalMode of ['prompt', 'auto_run']) {
    const harness = createHarness({ decision: 'ask', approvalMode });
    assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding, write).status,
      approvalMode === 'auto_run' ? 'granted' : 'rejected');
    assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding,
      { ...write, approval_mode: 'auto_run' }).error.reason, 'invalid_schema');
    harness.setDecision('deny');
    assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding, write).error.reason, 'policy_rejected');
  }
});

test('runtime operation admits only a Node-bound dynamic descriptor and seals its identity', () => {
  let active = pluginCapture();
  const harness = createHarness({
    resolvePluginToolAuthority(expected) {
      assert.deepEqual(expected, active.authority);
      return active;
    },
  });
  assert.equal(harness.authorityService.bindPluginTools(
    harness.binding,
    active.authority
  ), true);
  const dynamic = operation({ tool_name: PLUGIN_TOOL, arguments: { value: 21 } });
  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding, dynamic).status,
    'granted');
  assert.equal(harness.authorityService.checkRuntimeOperation(harness.binding, {
    ...dynamic,
    descriptor: { side_effecting: false },
  }).error.reason, 'invalid_schema');

  active = pluginCapture(2, 'd'.repeat(64));
  assert.throws(() => harness.authorityService.bindPluginTools(
    harness.binding,
    active.authority
  ), /sealed/);
});

test('effect-free reconciliation can rebind, while descriptor drift revokes current authority', () => {
  let active = pluginCapture();
  const harness = createHarness({ resolvePluginToolAuthority: () => active });
  harness.authorityService.bindPluginTools(harness.binding, active.authority);

  active = pluginCapture(2, 'd'.repeat(64));
  assert.equal(harness.authorityService.bindPluginTools(
    harness.binding,
    active.authority
  ), true);
  active = pluginCapture(2, 'e'.repeat(64));
  const result = harness.authorityService.checkRuntimeOperation(harness.binding, operation({
    tool_name: PLUGIN_TOOL,
    arguments: { value: 21 },
  }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.reason, 'project_authority_stale');
});

test('runtime operation never lets policy or approval override captured read-only mode', () => {
  const harness = createHarness({ decision: 'auto', mode: 'plan' });
  const write = operation({
    operation_id: 'tool-call-write',
    tool_name: 'write_file',
    arguments: { path: 'README.md', content: 'changed' },
  });

  assert.equal(harness.authorityService.noteApproved(harness.binding, {
    operationId: write.operation_id,
    toolName: write.tool_name,
    arguments: write.arguments,
  }), true);
  const rejected = harness.authorityService.checkRuntimeOperation(harness.binding, write);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.error.reason, 'read_only');
  assert.equal(harness.authorityService.checkRuntimeOperation(
    harness.binding, operation()).status, 'granted');
});

test('null-root captures permit conversation but block every workspace tool', () => {
  const harness = createHarness();
  harness.setAuthority(Object.freeze({ ...ROOT_A, root_path: null, root_id: null,
    root_revision: 4, device_id: null, inode: null }));
  const binding = harness.authorityService.captureSession('session-alpha', {
    requestId: 'request-null',
  });
  const context = harness.authorityService.toExecutionContext(binding);
  assert.deepEqual(context.knowledge_roots, []);
  assert.equal(context.skills_config.skills_project_root, null);
  assert.equal(context.skills_config.skills_project_enabled, false);
  const result = harness.authorityService.checkRuntimeOperation(binding, operation({
    request_id: 'request-null',
    authority_revision: context.authority_revision,
  }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.reason, 'tool_unavailable');
});

test('ToolExecutor selects branded scoped services and ignores forged authority fields', async () => {
  const harness = createHarness();
  let observed = null;
  const presentationFacades = [];
  const registry = { getTool: () => ({
    name: 'jenny_status', category: 'builtin', workspaceRequired: false, readOnly: true,
    sideEffecting: false, summarize: () => 'status',
    execute: async (_input, context) => {
      observed = context;
      return { content: 'ok', isError: false };
    },
  }) };
  const globalArtifact = { identity: 'global-artifact' };
  const executor = new ToolExecutor({ registry, permissionStore: {
    getSnapshot: (authority) => ({ version: 1,
      legacy_policies: { jenny_status: authority ? 'auto' : 'deny' }, rules: [] }),
  }, artifactService: globalArtifact, workspacePresentationService: {
    forSessionAuthority(authority, sessionId) {
      presentationFacades.push({ authority, sessionId });
      return { identity: 'scoped-presentation' };
    },
  }, browserSessionService: {
    reserveSlot: () => ({ ok: true }),
  }, logger: () => {} });

  const scoped = await executor.executePreApproved({
    callId: 'call-scoped', toolName: 'jenny_status', input: {},
  }, { executionAuthority: harness.binding });
  assert.equal(scoped.isError, false);
  assert.equal(observed.artifactService, harness.scopedArtifact);
  assert.equal(observed.workingDirectory, ROOT_A.root_path);
  assert.deepEqual(observed.projectAuthority, ROOT_A);
  assert.equal(observed.workspacePresentationService.identity, 'scoped-presentation');
  assert.equal(typeof observed.browserSessionService.open, 'function');
  assert.deepEqual(presentationFacades, [{ authority: ROOT_A, sessionId: 'session-alpha' }]);

  const forged = await executor.executePreApproved({
    callId: 'call-forged', toolName: 'jenny_status', input: {},
  }, { executionAuthority: {}, projectAuthority: ROOT_A, workingDirectory: ROOT_A.root_path });
  assert.equal(forged.isError, true);
  assert.equal(observed.artifactService, harness.scopedArtifact);
});

test('ToolExecutor cannot fall back to globals when approval settlement closes its binding', async () => {
  const harness = createHarness({ decision: 'ask' });
  let executions = 0;
  const executor = new ToolExecutor({
    registry: { getTool: () => ({
      name: 'write_file', category: 'builtin', workspaceRequired: true, readOnly: false,
      sideEffecting: true, summarize: () => 'write',
      execute: async () => { executions += 1; return { content: 'bad', isError: false }; },
    }) },
    permissionStore: { getSnapshot: () => ({ version: 3,
      legacy_policies: { write_file: 'ask' }, rules: [] }) },
    logger: () => {},
  });
  const pending = executor.execute({
    callId: 'write-after-close', toolName: 'write_file', input: { path: 'README.md' },
  }, { executionAuthority: harness.binding, streamId: 'request-alpha' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(executor.approve('write-after-close'), true);
  harness.authorityService.close(harness.binding);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.approvalState, 'cancelled');
  assert.equal(executions, 0);
});

test('Electron bridge uses the captured Git owner for internal checkpoints', async () => {
  const harness = createHarness();
  let globalCalls = 0;
  const result = await executeElectronToolRequest({
    workspaceGitService: { createCheckpoint: async () => { globalCalls += 1; return {}; } },
  }, {
    executionAuthority: harness.binding,
    sessionId: 'forged-session',
    params: { tool_name: '__jenny_git_checkpoint' },
  });
  assert.equal(result.success, true);
  assert.equal(result.metadata.ref, 'refs/jenny/checkpoints/session-alpha/1');
  assert.equal(globalCalls, 0);
  assert.equal(harness.checkpointCalls[0].session, 'session-alpha');

  harness.setAuthority(ROOT_B);
  const stale = await executeElectronToolRequest({}, {
    executionAuthority: harness.binding,
    params: { tool_name: '__jenny_git_checkpoint' },
  });
  assert.equal(stale.success, false);
  assert.equal(harness.checkpointCalls.length, 1);
});

test('approval rejects a stale captured root before settlement or persistent grant', () => {
  const harness = createHarness({ decision: 'ask' });
  const settlements = [];
  const grants = [];
  const service = {
    sessionExecutionAuthority: harness.authorityService,
    toolPermissionStore: {
      grantAlwaysAllow(toolName, input, authority) { grants.push({ toolName, input, authority }); },
    },
    pendingToolApprovals: new Map([['approval-1', {
      approvalId: 'approval-1',
      callId: 'tool-call-1',
      toolName: 'read_file',
      toolInput: { path: 'README.md' },
      executionAuthority: harness.binding,
      resolve(...args) { settlements.push(args); },
    }]]),
    _emitServiceLog() {},
  };
  harness.setAuthority(ROOT_B);

  assert.equal(approveToolCall(service, 'approval-1', { alwaysAllow: true }), false);
  assert.deepEqual(settlements, [[false, 'cancelled']]);
  assert.deepEqual(grants, []);
  assert.equal(service.pendingToolApprovals.size, 0);
});
