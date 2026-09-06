'use strict';

const crypto = require('node:crypto');
const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { validateSchemaInstance } = require('../remote-mcp/json-schema-validator');

const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_GLOBAL_ACTIVE = 16;
const MAX_HOST_ACTIVE = 1;
const MAX_GLOBAL_QUEUE = 64;
const MAX_HOST_QUEUE = 16;

function refusal(reason, retryable = false) {
  return { ok: false, code: PLUGIN_ERROR_CODES.POLICY_BLOCKED, reason, retryable };
}

function cancellation() {
  return {
    ok: false,
    code: PLUGIN_ERROR_CODES.OPERATION_CANCELLED,
    reason: 'operation_cancelled',
    retryable: false,
  };
}

function isJsonPlainObject(value) {
  if (!value || typeof value !== 'object'
    || Object.prototype.toString.call(value) !== '[object Object]') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || (Object.getPrototypeOf(prototype) === null
    && typeof prototype.constructor === 'function'
    && prototype.constructor.name === 'Object');
}

function canonicalJson(value) {
  const ancestors = new Set();
  function normalize(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (ancestors.has(item)) throw new Error('arguments_cycle_rejected');
      ancestors.add(item); const output = item.map(normalize); ancestors.delete(item); return output;
    }
    if (!isJsonPlainObject(item)) throw new Error('arguments_type_rejected');
    if (ancestors.has(item)) throw new Error('arguments_cycle_rejected');
    ancestors.add(item); const output = {};
    for (const key of Object.keys(item).sort()) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('arguments_key_rejected');
      output[key] = normalize(item[key]);
    }
    ancestors.delete(item); return output;
  }
  return JSON.stringify(normalize(value));
}

function authorityMismatch(descriptor, current, argumentHash) {
  const fields = ['publisher_id', 'plugin_id', 'contribution_id', 'artifact_digest', 'component_digest',
    'generation_id', 'commit_epoch', 'lifecycle_epoch', 'policy_revision', 'workspace_incarnation_id'];
  for (const field of fields) if (descriptor[field] !== current?.[field]) return `${field}_stale`;
  if (current.lifecycle_state !== 'active' || current.stage6_enabled !== true) return 'restricted_contribution_inactive';
  if (current.argument_hash !== undefined && current.argument_hash !== argumentHash) return 'argument_hash_stale';
  if (current.revoked === true || current.quarantined === true) return 'restricted_authority_revoked';
  return null;
}

class RestrictedInvocationController {
  constructor({ hostPool, tokenService, secretHandleBroker = null,
    getCurrentAuthority, now = () => performance.now() } = {}) {
    this._hostPool = hostPool; this._tokenService = tokenService; this._getCurrentAuthority = getCurrentAuthority;
    this._secretHandleBroker = secretHandleBroker;
    this._now = now; this._active = new Map(); this._queue = []; this._disposed = false;
  }

  _activeFor(key) { return [...this._active.values()].filter((item) => item.key === key).length; }
  _queuedFor(key) { return this._queue.filter((item) => item.key === key).length; }
  _canRun(key) { return this._active.size < MAX_GLOBAL_ACTIVE && this._activeFor(key) < MAX_HOST_ACTIVE; }

  invoke(descriptor, args, { signal = null, sessionId = '' } = {}) {
    if (this._disposed) return Promise.resolve(refusal('restricted_runtime_disposed'));
    let inputJson;
    try { inputJson = canonicalJson(args); } catch (error) { return Promise.resolve(refusal(error.message)); }
    if (Buffer.byteLength(inputJson, 'utf8') > MAX_ARGUMENT_BYTES) return Promise.resolve(refusal('restricted_arguments_too_large'));
    if (!descriptor?.compiled_input_schema
      || !validateSchemaInstance(descriptor.compiled_input_schema, args).ok) {
      return Promise.resolve(refusal('restricted_arguments_schema_invalid'));
    }
    const key = `${descriptor.publisher_id}\0${descriptor.plugin_id}\0${descriptor.contribution_id}`;
    if (!this._canRun(key) && (this._queue.length >= MAX_GLOBAL_QUEUE || this._queuedFor(key) >= MAX_HOST_QUEUE)) {
      return Promise.resolve(refusal('restricted_queue_limit_exceeded', true));
    }
    return new Promise((resolve) => {
      const item = { key, descriptor, inputJson, signal, sessionId: String(sessionId || '').trim(), resolve,
        id: Symbol(key), abort: null, host: null, settled: false };
      item.abort = () => {
        const index = this._queue.indexOf(item);
        if (index >= 0) {
          this._queue.splice(index, 1);
          item.settled = true;
          resolve(cancellation());
        } else if (this._active.has(item.id)) {
          item.host?.cancel?.();
        }
      };
      if (signal?.aborted) {
        item.settled = true;
        resolve(cancellation());
        return;
      }
      signal?.addEventListener('abort', item.abort, { once: true });
      if (this._canRun(key)) this._start(item); else this._queue.push(item);
    });
  }

