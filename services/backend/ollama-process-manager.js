const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const { FileJsonStore } = require('./file-json-store');
const {
  pipeChildLogs,
} = require('./child-process-logging');
const {
  getProcessCommandLineSync,
  isProcessAlive,
  killProcessTree,
  processCommandMatchesStored,
  waitForProcessExit,
} = require('./process-utils');
const {
  clearOwnedOllamaState,
  forceKillAnyRemainingLocalOllamaVerifiedSync,
  listLocalOllamaProcessesSync,
} = require('./ollama-shutdown');
const {
  buildSanitizedOllamaEnv,
} = require('./ollama-env');
const {
  classifyOllamaCrash,
} = require('./ollama-crash-diagnostics');
const {
  resolveOllamaOutputLevel,
} = require('./ollama-stderr-level');
const {
  TRAY_CONFLICT_REMEDIATION,
  buildTrayConflictWarnDetails,
  detectOllamaTrayConflictAsync,
  detectOllamaTrayConflictSync,
  isSilentExternalKillSignature,
} = require('./ollama-tray-conflict');

// Cap on the rolling stderr tail retained per spawn for crash diagnosis. Large
// enough to capture the fatal line plus a little surrounding context, small
// enough to keep log payloads bounded.
const STDERR_TAIL_MAX_LINES = 20;

// Engine-liveness heartbeat (2026-07-11 CMP-LOOP-0015 RCA): Ollama streams
// NOTHING to the chat client while the model composes a buffered tool call,
// but its embedded llama.cpp server prints per-slot telemetry on stderr every
// few seconds while decoding (and progress lines during prompt eval / model
// load). Lines matching these prefixes are forwarded — throttled — to the
// sidecar's stream-inactivity watchdog as proof the engine is busy, not hung.
// Deliberately EXCLUDES `srv` lines ("all slots are idle" is not activity)
// and [GIN] access logs (the shell's own /api/tags polls would defeat the
// watchdog entirely).
const ENGINE_ACTIVITY_LINE_PATTERNS = [
  /^slot\s+\w+/i, // per-slot lifecycle: launch/operator/print_timing/release
  /^cmn\s/i, // reasoning-budget transitions during active decode
  /^(llama_|load_tensors|llm_load|ggml_)/i, // model (re)load progress
];
const ENGINE_ACTIVITY_THROTTLE_MS = 5000;

function isEngineActivityLine(line) {
  const text = String(line || '');
  return ENGINE_ACTIVITY_LINE_PATTERNS.some((pattern) => pattern.test(text));
}
// How many tail lines to attach to the durable ollama.exited / startup_failed
// ERROR events.
const STDERR_TAIL_EMIT_LINES = 15;

