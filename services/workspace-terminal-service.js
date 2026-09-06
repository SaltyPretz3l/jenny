/* services/workspace-terminal-service.js - integrated PowerShell session for
 * the Workspace IDE terminal rail panel. Piped child_process stdio (NOT a
 * PTY: zero native deps - node-pty would require an electron-rebuild
 * pipeline the project does not have). Single session, cwd pinned to the
 * tools workspace root, env scrubbed (credentials + JENNY_* feature vars),
 * byte-capped output forwarded over the bridge as workspaceTerminal.onData /
 * onExit events. "signal" (Ctrl+C) kills the process tree and reports the
 * exit - piped stdio cannot deliver a real CTRL_C_EVENT portably. */

const { spawn } = require('child_process');

const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');
const { killProcessTree } = require('./backend/process-utils');
const { TERMINAL_ERROR_CODES } = require('./backend/error-codes');
const { createTerminalOutputQueue } = require('./workspace-terminal-output-queue');

const MAX_CHUNK_BYTES = 64 * 1024; // per onData event
const MAX_WRITE_BYTES = 16 * 1024; // per write() call

class WorkspaceTerminalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceTerminalError';
    this.code = code;
    this.error_code = code;
  }
}

class WorkspaceTerminalService {
  constructor({
    configService,
    sendBridgeEvent,
    spawnImpl = spawn,
    killTreeImpl = (pid) => killProcessTree(pid, { force: true, confirmExit: true }),
    env = process.env,
    logger = null,
    scheduleOutputFlush,
    cancelOutputFlush,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    writeDrainTimeoutMs = 2000,
  } = {}) {
    if (!configService) {
      throw new TypeError('WorkspaceTerminalService requires configService');
    }
    this._configService = configService;
    this._sendBridgeEvent = typeof sendBridgeEvent === 'function' ? sendBridgeEvent : () => {};
    this._spawn = spawnImpl;
    this._killTree = killTreeImpl;
    this._env = env;
    this._logger = typeof logger === 'function' ? logger : null;
    this._scheduleOutputFlush = scheduleOutputFlush;
    this._cancelOutputFlush = cancelOutputFlush;
    this._setTimeout = setTimeoutImpl;
    this._clearTimeout = clearTimeoutImpl;
    this._writeDrainTimeoutMs = Math.max(1, Math.min(Math.trunc(Number(writeDrainTimeoutMs)) || 2000, 30_000));
    this._session = null; // { id, child, shell, cwd }
    this._sessionCounter = 0;
    this._disposed = false;
    this._disposePromise = null;
  }

  _log(level, event, details = {}) {
    if (this._logger) {
      try {
        this._logger(level, event, details);
      } catch (_error) {
        /* logging must never break the terminal */
      }
    }
  }

  _requireRoot() {
    const root = String(this._configService.getToolsWorkspaceRoot?.() || '').trim();
    if (!root) {
      throw new WorkspaceTerminalError(
        TERMINAL_ERROR_CODES.ROOT_MISSING,
        'No workspace root is configured; choose a workspace folder first.'
      );
    }
    return root;
  }

  _createOutputQueue(sessionId) {
    return createTerminalOutputQueue({
      maxEventBytes: MAX_CHUNK_BYTES,
      schedule: this._scheduleOutputFlush,
      cancel: this._cancelOutputFlush,
      emit: (stream, chunk, droppedBytes) => {
        const payload = { sessionId, stream, chunk };
        if (droppedBytes > 0) payload.droppedBytes = droppedBytes;
        try { this._sendBridgeEvent('workspaceTerminal.onData', payload); } catch (_error) {
          this._log('WARN', 'workspace_terminal.bridge_emit_failed', { event: 'data' });
        }
      },
      log: (droppedBytes) => this._log('WARN', 'workspace_terminal.output_dropped', { dropped_bytes: droppedBytes }),
    });
  }

