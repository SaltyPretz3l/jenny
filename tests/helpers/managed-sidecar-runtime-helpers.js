const path = require('path');

const { BackendService } = require('../../services/backend/backend-service');
const { createFakeSafeStorage } = require('./fake-safe-storage');
const { trackCloseable } = require('./resource-cleanup');

function waitForChatStreamEvent(service, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.off('chat-stream', handler);
      reject(new Error(`waitForChatStreamEvent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    const handler = (event) => {
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timer);
      service.off('chat-stream', handler);
      resolve(event);
    };
    service.on('chat-stream', handler);
  });
}

function createManagedService(userDataPath, options = {}) {
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    launchCommand: process.execPath,
    launchArgs: [path.join(__dirname, '..', 'fixtures', 'fake-sidecar.js')],
    safeStorage: createFakeSafeStorage(),
    isSafeStorageReady: () => true,
    defaultModel: String(options.defaultModel || 'mock-v1'),
    configService: options.configService || null,
    runCodexDiagnostic: options.runCodexDiagnostic,
    checkCodexDiagnosticSetup: options.checkCodexDiagnosticSetup,
    openCodexLoginTerminal: options.openCodexLoginTerminal,
    featureFlags: options.featureFlags && typeof options.featureFlags === 'object'
      ? { ...options.featureFlags }
      : undefined,
  });
  // Managed fake-sidecar tests must not launch a real local Ollama runtime.
  // The production backend auto-start path is covered elsewhere; these suites
  // exercise JSON-RPC orchestration only.
  service.ollamaManager.ensureRunning = async () => ({
    ready: true,
    started: false,
    external: false,
    skipped: true,
  });
  service.ollamaManager.start = async () => ({ started: false, external: false, skipped: true });
  service.ollamaManager.stop = async () => {};
  return trackCloseable(service);
}

function createManagedServiceWithConfig(userDataPath, configService, options = {}) {
  const service = createManagedService(userDataPath, options);
  service.configService = configService;
  return service;
}

module.exports = {
  waitForChatStreamEvent,
  createManagedService,
  createManagedServiceWithConfig,
};
