const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const { createManagedService } = require('../helpers/managed-sidecar-runtime-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('loadModel throws when sidecar returns engine_fallback', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-fallback-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service._initializeManagedSidecar = async () => {
    // Mirror applyManagedInitializePayload: on engine fallback the live code
    // overwrites currentModel to the mock model before loadModel reads it for
    // the error message. The stub must reproduce that or it hides the bug.
    service.currentModel = 'mock-v1';
    service._lastEngineFallback = {
      requested_engine: 'ollama',
      reason: 'Ollama engine failed to initialize: ConnectionError: could not connect',
    };
  };
  service.refreshStatusSnapshot = async () => {};

  await assert.rejects(
    () => service.loadModel('qwen3.5:9b'),
    /Could not load ollama engine for model "qwen3.5:9b"/
  );
});

test('loadModel succeeds when sidecar returns no engine_fallback', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-no-fallback-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service._initializeManagedSidecar = async () => {
    // Mirror applyManagedInitializePayload: loadModel no longer assigns
    // service.currentModel itself (see backend-runtime.js loadModel) — it
    // passes requestedModel/requestedEngineType through to
    // _initializeManagedSidecar and relies on the real
    // initializeManagedSidecarWithTimeout + applyManagedInitializePayload
    // pipeline (local-engine-status.js / managed-sidecar-lifecycle.js) to set
    // currentModel from the sidecar's actual payload. The stub must
    // reproduce that assignment or result.model comes back empty.
    service.currentModel = 'mock-v1';
    service._lastEngineFallback = null;
  };
  service.refreshStatusSnapshot = async () => {};

  const result = await service.loadModel('mock-v1');
  assert.equal(result.status, 'ok');
  assert.equal(result.model, 'mock-v1');
});

// ChatGPT-subscription catalog slugs (bare gpt-5*) route to the chatgpt
// engine; other GPT-ish names (e.g. ollama's gpt-oss) must stay local.
test('loadModel keeps non-catalog GPT-like model names on the local default engine', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-local-routing-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service.providerIntegrationRegistry.resolveModelAvailability = () => ({
    available: true,
    reason: '',
  });
  service._initializeManagedSidecar = async (options = {}) => {
    // Mirror initializeManagedSidecarWithTimeout (local-engine-status.js):
    // loadModel no longer sets service.currentEngineType before calling
    // _initializeManagedSidecar — it now passes requestedEngineType through
    // the options object, and the real implementation assigns
    // service.currentEngineType from options.requestedEngineType before the
    // fallback is recorded. The stub must reproduce that assignment, or
    // requested_engine below falls back to the engine's stale default
    // ('mock') instead of the actually-requested 'ollama'.
    service.currentEngineType = options.requestedEngineType || service.currentEngineType;
    // Mirror applyManagedInitializePayload's currentModel overwrite (see above).
    service.currentModel = 'mock-v1';
    service._lastEngineFallback = {
      requested_engine: service.currentEngineType,
      reason: 'Ollama engine failed to initialize',
    };
  };
  service.refreshStatusSnapshot = async () => {};

  await assert.rejects(
    () => service.loadModel('gpt-oss:20b'),
    /Could not load ollama engine for model "gpt-oss:20b"/
  );
});
