'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compactAuthStatus,
  createCodexCliAuthService,
} = require('../services/backend/codex-cli-auth-service');

test('codex CLI auth service reports ready only for ChatGPT auth', async () => {
  const service = createCodexCliAuthService({
    checkSetup: async () => ({
      ok: true,
      code: 'ready',
      authType: 'chatgpt',
      commandPath: 'C:/codex/codex.exe',
      message: 'Logged in using ChatGPT',
    }),
  });

  const state = await service.getState();

  assert.equal(state.configured, true);
  assert.equal(state.status, 'ready');
  assert.equal(state.provider, 'codex-cli');
  assert.equal(state.authType, 'chatgpt');
  assert.equal(state.commandPath, 'C:/codex/codex.exe');
});

test('codex CLI auth service fails closed for API key auth', async () => {
  const service = createCodexCliAuthService({
    checkSetup: async () => ({ ok: true, code: 'ready', authType: 'api_key' }),
  });

  const state = await service.getState();

  assert.equal(state.configured, false);
  assert.equal(state.status, 'unconfigured');
  assert.equal(state.code, 'chatgpt_auth_required');
  assert.match(state.message, /ChatGPT/);
});

test('codex CLI auth service redacts setup failure messages', async () => {
  const warnings = [];
  const service = createCodexCliAuthService({
    checkSetup: async () => {
      throw new Error('failed at C:\\Users\\example\\secret\\codex.json with Authorization: Bearer sk-proj-secretsecretsecretsecret');
    },
    logger(level, event, fields) {
      warnings.push({ level, event, fields });
    },
  });

  const state = await service.getState();
  const serialized = JSON.stringify({ state, warnings });

  assert.equal(state.configured, false);
  assert.equal(state.code, 'cli_status_failed');
  assert.doesNotMatch(serialized, /C:\\Users\\example/);
  assert.doesNotMatch(serialized, /sk-proj-secretsecret/);
});

test('codex CLI auth service opens login terminal through the shared adapter', async () => {
  const service = createCodexCliAuthService({
    checkSetup: async () => ({ ok: false }),
    openLoginTerminal: async () => ({
      ok: true,
      code: 'login_terminal_opened',
      commandPath: 'C:/codex/codex.exe',
    }),
  });

  const result = await service.openLoginTerminal();

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'codex-cli');
  assert.equal(result.command, 'codex login');
  assert.equal(result.commandPath, 'C:/codex/codex.exe');
});

test('codex CLI auth service redacts login terminal failures', async () => {
  const service = createCodexCliAuthService({
    openLoginTerminal: async () => {
      throw new Error('failed at C:\\Users\\example\\secret\\codex.json with token sk-proj-secretsecretsecretsecret');
    },
  });

  const result = await service.openLoginTerminal();
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'login_terminal_failed');
  assert.doesNotMatch(serialized, /C:\\Users\\example/);
  assert.doesNotMatch(serialized, /sk-proj-secretsecret/);
});

test('compact auth status bounds thrown or malformed setup output', () => {
  const state = compactAuthStatus({
    ok: true,
    authType: 'unknown',
        message: 'ok-ish at C:\\Users\\example\\secret\\codex.json',
  });

  assert.equal(state.configured, false);
  assert.equal(state.code, 'chatgpt_auth_required');
  assert.equal(state.authType, '');
  assert.doesNotMatch(state.message, /C:\\Users\\example/);
});
