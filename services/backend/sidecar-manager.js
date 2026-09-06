const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const { FileJsonStore } = require('./file-json-store');
const { buildSandboxLayout, ensureSandboxLayout } = require('./path-utils');
const {
  getProcessCommandLine,
  killProcessTree,
  processCommandMatchesStored,
} = require('./process-utils');
const { sanitizeSpawnEnv } = require('./sanitize-spawn-env');
const { endSidecarInput } = require('./sidecar-client-shutdown');
const { SidecarLogLineDecoder } = require('./sidecar-log-line-decoder');

// The managed sidecar is a *model-adjacent* child: it re-spawns Python workers
// and, when the opt-in codex-cli engine is on, a vendor CLI. Cloning the whole
// parent environment into it handed a developer/CI shell's OpenAI, GitHub, AWS
// and HuggingFace credentials to every one of those descendants. The sidecar
// itself reads only JENNY_* (parent pid, cold-start audit, image-model dirs,
// python runtime) plus the standard Python/venv/CUDA discovery vars — feature
// flags arrive in the config payload, not in env — so an allowlist over
// sanitizeSpawnEnv's ALWAYS_KEEP system baseline is sufficient.
//
// allowOnly (not the default deny-first posture) because deny-first only strips
// keys whose NAME advertises a credential. It would still have forwarded
// HTTPS_PROXY=https://user:pass@host, AWS_PROFILE, and any vendor-specific
// config var — exactly the ambient shell state this child has no business
// seeing.
const SIDECAR_ALLOWED_ENV = Object.freeze([
  /^JENNY_/i,
  /^PYTHON/i,
  /^VIRTUAL_ENV$/i,
  /^CUDA_/i,
]);

function resolveBackendRepoRoot(explicitRepoRoot) {
  if (explicitRepoRoot) {
    return explicitRepoRoot;
  }
  return process.cwd();
}

// Project-local venv interpreter, per OS. Windows venvs put python under
// .venv/Scripts/python.exe; POSIX (macOS/Linux) venvs use .venv/bin/python.
// The setup script (scripts/setup/) always creates <repoRoot>/.venv, so this
// candidate resolves out of the box on every supported platform.
function venvPythonRelativePath(platform) {
  return platform === 'win32'
    ? path.join('.venv', 'Scripts', 'python.exe')
    : path.join('.venv', 'bin', 'python');
}

// Actionable detail for a missing managed-sidecar interpreter. A bare "not
// found at <path>" stranded users who had never created the project virtualenv:
// the app launches and the IDE works, so the only symptom is that every AI
// surface stays silently dead. Name the venv Jenny expects and the exact setup
// command for this platform.
function describeMissingPythonInterpreter({
  pythonExecutable,
  repoRoot,
  platform = process.platform,
  env = process.env,
} = {}) {
  const venvPath = path.join(String(repoRoot || ''), '.venv');
  const explicitOverride = String(env.JENNY_BACKEND_PYTHON || '').trim();
  if (explicitOverride && explicitOverride === pythonExecutable) {
    return `The managed sidecar's Python interpreter was not found at ${pythonExecutable}. `
      + 'That path came from the JENNY_BACKEND_PYTHON environment variable. Correct it, or unset '
      + `it to fall back to the project virtualenv at ${venvPath}, then retry.`;
  }
  const setupCommand = platform === 'win32' ? 'npm run setup' : 'bash ./setup.sh';
  return `The managed sidecar's Python interpreter was not found at ${pythonExecutable}. `
    + `Jenny expects the project virtualenv at ${venvPath}. Run "${setupCommand}" from the repo `
    + 'root to create it, then retry.';
}

function resolvePythonExecutable(repoRoot, explicitPython, options = {}) {
  if (explicitPython) {
    return explicitPython;
  }
  const platform = options.platform || process.platform;
  const fileExists = options.fileExists || fs.existsSync;
  const relativeVenvPython = venvPythonRelativePath(platform);
  const candidatePaths = [
    process.env.JENNY_BACKEND_PYTHON,
    path.join(repoRoot, relativeVenvPython),
    path.join(process.cwd(), relativeVenvPython),
  ].filter(Boolean);
  const existingPath = candidatePaths.find((candidate) => fileExists(candidate));
  return existingPath || candidatePaths[0];
}

