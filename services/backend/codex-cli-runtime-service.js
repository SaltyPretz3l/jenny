'use strict';
// Opt-in codex-cli ChatGPT product engine (explicit cloud opt-in, AGENTS.md).
// Composed via backend-service; reached via codexCli.* IPC + provider registry.
// See docs/architecture/BACKEND_SEAM_LANE.md.

const path = require('path');
const {
  DEFAULT_CODEX_CLI,
  normalizeCodexCliModelId: normalizeConfiguredCodexCliModelId,
  normalizeCodexCliSettings,
} = require('../shell-config-state');
const {
  redactDiagnosticString,
} = require('./diagnostic-redaction');

const CODEX_CLI_PROVIDER = 'codex-cli';
const CODEX_CLI_DEFAULT_MODEL = 'codex-cli/default';
const CODEX_CLI_DISABLED_REASON = 'Codex CLI integration is disabled.';
const DEFAULT_REQUEST_TIMEOUT_SECONDS = DEFAULT_CODEX_CLI.requestTimeoutSeconds;

function normalizeCodexCliModelId(value, { allowDefault = true } = {}) {
  const token = normalizeConfiguredCodexCliModelId(value, { allowDefault });
  if (!token) {
    return '';
  }
  return token.toLowerCase() === 'default'
    ? CODEX_CLI_DEFAULT_MODEL
    : `${CODEX_CLI_PROVIDER}/${token}`;
}

function normalizeCodexCliModelIds(values = []) {
  const models = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const modelId = normalizeCodexCliModelId(value, { allowDefault: false });
    const key = modelId.toLowerCase();
    if (!modelId || seen.has(key)) {
      continue;
    }
    seen.add(key);
    models.push(modelId);
  }
  return models;
}

function normalizeRuntimeAuthType(value) {
  const token = String(value || '').trim().toLowerCase();
  return token === 'chatgpt' || token === 'api_key' ? token : '';
}

function createUnavailableState(settings, reason, code = 'unavailable') {
  return {
    enabled: settings.enabled === true,
    provider: CODEX_CLI_PROVIDER,
    status: 'unavailable',
    code,
    authType: '',
    commandPath: settings.commandPath || '',
    requestTimeoutSeconds: settings.requestTimeoutSeconds || DEFAULT_REQUEST_TIMEOUT_SECONDS,
    models: [CODEX_CLI_DEFAULT_MODEL, ...normalizeCodexCliModelIds(settings.models)],
    message: reason,
  };
}