  _settleSession(session, { code = null, signal = '', reason = '' } = {}) {
    if (!session || session.settled) return false;
    session.settled = true;
    session.outputQueue.dispose({ flushPending: true });
    if (this._session === session) this._session = null;
    const payload = { sessionId: session.id, code: code === null ? null : Number(code), signal: signal ? String(signal) : '' };
    if (reason) payload.reason = reason;
    try { this._sendBridgeEvent('workspaceTerminal.onExit', payload); } catch (_error) {
      this._log('WARN', 'workspace_terminal.bridge_emit_failed', { event: 'exit' });
    }
    return true;
  }

  async _terminateSession(session, settlement) {
    if (!session || session.settled) return true;
    if (session.terminationPromise) return session.terminationPromise;
    const termination = (async () => {
      try {
        const outcome = await this._killTree(session.child.pid);
        if (outcome?.terminated !== true) throw Object.assign(new Error('unconfirmed'), { code: 'unconfirmed' });
      } catch (error) {
        this._log('WARN', 'workspace_terminal.kill_failed', { code: String(error?.code || 'unknown').slice(0, 40) });
        return false;
      }
      this._settleSession(session, settlement);
      return true;
    })();
    session.terminationPromise = termination;
    try {
      return await termination;
    } finally {
      if (!session.settled && session.terminationPromise === termination) session.terminationPromise = null;
    }
  }

  hasSession() {
    return Boolean(this._session);
  }

