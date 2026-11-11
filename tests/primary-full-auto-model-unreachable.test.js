'use strict';

/* Full auto on the Jenny chat can be armed by a person only. Each model-reachable surface that could
 * plausibly carry it is exercised through its real validator or allowlist: the settings allowlist and
 * the settings_change tool, the chat_configure tool and the chat-manage port behind it, and the tool
 * manifest (read as data). Behaviour only: nothing here reads source text. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { PRIMARY_SETTINGS_KEYS } = require('../services/primary-settings-contract');
const { getPrimarySettingEntry } = require('../services/primary-settings-allowlist');
const settingsChangeTool = require('../services/tools/builtin/settings-change-tool');
const chatConfigureTool = require('../services/tools/builtin/chat-configure-tool');
const { createPrimaryChatManageService } = require('../services/primary-chat-manage-service');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');

const FULL_AUTO_KEYS = [
  'full_auto', 'primary_full_auto', 'primaryFullAuto', 'primaryChat.fullAuto', 'primaryChat.full_auto',
  'fullAuto', 'full_auto_armed', 'default_run_mode.full_auto',
];
const { parseToolOutput } = require('./helpers/refusal-output');
const output = parseToolOutput;

test('no Full auto key is on the settings contract or resolves in the settings allowlist', () => {
  for (const key of FULL_AUTO_KEYS) {
    assert.equal(PRIMARY_SETTINGS_KEYS.includes(key), false, key);
    assert.equal(getPrimarySettingEntry(key), null, key);
  }
  assert.equal(PRIMARY_SETTINGS_KEYS.some((key) => /full.?auto/i.test(key)), false);
});

test('settings_change refuses a Full auto key before any port is reached', async () => {
  let reached = 0;
  const context = { primarySettingsService: { change: async () => { reached += 1; return { ok: true }; } } };
  for (const key of FULL_AUTO_KEYS) {
    for (const value of [true, 'on', 'armed']) {
      const answer = output(await settingsChangeTool.execute(
        { changes: [{ key, value }], purpose: 'Turn on Full auto.' }, context,
      ));
      assert.equal(answer.ok, false, `${key}=${value}`);
      assert.equal(answer.reason, 'not_allowed', `${key}=${value}`);
    }
  }
  // Mixed into an otherwise valid batch it still refuses the whole call.
  const mixed = output(await settingsChangeTool.execute({
    changes: [{ key: 'time_format_24h', value: true }, { key: 'full_auto', value: true }], purpose: 'Both.',
  }, context));
  assert.deepEqual([mixed.ok, mixed.reason], [false, 'not_allowed']);
  // Auto as the default run mode stays refused too.
  const auto = output(await settingsChangeTool.execute({
    changes: [{ key: 'default_run_mode', value: 'auto' }], purpose: 'Auto.',
  }, context));
  assert.deepEqual([auto.ok, auto.reason], [false, 'not_allowed']);
  assert.equal(reached, 0);
});

function configureHarness() {
  const project = { project_id: 'project_a', root_path: os.tmpdir(), root_id: 'root', root_revision: 1,
    device_id: 'device', inode: 'inode' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: (captured) => captured,
      _sessionStore: { getSessionSummary: () => ({ id: 'caller', run_mode: 'ask', plan_mode: false }) } },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const executionAuthority = authority.captureSession('caller', { requestId: 'stream', mode: 'assist', approvalMode: 'prompt' });
  const calls = [];
  const port = { async configure(args) {
    calls.push(args);
    return { ok: true, session_id: args.target_session_id, action: args.action, before: 'ask', after: args.value };
  } };
  const context = {
    sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation', callId: 'call-1',
    backendService: { sessionExecutionAuthority: authority,
      sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } },
    executionAuthority, primaryChatManageService: port, mode: 'ask', abortSignal: new AbortController().signal,
  };
  return { context, calls };
}

test('chat_configure refuses an unknown full_auto field and never passes it to the port', async () => {
  const base = { session_id: 'other', action: 'set_run_mode', value: 'plan', purpose: 'Switch it.' };
  const { context, calls } = configureHarness();
  for (const extra of [{ full_auto: true }, { fullAuto: true }, { primary_full_auto: 'on' }]) {
    const answer = output(await chatConfigureTool.execute({ ...base, ...extra }, context));
    assert.deepEqual(answer, { ok: false, reason: 'invalid_input' }, JSON.stringify(extra));
  }
  // Full auto is not a run mode value or a configure action either.
  for (const input of [
    { ...base, action: 'set_full_auto', value: 'on' },
    { ...base, action: 'full_auto', value: 'true' },
  ]) {
    const answer = output(await chatConfigureTool.execute(input, context));
    assert.deepEqual(answer, { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
});

test('chat_configure still refuses run mode auto, whatever its case, before the port', async () => {
  const { context, calls } = configureHarness();
  for (const value of ['auto', 'Auto', ' AUTO ']) {
    const answer = output(await chatConfigureTool.execute(
      { session_id: 'other', action: 'set_run_mode', value, purpose: 'Auto.' }, context,
    ));
    assert.deepEqual(answer, { ok: false, reason: 'not_allowed' }, value);
  }
  assert.deepEqual(calls, []);
});

function manageHarness() {
  const store = new Map([
    ['p1', { id: 'p1', title: 'Jenny', session_role: 'primary', run_mode: 'ask' }],
    ['s1', { id: 's1', title: 'Work', run_mode: 'ask', plan_mode: false, project_id: 'general' }],
  ]);
  const writes = [];
  const backend = {
    async setSessionPreferences(id, prefs) { writes.push([id, prefs]); Object.assign(store.get(id), prefs); return store.get(id); },
    async setSessionMeta() { return { ok: true }; },
  };
  const service = createPrimaryChatManageService({
    backendService: () => backend,
    sessionStore: () => ({ getSessionSummary: (id) => (store.has(id) ? { ...store.get(id) } : null) }),
    controls: () => ({ recordChatChange: () => true }),
    primarySessionId: () => 'p1',
    isSessionBusy: () => false,
  });
  return { service, store, writes };
}

test('the chat-manage port refuses set_run_mode auto and writes nothing for an extra full_auto field', async () => {
  const { service, store, writes } = manageHarness();
  for (const value of ['auto', 'AUTO', ' Auto ']) {
    const answer = await service.configure({ target_session_id: 's1', caller_session_id: 'p1', action: 'set_run_mode', value });
    assert.deepEqual(answer, { ok: false, reason: 'not_allowed' }, value);
  }
  for (const value of ['full_auto', 'full-auto']) {
    const answer = await service.configure({ target_session_id: 's1', caller_session_id: 'p1', action: 'set_run_mode', value });
    assert.deepEqual(answer, { ok: false, reason: 'invalid_input' }, value);
  }
  const extra = await service.configure({
    target_session_id: 's1', caller_session_id: 'p1', action: 'set_run_mode', value: 'plan', full_auto: true,
  });
  assert.equal(extra.ok, true);
  assert.deepEqual(writes, [['s1', { run_mode: 'plan' }]]);
  assert.equal(store.get('s1').full_auto, undefined);
  assert.equal(store.get('s1').run_mode, 'plan');
});

test('the tool manifest, read as data, has no tool named for Full auto', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'tools', 'tool-manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.tools) && manifest.tools.length > 0);
  const names = manifest.tools.map((tool) => String(tool.name));
  assert.deepEqual(names.filter((name) => /full[_-]?auto/i.test(name)), []);
});