function createCodexCliRuntimeService({
  userDataPath,
  configService = null,
  authService = null,
  logger = null,
} = {}) {
  let lastState = null;

  function log(level, event, details) {
    if (typeof logger === 'function') {
      logger(level, event, details || {});
    }
  }

  function getSettings() {
    const rawState = typeof configService?.getState === 'function'
      ? configService.getState()
      : {};
    return normalizeCodexCliSettings(rawState?.codexCli || rawState?.codex_cli);
  }

  function getRuntimeRoot() {
    const root = String(userDataPath || '').trim();
    return path.isAbsolute(root) ? path.join(root, 'codex-cli-engine') : '';
  }

  function getCommand(settings = getSettings()) {
    return String(settings.commandPath || 'codex').trim() || 'codex';
  }

  function getConfiguredModels(settings = getSettings()) {
    return [CODEX_CLI_DEFAULT_MODEL, ...normalizeCodexCliModelIds(settings.models)];
  }

  function getConfiguredModelState(settings = getSettings()) {
    const models = getConfiguredModels(settings);
    return {
      models,
      modelSet: new Set(models.map((model) => model.toLowerCase())),
    };
  }

  function availabilityForSettings(settings = getSettings()) {
    if (settings.enabled !== true) {
      return { available: false, reason: CODEX_CLI_DISABLED_REASON };
    }
    if (!getRuntimeRoot()) {
      return {
        available: false,
        reason: 'Codex CLI runtime root is not configured.',
      };
    }
    if (!lastState) {
      return {
        available: false,
        reason: 'Codex CLI auth status has not been checked yet.',
      };
    }
    if (lastState && lastState.status !== 'ready') {
      return {
        available: false,
        reason: String(lastState.message || 'Codex CLI ChatGPT auth is not ready.'),
      };
    }
    return { available: true, reason: '' };
  }

  function getState() {
    const settings = getSettings();
    if (settings.enabled !== true) {
      lastState = createUnavailableState(settings, CODEX_CLI_DISABLED_REASON, 'disabled');
      return lastState;
    }
    if (!getRuntimeRoot()) {
      lastState = createUnavailableState(
        settings,
        'Codex CLI runtime root is not configured.',
        'runtime_root_unavailable'
      );
      return lastState;
    }
    if (lastState) {
      const { models } = getConfiguredModelState(settings);
      return {
        ...lastState,
        enabled: true,
        commandPath: settings.commandPath || lastState.commandPath || '',
        requestTimeoutSeconds: settings.requestTimeoutSeconds,
        models,
      };
    }
    lastState = createUnavailableState(
      settings,
      'Codex CLI auth status has not been checked yet.',
      'auth_unchecked'
    );
    return lastState;
  }

  async function refresh() {
    const settings = getSettings();
    if (settings.enabled !== true) {
      lastState = createUnavailableState(settings, CODEX_CLI_DISABLED_REASON, 'disabled');
      return lastState;
    }
    if (!getRuntimeRoot()) {
      lastState = createUnavailableState(
        settings,
        'Codex CLI runtime root is not configured.',
        'runtime_root_unavailable'
      );
      return lastState;
    }
    if (!authService || typeof authService.getState !== 'function') {
      lastState = createUnavailableState(
        settings,
        'Codex CLI auth service is unavailable.',
        'auth_service_unavailable'
      );
      return lastState;
    }
    try {
      const { models } = getConfiguredModelState(settings);
      const auth = await Promise.resolve(authService.getState({
        codexCommand: getCommand(settings),
      }));
      const authType = normalizeRuntimeAuthType(auth?.authType || auth?.auth_type);
      const authenticated = auth?.configured === true || auth?.ok === true || auth?.status === 'ready';
      const ready = authenticated && authType === 'chatgpt';
      const fallbackCode = authenticated && authType !== 'chatgpt'
        ? 'chatgpt_auth_required'
        : 'auth_required_or_cli_missing';
      const fallbackMessage = 'Sign in with ChatGPT using codex login.';
      const unavailableCode = authenticated && authType !== 'chatgpt'
        ? 'chatgpt_auth_required'
        : String(auth?.code || fallbackCode);
      lastState = {
        enabled: true,
        provider: CODEX_CLI_PROVIDER,
        status: ready ? 'ready' : 'unavailable',
        code: ready ? 'ready' : unavailableCode,
        authType,
        commandPath: String(auth?.commandPath || auth?.command_path || settings.commandPath || ''),
        requestTimeoutSeconds: settings.requestTimeoutSeconds,
        models,
        message: ready
          ? redactDiagnosticString(auth?.message || 'Codex CLI is authenticated with ChatGPT.')
          : redactDiagnosticString(auth?.message || fallbackMessage),
      };
      return lastState;
    } catch (error) {
      const message = redactDiagnosticString(
        error?.message || error || 'Codex CLI auth refresh failed.'
      );
      log('WARN', 'codex_cli_runtime.refresh_failed', {
        message,
        errorType: String(error?.name || 'Error'),
      });
      lastState = createUnavailableState(settings, message, 'auth_refresh_failed');
      return lastState;
    }
  }

  async function openLoginTerminal() {
    const settings = getSettings();
    if (!authService || typeof authService.openLoginTerminal !== 'function') {
      return {
        ok: false,
        code: 'login_terminal_unavailable',
        provider: CODEX_CLI_PROVIDER,
        message: 'Codex CLI auth service is unavailable.',
      };
    }
    return authService.openLoginTerminal({
      codexCommand: getCommand(settings),
    });
  }

  function getModelCatalog() {
    const settings = getSettings();
    const availability = availabilityForSettings(settings);
    const { models } = getConfiguredModelState(settings);
    return models.map((id) => ({
      id,
      provider: CODEX_CLI_PROVIDER,
      available: availability.available,
      reason: availability.reason,
    }));
  }

  function isModelAvailable(modelId) {
    const rawId = String(modelId || '').trim();
    if (!rawId.toLowerCase().startsWith(`${CODEX_CLI_PROVIDER}/`)) {
      return null;
    }
    const id = normalizeCodexCliModelId(modelId);
    if (!id) {
      return null;
    }
    const { modelSet } = getConfiguredModelState();
    if (!modelSet.has(id.toLowerCase())) {
      return { available: false, reason: `Codex CLI model "${id}" is not configured.` };
    }
    return availabilityForSettings();
  }

  function getManagedConfigPatch() {
    const settings = getSettings();
    const { models } = getConfiguredModelState(settings);
    const availability = availabilityForSettings(settings);
    return {
      codex_cli_enabled: settings.enabled === true,
      codex_cli_auth_ready: availability.available === true,
      codex_cli_auth_reason: availability.available === true
        ? null
        : redactDiagnosticString(availability.reason || 'Codex CLI ChatGPT auth is not ready.'),
      // Prefer the path the auth probe actually authenticated. The settings
      // value is usually the bare "codex" token (or empty), so the sidecar was
      // handed a command it then had to re-resolve from PATH -- a different
      // resolution than the one we verified, which on Windows is how a
      // WindowsApps stub or a .cmd shim gets launched instead of the .exe the
      // probe proved works. The wire key and its sidecar consumers are
      // unchanged; only the value is now the resolved one.
      codex_cli_command: (
        (lastState && lastState.status === 'ready' && lastState.commandPath)
        || settings.commandPath
        || null
      ),
      codex_cli_runtime_root: getRuntimeRoot() || null,
      codex_cli_models: models.filter((model) => model !== CODEX_CLI_DEFAULT_MODEL),
      codex_cli_request_timeout_seconds: settings.requestTimeoutSeconds,
    };
  }

  return {
    name: CODEX_CLI_PROVIDER,
    getState,
    refresh,
    openLoginTerminal,
    getModelCatalog,
    isModelAvailable,
    getManagedConfigPatch,
  };
}

module.exports = {
  CODEX_CLI_DEFAULT_MODEL,
  CODEX_CLI_DISABLED_REASON,
  CODEX_CLI_PROVIDER,
  createCodexCliRuntimeService,
  normalizeCodexCliModelId,
  normalizeCodexCliModelIds,
};
