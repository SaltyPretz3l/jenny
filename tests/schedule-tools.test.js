'use strict';

// Row 85 S4: `schedule_list` (read-only, no card) and `schedule_change` (always carded, never always-allow) are
// closed schemas over the schedule port, offered to the primary Jenny chat only; plus the approval card fields.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const listTool = require('../services/tools/builtin/schedule-list-tool');
const changeTool = require('../services/tools/builtin/schedule-change-tool');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { NEVER_PERSIST_ALWAYS_ALLOW } = require('../services/tools/tool-permission-migrations');
const { scheduleChangeApprovalFields, SCHEDULE_CHANGE_SCOPE } = require('../services/backend/schedule-change-approval');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };
const CADENCE = { type: 'daily_at', daily_at: '08:00', weekdays: [1, 2, 3, 4, 5] };
const GOOD = { action: 'create', label: 'Morning summary', instruction: 'Tell me what finished overnight.', cadence: CADENCE,
  purpose: 'Check every weekday morning.' };
const OK = { ok: true, check: { reminder_id: 'rem_1' }, next_fires: [] };

function harness({ port, featureFlags } = {}) {
  const project = { project_id: 'project_a', root_path: os.tmpdir(), root_id: 'root', root_revision: 1, device_id: 'device', inode: 'inode' };
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
    async change(args) { calls.push(['change', args]); return OK; },
    async list(args) { calls.push(['list', args]); return { ok: true, schema_version: 1, checks: [], truncated: false }; },
  } : port;
  const backendService = { sessionExecutionAuthority: authority, ...(featureFlags ? { featureFlags } : {}),
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } };
  const context = { sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call-1', backendService, executionAuthority, primaryScheduleService: fake, mode: 'ask',
    abortSignal: new AbortController().signal };
  return { context, calls };
}

const output = result => JSON.parse(result.content);

test('schedule_change refuses bad top-level shapes before the port and strips purpose from what it forwards', async () => {
  const { context, calls } = harness();
  const bad = [
    undefined, null, [], {}, { ...GOOD, extra: 1 }, { ...GOOD, action: 'delete' }, { ...GOOD, action: 7 },
    { ...GOOD, purpose: '' }, { ...GOOD, purpose: 7 }, { ...GOOD, purpose: undefined }, { ...GOOD, purpose: 'x'.repeat(201) },
    { ...GOOD, caller_session_id: 'caller' },
  ];
  for (const input of bad) {
    assert.deepEqual(output(await changeTool.execute(input, context)), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
  const result = await changeTool.execute(GOOD, context);
  assert.deepEqual(output(result), OK);
  assert.deepEqual(result.metadata, { result_kind: 'schedule_change', status: 'ok', reminder_id: 'rem_1' });
  const { purpose: _purpose, ...forwarded } = GOOD;
  assert.deepEqual(calls, [['change', { ...forwarded, caller_session_id: 'caller' }]]);
  assert.equal(changeTool.summarize({}), 'Scheduled checks: change');
});

test('schedule_change passes port refusals through and maps a missing port, a throw or a stale call to closed reasons', async () => {
  const refused = await changeTool.execute(GOOD, harness({ port: { change: async () => ({ ok: false, reason: 'limit_reached' }) } }).context);
  assert.deepEqual(output(refused), { ok: false, reason: 'limit_reached' });
  assert.deepEqual(refused.metadata, { result_kind: 'schedule_change', status: 'refused', reason: 'limit_reached' });
  assert.deepEqual(output(await changeTool.execute(GOOD, harness({ port: null }).context)), { ok: false, reason: 'disabled' });
  const thrown = await changeTool.execute(GOOD, harness({ port: { change: async () => { throw new Error('private C:\\x'); } } }).context);
  assert.deepEqual(output(thrown), { ok: false, reason: 'denied' });
  assert.equal(thrown.content.includes('private'), false);
  assert.deepEqual(output(await changeTool.execute(GOOD, harness({ port: { change: async () => 'done' } }).context)), { ok: false, reason: 'denied' });
  const stale = harness();
  stale.context.logicalTurnId = '';
  assert.deepEqual(output(await changeTool.execute(GOOD, stale.context)), { ok: false, reason: 'denied' });
  assert.deepEqual(stale.calls, []);
});

test('both tools answer disabled behind either kill switch and refuse Plan mode and read-only chats', async () => {
  for (const featureFlags of [{ primary_scheduled_checks: false }, { primary_chat: false }]) {
    const off = harness({ featureFlags });
    assert.deepEqual(output(await changeTool.execute(GOOD, off.context)), { ok: false, reason: 'disabled' });
    assert.deepEqual(output(await listTool.execute({}, off.context)), { ok: false, reason: 'disabled' });
    assert.deepEqual(off.calls, []);
  }
  for (const flags of [{ planMode: true }, { readOnly: true }]) {
    const { context, calls } = harness();
    assert.deepEqual(output(await changeTool.execute(GOOD, { ...context, ...flags })), { ok: false, reason: 'denied' });
    assert.deepEqual(calls, []);
    // The read answers in Plan and read-only chats, like settings_get.
    assert.notEqual(output(await listTool.execute({}, { ...context, ...flags })).reason, 'denied');
    assert.equal(calls.length, 1);
  }
});

test('schedule_list is a closed read over the port with the caller from the context', async () => {
  const { context, calls } = harness();
  for (const input of [null, [], { extra: 1 }, { include_reminders: 'yes' }]) {
    assert.deepEqual(output(await listTool.execute(input, context)), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.deepEqual(output(await listTool.execute({}, context)), { ok: true, schema_version: 1, checks: [], truncated: false });
  await listTool.execute({ include_reminders: true }, context);
  assert.deepEqual(calls, [['list', { caller_session_id: 'caller' }], ['list', { include_reminders: true, caller_session_id: 'caller' }]]);
  assert.deepEqual(output(await listTool.execute({}, harness({ port: null }).context)), { ok: false, reason: 'disabled' });
  const thrown = await listTool.execute({}, harness({ port: { list: async () => { throw new Error('private'); } } }).context);
  assert.deepEqual(output(thrown), { ok: false, reason: 'denied' });
  assert.equal(listTool.summarize({}), 'Scheduled checks: list');
});

test('the manifest, policy and registry pin the pair: list auto and read-only, change ask and never always-allow', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'tools', 'tool-manifest.json'), 'utf8'));
  const list = manifest.tools.find(item => item.name === 'schedule_list');
  const change = manifest.tools.find(item => item.name === 'schedule_change');
  for (const entry of [list, change]) {
    assert.equal(entry.owner, 'electron');
    assert.equal(entry.availability.config_flag, 'tools_primary_schedules_enabled');
    assert.equal(entry.availability.workspace_required, false);
    assert.equal(entry.parameters.additionalProperties, false);
  }
  assert.equal(list.read_only, true);
  assert.equal(list.side_effecting, false);
  assert.deepEqual(Object.keys(list.parameters.properties), ['include_reminders']);
  assert.equal(change.read_only, false);
  assert.equal(change.side_effecting, true);
  assert.deepEqual(change.parameters.required, ['action', 'purpose']);
  assert.deepEqual(change.parameters.properties.action.enum, ['create', 'update', 'enable', 'disable', 'cancel']);
  assert.equal(change.parameters.properties.cadence.additionalProperties, false);
  assert.deepEqual(change.parameters.properties.cadence.properties.type.enum, ['once_at', 'daily_at', 'interval_minutes']);
  assert.equal(change.parameters.properties.cadence.properties.interval_minutes.minimum, 30);
  assert.equal(change.parameters.properties.purpose.maxLength, 200);
  assert.equal(NEVER_PERSIST_ALWAYS_ALLOW.has('schedule_change'), true);
  assert.equal(listTool.readOnly, true);
  assert.equal(changeTool.sideEffecting, true);

  for (const name of ['schedule_list', 'schedule_change']) {
    assert.equal(createDefaultRegistry({}).getTool(name), undefined);
    assert.equal(createDefaultRegistry({ toolsPrimarySchedulesEnabled: false }).getTool(name), undefined);
    const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: name } });
    assert.equal(hosted.success, false, name);
  }
  const tools = new ToolExecutor({ registry: createDefaultRegistry({ toolsPrimarySchedulesEnabled: true }),
    permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
  assert.equal(tools._evaluateToolPolicy(tools.registry.getTool('schedule_list'), {}, harness().context).decision, 'auto');
  assert.equal(tools._evaluateToolPolicy(tools.registry.getTool('schedule_change'), GOOD, harness().context).decision, 'ask');
});

