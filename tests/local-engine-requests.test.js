const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  startLocalEngineChatStream,
} = require('../services/backend/local-engine-requests');
const {
  MAX_INTERACTIVE_ROUNDS,
} = require('../services/backend/interactive-session-utils');

// --- helpers ---

function createActorStore(initial = {}) {
  const session = { id: 's', ...initial, active_turn: initial.active_turn || null };
  return {
    getSession: () => session,
    getSessionMessages: () => [],
    getActiveTurn: () => session.active_turn,
    setTurnIdentity(_sessionId, identity) { Object.assign(session, identity); return session; },
    setActiveTurn(_sessionId, activeTurn) { session.active_turn = activeTurn; return session; },
    clearActiveTurn() { if (!session.active_turn) return null; session.active_turn = null; return session; },
    flushSession: () => true,
  };
}

function withActorHarness(service) {
  const storeKey = service.isManagedSidecarMode ? 'sessionStore' : 'shadowStore';
  const initial = service[storeKey]?.getSession?.('s') || {};
  service[storeKey] = { ...(service[storeKey] || {}), ...createActorStore(initial) };
  service.activeStreams = new Map();
  return service;
}

function makeManagedService(overrides = {}) {
  const calls = [];
  const service = {
    sessionStore: createActorStore({ context_preferences: undefined }),
    activeStreams: new Map(),
    offlineIntelligenceService: undefined,
    _startManagedSidecarChatStream: (args) => {
      calls.push(args);
      return 'MANAGED_STREAM';
    },
    ...overrides,
  };
  return { service, calls };
}

function baseParams(overrides = {}) {
  return {
    sessionId: 's',
    prompt: 'p',
    visiblePrompt: 'p',
    traceId: 't',
    preferredModel: '  gemma  ',
    reasoningEffort: 'high',
    planMode: true,
    interactiveRoundCount: 9999,
    attachments: [],
    ...overrides,
  };
}

// --- tests ---

test('managed dispatch: returns MANAGED_STREAM and invokes _startManagedSidecarChatStream', async () => {
  const { service, calls } = makeManagedService();

  const result = await startLocalEngineChatStream(service, baseParams());

  assert.equal(result, 'MANAGED_STREAM');
  assert.equal(calls.length, 1);
});

test('managed dispatch: validates and forwards a bounded plugin command invocation', async () => {
  const { service, calls } = makeManagedService();
  const pluginCommandInvocation = {
    invocation_schema_version: 2,
    publisher_id: 'jenny-official',
    plugin_id: 'starter',
    command_id: 'command-main',
    observed_generation_id: 'gen-1',
    observed_registry_revision: 1,
    inputs: [{ type: 'string', key: 'topic', value: 'Jenny' }],
  };

  await startLocalEngineChatStream(service, baseParams({ pluginCommandInvocation }));

  assert.deepEqual(calls[0].pluginCommandInvocation, pluginCommandInvocation);
});

test('managed dispatch: rejects malformed plugin command input before the sidecar call', async () => {
  const { service, calls } = makeManagedService();
  const inputs = Array.from({ length: 17 }, (_entry, index) => ({
    type: 'integer',
    key: `input-${index}`,
    value: index,
  }));

  await assert.rejects(
    () => startLocalEngineChatStream(service, baseParams({
      pluginCommandInvocation: {
        invocation_schema_version: 2,
        publisher_id: 'jenny-official',
        plugin_id: 'starter',
        command_id: 'command-main',
        observed_generation_id: 'gen-1',
        observed_registry_revision: 1,
        inputs,
      },
    })),
    (error) => error?.code === 'CMP-PLUGIN-0015'
      && error?.reason === 'plugin_command_invocation_invalid'
      && error?.retryable === false
  );
  assert.equal(calls.length, 0);
});

function skillState({ featureEnabled = true, scopeEnabled = true, entryEnabled = true } = {}) {
  const entry = {
    id: 'bundled/humanizer', name: 'Humanizer', scope: 'bundled',
    command: 'humanize', enabled: entryEnabled,
  };
  const scope = { scope: 'bundled', enabled: scopeEnabled, entries: scopeEnabled ? [entry] : [] };
  return { featureEnabled, scopes: [scope], entries: scope.entries };
}