const OLLAMA_PORT = 11434;
const OLLAMA_HOST = '127.0.0.1';
const HEALTH_TIMEOUT_MS = 500;
const STARTUP_POLL_MS = 300;
const STARTUP_MAX_WAIT_MS = 15000;
const STOP_GRACE_MS = 3000;
// Delay before probing the port after an unexpected (crash) exit, so a clearer
// operator signal can be emitted: still listening => an external instance holds
// the port; silent => crashed, recovery deferred to the next chat's
// ensureRunning(). Kept short but non-zero so a fast respawn elsewhere settles.
const POST_EXIT_PROBE_DELAY_MS = 2000;
class OllamaProcessManager {
  constructor({
    logger,
    userDataPath,
    spawnImpl,
    killProcessTreeImpl,
    isProcessAliveImpl,
    waitForProcessExitImpl,
    listLocalOllamaProcessesImpl,
    forceKillAnyRemainingLocalOllamaSyncImpl,
    clearOwnedOllamaStateImpl,
    getProcessCommandLineSyncImpl,
    stateStore,
    platform,
    host = OLLAMA_HOST,
    port = OLLAMA_PORT,
    healthTimeoutMs = HEALTH_TIMEOUT_MS,
    postExitProbeDelayMs = POST_EXIT_PROBE_DELAY_MS,
    resolveMaxLoadedModels,
    detectTrayConflictImpl,
    onEngineActivity,
    engineActivityThrottleMs = ENGINE_ACTIVITY_THROTTLE_MS,
    nowImpl,
  } = {}) {
    this._process = null;
    this._ownedProcess = false;
    // Latches true on the first spawn this run and never resets. Consulted by
    // mightHaveLocalOllamaResidue() so a dispose-time force-kill sweep still
    // runs even after stop() has cleared _ownedProcess/_ownedPid.
    this._everOwnedProcess = false;
    this._ownedPid = 0;
    this._postExitProbeTimer = null;
    // Rolling tail of the most recent spawn's stderr, used to diagnose a code-1
    // startup crash. Reset on each start().
    this._recentStderr = [];
    // Details of the most recent failed start (crash or startup timeout), so the
    // chat preflight can compose a specific user-facing message instead of the
    // generic "Ollama is unavailable" line. Cleared on a successful start().
    this._lastFailure = null;
    this._log = logger || (() => {});
    this._spawn = spawnImpl || spawn;
    this._killProcessTree = killProcessTreeImpl || killProcessTree;
    this._isProcessAlive = isProcessAliveImpl || isProcessAlive;
    this._waitForProcessExit = waitForProcessExitImpl || waitForProcessExit;
    this._listLocalOllamaProcesses =
      listLocalOllamaProcessesImpl || ((options = {}) => listLocalOllamaProcessesSync(options));
    this._forceKillAnyRemainingLocalOllamaSync =
      forceKillAnyRemainingLocalOllamaSyncImpl || ((options = {}) =>
        forceKillAnyRemainingLocalOllamaVerifiedSync(options));
    this._clearOwnedOllamaState =
      clearOwnedOllamaStateImpl || clearOwnedOllamaState;
    this._getProcessCommandLineSync =
      getProcessCommandLineSyncImpl || getProcessCommandLineSync;
    // Tests inject a stub (or explicit null) so the default win32 detection
    // (PowerShell process list + Startup-folder readdir) never runs in a suite.
    this._detectTrayConflict = detectTrayConflictImpl === undefined
      ? detectOllamaTrayConflictSync
      : (detectTrayConflictImpl || (() => null));
    // Start()-path variant: injected impls drive both paths, but the default is
    // the async detector — the sync win32 scan (execFileSync, up to 5s) blocked
    // the whole event loop at start(), including the overlapped sidecar spawn.
    this._detectTrayConflictStart = detectTrayConflictImpl === undefined
      ? (args = {}) => detectOllamaTrayConflictAsync({
        ...args,
        listProcessesImpl: listLocalOllamaProcessesImpl ? this._listLocalOllamaProcesses : undefined,
      })
      : this._detectTrayConflict;
    // Result of the most recent start()-time tray detection; consulted by the
    // exit handler to name the tray as the likely killer on a silent code-1.
    this._trayConflict = null;
    this._expectedExitPids = new Set();
    this._platform = platform || process.platform;
    this._host = String(host || OLLAMA_HOST).trim() || OLLAMA_HOST;
    this._port = Number(port) || OLLAMA_PORT;
    this._healthTimeoutMs = Number(healthTimeoutMs) || HEALTH_TIMEOUT_MS;
    this._postExitProbeDelayMs = Number(postExitProbeDelayMs) >= 0
      ? Number(postExitProbeDelayMs)
      : POST_EXIT_PROBE_DELAY_MS;
    // Optional thunk: returns the desired OLLAMA_MAX_LOADED_MODELS ceiling for
    // this spawn (e.g. 2 when inline autocomplete needs a FIM model to coexist
    // with the chat model), or null/undefined to keep the anti-thrash default of
    // 1. Called at start() time so it sees live config; a user-set env var still
    // wins inside buildSanitizedOllamaEnv.
    this._resolveMaxLoadedModels =
      typeof resolveMaxLoadedModels === 'function' ? resolveMaxLoadedModels : null;
    // Throttled engine-liveness heartbeat sink (see ENGINE_ACTIVITY_LINE_PATTERNS).
    this._onEngineActivity = typeof onEngineActivity === 'function' ? onEngineActivity : null;
    this._engineActivityThrottleMs = Number(engineActivityThrottleMs) >= 0
      ? Number(engineActivityThrottleMs)
      : ENGINE_ACTIVITY_THROTTLE_MS;
    // Monotonic by default: a backward wall-clock step (NTP correction) under
    // Date.now would suppress heartbeats for the length of the jump, starving
    // the sidecar's liveness clock mid-generation — the exact false positive
    // the heartbeat exists to prevent.
    this._now = typeof nowImpl === 'function' ? nowImpl : () => performance.now();
    this._lastEngineActivityForwardedAt = 0;
    this._stateStore = stateStore || (
      userDataPath
        ? new FileJsonStore(path.join(userDataPath, 'ollama-process.json'))
        : null
    );
  }

  // Forward "the engine is doing work" to the sink at most once per throttle
  // window. Best-effort by contract: a throw in the sink must never take down
  // the log pipeline this rides on.
  _forwardEngineActivity(line) {
    if (!this._onEngineActivity || !isEngineActivityLine(line)) {
      return;
    }
    const now = this._now();
    if (now - this._lastEngineActivityForwardedAt < this._engineActivityThrottleMs) {
      return;
    }
    this._lastEngineActivityForwardedAt = now;
    try {
      this._onEngineActivity();
    } catch (_error) {
      /* best-effort */
    }
  }

