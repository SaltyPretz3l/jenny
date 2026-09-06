'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCodexCliRuntimeService,
  normalizeCodexCliModelId,
} = require('../services/backend/codex-cli-runtime-service');

test('codex CLI runtime service exposes disabled model entries without auth probing', async () => {
  let authProbeCount = 0;
  const service = createCodexCliRuntimeService({
    userDataPath: 'C:/Users/Jenny/AppData/Roaming/jenny',
    configService: {
      getState() {
        return {
          codexCli: {
            enabled: false,
            commandPath: 'C:/Tools/codex.exe',
            models: ['gpt-5.5'],
            requestTimeoutSeconds: 900,
          },
        };
      },
    },
    authService: {
      async getState() {
        authProbeCount += 1;
        return { configured: true, status: 'ready', authType: 'chatgpt' };
      },
    },
  });

  const state = await service.getState();
  const catalog = service.getModelCatalog();

  assert.equal(authProbeCount, 0);
  assert.equal(state.enabled, false);
  assert.equal(state.status, 'unavailable');
  assert.equal(state.code, 'disabled');
  assert.deepEqual(catalog.map((entry) => entry.id), [
    'codex-cli/default',
    'codex-cli/gpt-5.5',
  ]);
  assert.equal(catalog[0].available, false);
  assert.match(catalog[0].reason, /disabled/i);
  assert.deepEqual(service.isModelAvailable('codex-cli/default'), {
    available: false,
    reason: 'Codex CLI integration is disabled.',
  });
});

test('codex CLI runtime service refreshes ChatGPT auth and forwards managed config', async () => {
  const userDataPath = 'C:/Users/Jenny/AppData/Roaming/jenny';
  const service = createCodexCliRuntimeService({
    userDataPath,
    configService: {
      getState() {
        return {
          codexCli: {
            enabled: true,
            commandPath: 'C:/Tools/codex.exe',
            models: ['gpt-5.5', 'codex-cli/o4-mini'],
            requestTimeoutSeconds: 900,
          },
        };
      },
    },
    authService: {
      async getState(options) {
        assert.equal(options.codexCommand, 'C:/Tools/codex.exe');
        return {
          configured: true,
          status: 'ready',
          code: 'ready',
          authType: 'chatgpt',
          commandPath: 'C:/Tools/codex.exe',
          message: 'Codex CLI is authenticated with ChatGPT.',
        };
      },
    },
  });

  const state = await service.refresh();
  const patch = service.getManagedConfigPatch();

  assert.equal(state.status, 'ready');
  assert.equal(state.authType, 'chatgpt');
  assert.equal(service.isModelAvailable('codex-cli/gpt-5.5').available, true);
  assert.deepEqual(service.getModelCatalog().map((entry) => entry.id), [
    'codex-cli/default',
    'codex-cli/gpt-5.5',
    'codex-cli/o4-mini',
  ]);
  assert.deepEqual(patch, {
    codex_cli_enabled: true,
    codex_cli_auth_ready: true,
    codex_cli_auth_reason: null,
    codex_cli_command: 'C:/Tools/codex.exe',
    codex_cli_runtime_root: path.join(userDataPath, 'codex-cli-engine'),
    codex_cli_models: ['codex-cli/gpt-5.5', 'codex-cli/o4-mini'],
    codex_cli_request_timeout_seconds: 900,
  });
});

// F15 (c-1): the auth probe resolves `codex` to a concrete absolute path and
// proves that path authenticates. Publishing settings.commandPath instead threw
// that away, so the sidecar re-resolved the bare token from ITS own PATH — a
// different resolution than the one we verified, which on Windows is how a
// WindowsApps stub or a shell-only .cmd shim gets launched instead.
test('managed config publishes the authenticated resolved command path', async () => {
  const userDataPath = 'C:/Users/Jenny/AppData/Roaming/jenny';
  const resolved = 'C:/Users/Jenny/.vscode/extensions/openai.chatgpt-1.2.3/bin/codex.exe';
  const service = createCodexCliRuntimeService({
    userDataPath,
    configService: {
      getState() {
        return {
          codexCli: { enabled: true, commandPath: 'codex', requestTimeoutSeconds: 900 },
        };
      },
    },
    authService: {
      async getState() {
        return {
          configured: true,
          status: 'ready',
          code: 'ready',
          authType: 'chatgpt',
          commandPath: resolved,
          message: 'Codex CLI is authenticated with ChatGPT.',
        };
      },
    },
  });

  assert.equal(service.getManagedConfigPatch().codex_cli_command, 'codex');

  await service.refresh();

  assert.equal(service.getManagedConfigPatch().codex_cli_command, resolved);
  // The wire key and its sidecar consumers are unchanged — only the value.
  assert.deepEqual(Object.keys(service.getManagedConfigPatch()).sort(), [
    'codex_cli_auth_ready',
    'codex_cli_auth_reason',
    'codex_cli_command',
    'codex_cli_enabled',
    'codex_cli_models',
    'codex_cli_request_timeout_seconds',
    'codex_cli_runtime_root',
  ]);
});

