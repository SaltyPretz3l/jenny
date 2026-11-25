'use strict';
// new-test-file: row 197 T2, which turns are offered the Live tab's two tools (services/backend/run-view-tool-gate.js) and the flag that carries them; a new surface.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { hiddenRunViewTools, withRunViewEngineGate, withRunViewToolGate } = require('../services/backend/run-view-tool-gate');
const { managedToolPreferenceInput } = require('../services/backend/managed-sidecar-chat-helpers');
const { buildFeatureFlags, INTERNAL_FEATURE_FLAG_KEYS } = require('../services/feature-flags');
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-config');

const BOTH = ['run_view_look', 'run_view_restart'];

function service({
  refusal = null, confirmed = true, engine = 'ollama', flags = {}, project = 'p1', holder = true, throws = '',
} = {}) {
  const seen = [];
  return {
    seen,
    currentEngineType: engine,
    featureFlags: { tools_run_view_enabled: true, live_run_view: true, ...flags },
    projectAuthority: { captureSession: (id) => {
      if (throws === 'session') throw new Error('no session');
      seen.push(id);
      return { project_id: project };
    } },
    ...(holder ? { runView: {
      startRefusal: () => { if (throws === 'gate') throw new Error('gate'); return refusal; },
      hasConfirmedCommand: (id) => { if (throws === 'store') throw new Error('store'); seen.push(`cmd:${id}`); return confirmed; },
    } } : {}),
  };
}

const target = { sessionId: 'chat-1', session: { id: 'chat-1' } };

test('a chat whose project has a confirmed command, on a local engine, sees both tools', () => {
  const s = service();
  assert.deepEqual(hiddenRunViewTools(s, target), []);
  assert.deepEqual(s.seen, ['chat-1', 'cmd:p1']);
  const prefs = { disabled_tools: ['write_file'] };
  assert.equal(withRunViewToolGate(s, target, prefs), prefs, 'nothing hidden leaves the preferences as they were');
});

test('no confirmed command, no project, no holder, or a Live tab that may not run hides both', () => {
  for (const options of [
    { confirmed: false }, { project: '' }, { holder: false }, { refusal: 'disabled' }, { refusal: 'unsupported_platform' },
  ]) {
    assert.deepEqual(hiddenRunViewTools(service(options), target), BOTH, JSON.stringify(options));
  }
});

test('anything that cannot be read hides both (fail closed)', () => {
  for (const throws of ['session', 'gate', 'store']) {
    assert.deepEqual(hiddenRunViewTools(service({ throws }), target), BOTH, throws);
  }
});

test('a remote engine hides only the look; sandbox-only hides only the restart', () => {
  assert.deepEqual(hiddenRunViewTools(service({ engine: 'openai' }), target), ['run_view_look']);
  assert.deepEqual(hiddenRunViewTools(service({ refusal: 'sandbox_only' }), target), ['run_view_restart']);
  assert.deepEqual(hiddenRunViewTools(service({ refusal: 'sandbox_only', engine: 'openai' }), target), BOTH);
});

test('review F2.1/L1: strict or paranoid safety mode hides both; the turn path leaves the engine check until the model is resolved', () => {
  for (const safetyMode of ['strict', 'paranoid']) {
    const s = { ...service(), configService: { getChatUiState: () => ({ safetyMode }) } };
    assert.deepEqual(hiddenRunViewTools(s, target), BOTH, safetyMode);
  }
  const unreadable = { ...service(), configService: { getChatUiState: () => { throw new Error('gone'); } } };
  assert.deepEqual(hiddenRunViewTools(unreadable, target), BOTH, 'an unreadable mode hides both');
  assert.deepEqual(hiddenRunViewTools({ ...service(), configService: { getChatUiState: () => ({ safetyMode: 'normal' }) } }, target), []);
  // Before resolution the running engine may be a cloud one about to be switched away from (or the reverse).
  assert.deepEqual(hiddenRunViewTools(service({ engine: 'openai' }), target, { engine: false }), []);
  const before = managedToolPreferenceInput({ disabled_tools: [] }, {
    service: service({ engine: 'openai' }), sessionId: 'chat-1', session: { id: 'chat-1' },
  });
  assert.equal((before.disabled_tools || []).includes('run_view_look'), false, 'the pre-resolution pass does not judge the engine');
  const after = withRunViewEngineGate(service({ engine: 'openai' }), before).disabled_tools;
  assert.ok(after.includes('run_view_look') && !after.includes('run_view_restart'), 'the post-resolution pass does');
});

