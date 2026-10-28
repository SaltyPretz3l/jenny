'use strict';

// Print mode: one prompt, one run, one result frame, one exit code (Jenny CLI
// plan, decisions 6-9). The run holds the profile lock for its lifetime,
// composes the local-only host under the run's permission ceiling, settles
// every decision closed (no person is watching), projects the desktop stream
// to cli.v1 and ends with exactly one `result`.
//
// `runTurn` is the turn itself over an already composed host; print mode,
// `mcp serve` and the interactive loop share it, each with its own frame
// sink, its own signals and its own decider. `openHost`/`closeHost` are the
// lock and the started host around it.

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { acquireCliProfile, CLI_PROFILE_ERROR_CODES } = require('../services/cli-host/profile-lock');
const { createCliHost, hostComposition } = require('../services/cli-host/host');
const { hostLaunchOptions, lockOptions, resolveCliRuntime } = require('../services/cli-host/runtime-layout');
const { createHeadlessDecider } = require('../services/cli-host/decisions-headless');
const { createEventProjector } = require('../services/cli-host/event-projection');
const { createResultAggregator } = require('../services/cli-host/result-aggregator');
const { AI_ERROR_CODES, CLI_ERROR_CODES, HOST_ERROR_CODES } = require('../services/backend/error-codes');
const { API_VERSION } = require('../services/backend/sidecar-client');
const { CLI_CONTRACT, CLI_VERSION, EXIT_CODES } = require('./exit-codes');

const ROOT = path.resolve(__dirname, '..');
const UNLIMITED = 1_000_000_000;
const SETTLE_AFTER_CANCEL_MS = 15_000;
const TERMINAL_GRACE_MS = 5_000;
const CLOSE_TIMEOUT_MS = 20_000;
const NO_SESSION = 'none';
const CMP_RE = /^CMP-[A-Z]+(?:-[A-Z0-9]+)+$/u;
const USAGE_CODES = new Set([CLI_ERROR_CODES.INVALID_OPTION, CLI_ERROR_CODES.ENGINE_NOT_LOCAL, CLI_ERROR_CODES.INVALID_POLICY]);
const RETRYABLE_EXITS = new Set([EXIT_CODES.ENGINE_UNAVAILABLE, EXIT_CODES.PROFILE_BUSY]);

function cmpCode(error, fallback) {
  for (const candidate of [error?.error_code, error?.code]) {
    if (typeof candidate === 'string' && CMP_RE.test(candidate)) return candidate;
  }
  return fallback;
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout()), ms); timer.unref?.(); });
  return Promise.race([promise.finally(() => clearTimeout(timer)), guard]);
}

function usageFailure(message) {
  return Object.assign(new Error(message), { usage: true });
}

// The two things that can end a turn from outside: a cancel (a signal, the
// caller's pipe, an MCP cancellation) and the loss of the profile lock. A
// listener registered after the event still hears it.
function createTurnSignals() {
  const cancelListeners = new Set();
  const lostListeners = new Set();
  let cancelled = null;
  let lost = null;
  return Object.freeze({
    cancel(signalName) {
      if (cancelled) return;
      cancelled = signalName;
      for (const listener of cancelListeners) listener(signalName);
    },
    lockLost(error) {
      if (lost) return;
      lost = error || new Error('The profile lock was lost.');
      for (const listener of lostListeners) listener(lost);
    },
    onCancel(listener) { cancelListeners.add(listener); if (cancelled) listener(cancelled); },
    onLockLost(listener) { lostListeners.add(listener); if (lost) listener(lost); },
    cancelled: () => cancelled,
    lost: () => lost,
  });
}

// A run that fails before a session exists still ends with one error and one
// result frame, so a caller never has to parse free text.
function failedRun({ output, startedAt, code, message, exitFallback }) {
  const projector = createEventProjector({ run_id: `run_${randomUUID()}`, session_id: NO_SESSION });
  const aggregator = createResultAggregator({ run_id: NO_SESSION, session_id: NO_SESSION, started_at_ms: startedAt });
  const errorFrame = projector.next('error', { code, retryable: RETRYABLE_EXITS.has(exitFallback), message: String(message || '').slice(0, 2000) });
  output.frame(errorFrame);
  const finished = aggregator.finish({ reason: 'error', now_ms: Date.now() });
  // The aggregator never saw the error frame (it is bound to a run id), so the
  // code and exit are set here from the same classification.
  const payload = { ...finished, exit_code: exitFallback, is_error: true, error_code: code };
  output.frame(projector.next('result', payload));
  return { exitCode: payload.exit_code, payload };
}

