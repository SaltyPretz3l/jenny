'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CLI_ERROR_CODES,
  assertLocalOnlyEngine,
  assertLocalOnlyModel,
  createInertCodexHooks,
  createRefusingSafeStorage,
} = require('../../services/cli-host/local-only-providers');
const {
  CLI_CURATED_TOOLS,
  DESKTOP_ONLY_TOOLS,
  assertCuratedRegistry,
  createCuratedToolExecutor,
} = require('../../services/cli-host/curated-tool-executor');
const { createCodexCliAuthService } = require('../../services/backend/codex-cli-auth-service');
const { ToolRegistry } = require('../../services/tools/tool-registry');

function fakeConfigService() {
  return { getState: () => ({}), getToolsWorkspaceRoot: () => null };
}

test('error codes are frozen, distinct and in the CLI domain', () => {
  assert.ok(Object.isFrozen(CLI_ERROR_CODES));
  const codes = Object.values(CLI_ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.match(code, /^CMP-CLI-\d{4}$/);
});

test('assertLocalOnlyEngine accepts local engines and returns the normalized type', () => {
  assert.equal(assertLocalOnlyEngine(' Replay '), 'replay');
  assert.equal(assertLocalOnlyEngine('ollama'), 'ollama');
  assert.equal(assertLocalOnlyEngine('vllm'), 'vllm');
  assert.equal(assertLocalOnlyEngine('openai-compatible', { apiUrl: 'http://127.0.0.1:8080/v1' }), 'openai-compatible');
  assert.equal(assertLocalOnlyEngine('openai-compatible', { apiUrl: 'http://localhost:1234' }), 'openai-compatible');
});

test('assertLocalOnlyEngine refuses cloud, remote and unknown engines with a typed error', () => {
  const cases = [
    ['codex-cli'], ['chatgpt'], ['CHATGPT'], [''], [null], ['anthropic'],
    ['openai-compatible', { apiUrl: 'https://api.example.com/v1' }],
  ];
  for (const [engine, options] of cases) {
    assert.throws(() => assertLocalOnlyEngine(engine, options), (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.code, CLI_ERROR_CODES.ENGINE_NOT_LOCAL);
      assert.equal(error.reason, 'engine_not_local');
      return true;
    }, `engine ${engine} must be refused`);
  }
});

test('assertLocalOnlyModel refuses Ollama cloud-routed models and accepts everything else', () => {
  for (const model of ['gpt-oss:120b-cloud', 'qwen3-coder:480b-CLOUD', 'deepseek-v3.1:cloud']) {
    assert.throws(() => assertLocalOnlyModel('ollama', model), (error) => {
      assert.equal(error.code, CLI_ERROR_CODES.ENGINE_NOT_LOCAL);
      assert.equal(error.reason, 'model_not_local');
      return true;
    }, model);
  }
  assert.equal(assertLocalOnlyModel('ollama', 'qwen3:8b'), 'qwen3:8b');
  assert.equal(assertLocalOnlyModel('ollama', 'cloudy-sky:7b'), 'cloudy-sky:7b');
  assert.equal(assertLocalOnlyModel('ollama', ''), '');
  assert.equal(assertLocalOnlyModel('vllm', 'local-cloud'), 'local-cloud', 'the tag means cloud routing on Ollama only');
});

test('the refusing safeStorage reports no encryption and throws on every use', () => {
  const storage = createRefusingSafeStorage();
  assert.equal(storage.isEncryptionAvailable(), false);
  for (const call of [() => storage.encryptString('value'), () => storage.decryptString(Buffer.from('x'))]) {
    assert.throws(call, (error) => {
      assert.equal(error.code, CLI_ERROR_CODES.NO_SECURE_STORAGE);
      assert.equal(error.reason, 'cli_no_secure_storage');
      return true;
    });
  }
});

test('inert Codex hooks report cli_unsupported through the real auth service', async () => {
  const hooks = createInertCodexHooks();
  const setup = await hooks.checkCodexDiagnosticSetup({ codexCommand: 'codex' });
  assert.equal(setup.ok, false);
  assert.equal(setup.code, 'cli_unsupported');
  assert.equal(setup.reason, 'cli_unsupported');
  assert.equal(setup.commandPath, '');
  const login = await hooks.openCodexLoginTerminal();
  assert.equal(login.ok, false);
  assert.equal(login.reason, 'cli_unsupported');
  const auth = createCodexCliAuthService({
    checkSetup: hooks.checkCodexDiagnosticSetup, openLoginTerminal: hooks.openCodexLoginTerminal,
  });
  const state = await auth.getState();
  assert.equal(state.ok, false);
  assert.equal(state.configured, false);
  assert.equal(state.code, 'cli_unsupported');
  const opened = await auth.openLoginTerminal();
  assert.equal(opened.ok, false);
  assert.equal(opened.code, 'cli_unsupported');
});

test('the curated executor registers exactly ask_user and exit_plan_mode', () => {
  assert.ok(Object.isFrozen(CLI_CURATED_TOOLS));
  assert.deepEqual([...CLI_CURATED_TOOLS], ['ask_user', 'exit_plan_mode']);
  const executor = createCuratedToolExecutor({ configService: fakeConfigService(), permissionStore: null });
  assert.deepEqual(executor.registry.getAllTools().map((tool) => tool.name).sort(), [...CLI_CURATED_TOOLS]);
  for (const name of DESKTOP_ONLY_TOOLS) assert.equal(executor.registry.getTool(name), undefined, name);
});

test('registry drift is refused with a typed error', () => {
  const executor = createCuratedToolExecutor({ configService: fakeConfigService() });
  const extra = { name: 'run_command', description: 'x', parameters: { type: 'object' },
    execute: async () => ({}), summarize: () => '' };
  executor.registry.registerTool(extra);
  assert.throws(() => assertCuratedRegistry(executor.registry), (error) => {
    assert.equal(error.code, CLI_ERROR_CODES.TOOL_REGISTRY_DRIFT);
    assert.equal(error.reason, 'cli_tool_registry_drift');
    return true;
  });
  const missing = new ToolRegistry();
  assert.throws(() => assertCuratedRegistry(missing), { reason: 'cli_tool_registry_drift' });
  const aliased = new ToolRegistry();
  aliased.registerTool({ name: 'ask_user', aliases: ['delete_file'], description: 'x',
    parameters: { type: 'object' }, execute: async () => ({}), summarize: () => '' });
  aliased.registerTool({ name: 'exit_plan_mode', description: 'x',
    parameters: { type: 'object' }, execute: async () => ({}), summarize: () => '' });
  assert.throws(() => assertCuratedRegistry(aliased), { reason: 'cli_tool_registry_drift' });
});
