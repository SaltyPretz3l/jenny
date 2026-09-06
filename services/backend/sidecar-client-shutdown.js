const { SHUTDOWN_TIMEOUT_MS } = require('./sidecar-request-timeouts');

function endSidecarInput(attachedProcess) {
  const stdin = attachedProcess && attachedProcess.stdin;
  if (!stdin || stdin.writableEnded === true || stdin.destroyed === true) {
    return false;
  }
  stdin.end();
  return true;
}

async function requestSidecarShutdown(client, {
  apiVersion,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
} = {}) {
  const attachedProcess = client.process;
  const startedAt = Date.now();
  const requestedTimeoutMs = Number(timeoutMs);
  const boundedTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.min(Math.max(Math.trunc(requestedTimeoutMs), 1), SHUTDOWN_TIMEOUT_MS)
    : SHUTDOWN_TIMEOUT_MS;
  let status = 'acknowledged';
  try {
    return await client._requestWithTimeout(
      'shutdown',
      { accept_version: apiVersion },
      boundedTimeoutMs
    );
  } catch (error) {
    status = 'rpc_failed';
    throw error;
  } finally {
    const stdin = attachedProcess && attachedProcess.stdin;
    try {
      endSidecarInput(attachedProcess);
    } catch (error) {
      status = 'stdin_end_failed';
      client.logger?.('WARN', 'sidecar.shutdown_stdin_end_failed', {
        message: String(error && error.message || error).slice(0, 240),
      });
    }
    client.logger?.('INFO', 'sidecar.shutdown_request_complete', {
      stage: 'request_acknowledgement',
      status,
      durationMs: Math.max(Date.now() - startedAt, 0),
      stdinEnded: Boolean(stdin && stdin.writableEnded === true),
    });
  }
}

module.exports = {
  endSidecarInput,
  requestSidecarShutdown,
};
