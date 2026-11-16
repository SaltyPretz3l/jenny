'use strict';

// Row 136 slice 3: `session_prioritize`, the primary Jenny chat's "Finish this first". The tool runs here
// over the real session directory and the real lane admission: who may pick, the person's pick standing,
// a pick made before the chat starts, and Jenny's own requests not being held behind her pick.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const tool = require('../services/tools/builtin/session-prioritize-tool');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { createSessionDirectoryService } = require('../services/session-directory-service');
const { visibleChatPredicate } = require('../services/backend/memory-reflection-eligibility');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../services/session-runtime/lanes');
const { PRIMARY_PRIORITY_TOOL_NAMES, primaryPriorityToolsOffered } = require('../services/backend/primary-settings-tool-gate');
const { DIRECTORY_DATA_NOTE } = require('../services/tools/builtin/session-directory-tool-support');
const { parseToolOutput: output } = require('./helpers/refusal-output');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };
const T0 = '2026-11-11T10:00:00.000Z';
const ROUTE = captureRuntimeRoute({ engine_type: 'ollama', provider_id: 'ollama', configuration_revision: 'config-1',
  resource_class: 'local', requires_gpu: true });
// A title with a line break and an emoji on the 60-character cut of the row label.
const ODD_TITLE = `Two\n lines ${'x'.repeat(49)}\u{1F600}\u{1F600}`;

function chat(id, extra = {}) {
  return { id, project_id: 'project_a', title: `Chat ${id}`, session_type: 'chat', created_at: T0, updated_at: T0,
    message_count: 2, archived_at: null, lockdown: false, spawned_from: null, linked_session_ids: [], ...extra };
}

// P is the primary Jenny chat; `long`, `quick` and `odd` are project chats; `locked` is invisible to everyone.
function harness({ caller = 'P', running = ['long'] } = {}) {
  const sessions = [chat('P', { project_id: 'project_general', session_role: 'primary', title: 'Jenny' }),
    chat('long', { title: 'Rebuild the importer' }), chat('quick', { title: 'YouTube summary' }),
    chat('odd', { title: ODD_TITLE }), chat('locked', { lockdown: true })];
  const clock = { now: 1_000 };
  const lanes = new RuntimeLaneAdmission({ now: () => clock.now,
    limits: { local: { runnable_turns: 4, inference_requests: 1 } } });
  const start = (id) => lanes.tryAcquireTurn({ sessionId: id, route: ROUTE });
  running.forEach(start);
  const backend = { sessionRuntime: { store: { getStatus: () => ({ revision: 1 }),
    listSummaries: () => ({ items: [], next_cursor: null }), get: () => null }, lanes }, featureFlags: {} };
  const sessionStore = {
    listSessionRecords: () => sessions.map((entry) => ({ ...entry, active_turn: null })),
    getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }),
  };
  const logged = [];
  const directory = createSessionDirectoryService({
    sessionStore: () => sessionStore, runtime: () => null, visibleChat: () => visibleChatPredicate(backend),
    primaryChatEnabled: () => true, log: (_level, event, fields) => logged.push([event, fields]),
  });
  const project = { project_id: 'project_a', root_path: os.tmpdir(), root_id: 'root', root_revision: 1,
    device_id: 'device', inode: 'inode' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: (captured) => captured,
      _sessionStore: { getSessionSummary: () => ({ id: caller, run_mode: 'auto', plan_mode: false }) } },
    permissionStore: PERMISSIONS,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const executionAuthority = authority.captureSession(caller, { requestId: 'stream', mode: 'assist', approvalMode: 'auto' });
  const context = { sessionId: caller, streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call', backendService: { ...backend, sessionExecutionAuthority: authority, sessionStore },
    executionAuthority, sessionDirectoryService: directory, mode: 'auto', abortSignal: new AbortController().signal };
  const infer = (sessionId, ownerId = `req_${sessionId}`) => lanes.tryAcquireInference({ ownerId, sessionId,
    route: ROUTE, queue: true });
  const done = (admission) => lanes.release(admission.lease, { producerSettled: true });
  return { clock, context, done, infer, lanes, logged, start };
}

