'use strict';
// Opt-in codex-cli ChatGPT product engine (explicit cloud opt-in, AGENTS.md).
// Composed via backend-service; reached via codexCli.* IPC + provider registry.
// See docs/architecture/BACKEND_SEAM_LANE.md.

const {
  CODEX_LOGIN_COMMAND,
} = require('./codex-cli-login-setup');
const {
  checkCodexDiagnosticSetup,
  openCodexLoginTerminal,
} = require('./codex-cli-setup-adapter');
const {
  redactDiagnosticString,
} = require('./diagnostic-redaction');

const CODEX_CLI_PROVIDER = 'codex-cli';

function normalizeAuthType(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'chatgpt' || token === 'api_key') {
    return token;
  }
  return '';
}

function compactAuthStatus(result = {}) {
  const source = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const authType = normalizeAuthType(source.authType || source.auth_type);
  const setupOk = source.ok === true;
  const ready = setupOk && authType === 'chatgpt';
  const apiKeyOnly = setupOk && authType === 'api_key';
  const unknownAuthenticated = setupOk && !authType;
  let code = String(source.code || '').trim() || (setupOk ? 'ready' : 'auth_required_or_cli_missing');
  let message = redactDiagnosticString(source.message || '').trim();
  if (apiKeyOnly) {
    code = 'chatgpt_auth_required';
    message = 'Codex CLI is authenticated with an API key. Sign in with ChatGPT for Codex CLI models.';
  } else if (unknownAuthenticated) {
    code = 'chatgpt_auth_required';
    message = 'Codex CLI auth type is unknown. Sign in with ChatGPT for Codex CLI models.';
  }
  return {
    ok: ready,
    configured: ready,
    status: ready ? 'ready' : 'unconfigured',
    code: ready ? 'ready' : code,
    provider: CODEX_CLI_PROVIDER,
    authType,
    command: String(source.command || 'codex login status').trim() || 'codex login status',
    commandPath: String(source.commandPath || source.command_path || '').trim(),
    message: ready ? String(message || 'Codex CLI is authenticated with ChatGPT.').trim() : message,
  };
}

function createCodexCliAuthService({
  checkSetup = checkCodexDiagnosticSetup,
  openLoginTerminal = openCodexLoginTerminal,
  logger = null,
} = {}) {
  async function getState(options = {}) {
    try {
      const setup = await Promise.resolve(checkSetup(options));
      return compactAuthStatus(setup);
    } catch (error) {
      const message = redactDiagnosticString(error?.message || error || 'Codex CLI login status failed.');
      if (typeof logger === 'function') {
        logger('WARN', 'codex_cli_auth.status_failed', {
          message,
          errorType: String(error?.name || 'Error'),
        });
      }
      return {
        ok: false,
        configured: false,
        status: 'unconfigured',
        code: 'cli_status_failed',
        provider: CODEX_CLI_PROVIDER,
        authType: '',
        command: 'codex login status',
        commandPath: '',
        message,
      };
    }
  }

  async function openLogin(options = {}) {
    try {
      const result = await Promise.resolve(openLoginTerminal(options));
      return {
        provider: CODEX_CLI_PROVIDER,
        command: CODEX_LOGIN_COMMAND,
        ...(result && typeof result === 'object' ? result : { ok: false, code: 'login_terminal_failed' }),
      };
    } catch (error) {
      const message = redactDiagnosticString(error?.message || error || 'Could not open Codex login terminal.');
      return {
        ok: false,
        code: 'login_terminal_failed',
        provider: CODEX_CLI_PROVIDER,
        command: CODEX_LOGIN_COMMAND,
        message,
      };
    }
  }

  return {
    getState,
    openLoginTerminal: openLogin,
  };
}

module.exports = {
  CODEX_CLI_PROVIDER,
  compactAuthStatus,
  createCodexCliAuthService,
};
