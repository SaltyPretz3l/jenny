'use strict';

// Background-job registration hook (cohesiveness QoL W2-2).
//
// A backgrounded `run_command` returns immediately with the job id in the
// tool result's `metadata.background_job_id`. This helper spots that marker
// on the tool.result notification (both the legacy path and the canonical
// bridge path route through it) and emits a `background-job-started` service
// event; services/main/backend-service-wiring.js forwards it to the
// background-job tracker. Kept out of chat-stream-tool-handling.js, which
// sits at the file-size cap.

// Mirrors shell_background.py's canonical job-id format (uuid4().hex[:12]).
const BACKGROUND_JOB_ID_PATTERN = /^[0-9a-f]{12}$/;

function noteBackgroundJobFromToolResult(service, ctx, params) {
  if (!service || typeof service.emit !== 'function') {
    return false;
  }
  // Only the canonical shape registers: a background
  // run_command with run_in_background in its own input. Any other tool (or
  // an MCP server) echoing a plausible background_job_id must not feed the
  // process-control path or grow bogus chips.
  if (String(params?.tool_name || '') !== 'run_command') {
    return false;
  }
  const toolInput = params.tool_input && typeof params.tool_input === 'object'
    && !Array.isArray(params.tool_input)
    ? params.tool_input
    : {};
  if (toolInput.run_in_background !== true) {
    return false;
  }
  const metadata = params.metadata && typeof params.metadata === 'object'
    && !Array.isArray(params.metadata)
    ? params.metadata
    : null;
  const jobId = String(metadata?.background_job_id || '').trim();
  if (!BACKGROUND_JOB_ID_PATTERN.test(jobId)) {
    return false;
  }
  // The spawned PID rides the sidecar's tool result over the framed stdio
  // channel — the trusted registration path. The workspace-writable
  // status.json must never grant kill authority (a workspace writer could
  // retarget the kill at an unrelated process).
  const rawPid = metadata?.background_job_pid;
  const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : null;
  service.emit('background-job-started', {
    jobId,
    sessionId: String(ctx?.resolvedSessionId || '').trim(),
    command: String(toolInput.command || ''),
    toolCallId: String(params.tool_call_id || '').trim(),
    toolName: String(params.tool_name || '').trim(),
    pid,
  });
  return true;
}

module.exports = {
  BACKGROUND_JOB_ID_PATTERN,
  noteBackgroundJobFromToolResult,
};