function executor() {
  return new ToolExecutor({ registry: createDefaultRegistry({ toolsSessionDirectoryEnabled: true }),
    permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
}

test('session_prioritize takes one chat id and an optional boolean, and refuses anything else before any work', async () => {
  const { context, lanes } = harness();
  for (const input of [{}, { session_id: '' }, { session_id: ['long'] }, { session_id: 'long', first: 'yes' },
    { session_id: 'long', purpose: 'because' }, { session_id: 'x'.repeat(257) }, null, []]) {
    const result = await tool.execute(input, context);
    assert.deepEqual(output(result), { ok: false, reason: 'invalid_request' });
    assert.equal(result.isError, true);
  }
  assert.equal(lanes.firstSession(), null);
});

test('Jenny puts a running chat first: the lanes record her as the chooser and her row names the chat', async () => {
  const { context, infer, lanes, logged } = harness({ running: ['long', 'quick'] });
  const result = await tool.execute({ session_id: 'quick' }, context);
  assert.deepEqual(output(result), { ok: true, session_id: 'quick', title: 'YouTube summary', first: true,
    running: true, note: DIRECTORY_DATA_NOTE });
  assert.equal(result.isError, false);
  assert.equal(result.summary, 'Put "YouTube summary" first');
  // The bridge carries metadata, not the summary, to the saved row (gate sitting 2026-11-14, G11).
  assert.deepEqual(result.metadata, { result_kind: 'session_prioritize', status: 'ok', row_summary: 'Put "YouTube summary" first' });
  assert.equal(tool.summarize({ session_id: 'quick' }), 'Chat order');
  assert.deepEqual(lanes.firstSession(), { session_id: 'quick', set_by: 'primary', set_at: 1_000 });
  assert.deepEqual(logged, [['session_directory.prioritize', { session_id: 'quick', first: true }]]);
  // The other chat waits behind the pick; Jenny, who made it, does not (she still answers the person).
  const held = infer('long');
  assert.deepEqual([held.status, held.held_for_first], ['waiting', true]);
  assert.equal(infer('P').status, 'granted');
});

test('the row label is one line of whole characters, whatever the other chat is called', async () => {
  const { context, start } = harness();
  start('odd');
  const result = await tool.execute({ session_id: 'odd' }, context);
  assert.equal(result.summary, `Put "Two lines ${'x'.repeat(49)}\u{1F600}" first`);
  assert.equal(output(result).title, ODD_TITLE, 'the data keeps the title as the directory gives it');
});

test('the person\'s pick stands: Jenny can neither replace it nor lift it', async () => {
  const { context, lanes } = harness({ running: ['long', 'quick'] });
  assert.equal(lanes.setFirstSession('long').status, 'set');
  for (const input of [{ session_id: 'quick' }, { session_id: 'long' }, { session_id: 'long', first: false }]) {
    const refused = await tool.execute(input, context);
    const value = JSON.parse(refused.content);
    assert.equal(value.reason, 'user_pick_active', JSON.stringify(input));
    assert.match(value.message, /their choice stands/);
    assert.deepEqual([refused.isError, refused.summary], [true, 'Chat order']);
    assert.equal(Object.hasOwn(refused.metadata, 'row_summary'), false);
  }
  assert.deepEqual(lanes.firstSession(), { session_id: 'long', set_by: 'user', set_at: 1_000 });
});

test('first=false lifts only a pick Jenny made on that chat', async () => {
  const { context, lanes, logged } = harness({ running: ['long', 'quick'] });
  const nothing = await tool.execute({ session_id: 'quick', first: false }, context);
  assert.deepEqual(output(nothing), { ok: true, session_id: 'quick', title: 'YouTube summary', first: false,
    changed: false, note: DIRECTORY_DATA_NOTE });
  assert.equal(nothing.summary, 'Chat order');
  assert.equal(Object.hasOwn(nothing.metadata, 'row_summary'), false, 'nothing changed: the row keeps its generic label');
  await tool.execute({ session_id: 'quick' }, context);
  const other = await tool.execute({ session_id: 'long', first: false }, context);
  assert.equal(output(other).changed, false, 'another chat\'s pick is left alone');
  assert.equal(lanes.firstSession().session_id, 'quick');
  const lifted = await tool.execute({ session_id: 'quick', first: false }, context);
  assert.deepEqual([output(lifted).changed, lifted.summary, lifted.isError], [true, '"YouTube summary" takes turns again', false]);
  assert.equal(lifted.metadata.row_summary, '"YouTube summary" takes turns again');
  assert.equal(lanes.firstSession(), null);
  assert.deepEqual(logged.at(-1), ['session_directory.prioritize', { session_id: 'quick', first: false }]);
});

test('a chat with no reply running yet goes first once it starts, and the pick is dropped if it never does', async () => {
  const { clock, context, done, infer, lanes, start } = harness();
  const result = await tool.execute({ session_id: 'quick' }, context);
  assert.deepEqual([output(result).first, output(result).running], [true, false]);
  assert.equal(lanes.firstSession().session_id, 'quick');
  // Nothing is held for a chat that has not started.
  const before = infer('long');
  assert.equal(before.status, 'granted');
  done(before);
  // Its reply starts five minutes later (Jenny's message woke it): the pick takes effect from then.
  clock.now += 5 * 60_000;
  start('quick');
  const held = infer('long');
  assert.deepEqual([held.status, held.held_for_first], ['waiting', true]);
  const first = infer('quick');
  assert.equal(first.status, 'granted');
  done(first);
  assert.equal(infer('P').status, 'granted', 'the chat that made the pick is not held in the first chat\'s gaps');

  const never = harness();
  await tool.execute({ session_id: 'quick' }, never.context);
  never.clock.now += 10 * 60_000;
  assert.equal(never.lanes.firstSession().session_id, 'quick');
  never.clock.now += 1;
  assert.equal(never.lanes.firstSession(), null);
  // The person's own button still needs a running reply.
  assert.deepEqual(never.lanes.setFirstSession('quick'), { status: 'rejected', reason: 'session_not_running' });
});

test('only the primary chat may pick: never itself, never a chat it cannot see, never from another chat', async () => {
  const { context, lanes } = harness({ running: ['long', 'quick'] });
  const self = JSON.parse((await tool.execute({ session_id: 'P' }, context)).content);
  assert.equal(self.reason, 'self');
  assert.match(self.message, /cannot be put first/);
  for (const id of ['locked', 'missing']) {
    assert.deepEqual(output(await tool.execute({ session_id: id }, context)), { ok: false, reason: 'not_found' });
  }
  // A project chat that reaches the tool anyway (the gate hides it) is refused by the directory.
  const ordinary = harness({ caller: 'long', running: ['long', 'quick'] });
  assert.deepEqual(output(await tool.execute({ session_id: 'quick' }, ordinary.context)), { ok: false, reason: 'unavailable' });
  assert.deepEqual([lanes.firstSession(), ordinary.lanes.firstSession()], [null, null]);
  // No lane admission (the session runtime is off): unavailable, not a throw.
  const bare = harness({ running: ['quick'] });
  bare.context.backendService = { ...bare.context.backendService, sessionRuntime: null };
  assert.deepEqual(output(await tool.execute({ session_id: 'quick' }, bare.context)), { ok: false, reason: 'unavailable' });
});

test('Plan mode, read-only chats and stale calls change nothing; hosted has no such tool', async () => {
  for (const flags of [{ planMode: true }, { readOnly: true }, { logicalTurnId: '' }]) {
    const { context, lanes } = harness({ running: ['long', 'quick'] });
    const refused = await tool.execute({ session_id: 'quick' }, { ...context, ...flags });
    assert.equal(output(refused).reason, flags.logicalTurnId === '' ? 'stale_operation' : 'mode_refused');
    assert.equal(lanes.firstSession(), null);
  }
  const { context } = harness();
  assert.equal(executor()._preflightTool({ toolName: 'session_prioritize', callId: 'call', input: { session_id: 'a' } },
    { ...context, readOnly: true, planMode: true }, { preApproved: true }).tool, undefined);
  const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'session_prioritize' } });
  assert.equal(hosted.success, false);
});

// tests/primary-settings-tool-gate.test.js pins the deny lists every other chat gets.
test('no card by default, registered with the directory tools, and offered to the primary chat alone', () => {
  const { context } = harness();
  const tools = executor();
  assert.equal(tools._evaluateToolPolicy(tools.registry.getTool('session_prioritize'), { session_id: 'a' }, context).decision, 'auto');
  assert.equal(createDefaultRegistry({ toolsSessionDirectoryEnabled: false }).getTool('session_prioritize'), undefined);
  assert.deepEqual([...PRIMARY_PRIORITY_TOOL_NAMES], ['session_prioritize']);
  const service = { featureFlags: {} };
  assert.equal(primaryPriorityToolsOffered(service, { session: { id: 'p', session_role: 'primary' } }), true);
  assert.equal(primaryPriorityToolsOffered(service, { session: { id: 's', spawned_from: { parent_session_id: 'p' } } }), false);
  // A chat whose role cannot be read is not offered it.
  assert.equal(primaryPriorityToolsOffered(service, { session: { get session_role() { throw new Error('boom'); } } }), false);
});
