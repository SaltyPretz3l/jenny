'use strict';

class EngineAdapterStreamBroker {
  constructor({ invokeHost, maxFrameBytes = 65_536, maxStreamBytes = 16_777_216,
    maxActive = 2, stepTimeoutMs = 35_000, cancelTimeoutMs = 2_000,
    captureAuthority = () => null, guardAuthority = () => ({ ok: true }),
    guardRuntimeAuthority = () => ({ ok: true }) } = {}) {
    this._invoke = invokeHost;
    this._frame = maxFrameBytes;
    this._stream = maxStreamBytes;
    this._maximum = maxActive;
    this._timeout = stepTimeoutMs;
    this._cancelTimeout = cancelTimeoutMs;
    this._active = new Map();
    this._captureAuthority = captureAuthority;
    this._guardAuthority = guardAuthority;
    this._guardRuntimeAuthority = guardRuntimeAuthority;
  }

  async start({ requestId, descriptor, authority, input, signal }) {
    const policyToken = this._captureAuthority();
    const gated = this._guardAuthority(policyToken);
    if (!gated?.ok) return gated;
    const runtime = this._guardRuntimeAuthority(authority);
    if (!runtime?.ok) return runtime;
    if (this._active.has(requestId)) return { ok: false, reason: 'engine_stream_duplicate' };
    if (this._active.size >= this._maximum) return { ok: false, reason: 'engine_stream_limit' };
    if (Buffer.byteLength(JSON.stringify(input || {}), 'utf8') > descriptor.max_input_bytes) {
      return { ok: false, reason: 'engine_input_too_large' };
    }
    const state = { next: 0, bytes: 0, terminal: false, descriptor, authority, policyToken };
    this._active.set(requestId, state);
    try { return await this._step('start', { requestId, descriptor, authority, input, signal }, state); }
    catch (_error) { this._active.delete(requestId); return { ok: false, reason: 'engine_stream_start_failed' }; }
  }

  async acknowledge({ requestId, sequence, signal }) {
    const state = this._active.get(requestId);
    if (!state || state.terminal) return { ok: false, reason: 'engine_stream_not_active' };
    const gated = this._guardAuthority(state.policyToken);
    if (!gated?.ok) return gated;
    const runtime = this._guardRuntimeAuthority(state.authority);
    if (!runtime?.ok) {
      await this.cancel({ requestId, reason: 'generation_changed' });
      return runtime;
    }
    return this._step('stream_ack', { requestId, sequence, signal }, state);
  }

  async _step(operation, request, state) {
    let timer;
    let result;
    try {
      result = await Promise.race([
        this._invoke({ operation, ...request, descriptor: state.descriptor,
          authority: state.authority }),
        new Promise((_, reject) => { timer = setTimeout(
          () => reject(new Error('engine_stream_deadline')), this._timeout
        ); }),
      ]);
    } catch (_error) {
      clearTimeout(timer);
      await this.cancel({ requestId: request.requestId, reason: 'stream_deadline_or_failure' });
      return { ok: false, reason: 'engine_stream_host_failed' };
    }
    clearTimeout(timer);
    const gated = this._guardAuthority(state.policyToken);
    if (!gated?.ok) {
      await this.cancel({ requestId: request.requestId, reason: 'managed_policy_revoked' });
      return gated;
    }
    const runtime = this._guardRuntimeAuthority(state.authority);
    if (!runtime?.ok || this._active.get(request.requestId) !== state) {
      await this.cancel({ requestId: request.requestId, reason: 'generation_changed' });
      return runtime?.ok ? { ok: false, reason: 'engine_stream_not_active' } : runtime;
    }
    const frames = Array.isArray(result?.frames) ? result.frames : [];
    for (const frame of frames) {
      const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8');
      if (bytes > this._frame || state.bytes + bytes > Math.min(this._stream, state.descriptor.max_stream_bytes)
        || frame.sequence !== state.next || state.terminal) {
        await this.cancel({ requestId: request.requestId, reason: 'frame_rejected' });
        return { ok: false, reason: 'engine_stream_frame_rejected' };
      }
      state.next += 1; state.bytes += bytes;
      if (frame.kind === 'done' || frame.kind === 'error') state.terminal = true;
    }
    if (state.terminal) this._active.delete(request.requestId);
    return { ok: true, frames, terminal: state.terminal };
  }

  async cancel({ requestId, reason = 'cancelled' }) {
    const state = this._active.get(requestId);
    if (!state) return { ok: true, already_terminal: true };
    state.terminal = true;
    this._active.delete(requestId);
    let timer;
    try {
      await Promise.race([
        this._invoke({ operation: 'cancel', requestId, reason, authority: state.authority,
          descriptor: state.descriptor }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('engine_stream_cancel_deadline')),
            this._cancelTimeout);
        }),
      ]);
    }
    catch (_error) { return { ok: false, reason: 'engine_stream_cancel_ambiguous' }; }
    finally { clearTimeout(timer); }
    return { ok: true };
  }

  async cancelAll(reason = 'managed_policy_revoked') {
    const requestIds = [...this._active.keys()];
    const results = await Promise.all(requestIds.map((requestId) => this.cancel({ requestId, reason })));
    return { ok: results.every((result) => result?.ok), cancelled_count: requestIds.length };
  }
}

module.exports = { EngineAdapterStreamBroker };