// A session continues only inside the workspace project it was bound to:
// resuming it from another root would hand its history a different
// filesystem authority than the one it was created under.
function pickSession(backend, host, settings) {
  if (!settings.sessionId && !settings.continue) return null;
  const { project_id: projectId } = host.workspaceProject('cli_session_pick');
  if (settings.sessionId) {
    const session = backend.sessionStore.getSession(settings.sessionId);
    if (!session) throw usageFailure(`Session ${settings.sessionId} does not exist in this profile.`);
    if (session.project_id !== projectId) {
      throw usageFailure(`Session ${settings.sessionId} belongs to another workspace; run from that workspace or start a new session.`);
    }
    return settings.sessionId;
  }
  const sessions = (backend.sessionStore.listSessions() || []).filter((session) => session && session.id && session.project_id === projectId);
  const stamp = (session) => Date.parse(session.updated_at || session.updatedAt || session.created_at || session.createdAt || 0) || 0;
  const latest = sessions.sort((a, b) => stamp(b) - stamp(a))[0];
  if (!latest) throw usageFailure('There is no session to continue in this workspace.');
  return latest.id;
}

function runLimits(budgets) {
  if (budgets.max_inference_requests === null && budgets.max_output_tokens === null) return undefined;
  return {
    inference_requests: budgets.max_inference_requests ?? UNLIMITED,
    input_tokens: UNLIMITED,
    output_tokens: budgets.max_output_tokens ?? UNLIMITED,
  };
}

function isBudgetError(raw) {
  const text = `${raw?.message || ''} ${raw?.reason || ''}`;
  return /budget_exhausted|budget exhausted/iu.test(text);
}

