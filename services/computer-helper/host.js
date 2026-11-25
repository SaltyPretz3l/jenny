'use strict';

// The one jenny-computer helper host in Electron's main process: starts the
// native helper with `--serve`, checks `hello`, sends requests, routes replies
// and events (native/jenny-computer/PROTOCOL.md) and restarts after a crash on
// the next request, up to a limit. The live run view (197) and computer use
// (196) share it. It forwards any op the protocol names; the only per-op code
// is bookkeeping of which runs are alive.

const { spawn: nodeSpawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const protocol = require('./protocol');
const { resolveHelperBinary } = require('./helper-binary');

const STDERR_TAIL_BYTES = 64 * 1024;
const STDERR_PARTIAL_MAX = 4096;
const LOG_LINE_MAX = 500;
const KILL_WAIT_MS = 2000;
const RUN_STOP_EXTRA_MS = 8000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2000;
const NAMED_EVENTS = new Set(['run.window', 'run.window_state', 'run.exited']);
const HELPER_LOG_LEVELS = new Set(['info', 'warn', 'error']);
const NOOP = () => {};
const SILENT = { debug: NOOP, info: NOOP, warn: NOOP, error: NOOP };

function hostError(code, message, reason) {
  const error = Object.assign(new Error(message || code), { code });
  if (reason) error.reason = reason;
  return error;
}

function bound(text) {
  const line = String(text);
  return line.length > LOG_LINE_MAX ? `${line.slice(0, LOG_LINE_MAX)}...` : line;
}

// The last `limit` bytes of stderr, and each complete line handed to `onLine`.
function createStderrTail(limit, onLine) {
  let tail = Buffer.alloc(0);
  let partial = '';
  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      const joined = Buffer.concat([tail, bytes]);
      tail = joined.length > limit ? Buffer.from(joined.subarray(joined.length - limit)) : joined;
      partial += bytes.toString('utf8');
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) onLine(line.replace(/\r$/u, ''));
      if (partial.length > STDERR_PARTIAL_MAX) {
        onLine(partial);
        partial = '';
      }
    },
    text: () => tail.toString('utf8'),
  };
}

function settings(options) {
  return {
    command: options.command,
    args: Array.isArray(options.args) ? options.args : ['--serve'],
    env: options.env ?? process.env,
    spawn: options.spawn ?? nodeSpawn,
    logger: options.logger ?? SILENT,
    now: options.now ?? Date.now,
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
    requestTimeoutMs: options.requestTimeoutMs ?? 10000,
    helloTimeoutMs: options.helloTimeoutMs ?? 5000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 6000,
    maxRestarts: options.maxRestarts ?? 3,
    restartWindowMs: options.restartWindowMs ?? 60000,
  };
}

class ComputerHelperHost extends EventEmitter {
  constructor(options = {}) {
    super();
    this.opts = settings(options);
    this._state = 'stopped';
    this._entry = null;
    this._startPromise = null;
    this._lastUnavailable = null;
    this._stopPromise = null;
    this._pending = new Map();
    this._nextId = 1;
    this._restartTimes = [];
    this._restarts = 0;
    this._badLines = 0;
    this._runIds = new Set();
    this._stderr = createStderrTail(STDERR_TAIL_BYTES, (line) => {
      if (line !== '') this.opts.logger.debug(`jenny-computer stderr: ${bound(line)}`);
    });
  }

  state() { return this._state; }

  pid() { return this._entry?.child?.pid ?? null; }

  activeRunIds() { return [...this._runIds]; }

  stderrTail() { return this._stderr.text(); }

  stats() { return { badLines: this._badLines, restarts: this._restarts }; }

  /** Forget a sticky `unavailable` and the restart count, so the next request tries again. */
  reset() {
    this._restartTimes = [];
    if (this._state !== 'unavailable') return;
    this._lastUnavailable = null;
    this._setState('stopped');
  }

  start() {
    if (this._startPromise) return this._startPromise;
    if (this._state === 'unavailable') return Promise.resolve(this._lastUnavailable);
    if (this._stopPromise) return Promise.resolve({ available: false, reason: 'stopping' });
    const attempt = this._doStart().then((result) => {
      if (!result.available && this._startPromise === attempt) this._startPromise = null;
      return result;
    });
    this._startPromise = attempt;
    return attempt;
  }

  async request(op, args = {}, { timeoutMs } = {}) {
    if (op === 'shutdown') throw hostError('bad_request', 'shutdown belongs to stop()');
    try { protocol.encodeRequest(0, op, args); } catch (error) { throw hostError('bad_request', error.message); }
    await this._ensureReady();
    return this._send(op, args, this._timeoutFor(op, args, timeoutMs));
  }

