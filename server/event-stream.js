'use strict';

const { requireBoundedInteger } = require('./resource-limits');

const MAX_FRAME_BYTES = 512 * 1024;
const MAX_CLIENT_BYTES = 1024 * 1024;

// Bounded, disposable transport replay. This never writes conversation files.
class EventStream {
  constructor({ bootEpoch, now = Date.now, maxBytes = 16 * 1024 * 1024,
    streamBytes = 2 * 1024 * 1024, maxAgeMs = 120_000, maxClients = 32 } = {}) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(bootEpoch || '')) throw new Error('invalid_boot_epoch');
    this.bootEpoch = bootEpoch;
    this.now = now;
    this.maxBytes = requireBoundedInteger(maxBytes, 16 * 1024 * 1024);
    this.streamBytes = requireBoundedInteger(streamBytes, 2 * 1024 * 1024);
    this.maxAgeMs = requireBoundedInteger(maxAgeMs, 120_000);
    this.maxClients = requireBoundedInteger(maxClients, 32);
    this.cursor = 0;
    this.floor = 0;
    this.bytes = 0;
    this.events = [];
    this.streamSizes = new Map();
    this.clients = new Set();
    this.disposed = false;
  }

  _frame(type, payload, cursor = this.cursor) {
    const body = JSON.stringify({ ...payload, api_version: 1, boot_epoch: this.bootEpoch, cursor, event_type: type });
    return `id: ${this.bootEpoch}:${cursor}\nevent: jenny\ndata: ${body}\n\n`;
  }

  _trim() {
    const cutoff = this.now() - this.maxAgeMs;
    while (this.events.length && (this.events[0].at <= cutoff || this.bytes > this.maxBytes
      || this.events.length > 4096 || [...this.streamSizes.values()].some((size) => size > this.streamBytes))) {
      const removed = this.events.shift();
      this.bytes -= removed.bytes;
      const remaining = this.streamSizes.get(removed.stream) - removed.bytes;
      if (remaining) this.streamSizes.set(removed.stream, remaining);
      else this.streamSizes.delete(removed.stream);
      this.floor = removed.cursor;
    }
  }

  _send(client, frame) {
    try {
      if (!client.authorized() || client.response.destroyed || client.response.writableEnded) throw new Error('client_unavailable');
      if (client.response.writableLength + Buffer.byteLength(frame) > MAX_CLIENT_BYTES) throw new Error('slow_client');
      client.response.write(frame);
      return true;
    } catch (_error) {
      this.clients.delete(client);
      client.response.destroy();
      return false;
    }
  }

  publish(eventType, payload = {}) {
    if (this.disposed) return;
    if (!/^[a-z][a-z_]{0,63}$/.test(eventType)) throw new Error('invalid_event_type');
    if (this.cursor >= Number.MAX_SAFE_INTEGER) { this.dispose(); return; }
    const cursor = ++this.cursor;
    let frame = this._frame(eventType, payload, cursor);
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      frame = this._frame('resync_required', { reason: 'event_size_limit' }, cursor);
    }
    const stream = typeof payload.stream_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.stream_id)
      ? payload.stream_id : 'host';
    const bytes = Buffer.byteLength(frame);
    this.events.push({ cursor, frame, bytes, stream, at: this.now() });
    this.bytes += bytes;
    this.streamSizes.set(stream, (this.streamSizes.get(stream) || 0) + bytes);
    this._trim();
    for (const client of this.clients) this._send(client, frame);
  }

  subscribe({ response, deviceId, authorized, bootEpoch, cursor, onAdmit, onReject }) {
    const rejection = this.disposed ? 'unavailable' : !authorized() ? 'forbidden'
      : this.clients.size >= this.maxClients ? 'limit' : null;
    if (rejection) { onReject?.(rejection); return null; }
    // Admission and header commitment are synchronous with replay/publish.
    // A rejected subscriber must still be able to return a typed HTTP error.
    onAdmit?.();
    this._trim();
    const client = { response, deviceId, authorized };
    this.clients.add(client);
    // Registration and replay are synchronous with publish(), closing the
    // snapshot-to-subscription gap. A missing prefix requires a new snapshot.
    if (bootEpoch !== this.bootEpoch || !Number.isSafeInteger(cursor) || cursor < this.floor || cursor > this.cursor) {
      this._send(client, this._frame('resync_required', { reason: 'replay_unavailable' }));
    } else {
      for (const entry of this.events) {
        if (entry.cursor > cursor && !this._send(client, entry.frame)) break;
      }
    }
    const close = () => this.clients.delete(client);
    response.once('close', close);
    return () => { close(); response.off('close', close); };
  }

  heartbeat() {
    this._trim();
    for (const client of this.clients) this._send(client, ': heartbeat\n\n');
  }

  revokeDevice(deviceId) {
    for (const client of this.clients) {
      if (client.deviceId === deviceId) { this.clients.delete(client); client.response.destroy(); }
    }
  }

  dispose() {
    this.disposed = true;
    for (const client of this.clients) client.response.destroy();
    this.clients.clear();
    this.events.length = 0;
    this.streamSizes.clear();
    this.bytes = 0;
  }
}

module.exports = { EventStream };
