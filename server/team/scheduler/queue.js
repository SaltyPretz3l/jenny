'use strict';

// The wait order (row 123; spec "Choosing a node" step 3). One replaceable
// ordering function: continuation jobs first, then the node owner's own turns on
// their node, then everyone else's turns taking turns by member (least recently
// served member first), then an owner who was just held back (E52).
// orderWaiting(items, node, ownerWentAhead, servedRank) returns a new sorted array.
//
// An item is { continuation: boolean, member_id: string, seq: number }, where seq
// is a monotonic arrival number. `node` is the node a slot is free on, or null for
// the pool-wide order used to report queue positions.
//
// `ownerWentAhead` (owner decision E52, refining N8 and E7): the last turn handed
// out on `node` went to its owner ahead of another waiting member. The owner then
// waits behind everyone else there for one turn, and still goes first when nobody
// else waits: never twice in a row while someone else is waiting there.
//
// `servedRank` (optional): member id to a number, 0 for a member never served and
// larger the more recently one was served. Absent, the third tier is arrival order.

const CONTINUATION = 0;
const OWNER = 1;
const OTHERS = 2;
const OWNER_HELD_BACK = 3;

function tier(item, node, ownerWentAhead) {
  if (item.continuation) return CONTINUATION;
  if (node && item.member_id === node.member_id) return ownerWentAhead ? OWNER_HELD_BACK : OWNER;
  return OTHERS;
}

// `items` are in arrival order. Members keep their first-arrival order in the Map,
// so the stable sort by rank breaks ties by arrival.
function takeTurns(items, servedRank) {
  const queues = new Map();
  for (const item of items) {
    if (!queues.has(item.member_id)) queues.set(item.member_id, []);
    queues.get(item.member_id).push(item);
  }
  const lines = [...queues.values()].sort((a, b) => servedRank(a[0].member_id) - servedRank(b[0].member_id));
  const out = [];
  for (let round = 0; out.length < items.length; round += 1) {
    for (const line of lines) if (round < line.length) out.push(line[round]);
  }
  return out;
}

function orderWaiting(items, node = null, ownerWentAhead, servedRank = null) {
  const tiers = [[], [], [], []];
  for (const item of [...items].sort((a, b) => a.seq - b.seq)) tiers[tier(item, node, ownerWentAhead)].push(item);
  if (typeof servedRank === 'function') tiers[OTHERS] = takeTurns(tiers[OTHERS], servedRank);
  return tiers.flat();
}

module.exports = { orderWaiting };