  /** Asks the helper to shut down, waits for it, then ends the child this host spawned. Never rejects. */
  stop() {
    if (!this._stopPromise) {
      this._stopPromise = this._doStop().finally(() => { this._stopPromise = null; });
    }
    return this._stopPromise;
  }

  // --- start -------------------------------------------------------------

  async _doStart() {
    const command = this.opts.command === undefined ? resolveHelperBinary() : this.opts.command;
    if (!command) return this._unavailable('not_installed');
    this._setState('starting');
    const entry = this._spawnEntry(command);
    if (!entry) return this._unavailable('start_failed');
    let hello;
    try {
      hello = await this._send('hello', {}, this.opts.helloTimeoutMs);
    } catch (error) {
      this._endEntry(entry);
      return this._unavailable(error.code === 'timeout' ? 'no_answer' : 'start_failed');
    }
    return this._acceptHello(entry, hello);
  }

  _acceptHello(entry, hello) {
    if (hello.protocol !== protocol.PROTOCOL) {
      this._endEntry(entry);
      return this._unavailable('protocol_mismatch');
    }
    if (hello.available === false) {
      // Ended rather than kept: a helper that can do nothing is only a process to leak.
      this._endEntry(entry);
      return this._unavailable('not_available', { hello });
    }
    this._setState('ready');
    return { available: true, hello };
  }

  _unavailable(reason, extra = {}) {
    this._lastUnavailable = { available: false, reason, ...extra };
    this._setState('unavailable');
    return this._lastUnavailable;
  }

  _setState(next) {
    if (this._state === next) return;
    this._state = next;
    this._safeEmit('state', next);
  }