  async start() {
    // A (re)start supersedes any pending post-exit crash probe; otherwise a
    // stale probe could fire after the new process is up, see the port alive,
    // and wrongly mark our freshly-owned process as an external instance.
    this._clearPostExitProbe();
    // Fresh diagnostics for this attempt: the stderr tail is per-spawn, and a
    // prior failure must not leak into this attempt's result.
    this._recentStderr = [];
    this._lastFailure = null;
    // Detect the tray app / Startup shortcut before the already-running check:
    // when the tray's own server holds the port, Jenny would otherwise treat it
    // as a benign external instance and the conflict would stay silent — the
    // exact failure mode of the 2026-07-02 incident. Kicked off here, joined
    // after the port probe: detection overlaps without blocking the event loop.
    const trayCheckDone = this._runTrayConflictCheck();
    const ownership = this._readOwnedState();

    if (ownership && this._isProcessAlive(ownership.pid)) {
      // F2c: the persisted pid may have been recycled onto an unrelated
      // process; kill only what still matches the command we recorded.
      if (!this._ownedPidIdentityConfirmed(ownership.pid, ownership)) {
        this._log('WARN', 'ollama.force_kill_identity_unconfirmed', {
          pid: ownership.pid,
          status: 'skipped',
          phase: 'start',
        });
      } else {
        this._log('INFO', 'ollama.killing_stale_owned_process', { pid: ownership.pid });
        try {
          this._forceKillAnyRemainingLocalOllamaSync({
            platform: this._platform,
            logger: this._log,
            isProcessAliveImpl: this._isProcessAlive,
            ownedPids: [ownership.pid],
          });
        } catch (_error) {
          // best effort — fall through to normal start
        }
      }
      this._clearOwnedState();
    } else if (ownership) {
      this._clearOwnedState();
      this._log('INFO', 'ollama.stale_owned_process_state_cleared', { pid: ownership.pid });
    }

    const running = await this._isRunning();
    // Join the overlapped tray detection: its WARN and _trayConflict snapshot
    // must exist before any return or spawn (2026-07-02 incident contract).
    await trayCheckDone;
    if (running) {
      this._log('INFO', 'ollama.already_running', { port: this._port });
      this._ownedProcess = false;
      this._ownedPid = 0;
      return { started: false, external: true };
    }

    const command = await this._resolveCommand();
    if (!command) {
      this._log('WARN', 'ollama.not_found', {
        message: 'ollama executable not found on PATH; skipping auto-start',
      });
      this._lastFailure = {
        reason: 'not_found',
        likelyCause: 'not_installed',
        remediation:
          'The "ollama" executable was not found on PATH. Install Ollama (or add it to PATH) and retry.',
      };
      return { started: false, external: false, failure: this._lastFailure };
    }

    this._log('INFO', 'ollama.starting', { command });
    let maxLoadedModels = null;
    try {
      const resolved = Number(this._resolveMaxLoadedModels?.());
      if (Number.isInteger(resolved) && resolved > 1) {
        maxLoadedModels = resolved;
      }
    } catch (_error) {
      // best effort — fall back to the default ceiling
    }
    if (maxLoadedModels) {
      this._log('INFO', 'ollama.max_loaded_models_raised', {
        maxLoadedModels,
        reason: 'inline_suggest_coexistence',
      });
    }
    const spawnEnv = buildSanitizedOllamaEnv({ maxLoadedModels });
    if (spawnEnv.warning) {
      this._log('WARN', 'ollama.models_dir_ignored', {
        configuredPath: spawnEnv.configuredPath,
        reason: spawnEnv.warning.reason,
        target: spawnEnv.warning.target || null,
        remediation: spawnEnv.warning.remediation || null,
        troubleshooting: spawnEnv.warning.troubleshooting || null,
        message: spawnEnv.warning.message,
      });
    }
    this._process = this._spawn(command, ['serve'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
      env: spawnEnv.env,
    });
    pipeChildLogs(this._process, {
      logger: this._log,
      prefix: 'ollama',
      resolveLevel: resolveOllamaOutputLevel,
      onOutput: ({ stream, line }) => {
        if (stream !== 'stderr') {
          return;
        }
        this._recentStderr.push(line);
        if (this._recentStderr.length > STDERR_TAIL_MAX_LINES) {
          this._recentStderr.shift();
        }
        this._forwardEngineActivity(line);
      },
    });
    this._ownedProcess = true;
    this._everOwnedProcess = true;
    this._ownedPid = Number(this._process && this._process.pid) || 0;
    this._writeOwnedState({
      pid: this._ownedPid,
      command,
      startedAt: new Date().toISOString(),
      app_owned: true,
    });

    this._process.on('error', (error) => {
      const message = String(error.message || error);
      this._log('ERROR', 'ollama.spawn_error', { message });
      this._lastFailure = {
        reason: 'spawn_error',
        likelyCause: null,
        remediation: `Could not launch the ollama process: ${message}`,
      };
      this._resetLiveOwnership();
      this._clearOwnedState();
    });

    const spawnedProcess = this._process;
    this._process.on('exit', (code, signal) => {
      const pid = Number(spawnedProcess?.pid || 0) || 0;
      const expected = pid > 0 && this._expectedExitPids.has(pid);
      if (expected) {
        this._expectedExitPids.delete(pid);
      }
      const isCrash = !expected && (Number(code || 0) !== 0 || Boolean(signal));
      const exitLevel = expected
        ? 'INFO'
        : (Number(code || 0) === 0 && !signal ? 'WARN' : 'ERROR');
      let stderrTail = null;
      let classification = null;
      let traySuspected = false;
      if (isCrash) {
        // Capture the cause now, while the spawn's stderr tail is still around,
        // and attach it to the durable ERROR event so the reason is never lost.
        stderrTail = this._snapshotStderrTail();
        classification = classifyOllamaCrash(stderrTail);
        // Silent kill (code 1, no signal, no level=ERROR stderr): the tray app
        // may have launched AFTER start() (the boot-time this._trayConflict
        // snapshot is stale), so re-run detection fresh right now rather than
        // trusting the snapshot. A stderr classification, when present, keeps
        // the likelyCause slot — the tray suspicion rides alongside it.
        const silentKill = isSilentExternalKillSignature({ code, signal, stderrTail });
        const trayAtExit = silentKill ? this._detectTrayConflictAtExit() : null;
        traySuspected = Boolean(trayAtExit && trayAtExit.detected) && silentKill;
        if (traySuspected && !classification) {
          classification = {
            likelyCause: 'tray_app_conflict',
            remediation: TRAY_CONFLICT_REMEDIATION,
          };
        }
        this._lastFailure = {
          reason: 'crash',
          code,
          signal,
          stderrTail,
          likelyCause: classification?.likelyCause || null,
          remediation: classification?.remediation || null,
        };
      }
      this._log(exitLevel, 'ollama.exited', {
        code,
        signal,
        expected,
        ...(pid ? { pid } : {}),
        ...(classification?.likelyCause ? { likelyCause: classification.likelyCause } : {}),
        ...(traySuspected ? {
          traySuspected: true,
          message: `The Ollama tray app is running and is the likely killer of this silent exit. ${TRAY_CONFLICT_REMEDIATION}`,
        } : {}),
        ...(stderrTail ? { stderrTail } : {}),
      });
      this._resetLiveOwnership();
      this._clearOwnedState();
      if (isCrash) {
        // Crash exit: non-zero code OR a terminating signal (SIGKILL/SIGSEGV/
        // OOM-killer). Both are logged ERROR above and warrant a recovery probe.
        this._schedulePostExitProbe({ code, signal, ...(pid ? { pid } : {}) });
      }
    });

    const ready = await this._waitForReady(spawnedProcess);
    if (!ready) {
      const failure = this._buildStartupFailure();
      // Reason-aware fallback so an unclassified crash is not mislabelled as a
      // timeout (the two failure modes need different operator action).
      const fallbackMessage = failure.reason === 'crash'
        ? `Ollama exited unexpectedly (${failure.signal ? `signal ${failure.signal}` : `exit code ${failure.code}`})`
        : `Ollama did not become ready within ${STARTUP_MAX_WAIT_MS}ms`;
      this._log('ERROR', 'ollama.startup_failed', {
        reason: failure.reason,
        ...(failure.code != null ? { code: failure.code } : {}),
        ...(failure.signal != null ? { signal: failure.signal } : {}),
        ...(failure.likelyCause ? { likelyCause: failure.likelyCause } : {}),
        ...(failure.stderrTail ? { stderrTail: failure.stderrTail } : {}),
        message: failure.remediation || fallbackMessage,
      });
      await this._cleanupFailedStartup(failure.reason);
      return { started: false, external: false, failure };
    }

    this._lastFailure = null;
    this._log('INFO', 'ollama.started', { pid: this._process?.pid });
    return { started: true, external: false };
  }