  async _start(item) {
    this._active.set(item.id, item);
    const descriptor = item.descriptor;
    const argumentHash = crypto.createHash('sha256').update(item.inputJson).digest('hex');
    const invocationId = `inv_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64);
    const operationId = `op_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64);
    const cancellationId = `cancel_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64);
    let result;
    try {
      let current = await this._getCurrentAuthority(descriptor, { argument_hash: argumentHash });
      const mismatch = authorityMismatch(descriptor, current, argumentHash);
      if (mismatch) result = refusal(mismatch);
      else {
        const hostResult = await this._hostPool.acquire(descriptor);
        if (!hostResult.ok) result = refusal(hostResult.reason, hostResult.reason?.includes('limit'));
        else {
          item.host = hostResult.host;
          current = await this._getCurrentAuthority(descriptor, { argument_hash: argumentHash });
          const finalMismatch = authorityMismatch(descriptor, current, argumentHash);
          if (finalMismatch) {
            await this._hostPool.invalidate(descriptor);
            result = refusal(finalMismatch);
          } else {
            const timeoutMs = Math.min(descriptor.timeout_ms, 120000);
            const authority = { ...descriptor, process_instance_id: hostResult.host.process_instance_id,
            channel_id: hostResult.host.channel_id, workspace_incarnation_id: current.workspace_incarnation_id,
            purpose: 'restricted_runtime', destination: descriptor.network_origins?.[0] || '',
            deadline_epoch_ms: Date.now() + timeoutMs, invocation_id: invocationId,
            operation_id: operationId, cancellation_id: cancellationId, argument_hash: argumentHash,
            session_id: item.sessionId,
            revocation_generation: current.revocation_generation };
            const token = this._tokenService.mint(authority);
            if (!token.ok) result = refusal(token.reason);
            else if (item.signal?.aborted) result = cancellation();
            else {
              const terminal = await hostResult.host.invoke(
                item.inputJson,
                timeoutMs,
                { ...authority, token_id: token.token_id, signal: item.signal }
              );
              if (item.signal?.aborted) {
                result = cancellation();
              } else if (!terminal?.ok || terminal.status !== 'succeeded' || typeof terminal.result_json !== 'string') {
                result = refusal(terminal?.reason_code || 'restricted_invocation_failed');
              } else if (Buffer.byteLength(terminal.result_json, 'utf8') > MAX_RESULT_BYTES) {
                result = refusal('restricted_result_too_large');
              } else {
                try {
                  const value = JSON.parse(terminal.result_json);
                  result = descriptor.compiled_output_schema
                    && validateSchemaInstance(descriptor.compiled_output_schema, value).ok
                    ? { ok: true, value, invocation_id: invocationId }
                    : refusal('restricted_result_schema_invalid');
                } catch (_error) { result = refusal('restricted_result_json_invalid'); }
              }
            }
          }
        }
      }
    } catch (_error) {
      result = item.signal?.aborted ? cancellation() : refusal('restricted_invocation_failed');
      await this._hostPool.invalidate(descriptor).catch(() => {});
    }
    finally {
      this._tokenService.revokeInvocation(invocationId);
      this._active.delete(item.id); item.signal?.removeEventListener('abort', item.abort);
      if (!item.settled) item.resolve(result);
      item.settled = true;
      this._drain();
    }
  }

  _drain() {
    if (this._disposed) return;
    for (let index = 0; index < this._queue.length;) {
      const item = this._queue[index]; if (!this._canRun(item.key)) { index += 1; continue; }
      this._queue.splice(index, 1); this._start(item);
    }
  }

  snapshot() { return { active: this._active.size, queued: this._queue.length }; }
  async revokeGeneration(generationId) {
    for (const item of [...this._queue]) {
      if (item.descriptor.generation_id === generationId) item.abort();
    }
    for (const item of this._active.values()) {
      if (item.descriptor.generation_id === generationId) item.host?.cancel?.();
    }
    this._tokenService.revokeGeneration(generationId);
    this._secretHandleBroker?.revokeGeneration?.(generationId);
    return this._hostPool.revokeGeneration(generationId);
  }
  async dispose() { this._disposed = true; for (const item of this._queue.splice(0)) { item.signal?.removeEventListener('abort', item.abort); item.settled = true; item.resolve(cancellation()); } this._tokenService.clear(); this._secretHandleBroker?.clear?.(); await this._hostPool.dispose(); }
}

module.exports = {
  MAX_ARGUMENT_BYTES, MAX_RESULT_BYTES, MAX_GLOBAL_ACTIVE, MAX_HOST_ACTIVE,
  MAX_GLOBAL_QUEUE, MAX_HOST_QUEUE, canonicalJson, authorityMismatch, cancellation,
  RestrictedInvocationController,
};
