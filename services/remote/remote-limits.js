'use strict';

const PAIRING_WINDOW_MS = 120_000;
const PAIRING_FAILURES_MAX = 5;
const MAX_DEVICES = 5;
const ACCESS_SESSION_MS = 900_000;
const COMMANDS_PER_MIN = 30;
const COMMANDS_BURST = 10;
const SENDS_PER_MIN = 6;
const SESSION_CREATES_PER_HOUR = 5;
const PROMPT_MAX_BYTES = 16_384;
// FRAME_MAX_BYTES is the complete serialized wire message (JSON envelope +
// base64url ciphertext), measured by every sender and receiver before parsing.
// 1 MiB matches the relay platform's WebSocket message ceiling.
const FRAME_MAX_BYTES = 1_048_576;
const FRAME_HEADER_BUDGET_BYTES = 512;
// Largest plaintext a single sealed frame may carry: the ciphertext budget
// decoded from base64url minus the 16-byte AES-GCM tag.
const FRAME_PLAINTEXT_MAX_BYTES = Math.floor(((FRAME_MAX_BYTES - FRAME_HEADER_BUDGET_BYTES) * 3) / 4) - 16;
const PENDING_COMMANDS_MAX = 16;
const TRANSCRIPT_PAGE_MAX_MESSAGES = 50;
const TRANSCRIPT_PAGE_MAX_BYTES = 262_144;
const OUTBOUND_QUEUE_MAX_BYTES = 1_048_576;
const REPLAY_MAX_BYTES = 2_097_152;
const REPLAY_MAX_MS = 120_000;
const DELTA_COALESCE_MS = 50;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const HEARTBEAT_MS = 20_000;
const RELAY_ONLINE_LEASE_MS = 30_000;
const RATE_LIMITER_MAX_KEYS = 256;

function assertPositiveFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}

function createRateLimiter({ perMinute, burst, now = Date.now } = {}) {
  assertPositiveFinite(perMinute, 'perMinute');
  assertPositiveFinite(burst, 'burst');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const buckets = new Map();
  const refillPerMs = perMinute / 60_000;

  // At capacity only a bucket that has fully refilled may be evicted; an
  // exhausted identity must never regain its burst by being pushed out and
  // re-created (keys are authenticated device ids, never per-request values).
  function evictRefilledIfFull(currentTime) {
    if (buckets.size < RATE_LIMITER_MAX_KEYS) return true;
    for (const [key, bucket] of buckets) {
      const elapsed = Math.max(0, currentTime - bucket.updatedAt);
      if (bucket.tokens + (elapsed * refillPerMs) >= burst) {
        buckets.delete(key);
        return true;
      }
    }
    return false;
  }

  function take(key) {
    if (typeof key !== 'string') return false;
    const currentTime = Number(now());
    if (!Number.isFinite(currentTime)) throw new TypeError('now must return a finite number');

    let bucket = buckets.get(key);
    if (!bucket) {
      if (!evictRefilledIfFull(currentTime)) return false;
      bucket = { tokens: burst, updatedAt: currentTime };
      buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, currentTime - bucket.updatedAt);
      bucket.tokens = Math.min(burst, bucket.tokens + (elapsed * refillPerMs));
      bucket.updatedAt = Math.max(bucket.updatedAt, currentTime);
    }

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  function reset(key) {
    if (typeof key === 'string') buckets.delete(key);
  }

  return Object.freeze({ take, reset, size: () => buckets.size });
}

module.exports = Object.freeze({
  PAIRING_WINDOW_MS,
  PAIRING_FAILURES_MAX,
  MAX_DEVICES,
  ACCESS_SESSION_MS,
  COMMANDS_PER_MIN,
  COMMANDS_BURST,
  SENDS_PER_MIN,
  SESSION_CREATES_PER_HOUR,
  PROMPT_MAX_BYTES,
  FRAME_MAX_BYTES,
  FRAME_HEADER_BUDGET_BYTES,
  FRAME_PLAINTEXT_MAX_BYTES,
  PENDING_COMMANDS_MAX,
  TRANSCRIPT_PAGE_MAX_MESSAGES,
  TRANSCRIPT_PAGE_MAX_BYTES,
  OUTBOUND_QUEUE_MAX_BYTES,
  REPLAY_MAX_BYTES,
  REPLAY_MAX_MS,
  DELTA_COALESCE_MS,
  RECONNECT_BACKOFF_MAX_MS,
  HEARTBEAT_MS,
  RELAY_ONLINE_LEASE_MS,
  createRateLimiter,
});
