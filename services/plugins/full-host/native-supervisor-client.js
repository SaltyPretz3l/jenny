'use strict';

const crypto = require('node:crypto');
const { spawn: defaultSpawn } = require('node:child_process');

const MAX_FRAME_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 35_000;

function streamClosed(stream) {
  return !stream || stream.closed === true || stream.destroyed === true;
}

function sessionKey(value = {}) {
  return `${String(value.session_id || '')}\0${String(value.session_epoch || '')}`;
}

function recoverableSupervisorFailure(reason) {
  return ['supervisor_exited', 'supervisor_closed', 'supervisor_request_timeout',
    'supervisor_spawn_failed', 'supervisor_quiesced'].includes(reason);
}

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
    cleanupTimeoutMs = 2_000, log = () => {}, onExit = () => {}, onHostExit = () => {},
    hostResources = null, validateResourceAuthority = null } = {}) {
    this._path = executablePath;
    this._spawn = spawn;
    this._timeout = timeoutMs;
    this._cleanupTimeout = cleanupTimeoutMs;
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
    this._hostResources = hostResources;
    this._validateResourceAuthority = validateResourceAuthority;
    this._owner = null;
    this._connecting = null;
    this._pendingSpawnHandle = null;
    this._quiescing = false;
    this._quiesceConfirmed = false;
    this._quiescePromise = null;
  }

  async _ensureConnected({ validateResourceAuthority = null } = {}) {
    if (this._connecting) return this._connecting;
    if (this._child) return;
    if (this._disposed || this._quiescing || this._poisoned
      || typeof this._path !== 'string' || !this._path) {
      throw new Error('supervisor_unavailable');
    }
    const connecting = this._connect({ validateResourceAuthority });
    this._connecting = connecting;
    try { return await connecting; }
    catch (error) {
      const handle = this._pendingSpawnHandle;
      this._pendingSpawnHandle = null;
      if (handle) this._hostResources.settleSupervisorNoStart(handle, 'supervisor_spawn_failed');
      throw error;
    }
    finally { if (this._connecting === connecting) this._connecting = null; }
  }

  async _connect({ validateResourceAuthority = null } = {}) {
    const validate = validateResourceAuthority || this._validateResourceAuthority;
    const admission = this._hostResources?.trySupervisorStart?.({ validate });
    if (admission && !admission.ok) throw new Error(admission.reason);
    const handle = admission?.handle || null;
    if (this._disposed) {
      if (handle) this._hostResources.settleSupervisorNoStart(handle, 'supervisor_disposed');
      throw new Error('supervisor_unavailable');
    }
    if (handle && this._hostResources.markSupervisorAttempted(handle) !== true) {
      this._hostResources.settleSupervisorNoStart(handle, 'native_supervisor_binding_invalid');
      throw new Error('native_supervisor_binding_invalid');
    }
    this._key = crypto.randomBytes(32);
    this._sequence = 0;
    this._buffer = '';
    this._pendingSpawnHandle = handle;
    const child = this._spawn(this._path, [], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: {}, shell: false,
    });
    this._pendingSpawnHandle = null;
    const owner = { child, handle, spawned: false, noStartProven: false,
      closed: false, failed: false,
      sessions: new Map(), reason: null, cleanup: null, closeResolve: null,
      closePromise: null };
    owner.closePromise = new Promise((resolve) => { owner.closeResolve = resolve; });
    this._owner = owner;
    this._child = child;
    this._secret = child?.stdio?.[3] || null;
    if (!child || typeof child.once !== 'function' || typeof child.stdin?.write !== 'function'
      || typeof child.stdout?.on !== 'function' || typeof child.stderr?.on !== 'function'
      || !this._secret) {
      owner.spawned = true;
      if (handle) this._hostResources.markSupervisorSpawned(handle);
      this._failAll('supervisor_spawn_contract_invalid', owner);
      throw new Error('supervisor_spawn_contract_invalid');
    }
    if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      owner.spawned = true;
      if (handle) this._hostResources.markSupervisorSpawned(handle);
    }
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', () => {});
    child.once('spawn', () => {
      if (!owner.spawned) {
        owner.spawned = true;
        if (handle) this._hostResources.markSupervisorSpawned(handle);
      }
    });
    child.once('exit', () => this._failAll('supervisor_exited', owner));
    child.once('error', () => {
      owner.noStartProven = !owner.spawned
        && !(Number.isSafeInteger(child.pid) && child.pid > 0);
      this._failAll('supervisor_spawn_failed', owner);
    });
    child.once('close', () => this._onClose(owner));
    for (const stream of [child.stdin, child.stdout, child.stderr, child.stdio[3]]) {
      stream?.once?.('close', () => this._settleClosedOwner(owner));
    }
    try {
      const result = await this._send({ operation: 'handshake',
        auth_key: this._key.toString('hex') }, true);
      if (result?.protocol_version !== 1) throw new Error('supervisor_handshake_rejected');
    } catch (error) {
      if (!this._poisoned) this._failAll(error?.message || 'supervisor_handshake_rejected');
      throw error;
    }
  }

  _failAll(reason, owner = this._owner) {
    if (owner?.failed) return owner.cleanup;
    if (owner) { owner.failed = true; owner.reason = reason; }
    const pending = [...this._pending.values()];
    this._pending.clear();
    const child = owner?.child || this._child;
    if (this._child === child) this._child = null;
    const secret = child?.stdio?.[3] || this._secret;
    secret?.destroy?.();
    if (this._secret === secret) this._secret = null;
    if (!this._disposed) this._poisoned = true;
    child?.stdin?.destroy?.();
    child?.stdout?.destroy?.();
    child?.stderr?.destroy?.();
    if (child && child.exitCode == null) child.kill?.();
    for (const item of pending) { clearTimeout(item.timer); item.reject(new Error(reason)); }
    if (owner?.handle) {
      owner.cleanup = owner.noStartProven
        ? this._hostResources.settleSupervisorNoStart(owner.handle, reason)
        : this._hostResources.quarantineSupervisor(owner.handle, reason);
    }
    if (!this._disposed) void Promise.resolve(this._onExit({ reason,
      sessions: [...(owner?.sessions?.values() || [])], resource_cleanup: owner?.cleanup || null,
      cleanup_phase: 'lost' })).catch(() => {});
    return owner?.cleanup || null;
  }

  _onClose(owner) {
    if (owner.closed) return;
    owner.closed = true;
    if (!owner.failed) this._failAll('supervisor_closed', owner);
    this._settleClosedOwner(owner);
  }

  _settleClosedOwner(owner) {
    if (!owner.closed || owner.settled) return;
    const streams = [owner.child?.stdin, owner.child?.stdout, owner.child?.stderr,
      owner.child?.stdio?.[3]];
    const outputReadersTerminated = streams.every(streamClosed);
    if (owner.handle) {
      if (owner.noStartProven) {
        owner.cleanup = this._hostResources.settleSupervisorNoStart(owner.handle, owner.reason);
      } else {
        if (!owner.spawned) {
          owner.spawned = true;
          this._hostResources.markSupervisorSpawned(owner.handle);
        }
        owner.cleanup = this._hostResources.settleSupervisorClose(owner.handle, {
          processClosed: true, outputReadersTerminated,
          sessions: [...owner.sessions.values()], reason: owner.reason,
        });
      }
    }
    const confirmed = !owner.handle || owner.cleanup?.cleanup === 'confirmed';
    if (!confirmed) return;
    owner.settled = true;
    if (owner.reason === 'supervisor_quiesced') this._quiesceConfirmed = true;
    if (this._owner === owner) this._owner = null;
    if (!this._disposed && recoverableSupervisorFailure(owner.reason)) this._poisoned = false;
    owner.closeResolve?.(owner.cleanup);
    if (!this._disposed) void Promise.resolve(this._onExit({ reason: owner.reason,
      sessions: [...owner.sessions.values()], resource_cleanup: owner.cleanup || null,
      cleanup_phase: 'closed' })).catch(() => {});
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
    const child = this._child;
    if (!child || typeof child.stdin?.write !== 'function') {
      return Promise.reject(new Error('supervisor_unavailable'));
    }
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
      child.stdin.write(`${encoded}\n`, 'utf8', (error) => {
        if (error) {
          clearTimeout(timer);
          this._pending.delete(request.request_id);
          reject(new Error('supervisor_write_failed'));
        }
      });
    });
  }

  async _request(fields, options = {}) {
    await this._ensureConnected(options);
    if (this._disposed || !this._child) throw new Error('supervisor_unavailable');
    if (options.sessionIdentity) {
      const identity = Object.freeze({ session_id: options.sessionIdentity.session_id,
        session_epoch: options.sessionIdentity.session_epoch });
      this._owner?.sessions.set(sessionKey(identity), identity);
    }
    return this._send(fields);
  }
  async capabilities(options = {}) {
    try { return await this._request({ operation: 'capabilities' }, options); }
    catch (_error) { return { capabilities: [] }; }
  }
  async start(request, { signal, validateResourceAuthority = null } = {}) {
    if (signal?.aborted) return { ok: false, reason: 'supervisor_unavailable' };
    try {
      const receipt = await this._request({ operation: 'start', ...request }, {
        validateResourceAuthority, sessionIdentity: request,
      });
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
            const exitKey = sessionKey(request);
            if (reason !== 'session_not_found'
              && !this._hostExitNotified.has(exitKey)) {
              this._hostExitNotified.add(exitKey);
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
      let proof = await this._request({ operation: 'terminate', ...request });
      proof = this._hostResources?.applyPriorSupervisorProof?.({
        sessionId: request?.session_id, sessionEpoch: request?.session_epoch, proof,
      }) || proof;
      const result = { ok: true, ...proof };
      this._hostExitNotified.delete(sessionKey(request));
      return result;
    }
    catch (error) { return { ok: false, reason: error.message || 'supervisor_terminate_failed' }; }
  }
  async acknowledgeTermination(request) {
    try {
      const result = await this._request({ operation: 'acknowledge_termination', ...request });
      const key = sessionKey(request);
      this._owner?.sessions?.delete(key);
      this._hostResources?.acknowledgeTermination?.({
        sessionId: request?.session_id, sessionEpoch: request?.session_epoch,
      });
      this._hostExitNotified.delete(key);
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, reason: error.message || 'supervisor_acknowledgement_failed' };
    }
  }
  quiesce() {
    if (this._disposed) return Promise.resolve({ ok: false, reason: 'supervisor_disposed' });
    if (this._quiescePromise) return this._quiescePromise;
    this._quiescing = true;
    this._quiesceConfirmed = false;
    const operation = (async () => {
      const owner = this._owner;
      if (!owner) {
        this._quiesceConfirmed = true;
        return { ok: true, already_absent: true };
      }
      const child = owner.child || this._child;
      if (child?.stdin?.writable) child.stdin.end();
      if (child && child.exitCode == null) child.kill?.();
      this._failAll('supervisor_quiesced', owner);
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(owner.cleanup), this._cleanupTimeout);
        timer.unref?.();
      });
      await Promise.race([owner.closePromise, timeout]);
      clearTimeout(timer);
      const ok = owner.settled === true;
      this._quiesceConfirmed = ok;
      if (!ok) this._quiescePromise = null;
      return { ok, ...(ok ? {} : { reason: 'supervisor_cleanup_unconfirmed' }),
        resource_cleanup: owner.cleanup || null };
    })();
    this._quiescePromise = operation;
    return operation;
  }
  reopenAfterQuiesce() {
    if (this._disposed) return { ok: false, reason: 'supervisor_disposed' };
    if (!this._quiescing) return { ok: true };
    if (!this._quiesceConfirmed || this._owner || this._child || this._connecting) {
      return { ok: false, reason: 'supervisor_cleanup_unconfirmed' };
    }
    this._quiescing = false;
    this._quiesceConfirmed = false;
    this._quiescePromise = null;
    this._poisoned = false;
    return { ok: true };
  }
  async dispose() {
    if (this._disposed) return this._owner?.cleanup || null;
    this._disposed = true;
    const owner = this._owner;
    const child = owner?.child || this._child;
    if (child?.stdin?.writable) child.stdin.end();
    if (child && child.exitCode == null) child.kill?.();
    const cleanup = this._failAll('supervisor_disposed', owner);
    if (!owner?.handle) return cleanup;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(owner.cleanup), this._cleanupTimeout);
      timer.unref?.();
    });
    const settled = await Promise.race([owner.closePromise, timeout]);
    clearTimeout(timer);
    return settled || owner.cleanup;
  }
}

module.exports = { MAX_FRAME_BYTES, responseAuthMessage, NativeSupervisorClient };
