'use strict';

// Row 94 P2: `project_create` and `projects_list` are closed schemas over the placement port; the approval
// step ends a refused request before any card, and project_create is never always-allow.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const createTool = require('../services/tools/builtin/project-create-tool');
const listTool = require('../services/tools/builtin/projects-list-tool');
const { projectCreateRefusal } = require('../services/backend/project-create-approval');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { NEVER_PERSIST_ALWAYS_ALLOW } = require('../services/tools/tool-permission-migrations');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };
const GOOD = { name: 'App', folder: 'G:\\Work\\app', purpose: 'Make a project for the app folder.' };
const CHANGE_ID = `sc_${'c'.repeat(32)}`;

function harness({ port, featureFlags } = {}) {
  const project = { project_id: 'general', root_path: os.tmpdir(), root_id: 'root', root_revision: 1, device_id: 'device', inode: 'inode' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: captured => captured,
      _sessionStore: { getSessionSummary: () => ({ id: 'caller', run_mode: 'ask', plan_mode: false }) } },
    permissionStore: PERMISSIONS,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const executionAuthority = authority.captureSession('caller', { requestId: 'stream', mode: 'assist', approvalMode: 'prompt' });
  const calls = [];
  const fake = port === undefined ? {
    async create(args) { calls.push(['create', args]); return { ok: true, change_id: CHANGE_ID, project_id: 'pr_1', name: args.name, folder: args.folder }; },
    async list(args) { calls.push(['list', args]); return { ok: true, projects: [], total: 0 }; },
  } : port;
  const backendService = { sessionExecutionAuthority: authority, ...(featureFlags ? { featureFlags } : {}),
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } };
  const context = { sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call-1', backendService, executionAuthority, primaryChatPlacementService: fake, mode: 'ask',
    abortSignal: new AbortController().signal };
  return { context, calls };
}

const { parseToolOutput } = require('./helpers/refusal-output');
const output = parseToolOutput;

test('project_create is a closed schema: bad shapes refuse before the port', async () => {
  const { context, calls } = harness();
  for (const input of [undefined, null, [], {}, { ...GOOD, extra: 1 }, { ...GOOD, name: '' }, { ...GOOD, name: 'x'.repeat(81) },
    { ...GOOD, folder: '' }, { ...GOOD, folder: 7 }, { ...GOOD, folder: 'x'.repeat(1025) }, { ...GOOD, purpose: '' }, { ...GOOD, purpose: undefined }]) {
    assert.deepEqual(output(await createTool.execute(input, context)), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
});

test('project_create reaches the port with the live caller and this call id; refusals keep only safe facts', async () => {
  const { context, calls } = harness();
  const result = await createTool.execute(GOOD, context);
  assert.deepEqual(calls, [['create', { caller_session_id: 'caller', tool_call_id: 'call-1', name: 'App', folder: 'G:\\Work\\app' }]]);
  assert.deepEqual(output(result), { ok: true, project_id: 'pr_1', name: 'App', folder: 'G:\\Work\\app', change_id: CHANGE_ID });
  assert.deepEqual(result.metadata, { result_kind: 'project_create', status: 'ok', change_id: CHANGE_ID, project_id: 'pr_1' });
  const refusing = harness({ port: { create: async () => ({ ok: false, reason: 'exists', project_id: 'pr_9', project_name: 'Old', secret: 'x' }) } });
  assert.deepEqual(output(await createTool.execute(GOOD, refusing.context)), { ok: false, reason: 'exists', project_id: 'pr_9', project_name: 'Old' });
});

test('a missing or throwing port, a stale call, the kill switch and Plan/read-only all refuse without the port', async () => {
  assert.deepEqual(output(await createTool.execute(GOOD, harness({ port: null }).context)), { ok: false, reason: 'unavailable' });
  const thrown = await createTool.execute(GOOD, harness({ port: { create: async () => { throw new Error('C:\\Users\\private'); } } }).context);
  assert.deepEqual(output(thrown), { ok: false, reason: 'unavailable' });
  assert.equal(thrown.content.includes('private'), false);
  const stale = harness();
  stale.context.sessionIncarnation = '';
  assert.deepEqual(output(await createTool.execute(GOOD, stale.context)), { ok: false, reason: 'unavailable' });
  const off = harness({ featureFlags: { primary_chat_placement: false } });
  assert.deepEqual(output(await createTool.execute(GOOD, off.context)), { ok: false, reason: 'disabled' });
  assert.deepEqual(output(await listTool.execute({}, off.context)), { ok: false, reason: 'disabled' });
  for (const flags of [{ planMode: true }, { readOnly: true }]) {
    const { context, calls } = harness();
    assert.deepEqual(output(await createTool.execute(GOOD, { ...context, ...flags })), { ok: false, reason: 'mode_refused' });
    assert.deepEqual(calls, []);
  }
  assert.deepEqual(stale.calls, []);
});

test('projects_list takes no arguments and passes the port answer through', async () => {
  const { context, calls } = harness();
  assert.deepEqual(output(await listTool.execute({}, context)), { ok: true, projects: [], total: 0 });
  assert.deepEqual(calls, [['list', { caller_session_id: 'caller' }]]);
  assert.deepEqual(output(await listTool.execute({ scope: 'all' }, context)), { ok: false, reason: 'invalid_input' });
  assert.equal(listTool.summarize({}), 'Projects: list');
});

test('the approval step: a ready card passes, a refusal ends the call with its reason and facts', async () => {
  const seen = [];
  const ready = { primaryChatPlacement: { prepareCard: (args) => { seen.push(args); return { ok: true, name: 'App', folder: 'G:\\Work\\app' }; } } };
  assert.equal(await projectCreateRefusal(ready, 'caller', 'call-1', GOOD), null);
  assert.deepEqual(seen, [{ session_id: 'caller', tool_call_id: 'call-1', name: 'App', folder: 'G:\\Work\\app' }]);
  const elsewhere = { primaryChatPlacement: { prepareCard: () => ({ ok: false, reason: 'resolves_elsewhere', folder: 'G:\\real' }) } };
  const text = JSON.parse(await projectCreateRefusal(elsewhere, 'caller', 'call-1', GOOD));
  assert.equal(text.reason, 'resolves_elsewhere');
  assert.equal(text.folder, 'G:\\real');
  for (const service of [{}, { primaryChatPlacement: { prepareCard: () => { throw new Error('boom'); } } },
    { primaryChatPlacement: { prepareCard: () => ({ ok: false, reason: 'made_up' }) } }]) {
    assert.equal(JSON.parse(await projectCreateRefusal(service, 'caller', 'call-1', GOOD)).reason, 'unavailable');
  }
});

test('the manifest, policy and always-allow list pin project_create as side-effecting, ask-only, never always-allow', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'tools', 'tool-manifest.json'), 'utf8'));
  const entry = manifest.tools.find(item => item.name === 'project_create');
  assert.equal(entry.side_effecting, true);
  assert.equal(entry.owner, 'electron');
  assert.equal(entry.availability.config_flag, 'tools_primary_chat_placement_enabled');
  assert.deepEqual(entry.parameters.required, ['name', 'folder', 'purpose']);
  const list = manifest.tools.find(item => item.name === 'projects_list');
  assert.equal(list.read_only, true);
  assert.equal(NEVER_PERSIST_ALWAYS_ALLOW.has('project_create'), true);

  assert.equal(createDefaultRegistry({ toolsPrimaryChatPlacementEnabled: false }).getTool('project_create'), undefined);
  const tools = new ToolExecutor({ registry: createDefaultRegistry({ toolsPrimaryChatPlacementEnabled: true }),
    permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
  assert.equal(tools._evaluateToolPolicy(tools.registry.getTool('project_create'), GOOD, harness().context).decision, 'ask');
  assert.equal(tools._evaluateToolPolicy(tools.registry.getTool('projects_list'), {}, harness().context).decision, 'auto');
  const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'project_create' } });
  assert.equal(hosted.success, false);
});