  // Starts (or returns) THE session - single session policy for v1; restart
  // is kill + start from the renderer.
  async start() {
    if (this._disposed) {
      throw new WorkspaceTerminalError(
        TERMINAL_ERROR_CODES.NO_SESSION,
        'The terminal service has been disposed.'
      );
    }
    if (this._session) {
      return {
        sessionId: this._session.id,
        shell: this._session.shell,
        cwd: this._session.cwd,
        alreadyRunning: true,
      };
    }
    const cwd = this._requireRoot();
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const args = process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-Command', '-']
      : ['-i'];
    let child;
    try {
      child = this._spawn(shell, args, {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // JENNY_* feature-flag env must not leak into a user-visible shell.
        env: sanitizeSpawnEnv(this._env, { extraDeny: [/^JENNY_/i] }),
      });
    } catch (error) {
      throw new WorkspaceTerminalError(
        TERMINAL_ERROR_CODES.SPAWN_FAILED,
        `Could not start ${shell}: ${String(error?.message || error)}`
      );
    }
    if (!child || typeof child.on !== 'function') {
      throw new WorkspaceTerminalError(
        TERMINAL_ERROR_CODES.SPAWN_FAILED,
        `Could not start ${shell}.`
      );
    }
    this._sessionCounter += 1;
    const id = `term-${this._sessionCounter}`;
    const session = {
      id, child, shell, cwd, settled: false,
      outputQueue: this._createOutputQueue(id),
      writeTail: Promise.resolve(),
      terminationPromise: null,
    };
    this._session = session;

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => session.outputQueue.push('stdout', chunk));
    child.stderr?.on?.('data', (chunk) => session.outputQueue.push('stderr', chunk));
    child.on('error', (error) => {
      this._log('WARN', 'workspace_terminal.child_error', { code: String(error?.code || 'unknown').slice(0, 40) });
      session.outputQueue.push('stderr', '\n[terminal] The terminal process failed.\n');
      void this._terminateSession(session, { reason: 'child_error' });
    });
    child.on('exit', (code, signal) => {
      this._settleSession(session, { code, signal });
    });
    this._log('INFO', 'workspace_terminal.started', { shell });
    return { sessionId: id, shell, cwd, alreadyRunning: false };
  }

  _requireSession(sessionId) {
    const wanted = String(sessionId || '');
    if (!this._session || (wanted && this._session.id !== wanted)) {
      throw new WorkspaceTerminalError(
        TERMINAL_ERROR_CODES.NO_SESSION,
        'No terminal session is running.'
      );
    }
    return this._session;
  }

  async write({ sessionId, data } = {}) {
    const session = this._requireSession(sessionId);
    const text = String(data ?? '').slice(0, MAX_WRITE_BYTES);
    if (!text) {
      return { written: 0 };
    }
    const writeNow = async () => {
      if (this._session !== session || session.settled) this._requireSession(sessionId);
      const stdin = session.child.stdin;
      if (!stdin || typeof stdin.write !== 'function') this._requireSession('__missing_stdin__');
      let accepted;
      try {
        accepted = stdin.write(text);
      } catch (error) {
        this._log('WARN', 'workspace_terminal.stdin_error', { code: String(error?.code || 'unknown').slice(0, 40) });
        throw new WorkspaceTerminalError(TERMINAL_ERROR_CODES.NO_SESSION, 'The terminal input stream is unavailable.');
      }
      if (accepted === false && typeof stdin.once === 'function') {
        await new Promise((resolve, reject) => {
          let timer = null;
          const cleanup = () => {
            if (timer !== null) this._clearTimeout(timer);
            stdin.removeListener?.('drain', onDrain);
            stdin.removeListener?.('error', onError);
            stdin.removeListener?.('close', onClose);
          };
          const onDrain = () => { cleanup(); resolve(); };
          const onError = (error) => {
            cleanup();
            this._log('WARN', 'workspace_terminal.stdin_error', { code: String(error?.code || 'unknown').slice(0, 40) });
            reject(new WorkspaceTerminalError(TERMINAL_ERROR_CODES.NO_SESSION, 'The terminal input stream is unavailable.'));
          };
          const onClose = () => onError({ code: 'closed' });
          stdin.once('drain', onDrain);
          stdin.once('error', onError);
          stdin.once('close', onClose);
          timer = this._setTimeout(() => {
            cleanup();
            this._log('WARN', 'workspace_terminal.stdin_backpressure_timeout', {});
            reject(new WorkspaceTerminalError(TERMINAL_ERROR_CODES.NO_SESSION, 'The terminal input stream did not become writable.'));
          }, this._writeDrainTimeoutMs);
          timer?.unref?.();
        });
      }
      return { written: text.length };
    };
    session.writeTail = session.writeTail.then(writeNow, writeNow);
    return session.writeTail;
  }

  // "Ctrl+C" for piped stdio: kill the tree; the exit event drives the
  // renderer's visible "session ended" line. PowerShell children (npm, git)
  // would otherwise orphan, hence the tree kill.
  async signal({ sessionId } = {}) {
    const session = this._requireSession(sessionId);
    const terminated = await this._terminateSession(session, { signal: 'SIGTERM', reason: 'signaled' });
    if (!terminated) {
      return { signaled: false, terminationConfirmed: false, reason: 'kill_failed' };
    }
    return { signaled: true, terminationConfirmed: true };
  }

  async kill({ sessionId } = {}) {
    const wanted = String(sessionId || '');
    const session = this._session;
    if (!session || (wanted && session.id !== wanted)) {
      return { killed: false };
    }
    const terminated = await this._terminateSession(session, { signal: 'SIGKILL', reason: 'killed' });
    if (!terminated) {
      return { killed: false, terminationConfirmed: false, reason: 'kill_failed' };
    }
    return { killed: true, terminationConfirmed: true };
  }

  // Window close / app shutdown: never orphan a PowerShell tree.
  dispose() {
    this._disposed = true;
    if (!this._disposePromise) {
      this._disposePromise = (async () => {
        const session = this._session;
        if (!session) return { disposed: true, terminationConfirmed: true };
        const result = await this.kill({ sessionId: session.id });
        return {
          disposed: result.killed === true,
          terminationConfirmed: result.terminationConfirmed === true,
          ...(result.reason ? { reason: result.reason } : {}),
        };
      })();
      void this._disposePromise.then((result) => {
        if (!result.disposed) this._disposePromise = null;
      });
    }
    return this._disposePromise;
  }
}

module.exports = {
  WorkspaceTerminalService,
};