  // Start()-time detection of the Ollama tray app / Startup shortcut (win32
  // only; the detector no-ops elsewhere). Detection + WARN surfacing only — no
  // auto-kill, no shortcut deletion; the owner decides. Best-effort: a failing
  // detector must never block an engine start.
  async _runTrayConflictCheck() {
    this._trayConflict = null;
    try {
      const conflict = await this._detectTrayConflictStart({
        platform: this._platform,
        logger: this._log,
        listProcessesImpl: this._listLocalOllamaProcesses,
      });
      if (!conflict || !conflict.detected) {
        return;
      }
      this._trayConflict = conflict;
      this._log('WARN', 'ollama.tray_app_conflict_detected', buildTrayConflictWarnDetails(conflict));
    } catch (_error) {
      // best effort only — never block an engine start on detection
    }
  }

  // On-demand re-detection of the tray app, run from the exit handler on a
  // silent-kill signature. The start()-time check in _runTrayConflictCheck()
  // only runs once; when the tray app launches AFTER Jenny's engine, that
  // boot-time snapshot (this._trayConflict) stays stale for the life of the
  // process and the exit handler would otherwise never learn the tray is now
  // present. Mirrors _runTrayConflictCheck()'s detector call exactly (same
  // args) so the two code paths never drift. Best-effort: a failing detector
  // must never break exit handling. Only emits the WARN (and the toast it
  // drives) for a conflict that was NOT already flagged at start — the
  // start-time path already emitted it in that case.
  _detectTrayConflictAtExit() {
    try {
      const conflict = this._detectTrayConflict({
        platform: this._platform,
        logger: this._log,
        listProcessesImpl: this._listLocalOllamaProcesses,
      });
      if (!conflict || !conflict.detected) {
        return conflict || null;
      }
      const alreadyDetectedAtStart = Boolean(this._trayConflict && this._trayConflict.detected);
      if (!alreadyDetectedAtStart) {
        this._log('WARN', 'ollama.tray_app_conflict_detected', buildTrayConflictWarnDetails(conflict));
      }
      return conflict;
    } catch (_error) {
      // best effort only — never break exit handling on detection failure
      return null;
    }
  }

