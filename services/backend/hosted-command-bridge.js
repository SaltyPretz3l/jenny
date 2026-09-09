'use strict';

const { TOOL_ERROR_CODES } = require('./error-codes');

function hostedExecutionBrokerFor(service) {
  return service?.hostExecutionBroker
    || service?.options?.hostExecutionBroker
    || null;
}

function normalizeHostedRunCommandArguments(input) {
  const allowed = new Set([
    'command', 'cwd', 'timeout_seconds', 'expected_exit_codes', 'purpose',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return { error: 'Hosted run_command accepts foreground command arguments only.' };
  }
  if (typeof input.command !== 'string' || !input.command.trim()
    || input.command.includes('\0') || Buffer.byteLength(input.command, 'utf8') > 16_384) {
    return { error: 'Hosted run_command requires a non-empty command.' };
  }
  const cwd = input.cwd === undefined ? '.' : input.cwd;
  if (typeof cwd !== 'string' || !cwd || cwd.length > 1_024 || /[\\\0]/u.test(cwd)
    || cwd.startsWith('/') || cwd.split('/').includes('..')) {
    return { error: 'Hosted run_command requires a relative workspace cwd.' };
  }
  const timeoutSeconds = input.timeout_seconds === undefined ? 10 : input.timeout_seconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds)
    || timeoutSeconds < 0.1 || timeoutSeconds > 120) {
    return { error: 'Hosted run_command timeout must be between 0.1 and 120 seconds.' };
  }
  const expectedExitCodes = input.expected_exit_codes === undefined
    ? [0] : input.expected_exit_codes;
  if (!Array.isArray(expectedExitCodes) || expectedExitCodes.length < 1
    || expectedExitCodes.length > 16
    || expectedExitCodes.some((code) => !Number.isInteger(code) || code < 0 || code > 255)
    || new Set(expectedExitCodes).size !== expectedExitCodes.length) {
    return { error: 'Hosted run_command expected_exit_codes is invalid.' };
  }
  return {
    value: {
      command: input.command,
      cwd,
      timeoutSeconds,
      expectedExitCodes: [...expectedExitCodes],
    },
  };
}

async function executeHostedRunCommand(service, {
  input, sessionId, streamId, abortSignal,
}, { bridgeFailure, sanitizeBridgeMetadata, maxOutputChars }) {
  const worker = hostedExecutionBrokerFor(service);
  const version = Number(
    service?.options?.hostExecutionPolicyVersion
      ?? service?.hostExecutionPolicyVersion ?? 1
  );
  if (version !== 2 || !worker || worker.status?.().available !== true) {
    return bridgeFailure('run_command', 'Hosted execution worker is unavailable.', TOOL_ERROR_CODES.DISABLED);
  }
  const normalized = normalizeHostedRunCommandArguments(input);
  if (normalized.error) {
    return bridgeFailure('run_command', normalized.error, TOOL_ERROR_CODES.EXECUTION_FAILED);
  }
  if (!String(sessionId || '').trim() || !String(streamId || '').trim()) {
    return bridgeFailure('run_command', 'Hosted execution requires session and stream identity.', TOOL_ERROR_CODES.EXECUTION_FAILED);
  }
  try {
    const result = await worker.execute(normalized.value, {
      signal: abortSignal,
      sessionId: String(sessionId).trim(),
      streamId: String(streamId).trim(),
    });
    const stdout = String(result?.stdout || '');
    const stderr = String(result?.stderr || '');
    const output = stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr;
    return {
      tool_name: 'run_command',
      output: output.slice(0, maxOutputChars),
      success: result?.success === true,
      content_type: 'text',
      generated_artifacts: [],
      error_code: result?.success === true ? null : TOOL_ERROR_CODES.EXECUTION_FAILED,
      metadata: sanitizeBridgeMetadata({
        result_kind: 'hosted_execution_worker',
        status: result?.status,
        exit_code: result?.exit_code,
        output_truncated: result?.output_truncated === true || output.length > maxOutputChars,
        cleanup_confirmed: result?.cleanup_confirmed === true,
        workspace: result?.workspace,
      }),
    };
  } catch (error) {
    const rawReason = String(error?.reason || '').trim();
    const reason = /^[a-z_]{1,80}$/u.test(rawReason) ? rawReason : 'worker_execution_failed';
    const uncertain = reason === 'sandbox_cleanup_unconfirmed'
      || reason === 'sandbox_receipt_mismatch';
    return {
      ...bridgeFailure(
        'run_command',
        uncertain
          ? 'Hosted execution cleanup could not be confirmed; the worker remains unavailable.'
          : `Hosted execution failed: ${reason}.`,
        TOOL_ERROR_CODES.EXECUTION_FAILED,
      ),
      metadata: {
        result_kind: 'hosted_execution_worker',
        settlement: uncertain ? 'uncertain' : 'failed',
        reason: reason || 'worker_execution_failed',
      },
    };
  }
}

module.exports = { executeHostedRunCommand };