// One turn over a composed and started host: pick or create the session,
// submit, settle every decision closed, project the stream, finish with one
// result frame. Resolves { exitCode, payload } where payload is the result.
async function runTurn({ host, settings, prompt, output, signals, appVersion = '', startedAt = Date.now(), logger = () => {},
  createDecider = createHeadlessDecider }) {
  const timing = { process_start_ms: Math.round(startedAt - process.uptime() * 1000), started_ms: null, first_token_ms: null };
  const runId = `run_${randomUUID()}`;
  const requestId = `req_${randomUUID()}`;
  const { backend, runPolicy } = hostComposition(host);
  let projector = null;
  let aggregator = null;
  let decider = null;
  let workId = null;
  let sessionId;
  let terminal = null;
  let resolveTerminal = null;
  const terminalSeen = new Promise((resolve) => { resolveTerminal = resolve; });
  let cancelledBy = null;
  let timedOut = false;
  let inputRequired = false;
  let lockLost = null;
  let events = null;
  let pump = Promise.resolve();

  const emit = (frame) => { if (frame) { aggregator?.observe(frame); output.frame(frame); } };
  const hostFrame = (kind, payload, identities) => emit(projector.next(kind, payload, identities));
  const cancelRun = async () => {
    if (!workId) return;
    try { await host.cancel(workId); } catch (error) { logger('WARN', 'cli.cancel_failed', { message: String(error?.message || '') }); }
  };
  signals.onCancel((signalName) => {
    if (cancelledBy) return;
    cancelledBy = signalName;
    output.diagnostic(`[cancel] ${signalName}: stopping the run`);
    cancelRun();
  });
  // A lost lock means another host may now own the profile: the run fails
  // closed as an engine-unavailable error (exit 6), never as a signal.
  signals.onLockLost((error) => {
    if (lockLost) return;
    lockLost = error;
    output.diagnostic('[lock] the profile lock was lost: stopping the run');
    if (projector && !terminal) {
      hostFrame('error', { code: CLI_PROFILE_ERROR_CODES.LOCK_LOST, retryable: true, message: String(error?.message || 'The profile lock was lost.').slice(0, 2000) });
    }
    cancelRun();
  });

  const finishRun = (finish) => {
    const payload = aggregator.finish({ ...finish, now_ms: Date.now() });
    emit(projector.next('result', payload));
    return { exitCode: payload.exit_code, payload };
  };

  try {
    try {
      sessionId = pickSession(backend, host, settings) || (await host.createSession({ title: prompt.slice(0, 80) })).session_id;
    } catch (error) {
      return failedRun({ output, startedAt, code: cmpCode(error, CLI_ERROR_CODES.INVALID_OPTION),
        message: error?.message, exitFallback: error?.usage ? EXIT_CODES.USAGE : EXIT_CODES.RUNTIME_ERROR });
    }
    projector = createEventProjector({ run_id: runId, session_id: sessionId, request_id: requestId,
      options: { thinking: settings.thinking, tool_output: settings.toolOutput } });
    aggregator = createResultAggregator({ run_id: runId, session_id: sessionId, started_at_ms: startedAt });
    hostFrame('init', {
      versions: { cli: CLI_VERSION, contract: CLI_CONTRACT, app: appVersion || 'unknown', sidecar_api: API_VERSION },
      cwd: settings.workspaceRoot, model: settings.model, engine: settings.engine,
      permission_mode: runPolicy.permissionMode, allowed_tools: [...runPolicy.allowedTools],
      disallowed_tools: [...runPolicy.disallowedTools], budgets: { ...settings.budgets },
    });
    decider = createDecider({ service: backend, policy: runPolicy, logger,
      onDecision: (payload) => {
        // A question or plan settled by policy had nobody to take it; one a
        // person settled at the terminal is a decision, not missing input.
        if (payload.request !== 'tool_approval' && payload.by === 'policy') inputRequired = true;
        hostFrame('decision', payload);
      } });
    events = host.events();
    pump = (async () => {
      for await (const raw of events) {
        if (raw?.type === 'started' && timing.started_ms === null) timing.started_ms = Date.now() - timing.process_start_ms;
        if (raw?.type === 'delta' && raw.content && timing.first_token_ms === null) timing.first_token_ms = Date.now() - timing.process_start_ms;
        const frame = projector.project(raw);
        if (!frame) continue;
        emit(frame);
        // A terminal question batch has no pending entry to decline: the turn
        // ended waiting for answers nobody here can give.
        if (frame.kind === 'user_questions_requested' && frame.payload.terminal === true) inputRequired = true;
        if ((frame.kind === 'complete' || frame.kind === 'error') && !terminal) {
          terminal = { raw, frame };
          resolveTerminal();
        }
      }
    })();

    if (cancelledBy || lockLost) return finishRun(classify({ cancelledBy, lockLost }));
    const sent = await host.submit({
      session_id: sessionId, prompt, idempotency_key: requestId,
      ...(runPolicy.permissionMode === 'plan' ? { plan_mode: true } : {}),
      ...(settings.model ? { preferred_model: settings.model } : {}),
      ...(runLimits(settings.budgets) ? { limits: runLimits(settings.budgets) } : {}),
    });
    if (!sent?.ok) {
      hostFrame('error', { code: cmpCode(sent?.error, AI_ERROR_CODES.ENGINE_CONNECTION), retryable: true,
        message: String(sent?.error?.reason || sent?.reason || 'The runtime refused the prompt.') });
      return finishRun({ reason: 'error' });
    }
    workId = sent.work_id;
    // A cancel or lock loss that landed while the submit was in flight had no
    // work id to act on; it acts now.
    if (cancelledBy || lockLost) cancelRun();
    hostFrame('accepted', { user_message_id: sent.turn_id || sent.work_id, idempotency_key: requestId,
      retry_point: { revision: sent.revision, status: sent.status } }, { work_id: workId });
    hostFrame('status', { phase: 'work', work_status: sent.status, revision: sent.revision });

    const timeout = setTimeout(() => { timedOut = true; output.diagnostic('[timeout] cancelling the run'); cancelRun(); }, settings.budgets.timeout_ms);
    timeout.unref?.();
    let work = null;
    try {
      work = await host.waitForWork(workId, { timeoutMs: settings.budgets.timeout_ms + SETTLE_AFTER_CANCEL_MS });
    } catch (error) {
      logger('WARN', 'cli.work_wait_failed', { reason: String(error?.reason || error?.message || '') });
    } finally {
      clearTimeout(timeout);
    }
    await withTimeout(terminalSeen, TERMINAL_GRACE_MS, () => null);
    if (work) hostFrame('status', { phase: 'work', work_status: work.status, revision: work.revision });
    if (timing.started_ms !== null) {
      output.diagnostic(`[timing] host ready ${timing.started_ms} ms${timing.first_token_ms !== null ? `, first token ${timing.first_token_ms} ms` : ''} after process start`);
    }
    return finishRun(classify({ work, workId, terminal, cancelledBy, timedOut, inputRequired, lockLost }));
  } finally {
    decider?.dispose();
    // The subscription is the turn's: returning the iterator ends the pump
    // whether or not the host stays open for another turn.
    if (events) await events.return();
    await withTimeout(pump, 1000, () => null);
  }
}