test('managed config falls back to configured command when auth is not ready', async () => {
  const service = createCodexCliRuntimeService({
    userDataPath: 'C:/Users/Jenny/AppData/Roaming/jenny',
    configService: {
      getState() {
        return {
          codexCli: { enabled: true, commandPath: 'C:/Tools/codex.exe', requestTimeoutSeconds: 900 },
        };
      },
    },
    authService: {
      async getState() {
        return {
          configured: false,
          status: 'unavailable',
          code: 'auth_required_or_cli_missing',
          authType: '',
          // A stale/unverified path must not be promoted onto the wire.
          commandPath: 'C:/Windows/System32/WindowsApps/codex.exe',
        };
      },
    },
  });

  await service.refresh();

  const patch = service.getManagedConfigPatch();
  assert.equal(patch.codex_cli_auth_ready, false);
  assert.equal(patch.codex_cli_command, 'C:/Tools/codex.exe');
});

test('codex CLI runtime service keeps models unavailable until auth is checked', () => {
  const userDataPath = 'C:/Users/Jenny/AppData/Roaming/jenny';
  const service = createCodexCliRuntimeService({
    userDataPath,
    configService: {
      getState() {
        return {
          codexCli: {
            enabled: true,
            commandPath: 'C:/Tools/codex.exe',
            models: ['gpt-5.5'],
          },
        };
      },
    },
    authService: {
      async getState() {
        throw new Error('auth should not be probed by catalog reads');
      },
    },
  });

  const catalog = service.getModelCatalog();
  const patch = service.getManagedConfigPatch();

  assert.equal(catalog[0].available, false);
  assert.match(catalog[0].reason, /not been checked/i);
  assert.equal(service.isModelAvailable('codex-cli/default').available, false);
  assert.equal(patch.codex_cli_enabled, true);
  assert.equal(patch.codex_cli_auth_ready, false);
  assert.match(patch.codex_cli_auth_reason, /not been checked/i);
});

test('codex CLI runtime service fails closed for non-ChatGPT auth readiness', async () => {
  const service = createCodexCliRuntimeService({
    userDataPath: 'C:/Users/Jenny/AppData/Roaming/jenny',
    configService: {
      getState() {
        return {
          codexCli: {
            enabled: true,
            models: ['gpt-5.5'],
          },
        };
      },
    },
    authService: {
      async getState() {
        return {
          configured: true,
          status: 'ready',
          code: 'ready',
          authType: 'api_key',
        };
      },
    },
  });

  const state = await service.refresh();
  const catalog = service.getModelCatalog();

  assert.equal(state.status, 'unavailable');
  assert.equal(state.code, 'chatgpt_auth_required');
  assert.equal(state.authType, 'api_key');
  assert.equal(catalog[0].available, false);
  assert.match(catalog[0].reason, /ChatGPT/i);
});

test('codex CLI runtime service redacts auth refresh failures', async () => {
  const warnings = [];
  const service = createCodexCliRuntimeService({
    userDataPath: 'C:/Users/Jenny/AppData/Roaming/jenny',
    configService: {
      getState() {
        return { codexCli: { enabled: true } };
      },
    },
    authService: {
      async getState() {
      throw new Error('failed at C:\\Users\\example\\secret\\codex.json with token sk-proj-secretsecretsecretsecret');
      },
    },
    logger(level, event, fields) {
      warnings.push({ level, event, fields });
    },
  });

  const state = await service.refresh();
  const serialized = JSON.stringify({ state, warnings });

  assert.equal(state.status, 'unavailable');
  assert.equal(state.code, 'auth_refresh_failed');
  assert.doesNotMatch(serialized, /C:\\Users\\example/);
  assert.doesNotMatch(serialized, /sk-proj-secretsecret/);
});

test('codex CLI runtime service fails closed without an absolute runtime root', async () => {
  let authProbeCount = 0;
  const service = createCodexCliRuntimeService({
    userDataPath: '',
    configService: {
      getState() {
        return { codexCli: { enabled: true, models: ['gpt-5.5'] } };
      },
    },
    authService: {
      async getState() {
        authProbeCount += 1;
        return { configured: true, status: 'ready', authType: 'chatgpt' };
      },
    },
  });

  const state = await service.refresh();

  assert.equal(authProbeCount, 0);
  assert.equal(state.status, 'unavailable');
  assert.equal(state.code, 'runtime_root_unavailable');
  assert.equal(service.getManagedConfigPatch().codex_cli_runtime_root, null);
  assert.equal(service.getManagedConfigPatch().codex_cli_auth_ready, false);
  assert.deepEqual(service.isModelAvailable('codex-cli/default'), {
    available: false,
    reason: 'Codex CLI runtime root is not configured.',
  });
});

test('normalizeCodexCliModelId keeps default out of custom config', () => {
  assert.equal(normalizeCodexCliModelId(42, { allowDefault: false }), '');
  assert.equal(normalizeCodexCliModelId('default', { allowDefault: false }), '');
  assert.equal(normalizeCodexCliModelId('codex-cli/default', { allowDefault: false }), '');
  assert.equal(normalizeCodexCliModelId('codex-cli', { allowDefault: false }), '');
  assert.equal(normalizeCodexCliModelId('codex-cli/', { allowDefault: false }), '');
  assert.equal(normalizeCodexCliModelId(' gpt-5.5 ', { allowDefault: false }), 'codex-cli/gpt-5.5');
  assert.equal(normalizeCodexCliModelId('codex-cli/o4-mini', { allowDefault: false }), 'codex-cli/o4-mini');
});
