const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const { sanitizeSpawnEnv } = require('./sanitize-spawn-env');
const { FileJsonStore } = require('./file-json-store');
const {
  isProcessAlive,
  killProcessTree,
  waitForProcessExit,
} = require('./process-utils');

const VLLM_ALLOWED_ENV = [/^VLLM_/i, /^CUDA_/i, /^HF_/i, /^HUGGING_FACE_HUB_/i, /^TRANSFORMERS_/i, /^TORCH_/i, /^NCCL_/i, /^PYTHONPATH$/i, /^PYTHONHOME$/i];

const VLLM_PORT = 8000;
const VLLM_HOST = '127.0.0.1';
// F12c: readiness is now an HTTP identity probe (GET /v1/models), not a bare
// TCP connect, so the round trip needs more headroom than a socket handshake.
const HEALTH_TIMEOUT_MS = 1500;
const HEALTH_BODY_MAX_BYTES = 1024 * 1024;
const STARTUP_POLL_MS = 2000;
const STARTUP_MAX_WAIT_MS = 180000; // 3 minutes — vLLM loads the model into GPU at startup
const STOP_GRACE_MS = 5000;
const MANAGED_NETWORK_FLAGS = new Set(['--host', '--port', '--uds', '--config']);

// vLLM v0.11.1 verified 2026-04-19: parser names live in
// vllm/reasoning/__init__.py (_REASONING_PARSERS_TO_REGISTER['qwen3']) and
// vllm/entrypoints/openai/tool_parsers/__init__.py (_TOOL_PARSERS_TO_REGISTER['qwen3_coder']).
// If a future vLLM release renames these, also update sidecar/ai/app_profiles/qwen36.py.
function buildVllmLaunchArgs({
  model,
  port,
  maxModelLen,
  reasoningParser,
  toolCallParser,
  enableAutoToolChoice,
  extraArgs,
} = {}) {
  const normalizedModel = String(model || '').trim();
  if (!normalizedModel) {
    throw new Error('buildVllmLaunchArgs: model is required');
  }
  const resolvedPort = Number.isFinite(port) && port > 0 ? Math.trunc(port) : VLLM_PORT;
  const argv = ['serve', normalizedModel, '--host', VLLM_HOST, '--port', String(resolvedPort)];

  if (maxModelLen !== undefined && maxModelLen !== null && maxModelLen !== '') {
    const n = Number(maxModelLen);
    if (!Number.isFinite(n) || n <= 0 || Math.trunc(n) !== n) {
      throw new Error(`buildVllmLaunchArgs: maxModelLen must be a positive integer (got ${maxModelLen})`);
    }
    argv.push('--max-model-len', String(n));
  }

  if (reasoningParser) {
    const rp = String(reasoningParser).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(rp)) {
      throw new Error(`buildVllmLaunchArgs: reasoningParser has invalid characters (got ${rp})`);
    }
    argv.push('--reasoning-parser', rp);
  }

  if (toolCallParser) {
    const tp = String(toolCallParser).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(tp)) {
      throw new Error(`buildVllmLaunchArgs: toolCallParser has invalid characters (got ${tp})`);
    }
    argv.push('--tool-call-parser', tp);
  }

  if (enableAutoToolChoice) {
    argv.push('--enable-auto-tool-choice');
  }

  if (Array.isArray(extraArgs)) {
    for (const raw of extraArgs) {
      if (typeof raw !== 'string') {
        throw new Error('buildVllmLaunchArgs: extraArgs entries must be strings');
      }
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (/[\r\n\0]/.test(trimmed)) {
        throw new Error('buildVllmLaunchArgs: extraArgs entries must not contain newline or NUL');
      }
      const flagName = trimmed.split('=', 1)[0];
      if (MANAGED_NETWORK_FLAGS.has(flagName)) {
        throw new Error(`buildVllmLaunchArgs: ${flagName} is managed by Jenny and cannot be set in extraArgs`);
      }
      argv.push(trimmed);
    }
  } else if (extraArgs !== undefined && extraArgs !== null) {
    throw new Error('buildVllmLaunchArgs: extraArgs must be an array of strings');
  }

  return argv;
}