// The profile lock and the composed, started host, or the exit code of the
// failure that stood in their way (already reported as an error and a result
// frame). `onComposed` runs before the start, so a hard-exit hook can reach
// the sidecar the start spawns.
async function openHost({ settings, output, startedAt = Date.now(), runtime = resolveCliRuntime({ root: ROOT }), logger = () => {}, onLockLost = () => {}, onComposed = () => {} }) {
  let held;
  try {
    held = await acquireCliProfile({ userDataPath: settings.profilePath, ...lockOptions(runtime), onLost: onLockLost });
  } catch (error) {
    const busy = error?.code === CLI_PROFILE_ERROR_CODES.BUSY;
    // An ownership refusal (another host's profile, or a directory holding
    // data the CLI never imported) is the caller's to fix, not retryable.
    const ownership = error?.code === HOST_ERROR_CODES.CONFLICT;
    return { exitCode: failedRun({ output, startedAt, code: cmpCode(error, CLI_PROFILE_ERROR_CODES.LOCK_UNAVAILABLE),
      message: error?.message, exitFallback: busy ? EXIT_CODES.PROFILE_BUSY : (ownership ? EXIT_CODES.USAGE : EXIT_CODES.ENGINE_UNAVAILABLE) }).exitCode };
  }

  let host;
  try {
    host = createCliHost({
      profilePath: settings.profilePath, workspaceRoot: settings.workspaceRoot, ...hostLaunchOptions(runtime),
      engine: { type: settings.engine, model: settings.model },
      permissions: { allowedTools: settings.allowedTools, disallowedTools: settings.disallowedTools, permissionMode: settings.permissionMode },
      logger,
    });
  } catch (error) {
    held.release();
    const usage = USAGE_CODES.has(error?.code);
    const missingPython = error?.reason === 'invalid_python_executable';
    return { exitCode: failedRun({ output, startedAt, code: cmpCode(error, CLI_ERROR_CODES.INVALID_OPTION),
      message: missingPython ? 'The sidecar Python was not found. Run `jenny doctor`.' : error?.message,
      exitFallback: missingPython ? EXIT_CODES.ENGINE_UNAVAILABLE : (usage ? EXIT_CODES.USAGE : EXIT_CODES.RUNTIME_ERROR) }).exitCode };
  }
  onComposed(host);

  try {
    await host.start();
  } catch (error) {
    await withTimeout(host.close(), CLOSE_TIMEOUT_MS, () => null);
    held.release();
    return { exitCode: failedRun({ output, startedAt, code: cmpCode(error, AI_ERROR_CODES.ENGINE_CONNECTION),
      message: error?.message, exitFallback: EXIT_CODES.ENGINE_UNAVAILABLE }).exitCode };
  }
  return { held, host };
}

async function closeHost({ host, held, logger = () => {} }) {
  await withTimeout(host.close(), CLOSE_TIMEOUT_MS, () => { logger('WARN', 'cli.close_timeout', {}); return null; });
  held.release();
}

// Print mode: the lock, the host and one turn.
async function runPrint({ settings, prompt, output, control, appVersion = '', runtime, logger = () => {} }) {
  const startedAt = Date.now();
  const signals = createTurnSignals();
  const opened = await openHost({ settings, output, startedAt, runtime, logger,
    onLockLost: (error) => signals.lockLost(error),
    onComposed: (host) => {
      control.onCancel((signalName) => signals.cancel(signalName));
      // A second signal exits at once; the sidecar this run spawned must not
      // outlive it. The pid is the manager's own child, positively identified.
      control.onHardExit?.(() => killSidecar(hostComposition(host).backend));
    } });
  if (opened.exitCode !== undefined) return opened.exitCode;
  const { host, held } = opened;
  try {
    const { exitCode } = await runTurn({ host, settings, prompt, output, signals, appVersion, startedAt, logger });
    return exitCode;
  } finally {
    await closeHost({ host, held, logger });
  }
}

function killSidecar(backend) {
  const pid = Number(backend.sidecarManager?.getStatus?.().pid || 0);
  if (pid > 0) { try { process.kill(pid); } catch (_error) { /* already gone */ } }
}

// Why the run stopped, in the order the exit codes are owed: a lost profile
// lock, a person's signal, the CLI timeout, a paused or exhausted budget, a
// policy denial, a decision nobody could take, an error, or a clean completion.
function classify({ work, workId, terminal, cancelledBy, timedOut, inputRequired, lockLost }) {
  if (lockLost) return { reason: 'error' };
  if (cancelledBy) return { reason: 'cancelled', signal: cancelledBy };
  if (timedOut) return { reason: 'timeout' };
  // The runtime paused the work with a checkpoint: nothing was cancelled and
  // a later `--resume` continues it, so the caller learns the work id.
  if (work?.status === 'paused') {
    const id = typeof work.work_id === 'string' ? work.work_id : workId;
    return { reason: 'budget', resumable_stop: { reason: 'paused', ...(id ? { work_id: id } : {}) } };
  }
  const raw = terminal?.raw;
  if (raw && isBudgetError(raw)) return { reason: 'budget' };
  if (raw && String(raw.status || '') === 'denied') return { reason: 'denied' };
  if (work?.status === 'needs_attention' || (inputRequired && terminal?.frame.kind === 'complete')) return { reason: 'input_required' };
  if (terminal?.frame.kind === 'error') return { reason: 'error' };
  if (terminal?.frame.kind === 'complete') return { reason: 'complete' };
  return { reason: 'error' };
}

module.exports = { CLOSE_TIMEOUT_MS, classify, closeHost, createTurnSignals, failedRun, killSidecar, openHost, runPrint, runTurn, withTimeout };
