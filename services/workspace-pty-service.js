/* services/workspace-pty-service.js - real ConPTY terminal for the Workspace
 * IDE terminal rail, behind the default-ON `workspace_pty_terminal` flag
 * (env `JENNY_ENABLE_WORKSPACE_PTY_TERMINAL=0` rolls back to the legacy line
 * terminal).
 * Unlike the piped WorkspaceTerminalService sibling, this drives an actual
 * pseudo-terminal via @lydell/node-pty (zero-toolchain prebuilds), so
 * interactive TUIs, colors, and line editing work. Single session, cwd pinned
 * to the tools workspace root, env scrubbed (credentials + JENNY_* feature
 * vars), byte-capped output forwarded over the bridge as workspacePty.onData /
 * onExit events.
 *
 * Flag posture: every public method short-circuits to {available:false} when
 * the flag is off, and - pinned invariant - the native module loader is NEVER
 * invoked while gated OR before the workspace root is confirmed, so a disabled
 * or rootless install never loads native code. Public methods return plain
 * structured results and never throw across the IPC seam; the loader failing
 * (missing prebuild / ABI mismatch) fails soft to MODULE_LOAD_FAILED.
 *
 * node-pty quirk: this package reports pid === 0; the IPty handle itself is
 * held in the registry and pid is never fed to any kill-tree helper. */

'use strict';

const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');
const { TERMINAL_ERROR_CODES } = require('./backend/error-codes');
const { createTerminalOutputQueue } = require('./workspace-terminal-output-queue');

const MAX_CHUNK_BYTES = 64 * 1024; // per onData event (matches piped sibling)
const MAX_WRITE_BYTES = 16 * 1024; // per write() call
const COLS_MIN = 2;
const COLS_MAX = 500;
const ROWS_MIN = 2;
const ROWS_MAX = 300;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERMINATION_TIMEOUT_MS = 2000;

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

function truncateUtf8(value, maxBytes) {
  const source = String(value ?? '');
  let bytes = 0;
  let end = 0;
  for (const codePoint of source) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return { text: source.slice(0, end), bytes };
}