  _spawnEntry(command) {
    let child;
    try {
      child = this.opts.spawn(command, this.opts.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.opts.env });
    } catch (error) {
      this.opts.logger.warn(`jenny-computer could not start: ${bound(error.code || error.message)}`);
      return null;
    }
    const entry = { child, intentional: false, done: false, closed: null, resolveClosed: null, decoder: null };
    entry.closed = new Promise((resolve) => { entry.resolveClosed = resolve; });
    entry.decoder = protocol.createLineDecoder({
      onMessage: (message) => this._onMessage(entry, message),
      onError: (reason) => this._onBadLine(reason),
    });
    this._entry = entry;
    this._wire(entry);
    return entry;
  }

  _wire(entry) {
    const { child } = entry;
    child.stdout?.on('data', (chunk) => entry.decoder.push(chunk));
    child.stdout?.on('end', () => entry.decoder.end());
    child.stderr?.on('data', (chunk) => this._stderr.push(chunk));
    child.stdin?.on('error', NOOP);
    child.on('error', (error) => {
      this.opts.logger.warn(`jenny-computer process error: ${bound(error.code || error.message)}`);
      if (child.pid === undefined) this._finish(entry, null, null);
    });
    child.on('close', (code, signal) => this._finish(entry, code, signal));
  }

  // Ends a child the host no longer wants (failed hello). Not a crash.
  _endEntry(entry) {
    entry.intentional = true;
    if (this._entry === entry) this._entry = null;
    this._killEntry(entry);
  }

  _killEntry(entry) {
    try { entry.child.kill(); } catch (error) { this.opts.logger.warn(`jenny-computer could not be ended: ${bound(error.message)}`); }
  }

  // --- requests ----------------------------------------------------------

  async _ensureReady() {
    if (this._stopPromise || this._state === 'unavailable') throw hostError('helper_unavailable');
    if (this._state === 'ready') return;
    if (this._state === 'crashed' && !this._allowRestart()) {
      this._unavailable('restart_limit');
      throw hostError('helper_unavailable', 'restart_limit');
    }
    const result = await this.start();
    if (!result.available) throw hostError('helper_unavailable', result.reason);
  }

  _allowRestart() {
    const now = this.opts.now();
    this._restartTimes = this._restartTimes.filter((at) => now - at < this.opts.restartWindowMs);
    if (this._restartTimes.length >= this.opts.maxRestarts) return false;
    this._restartTimes.push(now);
    this._restarts += 1;
    return true;
  }

  _timeoutFor(op, args, timeoutMs) {
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
    if (op !== 'run.stop') return this.opts.requestTimeoutMs;
    const closeMs = Number.isFinite(args.close_timeout_ms) ? args.close_timeout_ms : DEFAULT_CLOSE_TIMEOUT_MS;
    return closeMs + RUN_STOP_EXTRA_MS;
  }

  _send(op, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = this._entry;
      if (!entry || entry.done) {
        reject(hostError('helper_exited', 'the helper is not running'));
        return;
      }
      const id = this._nextId;
      this._nextId += 1;
      const timer = this.opts.setTimeout(() => this._settle(id, () => reject(hostError('timeout', `${op} got no answer`))), timeoutMs);
      this._pending.set(id, { resolve, reject, timer, entry, op, runId: op === 'run.start' ? args.run_id : null, exitedEarly: false });
      try { entry.child.stdin.write(protocol.encodeRequest(id, op, args)); } catch (error) {
        this._settle(id, (pending) => pending.reject(hostError('helper_exited', error.message)));
      }
    });
  }

  _settle(id, action) {
    const pending = this._pending.get(id);
    if (!pending) return false;
    this._pending.delete(id);
    this.opts.clearTimeout(pending.timer);
    action(pending);
    return true;
  }

  _rejectPending(entry, code) {
    for (const [id, pending] of [...this._pending]) {
      if (pending.entry === entry) this._settle(id, () => pending.reject(hostError(code)));
    }
  }

  // --- messages ----------------------------------------------------------

  _onMessage(entry, message) {
    if (entry !== this._entry) return;
    if (message.kind === 'event') this._onEvent(message.name, message.fields);
    else this._onReply(message);
  }

  _onReply(reply) {
    if (reply.id === null) {
      this.opts.logger.warn(`jenny-computer rejected a request line: ${bound(reply.error?.code)}`);
      return;
    }
    const known = this._settle(reply.id, (pending) => {
      if (!reply.ok) {
        pending.reject(hostError(reply.error.code, reply.error.message, reply.error.reason));
        return;
      }
      this._trackRuns(pending, reply.result);
      pending.resolve(reply.result);
    });
    if (!known) this.opts.logger.debug(`jenny-computer: dropped a reply for unknown id ${reply.id}`);
  }

  // A run whose exit event came before its start reply is already over: it never joins the active set.
  _trackRuns(pending, result) {
    if (typeof result.run_id !== 'string') return;
    if (pending.op === 'run.start') {
      if (!pending.exitedEarly) this._runIds.add(result.run_id);
    } else if (pending.op === 'run.stop') this._runIds.delete(result.run_id);
  }

  _noteEarlyExit(runId) {
    for (const pending of this._pending.values()) {
      if (pending.op === 'run.start' && pending.runId === runId) pending.exitedEarly = true;
    }
  }

  _onEvent(name, fields) {
    if (name === 'log') this._logHelper(fields);
    if (name === 'run.exited' && typeof fields.run_id === 'string') {
      this._runIds.delete(fields.run_id);
      this._noteEarlyExit(fields.run_id);
    }
    this._safeEmit('event', name, fields);
    if (NAMED_EVENTS.has(name)) this._safeEmit(name, fields);
  }

  _logHelper(fields) {
    const level = HELPER_LOG_LEVELS.has(fields.level) ? fields.level : 'info';
    this.opts.logger[level](`jenny-computer: ${bound(fields.message ?? '')}`);
  }

  _onBadLine(reason) {
    this._badLines += 1;
    this.opts.logger.warn(`jenny-computer: unreadable stdout line (${reason})`);
  }

  _safeEmit(...args) {
    try { this.emit(...args); } catch (error) { this.opts.logger.error(`jenny-computer listener threw: ${bound(error.message)}`); }
  }

  // --- exit and stop -----------------------------------------------------

  _finish(entry, code, signal) {
    if (entry.done) return;
    entry.done = true;
    if (this._entry === entry) this._entry = null;
    entry.resolveClosed();
    this._rejectPending(entry, 'helper_exited');
    if (entry.intentional || this._state !== 'ready') return;
    this._startPromise = null;
    const runIds = [...this._runIds];
    this._runIds.clear();
    this._setState('crashed');
    this._safeEmit('helper_exited', { code, signal, runIds });
  }

  async _doStop() {
    if (this._state === 'starting' && this._startPromise) await this._startPromise.catch(NOOP);
    const entry = this._entry;
    if (entry && !entry.done) await this._shutdownEntry(entry);
    if (this._entry === entry) this._entry = null;
    // The helper's jobs end with it (kill-on-close), so no run outlives a stop.
    this._runIds.clear();
    this._startPromise = null;
    this._lastUnavailable = null;
    this._setState('stopped');
  }

  async _shutdownEntry(entry) {
    entry.intentional = true;
    this._send('shutdown', {}, this.opts.shutdownTimeoutMs).catch(NOOP);
    await this._waitClosed(entry, this.opts.shutdownTimeoutMs);
    if (entry.done) return;
    this._killEntry(entry);
    await this._waitClosed(entry, KILL_WAIT_MS);
  }

  _waitClosed(entry, ms) {
    return new Promise((resolve) => {
      const timer = this.opts.setTimeout(resolve, ms);
      entry.closed.then(() => {
        this.opts.clearTimeout(timer);
        resolve();
      });
    });
  }
}

function createComputerHelperHost(options = {}) {
  return new ComputerHelperHost(options);
}

module.exports = { ComputerHelperHost, createComputerHelperHost };
