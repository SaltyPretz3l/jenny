const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeOllamaFailure,
  ensureManagedLlamaServerReadyForChat,
} = require('../services/backend/managed-sidecar-chat-reconnect');

function makeLlamaPreflightService({
  state = 'ready', ensuredState = 'ready', engine = 'llama-server', currentModel = 'ornith:9b', tag = 'ornith:9b',
} = {}) {
  const calls = [];
  const logs = [];
  const model = { engine, modelPath: 'G:\\models\\ornith.gguf', tag, mtp: { mode: 'mtp' } };
  return {
    calls,
    logs,
    currentModel,
    options: { getLlamaServerManager: () => ({
      getStatus: () => ({ state }),
      async ensureRunning(spec) { calls.push(spec); return { state: ensuredState, lastError: 'still down' }; },
    }) },
    configService: { getLocalEngines: () => ({ openaiCompatible: { managed: {
      enabled: true, profileId: 'balanced', lastUsedTag: 'ornith-9b', perModel: { 'ornith-9b': model },
    } } }) },
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
  };
}

test('describeOllamaFailure names the crash code and remediation', () => {
  const message = describeOllamaFailure({
    reason: 'crash',
    code: 1,
    likelyCause: 'port_in_use',
    remediation: 'Another process is already using port 11434. Close it and retry.',
  });
  assert.match(message, /exit code 1/);
  assert.match(message, /port 11434/);
});

test('describeOllamaFailure handles signal, not_found, spawn_error, and timeout', () => {
  assert.match(
    describeOllamaFailure({ reason: 'crash', signal: 'SIGKILL' }),
    /signal SIGKILL/
  );
  assert.match(
    describeOllamaFailure({ reason: 'not_found', remediation: 'Install Ollama.' }),
    /could not be started.*Install Ollama/i
  );
  assert.match(
    describeOllamaFailure({ reason: 'spawn_error', remediation: 'Bad exe.' }),
    /could not be launched.*Bad exe/i
  );
  assert.match(
    describeOllamaFailure({ reason: 'startup_timeout' }),
    /did not become ready in time/i
  );
});

test('describeOllamaFailure falls back to the generic message without detail', () => {
  const generic = 'Ollama is unavailable after the preflight start attempt.';
  assert.equal(describeOllamaFailure(null), generic);
  assert.equal(describeOllamaFailure(undefined), generic);
  assert.equal(describeOllamaFailure({}), generic);
});

test('llama-server chat preflight is silent when already ready', async () => {
  const service = makeLlamaPreflightService();
  assert.equal(await ensureManagedLlamaServerReadyForChat(service, { engineType: 'openai-compatible' }), true);
  assert.deepEqual(service.calls, []);
  assert.deepEqual(service.logs, []);
});

test('llama-server chat preflight waits for the manager chain before trusting ready', async () => {
  const service = makeLlamaPreflightService();
  let released = false;
  const manager = service.options.getLlamaServerManager();
  manager.settled = () => new Promise((resolve) => setTimeout(() => {
    released = true;
    resolve({ state: 'ready' });
  }, 5));
  service.options.getLlamaServerManager = () => manager;
  assert.equal(await ensureManagedLlamaServerReadyForChat(service, { engineType: 'openai-compatible' }), true);
  assert.equal(released, true, 'the re-broker in flight settled first');
  // The chain can end somewhere else than ready (a stop raced in): relaunch.
  manager.settled = async () => ({ state: 'stopped' });
  assert.equal(await ensureManagedLlamaServerReadyForChat(service, { engineType: 'openai-compatible' }), true);
  assert.equal(service.calls.length, 1);
});

test('llama-server chat preflight restarts a crashed server from persisted config with the display tag', async () => {
  const service = makeLlamaPreflightService({ state: 'crashed' });
  assert.equal(await ensureManagedLlamaServerReadyForChat(service, { engineType: 'openai-compatible' }), true);
  assert.deepEqual(service.calls, [{
    modelTag: 'ornith:9b', modelPath: 'G:\\models\\ornith.gguf', profileId: 'balanced', mtp: { mode: 'mtp' },
  }]);
  assert.deepEqual(service.logs.map(({ event }) => event), [
    'chat.llama_server_preflight_restart', 'chat.llama_server_preflight_ready',
  ]);
  const untagged = makeLlamaPreflightService({ state: 'stopped', tag: '' });
  await ensureManagedLlamaServerReadyForChat(untagged, { engineType: 'openai-compatible' });
  assert.equal(untagged.calls[0].modelTag, 'ornith-9b', 'the key aliases the launch when no display tag was stored');
});

test('llama-server chat preflight waits on a starting or stopping server without a restart warning', async () => {
  for (const [state, warned] of [['starting', false], ['stopping', true]]) {
    const service = makeLlamaPreflightService({ state });
    assert.equal(await ensureManagedLlamaServerReadyForChat(service, { engineType: 'openai-compatible' }), true, state);
    assert.equal(service.calls.length, 1, state);
    assert.equal(service.logs.some(({ event }) => event === 'chat.llama_server_preflight_restart'), warned, state);
  }
});

test('llama-server chat preflight ignores chats that are not on the managed model', async () => {
  for (const options of [{ engine: 'ollama' }, { currentModel: 'my-vllm-70b' }]) {
    const service = makeLlamaPreflightService({ state: 'crashed', ...options });
    assert.equal(await ensureManagedLlamaServerReadyForChat(service, { engineType: 'openai-compatible' }), false);
    assert.deepEqual(service.calls, []);
    assert.deepEqual(service.logs, []);
  }
});

test('llama-server chat preflight throws the provider error when restart stays unavailable', async () => {
  const service = makeLlamaPreflightService({ state: 'crashed', ensuredState: 'stopped' });
  await assert.rejects(
    ensureManagedLlamaServerReadyForChat(service, { engineType: 'openai-compatible' }),
    (error) => error.message === 'llama-server is unavailable: still down'
      && error.error_type === 'EngineConnectionError'
  );
});

test('llama-server chat preflight leaves Ollama requests untouched', async () => {
  let touched = false;
  const service = { options: { getLlamaServerManager: () => { touched = true; } } };
  assert.equal(await ensureManagedLlamaServerReadyForChat(service, { engineType: 'ollama' }), false);
  assert.equal(touched, false);
});