  // Last few stderr lines from the current/most-recent spawn, joined for log and
  // error payloads. Returns null when nothing was captured.
  _snapshotStderrTail() {
    if (!Array.isArray(this._recentStderr) || this._recentStderr.length === 0) {
      return null;
    }
    return this._recentStderr.slice(-STDERR_TAIL_EMIT_LINES).join('\n');
  }

  // Resolve the failure detail for a not-ready start(): a crash/spawn-error
  // already captured by the exit/error handler, otherwise a startup timeout
  // (process alive but never answered /api/tags) classified from its stderr.
  _buildStartupFailure() {
    if (this._lastFailure) {
      return this._lastFailure;
    }
    const stderrTail = this._snapshotStderrTail();
    const classification = classifyOllamaCrash(stderrTail);
    this._lastFailure = {
      reason: 'startup_timeout',
      stderrTail,
      likelyCause: classification?.likelyCause || null,
      remediation: classification?.remediation
        || `Ollama did not become ready within ${STARTUP_MAX_WAIT_MS}ms.`,
    };
    return this._lastFailure;
  }

  _schedulePostExitProbe(context = {}) {
    this._clearPostExitProbe();
    const timer = setTimeout(() => {
      this._postExitProbeTimer = null;
      this._runPostExitProbe(context).catch(() => {});
    }, this._postExitProbeDelayMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    this._postExitProbeTimer = timer;
  }

  _clearPostExitProbe() {
    if (this._postExitProbeTimer) {
      clearTimeout(this._postExitProbeTimer);
      this._postExitProbeTimer = null;
    }
  }

  async _runPostExitProbe(context = {}) {
    const running = await this._isRunning();
    if (running) {
      // Something still answers on the port after our owned process died — an
      // external Ollama instance holds it, so there is nothing for us to recover.
      this._ownedProcess = false;
      this._log('INFO', 'ollama.detected_external_after_exit', {
        port: this._port,
        ...context,
      });
      return;
    }
    // Crashed and nothing is listening. We deliberately do NOT respawn here
    // (that risks a restart loop on a permanently blocked port); the next chat's
    // ensureRunning() is the recovery gate. Emit a clear operator signal so the
    // gap between crash and lazy recovery is not silent.
    this._log('WARN', 'ollama.crashed_pending_recovery', {
      port: this._port,
      message: 'Ollama exited unexpectedly; it will be restarted on the next chat.',
      ...context,
    });
  }

  async ensureRunning() {
    if (await this._isRunning()) {
      return { started: false, external: !this._ownedProcess, ready: true };
    }
    this._log('WARN', 'ollama.preflight_unavailable', {
      port: this._port,
      message: 'Ollama is not responding before chat; attempting to start it.',
    });
    const startResult = await this.start();
    const ready = await this._isRunning();
    const failure = ready ? null : (startResult?.failure || this._lastFailure || null);
    if (!ready) {
      this._log('WARN', 'ollama.preflight_unavailable_after_start', {
        port: this._port,
        started: Boolean(startResult?.started),
        external: Boolean(startResult?.external),
        ...(failure?.likelyCause ? { likelyCause: failure.likelyCause } : {}),
        ...(failure?.reason ? { reason: failure.reason } : {}),
      });
    }
    return {
      started: Boolean(startResult?.started),
      external: Boolean(startResult?.external),
      ready,
      ...(failure ? { failure } : {}),
    };
  }

  async stop(options = {}) {
    // A deliberate stop supersedes any pending post-exit crash probe.
    this._clearPostExitProbe();
    const scope = options && options.scope === 'any_local' ? 'any_local' : 'app_owned';
    const ownedState = this._readOwnedState();
    const ownedPid = this._getOwnedPid(ownedState);
    const isOwned = this._ownedProcess || Boolean(ownedState);

    if (scope === 'any_local') {
      await this._stopAnyLocal(ownedPid, isOwned, ownedState);
      return;
    }

    if (!isOwned || !ownedPid) {
      if (await this._isRunning()) {
        this._log('INFO', 'ollama.external_left_running', { port: this._port });
      }
      return;
    }

    if (!this._isProcessAlive(ownedPid)) {
      this._clearOwnedState();
      this._resetLiveOwnership();
      this._log('INFO', 'ollama.stale_owned_process_state_cleared', { pid: ownedPid });
      return;
    }

    if (!this._ownedPidIdentityConfirmed(ownedPid, ownedState)) {
      // F2c: not ours to kill — drop the record so the next launch skips it.
      this._log('WARN', 'ollama.force_kill_identity_unconfirmed', {
        pid: ownedPid,
        status: 'skipped',
        phase: 'stop',
      });
      this._clearOwnedState();
      this._resetLiveOwnership();
      return;
    }

    await this._stopOwnedPid(ownedPid);
    await this._killOrphanedRunners(ownedPid).catch(() => null);

    // F2d: clear ownership only on a CONFIRMED exit; else retain for retry.
    this._finalizeOwnedStop(ownedPid);
  }

  // PID-reuse guard, mirroring sidecar-shutdown.js: a pid read back from disk
  // may belong to an unrelated process by now. A live child handle needs no
  // check — that pid is ours by construction.
  _ownedPidIdentityConfirmed(ownedPid, ownedState) {
    const pid = Number(ownedPid) || 0;
    if (!pid) {
      return false;
    }
    if ((Number(this._process && this._process.pid) || 0) === pid) {
      return true;
    }
    let commandLine;
    try {
      commandLine = this._getProcessCommandLineSync(pid, { platform: this._platform });
    } catch (_error) {
      commandLine = '';
    }
    return processCommandMatchesStored(commandLine, ownedState && ownedState.command);
  }

  // Clear the owned-state record only on a CONFIRMED exit; an unconfirmed one
  // retains it and downgrades the terminal log to WARN.
  _finalizeOwnedStop(ownedPid, extra = {}) {
    const pid = Number(ownedPid) || 0;
    const confirmed = !pid || !this._isProcessAlive(pid);
    if (confirmed) {
      this._clearOwnedState();
      this._log('INFO', 'ollama.stopped', { confirmed: true, ...extra });
      return true;
    }
    this._log('WARN', 'ollama.stopped', {
      confirmed: false,
      pid,
      retained: true,
      message: 'Ollama exit was not confirmed; the owned-state record is retained so the next launch can reap it.',
      ...extra,
    });
    return false;
  }

  // #15: async + memoized PATH lookup. The synchronous execFileSync blocked the
  // main thread for up to 3s when ollama is absent; execFile keeps the event loop
  // free and a successful lookup is cached per process. A miss is NOT cached so a
  // later start() re-probes PATH after an in-app install.
  _resolveCommand() {
    if (!this._resolveCommandPromise) {
      this._resolveCommandPromise = new Promise((resolve) => {
        const { execFile } = require('child_process');
        const cmd = this._platform === 'win32' ? 'where' : 'which';
        execFile(cmd, ['ollama'], { encoding: 'utf-8', timeout: 3000, windowsHide: true }, (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const first = String(stdout || '').split(/\r?\n/)[0].trim();
          resolve(first || null);
        });
      }).then((command) => {
        if (!command) {
          this._resolveCommandPromise = null;
        }
        return command;
      });
    }
    return this._resolveCommandPromise;
  }

  async _isRunning() {
    return new Promise((resolve) => {
      const url = `http://${this._host}:${this._port}/api/tags`;
      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      try {
        const request = http.get(url, { timeout: this._healthTimeoutMs }, (response) => {
          const statusCode = response.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            response.resume();
            finish(false);
            return;
          }
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += String(chunk || '');
            if (body.length > 1024 * 1024) {
              request.destroy();
              finish(false);
            }
          });
          response.on('end', () => {
            try {
              const payload = JSON.parse(body);
              finish(Boolean(payload && Array.isArray(payload.models)));
            } catch (_error) {
              finish(false);
            }
          });
        });
        request.on('timeout', () => {
          request.destroy();
          finish(false);
        });
        request.on('error', () => finish(false));
      } catch (_error) {
        finish(false);
      }
    });
  }

  async _waitForReady(spawnedProcess) {
    const deadline = Date.now() + STARTUP_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      // Fast-fail: if our spawned process already died (crash or spawn error),
      // the exit/error handler has nulled this._process. Stop blind-polling the
      // dead port for the full timeout and surface the captured crash reason.
      if (spawnedProcess && this._process !== spawnedProcess) {
        return false;
      }
      if (await this._isRunning()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
    }
    return false;
  }

  // True only when a local ollama process could actually be left behind: this
  // run spawned one (latched _everOwnedProcess), or a prior run's owned-state
  // record survives on disk (crashed run). BackendService.dispose() consults
  // this before the force-kill sweep — the sweep's synchronous process-list
  // scan costs ~1s on win32, which is pure waste on hosts that never ran
  // local ollama (and was a flat 1s tax on every test-suite dispose).
  mightHaveLocalOllamaResidue() {
    if (this._everOwnedProcess) {
      return true;
    }
    return this._readOwnedState() !== null;
  }

  _readOwnedState() {
    const state = this._stateStore ? this._stateStore.read(null) : null;
    const pid = Number(state && state.pid);
    if (!state || state.app_owned !== true || !Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    return {
      pid,
      command: String(state.command || '').trim(),
      startedAt: String(state.startedAt || '').trim(),
      app_owned: true,
    };
  }

  _writeOwnedState(value) {
    if (!this._stateStore) {
      return;
    }
    this._stateStore.write(value);
  }

  _clearOwnedState() {
    if (this._stateStore) {
      this._stateStore.delete();
    }
    this._clearOwnedOllamaState(null);
  }

  // Drop the in-memory handle/ownership latch. Deliberately does NOT touch the
  // on-disk owned-state record — that lifetime is governed by F2d confirmation.
  _resetLiveOwnership() {
    this._process = null;
    this._ownedProcess = false;
    this._ownedPid = 0;
  }

  _getOwnedPid(ownedState = null) {
    if (this._process && this._process.pid) {
      return Number(this._process.pid) || 0;
    }
    if (this._ownedPid) {
      return Number(this._ownedPid) || 0;
    }
    if (ownedState && ownedState.pid) {
      return Number(ownedState.pid) || 0;
    }
    return 0;
  }

  async _stopOwnedPid(ownedPid) {
    const stopSource = this._process ? 'live_handle' : 'persisted_pid';
    const liveHandlePid = Number(this._process && this._process.pid) || 0;
    const normalizedOwnedPid = Number(ownedPid) || 0;
    this._log('INFO', 'ollama.stopping', { pid: ownedPid, stop_source: stopSource });
    if (normalizedOwnedPid && liveHandlePid === normalizedOwnedPid) {
      this._expectedExitPids.add(normalizedOwnedPid);
    }
    this._resetLiveOwnership();

    await this._killProcessTree(ownedPid, { force: false }).catch(() => null);
    const stoppedGracefully = await this._waitForProcessExit(ownedPid, STOP_GRACE_MS);
    if (!stoppedGracefully) {
      await this._killProcessTree(ownedPid, { force: true }).catch(() => null);
      try {
        await this._waitForProcessExit(ownedPid, STOP_GRACE_MS);
      } catch (_error) {
        // best effort only
      }
    }
  }

  async _cleanupFailedStartup(reason) {
    const ownedPid = this._getOwnedPid();
    try {
      if (ownedPid && this._isProcessAlive(ownedPid)) {
        await this._stopOwnedPid(ownedPid);
      }
    } catch (error) {
      this._log('WARN', 'ollama.startup_cleanup_failed', {
        reason: String(reason || 'startup_failed'),
        pid: ownedPid || null,
        message: String(error && error.message || error),
      });
    } finally {
      this._resetLiveOwnership();
      if (!ownedPid || !this._isProcessAlive(ownedPid)) {
        this._clearOwnedState();
      } else {
        this._log('WARN', 'ollama.cleanup_unconfirmed', {
          reason: String(reason || 'startup_failed'), pid: ownedPid, confirmed: false, retained: true,
        });
      }
    }
  }

  async _stopAnyLocal(ownedPid, isOwned, ownedState = null) {
    let identityConfirmed = true;
    if (isOwned && ownedPid && this._isProcessAlive(ownedPid)) {
      identityConfirmed = this._ownedPidIdentityConfirmed(ownedPid, ownedState);
      if (identityConfirmed) {
        await this._stopOwnedPid(ownedPid);
      } else {
        this._log('WARN', 'ollama.force_kill_identity_unconfirmed', {
          pid: ownedPid,
          status: 'skipped',
          phase: 'stop_any_local',
        });
      }
    } else if (ownedPid && !this._isProcessAlive(ownedPid)) {
      this._log('INFO', 'ollama.stale_owned_process_state_cleared', { pid: ownedPid });
    }

    this._resetLiveOwnership();

    // F2: the machine-wide sweep only runs when THIS install could have left a
    // local ollama behind; otherwise quit must leave other tools' daemons alone.
    let sweepResult = null;
    if (!this.mightHaveLocalOllamaResidue()) {
      this._log('INFO', 'ollama.any_local_sweep_skipped', {
        scope: 'any_local',
        reason: 'no_local_ollama_residue',
      });
    } else {
      try {
        this._log('INFO', 'ollama.stopping_any_local', { scope: 'any_local' });
        sweepResult = this._forceKillAnyRemainingLocalOllamaSync({
          platform: this._platform,
          logger: this._log,
          isProcessAliveImpl: this._isProcessAlive,
          // F2(3): with the owned pid known, skip the blanket by-name kill.
          ownedPids: identityConfirmed && ownedPid ? [ownedPid] : null,
        });
      } catch (error) {
        this._log('WARN', 'ollama.any_local_sweep_failed', {
          message: String(error && error.message || error),
        });
      }
    }

    // Identity-unconfirmed: the record is not ours, so drop it outright.
    if (!identityConfirmed) {
      this._clearOwnedState();
      this._log('INFO', 'ollama.stopped', { confirmed: true, skipped: 'identity_unconfirmed' });
      return;
    }
    this._finalizeOwnedStop(ownedPid, {
      ...(sweepResult ? { killedPids: sweepResult.killedPids || [] } : {}),
    });
  }

  // POSIX orphans are reparented to pid 1, which remains alive, so that pid
  // must count as orphaned. Confirm the live command line before signalling
  // because a listed pid may have been reused or may be an external server.
  // Older ollama_llama_server binaries are not listed here and are out of scope.
  async _killOrphanedRunners(parentPid) {
    try {
      if (this._platform === 'win32') {
        const orphanPids = this._listLocalOllamaProcesses({
          platform: this._platform,
          logger: this._log,
        })
          .filter((entry) => entry.parentPid === parentPid || !this._isProcessAlive(entry.parentPid))
          .map((entry) => entry.pid);
        for (const pid of orphanPids) {
          this._log('INFO', 'ollama.killing_orphaned_runner', { pid, parentPid });
          await this._killProcessTree(pid, { force: true }).catch(() => null);
        }
        return;
      }
      const entries = this._listLocalOllamaProcesses({
        platform: this._platform,
        logger: this._log,
      });
      for (const entry of entries) {
        const pid = entry.pid;
        if (!Number.isInteger(pid) || pid <= 0 || pid === parentPid
          || !(entry.parentPid === parentPid || entry.parentPid === 1
            || !this._isProcessAlive(entry.parentPid))) continue;
        let commandLine;
        try {
          commandLine = this._getProcessCommandLineSync(pid, { platform: this._platform });
        } catch (_error) {
          commandLine = '';
        }
        if (!/\brunner\b/.test(commandLine)) {
          this._log('DEBUG', 'ollama.orphan_runner_identity_unconfirmed', { pid, parentPid });
          continue;
        }
        this._log('INFO', 'ollama.killing_orphaned_runner', { pid, parentPid });
        await this._killProcessTree(pid, { force: true }).catch(() => null);
      }
    } catch (_error) {
      // best effort only
    }
  }

}

// Dispose-time force-kill sweep, gated on the residue probe when the manager
// provides one — the sweep's synchronous process-list scan costs ~1s on win32,
// pure waste when no local ollama could be left behind. Managers without the
// probe (injected test stubs) keep the unconditional sweep.
function runOllamaDisposeForceKillSweep(manager) {
  const mightHaveResidue = typeof manager.mightHaveLocalOllamaResidue === 'function'
    ? manager.mightHaveLocalOllamaResidue()
    : true;
  if (!mightHaveResidue) {
    return;
  }
  manager._forceKillAnyRemainingLocalOllamaSync({
    platform: manager._platform,
    logger: manager._log,
    isProcessAliveImpl: manager._isProcessAlive,
  });
}

module.exports = {
  ENGINE_ACTIVITY_THROTTLE_MS,
  OllamaProcessManager,
  isEngineActivityLine,
  resolveOllamaOutputLevel,
  runOllamaDisposeForceKillSweep,
};