class WorkspacePtyService {
  constructor({
    configService,
    featureFlagProvider,
    sendBridgeEvent,
    ptyModuleLoader = () => require('@lydell/node-pty'),
    env = process.env,
    logger = null,
    scheduleOutputFlush,
    cancelOutputFlush,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    terminationTimeoutMs = TERMINATION_TIMEOUT_MS,
  } = {}) {
    if (!configService) {
      throw new TypeError('WorkspacePtyService requires configService');
    }
    this._configService = configService;
    this._featureFlagProvider = typeof featureFlagProvider === 'function' ? featureFlagProvider : null;
    this._sendBridgeEvent = typeof sendBridgeEvent === 'function' ? sendBridgeEvent : () => {};
    this._ptyModuleLoader = typeof ptyModuleLoader === 'function' ? ptyModuleLoader : () => require('@lydell/node-pty');
    this._env = env;
    this._logger = typeof logger === 'function' ? logger : null;
    this._scheduleOutputFlush = scheduleOutputFlush;
    this._cancelOutputFlush = cancelOutputFlush;
    this._setTimeout = setTimeoutImpl;
    this._clearTimeout = clearTimeoutImpl;
    this._terminationTimeoutMs = clampInt(terminationTimeoutMs, 1, 30_000, TERMINATION_TIMEOUT_MS);
    this._ptyModule = null; // cached loaded module
    this._session = null; // { id, pty, shell, cwd }
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

  _enabled() {
    return this._featureFlagProvider?.()?.workspace_pty_terminal === true;
  }

  _requireRoot() {
    return String(this._configService.getToolsWorkspaceRoot?.() || '').trim();
  }

  // Lazy-load + cache the native module. Throws on loader failure; the caller
  // (spawn) catches and maps to MODULE_LOAD_FAILED.
  _loadPtyModule() {
    if (!this._ptyModule) {
      this._ptyModule = this._ptyModuleLoader();
    }
    return this._ptyModule;
  }

  _createOutputQueue(sessionId) {
    return createTerminalOutputQueue({
      maxEventBytes: MAX_CHUNK_BYTES,
      schedule: this._scheduleOutputFlush,
      cancel: this._cancelOutputFlush,
      emit: (_stream, data, droppedBytes) => {
        const payload = { sessionId, data };
        if (droppedBytes > 0) payload.droppedBytes = droppedBytes;
        try { this._sendBridgeEvent('workspacePty.onData', payload); } catch (_error) {
          this._log('WARN', 'workspace_pty.bridge_emit_failed', { event: 'data' });
        }
      },
      log: (droppedBytes) => this._log('WARN', 'workspace_pty.output_dropped', { dropped_bytes: droppedBytes }),
    });
  }

  _settleSession(session, info) {
    if (!session || session.settled) return false;
    session.settled = true;
    session.outputQueue.dispose({ flushPending: true });
    if (this._session === session) this._session = null;
    const { exitCode, signal } = info || {};
    try {
      this._sendBridgeEvent('workspacePty.onExit', {
        sessionId: session.id,
        exitCode: Number(exitCode ?? -1),
        signal: signal == null ? '' : String(signal),
      });
    } catch (_error) {
      this._log('WARN', 'workspace_pty.bridge_emit_failed', { event: 'exit' });
    } finally {
      session.resolveExit({ confirmed: true });
    }
    return true;
  }

  _wire(session) {
    const { pty } = session;
    pty.onExit((info) => this._settleSession(session, info));
    pty.onData((data) => {
      session.outputQueue.push('pty', data);
    });
  }

  async _waitForExit(session) {
    if (session.settled) return true;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = this._setTimeout(() => resolve({ confirmed: false }), this._terminationTimeoutMs);
      timer?.unref?.();
    });
    const outcome = await Promise.race([session.exitPromise, timeout]);
    if (timer !== null) this._clearTimeout(timer);
    return outcome?.confirmed === true;
  }

  async _terminateSession(session) {
    if (!session || session.settled) return true;
    if (session.terminationPromise) return session.terminationPromise;
    const termination = (async () => {
      try {
        session.pty.kill();
      } catch (error) {
        this._log('WARN', 'workspace_pty.kill_failed', { code: String(error?.code || 'unknown').slice(0, 40) });
        return false;
      }
      const confirmed = await this._waitForExit(session);
      if (!confirmed) this._log('WARN', 'workspace_pty.kill_unconfirmed', {});
      return confirmed;
    })();
    session.terminationPromise = termination;
    try {
      return await termination;
    } finally {
      if (!session.settled && session.terminationPromise === termination) session.terminationPromise = null;
    }
  }

  async spawn({ cols, rows } = {}) {
    if (this._disposed) {
      return {
        ok: false,
        available: this._enabled(),
        code: TERMINAL_ERROR_CODES.NO_SESSION,
        reason: 'disposed',
      };
    }
    // 1. Flag check FIRST - never touch the loader while gated.
    if (!this._enabled()) {
      return { available: false };
    }
    // 2. Root check BEFORE lazy load - a rootless spawn must not load native code.
    const cwd = this._requireRoot();
    if (!cwd) {
      return {
        ok: false,
        available: true,
        code: TERMINAL_ERROR_CODES.ROOT_MISSING,
        message: 'No workspace root is configured; choose a workspace folder first.',
      };
    }
    // 3. Single-session policy.
    if (this._session) {
      return {
        ok: true,
        available: true,
        alreadyRunning: true,
        sessionId: this._session.id,
      };
    }
    // 4. Lazy-load the native module - fail soft.
    let ptyModule;
    try {
      ptyModule = this._loadPtyModule();
    } catch (error) {
      this._log('WARN', 'workspace_pty.module_load_failed', {
        message: String(error?.message || error || ''),
      });
      return {
        ok: false,
        available: true,
        code: TERMINAL_ERROR_CODES.MODULE_LOAD_FAILED,
        message: 'The terminal engine could not be loaded.',
      };
    }

    const safeCols = clampInt(cols, COLS_MIN, COLS_MAX, DEFAULT_COLS);
    const safeRows = clampInt(rows, ROWS_MIN, ROWS_MAX, DEFAULT_ROWS);
    const spawnEnv = sanitizeSpawnEnv(this._env, { extraDeny: [/^JENNY_/i] });
    const opts = { cols: safeCols, rows: safeRows, cwd, env: spawnEnv };

    // 5. Shell candidates: win32 powershell -> cmd fallback; posix bash (-i).
    const candidates = process.platform === 'win32'
      ? [{ shell: 'powershell.exe', args: ['-NoProfile', '-NoLogo'] }, { shell: 'cmd.exe', args: [] }]
      : [{ shell: 'bash', args: ['-i'] }];

    let pty = null;
    let chosen = null;
    let lastError = null;
    for (const candidate of candidates) {
      try {
        pty = ptyModule.spawn(candidate.shell, candidate.args, opts);
        chosen = candidate.shell;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!pty) {
      this._log('WARN', 'workspace_pty.spawn_failed', {
        message: String(lastError?.message || lastError || ''),
      });
      return {
        ok: false,
        available: true,
        code: TERMINAL_ERROR_CODES.SPAWN_FAILED,
        message: `Could not start the terminal shell: ${String(lastError?.message || lastError || '')}`,
      };
    }

    // 6. Session id + registry (HOLD the IPty handle, never pty.pid).
    this._sessionCounter += 1;
    const id = `pty-${this._sessionCounter}`;
    let resolveExit;
    const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
    const session = {
      id, pty, shell: chosen, cwd, settled: false, resolveExit, exitPromise,
      outputQueue: this._createOutputQueue(id),
      terminationPromise: null,
    };
    this._session = session;
    // 7. Wire data/exit forwarding.
    try {
      this._wire(session);
    } catch (error) {
      this._log('WARN', 'workspace_pty.wire_failed', {
        message: String(error?.message || error || '').slice(0, 160),
      });
      const terminationConfirmed = await this._terminateSession(session);
      return {
        ok: false,
        available: true,
        code: TERMINAL_ERROR_CODES.SPAWN_FAILED,
        message: 'The terminal engine could not attach its event handlers.',
        terminationConfirmed,
      };
    }

    this._log('INFO', 'workspace_pty.started', { shell: chosen });
    return {
      ok: true,
      available: true,
      alreadyRunning: false,
      sessionId: id,
      shell: chosen,
      cwd,
    };
  }

  _sessionFor(sessionId) {
    const wanted = String(sessionId || '');
    if (!this._session || (wanted && this._session.id !== wanted)) {
      return null;
    }
    return this._session;
  }

  async write({ sessionId, data } = {}) {
    const session = this._sessionFor(sessionId);
    if (!session) {
      if (!this._enabled()) return { available: false };
      return { ok: false, code: TERMINAL_ERROR_CODES.NO_SESSION };
    }
    const { text, bytes } = truncateUtf8(data, MAX_WRITE_BYTES);
    try {
      session.pty.write(text);
    } catch (_error) {
      // A write racing the pty's own exit must not throw across the IPC seam.
      return { ok: false, code: TERMINAL_ERROR_CODES.NO_SESSION };
    }
    return { ok: true, written: bytes };
  }

  async resize({ sessionId, cols, rows } = {}) {
    const session = this._sessionFor(sessionId);
    if (!session) {
      if (!this._enabled()) return { available: false };
      return { ok: false, code: TERMINAL_ERROR_CODES.NO_SESSION };
    }
    const safeCols = clampInt(cols, COLS_MIN, COLS_MAX, DEFAULT_COLS);
    const safeRows = clampInt(rows, ROWS_MIN, ROWS_MAX, DEFAULT_ROWS);
    try {
      session.pty.resize(safeCols, safeRows);
    } catch (error) {
      return {
        ok: false,
        code: TERMINAL_ERROR_CODES.SPAWN_FAILED,
        message: `Could not resize the terminal: ${String(error?.message || error || '')}`,
      };
    }
    return { ok: true };
  }

  async kill({ sessionId } = {}) {
    const session = this._sessionFor(sessionId);
    if (!session) {
      if (!this._enabled()) return { available: false };
      return { ok: true, killed: false };
    }
    const terminationConfirmed = await this._terminateSession(session);
    if (!terminationConfirmed) {
      return {
        ok: false,
        killed: false,
        terminationConfirmed: false,
        code: TERMINAL_ERROR_CODES.SPAWN_FAILED,
      };
    }
    return { ok: true, killed: true, terminationConfirmed: true };
  }

  hasSession() {
    return Boolean(this._session);
  }

  // Coordinator participant signal; same ownership state as hasSession().
  isRunning() {
    return Boolean(this._session);
  }

  // Window close / app shutdown (will-quit guard): never orphan a pty, never throw.
  dispose() {
    this._disposed = true;
    if (!this._disposePromise) {
      this._disposePromise = (async () => {
        const session = this._session;
        if (!session) return { disposed: true, terminationConfirmed: true };
        const result = await this.kill({ sessionId: session.id });
        if (result.terminationConfirmed === true) {
          return { disposed: true, terminationConfirmed: true };
        }
        return {
          disposed: false,
          sessionId: session.id,
          terminationConfirmed: false,
          code: result.code || TERMINAL_ERROR_CODES.SPAWN_FAILED,
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
  WorkspacePtyService,
};
