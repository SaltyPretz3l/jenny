'use strict';

const crypto = require('node:crypto');

const MAX_CONTROL_FRAME_BYTES = 128 * 1024;
const MAX_LOAD_FRAME_BYTES = 86 * 1024 * 1024;
const MAX_BUFFERED_BYTES = (2 * MAX_CONTROL_FRAME_BYTES) + 8;
const MAX_PENDING_READS = 64;

function digestText(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function macInput(channelId, sequence, kind, payloadDigest) {
  return Buffer.from(`${channelId}\0${sequence}\0${kind}\0${payloadDigest}`, 'utf8');
}

function signFrame(key, { channelId, sequence, kind, payload }) {
  const payloadJson = JSON.stringify(payload);
  const payloadDigest = digestText(payloadJson);
  return {
    channel_id: channelId,
    sequence,
    kind,
    payload_json: payloadJson,
    payload_digest: payloadDigest,
    mac: crypto.createHmac('sha256', key).update(macInput(channelId, sequence, kind, payloadDigest)).digest('hex'),
  };
}

function verifyFrame(key, frame, { channelId, sequence, kind = null } = {}) {
  if (!frame || frame.channel_id !== channelId || frame.sequence !== sequence
    || (kind !== null && frame.kind !== kind) || typeof frame.payload_json !== 'string') {
    return { ok: false, reason: 'authenticated_frame_identity_rejected' };
  }
  const payloadDigest = digestText(frame.payload_json);
  if (payloadDigest !== frame.payload_digest || !/^[0-9a-f]{64}$/.test(String(frame.mac || ''))) {
    return { ok: false, reason: 'authenticated_frame_digest_rejected' };
  }
  const expected = crypto.createHmac('sha256', key)
    .update(macInput(channelId, sequence, frame.kind, payloadDigest)).digest();
  const presented = Buffer.from(frame.mac, 'hex');
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'authenticated_frame_mac_rejected' };
  }
  try { return { ok: true, payload: JSON.parse(frame.payload_json), kind: frame.kind }; }
  catch (_error) { return { ok: false, reason: 'authenticated_frame_payload_rejected' }; }
}

function encodeFrame(value, maximum = MAX_CONTROL_FRAME_BYTES) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length === 0 || body.length > maximum) throw new Error('channel_frame_size_rejected');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

class FrameReader {
  constructor(stream, { maxBufferedBytes = MAX_BUFFERED_BYTES } = {}) {
    this._stream = stream;
    this._buffer = Buffer.alloc(0);
    this._waiters = [];
    this._closedError = null;
    this._maxBufferedBytes = maxBufferedBytes;
    stream.on('data', (chunk) => {
      if (this._closedError) return;
      if (!Buffer.isBuffer(chunk) || this._buffer.length + chunk.length > this._maxBufferedBytes) {
        this._close(new Error('channel_buffer_limit_rejected'));
        stream.destroy();
        return;
      }
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._drain();
    });
    const close = () => this._close(new Error('channel_closed'));
    stream.once('error', close);
    stream.once('close', close);
  }

  read(maximum = MAX_CONTROL_FRAME_BYTES) {
    if (this._closedError) return Promise.reject(this._closedError);
    if (this._waiters.length >= MAX_PENDING_READS) {
      const error = new Error('channel_read_queue_limit_rejected');
      this._close(error);
      this._stream.destroy();
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject, maximum });
      this._drain();
    });
  }

  _drain() {
    while (this._waiters.length && this._buffer.length >= 4) {
      const waiter = this._waiters[0];
      const length = this._buffer.readUInt32BE(0);
      if (length === 0 || length > waiter.maximum) {
        this._waiters.shift().reject(new Error('channel_frame_size_rejected'));
        this._stream.destroy();
        continue;
      }
      if (this._buffer.length < 4 + length) return;
      this._waiters.shift();
      const body = this._buffer.subarray(4, 4 + length);
      this._buffer = this._buffer.subarray(4 + length);
      try { waiter.resolve(JSON.parse(body.toString('utf8'))); }
      catch (_error) { waiter.reject(new Error('channel_frame_json_rejected')); }
    }
  }

  _close(error) {
    if (this._closedError) return;
    this._closedError = error;
    this._buffer = Buffer.alloc(0);
    for (const waiter of this._waiters.splice(0)) waiter.reject(error);
  }
}

class AuthenticatedChannel {
  constructor(stream, { key, channelId } = {}) {
    this._stream = stream;
    this._reader = new FrameReader(stream);
    this._key = key;
    this._channelId = channelId;
    this._outgoing = 0;
    this._incoming = 0;
  }

  writeBootstrap(payload) { this._stream.write(encodeFrame(payload)); }

  send(kind, payload, maximum = MAX_CONTROL_FRAME_BYTES) {
    const frame = signFrame(this._key, { channelId: this._channelId, sequence: this._outgoing, kind, payload });
    this._outgoing += 1;
    this._stream.write(encodeFrame(frame, maximum));
  }

  async receive({ kind = null, maximum = MAX_CONTROL_FRAME_BYTES } = {}) {
    const frame = await this._reader.read(maximum);
    const result = verifyFrame(this._key, frame, { channelId: this._channelId, sequence: this._incoming, kind });
    if (!result.ok) { this._stream.destroy(); throw new Error(result.reason); }
    this._incoming += 1;
    return result;
  }

  destroy() { this._stream.destroy(); }
}

module.exports = {
  MAX_CONTROL_FRAME_BYTES, MAX_LOAD_FRAME_BYTES, MAX_BUFFERED_BYTES, MAX_PENDING_READS,
  digestText, signFrame, verifyFrame, encodeFrame, FrameReader, AuthenticatedChannel,
};