test('correctness review 4: the engine pass reads no project, and leaves fixed-list and already-denied turns alone', () => {
  const remote = service({ engine: 'openai' });
  remote.runView.hasConfirmedCommand = () => { throw new Error('the engine pass must not re-read the project'); };
  assert.deepEqual(withRunViewEngineGate(remote, null), { disabled_tools: ['run_view_look'] });
  const handoff = { enabled_tools: ['complete_session_handoff'], disabled_tools: [], disabled_tool_families: [] };
  assert.equal(withRunViewEngineGate(remote, handoff), handoff, 'a fixed list without the look is untouched');
  const denied = { disabled_tools: ['run_view_look', 'run_view_restart'] };
  assert.equal(withRunViewEngineGate(remote, denied), denied);
  const prefs = { disabled_tools: ['zeta'] };
  assert.equal(withRunViewEngineGate(service(), prefs), prefs, 'a local engine changes nothing');
  assert.equal(withRunViewEngineGate(service({ engine: 'openai', flags: { live_run_view: false } }), prefs), prefs);
});

test('review F2.1: the managed turn gates the look again right after the model is resolved', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../services/backend/managed-sidecar-chat.js'), 'utf8');
  const resolved = src.indexOf('lockdownRequest.assertResolvedEngine();');
  // Row 196: the look's gate sits inside the combined line that also gates the computer tool.
  const regate = src.indexOf('requestToolPreferences = withComputerEngineGate(service, withRunViewEngineGate(service, requestToolPreferences));');
  const authority = src.indexOf('captureManagedExecutionAuthority(service, resolvedSessionId');
  assert.ok(resolved > 0 && regate > resolved && authority > regate, 'resolve, then gate, then the execution authority');
});

test('with either flag off the tools are not registered, so the request is left alone', () => {
  for (const flags of [{ tools_run_view_enabled: false }, { live_run_view: false }]) {
    assert.deepEqual(hiddenRunViewTools(service({ flags, confirmed: false }), target), [], JSON.stringify(flags));
  }
});

test('hidden names join disabled_tools once, sorted, keeping what was there', () => {
  const s = service({ confirmed: false });
  assert.deepEqual(withRunViewToolGate(s, target, { disabled_tools: ['run_view_look', 'zeta'], other: 1 }),
    { disabled_tools: ['run_view_look', 'run_view_restart', 'zeta'], other: 1 });
  assert.deepEqual(withRunViewToolGate(s, target, null), { disabled_tools: BOTH });
});

test('the turn path applies the gate to every ordinary turn', () => {
  const hidden = managedToolPreferenceInput({ disabled_tools: ['write_file'] }, {
    service: service({ confirmed: false }), sessionId: 'chat-1', session: { id: 'chat-1' },
  });
  for (const name of BOTH) assert.ok(hidden.disabled_tools.includes(name), name);
  const offered = managedToolPreferenceInput({ disabled_tools: [] }, {
    service: service(), sessionId: 'chat-1', session: { id: 'chat-1' },
  });
  for (const name of BOTH) assert.equal((offered.disabled_tools || []).includes(name), false, name);
});

test('the flag is internal and on by default, with a kill switch', () => {
  assert.equal(buildFeatureFlags({}).tools_run_view_enabled, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_TOOLS_RUN_VIEW: '0' }).tools_run_view_enabled, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('tools_run_view_enabled'));
});

function sidecarConfig(featureFlags, hostMode = 'desktop') {
  return buildManagedSidecarConfig({
    hostMode, currentEngineType: 'replay', currentModel: 'replay-model', defaultModel: 'replay-model',
    options: { userDataPath: os.tmpdir(), modelEndpoint: { engine: 'replay', model: 'replay-model' } },
    featureFlags, toolExecutor: {},
    configService: { getState: () => ({ tools: {} }), getToolsWorkspaceRoot: () => '' },
    skillsService: { getSidecarConfig: () => ({}) }, knowledgeService: { getSidecarConfig: () => ({}) },
  });
}

test('the sidecar flag is a real true only with the Live tab on, and hosted keeps it closed', () => {
  assert.equal(sidecarConfig({ tools_run_view_enabled: true }).tools_run_view_enabled, true);
  for (const flags of [{}, { tools_run_view_enabled: 'true' }, { tools_run_view_enabled: true, live_run_view: false }]) {
    assert.equal(sidecarConfig(flags).tools_run_view_enabled, false, JSON.stringify(flags));
  }
  assert.equal(sidecarConfig({ tools_run_view_enabled: true }, 'server').tools_run_view_enabled, false);
});
