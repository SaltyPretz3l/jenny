'use strict';
// Opt-in codex-cli ChatGPT product engine (explicit cloud opt-in, AGENTS.md).
// Composed via backend-service; reached via codexCli.* IPC + provider registry.
// See docs/architecture/BACKEND_SEAM_LANE.md.

const CODEX_LOGIN_COMMAND = 'codex login';

const CODEX_LOGIN_SETUP_MESSAGES = Object.freeze({
  login_terminal_opened: 'Opened a visible terminal for Codex CLI sign-in.',
  cli_access_denied: 'Windows denied launching Codex CLI. Install or update the npm Codex CLI, then run codex login.',
  auth_required_or_cli_missing: 'Codex CLI is missing or not authenticated. Install or update the npm Codex CLI, then run codex login.',
  cli_status_timeout: 'Codex CLI login status timed out. Run codex login status in a terminal, then retry.',
  login_terminal_unavailable: 'Codex login terminal launcher is unavailable.',
  login_terminal_failed: 'Could not open the Codex login terminal.',
  unsupported_platform: 'Jenny cannot open the Codex login terminal on this platform. Run codex login manually.',
});

function isAccessDenied(error) {
  const message = String(error?.message || error || '');
  return error?.code === 'EACCES' || /access is denied/i.test(message);
}

function classifyCodexLoginSetupError(error) {
  if (isAccessDenied(error)) {
    return 'cli_access_denied';
  }
  if (error?.code === 'ENOENT') {
    return 'auth_required_or_cli_missing';
  }
  return 'login_terminal_failed';
}

function normalizeCodexLoginSetupCode(code, ok = false) {
  const value = String(code || '').trim();
  if (value) {
    return value;
  }
  return ok === true ? 'login_terminal_opened' : 'login_terminal_failed';
}

function getCodexLoginSetupMessage(code, fallback = '', { scrubText = null } = {}) {
  const setupCode = normalizeCodexLoginSetupCode(code);
  const known = CODEX_LOGIN_SETUP_MESSAGES[setupCode];
  if (known) {
    return known;
  }
  const raw = String(fallback || '').trim();
  const scrubbed = typeof scrubText === 'function' ? scrubText(raw) : raw;
  return String(scrubbed || '').trim() || CODEX_LOGIN_SETUP_MESSAGES.login_terminal_failed;
}

function createCodexLoginSetupResult({
  ok = false,
  code = '',
  command = CODEX_LOGIN_COMMAND,
  message = '',
  scrubText = null,
} = {}) {
  const success = ok === true;
  const setupCode = normalizeCodexLoginSetupCode(code, success);
  return {
    ok: success,
    code: setupCode,
    command: command || CODEX_LOGIN_COMMAND,
    message: getCodexLoginSetupMessage(setupCode, message, { scrubText }),
  };
}

module.exports = {
  CODEX_LOGIN_COMMAND,
  CODEX_LOGIN_SETUP_MESSAGES,
  classifyCodexLoginSetupError,
  createCodexLoginSetupResult,
  getCodexLoginSetupMessage,
  normalizeCodexLoginSetupCode,
};