test('managed dispatch: validates, enriches, and forwards a skill invocation before reservation', async () => {
  const { service, calls } = makeManagedService({
    skillsService: { getState: () => skillState() },
  });

  await startLocalEngineChatStream(service, baseParams({
    skillInvocation: { id: 'bundled/humanizer' },
  }));

  assert.deepEqual(calls[0].skillInvocation, {
    id: 'bundled/humanizer', name: 'Humanizer', scope: 'bundled', command: 'humanize',
  });
});

for (const [label, state, id, reason] of [
  ['unknown', skillState(), 'bundled/missing', 'skill_unknown'],
  ['disabled', skillState({ entryEnabled: false }), 'bundled/humanizer', 'skill_disabled'],
  ['scope-disabled', skillState({ scopeEnabled: false }), 'bundled/humanizer', 'skill_scope_disabled'],
  ['feature-disabled', skillState({ featureEnabled: false }), 'bundled/humanizer', 'skills_feature_disabled'],
  ['malformed', skillState(), 'bundled/../escape', 'skill_unknown'],
]) {
  test(`managed dispatch: ${label} skill rejects before reserveStart`, async () => {
    const { service, calls } = makeManagedService({
      skillsService: { getState: () => state },
    });

    await assert.rejects(
      () => startLocalEngineChatStream(service, baseParams({ skillInvocation: { id } })),
      (error) => error?.code === 'SKILL_NOT_AVAILABLE'
        && error?.reason === reason && error?.retryable === false
    );
    assert.equal(service.sessionTurnActors, undefined);
    assert.equal(calls.length, 0);
  });
}

test('managed dispatch: runtimePreferredModel is trimmed', async () => {
  const { service, calls } = makeManagedService();

  await startLocalEngineChatStream(service, baseParams());

  assert.equal(calls[0].runtimePreferredModel, 'gemma');
});

test('managed dispatch forwards the additive approval mode unchanged', async () => {
  const { service, calls } = makeManagedService();

  await startLocalEngineChatStream(service, baseParams({ approvalMode: 'auto_run' }));

  assert.equal(calls[0].approvalMode, 'auto_run');
});

test('managed dispatch: normalizedPreferences.preferred_model is trimmed', async () => {
  const { service, calls } = makeManagedService();

  await startLocalEngineChatStream(service, baseParams());

  assert.equal(calls[0].normalizedPreferences.preferred_model, 'gemma');
});

test('managed dispatch: normalizedPreferences.plan_mode is true', async () => {
  const { service, calls } = makeManagedService();

  await startLocalEngineChatStream(service, baseParams());

  assert.equal(calls[0].normalizedPreferences.plan_mode, true);
});

test('managed dispatch: normalizedPreferences.conversation_mode is "chat"', async () => {
  const { service, calls } = makeManagedService();

  await startLocalEngineChatStream(service, baseParams());

  assert.equal(calls[0].normalizedPreferences.conversation_mode, 'chat');
});

test('managed dispatch: interactive_round_count is clamped to MAX_INTERACTIVE_ROUNDS (not 9999)', async () => {
  const { service, calls } = makeManagedService();

  await startLocalEngineChatStream(service, baseParams({ interactiveRoundCount: 9999 }));

  // Must equal the MAX constant, not the raw 9999
  assert.equal(calls[0].normalizedPreferences.interactive_round_count, MAX_INTERACTIVE_ROUNDS);
  assert.notEqual(calls[0].normalizedPreferences.interactive_round_count, 9999);
});

test('forced local inference with no selected Model Library model rejects before dispatch', async () => {
  const service = withActorHarness({
    isManagedSidecarMode: true,
    sessionStore: { getSession: () => ({}) },
    offlineIntelligenceService: {
      getState: async () => ({ mode: 'local_only', preferredLocalModel: '' }),
    },
    _startManagedSidecarChatStream: () => 'SHOULD_NOT_REACH',
  });

  await assert.rejects(
    () => startLocalEngineChatStream(service, baseParams({ attachments: [] })),
    /model selected in Model Library/
  );
});

