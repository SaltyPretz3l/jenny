'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assertChatTurnAdmissible } = require('../services/backend/chat-turn-admission');
const { captureRuntimeRoute } = require('../services/session-runtime/lanes');

function service({ gpuState = 'chat_resident', session = null } = {}) {
  return {
    currentEngineType: 'ollama',
    exclusiveGpuCoordinator: { getState: () => ({ state: gpuState, leaseId: null }) },
    sessionStore: { getSession: () => session },
  };
}

function route(engineType, resourceClass, requiresGpu) {
  return captureRuntimeRoute({
    engine_type: engineType,
    provider_id: engineType,
    configuration_revision: 'config-1',
    resource_class: resourceClass,
    requires_gpu: requiresGpu,
  });
}

test('chat admission rejects transitioning and privileged GPU ownership', () => {
  for (const gpuState of ['transitioning', 'privileged_resident']) {
    assert.throws(() => assertChatTurnAdmissible(service({ gpuState }), 'chat-session'),
      (error) => error.code === 'gpu_busy_plugin');
  }
});

test('chat admission rejects plugin sessions and admits chat or absent sessions', () => {
  assert.throws(() => assertChatTurnAdmissible(service({
    session: { id: 'plugin-session', session_type: 'plugin' },
  }), 'plugin-session'), (error) => error.code === 'session_type_mismatch');
  assert.doesNotThrow(() => assertChatTurnAdmissible(service({
    session: { id: 'chat-session', session_type: 'chat' },
  }), 'chat-session'));
  assert.doesNotThrow(() => assertChatTurnAdmissible(service(), 'missing-session'));
});

test('routed GPU admission distinguishes local GPU, local non-GPU, and cloud work', () => {
  const busy = service({ gpuState: 'privileged_resident' });
  busy.codexCliRuntimeService = {
    getState: () => ({ status: 'ready', authType: 'chatgpt' }),
  };
  busy.codexCliAuthService = { getCredentialEpoch: () => 1 };
  assert.throws(
    () => assertChatTurnAdmissible(busy, 'chat-session', route('ollama', 'local', true)),
    error => error.code === 'gpu_busy_plugin' && error.retryable === true
  );
  assert.doesNotThrow(
    () => assertChatTurnAdmissible(busy, 'chat-session', route('replay', 'local', false))
  );
  assert.doesNotThrow(
    () => assertChatTurnAdmissible(busy, 'chat-session', route('codex-cli', 'cloud', false))
  );
});

test('routed credentials use the captured engine when mutable selection changes', () => {
  const chatgptRoute = route('chatgpt', 'cloud', false);
  const capturedChatgpt = service({ gpuState: 'privileged_resident' });
  capturedChatgpt.currentEngineType = 'ollama';
  capturedChatgpt.chatgptAuthService = {
    hasCredential: () => false,
    getCredentialEpoch: () => 2,
  };
  capturedChatgpt._chatgptRuntimeCredentialEpoch = 2;
  assert.throws(
    () => assertChatTurnAdmissible(capturedChatgpt, 'chat-session', chatgptRoute),
    error => error.code === 'chatgpt_signed_out'
  );

  const capturedLocal = service();
  capturedLocal.currentEngineType = 'chatgpt';
  capturedLocal.chatgptAuthService = { hasCredential: () => false };
  assert.doesNotThrow(
    () => assertChatTurnAdmissible(capturedLocal, 'chat-session', route('mock', 'local', false))
  );
});

test('routed admission still enforces session type and rejects untrusted metadata', () => {
  const pluginSession = service({
    gpuState: 'privileged_resident',
    session: { id: 'plugin-session', session_type: 'plugin' },
  });
  assert.throws(
    () => assertChatTurnAdmissible(
      pluginSession,
      'plugin-session',
      route('chatgpt', 'cloud', false)
    ),
    error => error.code === 'session_type_mismatch'
  );
  assert.throws(
    () => assertChatTurnAdmissible(service(), 'chat-session', {
      engine_type: 'chatgpt', provider_id: 'chatgpt', configuration_revision: 'spoofed',
      resource_class: 'cloud', requires_gpu: false,
    }),
    /runtime_provider_route_untrusted/u
  );
});

test('routed Codex CLI admission requires a current ChatGPT credential', () => {
  const codexRoute = route('codex-cli', 'cloud', false);
  const missing = service({ gpuState: 'privileged_resident' });
  missing.codexCliRuntimeService = {
    getState: () => ({ status: 'unavailable', authType: '' }),
  };
  assert.throws(
    () => assertChatTurnAdmissible(missing, 'chat-session', codexRoute),
    error => error.code === 'codex_cli_auth_required'
  );
  missing.codexCliRuntimeService.getState = () => ({ status: 'ready', authType: 'chatgpt' });
  missing.codexCliAuthService = { getCredentialEpoch: () => 1 };
  assert.doesNotThrow(() => assertChatTurnAdmissible(missing, 'chat-session', codexRoute));
});

test('queued admission reads canonical summaries without hydrating transcripts', () => {
  const captured = service();
  const summaries = new Map([
    ['chat-session', { id: 'chat-session', session_type: 'chat' }],
    ['plugin-session', { id: 'plugin-session', session_type: 'plugin' }],
  ]);
  const reads = [];
  captured.sessionStore = {
    getSessionSummary(id) { reads.push(id); return summaries.get(id) || null; },
    getSession() { assert.fail('pre-admission transcript hydration'); },
  };
  const local = route('mock', 'local', false);
  assert.doesNotThrow(() => assertChatTurnAdmissible(captured, 'chat-session', local));
  assert.throws(() => assertChatTurnAdmissible(captured, 'plugin-session', local),
    error => error.code === 'session_type_mismatch');
  assert.doesNotThrow(() => assertChatTurnAdmissible(captured, 'missing-session', local));
  assert.deepEqual(reads, ['chat-session', 'plugin-session', 'missing-session']);
});
