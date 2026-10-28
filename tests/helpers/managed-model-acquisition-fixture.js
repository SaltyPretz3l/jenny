'use strict';

// The fake managed-sidecar service of tests/managed-sidecar/managed-model-acquisition.test.js and its
// initialize payload, shared so the acquisition tests stay under the 600-line ratchet.

const { EventEmitter } = require('events');

function createService(initialize) {
  const service = new EventEmitter();
  const sidecarProcess = {};
  Object.assign(service, {
    appVersion: '0.1.0',
    currentEngineType: 'ollama',
    currentModel: '',
    defaultModel: 'ornith:9b',
    featureFlags: {},
    options: { userDataPath: process.cwd() },
    _disposed: false,
    _stopping: false,
    _managedInitializeFlight: null,
    _managedInitializeGeneration: 0,
    _managedPendingModel: '',
    _lastEngineFallback: null,
    _modelLifecycle: { state: 'unloaded' },
    _emitServiceLog() {},
    sidecarManager: {
      process: sidecarProcess,
      getStatus() { return { phase: 'ready', pid: 42 }; },
    },
    sidecarClient: {
      process: sidecarProcess,
      connected: true,
      attachProcess(next) { this.process = next; this.connected = true; },
      initialize,
    },
  });
  return service;
}

function successPayload(model = 'ornith:9b') {
  return {
    active_engine: 'ollama',
    active_model: model,
    active_model_capabilities: { text: true },
    local_runtime: {
      engine: { type: 'ollama' },
      model: { id: model, loaded: true },
    },
  };
}

module.exports = { createService, successPayload };