test('forced local inference requires verified Ollama or vLLM engine provenance before dispatch', async () => {
  let dispatchCount = 0;
  const service = withActorHarness({
    isManagedSidecarMode: true,
    sessionStore: { getSession: () => ({}) },
    offlineIntelligenceService: {
      getState: async () => ({
        mode: 'local_only',
        preferredLocalModel: 'gpt-5:latest',
        selectedLocalEngineType: 'chatgpt',
        localCatalog: { available: true },
        localChatReady: true,
        localVisionReady: true,
      }),
    },
    _startManagedSidecarChatStream: () => { dispatchCount += 1; },
  });

  await assert.rejects(
    () => startLocalEngineChatStream(service, baseParams({ attachments: [] })),
    /without a verified local inference provider/
  );
  assert.equal(dispatchCount, 0);
});

test('forced local inference rejects openai-compatible endpoints even when readiness is stale', async () => {
  let dispatchCount = 0;
  const service = withActorHarness({
    isManagedSidecarMode: true,
    sessionStore: { getSession: () => ({}) },
    offlineIntelligenceService: {
      getState: async () => ({
        mode: 'local_only',
        preferredLocalModel: 'model.gguf',
        selectedLocalEngineType: 'openai-compatible',
        localCatalog: { available: true },
        localChatReady: true,
        localVisionReady: true,
      }),
    },
    _startManagedSidecarChatStream: () => { dispatchCount += 1; },
  });

  await assert.rejects(
    () => startLocalEngineChatStream(service, baseParams({ attachments: [] })),
    /without a verified local inference provider/
  );
  assert.equal(dispatchCount, 0);
});

test('forced local inference rejects stale readiness when the current local catalog probe failed', async () => {
  let dispatchCount = 0;
  const service = withActorHarness({
    isManagedSidecarMode: true,
    sessionStore: { getSession: () => ({}) },
    offlineIntelligenceService: {
      getState: async () => ({
        mode: 'local_only',
        preferredLocalModel: 'qwen:local',
        selectedLocalEngineType: 'ollama',
        localCatalog: { available: false, models: [{ id: 'qwen:local', installed: true }] },
        localChatReady: true,
        unavailableReason: 'Local model catalog is unavailable.',
      }),
    },
    _startManagedSidecarChatStream: () => { dispatchCount += 1; },
  });

  await assert.rejects(
    () => startLocalEngineChatStream(service, baseParams({ attachments: [] })),
    /Local model catalog is unavailable/
  );
  assert.equal(dispatchCount, 0);
});

test('forced local inference carries verified engine provenance into managed model resolution', async () => {
  const calls = [];
  const service = withActorHarness({
    isManagedSidecarMode: true,
    sessionStore: { getSession: () => ({}) },
    offlineIntelligenceService: {
      getState: async () => ({
        mode: 'local_only',
        preferredLocalModel: 'gpt-5:local',
        selectedLocalEngineType: 'ollama',
        localCatalog: { available: true },
        localChatReady: true,
        localVisionReady: true,
      }),
    },
    _startManagedSidecarChatStream: (args) => { calls.push(args); return 'LOCAL_STREAM'; },
  });

  const result = await startLocalEngineChatStream(service, baseParams({ attachments: [] }));
  assert.equal(result, 'LOCAL_STREAM');
  assert.equal(calls[0].runtimePreferredModel, 'gpt-5:local');
  assert.equal(calls[0].runtimePreferredEngineType, 'ollama');
});

test('offline local-only managed but localChatReady false: rejects with unavailableReason', async () => {
  const service = withActorHarness({
    isManagedSidecarMode: true,
    sessionStore: { getSession: () => ({}) },
    offlineIntelligenceService: {
      getState: async () => ({
        mode: 'local_only',
        preferredLocalModel: 'm',
        localChatReady: false,
        unavailableReason: 'down',
      }),
    },
    _startManagedSidecarChatStream: () => 'SHOULD_NOT_REACH',
  });

  await assert.rejects(
    () => startLocalEngineChatStream(service, baseParams({ attachments: [] })),
    /down/
  );
});
