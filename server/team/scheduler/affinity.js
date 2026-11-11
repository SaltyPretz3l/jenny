'use strict';

// The affinity map and the retry exclusion (row 123, slice 4a-1; spec "Choosing a
// node" and "Retry"). Both are bounded maps keyed by conversation key. A Map
// keeps insertion order, so re-inserting on use makes the first key the least
// recently used one, which is the one evicted.

function createAffinityMap({ max, idleMs }) {
  // conversation key -> { node_id, last_used_at }; at most `max` entries.
  const entries = new Map();

  function live(key, now) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now - entry.last_used_at >= idleMs) {
      entries.delete(key);
      return null;
    }
    return entry;
  }

  return {
    get(key, now) {
      const entry = live(key, now);
      return entry ? entry.node_id : null;
    },
    set(key, nodeId, now) {
      entries.delete(key);
      while (entries.size >= max) entries.delete(entries.keys().next().value);
      entries.set(key, { node_id: nodeId, last_used_at: now });
    },
    // Refreshes the idle clock of an existing entry without changing its node.
    touch(key, now) {
      const entry = live(key, now);
      if (!entry) return;
      entries.delete(key);
      entries.set(key, { node_id: entry.node_id, last_used_at: now });
    },
    forgetNode(nodeId) {
      for (const [key, entry] of entries) if (entry.node_id === nodeId) entries.delete(key);
    },
    sweep(now) {
      for (const key of [...entries.keys()]) live(key, now);
    },
  };
}

function createExclusions({ max, ttlMs }) {
  // conversation key -> { node_id, until }; at most `max` entries.
  const entries = new Map();

  function live(key, now) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now >= entry.until) {
      entries.delete(key);
      return null;
    }
    return entry;
  }

  return {
    exclude(key, nodeId, now) {
      entries.delete(key);
      while (entries.size >= max) entries.delete(entries.keys().next().value);
      entries.set(key, { node_id: nodeId, until: now + ttlMs });
    },
    get(key, now) {
      const entry = live(key, now);
      return entry ? entry.node_id : null;
    },
    clear(key) {
      entries.delete(key);
    },
    sweep(now) {
      for (const key of [...entries.keys()]) live(key, now);
    },
  };
}

module.exports = { createAffinityMap, createExclusions };