const GRACEFUL_STOP_TIMEOUT_MS = 5000;
const FORCED_STOP_TIMEOUT_MS = 2000;
const DEFAULT_SOFT_TIMEOUT_MS = 25000;
const MANAGED_SIDECAR_BASE_URL = 'stdio://sidecar';

class SidecarManager extends EventEmitter {
  constructor({
    mode = 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable,
    sandboxRoot,
    spawnImpl,
    logLevel = 'INFO',
    launchCommand,
    launchArgs,
    launchSource,
    packagedLaunchDetail,
    packagedSidecarLaunch = null,
    resolvePackagedLaunch = null,
    killProcessTreeImpl,
    getProcessCommandLineImpl,
    startupSoftTimeoutMs = DEFAULT_SOFT_TIMEOUT_MS,
    gracefulStopTimeoutMs = GRACEFUL_STOP_TIMEOUT_MS,
    forcedStopTimeoutMs = FORCED_STOP_TIMEOUT_MS,
    logger,
    nowFn = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    super();
    this.mode = mode;
    this.repoRoot = resolveBackendRepoRoot(repoRoot);
    this.pythonExecutable = resolvePythonExecutable(this.repoRoot, pythonExecutable);
    this.sandboxLayout = buildSandboxLayout(
      sandboxRoot || path.join(userDataPath, 'backend-sidecar')
    );
    this.spawnImpl = spawnImpl || spawn;
    this.logLevel = logLevel;
    this.launchCommand = launchCommand || this.pythonExecutable;
    this.launchArgs = launchArgs || null;
    this.launchSource = String(launchSource || '').trim()
      || (packagedSidecarLaunch ? 'packaged-binary' : 'python-module');
    this.packagedLaunchDetail = String(packagedLaunchDetail || '').trim()
      || String(
        packagedSidecarLaunch?.packagedLaunchDetail
        || packagedSidecarLaunch?.failureReason
        || ''
      ).trim();
    this.packagedSidecarLaunch = (
      packagedSidecarLaunch
      && typeof packagedSidecarLaunch === 'object'
      && !Array.isArray(packagedSidecarLaunch)
    ) ? { ...packagedSidecarLaunch } : null;
    // Optional async resolver used when packagedSidecarLaunch is deferred off the
    // pre-window path; resolved lazily during start() (see _startManagedDev).
    this._resolvePackagedLaunch = typeof resolvePackagedLaunch === 'function'
      ? resolvePackagedLaunch
      : null;
    this.killProcessTreeImpl = killProcessTreeImpl || killProcessTree;
    this.getProcessCommandLineImpl = getProcessCommandLineImpl || getProcessCommandLine;
    // startupSoftTimeoutMs is the managed startup watchdog used for exit grace and the ready deadline.
    this.startupSoftTimeoutMs = Math.max(Number(startupSoftTimeoutMs) || 0, 0);
    this.gracefulStopTimeoutMs = Math.min(
      Math.max(Number(gracefulStopTimeoutMs) || 0, 1),
      GRACEFUL_STOP_TIMEOUT_MS
    );
    this.forcedStopTimeoutMs = Math.min(
      Math.max(Number(forcedStopTimeoutMs) || 0, 1),
      FORCED_STOP_TIMEOUT_MS
    );
    this.logger = typeof logger === 'function' ? logger : null;
    this._now = typeof nowFn === 'function' ? nowFn : Date.now;
    // Optional injected timer seam (defaults to the real globals) so tests can
    // drive the spawn-settle grace deterministically without wall-clock delays.
    this._setTimeout = typeof setTimeoutFn === 'function' ? setTimeoutFn : setTimeout;
    this._clearTimeout = typeof clearTimeoutFn === 'function' ? clearTimeoutFn : clearTimeout;
    this.status = {
      mode: this.mode,
      phase: 'stopped',
      baseUrl: '',
      attempts: 0,
      detail: '',
      pid: 0,
      startupStage: '',
      startupMs: 0,
      progressLogCount: 0,
      launchSource: this.launchSource,
      packagedLaunchDetail: this.packagedLaunchDetail,
    };
    this.process = null;
    this.isStopping = false;
    this._retryStartInFlight = null;
    this.logDecoder = new SidecarLogLineDecoder();
    this.startupStartedAt = 0;
    this.progressLogCount = 0;
    this.lastExitInfo = null;
    this.lastSpawnError = null;
    this.stateStore = new FileJsonStore(this.sandboxLayout.stateFilePath);
  }

  getStatus() {
    return { ...this.status };
  }

  _setStatus(patch) {
    this.status = {
      ...this.status,
      ...patch,
    };
    this.emit('status', this.getStatus());
  }

  async start() {
    this.logDecoder = new SidecarLogLineDecoder();
    this.startupStartedAt = Date.now();
    this.progressLogCount = 0;
    this.lastExitInfo = null;
    this.lastSpawnError = null;
    return this._startManagedDev();
  }

  async retryStart() {
    // In-flight latch (W3.9): concurrent retry triggers (user retry button,
    // crash auto-reconnect, engine-switch restart) coalesce onto a single
    // stop/start cycle instead of interleaving two restarts.
    if (this._retryStartInFlight) {
      return this._retryStartInFlight;
    }
    this._retryStartInFlight = (async () => {
      try {
        await this.stop();
        return await this.start();
      } finally {
        this._retryStartInFlight = null;
      }
    })();
    return this._retryStartInFlight;
  }

  async _startManagedDev() {
    ensureSandboxLayout(this.sandboxLayout);
    await this.cleanupStaleState();

    if (!fs.existsSync(this.repoRoot)) {
      throw new Error(`Managed backend repo was not found at ${this.repoRoot}.`);
    }
    const env = {
      ...sanitizeSpawnEnv(process.env, { allow: SIDECAR_ALLOWED_ENV, allowOnly: true }),
      PYTHONUNBUFFERED: '1',
      // Authoritative parent pid for the sidecar's parent-death watchdog
      // (sidecar/runtime/parent_watchdog.py): it self-exits if this process
      // dies, guarding against orphaned sidecars when Electron is SIGKILLed.
      JENNY_PARENT_PID: String(process.pid),
    };

    // Packaged release builds defer launch resolution (full-binary SHA-256 +
    // `--version` probe) to here so it runs inside the awaited start() phase --
    // after the window has been created -- instead of blocking first paint when
    // the BackendService is constructed before the window.
    if (!this.packagedSidecarLaunch && typeof this._resolvePackagedLaunch === 'function') {
      const resolved = await this._resolvePackagedLaunch();
      this.packagedSidecarLaunch = (
        resolved && typeof resolved === 'object' && !Array.isArray(resolved)
      ) ? { ...resolved } : null;
      if (this.packagedSidecarLaunch) {
        this.packagedLaunchDetail = String(
          this.packagedSidecarLaunch.packagedLaunchDetail
          || this.packagedSidecarLaunch.failureReason
          || this.packagedLaunchDetail
          || ''
        ).trim();
      }
    }

    let launchCommand = this.launchCommand;
    let launchArgs = this.launchArgs;
    let launchSource = this.launchSource || 'python-module';
    let packagedLaunchDetail = this.packagedLaunchDetail || '';

    if (this.packagedSidecarLaunch) {
      launchSource = 'packaged-binary';
      packagedLaunchDetail = String(
        this.packagedSidecarLaunch.packagedLaunchDetail
        || this.packagedSidecarLaunch.failureReason
        || packagedLaunchDetail
      ).trim();
      if (this.packagedSidecarLaunch.ok !== true) {
        const failureDetail = packagedLaunchDetail || 'Packaged sidecar launch is unavailable.';
        this._setStatus({
          phase: 'failed',
          detail: failureDetail,
          startupStage: 'packaged_launch_invalid',
          startupMs: this._getStartupElapsedMs(),
          progressLogCount: this.progressLogCount,
          launchSource,
          packagedLaunchDetail: failureDetail,
        });
        throw new Error(failureDetail);
      }
      launchCommand = this.packagedSidecarLaunch.launchCommand;
      launchArgs = this.packagedSidecarLaunch.launchArgs;
    } else {
      launchCommand = launchCommand || this.pythonExecutable;
      launchArgs = launchArgs || ['-m', 'sidecar'];
      // Guard the command we are about to spawn, not just the resolved
      // interpreter -- they are the same in every production path today, and
      // checking the spawn target keeps them from silently diverging.
      if (!fs.existsSync(launchCommand)) {
        const failureDetail = describeMissingPythonInterpreter({
          pythonExecutable: launchCommand,
          repoRoot: this.repoRoot,
        });
        if (this.logger) {
          // Only the path that actually failed -- repoRoot adds no diagnostic
          // here and the state store already persists it.
          this.logger('ERROR', 'backend.sidecar_python_missing', {
            pythonExecutable: launchCommand,
          });
        }
        this._setStatus({
          phase: 'failed',
          detail: failureDetail,
          startupStage: 'python_missing',
          startupMs: this._getStartupElapsedMs(),
          progressLogCount: this.progressLogCount,
          launchSource,
          packagedLaunchDetail,
        });
        throw new Error(failureDetail);
      }
    }
    this.launchSource = launchSource;
    this.packagedLaunchDetail = packagedLaunchDetail;

    this._setStatus({
      phase: 'starting',
      baseUrl: MANAGED_SIDECAR_BASE_URL,
      attempts: 1,
      detail: 'Starting managed sidecar.',
      startupStage: 'launch_prepared',
      startupMs: this._getStartupElapsedMs(),
      progressLogCount: this.progressLogCount,
      launchSource,
      packagedLaunchDetail,
    });

    const spawnedProcess = this.spawnImpl(
      launchCommand,
      launchArgs,
      {
        cwd: this.repoRoot,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    this.process = spawnedProcess;

    spawnedProcess.stderr.on('data', (chunk) => this._appendLog(chunk));
    spawnedProcess.once('error', (error) => {
      if (this.process !== spawnedProcess) {
        return;
      }
      this.lastSpawnError = error instanceof Error ? error : new Error(String(error || 'Sidecar spawn failed.'));
      this.process = null;
      if (!this.isStopping && this.status.phase !== 'stopped') {
        this._setStatus({
          phase: 'failed',
          detail: `Backend failed to start (${this.lastSpawnError.message}).`,
          pid: 0,
          startupStage: 'spawn_error',
          startupMs: this._getStartupElapsedMs(),
          progressLogCount: this.progressLogCount,
          launchSource,
          packagedLaunchDetail,
        });
      }
    });
    spawnedProcess.once('exit', (code, signal) => {
      if (this.process !== spawnedProcess) {
        return;
      }
      for (const line of this.logDecoder.end()) this._appendDecodedLog(line);
      this.lastExitInfo = {
        code: code ?? null,
        signal: signal || 'none',
      };
      this.process = null;
      if (!this.isStopping && this.status.phase !== 'stopped') {
        this._setStatus({
          phase: 'failed',
          detail: `Backend exited before shutdown (code=${code ?? 'null'} signal=${signal || 'none'}).`,
          pid: 0,
          startupStage: 'spawn_exit',
          startupMs: this._getStartupElapsedMs(),
          progressLogCount: this.progressLogCount,
          launchSource,
          packagedLaunchDetail,
        });
      }
    });

    const currentPid = Number(spawnedProcess.pid || 0);
    if (currentPid > 0) {
      this.stateStore.write({
        pid: currentPid,
        baseUrl: MANAGED_SIDECAR_BASE_URL,
        command: [launchCommand, ...(launchArgs || [])].join(' '),
        repoRoot: this.repoRoot,
        sandboxRoot: this.sandboxLayout.rootPath,
        startedAt: new Date().toISOString(),
        launchSource,
        packagedLaunchDetail,
      });
    } else {
      this.stateStore.delete();
    }

    this._setStatus({
      pid: currentPid,
      startupStage: 'spawned',
      startupMs: this._getStartupElapsedMs(),
      launchSource,
      packagedLaunchDetail,
    });
    const startupExitGraceMs = Math.max(Math.min(this.startupSoftTimeoutMs || 0, 500), 200);
    await this._waitForSpawnSettle(startupExitGraceMs);
    if (this.lastSpawnError && !this.isStopping) {
      throw new Error(this.lastSpawnError.message);
    }
    if (this.lastExitInfo && !this.isStopping) {
      throw new Error(
        `Backend exited with code ${this.lastExitInfo.code ?? 'null'} signal=${this.lastExitInfo.signal}.`
      );
    }
    if (this.process && this.process.exitCode !== null) {
      throw new Error(`Backend exited with code ${this.process.exitCode}.`);
    }
    this._setStatus({
      phase: 'ready',
      baseUrl: MANAGED_SIDECAR_BASE_URL,
      detail: 'Managed sidecar process is ready.',
      pid: this.process && this.process.pid ? this.process.pid : 0,
      startupStage: 'spawned',
      startupMs: this._getStartupElapsedMs(),
      progressLogCount: this.progressLogCount,
      launchSource,
      packagedLaunchDetail,
    });
    return this.getStatus();
  }

  async cleanupStaleState() {
    const state = this.stateStore.read(null);
    if (!state || !state.pid) {
      this.stateStore.delete();
      return false;
    }

    const pid = Number(state.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      this.stateStore.delete();
      return false;
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      // ESRCH = process gone, EPERM = process exists but not ours — skip kill in both cases.
      void error;
      this.stateStore.delete();
      return false;
    }
    // The stored pid comes from a PREVIOUS app run: the OS may have recycled
    // it to an unrelated process. Only force-kill when the live process's
    // command line still matches the sidecar command we recorded at spawn.
    const verified = await this._verifyStoredSidecarIdentity(pid, state);
    if (!verified) {
      this._appendDecodedLog(
        `Skipped stale-state kill for pid ${pid}: live process does not match the stored sidecar command.`
      );
      this.stateStore.delete();
      return false;
    }
    await this.killProcessTreeImpl(pid, { force: true }).catch(() => null);
    this.stateStore.delete();
    return false;
  }

  async _verifyStoredSidecarIdentity(pid, state) {
    const storedCommand = String(state?.command || '').trim();
    if (!storedCommand) {
      // Legacy state files carry no command; identity cannot be confirmed.
      return false;
    }
    let commandLine;
    try {
      commandLine = String((await this.getProcessCommandLineImpl(pid)) || '');
    } catch (_error) {
      return false;
    }
    // Quote and whitespace shapes differ between our stored join and the
    // OS-reported command line. The genuine sidecar's command line contains
    // the exact command we launched it with.
    return processCommandMatchesStored(commandLine, storedCommand);
  }

  async stop({ gracefulDeadlineAt } = {}) {
    this.isStopping = true;
    const currentPid = this.process && this.process.pid ? this.process.pid : 0;
    const startedAt = this._now();
    const gracefulDeadline = Number.isFinite(Number(gracefulDeadlineAt))
      ? Number(gracefulDeadlineAt)
      : startedAt + this.gracefulStopTimeoutMs;
    let graceful = !currentPid;
    let forced = false;
    let exitConfirmed = !currentPid;

    try {
      if (currentPid) {
        this._setStatus({
          phase: 'stopping',
          detail: 'Stopping managed sidecar.',
        });
        this._endChildInput();
        const gracefulWaitStartedAt = this._now();
        graceful = await this._waitForProcessExit(
          Math.max(gracefulDeadline - gracefulWaitStartedAt, 0)
        );
        exitConfirmed = graceful;
        this._logShutdownStage('graceful_exit', graceful ? 'ok' : 'timeout', {
          durationMs: Math.max(this._now() - gracefulWaitStartedAt, 0),
          remainingBudgetMs: Math.max(gracefulDeadline - this._now(), 0),
          forced: false,
          confirmed: graceful,
        });
        if (!graceful) {
          forced = true;
          this._setStatus({
            phase: 'stopping',
            detail: 'Sidecar did not exit gracefully; forcing shutdown.',
          });
          const forceStartedAt = this._now();
          const killResult = await this._killProcessTreeForStop(currentPid, {
            force: true,
            confirmExit: true,
            timeoutMs: this.forcedStopTimeoutMs,
          });
          exitConfirmed = killResult === true;
          this._logShutdownStage('force_tree_kill', exitConfirmed ? 'ok' : 'unconfirmed', {
            durationMs: Math.max(this._now() - forceStartedAt, 0),
            remainingBudgetMs: 0,
            forced: true,
            confirmed: exitConfirmed,
          });
        }
      } else {
        await this.cleanupStaleState();
      }
    } finally {
      this.process = null;
      this.lastExitInfo = null;
      if (exitConfirmed) {
        this.stateStore.delete();
      }
      this._setStatus({
        phase: 'stopped',
        pid: 0,
        detail: exitConfirmed ? '' : 'Sidecar exit was not confirmed; emergency cleanup retained.',
      });
      this.isStopping = false;
    }
    const result = {
      pid: currentPid,
      graceful,
      forced,
      exitConfirmed,
      durationMs: Math.max(this._now() - startedAt, 0),
    };
    this._logShutdownStage('total', exitConfirmed ? 'ok' : 'unconfirmed', {
      durationMs: result.durationMs,
      remainingBudgetMs: Math.max(gracefulDeadline - this._now(), 0),
      forced,
      confirmed: exitConfirmed,
    });
    return result;
  }

  // Stdin EOF is the sidecar's only live tie to this process (see the module
  // docstring in sidecar/runtime/parent_watchdog.py), so closing the pipe is
  // what lets it exit on its own. The normal shutdown path closes it through
  // the sidecar client (requestSidecarShutdown -> endSidecarInput), but a stop
  // that runs with no client attached -- initialization failed before
  // ensureSidecarClientAttached, or a crash disposed it -- would otherwise
  // reach the graceful wait with the pipe still open, stall the full window,
  // and leave force-kill as the child's only exit. Idempotent: endSidecarInput
  // skips a pipe the client already ended.
  _endChildInput() {
    const child = this.process;
    if (!child || !child.stdin) {
      return false;
    }
    // A child that has already exited fails this write ASYNCHRONOUSLY. In the
    // client-less case nothing else is listening on the stream, so an unhandled
    // 'error' would take the process down mid-shutdown.
    if (typeof child.stdin.once === 'function') {
      child.stdin.once('error', () => {});
    }
    try {
      return endSidecarInput(child);
    } catch (_error) {
      return false;
    }
  }

  async _killProcessTreeForStop(pid, options) {
    try {
      const result = await this.killProcessTreeImpl(pid, options);
      return result?.terminated === true;
    } catch (_error) {
      return false;
    }
  }

  _logShutdownStage(stage, status, details = {}) {
    if (!this.logger) {
      return;
    }
    this.logger(status === 'ok' ? 'INFO' : 'WARN', 'backend.sidecar_shutdown_stage', {
      stage: String(stage || ''),
      status: String(status || ''),
      durationMs: Math.max(Number(details.durationMs) || 0, 0),
      remainingBudgetMs: Math.max(Number(details.remainingBudgetMs) || 0, 0),
      forced: details.forced === true,
      confirmed: details.confirmed === true,
    });
  }

  _getStartupElapsedMs() {
    if (!this.startupStartedAt) {
      return 0;
    }
    return Math.max(Date.now() - this.startupStartedAt, 0);
  }

  _appendLog(chunk) {
    const droppedBefore = this.logDecoder.droppedOversizedLines;
    for (const line of this.logDecoder.push(chunk)) this._appendDecodedLog(line);
    if (this.logDecoder.droppedOversizedLines > droppedBefore) {
      const droppedCount = this.logDecoder.droppedOversizedLines - droppedBefore;
      this._appendDecodedLog(JSON.stringify({
        level: 'WARN', layer: 'sidecar', component: 'sidecar.transport',
        event: 'sidecar.diagnostics.oversized_record',
        message: 'An oversized sidecar diagnostic record was discarded.',
        status: 'degraded', data: { dropped_count: droppedCount },
        redaction_mode: 'redacted', schema_version: 1,
      }));
    }
  }

  _appendDecodedLog(line) {
    const text = String(line || '').trim();
    if (!text) {
      return;
    }
    this.progressLogCount += 1;
    this.emit('log', text);
  }

  async _waitForProcessExit(timeoutMs) {
    if (!this.process) {
      return true;
    }
    if (this.process.exitCode != null) {
      return true;
    }
    if (typeof this.process.once !== 'function') {
      return false;
    }
    if (Number(timeoutMs) <= 0) {
      return false;
    }
    const observedProcess = this.process;
    return new Promise((resolve) => {
      let settled = false;
      const removeExitListener = () => {
        if (!observedProcess) {
          return;
        }
        if (typeof observedProcess.off === 'function') {
          observedProcess.off('exit', handleExit);
        } else if (typeof observedProcess.removeListener === 'function') {
          observedProcess.removeListener('exit', handleExit);
        }
      };
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        this._clearTimeout(timer);
        removeExitListener();
        resolve(value);
      };
      const handleExit = () => finish(true);
      const timer = this._setTimeout(() => finish(false), Math.max(Number(timeoutMs) || 0, 1));
      timer?.unref?.();
      observedProcess.once('exit', handleExit);
    });
  }

  // #23: Startup spawn-settle wait. Returns true if the process exits within the
  // grace (caller treats as a spawn failure), false if it survives -- resolving
  // EARLY on the first stderr byte (a healthy "process is running" signal) instead
  // of always burning the full 300-500ms grace. stderr is the log channel (already
  // consumed by _appendLog), never the stdout RPC channel, so listening here can't
  // steal handshake bytes. A process that emits-then-crashes is still caught by the
  // subsequent initialize handshake; the grace remains the worst-case ceiling.
  async _waitForSpawnSettle(timeoutMs) {
    if (!this.process) {
      return true;
    }
    if (this.process.exitCode != null) {
      return true;
    }
    if (typeof this.process.once !== 'function') {
      return false;
    }
    return new Promise((resolve) => {
      let settled = false;
      const stderr = this.process ? this.process.stderr : null;
      const cleanup = () => {
        this._clearTimeout(timer);
        if (this.process) {
          if (typeof this.process.off === 'function') {
            this.process.off('exit', handleExit);
          } else if (typeof this.process.removeListener === 'function') {
            this.process.removeListener('exit', handleExit);
          }
        }
        if (stderr && typeof stderr.off === 'function') {
          stderr.off('data', handleFirstByte);
        } else if (stderr && typeof stderr.removeListener === 'function') {
          stderr.removeListener('data', handleFirstByte);
        }
      };
      const finish = (exited) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(exited);
      };
      const handleExit = () => finish(true);
      const handleFirstByte = () => finish(false);
      const timer = this._setTimeout(() => finish(false), Math.max(Number(timeoutMs) || 0, 1));
      this.process.once('exit', handleExit);
      if (stderr && typeof stderr.on === 'function') {
        stderr.on('data', handleFirstByte);
      }
    });
  }
}

module.exports = {
  SIDECAR_ALLOWED_ENV,
  SidecarManager,
  describeMissingPythonInterpreter,
  resolvePythonExecutable,
  venvPythonRelativePath,
};