test('the approval card carries the port\'s trusted description, or a refused state; never model text', async () => {
  const card = { ok: true, action: 'create', reminder_id: null, before: null,
    after: { label: 'Morning summary', instruction: 'Tell me.', cadence_text: 'Weekdays at 08:00', enabled: true, next_fires: ['2026-11-02T08:00:00-06:00'] } };
  const seen = [];
  const service = { primarySchedules: { describeChange: async (input) => { seen.push(input); return card; } } };
  const fields = await scheduleChangeApprovalFields(service, 'caller', { ...GOOD, label: 'ignored by the card' });
  assert.deepEqual(fields, { schedule_change_approval: { schema_version: 1, state: 'ready', action: 'create', reminder_id: null,
    before: null, after: card.after } });
  const { purpose: _purpose, ...forwarded } = { ...GOOD, label: 'ignored by the card' };
  assert.deepEqual(seen, [{ ...forwarded, caller_session_id: 'caller' }]);
  const refusedWith = async (answer) => scheduleChangeApprovalFields({ primarySchedules: { describeChange: async () => answer } }, 'caller', GOOD);
  assert.deepEqual(await refusedWith({ ok: false, reason: 'not_a_check' }),
    { schedule_change_approval: { schema_version: 1, state: 'refused', reason: 'not_a_check', before: null, after: null } });
  assert.equal((await refusedWith({ ok: false, reason: 'Error: C:/secret' })).schedule_change_approval.reason, 'denied');
  assert.equal((await refusedWith('nonsense')).schedule_change_approval.state, 'refused');
  const thrown = await scheduleChangeApprovalFields({ primarySchedules: { describeChange: async () => { throw new Error('x'); } } }, 'caller', GOOD);
  assert.equal(thrown.schedule_change_approval.reason, 'denied');
  assert.equal((await scheduleChangeApprovalFields({}, 'caller', GOOD)).schedule_change_approval.reason, 'disabled');
  assert.equal(SCHEDULE_CHANGE_SCOPE, 'Scheduled checks');
});