// The live approval path (chat-stream-tool-approval.js): a refusal never shows a card; a ready request shows the
// generic card over the exact folder and name.
function approvalService(prepareCard) {
  const emitted = [];
  const messages = [];
  const service = {
    primaryChatPlacement: { prepareCard },
    sessionStore: { appendMessage: (_sessionId, message) => messages.push(message), updateMessage() {}, getSessionSummary: () => ({ run_mode: 'ask' }) },
    emit: (_channel, payload) => emitted.push(payload), pendingToolApprovals: new Map(), currentModel: 'm',
  };
  return { service, emitted, messages };
}

test('approval path: a refused folder ends the call before any card, with the reason for the model', async () => {
  const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
  const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
  const { service, emitted, messages } = approvalService(() => ({ ok: false, reason: 'credential_folder' }));
  const approved = await waitForToolApproval(service, 'stream-1', 'sess_primary', 'req-1', {
    tool_name: 'project_create', tool_call_id: 'call-1', tool_input: { ...GOOD, folder: 'G:\\keys\\.ssh' },
  }, new AbortController(), new CanonicalTurnEventCollector({ turnId: 'turn-1', sessionId: 'sess_primary' }));
  assert.equal(approved.approved, false);
  assert.equal(approved.decision, 'app_refused', 'not the user\'s Deny: the turn goes on with the reason');
  assert.equal(JSON.parse(approved.feedback).reason, 'credential_folder');
  assert.equal(service.pendingToolApprovals.size, 0);
  assert.equal(emitted.some((event) => event.type === 'tool_approval_needed'), false, 'no card');
  const result = emitted.find((event) => event.type === 'tool_result');
  assert.equal(JSON.parse(result.content).reason, 'credential_folder');
  assert.ok(messages.some((row) => row.kind === 'tool_result' && row.tool_result?.metadata?.app_refused === true));
});

test('approval path: a prepared request shows the card over the exact folder and name, one-off only', async () => {
  const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
  const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
  const seen = [];
  const { service, emitted } = approvalService((args) => { seen.push(args.tool_call_id); return { ok: true, name: 'App', folder: GOOD.folder }; });
  const done = waitForToolApproval(service, 'stream-2', 'sess_primary', 'req-2', {
    tool_name: 'project_create', tool_call_id: 'call-2', tool_input: GOOD,
  }, new AbortController(), new CanonicalTurnEventCollector({ turnId: 'turn-2', sessionId: 'sess_primary' }));
  await new Promise((resolve) => setImmediate(resolve));
  const card = emitted.find((event) => event.type === 'tool_approval_needed');
  assert.ok(card, 'card shown');
  assert.deepEqual(seen, ['call-2']);
  assert.deepEqual(card.exact_approval.fields.map((field) => [field.name, field.text]), [['folder', GOOD.folder], ['name', 'App']]);
  [...service.pendingToolApprovals.values()][0].resolve(false, 'denied');
  assert.equal(await done, false);
});
