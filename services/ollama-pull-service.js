'use strict';

const { EventEmitter } = require('events');
const { spawn: defaultSpawn } = require('child_process');
const { buildSanitizedOllamaEnv } = require('./backend/ollama-env');
const { killProcessTree } = require('./backend/process-utils');
const { SETUP_ERROR_CODES } = require('./backend/error-codes');
const { normalizeString } = require('./backend/path-utils');
const { resolveOllamaCommand } = require('./ollama-runtime-paths');
const { aggregatePullStats, parsePullLine, stripAnsi } = require('./ollama-pull-progress');
const { createRequestId, normalizeRequestId, publicPullState } = require('./setup-service-helpers');

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const PROGRESS_INTERVAL_MS = 250;
const PULL_INACTIVITY_MS = 5 * 60 * 1000;
const TERMINATION_TIMEOUT_MS = 5_000;
const OUTPUT_TAIL_CHARS = 4_096;

function normalizeModelName(value) {
  const model = normalizeString(value);
  return model && !/[\r\n\0]/.test(model) && MODEL_PATTERN.test(model) ? model : '';
}

function boundedError(value) {
  return stripAnsi(String(value || ''))
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:"']+[\\/])+[^\s:"']*/g, '[path]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .trim()
    .slice(0, 300);
}

class OllamaPullService extends EventEmitter {
  constructor({
    spawnImpl = defaultSpawn,
    requestIdProvider = createRequestId,
    nowProvider = () => new Date(),
    platform = process.platform,
    env = process.env,
    fileExists,
    killProcessTreeImpl = killProcessTree,
    inactivityMs = PULL_INACTIVITY_MS,
    logger = null,
  } = {}) {
    super();
    this.spawnImpl = spawnImpl;
    this.requestIdProvider = requestIdProvider;
    this.nowProvider = nowProvider;
    this.platform = platform;
    this.env = env;
    this.fileExists = fileExists;
    this.killProcessTreeImpl = killProcessTreeImpl;
    this.inactivityMs = Math.max(1, Number(inactivityMs) || PULL_INACTIVITY_MS);
    this.logger = typeof logger === 'function' ? logger : null;
    this.activeByModel = new Map();
    this.activeByRequestId = new Map();
  }

  _nowIso() {
    const value = this.nowProvider();
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
  }

  _command() {
    return resolveOllamaCommand({
      platform: this.platform,
      env: this.env,
      ...(typeof this.fileExists === 'function' ? { fileExists: this.fileExists } : {}),
    });
  }

  _log(level, event, details) {
    try {
      this.logger?.(level, event, details);
    } catch (_error) {
      // Diagnostics must not change pull lifecycle behavior.
    }
  }

  _emit(entry, { terminal = false } = {}) {
    const now = Date.now();
    if (!terminal && entry.lastEmitAt && now - entry.lastEmitAt < PROGRESS_INTERVAL_MS) return;
    entry.lastEmitAt = now;
    this.emit('progress', publicPullState(entry));
  }

  _resetInactivity(entry) {
    if (entry.inactivityTimer) clearTimeout(entry.inactivityTimer);
    entry.inactivityTimer = setTimeout(() => {
      void this._cancelEntry(entry, 'pull_inactivity_timeout');
    }, this.inactivityMs);
    entry.inactivityTimer.unref?.();
  }

  _finish(entry, patch = {}) {
    if (entry.finished) return publicPullState(entry);
    entry.finished = true;
    if (entry.inactivityTimer) clearTimeout(entry.inactivityTimer);
    entry.status = patch.status || entry.status;
    entry.code = patch.code || entry.code || '';
    entry.summary = patch.summary || entry.summary;
    entry.percent = entry.status === 'completed' ? 100 : entry.percent;
    entry.updatedAt = this._nowIso();
    entry.exitCode = Object.hasOwn(patch, 'exitCode') ? patch.exitCode : entry.exitCode;
    entry.error = boundedError(patch.error);
    entry.terminationConfirmed = patch.terminationConfirmed === true;
    this.activeByModel.delete(entry.model);
    this.activeByRequestId.delete(entry.requestId);
    this._emit(entry, { terminal: true });
    entry.resolve?.(publicPullState(entry));
    entry.resolve = null;
    this._log(entry.status === 'completed' ? 'INFO' : 'WARN', 'setup.ollama_pull_finished', {
      request_id: entry.requestId,
      model: entry.model,
      status: entry.status,
      exit_code: entry.exitCode,
      termination_confirmed: entry.terminationConfirmed,
    });
    return publicPullState(entry);
  }

