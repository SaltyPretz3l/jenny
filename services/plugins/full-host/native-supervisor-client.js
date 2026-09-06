'use strict';

const crypto = require('node:crypto');
const { spawn: defaultSpawn } = require('node:child_process');

const MAX_FRAME_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 35_000;

function requestAuthMessage(request) {
  return [request.direction, request.sequence, request.request_id, request.operation,
    request.executable_path || '', request.executable_digest || '', request.session_id || '',
    request.session_epoch ?? '', request.launch_context_json || '', request.payload_json || '',
    request.workload_profile_json || '', request.workload_profile_id || '',
    request.proof_timeout_ms ?? '', request.secret_size ?? '', request.secret_digest || '',
    request.grant_id || ''].join('\0');
}

function responseAuthMessage(response) {
  return [response.direction, response.sequence, response.request_id, response.ok,
    response.reason || '', response.result == null ? '' : JSON.stringify(response.result)].join('\0');
}

function tag(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

class NativeSupervisorClient {
  constructor({ executablePath, spawn = defaultSpawn, timeoutMs = REQUEST_TIMEOUT_MS,
    log = () => {}, onExit = () => {}, onHostExit = () => {} } = {}) {
    this._path = executablePath;
    this._spawn = spawn;
    this._timeout = timeoutMs;
    this._log = log;
    this._onExit = onExit;
    this._onHostExit = onHostExit;
    this._child = null;
    this._secret = null;
    this._key = crypto.randomBytes(32);
    this._sequence = 0;
    this._pending = new Map();
    this._buffer = '';
    this._disposed = false;
    this._poisoned = false;
    this._hostExitNotified = new Set();
  }

  async _connect() {
    if (this._child) return;
    if (this._disposed || this._poisoned || typeof this._path !== 'string' || !this._path) {
      throw new Error('supervisor_unavailable');
    }
    const child = this._spawn(this._path, [], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: {}, shell: false,
    });
    this._child = child;
    this._secret = child.stdio[3];
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', () => {});
    child.once('exit', () => this._failAll('supervisor_exited'));
    child.once('error', () => this._failAll('supervisor_spawn_failed'));
    try {
      const result = await this._send({ operation: 'handshake',
        auth_key: this._key.toString('hex') }, true);
      if (result?.protocol_version !== 1) throw new Error('supervisor_handshake_rejected');
    } catch (error) {
      if (!this._poisoned) this._failAll(error?.message || 'supervisor_handshake_rejected');
      throw error;
    }
  }

  _failAll(reason) {
    const pending = [...this._pending.values()];
    this._pending.clear();
    const child = this._child;
    this._child = null;
    this._secret?.destroy?.();
    this._secret = null;
    if (!this._disposed) this._poisoned = true;
    child?.stdin?.destroy?.();
    child?.stdout?.destroy?.();
    child?.stderr?.destroy?.();
    if (child && child.exitCode == null) child.kill?.();
    for (const item of pending) { clearTimeout(item.timer); item.reject(new Error(reason)); }
    if (!this._disposed) void Promise.resolve(this._onExit(reason)).catch(() => {});
  }

  _onData(chunk) {
    this._buffer += chunk.toString('utf8');
    if (Buffer.byteLength(this._buffer, 'utf8') > MAX_FRAME_BYTES * 2) {
      this._failAll('supervisor_frame_too_large');
      return;
    }
    let newline;
    while ((newline = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, newline).replace(/\r$/, '');
      this._buffer = this._buffer.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
        this._failAll('supervisor_frame_too_large');
        return;
      }
      let response;
      try { response = JSON.parse(line); } catch (_error) {
        this._failAll('supervisor_frame_invalid'); return;
      }
      const pending = this._pending.get(response.request_id);
      if (!pending || response.direction !== 'supervisor_to_electron'
        || response.sequence !== pending.sequence
        || response.auth_tag !== tag(this._key, responseAuthMessage(response))) {
        this._failAll('supervisor_response_auth_rejected'); return;
      }
      this._pending.delete(response.request_id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.reason || 'supervisor_request_failed'));
    }
  }

  _send(fields, handshake = false) {
    const sequence = this._sequence++;
    const request = {
      operation: fields.operation,
      request_id: crypto.randomUUID().replaceAll('-', ''),
      direction: 'electron_to_supervisor', sequence,
      auth_tag: '', auth_key: fields.auth_key || null,
      executable_path: fields.executable_path || null,
      executable_digest: fields.executable_digest || null,
      session_id: fields.session_id || null,
      session_epoch: fields.session_epoch ?? null,
      launch_context_json: fields.launch_context_json || null,
      payload_json: fields.payload_json || null,
      workload_profile_json: fields.workload_profile_json || null,
      workload_profile_id: fields.workload_profile_id || null,
      proof_timeout_ms: fields.proof_timeout_ms ?? null,
      secret_size: fields.secret_size ?? null,
      secret_digest: fields.secret_digest || null,
      grant_id: fields.grant_id || null,
    };
    if (!handshake) request.auth_tag = tag(this._key, requestAuthMessage(request));
    const encoded = JSON.stringify(request);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) {
      return Promise.reject(new Error('supervisor_request_too_large'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._failAll('supervisor_request_timeout');
      }, this._timeout);
      this._pending.set(request.request_id, { resolve, reject, timer, sequence });
      this._child.stdin.write(`${encoded}\n`, 'utf8', (error) => {
        if (error) {
          clearTimeout(timer);
          this._pending.delete(request.request_id);
          reject(new Error('supervisor_write_failed'));
        }
      });
    });
  }

  async _request(fields) { await this._connect(); return this._send(fields); }
  async capabilities() {
    try { return await this._request({ operation: 'capabilities' }); }
    catch (_error) { return { capabilities: [] }; }
  }
  async start(request, { signal } = {}) {
    if (signal?.aborted) return { ok: false, reason: 'supervisor_unavailable' };
    try {
      const receipt = await this._request({ operation: 'start', ...request });
      if (signal?.aborted) {
        await this.terminate({ session_id: request.session_id, session_epoch: request.session_epoch,
          reason: 'startup_cancelled' });
        return { ok: false, reason: 'supervisor_unavailable' };
      }
      const channel = Object.freeze({
        request: async (operation, payload = {}) => {
          let host;
          try {
            host = await this._request({ operation: 'host_call',
              session_id: request.session_id, session_epoch: request.session_epoch,
              payload_json: JSON.stringify({ operation, payload }) });
          } catch (error) {
            const reason = String(error?.message || 'host_process_exited');
            if (reason !== 'session_not_found'
              && !this._hostExitNotified.has(request.session_id)) {
              this._hostExitNotified.add(request.session_id);
              await Promise.resolve(this._onHostExit({ session_id: request.session_id,
                session_epoch: request.session_epoch, reason })).catch(() => {});
            }
            throw error;
          }
          if (host?.status !== 'ok' || typeof host.payload_json !== 'string') {
            return { ok: false, reason: 'host_call_rejected' };
          }
          try { return JSON.parse(host.payload_json); } catch (_error) {
            return { ok: false, reason: 'host_payload_invalid' };
          }
        },
      });
      return { ok: true, receipt, channel };
    } catch (error) { return { ok: false, reason: error.message || 'supervisor_start_failed' }; }
  }
  async deliverSecret({ session_id, session_epoch, grant_id, secret }) {
    await this._connect();
    const bytes = Buffer.from(secret, 'utf8');
    if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES || !this._secret?.writable) {
      throw new Error('secret_channel_unavailable');
    }
    const frame = Buffer.allocUnsafe(bytes.length + 4);
    frame.writeUInt32BE(bytes.length, 0);
    bytes.copy(frame, 4);
    const response = this._send({ operation: 'deliver_secret', session_id, session_epoch,
      grant_id, secret_size: bytes.length,
      secret_digest: crypto.createHash('sha256').update(bytes).digest('hex') });
    await new Promise((resolve, reject) => {
      this._secret.write(frame, (error) => (error ? reject(error) : resolve()));
    });
    const host = await response;
    if (host?.status !== 'ok' || typeof host.payload_json !== 'string') {
      throw new Error('secret_delivery_rejected');
    }
    try { return JSON.parse(host.payload_json); }
    catch (error) { throw new Error('secret_receipt_invalid', { cause: error }); }
  }
  async terminate(request) {
    try {
      const result = { ok: true, ...(await this._request({ operation: 'terminate', ...request })) };
      this._hostExitNotified.delete(request?.session_id);
      return result;
    }
    catch (error) { return { ok: false, reason: error.message || 'supervisor_terminate_failed' }; }
  }
  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const child = this._child;
    this._child = null;
    this._secret?.destroy?.();
    this._secret = null;
    if (child?.stdin?.writable) child.stdin.end();
    if (child && child.exitCode == null) child.kill?.();
    this._failAll('supervisor_disposed');
  }
}

module.exports = { MAX_FRAME_BYTES, responseAuthMessage, NativeSupervisorClient };
