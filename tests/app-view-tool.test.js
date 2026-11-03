'use strict';

// Row 94 P3: `app_view` is a closed schema per action over the app-view port; a chat target must be in the caller's
// session-directory scope, a file goes through the port's containment check, and nothing is carded.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const tool = require('../services/tools/builtin/app-view-tool');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { PRIMARY_APP_VIEW_TOOL_NAMES, primaryAppViewToolsOffered } = require('../services/backend/primary-settings-tool-gate');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };
const WHY = { purpose: 'Show the user the setting we discussed.' };

function harness({ port, featureFlags, visible = ['sess_other'] } = {}) {
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
    admit(args) { return args.session_id === 'caller' ? { ok: true } : { ok: false, reason: 'not_allowed' }; },
    requestView(args) { calls.push(['view', args]); return { ok: true, delivered: true, request_id: 'apv-1-1' }; },
    state(args) { calls.push(['state', args]); return { ok: true, layout: { active_view: 'chat' } }; },
    async resolveProjectFile(args) { calls.push(['file', args]); return args.path === 'secret' ? { ok: false, reason: 'outside_folder' } : { ok: true, path: 'src/app.js' }; },
  } : port;
  const backendService = { sessionExecutionAuthority: authority, ...(featureFlags ? { featureFlags } : {}),
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } };
  const sessionDirectoryService = { transcript: async ({ sessionId }) => ({ ok: visible.includes(sessionId) }) };
  const context = { sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call-1', backendService, executionAuthority, appViewService: fake, sessionDirectoryService, mode: 'ask',
    abortSignal: new AbortController().signal };
  return { context, calls };
}

const output = result => JSON.parse(result.content);

test('each action takes only its own keys; purpose is required except for state', async () => {
  const { context, calls } = harness();
  for (const input of [undefined, null, [], {}, { action: 'teleport', ...WHY }, { action: 'settings', section: 'models' },
    { action: 'settings', section: 'models', path: 'x', ...WHY }, { action: 'terminal', purpose: '' }, { action: 'state', section: 'models' },
    { action: 'sidebar', collapsed: true, purpose: 'x'.repeat(201) }]) {
    assert.deepEqual(output(await tool.execute(input, context)), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
});

test('a request reaches the port with the live caller and says "requested", never "opened"', async () => {
  const { context, calls } = harness();
  const answer = output(await tool.execute({ action: 'settings', section: 'notifications', ...WHY }, context));
  assert.equal(answer.ok, true);
  assert.equal(answer.status, 'requested');
  assert.match(answer.note, /do not tell the user it is open/);
  assert.deepEqual(calls, [['view', { session_id: 'caller', action: 'settings', target: { section: 'notifications' } }]]);
  assert.deepEqual(output(await tool.execute({ action: 'state' }, context)), { ok: true, layout: { active_view: 'chat' } });
});

test('a chat target must be in the caller\'s directory scope (the caller itself always is)', async () => {
  const { context, calls } = harness();
  assert.deepEqual(output(await tool.execute({ action: 'chat', session_id: 'sess_hidden', ...WHY }, context)), { ok: false, reason: 'unknown_chat' });
  assert.deepEqual(output(await tool.execute({ action: 'split', session_id: 'sess_hidden', ...WHY }, context)), { ok: false, reason: 'unknown_chat' });
  assert.equal(output(await tool.execute({ action: 'chat_panel', session_id: 'caller', surface: 'changes', ...WHY }, context)).ok, true);
  assert.equal(output(await tool.execute({ action: 'chat', session_id: 'sess_other', ...WHY }, context)).ok, true);
  assert.deepEqual(calls.map(([kind, args]) => [kind, args.action]), [['view', 'chat_panel'], ['view', 'chat']]);
});

test('a file goes through the containment check and sends the checked relative path', async () => {
  const { context, calls } = harness();
  assert.equal(output(await tool.execute({ action: 'file', project_id: 'pr_1', path: 'src\\app.js', line: 7, ...WHY }, context)).ok, true);
  assert.deepEqual(calls.at(-1), ['view', { session_id: 'caller', action: 'file', target: { project_id: 'pr_1', path: 'src/app.js', line: 7 } }]);
  assert.deepEqual(output(await tool.execute({ action: 'file', project_id: 'pr_1', path: 'secret', ...WHY }, context)), { ok: false, reason: 'outside_folder' });
  assert.equal(calls.filter(([kind]) => kind === 'view').length, 1);
});

test('the kill switch, a stale call, a missing or throwing port refuse; Plan mode may view', async () => {
  const off = harness({ featureFlags: { primary_app_view: false } });
  assert.deepEqual(output(await tool.execute({ action: 'terminal', ...WHY }, off.context)), { ok: false, reason: 'disabled' });
  const stale = harness();
  stale.context.sessionIncarnation = '';
  assert.deepEqual(output(await tool.execute({ action: 'terminal', ...WHY }, stale.context)), { ok: false, reason: 'unavailable' });
  assert.deepEqual(output(await tool.execute({ action: 'terminal', ...WHY }, harness({ port: null }).context)), { ok: false, reason: 'unavailable' });
  const thrown = await tool.execute({ action: 'terminal', ...WHY }, harness({ port: { admit: () => ({ ok: true }), requestView: () => { throw new Error('C:\\private'); } } }).context);
  assert.deepEqual(output(thrown), { ok: false, reason: 'unavailable' });
  // A caller the port does not admit learns nothing about chats or files: no directory or filesystem lookup runs.
  const looked = [];
  const refused = harness({ port: { admit: () => ({ ok: false, reason: 'not_allowed' }), requestView: () => ({ ok: true }),
    resolveProjectFile: async () => { looked.push('file'); return { ok: false, reason: 'missing' }; } } });
  refused.context.sessionDirectoryService = { transcript: async () => { looked.push('directory'); return { ok: true }; } };
  assert.deepEqual(output(await tool.execute({ action: 'file', project_id: 'p', path: 'a.js', ...WHY }, refused.context)), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(output(await tool.execute({ action: 'chat', session_id: 'sess_x', ...WHY }, refused.context)), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(looked, []);
  const plan = harness();
  assert.equal(output(await tool.execute({ action: 'terminal', ...WHY }, { ...plan.context, planMode: true, readOnly: true })).ok, true);
});

test('registered only with the flag, auto policy, offered to the primary chat only', () => {
  assert.equal(createDefaultRegistry({ toolsPrimaryAppViewEnabled: false }).getTool('app_view'), undefined);
  const tools = new ToolExecutor({ registry: createDefaultRegistry({ toolsPrimaryAppViewEnabled: true }), permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
  assert.equal(tools._evaluateToolPolicy(tools.registry.getTool('app_view'), { action: 'terminal', ...WHY }, harness().context).decision, 'auto');
  assert.deepEqual(PRIMARY_APP_VIEW_TOOL_NAMES, ['app_view']);
  assert.equal(primaryAppViewToolsOffered({ featureFlags: { primary_app_view: false } }, {}), true, 'switch off: the gate leaves the request alone');
});
