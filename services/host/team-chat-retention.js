'use strict';

// Team chat retention (row 123 slice 2a-1, TEAM_CHAT_SPEC "Store"): per channel
// 50,000 messages or 365 days, whichever comes first; the whole team-chat tree
// 2 GiB. Pruning removes whole oldest segments only (a prefix, so floor_seq
// stays one number) and never a segment a mutation is writing or the current
// head. Pure planning over segment metadata; the store applies the plan.

const { LIMITS } = require('./team-chat-schema');

const DAY_MS = 24 * 60 * 60 * 1000;

// The defaults, and the ceiling of every override.
const RETENTION_LIMITS = Object.freeze({
  maxMessages: 50000,
  maxAgeMs: 365 * DAY_MS,
  treeMaxBytes: 2 * 1024 ** 3,
  segmentMaxMessages: LIMITS.SEGMENT_MAX_MESSAGES,
  segmentMaxBytes: LIMITS.SEGMENT_MAX_BYTES,
});

const sumBytes = (segments) => segments.reduce((sum, meta) => sum + meta.bytes, 0);
const headOnly = (segments) => new Set(segments.length ? [segments[segments.length - 1].n] : []);
const allOf = (segments) => new Set(segments.map((meta) => meta.n));

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

// Removes the globally oldest removable segments (by newest message, then
// channel id) until `total - freed + delta <= maxBytes`. `channels[i].skip` is
// how many leading segments are already planned for removal; `total` already
// excludes them. Returns the full per-channel prefix lengths, or { ok: false }
// when no plan makes room (nothing is applied).
function planTreePrune({ channels, total, delta, maxBytes }) {
  const cursors = channels.map((channel) => channel.skip || 0);
  let freed = 0;
  while (total - freed + delta > maxBytes) {
    let best = -1;
    for (let i = 0; i < channels.length; i += 1) {
      const meta = channels[i].segments[cursors[i]];
      if (!meta || channels[i].protectedNs.has(meta.n)) continue;
      if (best === -1) { best = i; continue; }
      const current = channels[best].segments[cursors[best]];
      const older = meta.newest_at - current.newest_at
        || (channels[i].channel_id < channels[best].channel_id ? -1 : 1);
      if (older < 0) best = i;
    }
    if (best === -1) return { ok: false };
    freed += channels[best].segments[cursors[best]].bytes;
    cursors[best] += 1;
  }
  const removals = new Map();
  channels.forEach((channel, i) => { if (cursors[i] > 0) removals.set(channel.channel_id, cursors[i]); });
  return { ok: true, removals };
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

// A channel's place in tree planning: a broken channel is never pruned.
const treeEntry = (state, protectedNs) => ({
  channel_id: state.doc.channel_id, segments: state.doc.segments,
  protectedNs: state.broken ? allOf(state.doc.segments) : protectedNs,
});

// The pruning one mutation needs, planned from segment metadata only: the
// target channel's own count and age limits, then the tree byte limit across
// every channel (others keep their head). Returns Map(channel_id -> prefix
// length), or null when no plan makes room.
function planRoom({ states, target, protectedNs, incoming, delta, now, limits }) {
  const own = planChannelPrune({ segments: target.doc.segments, protectedNs, now, limits, incoming });
  const removals = new Map(own > 0 ? [[target.doc.channel_id, own]] : []);
  const total = states.reduce((sum, state) => sum + state.doc.bytes, 0) - sumBytes(target.doc.segments.slice(0, own));
  if (total + delta <= limits.treeMaxBytes) return removals;
  const channels = states.map((state) => ({
    ...treeEntry(state, state === target ? protectedNs : headOnly(state.doc.segments)),
    skip: removals.get(state.doc.channel_id),
  }));
  const plan = planTreePrune({ channels, total, delta, maxBytes: limits.treeMaxBytes });
  return plan.ok ? plan.removals : null;
}

// A sweep with no mutation: each healthy channel's count and age limits with
// its head kept, then the tree limit if still over (best effort: nothing when
// no plan fits). Returns [[channel_id, prefix length]] to apply in order.
function planSweep({ states, now, limits }) {
  const removals = new Map();
  for (const state of states) {
    if (state.broken) continue;
    const own = planChannelPrune({ segments: state.doc.segments, protectedNs: headOnly(state.doc.segments), now, limits });
    if (own > 0) removals.set(state.doc.channel_id, own);
  }
  const total = states.reduce((sum, state) => sum + state.doc.bytes
    - sumBytes(state.doc.segments.slice(0, removals.get(state.doc.channel_id) || 0)), 0);
  if (total > limits.treeMaxBytes) {
    const plan = planTreePrune({ total, delta: 0, maxBytes: limits.treeMaxBytes,
      channels: states.map((state) => ({ ...treeEntry(state, headOnly(state.doc.segments)),
        skip: removals.get(state.doc.channel_id) })) });
    if (plan.ok) return [...plan.removals];
  }
  return [...removals];
}

module.exports = {
  RETENTION_LIMITS,
  headOnly,
  resolveLimits,
  planChannelPrune,
  planRoom,
  planSweep,
  planTreePrune,
  prunedThreads,
  sumBytes,
};