class VLLMProcessManager {
  constructor({
    logger,
    model,
    port,
    launchArgs,
    userDataPath,
    stateStore,
    platform,
    spawnImpl,
    killProcessTreeImpl,
    isProcessAliveImpl,
    waitForProcessExitImpl,
    pidMatchesVllmImpl,
  } = {}) {
    this._process = null;
    this._ownedProcess = false;
    this._ownedPid = 0;
    this._log = logger || (() => {});
    this._model = model || '';
    this._port = port || VLLM_PORT;
    this._launchArgs = launchArgs && typeof launchArgs === 'object' ? { ...launchArgs } : {};
    this._platform = platform || process.platform;
    this._spawn = spawnImpl || spawn;
    this._killProcessTree = killProcessTreeImpl || killProcessTree;
    this._isProcessAlive = isProcessAliveImpl || isProcessAlive;
    this._waitForProcessExit = waitForProcessExitImpl || waitForProcessExit;
    this._pidMatchesVllmImpl = pidMatchesVllmImpl || null;
    this._stateStore = stateStore || (
      userDataPath
        ? new FileJsonStore(path.join(userDataPath, 'vllm-process.json'))
        : null
    );
  }

  async start() {
    const ownership = this._readOwnedState();
    if (ownership) {
      const alive = this._isProcessAlive(ownership.pid);
      if (alive && this._pidMatchesVllm(ownership.pid)) {
        this._log('INFO', 'vllm.killing_stale_owned_process', { pid: ownership.pid });
        const killOutcome = await this._killProcessTree(ownership.pid, { force: true })
          .catch(() => ({ terminated: false }));
        const exited = await this._waitForProcessExit(ownership.pid, STOP_GRACE_MS)
          .catch(() => false);
        if (exited !== true) {
          this._log('WARN', 'vllm.stale_owned_process_exit_unconfirmed', {
            pid: ownership.pid,
            killTerminated: killOutcome?.terminated === true,
            retained: true,
            message: 'Stale vLLM exit was not confirmed; ownership is retained and replacement startup is aborted.',
          });
          return { started: false, external: false };
        }
      } else {
        this._log('INFO', 'vllm.stale_owned_process_state_cleared', { pid: ownership.pid, alive });
      }
      this._clearOwnedState();
    }

    if (await this._isRunning()) {
      // F12c: something answers an OpenAI-shaped /v1/models on our port. Only
      // adopt it when it actually serves the model we were configured for —
      // otherwise it is a stranger and must NOT be reported as ready.
      const adoption = await this._confirmExternalServesModel();
      if (!adoption.ok) {
        this._log('WARN', 'vllm.port_occupied_by_other_service', {
          port: this._port,
          model: this._model,
          servedModels: adoption.servedModels.slice(0, 10),
          message: 'Port is held by a service that does not serve the configured model; not adopting it.',
        });
        this._ownedProcess = false;
        this._ownedPid = 0;
        return { started: false, external: false };
      }
      this._log('INFO', 'vllm.already_running', { port: this._port });
      this._ownedProcess = false;
      this._ownedPid = 0;
      return { started: false, external: true };
    }

    if (!this._model) {
      this._log('WARN', 'vllm.no_model', {
        message: 'No model configured for vLLM; skipping auto-start',
      });
      return { started: false, external: false };
    }

    const command = await this._resolveCommand();
    if (!command) {
      this._log('WARN', 'vllm.not_found', {
        message: 'vllm executable not found on PATH; skipping auto-start',
      });
      return { started: false, external: false };
    }

    let argv;
    try {
      argv = this._buildArgv();
    } catch (error) {
      this._log('ERROR', 'vllm.launch_args_invalid', { message: String(error.message || error) });
      return { started: false, external: false };
    }

    this._log('INFO', 'vllm.starting', { command, model: this._model, port: this._port });
    this._process = this._spawnProcess(command, argv);
    const launchedProcess = this._process;
    this._ownedProcess = true;
    this._ownedPid = Number(this._process && this._process.pid) || 0;
    this._writeOwnedState({
      pid: this._ownedPid,
      command,
      port: this._port,
      model: this._model,
      startedAt: new Date().toISOString(),
      app_owned: true,
    });
    this._stderrTail = '';

    if (this._process.stderr) {
      this._process.stderr.on('data', (chunk) => {
        this._stderrTail += String(chunk);
        if (this._stderrTail.length > 4096) {
          this._stderrTail = this._stderrTail.slice(-2048);
        }
      });
    }

    let resolveLaunchFailure;
    const launchFailure = new Promise((resolve) => { resolveLaunchFailure = resolve; });

    launchedProcess.on('error', (error) => {
      this._log('ERROR', 'vllm.spawn_error', { message: String(error.message || error) });
      this._resetOwnership();
      resolveLaunchFailure({ reason: 'spawn_error' });
    });

    launchedProcess.on('exit', (code, signal) => {
      this._log('INFO', 'vllm.exited', { code, signal });
      this._resetOwnership();
      resolveLaunchFailure({
        reason: 'early_exit',
        code: Number.isInteger(code) ? code : null,
        signal: signal ? String(signal).slice(0, 32) : null,
      });
    });

    const startup = await Promise.race([
      this._waitForReady().then((ready) => ({ ready })),
      launchFailure,
    ]);
    if (startup.reason) {
      this._log('WARN', 'vllm.launch_failed', {
        reason: startup.reason,
        code: startup.code ?? null,
        signal: startup.signal ?? null,
        message: 'vLLM exited before readiness was confirmed.',
      });
      return { started: false, external: false };
    }
    const ready = startup.ready;
    if (!ready) {
      const stderr = (this._stderrTail || '').trim();
      this._log('WARN', 'vllm.startup_timeout', {
        message: `vLLM did not become ready within ${STARTUP_MAX_WAIT_MS}ms`,
        stderr: stderr ? stderr.slice(-512) : undefined,
      });
      return { started: false, external: false };
    }

    this._log('INFO', 'vllm.started', { pid: launchedProcess.pid, model: this._model });
    return { started: true, external: false };
  }

