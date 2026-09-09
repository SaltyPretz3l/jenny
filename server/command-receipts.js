'use strict';

const { createHash } = require('node:crypto');
const { readJson, writeJson } = require('../services/host/durable-json');
const { hostFailure } = require('./api-contract');
const { requireBoundedInteger } = require('./resource-limits');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// These are operation receipts, never conversation history. Pending records
// recovered after a crash remain indeterminate; the host must not repeat them.
class CommandReceipts {
  constructor({ filePath, now = Date.now, capacity = 10_000, ttlMs = 86_400_000, write = writeJson }) {
    this.filePath = filePath;
    this.now = now;
    this.capacity = requireBoundedInteger(capacity, 10_000);
    this.ttlMs = requireBoundedInteger(ttlMs, 86_400_000);
    this.write = write;
    this.running = new Map();
    this.broken = false;
    const stored = readJson(filePath, { maxBytes: 64 * 1024 * 1024 });
    if (stored && (stored.schema_version !== 1 || !Array.isArray(stored.receipts)
      || stored.receipts.length > capacity || stored.receipts.some((entry) =>
        !entry || typeof entry.key !== 'string' || entry.key.length > 300
        || !/^[a-f0-9]{64}$/.test(entry.digest) || !Number.isSafeInteger(entry.created_at)
        || entry.created_at < 0 || entry.created_at > now() + 300_000
        || !['pending', 'settled'].includes(entry.state)
        || (entry.state === 'settled' && (!entry.result || typeof entry.result.ok !== 'boolean'
          || Buffer.byteLength(JSON.stringify(entry.result)) > 4096))))) {
      throw Object.assign(new Error('invalid_receipt_store'), { code: 'CMP-HOST-0006' });
    }
    this.entries = new Map((stored?.receipts || []).map((entry) => [entry.key, entry]));
    if (this.entries.size !== (stored?.receipts.length || 0)) {
      throw Object.assign(new Error('duplicate_receipt_identity'), { code: 'CMP-HOST-0006' });
    }
  }

  _save() {
    try { this.write(this.filePath, { schema_version: 1, receipts: [...this.entries.values()] }); }
    catch (error) { this.broken = true; throw new Error('receipt_write_failed', { cause: error }); }
  }

  _expireSettled(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.state !== 'settled' || this.running.has(key)
      || entry.created_at + this.ttlMs > this.now()) return false;
    this.entries.delete(key);
    this._save();
    return true;
  }

  lookup(command, deviceId) {
    if (this.broken) return { found: true,
      result: hostFailure('persistence', 'receipt_store_unavailable', command.request_id) };
    const key = `${deviceId}:${command.request_id}`;
    try { this._expireSettled(key); }
    catch (_error) { return { found: true,
      result: hostFailure('persistence', 'receipt_store_unavailable', command.request_id) }; }
    const previous = this.entries.get(key);
    if (!previous) return { found: false };
    const digest = createHash('sha256').update(stableJson(command)).digest('hex');
    if (previous.digest !== digest) return { found: true,
      result: hostFailure('conflict', 'request_payload_changed', command.request_id) };
    return { found: true, result: this.running.get(key) || (previous.state === 'settled'
      ? structuredClone(previous.result) : hostFailure('conflict', 'operation_indeterminate', command.request_id)) };
  }

  status(requestId, deviceId) {
    if (this.broken) return hostFailure('persistence', 'receipt_store_unavailable', requestId);
    const key = `${deviceId}:${requestId}`;
    try { this._expireSettled(key); }
    catch (_error) { return hostFailure('persistence', 'receipt_store_unavailable', requestId); }
    const entry = this.entries.get(key);
    if (!entry) return { ok: true, state: 'unknown' };
    if (entry.state === 'settled') return { ok: true, state: 'settled', result: structuredClone(entry.result) };
    return { ok: true, state: this.running.has(key) ? 'pending' : 'indeterminate' };
  }

  async run(command, deviceId, execute) {
    const requestId = command.request_id;
    if (this.broken) return hostFailure('persistence', 'receipt_store_unavailable', requestId);
    const key = `${deviceId}:${requestId}`;
    const digest = createHash('sha256').update(stableJson(command)).digest('hex');
    const previous = this.lookup(command, deviceId);
    if (previous.found) return previous.result;
    const now = this.now();
    for (const [entryKey, entry] of this.entries) {
      if (entry.state === 'settled' && !this.running.has(entryKey)
        && entry.created_at + this.ttlMs <= now) this.entries.delete(entryKey);
    }
    if (this.entries.size >= this.capacity) return hostFailure('limit', 'receipt_capacity', requestId);
    const entry = { key, digest, created_at: now, state: 'pending' };
    this.entries.set(key, entry);
    try { this._save(); }
    catch (_error) { return hostFailure('persistence', 'receipt_store_unavailable', requestId); }
    // Schedule after installing the promise so same-tick retries also join it.
    const result = Promise.resolve().then(async () => {
      try {
        const outcome = await execute();
        if (!outcome || typeof outcome.ok !== 'boolean' || Buffer.byteLength(JSON.stringify(outcome)) > 4096) {
          return hostFailure('conflict', 'operation_indeterminate', requestId);
        }
        entry.state = 'settled';
        entry.result = structuredClone(outcome);
        this._save();
        return outcome;
      } catch (_error) {
        // Side effect may have completed. Leave the durable pending receipt.
        return hostFailure(this.broken ? 'persistence' : 'conflict',
          this.broken ? 'receipt_store_unavailable' : 'operation_indeterminate', requestId);
      } finally { this.running.delete(key); }
    });
    this.running.set(key, result);
    return result;
  }
}

module.exports = { CommandReceipts };
