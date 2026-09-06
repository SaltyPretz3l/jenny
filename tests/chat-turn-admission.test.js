'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assertChatTurnAdmissible } = require('../services/backend/chat-turn-admission');

function service({ gpuState = 'chat_resident', session = null } = {}) {
  return {
    currentEngineType: 'ollama',
    exclusiveGpuCoordinator: { getState: () => ({ state: gpuState, leaseId: null }) },
    sessionStore: { getSession: () => session },
  };
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