  async stop() {
    if (!this._ownedProcess || !this._process) {
      return;
    }

    const proc = this._process;
    const pid = Number(proc.pid) || 0;
    this._log('INFO', 'vllm.stopping', { pid });

    // F2d: drop only the LIVE handle before killing; the on-disk ownership
    // record survives until the exit is confirmed, so a failed kill leaves a
    // record the next launch's stale-state sweep can reap.
    this._process = null;
    this._ownedProcess = false;
    this._ownedPid = 0;

    let exited = false;
    const exitPromise = new Promise((resolve) => {
      proc.once('exit', () => {
        exited = true;
        resolve();
      });
    });

    try {
      proc.kill('SIGTERM');
    } catch (_error) {
      // best effort
    }

    await Promise.race([
      exitPromise,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, STOP_GRACE_MS);
        timer?.unref?.();
      }),
    ]);

    if (!exited) {
      // F2d: proc.kill('SIGKILL') only signals the direct child. On win32 the
      // vLLM worker subprocesses are not in that set at all, so escalate
      // through the injected tree-kill and then VERIFY before claiming a stop.
      await this._killProcessTree(pid, { force: true }).catch(() => null);
      exited = await this._waitForProcessExit(pid, STOP_GRACE_MS).catch(() => false);
    }

    if (exited) {
      this._clearOwnedState();
      this._log('INFO', 'vllm.stopped', { pid, confirmed: true });
      return;
    }
    this._log('WARN', 'vllm.stopped', {
      pid,
      confirmed: false,
      retained: true,
      message: 'vLLM exit was not confirmed; the owned-state record is retained so the next launch can reap it.',
    });
  }

  /** Update the model used for auto-start (before calling start()). */
  setModel(model) {
    this._model = model || '';
  }

  /** Update launch-args partial (before calling start()). */
  setLaunchArgs(partial) {
    this._launchArgs = partial && typeof partial === 'object' ? { ...partial } : {};
  }

  // F12a: single entry point used by the lifecycle just before start(), so the
  // manager picks up live config (port + launch args + current model) instead
  // of the construction-time snapshot the constructor captured at boot. Each
  // field is optional: an absent/invalid value leaves the current setting.
  configure({ model, port, launchArgs } = {}) {
    const normalizedModel = String(model || '').trim();
    if (normalizedModel) {
      this.setModel(normalizedModel);
    }
    const normalizedPort = Number(port);
    if (Number.isFinite(normalizedPort) && normalizedPort > 0 && normalizedPort <= 65535) {
      this._port = Math.trunc(normalizedPort);
    }
    if (launchArgs && typeof launchArgs === 'object' && !Array.isArray(launchArgs)) {
      this.setLaunchArgs(launchArgs);
    }
  }

  _buildArgv() {
    return buildVllmLaunchArgs({
      model: this._model,
      port: this._port,
      maxModelLen: this._launchArgs.maxModelLen,
      reasoningParser: this._launchArgs.reasoningParser,
      toolCallParser: this._launchArgs.toolCallParser,
      enableAutoToolChoice: this._launchArgs.enableAutoToolChoice,
      extraArgs: this._launchArgs.extraArgs,
    });
  }

  _spawnProcess(command, argv) {
    return this._spawn(command, argv, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
      windowsHide: true,
      env: sanitizeSpawnEnv(process.env, { allow: VLLM_ALLOWED_ENV }),
    });
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
      port: Number(state.port) || null,
      model: String(state.model || '').trim(),
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
  }

  _resetOwnership() {
    this._process = null;
    this._ownedProcess = false;
    this._ownedPid = 0;
    this._clearOwnedState();
  }

  _pidMatchesVllm(pid) {
    if (this._pidMatchesVllmImpl) {
      return Boolean(this._pidMatchesVllmImpl(pid, { platform: this._platform }));
    }
    const normalizedPid = Number(pid);
    if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
      return false;
    }
    try {
      const { execFileSync } = require('child_process');
      let commandLine = '';
      if (this._platform === 'win32') {
        try {
          const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${normalizedPid}" | Select-Object -ExpandProperty CommandLine`;
          commandLine = String(execFileSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { encoding: 'utf-8', timeout: 3000, windowsHide: true },
          ) || '').trim();
        } catch (_error) {
          try {
            commandLine = String(execFileSync(
              'wmic',
              ['process', 'where', `ProcessId=${normalizedPid}`, 'get', 'CommandLine', '/format:value'],
              { encoding: 'utf-8', timeout: 3000, windowsHide: true },
            ) || '').trim();
          } catch (_error2) {
            return false;
          }
        }
      } else {
        commandLine = String(execFileSync(
          'ps',
          ['-p', String(normalizedPid), '-o', 'args='],
          { encoding: 'utf-8', timeout: 3000 },
        ) || '').trim();
      }
      return /\bvllm\b/i.test(commandLine);
    } catch (_error) {
      return false;
    }
  }

  // Memoize the asynchronous PATH lookup so a missing vLLM executable never blocks the main thread.
  _resolveCommand() {
    if (!this._resolveCommandPromise) {
      this._resolveCommandPromise = new Promise((resolve) => {
        const { execFile } = require('child_process');
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        execFile(cmd, ['vllm'], { encoding: 'utf-8', timeout: 3000, windowsHide: true }, (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const first = String(stdout || '').split(/\r?\n/)[0].trim();
          resolve(first || null);
        });
      });
    }
    return this._resolveCommandPromise;
  }

  // F12c: identity probe, modelled on OllamaProcessManager._isRunning. A bare
  // TCP connect treats ANY listener on port 8000 (a very common dev-server
  // port) as a ready vLLM, after which the sidecar posts OpenAI-format chat to
  // an unrelated service. Require a 2xx /v1/models response whose payload
  // carries the OpenAI model-list shape.
  async _probeServedModels() {
    return new Promise((resolve) => {
      const url = `http://${VLLM_HOST}:${this._port}/v1/models`;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const request = http.get(url, { timeout: HEALTH_TIMEOUT_MS }, (response) => {
          const statusCode = response.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            response.resume();
            finish(null);
            return;
          }
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += String(chunk || '');
            if (body.length > HEALTH_BODY_MAX_BYTES) {
              request.destroy();
              finish(null);
            }
          });
          response.on('end', () => {
            try {
              const payload = JSON.parse(body);
              if (!payload || !Array.isArray(payload.data)) {
                finish(null);
                return;
              }
              finish(payload.data
                .map((entry) => String((entry && entry.id) || '').trim())
                .filter(Boolean));
            } catch (_error) {
              finish(null);
            }
          });
        });
        request.on('timeout', () => {
          request.destroy();
          finish(null);
        });
        request.on('error', () => finish(null));
      } catch (_error) {
        finish(null);
      }
    });
  }

  async _isRunning() {
    return Array.isArray(await this._probeServedModels());
  }

  // Adoption gate for an externally-held port. No configured model means there
  // is nothing to match against, so any healthy OpenAI-compatible listener is
  // accepted (the pre-existing behavior).
  async _confirmExternalServesModel() {
    if (!this._model) {
      return { ok: true, servedModels: [] };
    }
    const servedModels = await this._probeServedModels();
    if (!Array.isArray(servedModels) || !servedModels.includes(this._model)) {
      return { ok: false, servedModels: Array.isArray(servedModels) ? servedModels : [] };
    }
    return { ok: true, servedModels };
  }

  async _waitForReady() {
    const launched = this._process;
    const deadline = Date.now() + STARTUP_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this._isRunning()) return true;
      // The launched child already exited (its exit handler reset ownership):
      // stop polling instead of probing health for the full window.
      if (launched && this._process !== launched) return false;
      await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
    }
    return false;
  }
}

module.exports = { VLLMProcessManager, buildVllmLaunchArgs };
