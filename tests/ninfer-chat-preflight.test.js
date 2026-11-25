'use strict';

// Chat preflight for the managed NInfer runtime (row 54 Step 6): only the
// last-used artifact's own chats relaunch it, a crash recovers on the next
// message, and an unrecoverable server fails the turn before the sidecar.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureManagedNinferReadyForChat } = require('../services/backend/managed-sidecar-chat-reconnect');

const ARTIFACT = { id: 'qwen3.8-27b-nvfp4', model_id: 'qwen3.8-27b-nvfp4' };

function makeService({ state = 'ready', ensuredState = 'ready', currentModel = 'qwen3.8-27b-nvfp4', lastUsedArtifactId = 'qwen3.8-27b-nvfp4', manager = true } = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    currentModel,
    options: { getNinferManager: () => (manager ? {
      getStatus: () => ({ state, stoppedBy: state === 'crashed' ? 'watchdog' : '' }),
      async settled() { calls.push('settled'); return { state }; },
      async ensureRunning(spec) { calls.push(spec); return { state: ensuredState, lastError: 'ninfer_host_memory' }; },
    } : null) },
    ninferRuntime: { artifacts: { artifacts: [ARTIFACT] } },
    configService: { getLocalEngines: () => ({ ninfer: { lastUsedArtifactId } }) },
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
  };
}

test('a ready NInfer answers after its chain settles; a crash relaunches on the next message', async () => {
  const ready = makeService();
  assert.equal(await ensureManagedNinferReadyForChat(ready, { engineType: 'openai-compatible' }), true);
  assert.deepEqual(ready.calls, ['settled']);
  const crashed = makeService({ state: 'crashed' });
  assert.equal(await ensureManagedNinferReadyForChat(crashed, { engineType: 'openai-compatible' }), true);
  assert.deepEqual(crashed.calls, [{ artifactId: 'qwen3.8-27b-nvfp4' }]);
  const restart = crashed.logs.find(({ event }) => event === 'chat.ninfer_preflight_restart');
  assert.equal(restart.details.stoppedBy, 'watchdog');
});

test('other engines, other models, no boot target and no manager are left alone', async () => {
  assert.equal(await ensureManagedNinferReadyForChat(makeService(), { engineType: 'ollama' }), false);
  assert.equal(await ensureManagedNinferReadyForChat(makeService({ currentModel: 'ornith:9b' }), { engineType: 'openai-compatible' }), false);
  assert.equal(await ensureManagedNinferReadyForChat(makeService({ lastUsedArtifactId: '' }), { engineType: 'openai-compatible' }), false);
  assert.equal(await ensureManagedNinferReadyForChat(makeService({ manager: false }), { engineType: 'openai-compatible' }), false);
  // An empty current model (boot, after Unload) still belongs to the boot target.
  const booting = makeService({ state: 'stopped', currentModel: '' });
  assert.equal(await ensureManagedNinferReadyForChat(booting, { engineType: 'openai-compatible' }), true);
});

test('an unrecoverable NInfer fails the turn with a retryable engine-connection error naming it', async () => {
  const service = makeService({ state: 'stopped', ensuredState: 'stopped' });
  await assert.rejects(
    ensureManagedNinferReadyForChat(service, { engineType: 'openai-compatible' }),
    (error) => error.retryable === true && /NInfer is unavailable: ninfer_host_memory/.test(error.message)
  );
  assert.ok(service.logs.some(({ event }) => event === 'chat.ninfer_preflight_unavailable'));
});

// Row 200 S2 step 6: the Strata sibling, gated on Strata being the last-used managed server.
function makeStrataService({ state = 'crashed', ensuredState = 'ready', currentModel = 'inkling-2-mini-sq-20', lastUsed = true } = {}) {
  const calls = [];
  const logs = [];
  return {
    calls, logs, currentModel,
    options: { getStrataManager: () => ({
      getStatus: () => ({ state, stoppedBy: '' }),
      async settled() { calls.push('settled'); return { state }; },
      async ensureRunning(spec) { calls.push(['ensureRunning', spec]); return { state: ensuredState, lastError: 'strata_blocked_by_windows' }; },
    }) },
    strataRuntime: { enabled: true, getState: () => ({ model: { id: 'inkling-2-mini-sq-20', aliases: ['inkling-2-mini'] } }) },
    configService: { getLocalEngines: () => ({ strata: { lastUsed } }) },
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
  };
}

test('Strata: a crash relaunches with the saved settings on the next message; others are left alone', async () => {
  const { ensureManagedStrataReadyForChat } = require('../services/backend/managed-sidecar-chat-reconnect');
  const crashed = makeStrataService();
  assert.equal(await ensureManagedStrataReadyForChat(crashed, { engineType: 'openai-compatible' }), true);
  assert.deepEqual(crashed.calls, [['ensureRunning', null]]);
  assert.ok(crashed.logs.some(({ event }) => event === 'chat.strata_preflight_restart'));
  assert.equal(await ensureManagedStrataReadyForChat(makeStrataService({ currentModel: 'inkling-2-mini' }), { engineType: 'openai-compatible' }), true, 'the alias counts');
  for (const service of [makeStrataService({ lastUsed: false }), makeStrataService({ currentModel: 'ornith:9b' })]) {
    assert.equal(await ensureManagedStrataReadyForChat(service, { engineType: 'openai-compatible' }), false);
    assert.deepEqual(service.calls, []);
  }
  assert.equal(await ensureManagedStrataReadyForChat(makeStrataService(), { engineType: 'ollama' }), false);
  const failed = makeStrataService({ state: 'stopped', ensuredState: 'stopped' });
  await assert.rejects(ensureManagedStrataReadyForChat(failed, { engineType: 'openai-compatible' }),
    (error) => error.retryable === true && /Strata is unavailable: strata_blocked_by_windows/.test(error.message));
});
