'use strict';

// Eligibility, node choice and the pool summary (row 123, slice 4a-1; spec
// "Choosing a node" and "Model per conversation"). Pure: callers pass node views
// with { node_id, online, paused, slots, busy_slots, last_served_at, order,
// models } or node records with the same fields.

function modelEntry(node, modelId) {
  return node.models.find((entry) => entry.id === modelId) || null;
}

/**
 * Whether `node` may serve a lease for `want` ({ model, wantsVision }).
 * Options: excludedNodeId (the retry exclusion for this conversation key),
 * contextFloor (the pool context length the sidecar loaded; a model below it is
 * not eligible), ignoreSlots (eligibility in principle, used before queueing).
 */
function isEligible(node, want, { excludedNodeId = null, contextFloor = null, ignoreSlots = false } = {}) {
  if (!node.online || node.paused) return false;
  if (!ignoreSlots && node.busy_slots >= node.slots) return false;
  if (excludedNodeId !== null && node.node_id === excludedNodeId) return false;
  const entry = modelEntry(node, want.model);
  if (!entry) return false;
  if (want.wantsVision && entry.vision !== true) return false;
  if (contextFloor !== null && Number.isSafeInteger(entry.context_length) && entry.context_length < contextFloor) {
    return false;
  }
  return true;
}

function servedBefore(a, b) {
  return a.last_served_at - b.last_served_at || a.order - b.order;
}

/**
 * The node to serve `want`: the affinity node if eligible and free, else the
 * eligible node with the oldest last_served_at (registration order breaks ties).
 * Returns null when no eligible node has a free slot.
 */
function chooseNode(nodes, want, { affinityNodeId = null, excludedNodeId = null, contextFloor = null } = {}) {
  const eligible = nodes.filter((node) => isEligible(node, want, { excludedNodeId, contextFloor }));
  if (eligible.length === 0) return null;
  const affinity = affinityNodeId === null ? null : eligible.find((node) => node.node_id === affinityNodeId);
  if (affinity) return affinity;
  return [...eligible].sort(servedBefore)[0];
}

// The slots that can take work: online and not paused. Feeds the lane limits.
function onlineSlots(nodes) {
  return nodes.reduce((sum, node) => (node.online && !node.paused ? sum + node.slots : sum), 0);
}

// The union of online models by id (smallest context length, any vision or
// thinking), the smallest context length overall, and the online slots.
function poolSummary(nodes) {
  const union = new Map();
  for (const node of nodes) {
    if (!node.online) continue;
    for (const entry of node.models) {
      const prior = union.get(entry.id);
      const lengths = [prior?.context_length, entry.context_length].filter((n) => Number.isSafeInteger(n));
      union.set(entry.id, {
        id: entry.id, context_length: lengths.length ? Math.min(...lengths) : null,
        vision: Boolean(prior?.vision || entry.vision), thinking: Boolean(prior?.thinking || entry.thinking),
      });
    }
  }
  const models = [...union.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lengths = models.map((m) => m.context_length).filter((n) => n !== null);
  return {
    models, context_length: lengths.length ? Math.min(...lengths) : null,
    vision: models.some((m) => m.vision), thinking: models.some((m) => m.thinking), online_slots: onlineSlots(nodes),
  };
}

module.exports = { chooseNode, isEligible, modelEntry, onlineSlots, poolSummary };
