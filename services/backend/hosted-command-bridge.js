'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TOOL_ERROR_CODES } = require('./error-codes');
const { getTrustedExecutionBinding } = require('./session-execution-authority');
const { createWorkspaceSnapshot, removeSnapshot, inside } = require('../execution/desktop-workspace-snapshot');
const { sandboxError } = require('../execution/sandbox-errors');
const { createToolResourceClaim, projectToolResourceWait } = require('../tools/tool-resource-execution');

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

// The worker copies only the project the command was approved for. The project
// is staged into a per-job copy under the staging root, and only that root is
// mounted as the worker's /inputs, so sibling projects are never reachable.
// Returns the trusted project root, or null when it is missing or not inside
// the workspace (fail closed).
function hostedProjectRoot(service, trusted) {
  try {
    const config = service?.configService;
    const workspace = typeof config?.getToolsWorkspaceRoot === 'function'
      ? config.getToolsWorkspaceRoot() : config?.getState?.()?.toolsWorkspaceRoot;
    const project = trusted?.authority?.root_path;
    if (typeof workspace !== 'string' || !workspace.trim()
      || typeof project !== 'string' || !project.trim()) return null;
    const relative = path.relative(path.resolve(workspace.trim()), path.resolve(project));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
    return path.resolve(project);
  } catch {
    return null;
  }
}

function hostedStagingRoot(service) {
  const value = service?.hostExecutionStagingRoot || service?.options?.hostExecutionStagingRoot;
  return typeof value === 'string' && value.trim() && path.isAbsolute(value.trim())
    ? path.resolve(value.trim()) : null;
}

// The staging volume is the worker's whole /inputs, so a second job's staged
// copy would be readable by a running command. Staging, execution and cleanup
// therefore hold one process-wide lock; the worker runs one job at a time anyway.
let stagingTail = Promise.resolve();
async function acquireStagingLock(signal) {
  const previous = stagingTail;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  stagingTail = previous.then(() => held);
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(true);
    if (signal?.aborted) resolve(true); else signal?.addEventListener?.('abort', onAbort, { once: true });
  });
  const cancelled = await Promise.race([previous.then(() => false), aborted]);
  signal?.removeEventListener?.('abort', onAbort);
  if (cancelled) { release(); throw sandboxError('sandbox_cancelled'); }
  return release;
}

async function makeTreeWritable(directory) {
  await fs.chmod(directory, 0o700);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) await makeTreeWritable(path.join(directory, entry.name));
  }
}

// Remove stale children of the staging root left by a crash. Only direct
// children are touched (symlinks are unlinked, never followed).
async function purgeStagingRoot(stagingRoot) {
  let names;
  try { names = await fs.readdir(stagingRoot); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw sandboxError('snapshot_staging_purge_failed');
  }
  for (const name of names) {
    const child = path.join(stagingRoot, name);
    if (path.dirname(child) !== stagingRoot || !inside(stagingRoot, child)) continue;
    try {
      const stat = await fs.lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink() && /^[a-f0-9-]{36}$/u.test(name)) {
        await removeSnapshot({ directory: child, stagingRoot });
      } else {
        if (stat.isDirectory() && !stat.isSymbolicLink() && process.platform !== 'win32') {
          await makeTreeWritable(child).catch(() => {});
        }
        await fs.rm(child, { recursive: true, force: true });
      }
    } catch { throw sandboxError('snapshot_staging_purge_failed'); }
  }
}

async function stageHostedInput(service, projectRoot, stagingRoot, signal, id) {
  await purgeStagingRoot(stagingRoot);
  const userData = service?.options?.userDataPath || service?.userDataPath;
  const snapshot = await createWorkspaceSnapshot({
    root: projectRoot, stagingRoot, signal, id, posixNames: process.platform !== 'win32',
    forbiddenRoots: typeof userData === 'string' && userData.trim() ? [userData] : [],
  });
  return { directory: snapshot.directory };
}

async function executeHostedRunCommand(service, {
  input, sessionId, streamId, abortSignal, executionAuthority, callId, beforeProducer = null,
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
  let resourceClaim;
  let result;
  let commandMayStart = false;
  const trusted = getTrustedExecutionBinding(executionAuthority);
  const projectRoot = hostedProjectRoot(service, trusted);
  if (projectRoot === null) {
    return bridgeFailure('run_command', 'Hosted execution needs a configured workspace mount and a chat project folder inside it; that scope could not be established (project_root_outside_workspace).', TOOL_ERROR_CODES.EXECUTION_FAILED);
  }
  const stagingRoot = hostedStagingRoot(service);
  if (stagingRoot === null) {
    return bridgeFailure('run_command', 'Hosted execution failed: execution_staging_unavailable.', TOOL_ERROR_CODES.DISABLED);
  }
  let releaseStaging = null;
  let staged = null;
  try {
    releaseStaging = await acquireStagingLock(abortSignal);
    // The worker may have become blocked (e.g. cleanup unconfirmed) while this
    // call waited; never stage into a possibly live job's /inputs.
    if (worker.status?.().available !== true) throw sandboxError('sandbox_unavailable');
    // The broker fixes input_root at submit, so the copy is named now but only
    // made inside admission: after the resource lease and the authority check.
    const stagedId = randomUUID();
    normalized.value.inputRoot = stagedId;
    resourceClaim = createToolResourceClaim({ binding: executionAuthority,
      operationId: callId, toolName: 'run_command', input, required: !!service.sessionRuntime });
    result = await worker.execute(normalized.value, {
      signal: abortSignal,
      sessionId: String(sessionId).trim(),
      streamId: String(streamId).trim(),
      beforeAdmission: async () => {
        await resourceClaim?.admit(); await beforeProducer?.();
        trusted?.assertCurrent();
        staged = await stageHostedInput(service, projectRoot, stagingRoot, abortSignal, stagedId);
        commandMayStart = true;
      },
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
    if (projectToolResourceWait(error)) throw error;
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
  } finally {
    if (staged) {
      try { await removeSnapshot({ directory: staged.directory, stagingRoot }); } catch { /* purged on next staging */ }
    }
    releaseStaging?.();
    await resourceClaim?.settle({
      status: result?.status === 'cancelled' ? 'cancelled' : result?.success === true ? 'succeeded' : 'failed',
      cleanup: !commandMayStart || result?.cleanup_confirmed === true ? 'confirmed' : 'uncertain',
    });
  }
}

module.exports = { executeHostedRunCommand };
