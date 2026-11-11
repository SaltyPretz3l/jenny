'use strict';

// Row 111: whether an approval in the Jenny chat is answered by Full auto instead of a person. Read once
// per call, after every refusal has had its say (deny rules, port refusals, the duplicate check).
//
// `autoRun` is load-bearing: scheduled checks and digests run in this same chat with prompt approvals, and
// they keep asking. Wake turns inherit `auto_run` from the chat, so Full auto covers them (owner, 2026-11-08).
// Paranoid safety mode wins. Anything unknown or unreadable means a person is asked.
const { getTrustedExecutionBinding } = require('./session-execution-authority');

const FULL_AUTO_SCOPE = 'full_auto';
const FULL_AUTO_SAFETY_MODES = new Set(['normal', 'strict']);

function fullAutoApproves(service, { toolName, sessionId, executionAuthority } = {}) {
  // Read at capture: a scheduled check caught by an Ask -> Auto flip mid-run keeps asking.
  if (toolName === 'exit_plan_mode' || getTrustedExecutionBinding(executionAuthority)?.capturedAutoRun !== true) return false;
  try {
    return service?.primaryFullAuto?.isArmed?.(sessionId) === true
      && FULL_AUTO_SAFETY_MODES.has(service.configService?.getChatUiState?.()?.safetyMode);
  } catch {
    return false;
  }
}

module.exports = { FULL_AUTO_SCOPE, fullAutoApproves };
