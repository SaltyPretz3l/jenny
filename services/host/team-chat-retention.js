'use strict';

// Team chat retention (row 123 slice 2a-1, TEAM_CHAT_SPEC "Store"): per channel
// 50,000 messages or 365 days, whichever comes first; the whole team-chat tree
// 2 GiB. Pruning removes whole oldest segments only (a prefix, so floor_seq
// stays one number) and never a segment a mutation is writing or the current
// head. Pure planning over segment metadata; the store applies the plan (the
// room a request needs is planned in team-chat-room.js).

const { LIMITS } = require('./team-chat-schema');

const DAY_MS = 24 * 60 * 60 * 1000;

// The defaults, and the ceiling of every override.
const RETENTION_LIMITS = Object.freeze({
  maxMessages: 50000,
  maxAgeMs: 365 * DAY_MS,
  treeMaxBytes: 2 * 1024 ** 3,
  // Slice 2c host: the team's attachment blobs (staged and attached); their bytes count toward treeMaxBytes as well.
  attachmentMaxBytes: 1024 ** 3,
  attachmentMaxFiles: 50000,
  segmentMaxMessages: LIMITS.SEGMENT_MAX_MESSAGES,
  segmentMaxBytes: LIMITS.SEGMENT_MAX_BYTES,
});

const sumBytes = (segments) => segments.reduce((sum, meta) => sum + meta.bytes, 0);
const headOnly = (segments) => new Set(segments.length ? [segments[segments.length - 1].n] : []);

// Limits can only be lowered (the owner's Settings, or a test); an unknown key,
// a non-integer or a raise is a programming error and throws.
function resolveLimits(overrides = {}) {
  const resolved = { ...RETENTION_LIMITS };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!Object.prototype.hasOwnProperty.call(RETENTION_LIMITS, key)
      || !Number.isSafeInteger(value) || value < 1 || value > RETENTION_LIMITS[key]) {
      throw new TypeError(`invalid retention limit: ${key}`);
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

// How many of the channel's oldest segments to remove so that, with `incoming`
// new messages, the channel holds at most maxMessages and no removable segment
// whose newest message is older than maxAgeMs. Stops at the first protected
// segment so the removal is always a prefix.
function planChannelPrune({ segments, protectedNs, now, limits, incoming = 0 }) {
  let count = segments.reduce((sum, meta) => sum + meta.count, 0);
  const cutoff = now - limits.maxAgeMs;
  let k = 0;
  while (k < segments.length) {
    const meta = segments[k];
    if (protectedNs.has(meta.n)) break;
    const overCount = count + incoming > limits.maxMessages;
    const aged = meta.newest_at < cutoff;
    if (!overCount && !aged) break;
    count -= meta.count;
    k += 1;
  }
  return k;
}

// The ids a prune removes from a channel's visible entries (seq order): all
// below the floor, and every reply at or above it whose root is below it (a
// thread root is pruned with its replies).
function prunedThreads(entries, floorSeq) {
  const removedIds = new Set();
  const orphanIds = new Set();
  for (const entry of entries) {
    if (entry.seq < floorSeq) removedIds.add(entry.id);
    else if (entry.root !== null && removedIds.has(entry.root)) orphanIds.add(entry.id);
  }
  return { removedIds, orphanIds };
}

// A sweep with no mutation: each healthy channel's count and age limits with
// its head kept. Returns [[channel_id, prefix length]] to apply in order. The
// tree limit (segments and attachment blobs) is planned after it by the store
// (team-chat-room.js, review round two), which credits the blobs a prune frees.
function planSweep({ states, now, limits }) {
  const removals = [];
  for (const state of states) {
    if (state.broken) continue;
    const own = planChannelPrune({ segments: state.doc.segments, protectedNs: headOnly(state.doc.segments), now, limits });
    if (own > 0) removals.push([state.doc.channel_id, own]);
  }
  return removals;
}

module.exports = {
  RETENTION_LIMITS,
  headOnly,
  resolveLimits,
  planChannelPrune,
  planSweep,
  prunedThreads,
  sumBytes,
};
