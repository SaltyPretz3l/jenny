'use strict';

// Eligibility, node choice and the pool summary (row 123, slice 4a-1; spec
// "Choosing a node" and "Model per conversation"). Pure: callers pass node views
// with { node_id, online, paused, slots, busy_slots, last_served_at, order,
// models } or node records with the same fields.

function modelEntry(node, modelId) {
  return node.models.find((entry) => entry.id === modelId) || null;
}

/**
 * Whether `node` may serve a lease for `want` ({ model, wantsVision,
 * allowedNodes }). `allowedNodes` is null or absent for any node, else the node
 * ids the lease may use. Options: excludedNodeIds
 * (the retry exclusions for this conversation key), ignoreSlots (eligibility in
 * principle, used before queueing), permit (a last check, asked only of a node
 * that passed every other test: false refuses it; the host's re-check that a
 * node's owner may read the conversation). A model's context length never
 * decides eligibility: each turn is sized for its own leased model (slice 4f).
 */
function isEligible(node, want, { excludedNodeIds = null, ignoreSlots = false, permit = null } = {}) {
  if (!node.online || node.paused) return false;
  if (want.allowedNodes && !want.allowedNodes.includes(node.node_id)) return false;
  if (!ignoreSlots && node.busy_slots >= node.slots) return false;
  if (excludedNodeIds !== null && excludedNodeIds.includes(node.node_id)) return false;
  const entry = modelEntry(node, want.model);
  if (!entry) return false;
  if (want.wantsVision && entry.vision !== true) return false;
  return permit === null || permit(node) === true;
}

function servedBefore(a, b) {
  return a.last_served_at - b.last_served_at || a.order - b.order;
}

/**
 * The node to serve `want`: the affinity node if eligible and free, else the
 * eligible node with the oldest last_served_at (registration order breaks ties).
 * Returns null when no eligible node has a free slot.
 */
function chooseNode(nodes, want, { affinityNodeId = null, excludedNodeIds = null, permit = null } = {}) {
  const eligible = nodes.filter((node) => isEligible(node, want, { excludedNodeIds, permit }));
  if (eligible.length === 0) return null;
  const affinity = affinityNodeId === null ? null : eligible.find((node) => node.node_id === affinityNodeId);
  if (affinity) return affinity;
  return [...eligible].sort(servedBefore)[0];
}

// The slots that can take work: online and not paused. Feeds the lane limits.
function onlineSlots(nodes) {
  return nodes.reduce((sum, node) => (node.online && !node.paused ? sum + node.slots : sum), 0);
}

// The union of models by id over the nodes that can take work now (online and not paused: a paused node
// advertises nothing and lowers no minimum), with the smallest context length (two nodes serving one
// model, the smaller is the safe one; any vision or thinking), the largest of those
// lengths across models (what the gateway's /props reports), and the online slots.
function poolSummary(nodes) {
  const union = new Map();
  for (const node of nodes) {
    if (!node.online || node.paused) continue;
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
    models, largest_context_length: lengths.length ? Math.max(...lengths) : null,
    vision: models.some((m) => m.vision), thinking: models.some((m) => m.thinking), online_slots: onlineSlots(nodes),
  };
}

module.exports = { chooseNode, isEligible, modelEntry, onlineSlots, poolSummary };
