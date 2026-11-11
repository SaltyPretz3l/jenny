'use strict';

const { requireBoundedInteger } = require('./resource-limits');
const { ID_PATTERNS } = require('./team/ids');

const MAX_FRAME_BYTES = 512 * 1024;
const MAX_CLIENT_BYTES = 1024 * 1024;
// Hard maximum for `maxClients`. Single-owner hosts keep the default of 32; a team host passes 64.
const MAX_STREAM_CLIENTS = 64;
// An audience is a team's members; a team holds at most eight, so 64 is a generous ceiling.
const MAX_AUDIENCE = 64;
const BUCKET_PATTERN = /^[A-Za-z0-9_:-]{1,192}$/;
const OPTION_KEYS = new Set(['audience', 'bucket', 'ephemeral']);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Publish options (TEAM_CHAT_SPEC "Events"). No options is today's broadcast. A key
// that is present must be valid: a malformed audience is refused, never widened.
function readPublishOptions(options) {
  if (options === undefined) return { audience: null, bucket: null, ephemeral: false };
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !OPTION_KEYS.has(key))
    || (has(options, 'ephemeral') && typeof options.ephemeral !== 'boolean')) throw new Error('invalid_publish_options');
  if (has(options, 'bucket') && !(typeof options.bucket === 'string' && BUCKET_PATTERN.test(options.bucket))) {
    throw new Error('invalid_event_bucket');
  }
  let audience = null;
  if (has(options, 'audience')) {
    if (!(options.audience instanceof Set)) throw new Error('invalid_event_audience');
    // A private copy: a caller changing its set afterwards cannot widen a stored event.
    audience = new Set(options.audience);
    if (audience.size > MAX_AUDIENCE) throw new Error('invalid_event_audience');
    for (const memberId of audience) {
      if (typeof memberId !== 'string' || !ID_PATTERNS.member.test(memberId)) throw new Error('invalid_event_audience');
    }
  }
  return { audience, bucket: options.bucket ?? null, ephemeral: options.ephemeral === true };
}

// A subscription's member identity, captured once. Without a valid member id and a
// membership predicate the subscription sees no audience-scoped event.
function readIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const { memberId, mayReceive } = identity;
  if (typeof memberId !== 'string' || !ID_PATTERNS.member.test(memberId) || typeof mayReceive !== 'function') return null;
  return Object.freeze({ memberId, mayReceive });
}

function audienceBytes(audience) {
  let bytes = 0;
  if (audience) for (const memberId of audience) bytes += memberId.length;
  return bytes;
}

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
    this.maxClients = requireBoundedInteger(maxClients, MAX_STREAM_CLIENTS);
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

  // The one delivery rule, for live send and replay alike. A no-audience event goes to
  // everyone, as before. An audience event needs the subscriber's member id in the
  // stored audience AND the caller's membership predicate to answer exactly true now.
  _visible(client, entry) {
    if (entry.audience === null) return true;
    const identity = client.identity;
    if (!identity || !entry.audience.has(identity.memberId)) return false;
    try {
      return identity.mayReceive(identity.memberId, { type: entry.type, bucket: entry.stream }) === true;
    } catch (_error) {
      return false;
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

  // options: { audience: Set of member ids, bucket: replay bucket, ephemeral: live only }.
  publish(eventType, payload = {}, options = undefined) {
    if (this.disposed) return;
    if (!/^[a-z][a-z_]{0,63}$/.test(eventType)) throw new Error('invalid_event_type');
    const { audience, bucket, ephemeral } = readPublishOptions(options);
    if (this.cursor >= Number.MAX_SAFE_INTEGER) { this.dispose(); return; }
    const cursor = ++this.cursor;
    let frame = this._frame(eventType, payload, cursor);
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      frame = this._frame('resync_required', { reason: 'event_size_limit' }, cursor);
    }
    const stream = bucket || (typeof payload.stream_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.stream_id)
      ? payload.stream_id : 'host');
    // An oversized event's resync frame keeps the event's audience.
    const entry = { cursor, frame, bytes: 0, stream, type: eventType, audience, at: this.now() };
    if (!ephemeral) {
      // The stored audience counts toward the per-bucket and overall byte bounds.
      entry.bytes = Buffer.byteLength(frame) + audienceBytes(audience);
      this.events.push(entry);
      this.bytes += entry.bytes;
      this.streamSizes.set(stream, (this.streamSizes.get(stream) || 0) + entry.bytes);
      this._trim();
    }
    for (const client of this.clients) if (this._visible(client, entry)) this._send(client, frame);
  }

  // identity: optional { memberId, mayReceive(memberId, { type, bucket }) } (see _visible).
  subscribe({ response, deviceId, authorized, bootEpoch, cursor, onAdmit, onReject, identity }) {
    const rejection = this.disposed ? 'unavailable' : !authorized() ? 'forbidden'
      : this.clients.size >= this.maxClients ? 'limit' : null;
    if (rejection) { onReject?.(rejection); return null; }
    // Admission and header commitment are synchronous with replay/publish.
    // A rejected subscriber must still be able to return a typed HTTP error.
    onAdmit?.();
    this._trim();
    const client = { response, deviceId, authorized, identity: readIdentity(identity) };
    this.clients.add(client);
    // Registration and replay are synchronous with publish(), closing the
    // snapshot-to-subscription gap. A missing prefix requires a new snapshot.
    if (bootEpoch !== this.bootEpoch || !Number.isSafeInteger(cursor) || cursor < this.floor || cursor > this.cursor) {
      this._send(client, this._frame('resync_required', { reason: 'replay_unavailable' }));
    } else {
      for (const entry of this.events) {
        if (entry.cursor > cursor && this._visible(client, entry) && !this._send(client, entry.frame)) break;
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

module.exports = { EventStream, MAX_STREAM_CLIENTS };
