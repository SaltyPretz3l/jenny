'use strict';

// Bounded, disposable transport replay (H16). Two lanes share one cursor sequence:
//
// - The durable lane holds every stored event except the token-rate `chat_stream` events below. It is bounded by
//   age, bytes, count and per-bucket bytes, evicts oldest first, and its floor alone decides `resync_required`: a
//   cursor at or past the floor replays every durable event after it.
// - The tail lane holds `chat_stream` events of the types in TAIL_STREAM_TYPES (token deltas, thinking status,
//   tool output chunks, test progress). It is bounded by age, its own bytes and count, never evicts a durable event
//   and moves no floor, so a burst of tokens in one conversation cannot force another bucket's client to resync.
//
// A replay sends both lanes merged in cursor order, so a client still receives every event it gets in publish
// order. It may miss tail events that left the tail before the client reconnected: they are forward-only
// refinements of a running turn, which the turn's next aggregate checkpoint or the conversation snapshot's live
// projection repairs. A turn's boundaries (`started`, `stream_reset`, tool events, `complete`, `error`) are durable
// and never skipped. An `ephemeral` publish is live only and lands in neither lane. Eviction is amortized O(1) per event.

const { requireBoundedInteger } = require('./resource-limits');
const { ID_PATTERNS } = require('./team/ids');

// The bucket of an event published with neither a bucket nor a valid `stream_id`.
const DEFAULT_BUCKET = 'host';

const MAX_FRAME_BYTES = 512 * 1024;
const MAX_CLIENT_BYTES = 1024 * 1024;
// Hard maximum for `maxClients`. Single-owner hosts keep the default of 32; a team host passes 64.
const MAX_STREAM_CLIENTS = 64;
// An audience is a team's members; a team holds at most eight, so 64 is a generous ceiling.
const MAX_AUDIENCE = 64;
const BUCKET_PATTERN = /^[A-Za-z0-9_:-]{1,192}$/;
const OPTION_KEYS = new Set(['audience', 'bucket', 'ephemeral']);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
// Each lane holds at most this many events.
const MAX_LANE_EVENTS = 4096;
// The `chat_stream` inner types that ride the tail lane (see the header).
const TAIL_STREAM_TYPES = new Set(['delta', 'thinking_status', 'tool_output_chunk', 'tool_test_progress']);
const isTailEvent = (eventType, payload) => eventType === 'chat_stream'
  && TAIL_STREAM_TYPES.has(payload?.event?.type);

// A FIFO with O(1) push and shift: a head index, compacted once at least half of the array is spent.
class Lane {
  constructor() { this.items = []; this.head = 0; this.bytes = 0; }
  get length() { return this.items.length - this.head; }
  at(index) { return this.items[this.head + index]; }
  push(entry) { this.items.push(entry); this.bytes += entry.bytes; }
  shift() {
    const entry = this.items[this.head];
    this.items[this.head] = undefined;
    this.head += 1;
    this.bytes -= entry.bytes;
    if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return entry;
  }
  clear() { this.items = []; this.head = 0; this.bytes = 0; }
}

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
    streamBytes = 2 * 1024 * 1024, tailBytes = 4 * 1024 * 1024, maxAgeMs = 120_000, maxClients = 32 } = {}) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(bootEpoch || '')) throw new Error('invalid_boot_epoch');
    this.bootEpoch = bootEpoch;
    this.now = now;
    this.maxBytes = requireBoundedInteger(maxBytes, 16 * 1024 * 1024);
    this.streamBytes = requireBoundedInteger(streamBytes, 2 * 1024 * 1024);
    this.tailBytes = requireBoundedInteger(tailBytes, 4 * 1024 * 1024);
    this.maxAgeMs = requireBoundedInteger(maxAgeMs, 120_000);
    this.maxClients = requireBoundedInteger(maxClients, MAX_STREAM_CLIENTS);
    this.cursor = 0;
    this.floor = 0;
    this.durable = new Lane();
    this.tail = new Lane();
    this.streamSizes = new Map();
    this.clients = new Set();
    this.disposed = false;
  }

  // Every stored event of both lanes, merged in cursor order.
  * _stored() {
    const { durable, tail } = this;
    let d = 0;
    let t = 0;
    while (d < durable.length || t < tail.length) {
      yield t >= tail.length || (d < durable.length && durable.at(d).cursor < tail.at(t).cursor)
        ? durable.at(d++) : tail.at(t++);
    }
  }

  // Inspection only (tests, diagnostics): a copy of the stored events in cursor order, and their bytes.
  get events() { return [...this._stored()]; }
  get bytes() { return this.durable.bytes + this.tail.bytes; }

  _frame(type, payload, cursor = this.cursor) {
    const body = JSON.stringify({ ...payload, api_version: 1, boot_epoch: this.bootEpoch, cursor, event_type: type });
    return `id: ${this.bootEpoch}:${cursor}\nevent: jenny\ndata: ${body}\n\n`;
  }

  // `grown`: the bucket a durable publish just added to, the only one that can be over its byte bound (every
  // other bucket was within it after the previous trim, and an eviction only shrinks one).
  _trim(grown = null) {
    const cutoff = this.now() - this.maxAgeMs;
    const { durable, tail } = this;
    while (durable.length && (durable.at(0).at <= cutoff || durable.bytes > this.maxBytes
      || durable.length > MAX_LANE_EVENTS || (grown !== null && this.streamSizes.get(grown) > this.streamBytes))) {
      const removed = durable.shift();
      const remaining = this.streamSizes.get(removed.stream) - removed.bytes;
      if (remaining) this.streamSizes.set(removed.stream, remaining);
      else this.streamSizes.delete(removed.stream);
      this.floor = removed.cursor;
    }
    while (tail.length && (tail.at(0).at <= cutoff || tail.bytes > this.tailBytes || tail.length > MAX_LANE_EVENTS)) {
      tail.shift();
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
      ? payload.stream_id : DEFAULT_BUCKET);
    // An oversized event's resync frame keeps the event's audience.
    const entry = { cursor, frame, bytes: 0, stream, type: eventType, audience, at: this.now() };
    if (!ephemeral) {
      // The stored audience counts toward its lane's byte bounds.
      entry.bytes = Buffer.byteLength(frame) + audienceBytes(audience);
      if (isTailEvent(eventType, payload)) {
        this.tail.push(entry);
        this._trim();
      } else {
        this.durable.push(entry);
        this.streamSizes.set(stream, (this.streamSizes.get(stream) || 0) + entry.bytes);
        this._trim(stream);
      }
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
      this._replay(client, cursor);
    }
    const close = () => this.clients.delete(client);
    response.once('close', close);
    return () => { close(); response.off('close', close); };
  }

  // Both lanes after `cursor`, merged in cursor order; stops at the first failed send.
  _replay(client, cursor) {
    for (const entry of this._stored()) {
      if (entry.cursor > cursor && this._visible(client, entry) && !this._send(client, entry.frame)) return;
    }
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
    this.durable.clear();
    this.tail.clear();
    this.streamSizes.clear();
  }
}

module.exports = { DEFAULT_BUCKET, EventStream, MAX_STREAM_CLIENTS };
