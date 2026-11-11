const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { t } = require('../../i18n-main');
const { createUnavailableSetupState } = require('../../setup-service');
const { SETUP_ERROR_CODES } = require('../../backend/error-codes');
const { defaultOllamaFallbackUrl } = require('../../ollama-install-service');

// Setup domain IPC: first-run setup state, endpoint validation, Ollama detect /
// pull / install, and the MCP discovery, auth and rea-install channels. Every
// handler answers a structured unavailable shape when its service is absent.

function setupUnavailableValidation() {
    return { ok: false, code: 'setup_unavailable', message: t('main.setup.unavailable', 'Setup service is unavailable.') };
}

function setupUnavailablePull() {
  return { requestId: '', model: '', status: 'failed', summary: t('main.setup.unavailable', 'Setup service is unavailable.') };
}

function setupUnavailableCancel(payload = {}) {
  const requestId = String(payload?.requestId || payload?.request_id || '').trim().slice(0, 120);
  return {
    cancelled: false,
    termination_confirmed: false,
    request_id: requestId,
    status: 'unavailable',
    code: 'setup_unavailable',
    error_code: SETUP_ERROR_CODES.TERMINATION_FAILED,
  };
}

function getSetupStatePayload(setupService) {
  if (!setupService) {
    return createUnavailableSetupState();
  }
  if (typeof setupService.refreshReadiness === 'function') {
    return setupService.refreshReadiness();
  }
  return setupService.getState();
}

function registerSetupIpcHandlers(ipcMainLike, { setupService, ollamaInstallService, ipcAuthorization }) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'setup.getState': () => getSetupStatePayload(setupService),
    'setup.updateState': (_, patch) =>
      setupService ? setupService.updateState(patch) : createUnavailableSetupState(),
    'setup.complete': () =>
      setupService ? setupService.complete() : createUnavailableSetupState(),
    'setup.reset': () =>
      setupService ? setupService.reset() : createUnavailableSetupState(),
    'setup.factoryReset': () =>
      setupService ? setupService.factoryReset() : createUnavailableSetupState(),
    'setup.validateEndpoint': (_, payload) =>
      setupService
        ? setupService.validateEndpoint(payload)
        : setupUnavailableValidation(),
    'setup.saveEndpoint': (_, payload) =>
      setupService && typeof setupService.saveEndpoint === 'function'
        ? setupService.saveEndpoint(payload)
        : {
            ...createUnavailableSetupState(),
            endpoint_result: {
              ok: false,
              code: 'setup_unavailable',
              error_code: SETUP_ERROR_CODES.ENDPOINT_INVALID,
              message: 'Setup is unavailable.',
              retryable: true,
            },
          },
    'setup.startOllamaPull': (_, payload) =>
      setupService
        ? setupService.startOllamaPullPublic(payload)
        : setupUnavailablePull(),
    'setup.cancelOllamaPull': (_, payload) =>
      setupService
        ? setupService.cancelOllamaPull(payload)
        : setupUnavailableCancel(payload),
    'setup.detectOllama': (_, payload) =>
      setupService
        ? setupService.detectOllama(payload)
        : { installed: false, running: false, version: '', installPath: '', source: 'none' },
    'setup.getOllamaInstallPlan': () =>
      ollamaInstallService
        ? ollamaInstallService.getInstallPlan()
        : { available: false, url: '', version: '', sizeBytes: 0, sha256: '', license: '', format: '', installDir: '', manualFallbackUrl: defaultOllamaFallbackUrl(process.platform) },
    'setup.installOllama': (_, payload) =>
      ollamaInstallService
        ? ollamaInstallService.installOllama(payload)
        : { status: 'failed', code: 'unavailable', manualFallbackUrl: defaultOllamaFallbackUrl(process.platform) },
    'setup.cancelOllamaInstall': (_, payload) =>
      ollamaInstallService
        ? ollamaInstallService.cancelOllamaInstall(payload)
        : setupUnavailableCancel(payload),
  }, ipcAuthorization);
}

function registerMcpIpcHandlers(ipcMainLike, { mcpDiscoveryService, reaInstallService, ipcAuthorization }) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'mcpDiscovery.getState': () =>
      mcpDiscoveryService ? mcpDiscoveryService.getState() : { servers: [], readOnly: true },
    'mcpDiscovery.refresh': () =>
      mcpDiscoveryService ? mcpDiscoveryService.refresh() : { servers: [], readOnly: true },
    'mcpDiscovery.createServer': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.createServer(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.updateServer': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.updateServer(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.removeServer': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.removeServer(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.testServer': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.testServer(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.checkReadiness': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.checkReadiness(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.getPrompt': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.getPrompt(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.getReaInstallPlan': () =>
      reaInstallService ? reaInstallService.getInstallPlan() : { supported: false },
    'mcpDiscovery.installRea': (_, payload) =>
      reaInstallService ? reaInstallService.installRea(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.uninstallRea': (_, payload) =>
      reaInstallService ? reaInstallService.uninstallRea(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.approveServer': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.approveServer(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.setServerEnabled': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.setServerEnabled(payload) : { ok: false, error: { code: 'unavailable' } },
    // mcpAuth.* — SECURITY: these handlers must never surface a decrypted
    // secret to the renderer (see services/mcp-discovery-service.js).
    'mcpAuth.getStatus': () =>
      mcpDiscoveryService
        ? mcpDiscoveryService.getMcpAuthStatus()
        : { loaded: false, store: { status: 'unavailable', recoveryTitle: '', recoveryHint: '' }, servers: [] },
    'mcpAuth.set': (_, payload) =>
      mcpDiscoveryService
        ? mcpDiscoveryService.setMcpAuthToken(payload)
        : { ok: false, error: { code: 'unavailable', message: 'MCP auth is unavailable.' } },
    'mcpAuth.delete': (_, payload) =>
      mcpDiscoveryService
        ? mcpDiscoveryService.deleteMcpAuthToken(payload)
        : { ok: false, error: { code: 'unavailable', message: 'MCP auth is unavailable.' } },
  }, ipcAuthorization);
}

module.exports = {
  registerMcpIpcHandlers,
  registerSetupIpcHandlers,
};