  start(payload = {}) {
    const model = normalizeModelName(payload.model);
    if (!model) throw new Error('A valid Ollama model name is required.');
    const active = this.activeByModel.get(model);
    if (active) return active;
    let requestId = normalizeRequestId(payload.requestId || payload.request_id)
      || normalizeRequestId(this.requestIdProvider()) || createRequestId();
    if (this.activeByRequestId.has(requestId)) {
      requestId = normalizeRequestId(this.requestIdProvider()) || createRequestId();
      while (this.activeByRequestId.has(requestId)) requestId = createRequestId();
    }
    const startedAt = this._nowIso();
    const entry = {
      requestId, model, status: 'running', summary: 'Starting Ollama model pull.',
      startedAt, updatedAt: startedAt, exitCode: null, error: '', finished: false,
      child: null, percent: 0, bytes: 0, totalBytes: 0, label: '', layers: new Map(),
      lastOutputLine: '', lastErrorLine: '', terminationConfirmed: false, lastEmitAt: 0, code: '',
      stdoutBuffer: '', stderrBuffer: '', cancelPromise: null,
    };
    entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
    this.activeByModel.set(model, entry);
    this.activeByRequestId.set(requestId, entry);
    this._emit(entry);
    try {
      entry.child = this.spawnImpl(this._command(), ['pull', model], {
        windowsHide: true,
        env: buildSanitizedOllamaEnv(this.env).env,
      });
    } catch (error) {
      this._finish(entry, { status: 'failed', summary: 'Failed to start Ollama pull.', error });
      return entry;
    }
    this._resetInactivity(entry);
    const consumeLine = (rawLine) => {
      const line = stripAnsi(rawLine).trim();
      if (line) {
        entry.summary = boundedError(line);
        entry.lastOutputLine = entry.summary;
        if (/^error\b/i.test(line)) entry.lastErrorLine = boundedError(line);
        const parsed = parsePullLine(line);
        if (parsed?.label) entry.label = parsed.label;
        if (parsed?.kind === 'success') entry.percent = 100;
        if (parsed?.kind === 'layer' && parsed.digest) {
          const previous = entry.layers.get(parsed.digest) || {};
          entry.layers.set(parsed.digest, {
            percent: Number.isFinite(parsed.percent) ? parsed.percent : previous.percent || 0,
            bytes: Number.isFinite(parsed.bytes) ? parsed.bytes : previous.bytes || 0,
            total: Number.isFinite(parsed.total) ? parsed.total : previous.total || 0,
          });
          Object.assign(entry, aggregatePullStats(entry.layers));
        }
        entry.updatedAt = this._nowIso();
        this._emit(entry);
      }
    };
    const handleData = (bufferKey) => (chunk) => {
      this._resetInactivity(entry);
      const parts = `${entry[bufferKey]}${String(chunk || '')}`.split(/\r?\n|\r/);
      entry[bufferKey] = (parts.pop() || '').slice(-OUTPUT_TAIL_CHARS);
      parts.forEach(consumeLine);
    };
    const flushBuffers = () => {
      consumeLine(entry.stdoutBuffer);
      consumeLine(entry.stderrBuffer);
      entry.stdoutBuffer = '';
      entry.stderrBuffer = '';
    };
    entry.child?.stdout?.on?.('data', handleData('stdoutBuffer'));
    entry.child?.stderr?.on?.('data', handleData('stderrBuffer'));
    entry.child?.once?.('error', (error) => {
      this._finish(entry, { status: 'failed', summary: 'Ollama pull failed.', error });
    });
    entry.child?.once?.('exit', (code, signal) => {
      if (entry.finished) return;
      if (entry.status === 'cancelling') {
        return;
      }
      flushBuffers();
      const succeeded = code === 0;
      const detail = entry.lastErrorLine || entry.lastOutputLine;
      this._finish(entry, {
        status: succeeded ? 'completed' : 'failed',
        summary: succeeded ? 'Ollama model pull completed.' : 'Ollama model pull failed.',
        exitCode: Number.isFinite(code) ? code : null,
        error: succeeded ? '' : `${detail ? `${detail} (` : ''}ollama pull exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail ? ')' : ''}`,
      });
    });
    this._log('INFO', 'setup.ollama_pull_started', { request_id: requestId, model });
    return entry;
  }

  async delete(payload = {}) {
    const model = normalizeModelName(payload.model);
    if (!model) return { status: 'failed', code: 'invalid_tag', message: 'A valid Ollama model tag is required.' };
    if (this.activeByModel.has(model)) {
      return { status: 'failed', code: 'pull_in_progress', message: 'This model is still downloading.' };
    }
    let child;
    try {
      child = this.spawnImpl(this._command(), ['rm', model], {
        windowsHide: true,
        env: buildSanitizedOllamaEnv(this.env).env,
      });
    } catch (_error) {
      return { status: 'failed', code: 'delete_failed', message: 'Could not start model removal.' };
    }
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      const append = (chunk) => { output = `${output}${stripAnsi(String(chunk || ''))}`.slice(-OUTPUT_TAIL_CHARS); };
      const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
      child?.stderr?.on?.('data', append);
      child?.stdout?.on?.('data', append);
      child?.once?.('error', () => finish({ status: 'failed', code: 'delete_failed', message: 'Model removal failed.' }));
      child?.once?.('exit', (code) => {
        if (code === 0) return finish({ status: 'deleted', model });
        const message = boundedError(output) || 'Model removal failed.';
        finish({ status: 'failed', code: /not found/i.test(message) ? 'not_found' : 'delete_failed', message });
      });
      if (!child?.once) finish({ status: 'failed', code: 'delete_failed', message: 'Model removal could not be observed.' });
    });
  }

  async _cancelEntry(entry, reason = 'cancelled') {
    if (!entry || entry.finished) return entry ? publicPullState(entry) : null;
    if (!entry.cancelPromise) {
      entry.cancelPromise = (async () => {
        entry.status = 'cancelling';
        entry.summary = reason === 'pull_inactivity_timeout'
          ? 'Ollama pull stalled; stopping it.'
          : 'Stopping Ollama model pull.';
        this._emit(entry, { terminal: true });
        let terminationConfirmed = false;
        const pid = Number(entry.child?.pid);
        if (Number.isInteger(pid) && pid > 0) {
          try {
            const result = await this.killProcessTreeImpl(pid, {
              force: true, confirmExit: true, timeoutMs: TERMINATION_TIMEOUT_MS, platform: this.platform,
            });
            terminationConfirmed = result?.terminated === true;
          } catch (_error) { terminationConfirmed = false; }
        } else {
          try { entry.child?.kill?.(); } catch (_error) { /* surfaced below */ }
        }
        if (!terminationConfirmed && !entry.finished) {
          this._finish(entry, {
            status: 'failed', code: 'termination_failed',
            summary: 'Ollama pull could not be confirmed stopped.',
            error: 'Process termination was not confirmed.',
            terminationConfirmed: false,
          });
        } else if (!entry.finished) {
          const stalled = reason === 'pull_inactivity_timeout';
          this._finish(entry, stalled
            ? {
                status: 'failed', code: 'pull_inactivity',
                summary: 'Ollama pull stalled and was stopped.',
                error: 'No model download progress was received for five minutes.',
                terminationConfirmed: true,
              }
            : {
                status: 'cancelled', code: 'cancelled',
                summary: 'Ollama model pull cancelled.', terminationConfirmed: true,
              });
        }
        return publicPullState(entry);
      })();
    }
    return entry.cancelPromise;
  }

  async cancel(payload = {}) {
    const requestId = normalizeString(payload.requestId || payload.request_id);
    const model = normalizeModelName(payload.model);
    const entry = requestId ? this.activeByRequestId.get(requestId) : this.activeByModel.get(model);
    if (!entry) {
      return { cancelled: false, termination_confirmed: false, request_id: requestId, status: 'not_found', code: 'not_found', error_code: '' };
    }
    const state = await this._cancelEntry(entry);
    return {
      ...state,
      cancelled: state.status === 'cancelled',
      termination_confirmed: entry.terminationConfirmed === true,
      request_id: entry.requestId,
      status: state.status,
      code: state.status === 'cancelled' ? 'cancelled' : (state.code || 'termination_failed'),
      error_code: state.terminationConfirmed === false && state.status !== 'cancelled'
        ? SETUP_ERROR_CODES.TERMINATION_FAILED : '',
    };
  }

  signalActive() {
    for (const entry of this.activeByRequestId.values()) {
      entry.status = 'cancelling';
      try { entry.child?.kill?.(); } catch (_error) { /* emergency best effort */ }
    }
    return this.activeByRequestId.size;
  }

  async drainActive() {
    const entries = [...this.activeByRequestId.values()];
    await Promise.all(entries.map((entry) => this._cancelEntry(entry)));
    return entries.length;
  }
}

module.exports = { OllamaPullService };
