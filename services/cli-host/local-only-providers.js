'use strict';

const { CLI_ERROR_CODES } = require('../backend/error-codes');
const { isLocalEngine } = require('../backend/session-lockdown-gate');
const { CLOUD_ENGINE_TYPES } = require('../backend/managed-sidecar-chat-helpers');

function cliError(ErrorType, code, reason, message) {
  return Object.assign(new ErrorType(message || reason), { code, reason });
}

// A CLI process has no Electron safeStorage and must never emulate it, so the
// secure store sees encryption as unavailable and refuses every write; these
// throws only fire if a caller bypasses that availability check.
function createRefusingSafeStorage() {
  const refuse = () => {
    throw cliError(Error, CLI_ERROR_CODES.NO_SECURE_STORAGE, 'cli_no_secure_storage',
      'The Jenny CLI has no secure credential storage.');
  };
  return Object.freeze({
    isEncryptionAvailable: () => false,
    encryptString: refuse,
    decryptString: refuse,
  });
}

const CODEX_UNSUPPORTED_MESSAGE = 'Codex CLI is not available from the Jenny CLI.';

// Same shapes as codex-cli-setup-adapter's results, so the auth service's
// compactAuthStatus and openLogin pass them through unchanged; nothing spawns.
function createInertCodexHooks() {
  return Object.freeze({
    checkCodexDiagnosticSetup: async () => ({
      ok: false, code: 'cli_unsupported', reason: 'cli_unsupported', command: 'codex login status',
      commandPath: '', commandSource: 'unknown', authType: '', exitCode: null,
      stdoutTail: '', stderrTail: '', message: CODEX_UNSUPPORTED_MESSAGE,
    }),
    openCodexLoginTerminal: async () => ({
      ok: false, code: 'cli_unsupported', reason: 'cli_unsupported', command: 'codex login',
      commandPath: '', message: CODEX_UNSUPPORTED_MESSAGE,
    }),
  });
}

// isLocalEngine already rejects the cloud engines; naming them again keeps the
// refusal independent of how that predicate evolves. It accepts `replay` (and
// the test-only `mock`) as local, which is what the replay-driven tests need.
function assertLocalOnlyEngine(engineType, { apiUrl = '' } = {}) {
  const normalized = String(engineType || '').trim().toLowerCase();
  if (!normalized || CLOUD_ENGINE_TYPES.has(normalized) || !isLocalEngine(normalized, apiUrl)) {
    throw cliError(TypeError, CLI_ERROR_CODES.ENGINE_NOT_LOCAL, 'engine_not_local',
      'The Jenny CLI runs local engines only.');
  }
  return normalized;
}

// Ollama routes a model tagged `-cloud` (or `:cloud`) to its hosted service
// with the same local API, so the engine type alone cannot vouch for it.
const OLLAMA_CLOUD_MODEL_RE = /(?:-|:)cloud$/iu;

function assertLocalOnlyModel(engineType, model) {
  const name = String(model || '').trim();
  if (String(engineType || '').toLowerCase() === 'ollama' && OLLAMA_CLOUD_MODEL_RE.test(name)) {
    throw cliError(TypeError, CLI_ERROR_CODES.ENGINE_NOT_LOCAL, 'model_not_local',
      'The Jenny CLI runs local models only; Ollama cloud models are refused.');
  }
  return name;
}

module.exports = {
  CLI_ERROR_CODES,
  assertLocalOnlyEngine,
  assertLocalOnlyModel,
  cliError,
  createInertCodexHooks,
  createRefusingSafeStorage,
};
